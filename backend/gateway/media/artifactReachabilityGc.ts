import {
  isTerminalProductionJobStatus,
  type ProductionJobRecord,
} from "../../../packages/protocol/src/productionJobProtocol";
import type { ArtifactStorageBackend, StoredArtifactObject } from "./artifactStorage";

/**
 * Reachability-based garbage collection over the artifact storage backend.
 *
 * Reachability is computed from durable job records: every immutable job
 * artifact stays reachable while its job record exists, and every staged
 * content-addressed media input referenced by a non-terminal (queued,
 * running, outcome_unknown, reconciling) job stays reachable so a retry or
 * reconciliation never loses its exact source bytes. Staged inputs of
 * terminal jobs age out through the retention window instead.
 *
 * Every hook is injectable — clock, retention, legal hold, and the storage
 * backend itself — and sweeping defaults to a dry run, so the GC is fully
 * testable and can never delete silently. Because a reviewed plan is
 * executed later, {@link revalidateArtifactGcSweep} re-checks it against
 * live job records and object freshness just before deletion, so a key that
 * became reachable or was rewritten after planning is skipped with a typed
 * code instead of deleted.
 */

/** Storage prefix that owns durable job artifacts. */
export const PRODUCTION_JOB_ARTIFACT_PREFIX = "production-jobs/" as const;
/** Storage prefix that owns content-addressed staged media inputs. */
export const MEDIA_INPUT_PREFIX = "media-transcode-inputs/" as const;

const JOB_ARTIFACT_KEY_PATTERN = /^production-jobs\/[^/]+\/attempts\/[^/]+\/[^/]+$/;
const MEDIA_INPUT_KEY_PATTERN = /^media-transcode-inputs\/[a-f0-9]{64}\.bin$/;
const STAGED_SHA256_PATTERN = /sha256:([a-f0-9]{64})/g;

/** Why a stored object was kept by the GC plan. */
export type ArtifactGcKeepReason = "reachable" | "retained" | "legal-hold" | "outside-scope";

/** Why a stored object was planned for sweeping. */
export type ArtifactGcSweepReason = "unreachable" | "retention-expired";

/** One examined object with the planned action. */
export interface ArtifactGcEntry extends StoredArtifactObject {
  action: "keep" | "sweep";
  /** Present when the action is keep. */
  keepReason?: ArtifactGcKeepReason;
  /** Present when the action is sweep. */
  sweepReason?: ArtifactGcSweepReason;
}

/** Immutable, reviewable GC plan; sweeping consumes exactly this plan. */
export interface ArtifactGcPlan {
  contract: "director-artifact-gc-plan-v1";
  plannedAt: string;
  minimumAgeMs: number;
  examined: number;
  entries: ArtifactGcEntry[];
}

/**
 * Computes the set of storage keys reachable from durable job records.
 *
 * @param jobs - Every durable production job record.
 * @returns Keys that must never be swept while these records exist.
 */
export function collectReachableArtifactKeys(jobs: readonly ProductionJobRecord[]): Set<string> {
  const reachable = new Set<string>();
  for (const job of jobs) {
    for (const artifact of job.artifacts) {
      reachable.add(`${PRODUCTION_JOB_ARTIFACT_PREFIX}${job.id}/attempts/${artifact.attemptId}/${artifact.fileName}`);
    }
    if (!isTerminalProductionJobStatus(job.status)) {
      // Conservative input reachability: any sha256-addressed source referenced
      // anywhere in an active job's input stays staged for retry/reconciliation.
      for (const match of JSON.stringify(job.input).matchAll(STAGED_SHA256_PATTERN)) {
        reachable.add(`${MEDIA_INPUT_PREFIX}${match[1]}.bin`);
      }
    }
  }
  return reachable;
}

