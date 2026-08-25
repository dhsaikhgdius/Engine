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
 * testable and can never delete silently.
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

/** One examined object with the planned action. */
export interface ArtifactGcEntry extends StoredArtifactObject {
  action: "keep" | "sweep";
  /** Present when the action is keep. */
  keepReason?: ArtifactGcKeepReason;
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
    if (reachable.has(object.key)) {
      return { ...object, action: "keep", keepReason: "reachable" };
    }
    if (options.isLegalHold?.(object.key)) {
      return { ...object, action: "keep", keepReason: "legal-hold" };
    }
    if (plannedAtMs - new Date(object.modifiedAt).getTime() < minimumAgeMs) {
      return { ...object, action: "keep", keepReason: "retained" };
    }
    return { ...object, action: "sweep" };
  });

  return {
    contract: "director-artifact-gc-plan-v1",
    plannedAt: new Date(plannedAtMs).toISOString(),
    minimumAgeMs,
    examined: entries.length,
    entries,
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
    };
  }
  const deletedKeys: string[] = [];
  const skippedKeys: string[] = [];
  let reclaimedBytes = 0;
  for (const entry of sweepEntries) {
    try {
      if (await storage.delete(entry.key)) {
        deletedKeys.push(entry.key);
        reclaimedBytes += entry.bytes;
      } else {
        skippedKeys.push(entry.key);
      }
    } catch {
      skippedKeys.push(entry.key);
    }
  }
  return { dryRun: false, deletedKeys, reclaimedBytes, skippedKeys };
}
