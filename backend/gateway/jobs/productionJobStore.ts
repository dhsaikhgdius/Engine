import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  PRODUCTION_JOB_CONTRACT_VERSION,
  canvasJobInputSchema,
  canvasVideoJobInputSchema,
  hashInputFingerprint,
  productionJobArtifactSchema,
  productionJobRecordSchema,
  productionJobSpecSchema,
  productionJobStatusSchema,
  transitionProductionJob,
  type ProductionJobArtifact,
  type ProductionJobError,
  type ProductionJobInput,
  type ProductionJobKind,
  type ProductionJobRecord,
  type ProductionJobSpecInput,
} from "../../../packages/protocol/src/productionJobProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";
import { stableJson } from "../../../packages/protocol/src/stableJson";
import { renderCanvasPlaceholderPng } from "./canvasPlaceholderArtifact";

type StoredJobIndex = {
  byId: Map<string, ProductionJobRecord>;
  byIdempotencyKey: Map<string, ProductionJobRecord>;
};

const legacyCanvasArtifactSchema = z.strictObject({
  mimeType: z.string().min(1),
  fileName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});

const legacyCanvasJobRecordMetadata = {
  id: z.string().min(1),
  status: productionJobStatusSchema.exclude(["reconciling"]),
  progress: z.number().min(0).max(1),
  inputFingerprint: z.string().min(1),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  message: z.string().optional(),
  artifact: legacyCanvasArtifactSchema.optional(),
  error: z.string().optional(),
} as const;

const legacyCanvasJobRecordSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    ...legacyCanvasJobRecordMetadata,
    kind: z.literal("canvas.image"),
    input: canvasJobInputSchema,
  }),
  z.looseObject({
    ...legacyCanvasJobRecordMetadata,
    kind: z.literal("canvas.video"),
    input: canvasVideoJobInputSchema,
  }),
]);

function productionJobPath(dataDirectory: string, jobId: string) {
  return join(dataDirectory, "production-jobs", jobId, "job.json");
}

function legacyJobPath(dataDirectory: string, jobId: string) {
  return join(dataDirectory, "canvas-jobs", jobId, "job.json");
}

function legacyArtifactPath(dataDirectory: string, jobId: string, fileName: string) {
  return join(dataDirectory, "canvas-jobs", jobId, fileName);
}

