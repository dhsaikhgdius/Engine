import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProductionJobRecord } from "../../../packages/protocol/src/productionJobProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import {
  MEDIA_INPUT_PREFIX,
  PRODUCTION_JOB_ARTIFACT_PREFIX,
  planArtifactStorageGc,
  revalidateArtifactGcSweep,
  sweepArtifactStorageGc,
  type ArtifactGcEntry,
  type ArtifactGcPlan,
  type ArtifactGcSweepSkip,
} from "./artifactReachabilityGc";
import {
  collectRetentionExpiredArtifactKeys,
  legalHoldPredicate,
  type ResolvedArtifactRetentionPolicy,
} from "./artifactRetentionPolicy";
import type { ArtifactStorageBackend } from "./artifactStorage";

/**
 * Operational surface over the artifact storage backend: usage estimation,
 * reviewable GC planning (always a dry run), and explicit, confirmed,
 * idempotent sweeping with a persisted audit trail.
 *
 * A sweep can only consume a plan this exact process produced: the caller
 * must echo the plan id as `confirm`, plans expire after a bounded TTL, and
 * replaying an executed plan returns the recorded outcome instead of
 * deleting twice. Before deleting, the reviewed plan is revalidated against
 * the live job records and object freshness, so a key that became reachable
 * or was rewritten during the review window is skipped with a typed code
 * instead of deleted. Every executed sweep is appended to a bounded
 * on-disk audit log that the health endpoint reports as "recent GC
 * results", including per-reason skip counts.
 */

/** Default lifetime of a computed GC plan before sweeping refuses it. */
export const DEFAULT_STORAGE_GC_PLAN_TTL_MS = 15 * 60_000;
/** Maximum number of concurrently retained (unswept) plans. */
const MAX_CACHED_PLANS = 16;
/** Maximum persisted audit entries; the oldest are dropped first. */
const MAX_AUDIT_ENTRIES = 50;

const storageGcSweepReasonCountsSchema = z.strictObject({
  unreachable: z.number().int().nonnegative(),
  retentionExpired: z.number().int().nonnegative(),
});

const storageGcSkipReasonCountsSchema = z.strictObject({
  becameReachable: z.number().int().nonnegative(),
  modifiedSincePlan: z.number().int().nonnegative(),
  alreadyAbsent: z.number().int().nonnegative(),
  deleteFailed: z.number().int().nonnegative(),
});

/** Per-reason counts of planned-sweep keys that were skipped, not deleted. */
export type StorageGcSkipReasonCounts = z.infer<typeof storageGcSkipReasonCountsSchema>;

/** One persisted record of an executed sweep. */
export const storageGcAuditEntrySchema = z.strictObject({
  planId: z.string().min(1),
  plannedAt: z.string().min(1),
  sweptAt: z.string().min(1),
  examined: z.number().int().nonnegative(),
  plannedSweepCount: z.number().int().nonnegative(),
  plannedSweepBytes: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  reclaimedBytes: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  byReason: storageGcSweepReasonCountsSchema,
  /** Absent on audit entries recorded before skip reasons were tracked. */
  skippedByReason: storageGcSkipReasonCountsSchema.optional(),
});

/** One persisted record of an executed sweep. */
export type StorageGcAuditEntry = z.infer<typeof storageGcAuditEntrySchema>;

const storageGcAuditFileSchema = z.looseObject({
  version: z.literal(1),
  entries: z.array(z.unknown()),
});

/** Reviewable summary of one computed GC plan. */
export interface StorageGcPlanSummary {
  planId: string;
  plannedAt: string;
  expiresAt: string;
  minimumAgeMs: number;
  examined: number;
  keep: { reachable: number; retained: number; legalHold: number; outsideScope: number };
  sweep: { count: number; bytes: number; byReason: { unreachable: number; retentionExpired: number } };
  /** Exactly the objects the sweep would delete, for review. */
  sweepEntries: ArtifactGcEntry[];
}