/** Options for {@link planArtifactStorageGc}. */
export interface ArtifactGcPlanOptions {
  /** The storage backend to enumerate. */
  storage: ArtifactStorageBackend;
  /** Every durable job record; drives reachability. */
  jobs: readonly ProductionJobRecord[];
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Objects younger than this are always kept (default 24 h). */
  minimumAgeMs?: number;
  /** Legal-hold hook: keys it returns true for are never swept. */
  isLegalHold?: (key: string) => boolean;
  /**
   * Reachable job-artifact keys whose terminal retention window has passed
   * (see `collectRetentionExpiredArtifactKeys`). These become sweep
   * candidates despite being reachable; legal hold and the minimum age
   * still protect them. Omitted or empty preserves pure reachability GC.
   */
  retentionExpiredKeys?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

/**
 * Plans a reachability GC pass without deleting anything. Only artifact
 * files under `production-jobs/<id>/attempts/…` and staged inputs under
 * `media-transcode-inputs/…` are ever sweep candidates; job metadata and any
 * unrecognized keys are kept as outside-scope.
 *
 * @param options - Storage, jobs, clock, retention window, and legal-hold hook.
 * @returns The reviewable plan listing every examined object with its action.
 */
export async function planArtifactStorageGc(options: ArtifactGcPlanOptions): Promise<ArtifactGcPlan> {
  const now = options.now ?? Date.now;
  const minimumAgeMs = options.minimumAgeMs ?? 24 * 60 * 60_000;
  const reachable = collectReachableArtifactKeys(options.jobs);
  const plannedAtMs = now();
  const objects = [
    ...(await options.storage.list(PRODUCTION_JOB_ARTIFACT_PREFIX)),
    ...(await options.storage.list(MEDIA_INPUT_PREFIX)),
  ];

  const entries: ArtifactGcEntry[] = objects.map((object) => {
    if (!JOB_ARTIFACT_KEY_PATTERN.test(object.key) && !MEDIA_INPUT_KEY_PATTERN.test(object.key)) {
      return { ...object, action: "keep", keepReason: "outside-scope" };
    }
    const retentionExpired = options.retentionExpiredKeys?.has(object.key) ?? false;
    if (reachable.has(object.key) && !retentionExpired) {
      return { ...object, action: "keep", keepReason: "reachable" };
    }
    if (options.isLegalHold?.(object.key)) {
      return { ...object, action: "keep", keepReason: "legal-hold" };
    }
    if (plannedAtMs - new Date(object.modifiedAt).getTime() < minimumAgeMs) {
      return { ...object, action: "keep", keepReason: "retained" };
    }
    return { ...object, action: "sweep", sweepReason: retentionExpired ? "retention-expired" : "unreachable" };
  });

  return {
    contract: "director-artifact-gc-plan-v1",
    plannedAt: new Date(plannedAtMs).toISOString(),
    minimumAgeMs,
    examined: entries.length,
    entries,
  };
}

/** Why one planned-sweep key was skipped instead of deleted. */
export type ArtifactGcSweepSkipCode =
  | "became-reachable"
  | "modified-since-plan"
  | "already-absent"
  | "delete-failed";

/** One planned-sweep key that was not deleted, with the typed evidence. */
export interface ArtifactGcSweepSkip {
  key: string;
  code: ArtifactGcSweepSkipCode;
  reason: string;
}

/** Options for {@link revalidateArtifactGcSweep}. */
export interface ArtifactGcSweepRevalidationOptions {
  /** The backend the plan was computed against. */
  storage: ArtifactStorageBackend;
  /** Every durable job record *at sweep time*; drives fresh reachability. */
  jobs: readonly ProductionJobRecord[];
  /** The reviewed plan about to be executed. */
  plan: ArtifactGcPlan;
  /** Keys whose terminal retention window has passed at sweep time. */
  retentionExpiredKeys?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

/**
 * Revalidates a reviewed plan against the live system just before execution.
 *
 * Planning and sweeping are separated by a human review window, and the
 * world keeps moving in between: a new or retried job can make a
 * planned-sweep key reachable again (a re-referenced content-addressed
 * staged input, a job record that gained artifacts), and a content-addressed
 * object can be rewritten under the same key after the plan enumerated the
 * old bytes. Executing the stale plan verbatim would delete bytes the GC
 * contract promises to keep, so such keys are pruned into typed skips
 * (`became-reachable`, `modified-since-plan`) instead of deleted.
 *
 * @param options - Storage, fresh job records, the reviewed plan, and the
 *   sweep-time retention-expired keys.
 * @returns The executable subset of the plan plus the blocked skips.
 */
export async function revalidateArtifactGcSweep(
  options: ArtifactGcSweepRevalidationOptions,
): Promise<{ executable: ArtifactGcPlan; blocked: ArtifactGcSweepSkip[] }> {
  const reachable = collectReachableArtifactKeys(options.jobs);
  const plannedAtMs = new Date(options.plan.plannedAt).getTime();
  const blocked: ArtifactGcSweepSkip[] = [];
  const blockedKeys = new Set<string>();
  for (const entry of options.plan.entries) {
    if (entry.action !== "sweep") continue;
    if (reachable.has(entry.key) && !(options.retentionExpiredKeys?.has(entry.key) ?? false)) {
      blocked.push({
        key: entry.key,
        code: "became-reachable",
        reason:
          "A live job record references this key now; deleting it would lose bytes a retry or reconciliation needs.",
      });
      blockedKeys.add(entry.key);
      continue;
    }
    const head = await options.storage.head(entry.key);
    if (head && new Date(head.modifiedAt).getTime() > plannedAtMs) {
      blocked.push({
        key: entry.key,
        code: "modified-since-plan",
        reason: `The object was rewritten at ${head.modifiedAt}, after the plan was computed at ${options.plan.plannedAt}; the reviewed plan no longer describes these bytes.`,
      });
      blockedKeys.add(entry.key);
    }
  }
  if (!blocked.length) return { executable: options.plan, blocked };
  return {
    executable: { ...options.plan, entries: options.plan.entries.filter((entry) => !blockedKeys.has(entry.key)) },
    blocked,
  };
}

/** Result of executing (or dry-running) a GC plan. */
export interface ArtifactGcSweepResult {
  dryRun: boolean;
  /** Keys the sweep deleted (empty during a dry run). */
  deletedKeys: string[];
  /** Bytes reclaimed (planned bytes during a dry run). */
  reclaimedBytes: number;
  /** Keys whose deletion failed or that no longer existed. */
  skippedKeys: string[];
  /** Typed evidence for every skipped key. */
  skipped: ArtifactGcSweepSkip[];
}

/**
 * Executes a GC plan against the storage backend. Defaults to a dry run:
 * deletion only happens when `dryRun` is explicitly false.
 *
 * @param storage - The backend the plan was computed against.
 * @param plan - The plan produced by {@link planArtifactStorageGc}.
 * @param options.dryRun - Set to `false` to actually delete swept objects.
 * @returns Deleted keys, reclaimed bytes, and skipped keys.
 */
export async function sweepArtifactStorageGc(
  storage: ArtifactStorageBackend,
  plan: ArtifactGcPlan,
  options: { dryRun?: boolean } = {},
): Promise<ArtifactGcSweepResult> {
  const dryRun = options.dryRun ?? true;
  const sweepEntries = plan.entries.filter((entry) => entry.action === "sweep");
  if (dryRun) {
    return {
      dryRun: true,
      deletedKeys: [],
      reclaimedBytes: sweepEntries.reduce((total, entry) => total + entry.bytes, 0),
      skippedKeys: [],
      skipped: [],
    };
  }
  const deletedKeys: string[] = [];
  const skipped: ArtifactGcSweepSkip[] = [];
  let reclaimedBytes = 0;
  for (const entry of sweepEntries) {
    try {
      if (await storage.delete(entry.key)) {
        deletedKeys.push(entry.key);
        reclaimedBytes += entry.bytes;
      } else {
        skipped.push({
          key: entry.key,
          code: "already-absent",
          reason: "The object no longer existed when the sweep reached it.",
        });
      }
    } catch (error) {
      skipped.push({
        key: entry.key,
        code: "delete-failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { dryRun: false, deletedKeys, reclaimedBytes, skippedKeys: skipped.map((skip) => skip.key), skipped };
}