function safeSegment(value: string, label: string) {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid ${label} path segment`);
  }
  return value;
}

function artifactPath(dataDirectory: string, jobId: string, attemptId: string, fileName: string) {
  return join(
    dataDirectory,
    "production-jobs",
    safeSegment(jobId, "job id"),
    "attempts",
    safeSegment(attemptId, "attempt id"),
    safeSegment(fileName, "artifact file name"),
  );
}

function structuredAttemptError(
  status: ProductionJobRecord["status"],
  message?: string,
): ProductionJobError | undefined {
  if (!message) return undefined;
  return {
    code: status === "outcome_unknown" ? "outcome_unknown" : "legacy_job_error",
    message,
    retryable: status === "outcome_unknown",
  };
}

function migrateLegacyCanvasJob(raw: unknown): ProductionJobRecord | null {
  const parsed = legacyCanvasJobRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const legacy = parsed.data;
  const attemptId = `${legacy.id}-attempt-1`;
  const artifact = legacy.artifact
    ? productionJobArtifactSchema.parse({
        ...legacy.artifact,
        id: `${attemptId}-artifact-1`,
        attemptId,
        role: "primary",
        createdAt: legacy.updatedAt,
      })
    : undefined;
  const error = structuredAttemptError(legacy.status, legacy.error);
  return productionJobRecordSchema.parse({
    contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
    id: legacy.id,
    kind: legacy.kind,
    status: legacy.status,
    progress: legacy.progress,
    inputFingerprint: legacy.inputFingerprint,
    idempotencyKey: legacy.idempotencyKey,
    input: legacy.input,
    attempts: [
      {
        id: attemptId,
        number: 1,
        status: legacy.status,
        provider: "director.legacy-canvas",
        inputFingerprint: legacy.inputFingerprint,
        idempotencyKey: legacy.idempotencyKey,
        sourceRevisions: {},
        timestamps: {
          createdAt: legacy.createdAt,
          startedAt: legacy.status === "queued" ? undefined : legacy.createdAt,
          outcomeUnknownAt: legacy.status === "outcome_unknown" ? legacy.updatedAt : undefined,
          finishedAt:
            legacy.status === "succeeded" || legacy.status === "failed" || legacy.status === "cancelled"
              ? legacy.updatedAt
              : undefined,
        },
        error,
        artifacts: artifact ? [artifact] : [],
      },
    ],
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    message: legacy.message,
    artifacts: artifact ? [artifact] : [],
    artifact,
    error: legacy.error,
  });
}

function cloneJob(job: ProductionJobRecord): ProductionJobRecord {
  return structuredClone(job);
}

function sameJson(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

/**
 * Thrown when an idempotency key is reused with different input parameters.
 * The existing job id is available so callers can redirect to it.
 */
export class ProductionJobIdempotencyConflictError extends Error {
  readonly code = "production_job_idempotency_conflict";

  constructor(readonly existingJobId: string) {
    super("The idempotency key is already bound to a different production job input");
    this.name = "ProductionJobIdempotencyConflictError";
  }
}

/**
 * Durable store for production jobs (image, video, audio, 3D generation,
 * media transcode, scene reconstruction, episode packaging, and legacy
 * canvas jobs). Jobs are indexed in memory on first load and persisted as
 * atomic JSON files. Supports idempotency-keyed enqueue, per-id serialized
 * updates, and reconciliation of jobs interrupted by a gateway restart.
 */
export class ProductionJobStore {
  private index: StoredJobIndex = { byId: new Map(), byIdempotencyKey: new Map() };
  private loadPromise: Promise<void> | null = null;
  private enqueueTail: Promise<void> = Promise.resolve();
  private readonly updateTails = new Map<string, Promise<void>>();

  constructor(readonly dataDirectory: string) {}

  private indexJob(job: ProductionJobRecord) {
    this.index.byId.set(job.id, job);
    this.index.byIdempotencyKey.set(job.idempotencyKey, job);
  }

  private async persist(job: ProductionJobRecord) {
    await writeJsonAtomic(productionJobPath(this.dataDirectory, job.id), job);
    this.indexJob(job);
  }

  private async loadRoot(rootName: "production-jobs" | "canvas-jobs") {
    const root = join(this.dataDirectory, rootName);
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      return;
    }
    for (const jobId of entries) {
      if (rootName === "canvas-jobs" && this.index.byId.has(jobId)) continue;
      try {
        const raw = JSON.parse(
          await readFile(
            rootName === "production-jobs"
              ? productionJobPath(this.dataDirectory, jobId)
              : legacyJobPath(this.dataDirectory, jobId),
            "utf8",
          ),
        ) as unknown;
        let job = productionJobRecordSchema.safeParse(raw).data ?? migrateLegacyCanvasJob(raw);
        if (!job) continue;

        if (rootName === "canvas-jobs") {
          const legacyArtifact = job.artifact;
          if (legacyArtifact) {
            const target = artifactPath(this.dataDirectory, job.id, legacyArtifact.attemptId, legacyArtifact.fileName);
            await mkdir(dirname(target), { recursive: true });
            try {
              await copyFile(legacyArtifactPath(this.dataDirectory, job.id, legacyArtifact.fileName), target);
            } catch {
              // Metadata remains useful even when an old artifact file has already been cleaned up.
            }
          }
          await this.persist(job);
        }

        if (job.status === "running") {
          job = transitionProductionJob(job, "outcome_unknown", {
            progress: job.progress,
            message: "Executor interrupted; provider outcome must be reconciled",
            error: "The gateway restarted while this attempt was running",
            structuredError: {
              code: "executor_restart_outcome_unknown",
              message: "The gateway restarted while this attempt was running",
              retryable: false,
            },
          });
          await this.persist(job);
        } else {
          this.indexJob(job);
        }
      } catch {
        // A corrupt record cannot prevent other durable jobs from recovering.
      }
    }
  }

  private async ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        await this.loadRoot("production-jobs");
        await this.loadRoot("canvas-jobs");
      })();
    }
    await this.loadPromise;
  }

  /**
   * Returns a job by id, or null when it does not exist.
   *
   * @param jobId - The production job id.
   */
  async get(jobId: string) {
    await this.ensureLoaded();
    const job = this.index.byId.get(jobId);
    return job ? cloneJob(job) : null;
  }

  /**
   * Lists all jobs, optionally filtered by kind, newest first.
   *
   * @param kinds - Optional job kinds to filter by.
   */
  async list(kinds?: readonly ProductionJobKind[]) {
    await this.ensureLoaded();
    const selected = kinds?.length ? new Set(kinds) : null;
    return [...this.index.byId.values()]
      .filter((job) => !selected || selected.has(job.kind))
      .map(cloneJob)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Looks up a job by idempotency key. Returns the existing job when the
   * key, kind, input, provider, and source revisions all match; throws
   * {@link ProductionJobIdempotencyConflictError} when they conflict.
   *
   * @param idempotencyKey - The client-supplied idempotency key.
   * @param kind - The job kind.
   * @param input - The validated job input.
   * @param metadata.provider - The provider identifier.
   * @param metadata.sourceRevisions - Source revision map for deduplication.
   * @returns The existing job, or null when no match exists.
   * @throws {@link ProductionJobIdempotencyConflictError} When the key is reused with different parameters.
   */
  async findByIdempotency(
    idempotencyKey: string,
    kind: ProductionJobKind,
    input: ProductionJobInput,
    metadata: { provider: string; sourceRevisions: Record<string, string | number> },
  ) {
    await this.ensureLoaded();
    const existing = this.index.byIdempotencyKey.get(idempotencyKey);
    if (!existing) return null;
    const fingerprint = hashInputFingerprint(kind, input);
    const firstAttempt = existing.attempts[0]!;
    if (
      existing.kind !== kind ||
      existing.inputFingerprint !== fingerprint ||
      !sameJson(existing.input, input) ||
      firstAttempt.provider !== metadata.provider ||
      !sameJson(firstAttempt.sourceRevisions, metadata.sourceRevisions)
    ) {
      throw new ProductionJobIdempotencyConflictError(existing.id);
    }
    return cloneJob(existing);
  }

  /**
   * Enqueues a new production job. Idempotency is checked first: when a job
   * with the same key already exists with matching parameters, it is returned
   * instead of creating a duplicate.
   *
   * @param params - The job specification with idempotency key and id factory.
   * @returns The newly created or existing job.
   * @throws {@link ProductionJobIdempotencyConflictError} When the idempotency key conflicts.
   */
  async enqueue(
    params: ProductionJobSpecInput & {
      idempotencyKey: string;
      provider?: string;
      externalId?: string;
      sourceRevisions?: Record<string, string | number>;
      createId: () => string;
    },
  ): Promise<ProductionJobRecord> {
    let release!: () => void;
    const preceding = this.enqueueTail;
    this.enqueueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      const spec = productionJobSpecSchema.parse({ kind: params.kind, input: params.input });
      const provider = params.provider ?? "director.local";
      const sourceRevisions = params.sourceRevisions ?? {};
      const existing = await this.findByIdempotency(params.idempotencyKey, spec.kind, spec.input, {
        provider,
        sourceRevisions,
      });
      if (existing) return existing;

      const now = new Date().toISOString();
      const id = params.createId();
      const inputFingerprint = hashInputFingerprint(spec.kind, spec.input);
      const job = productionJobRecordSchema.parse({
        contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
        id,
        kind: spec.kind,
        status: "queued",
        progress: 0,
        inputFingerprint,
        idempotencyKey: params.idempotencyKey,
        input: spec.input,
        attempts: [
          {
            id: `${id}-attempt-1`,
            number: 1,
            status: "queued",
            provider,
            externalId: params.externalId,
            inputFingerprint,
            idempotencyKey: params.idempotencyKey,
            sourceRevisions,
            timestamps: { createdAt: now },
            artifacts: [],
          },
        ],
        createdAt: now,
        updatedAt: now,
        message: "Queued",
        artifacts: [],
      });
      await this.persist(job);
      return cloneJob(job);
    } finally {
      release();
    }
  }

  /**
   * Persists an updated job record. Updates are serialized per id so
   * concurrent writers never lose a transition.
   *
   * @param job - The complete updated job record.
   * @returns The persisted job record.
   * @throws When the job does not exist in the index.
   */
  async update(job: ProductionJobRecord) {
    await this.ensureLoaded();
    const parsed = productionJobRecordSchema.parse(job);
    const preceding = this.updateTails.get(parsed.id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.updateTails.set(parsed.id, tail);
    await preceding;
    try {
      if (!this.index.byId.has(parsed.id)) throw new Error(`Production job ${parsed.id} does not exist`);
      await this.persist(parsed);
      return cloneJob(parsed);
    } finally {
      release();
      if (this.updateTails.get(parsed.id) === tail) this.updateTails.delete(parsed.id);
    }
  }

  /**
   * Transitions a job into the reconciling state so an executor can safely
   * resolve its outcome.
   *
   * @param jobId - The job id to begin reconciliation for.
   * @returns The updated job, or null when the job does not exist.
   */
  async beginReconciliation(jobId: string) {
    const job = await this.get(jobId);
    if (!job) return null;
    const reconciling = transitionProductionJob(job, "reconciling", {
      message: "Reconciling provider outcome",
    });
    return this.update(reconciling);
  }

  /**
   * Sets the external id on the current attempt. The external id is immutable
   * once recorded.
   *
   * @param jobId - The job id.
   * @param externalId - The provider-assigned external id.
   * @returns The updated job, or null when the job does not exist.
   * @throws When the external id is already set to a different value.
   */
  async setCurrentAttemptExternalId(jobId: string, externalId: string) {
    const job = await this.get(jobId);
    if (!job) return null;
    const parsedExternalId = z.string().trim().min(1).max(500).parse(externalId);
    const current = job.attempts.at(-1)!;
    if (current.externalId && current.externalId !== parsedExternalId) {
      throw new Error("Production job attempt externalId is immutable once recorded");
    }
    current.externalId = parsedExternalId;
    current.externalIds = [parsedExternalId];
    job.updatedAt = new Date().toISOString();
    return this.update(job);
  }

  /**
   * Appends an external id to the current attempt's phase list. The first
   * call sets the immutable externalId as well. When the list exceeds 16
   * entries, the oldest middle phases are dropped.
   *
   * @param jobId - The job id.
   * @param externalId - The provider-assigned external id for this phase.
   * @returns The updated job, or null when the job does not exist.
   */
  async appendCurrentAttemptExternalId(jobId: string, externalId: string) {
    const job = await this.get(jobId);
    if (!job) return null;
    const parsedExternalId = z.string().trim().min(1).max(500).parse(externalId);
    const current = job.attempts.at(-1)!;
    if (!current.externalId) {
      current.externalId = parsedExternalId;
      current.externalIds = [parsedExternalId];
    } else {
      const externalIds = current.externalIds ?? [current.externalId];
      if (!externalIds.includes(parsedExternalId)) externalIds.push(parsedExternalId);
      if (externalIds.length > 16) {
        // The record schema caps phases at 16 and pins externalIds[0] to the immutable
        // externalId, so drop the oldest middle phases instead of failing the job mid-run.
        const dropped = externalIds.splice(1, externalIds.length - 16);
        console.warn(
          `Production job ${jobId} attempt exceeded 16 provider phases; dropped oldest external ids: ${dropped.join(", ")}`,
        );
      }
      current.externalIds = externalIds;
    }
    job.updatedAt = new Date().toISOString();
    return this.update(job);
  }

  /**
   * Resolves a reconciliation by transitioning the job to a terminal state.
   *
   * @param jobId - The job id.
   * @param resolution - The resolution state and optional error/artifact.
   * @returns The updated job, or null when the job does not exist.
   */
  async resolveReconciliation(
    jobId: string,
    resolution: {
      status: "succeeded" | "failed" | "queued";
      message?: string;
      error?: ProductionJobError;
      artifact?: ProductionJobArtifact;
    },
  ) {
    const job = await this.get(jobId);
    if (!job) return null;
    const resolved = transitionProductionJob(job, resolution.status, {
      progress: resolution.status === "succeeded" ? 1 : resolution.status === "queued" ? 0 : job.progress,
      message: resolution.message ?? (resolution.status === "queued" ? "Queued after reconciliation" : "Reconciled"),
      error: resolution.error?.message,
      structuredError: resolution.error,
      artifact: resolution.artifact,
    });
    return this.update(resolved);
  }

  /**
   * Returns the absolute filesystem path for an artifact file.
   *
   * @param jobId - The job id.
   * @param attemptId - The attempt id.
   * @param fileName - The artifact file name.
   * @returns The absolute path to the artifact file.
   */
  artifactFilePath(jobId: string, attemptId: string, fileName: string) {
    return artifactPath(this.dataDirectory, jobId, attemptId, fileName);
  }

  /**
   * Reads an artifact's bytes from the filesystem.
   *
   * @param job - The job record.
   * @param artifact - The artifact descriptor.
   * @returns The artifact file contents as a Buffer.
   */
  async readArtifact(job: ProductionJobRecord, artifact: ProductionJobArtifact) {
    return readFile(this.artifactFilePath(job.id, artifact.attemptId, artifact.fileName));
  }
}

/**
 * Executes a legacy canvas image job by rendering a placeholder PNG and
 * transitioning the job to succeeded. Used for backward compatibility with
 * the pre-production-job canvas system.
 *
 * @param store - The production job store.
 * @param job - The canvas image job record.
 * @returns The updated job record.
 * @throws When the job kind is not "canvas.image".
 */
export async function executeCanvasImageJob(store: ProductionJobStore, job: ProductionJobRecord) {
  if (job.kind !== "canvas.image") throw new Error(`Cannot execute ${job.kind} with the Canvas image executor`);
  const input = canvasJobInputSchema.parse(job.input);
  let current = transitionProductionJob(job, "running", { progress: 0.05, message: "Rendering placeholder" });
  await store.update(current);

  const attempt = current.attempts.at(-1)!;
  const png = renderCanvasPlaceholderPng({
    width: input.width,
    height: input.height,
    title: input.prompt.slice(0, 80),
  });
  const now = new Date().toISOString();
  const artifact = productionJobArtifactSchema.parse({
    id: `${attempt.id}-artifact-1`,
    attemptId: attempt.id,
    role: "primary",
    mimeType: "image/png",
    fileName: "output.png",
    sha256: createHash("sha256").update(png).digest("hex"),
    bytes: png.byteLength,
    createdAt: now,
  });
  const path = store.artifactFilePath(current.id, attempt.id, artifact.fileName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);

  current = transitionProductionJob(current, "succeeded", {
    progress: 1,
    message: "Succeeded",
    artifact,
  });
  await store.update(current);
  return current;
}
