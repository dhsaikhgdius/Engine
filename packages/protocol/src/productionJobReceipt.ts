import { z } from "zod";
import {
  isTerminalProductionJobStatus,
  productionJobArtifactSchema,
  productionJobErrorSchema,
  productionJobKindSchema,
  productionJobStatusSchema,
  type ProductionJobArtifact,
  type ProductionJobRecord,
} from "./productionJobProtocol";

/**
 * Contract tag stamped on every normalized production job receipt. The
 * receipt is the one uniform, kind-independent projection of a durable
 * production job that Agent, HTTP, and UI surfaces share, so generation,
 * DCC, transcode/proxy, transcription, reconstruction, and episode jobs all
 * report identity, lifecycle, attempts, artifacts, and errors the same way.
 */
export const PRODUCTION_JOB_RECEIPT_CONTRACT = "director-production-job-receipt-v1" as const;

/** Compact summary of the current (latest) attempt inside a receipt. */
export const productionJobReceiptAttemptSchema = z.strictObject({
  id: z.string().min(1),
  number: z.number().int().positive(),
  provider: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(500).optional(),
  /** Ordered provider phases; the first entry is the immutable externalId. */
  externalIds: z.array(z.string().trim().min(1).max(500)).min(1).max(16).optional(),
});

/**
 * Live byte presence for one receipt artifact. Durable job JSON never stores
 * this — it is projected at read time so retention GC can age out bytes while
 * sha256 / ArtifactVersion evidence remains.
 */
export const productionJobArtifactStoragePresenceSchema = z.enum(["present", "absent"]);

/**
 * Receipt artifact: immutable metadata plus optional live `storagePresence`
 * when the Gateway (or a test) has probed the artifact bytes.
 */
export const productionJobReceiptArtifactSchema = productionJobArtifactSchema.extend({
  storagePresence: productionJobArtifactStoragePresenceSchema.optional(),
});

/** Options for {@link projectProductionJobReceipt}. */
export type ProjectProductionJobReceiptOptions = {
  /**
   * Live byte presence keyed by artifact id. When provided, every artifact on
   * the receipt carries `storagePresence` (missing keys become `absent`).
   */
  artifactStoragePresence?: ReadonlyMap<string, z.infer<typeof productionJobArtifactStoragePresenceSchema>>;
};

/**
 * Normalized, kind-independent receipt for one durable production job.
 * Purely a projection of {@link ProductionJobRecord}: it never carries
 * state of its own and is safe to recompute at any time.
 */
export const productionJobReceiptSchema = z
  .strictObject({
    contract: z.literal(PRODUCTION_JOB_RECEIPT_CONTRACT),
    jobId: z.string().min(1),
    kind: productionJobKindSchema,
    status: productionJobStatusSchema,
    /** True exactly when status is succeeded, failed, or cancelled. */
    terminal: z.boolean(),
    progress: z.number().min(0).max(1),
    message: z.string().optional(),
    idempotencyKey: z.string().min(1),
    inputFingerprint: z.string().min(1),
    attemptCount: z.number().int().positive(),
    attempt: productionJobReceiptAttemptSchema,
    timestamps: z.strictObject({
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      startedAt: z.string().datetime().optional(),
      outcomeUnknownAt: z.string().datetime().optional(),
      reconciliationStartedAt: z.string().datetime().optional(),
      finishedAt: z.string().datetime().optional(),
    }),
    error: productionJobErrorSchema.optional(),
    /** Ordered immutable artifacts across every attempt of the job. */
    artifacts: z.array(productionJobReceiptArtifactSchema),
    /** The promoted/primary artifact id when the compatibility pointer exists. */
    primaryArtifactId: z.string().min(1).optional(),
  })
  .superRefine((receipt, context) => {
    if (receipt.terminal !== isTerminalProductionJobStatus(receipt.status)) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "terminal must match whether the status is succeeded, failed, or cancelled",
      });
    }
    if (receipt.attempt.number !== receipt.attemptCount) {
      context.addIssue({
        code: "custom",
        path: ["attempt", "number"],
        message: "The receipt attempt must be the latest attempt of the job",
      });
    }
    const artifactIds = new Set(receipt.artifacts.map((artifact) => artifact.id));
    if (artifactIds.size !== receipt.artifacts.length) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "Artifact IDs must be unique" });
    }
    if (receipt.primaryArtifactId && !artifactIds.has(receipt.primaryArtifactId)) {
      context.addIssue({
        code: "custom",
        path: ["primaryArtifactId"],
        message: "primaryArtifactId must reference an artifact in this receipt",
      });
    }
  });

/** Normalized receipt of one durable production job. */
export type ProductionJobReceipt = z.infer<typeof productionJobReceiptSchema>;

/** Receipt artifact with optional live storage presence. */
export type ProductionJobReceiptArtifact = z.infer<typeof productionJobReceiptArtifactSchema>;

/** Live artifact byte presence on a receipt. */
export type ProductionJobArtifactStoragePresence = z.infer<typeof productionJobArtifactStoragePresenceSchema>;

function projectReceiptArtifacts(
  artifacts: readonly ProductionJobArtifact[],
  presence: ProjectProductionJobReceiptOptions["artifactStoragePresence"],
): ProductionJobReceiptArtifact[] {
  if (!presence) return artifacts.map((artifact) => ({ ...artifact }));
  return artifacts.map((artifact) => ({
    ...artifact,
    storagePresence: presence.get(artifact.id) ?? "absent",
  }));
}

/**
 * Projects the normalized receipt from a full durable job record. The
 * projection is deterministic and total over every job kind: the same job
 * record always produces the same receipt regardless of which executor
 * (generation, DCC, media transcode/proxy, transcription, reconstruction,
 * episode packaging) ran it.
 *
 * Pass {@link ProjectProductionJobReceiptOptions.artifactStoragePresence} from
 * Gateway live reads so agents see whether retention GC has aged out bytes.
 *
 * @param job - The full durable job record.
 * @param options - Optional live byte-presence map.
 * @returns The validated normalized receipt.
 */
export function projectProductionJobReceipt(
  job: ProductionJobRecord,
  options: ProjectProductionJobReceiptOptions = {},
): ProductionJobReceipt {
  const current = job.attempts.at(-1)!;
  const error = current.error ?? (job.error ? { code: "job_error", message: job.error, retryable: false } : undefined);
  return productionJobReceiptSchema.parse({
    contract: PRODUCTION_JOB_RECEIPT_CONTRACT,
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    terminal: isTerminalProductionJobStatus(job.status),
    progress: job.progress,
    message: job.message,
    idempotencyKey: job.idempotencyKey,
    inputFingerprint: job.inputFingerprint,
    attemptCount: job.attempts.length,
    attempt: {
      id: current.id,
      number: current.number,
      provider: current.provider,
      externalId: current.externalId,
      externalIds: current.externalIds,
    },
    timestamps: {
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: current.timestamps.startedAt,
      outcomeUnknownAt: current.timestamps.outcomeUnknownAt,
      reconciliationStartedAt: current.timestamps.reconciliationStartedAt,
      finishedAt: current.timestamps.finishedAt,
    },
    error,
    artifacts: projectReceiptArtifacts(job.artifacts, options.artifactStoragePresence),
    primaryArtifactId: job.artifact?.id,
  });
}