/** Outcome of one executed (or replayed) sweep. */
export interface StorageGcSweepOutcome {
  planId: string;
  plannedAt: string;
  sweptAt: string;
  /** True when this call returned the recorded outcome of an earlier sweep. */
  replayed: boolean;
  deletedCount: number;
  reclaimedBytes: number;
  skippedCount: number;
  deletedKeys: string[];
  skippedKeys: string[];
  /** Typed evidence for every skipped key, including sweep-time revalidation. */
  skipped: ArtifactGcSweepSkip[];
  byReason: { unreachable: number; retentionExpired: number };
  skippedByReason: StorageGcSkipReasonCounts;
}

/** Usage estimate for one storage category. */
export interface StorageUsageEstimate {
  objects: number;
  bytes: number;
}

/**
 * Live capacity of the storage backend, measured while building the health
 * report — never a cached or assumed number. Backends without an enumerable
 * capacity (object storage) and failed measurements are typed omissions with
 * a machine code plus the human reason, mirroring the omitted/`storagePresence`
 * honesty contracts elsewhere in the gateway.
 */
export type StorageCapacityCheck =
  | {
      status: "measured";
      totalBytes: number;
      freeBytes: number;
      availableBytes: number;
      /** Fraction of the volume already used, in [0, 1]. */
      usedRatio: number;
    }
  | {
      status: "unavailable";
      code: "capacity_unsupported" | "capacity_probe_failed";
      reason: string;
    };

/**
 * Result of the live put → verify → delete round trip the health report runs
 * against the real backend. A read-only mount, a full disk, or a broken
 * injected object-storage client fails here with the exact step, instead of
 * the report implying a writable backend it never exercised.
 */
export type StorageWriteProbe =
  | { status: "ok"; probedAt: string; latencyMs: number }
  | {
      status: "failed";
      probedAt: string;
      latencyMs: number;
      code: "put_failed" | "verify_failed" | "delete_failed";
      reason: string;
    };

/** Reserved key prefix for health write probes; outside every GC sweep scope. */
export const STORAGE_WRITE_PROBE_PREFIX = "storage-health/";

/** The full storage/jobs health report. */
export interface StorageHealthReport {
  contract: "director-storage-health-v1";
  generatedAt: string;
  backend: ArtifactStorageBackend["kind"];
  policy: {
    source: ResolvedArtifactRetentionPolicy["source"];
    minimumAgeHours: number;
    rules: ResolvedArtifactRetentionPolicy["policy"]["rules"];
    legalHold: { keys: number; keyPrefixes: number; jobIds: number };
  };
  usage: {
    jobArtifacts: StorageUsageEstimate;
    jobMetadata: StorageUsageEstimate;
    stagedMediaInputs: StorageUsageEstimate;
    total: StorageUsageEstimate;
  };
  jobs: {
    total: number;
    nonTerminal: number;
    byStatus: Record<string, number>;
  };
  sweepCandidates: { count: number; bytes: number; byReason: { unreachable: number; retentionExpired: number } };
  /** Recent executed sweeps, newest first. */
  recentSweeps: StorageGcAuditEntry[];
  /** Live capacity measurement, or a typed omission when not measurable. */
  capacity: StorageCapacityCheck;
  /** Live put → verify → delete round trip against the real backend. */
  writeProbe: StorageWriteProbe;
}

/** Thrown when a sweep references a plan this gateway does not hold. */
export class StorageGcPlanNotFoundError extends Error {
  readonly code = "gc_plan_not_found";

  constructor(planId: string) {
    super(
      `GC plan "${planId}" does not exist on this gateway (plans do not survive a restart); request a fresh dry-run plan via POST /api/storage/gc/plan.`,
    );
    this.name = "StorageGcPlanNotFoundError";
  }
}

/** Thrown when a sweep references a plan whose review window has passed. */
export class StorageGcPlanExpiredError extends Error {
  readonly code = "gc_plan_expired";

  constructor(planId: string, expiresAt: string) {
    super(
      `GC plan "${planId}" expired at ${expiresAt}; request a fresh dry-run plan via POST /api/storage/gc/plan and confirm that one.`,
    );
    this.name = "StorageGcPlanExpiredError";
  }
}

/** Thrown when the explicit confirmation does not echo the plan id. */
export class StorageGcConfirmMismatchError extends Error {
  readonly code = "gc_confirm_mismatch";

  constructor() {
    super(
      'Sweeping is destructive and requires explicit confirmation: set "confirm" to the exact planId returned by POST /api/storage/gc/plan.',
    );
    this.name = "StorageGcConfirmMismatchError";
  }
}

type CachedPlan = {
  plan: ArtifactGcPlan;
  planId: string;
  createdAtMs: number;
  expiresAtMs: number;
  outcome?: StorageGcSweepOutcome;
};

/** Options for {@link StorageOpsService}. */
export interface StorageOpsServiceOptions {
  storage: ArtifactStorageBackend;
  jobs: ProductionJobStore;
  retention: ResolvedArtifactRetentionPolicy;
  /** Directory that owns the persisted audit log. */
  dataDirectory: string;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Plan review window; defaults to {@link DEFAULT_STORAGE_GC_PLAN_TTL_MS}. */
  planTtlMs?: number;
  /** Injectable id factory; defaults to `randomUUID`. */
  createPlanId?: () => string;
}

function emptyUsage(): StorageUsageEstimate {
  return { objects: 0, bytes: 0 };
}

function addUsage(usage: StorageUsageEstimate, entry: ArtifactGcEntry) {
  usage.objects += 1;
  usage.bytes += entry.bytes;
}

function sweepReasonCounts(entries: readonly ArtifactGcEntry[]) {
  const byReason = { unreachable: 0, retentionExpired: 0 };
  for (const entry of entries) {
    if (entry.action !== "sweep") continue;
    if (entry.sweepReason === "retention-expired") byReason.retentionExpired += 1;
    else byReason.unreachable += 1;
  }
  return byReason;
}

function skipReasonCounts(skipped: readonly ArtifactGcSweepSkip[]): StorageGcSkipReasonCounts {
  const counts: StorageGcSkipReasonCounts = {
    becameReachable: 0,
    modifiedSincePlan: 0,
    alreadyAbsent: 0,
    deleteFailed: 0,
  };
  for (const skip of skipped) {
    if (skip.code === "became-reachable") counts.becameReachable += 1;
    else if (skip.code === "modified-since-plan") counts.modifiedSincePlan += 1;
    else if (skip.code === "already-absent") counts.alreadyAbsent += 1;
    else counts.deleteFailed += 1;
  }
  return counts;
}

/** Operational storage health, GC planning, and confirmed sweeping. */
export class StorageOpsService {
  private readonly storage: ArtifactStorageBackend;
  private readonly jobs: ProductionJobStore;
  private readonly retention: ResolvedArtifactRetentionPolicy;
  private readonly auditPath: string;
  private readonly now: () => number;
  private readonly planTtlMs: number;
  private readonly createPlanId: () => string;
  private readonly plans = new Map<string, CachedPlan>();
  private auditEntries: StorageGcAuditEntry[] | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: StorageOpsServiceOptions) {
    this.storage = options.storage;
    this.jobs = options.jobs;
    this.retention = options.retention;
    this.auditPath = join(options.dataDirectory, "storage-gc-audit.json");
    this.now = options.now ?? Date.now;
    this.planTtlMs = options.planTtlMs ?? DEFAULT_STORAGE_GC_PLAN_TTL_MS;
    this.createPlanId = options.createPlanId ?? randomUUID;
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadAudit(): Promise<StorageGcAuditEntry[]> {
    if (this.auditEntries) return this.auditEntries;
    let entries: StorageGcAuditEntry[] = [];
    try {
      const raw = storageGcAuditFileSchema.safeParse(JSON.parse(await readFile(this.auditPath, "utf8")));
      if (raw.success) {
        entries = raw.data.entries
          .map((candidate) => storageGcAuditEntrySchema.safeParse(candidate).data)
          .filter((entry): entry is StorageGcAuditEntry => entry !== undefined);
      }
    } catch {
      // A missing or corrupt audit file starts empty; history is advisory.
    }
    this.auditEntries = entries;
    return entries;
  }

  private async appendAudit(entry: StorageGcAuditEntry) {
    const entries = await this.loadAudit();
    entries.push(entry);
    if (entries.length > MAX_AUDIT_ENTRIES) entries.splice(0, entries.length - MAX_AUDIT_ENTRIES);
    await writeJsonAtomic(this.auditPath, { version: 1, entries });
  }

  private async computePlan(jobs: readonly ProductionJobRecord[]): Promise<ArtifactGcPlan> {
    const policy = this.retention.policy;
    return planArtifactStorageGc({
      storage: this.storage,
      jobs,
      now: this.now,
      minimumAgeMs: policy.minimumAgeHours * 60 * 60_000,
      isLegalHold: legalHoldPredicate(policy),
      retentionExpiredKeys: collectRetentionExpiredArtifactKeys(jobs, policy, this.now()),
    });
  }

  private summarize(planId: string, plan: ArtifactGcPlan, expiresAtMs: number): StorageGcPlanSummary {
    const keep = { reachable: 0, retained: 0, legalHold: 0, outsideScope: 0 };
    const sweepEntries: ArtifactGcEntry[] = [];
    for (const entry of plan.entries) {
      if (entry.action === "sweep") {
        sweepEntries.push(entry);
        continue;
      }
      if (entry.keepReason === "reachable") keep.reachable += 1;
      else if (entry.keepReason === "retained") keep.retained += 1;
      else if (entry.keepReason === "legal-hold") keep.legalHold += 1;
      else keep.outsideScope += 1;
    }
    return {
      planId,
      plannedAt: plan.plannedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      minimumAgeMs: plan.minimumAgeMs,
      examined: plan.examined,
      keep,
      sweep: {
        count: sweepEntries.length,
        bytes: sweepEntries.reduce((total, entry) => total + entry.bytes, 0),
        byReason: sweepReasonCounts(sweepEntries),
      },
      sweepEntries,
    };
  }

  /**
   * Measures live backend capacity for the health report. A backend without
   * an enumerable capacity and a failed measurement are both explicit typed
   * omissions; a number is only ever reported when it was just measured.
   */
  private async checkCapacity(): Promise<StorageCapacityCheck> {
    if (!this.storage.capacity) {
      return {
        status: "unavailable",
        code: "capacity_unsupported",
        reason: `The ${this.storage.kind} backend does not expose an enumerable capacity; free-space numbers would be invented, so none are reported.`,
      };
    }
    try {
      const measured = await this.storage.capacity();
      const usedRatio =
        measured.totalBytes > 0
          ? Math.min(1, Math.max(0, (measured.totalBytes - measured.freeBytes) / measured.totalBytes))
          : 0;
      return {
        status: "measured",
        totalBytes: measured.totalBytes,
        freeBytes: measured.freeBytes,
        availableBytes: measured.availableBytes,
        usedRatio: Number(usedRatio.toFixed(4)),
      };
    } catch (error) {
      return {
        status: "unavailable",
        code: "capacity_probe_failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Runs a live put → verify → delete round trip under the reserved
   * `storage-health/` prefix. The probe object is deleted before usage is
   * enumerated so it never appears in the report it verifies; a failed put
   * still attempts a best-effort cleanup so probes cannot accumulate.
   */
  private async probeWrite(): Promise<StorageWriteProbe> {
    const startedMs = this.now();
    const probedAt = new Date(startedMs).toISOString();
    const key = `${STORAGE_WRITE_PROBE_PREFIX}probe-${randomUUID()}.bin`;
    const payload = new TextEncoder().encode(`director-storage-write-probe ${probedAt}`);
    let step: "put" | "verify" | "delete" = "put";
    try {
      await this.storage.put(key, payload);
      step = "verify";
      const head = await this.storage.head(key);
      if (!head) throw new Error("The probe object was not readable immediately after a successful put.");
      if (head.bytes !== payload.byteLength) {
        throw new Error(`The probe object read back ${head.bytes} bytes; ${payload.byteLength} were written.`);
      }
      step = "delete";
      const deleted = await this.storage.delete(key);
      if (!deleted) throw new Error("The probe object could not be deleted after verification.");
      return { status: "ok", probedAt, latencyMs: Math.max(0, this.now() - startedMs) };
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      return {
        status: "failed",
        probedAt,
        latencyMs: Math.max(0, this.now() - startedMs),
        code: `${step}_failed`,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Builds the storage/jobs health report: policy in effect, usage
   * estimates, current sweep candidates (from a fresh dry-run plan that is
   * not retained), recent executed sweeps, plus two live checks — a
   * capacity measurement and a write/verify/delete probe — so the report
   * never implies a healthy backend it did not exercise.
   */
  async health(): Promise<StorageHealthReport> {
    const capacity = await this.checkCapacity();
    // Probe before enumerating usage so the (deleted) probe object never
    // shows up inside the very report that created it.
    const writeProbe = await this.probeWrite();
    const jobs = await this.jobs.list();
    const plan = await this.computePlan(jobs);

    const usage = {
      jobArtifacts: emptyUsage(),
      jobMetadata: emptyUsage(),
      stagedMediaInputs: emptyUsage(),
      total: emptyUsage(),
    };
    for (const entry of plan.entries) {
      addUsage(usage.total, entry);
      if (entry.key.startsWith(MEDIA_INPUT_PREFIX)) {
        addUsage(usage.stagedMediaInputs, entry);
      } else if (entry.key.startsWith(PRODUCTION_JOB_ARTIFACT_PREFIX)) {
        addUsage(entry.keepReason === "outside-scope" ? usage.jobMetadata : usage.jobArtifacts, entry);
      }
    }

    const byStatus: Record<string, number> = {};
    let nonTerminal = 0;
    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") nonTerminal += 1;
    }

    const sweepEntries = plan.entries.filter((entry) => entry.action === "sweep");
    const audit = await this.loadAudit();
    const policy = this.retention.policy;
    return {
      contract: "director-storage-health-v1",
      generatedAt: new Date(this.now()).toISOString(),
      backend: this.storage.kind,
      policy: {
        source: this.retention.source,
        minimumAgeHours: policy.minimumAgeHours,
        rules: policy.rules,
        legalHold: {
          keys: policy.legalHold.keys.length,
          keyPrefixes: policy.legalHold.keyPrefixes.length,
          jobIds: policy.legalHold.jobIds.length,
        },
      },
      usage,
      jobs: { total: jobs.length, nonTerminal, byStatus },
      sweepCandidates: {
        count: sweepEntries.length,
        bytes: sweepEntries.reduce((total, entry) => total + entry.bytes, 0),
        byReason: sweepReasonCounts(sweepEntries),
      },
      recentSweeps: [...audit].reverse().slice(0, 10),
      capacity,
      writeProbe,
    };
  }

  /**
   * Computes and retains a reviewable GC plan (always a dry run). Nothing is
   * deleted; the returned `planId` must be echoed as `confirm` to
   * {@link sweep} within the plan TTL to execute exactly this plan.
   */
  async plan(): Promise<StorageGcPlanSummary> {
    return this.runSerialized(async () => {
      const jobs = await this.jobs.list();
      const plan = await this.computePlan(jobs);
      const planId = this.createPlanId();
      const createdAtMs = this.now();
      const expiresAtMs = createdAtMs + this.planTtlMs;
      this.plans.set(planId, { plan, planId, createdAtMs, expiresAtMs });
      // Bound the cache: drop the oldest unexecuted plans first.
      while (this.plans.size > MAX_CACHED_PLANS) {
        const oldest = [...this.plans.values()].sort((left, right) => left.createdAtMs - right.createdAtMs)[0]!;
        this.plans.delete(oldest.planId);
      }
      return this.summarize(planId, plan, expiresAtMs);
    });
  }

  /**
   * Executes a previously computed plan. Requires the caller to echo the
   * plan id as explicit confirmation, refuses unknown or expired plans with
   * the corrective call, and is idempotent: replaying an executed plan
   * returns the recorded outcome without deleting again.
   *
   * The reviewed plan is revalidated against the live job records and
   * object freshness immediately before deletion: a planned-sweep key that
   * a job now references, or whose bytes were rewritten after planning, is
   * skipped with a typed code (`became-reachable`, `modified-since-plan`)
   * instead of deleted, so a stale plan can never delete bytes a retry or
   * reconciliation needs.
   *
   * @throws {@link StorageGcConfirmMismatchError} When `confirm` ≠ `planId`.
   * @throws {@link StorageGcPlanNotFoundError} When the plan is unknown.
   * @throws {@link StorageGcPlanExpiredError} When the review window passed.
   */
  async sweep(request: { planId: string; confirm: string }): Promise<StorageGcSweepOutcome> {
    if (request.confirm !== request.planId) throw new StorageGcConfirmMismatchError();
    return this.runSerialized(async () => {
      const cached = this.plans.get(request.planId);
      if (!cached) throw new StorageGcPlanNotFoundError(request.planId);
      if (cached.outcome) return { ...cached.outcome, replayed: true };
      if (this.now() > cached.expiresAtMs) {
        throw new StorageGcPlanExpiredError(request.planId, new Date(cached.expiresAtMs).toISOString());
      }

      const jobsNow = await this.jobs.list();
      const { executable, blocked } = await revalidateArtifactGcSweep({
        storage: this.storage,
        jobs: jobsNow,
        plan: cached.plan,
        retentionExpiredKeys: collectRetentionExpiredArtifactKeys(jobsNow, this.retention.policy, this.now()),
      });
      const result = await sweepArtifactStorageGc(this.storage, executable, { dryRun: false });
      const sweepEntries = cached.plan.entries.filter((entry) => entry.action === "sweep");
      const deleted = new Set(result.deletedKeys);
      const byReason = sweepReasonCounts(sweepEntries.filter((entry) => deleted.has(entry.key)));
      const skipped = [...blocked, ...result.skipped];
      const skippedByReason = skipReasonCounts(skipped);
      const sweptAt = new Date(this.now()).toISOString();
      const outcome: StorageGcSweepOutcome = {
        planId: request.planId,
        plannedAt: cached.plan.plannedAt,
        sweptAt,
        replayed: false,
        deletedCount: result.deletedKeys.length,
        reclaimedBytes: result.reclaimedBytes,
        skippedCount: skipped.length,
        deletedKeys: result.deletedKeys,
        skippedKeys: skipped.map((skip) => skip.key),
        skipped,
        byReason,
        skippedByReason,
      };
      cached.outcome = outcome;
      await this.appendAudit({
        planId: outcome.planId,
        plannedAt: outcome.plannedAt,
        sweptAt: outcome.sweptAt,
        examined: cached.plan.examined,
        plannedSweepCount: sweepEntries.length,
        plannedSweepBytes: sweepEntries.reduce((total, entry) => total + entry.bytes, 0),
        deletedCount: outcome.deletedCount,
        reclaimedBytes: outcome.reclaimedBytes,
        skippedCount: outcome.skippedCount,
        byReason,
        skippedByReason,
      });
      return outcome;
    });
  }
}
