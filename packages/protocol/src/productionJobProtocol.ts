/**
 * Production job protocol: the durable record shape and state machine for
 * every long-running generation/processing job (image, video, audio, 3D,
 * transcription, reconstruction, media proxy/transcode, DCC export/import,
 * episode packaging).
 *
 * The model is attempt-based. A job freezes its logical identity once — the
 * kind/input fingerprint and idempotency key — and every retry is a new
 * attempt that must carry the same frozen identity, so a retried job can
 * never silently execute different work. Artifacts are immutable and belong
 * to the attempt that produced them; the job-level `artifacts` array is a
 * validated ordered projection of attempt artifacts, never an independent
 * mutable list.
 *
 * The lifecycle explicitly models provider uncertainty: `running` may go to
 * `outcome_unknown` (the provider stopped answering mid-flight), which must
 * pass through `reconciling` before resolving to succeeded/failed/queued.
 * That forces callers to confirm what actually happened with the provider
 * instead of guessing, which is what makes retries safe for paid
 * generation APIs. `productionJobRecordSchema.superRefine` re-validates all
 * of these invariants on every parse, so a corrupt record is rejected at
 * load rather than trusted.
 *
 * Job kinds live in `productionJobKinds.json` so the vocabulary is shared
 * with non-TypeScript consumers.
 */
import { z } from "zod";
import productionJobKinds from "./productionJobKinds.json";
import { protocolKeys } from "./primitives";
import { strictKind } from "./strictProtocolVariant";
import {
  comfyGenerationInputImageSchema,
  comfyGenerationParametersSchema,
  comfyGenerationSourceContextSchema,
  comfyPromptProvenanceSchema,
} from "./comfyGenerationProtocol";
import { generated3dJobInputSchema } from "./generated3dProtocol";
import { mediaTranscriptionJobInputSchema } from "./mediaTranscriptionProtocol";
import { captureReconstructionJobInputSchema } from "./captureReconstructionProtocol";
import { episodePackageJobInputSchema } from "./episodeProtocol";

/** Production job protocol version — incremented when the record shape changes incompatibly. */
export const PRODUCTION_JOB_CONTRACT_VERSION = 1 as const;

/** Lifecycle status of a production job. */
export type ProductionJobStatus = keyof typeof productionJobKinds.statuses;
/** Discriminated kind of a production job. */
export type ProductionJobKind = keyof typeof productionJobKinds.kinds;
/** All valid production job status strings. */
export const PRODUCTION_JOB_STATUSES = protocolKeys(productionJobKinds.statuses);
/** All valid production job kind strings. */
export const PRODUCTION_JOB_KINDS = protocolKeys(productionJobKinds.kinds);

/** The two canvas-native job kinds consumed by the existing Canvas bridge. */
export const CANVAS_JOB_KINDS = ["canvas.image", "canvas.video"] as const;
/** Union of canvas-native job kinds. */
export type CanvasProductionJobKind = (typeof CANVAS_JOB_KINDS)[number];

/** Zod schema for production job status. */
export const productionJobStatusSchema = z.enum(PRODUCTION_JOB_STATUSES);
/** Zod schema for production job kind. */
export const productionJobKindSchema = z.enum(PRODUCTION_JOB_KINDS);
/** Zod schema for canvas-native job kinds. */
export const canvasJobKindSchema = z.enum(CANVAS_JOB_KINDS);

const dimensionsSchema = {
  width: z.number().int().min(64).max(8192).default(1024),
  height: z.number().int().min(64).max(8192).default(576),
};

/** Input shape for canvas image generation jobs. */
export const canvasJobInputSchema = z.strictObject({
  nodeId: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(4000).optional(),
  ...dimensionsSchema,
});

/** Input shape for canvas video generation jobs, extending the image job with duration and fps. */
export const canvasVideoJobInputSchema = canvasJobInputSchema.extend({
  durationSeconds: z.number().positive().max(600).optional(),
  fps: z.number().positive().max(240).optional(),
});

const comfyJobRoutingSchema = {
  nodeId: z.string().trim().min(1).max(80).default("comfy-default"),
  seed: z.number().int().min(0).max(2_147_483_647).default(0),
  parameters: comfyGenerationParametersSchema.default({}),
  inputImages: z.array(comfyGenerationInputImageSchema).max(64).default([]),
  sourceArtifactIds: z.array(z.string().min(1)).max(64).default([]),
  sourceContext: comfyGenerationSourceContextSchema.default({ source: "manual", metadata: {} }),
  promptProvenance: comfyPromptProvenanceSchema.default({ source: "manual", editedAfterCompile: false }),
};

/** Input shape for generic image generation jobs via ComfyUI. */
export const imageGenerationJobInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(12000),
  negativePrompt: z.string().trim().max(12000).optional(),
  ...dimensionsSchema,
  workflowId: z.string().trim().min(1).max(160).default("comfy-workflow-configured-image"),
  ...comfyJobRoutingSchema,
});

/** Input shape for video generation jobs via ComfyUI. */
export const videoGenerationJobInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(12000),
  negativePrompt: z.string().trim().max(12000).optional(),
  ...dimensionsSchema,
  workflowId: z.string().trim().min(1).max(160).default("comfy-workflow-configured-video"),
  durationSeconds: z.number().positive().max(600).default(5),
  fps: z.number().positive().max(240).default(24),
  ...comfyJobRoutingSchema,
});

/** Input shape for audio generation jobs via ComfyUI. */
export const audioGenerationJobInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(12000),
  negativePrompt: z.string().trim().max(12000).optional(),
  mode: z.enum(["sound-effect", "music", "speech"]).default("sound-effect"),
  durationSeconds: z.number().positive().max(3600).default(10),
  sampleRate: z.number().int().min(8000).max(192000).default(48000),
  voice: z.string().trim().min(1).max(240).optional(),
  language: z.string().trim().min(1).max(80).optional(),
  workflowId: z.string().trim().min(1).max(160).default("comfy-workflow-configured-audio"),
  ...comfyJobRoutingSchema,
});

/** Input shape for media proxy (transcoding/resize) jobs. */
export const mediaProxyJobInputSchema = z.strictObject({
  sourceMediaId: z.string().min(1),
  maxWidth: z.number().int().min(64).max(8192).default(1280),
  maxHeight: z.number().int().min(64).max(8192).default(720),
  codec: z.string().trim().min(1).max(100).default("h264"),
});

/** Input shape for media transcode jobs. */
export const mediaTranscodeJobInputSchema = z.strictObject({
  sourceMediaId: z.string().min(1),
  targetMimeType: z.string().trim().min(1).max(200),
  codec: z.string().trim().min(1).max(100).optional(),
  container: z.string().trim().min(1).max(50).optional(),
});

const dccFormatSchema = z.enum(["gltf", "glb", "usd", "usda", "usdc", "usdz", "blend"]);
/** Input shape for DCC export jobs (glTF, USD, Blender). */
export const dccExportJobInputSchema = z.strictObject({
  projectId: z.string().min(1),
  format: dccFormatSchema,
  objectIds: z.array(z.string().min(1)).default([]),
});

/** Input shape for DCC import jobs. */
export const dccImportJobInputSchema = z.strictObject({
  sourceArtifactId: z.string().min(1),
  format: dccFormatSchema.optional(),
  mergeMode: z.enum(["create", "merge", "replace"]).default("create"),
  targetProjectId: z.string().min(1).optional(),
});

const productionJobSpecs = [
  strictKind("canvas.image", { input: canvasJobInputSchema }),
  strictKind("canvas.video", { input: canvasVideoJobInputSchema }),
  strictKind("image.generate", { input: imageGenerationJobInputSchema }),
  strictKind("video.generate", { input: videoGenerationJobInputSchema }),
  strictKind("model.generate", { input: generated3dJobInputSchema }),
  strictKind("audio.generate", { input: audioGenerationJobInputSchema }),
  strictKind("media.proxy", { input: mediaProxyJobInputSchema }),
  strictKind("media.transcribe", { input: mediaTranscriptionJobInputSchema }),
  strictKind("media.transcode", { input: mediaTranscodeJobInputSchema }),
  strictKind("scene.reconstruct", { input: captureReconstructionJobInputSchema }),
  strictKind("dcc.export", { input: dccExportJobInputSchema }),
  strictKind("dcc.import", { input: dccImportJobInputSchema }),
  strictKind("episode.package", { input: episodePackageJobInputSchema }),
] as const;

/** A kind/input pair whose input is structurally tied to its executor kind. */
export const productionJobSpecSchema = z.discriminatedUnion("kind", productionJobSpecs);

/** Revisions of source artifacts at the time the job was enqueued, keyed by artifact id. */
export const sourceRevisionsSchema = z.record(
  z.string().min(1),
  z.union([z.string().min(1), z.number().int().nonnegative()]),
);

/** Structured error for a production job with code, message, and retryability. */
export const productionJobErrorSchema = z.strictObject({
  code: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(12000),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const safeFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"), {
    message: "Artifact fileName must be a single safe path segment",
  });

/** A single output artifact produced by a job attempt. */
export const productionJobArtifactSchema = z.strictObject({
  id: z.string().min(1),
  attemptId: z.string().min(1),
  role: z.string().trim().min(1).max(100).default("primary"),
  mimeType: z.string().min(1),
  fileName: safeFileNameSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

/** One attempt within a job's lifecycle, with status, timestamps, provider info, and artifacts. */
export const productionJobAttemptSchema = z.strictObject({
  id: z.string().min(1),
  number: z.number().int().positive(),
  status: productionJobStatusSchema,
  provider: z.string().trim().min(1).max(200),
  externalId: z.string().trim().min(1).max(500).optional(),
  /** Ordered provider phases; externalId remains the immutable first task for compatibility. */
  externalIds: z.array(z.string().trim().min(1).max(500)).min(1).max(16).optional(),
  inputFingerprint: z.string().min(1),
  idempotencyKey: z.string().min(1),
  sourceRevisions: sourceRevisionsSchema,
  timestamps: z.strictObject({
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    outcomeUnknownAt: z.string().datetime().optional(),
    reconciliationStartedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
  }),
  error: productionJobErrorSchema.optional(),
  artifacts: z.array(productionJobArtifactSchema),
});

const enqueueMetadataShape = {
  contractVersion: z.literal(PRODUCTION_JOB_CONTRACT_VERSION).default(PRODUCTION_JOB_CONTRACT_VERSION),
  idempotencyKey: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).max(200).default("director.local"),
  externalId: z.string().trim().min(1).max(500).optional(),
  sourceRevisions: sourceRevisionsSchema.default({}),
};

/** Request to enqueue a production job; a discriminated union over all job kinds. */
export const enqueueProductionJobRequestSchema = z.discriminatedUnion("kind", [
  productionJobSpecs[0].extend(enqueueMetadataShape),
  productionJobSpecs[1].extend(enqueueMetadataShape),
  productionJobSpecs[2].extend(enqueueMetadataShape),
  productionJobSpecs[3].extend(enqueueMetadataShape),
  productionJobSpecs[4].extend(enqueueMetadataShape),
  productionJobSpecs[5].extend(enqueueMetadataShape),
  productionJobSpecs[6].extend(enqueueMetadataShape),
  productionJobSpecs[7].extend(enqueueMetadataShape),
  productionJobSpecs[8].extend(enqueueMetadataShape),
  productionJobSpecs[9].extend(enqueueMetadataShape),
  productionJobSpecs[10].extend(enqueueMetadataShape),
  productionJobSpecs[11].extend(enqueueMetadataShape),
  productionJobSpecs[12].extend(enqueueMetadataShape),
]);

// Canvas bridge: keep the historical Canvas request parser available.
/** Request to enqueue a canvas job; subset of the full production job kinds. */
export const enqueueCanvasJobRequestSchema = z.discriminatedUnion("kind", [
  productionJobSpecs[0].extend(enqueueMetadataShape),
  productionJobSpecs[1].extend(enqueueMetadataShape),
]);

const recordMetadataShape = {
  contractVersion: z.literal(PRODUCTION_JOB_CONTRACT_VERSION),
  id: z.string().min(1),
  status: productionJobStatusSchema,
  progress: z.number().min(0).max(1),
  inputFingerprint: z.string().min(1),
  idempotencyKey: z.string().min(1),
  attempts: z.array(productionJobAttemptSchema).min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  message: z.string().optional(),
  artifacts: z.array(productionJobArtifactSchema),
  // Singular artifact and string error are retained for the current Canvas bridge.
  artifact: productionJobArtifactSchema.optional(),
  error: z.string().optional(),
};

/** The full durable job record with all attempts, self-validating against the job state machine. */
export const productionJobRecordSchema = z
  .discriminatedUnion("kind", [
    productionJobSpecs[0].extend(recordMetadataShape),
    productionJobSpecs[1].extend(recordMetadataShape),
    productionJobSpecs[2].extend(recordMetadataShape),
    productionJobSpecs[3].extend(recordMetadataShape),
    productionJobSpecs[4].extend(recordMetadataShape),
    productionJobSpecs[5].extend(recordMetadataShape),
    productionJobSpecs[6].extend(recordMetadataShape),
    productionJobSpecs[7].extend(recordMetadataShape),
    productionJobSpecs[8].extend(recordMetadataShape),
    productionJobSpecs[9].extend(recordMetadataShape),
    productionJobSpecs[10].extend(recordMetadataShape),
    productionJobSpecs[11].extend(recordMetadataShape),
    productionJobSpecs[12].extend(recordMetadataShape),
  ])
  .superRefine((job, context) => {
    const current = job.attempts.at(-1);
    if (current?.status !== job.status) {
      context.addIssue({
        code: "custom",
        path: ["attempts", job.attempts.length - 1, "status"],
        message: "The latest attempt status must match the job status",
      });
    }
    const attemptIds = new Set<string>();
    for (let index = 0; index < job.attempts.length; index += 1) {
      const attempt = job.attempts[index]!;
      if (attemptIds.has(attempt.id)) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "id"],
          message: "Attempt IDs must be unique within a job",
        });
      }
      attemptIds.add(attempt.id);
      if (attempt.number !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "number"],
          message: "Attempt numbers must be contiguous and one-based",
        });
      }
      if (attempt.externalIds && attempt.externalId !== attempt.externalIds[0]) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "externalIds"],
          message: "externalIds must begin with the immutable externalId",
        });
      }
      if (attempt.externalIds && new Set(attempt.externalIds).size !== attempt.externalIds.length) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "externalIds"],
          message: "externalIds must be unique and ordered",
        });
      }
      if (attempt.inputFingerprint !== job.inputFingerprint || attempt.idempotencyKey !== job.idempotencyKey) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index],
          message: "Every attempt must freeze the logical job fingerprint and idempotency key",
        });
      }
      if (index < job.attempts.length - 1 && !isTerminalProductionJobStatus(attempt.status)) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "status"],
          message: "Historical attempts must be terminal",
        });
      }
      if (attempt.status === "running" && !attempt.timestamps.startedAt) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "timestamps", "startedAt"],
          message: "A running attempt must record when execution started",
        });
      }
      if (
        (attempt.status === "outcome_unknown" || attempt.status === "reconciling") &&
        !attempt.timestamps.outcomeUnknownAt
      ) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "timestamps", "outcomeUnknownAt"],
          message: "An uncertain attempt must record when its outcome became unknown",
        });
      }
      if (attempt.status === "reconciling" && !attempt.timestamps.reconciliationStartedAt) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "timestamps", "reconciliationStartedAt"],
          message: "A reconciling attempt must record when reconciliation started",
        });
      }
      if (isTerminalProductionJobStatus(attempt.status) && !attempt.timestamps.finishedAt) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "timestamps", "finishedAt"],
          message: "A terminal attempt must record when it finished",
        });
      }
      if (!isTerminalProductionJobStatus(attempt.status) && attempt.timestamps.finishedAt) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "timestamps", "finishedAt"],
          message: "A non-terminal attempt cannot have a finished timestamp",
        });
      }
      for (const artifact of attempt.artifacts) {
        if (artifact.attemptId !== attempt.id) {
          context.addIssue({
            code: "custom",
            path: ["attempts", index, "artifacts"],
            message: "Attempt artifacts must reference their owning attempt",
          });
        }
      }
    }
    const artifactIds = new Set(job.artifacts.map((artifact) => artifact.id));
    if (artifactIds.size !== job.artifacts.length) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "Artifact IDs must be unique" });
    }
    for (const artifact of job.artifacts) {
      if (!attemptIds.has(artifact.attemptId)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts"],
          message: "Every artifact must reference an attempt in this job",
        });
      }
    }
    const attemptArtifacts = job.attempts.flatMap((attempt) => attempt.artifacts);
    if (
      attemptArtifacts.length !== job.artifacts.length ||
      attemptArtifacts.some((artifact, index) => JSON.stringify(artifact) !== JSON.stringify(job.artifacts[index]))
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Job artifacts must be the ordered, immutable projection of attempt artifacts",
      });
    }
    const promotedArtifact = job.artifact
      ? job.artifacts.find((artifact) => artifact.id === job.artifact?.id)
      : undefined;
    if (job.artifact && (!promotedArtifact || JSON.stringify(promotedArtifact) !== JSON.stringify(job.artifact))) {
      context.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "The compatibility artifact must exactly reference an immutable artifact in the job history",
      });
    }
  });

/** A discriminated kind/input pair for a production job. */
export type ProductionJobSpec = z.infer<typeof productionJobSpecSchema>;
/** Input shape for a production job spec. */
export type ProductionJobSpecInput = z.input<typeof productionJobSpecSchema>;
/** The input payload of a production job, keyed by kind. */
export type ProductionJobInput = ProductionJobSpec["input"];
/** Input shape for a canvas job. */
export type CanvasJobInput = z.infer<typeof canvasJobInputSchema>;
/** The full durable job record with all attempts. */
export type ProductionJobRecord = z.infer<typeof productionJobRecordSchema>;
/** One attempt within a job's lifecycle. */
export type ProductionJobAttempt = z.infer<typeof productionJobAttemptSchema>;
/** A single output artifact from a job attempt. */
export type ProductionJobArtifact = z.infer<typeof productionJobArtifactSchema>;
/** Structured error for a production job. */
export type ProductionJobError = z.infer<typeof productionJobErrorSchema>;
/** Request to enqueue a production job. */
export type EnqueueProductionJobRequest = z.infer<typeof enqueueProductionJobRequestSchema>;

/**
 * Computes a deterministic FNV-1a fingerprint of a job's kind and input,
 * used for idempotency and deduplication.
 *
 * @param kind - The job kind string.
 * @param input - The job's input payload.
 * @returns A fingerprint string prefixed with `fp-`.
 */
export function hashInputFingerprint(kind: ProductionJobKind | string, input: ProductionJobInput) {
  const payload = JSON.stringify({ kind, input });
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fp-${(hash >>> 0).toString(16)}`;
}

const TERMINAL: ReadonlySet<ProductionJobStatus> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Returns whether a job status is terminal (succeeded, failed, or cancelled).
 *
 * @param status - The job status to check.
 * @returns `true` when the status is terminal.
 */
export function isTerminalProductionJobStatus(status: ProductionJobStatus) {
  return TERMINAL.has(status);
}

/**
 * Validates whether a job status transition is allowed by the state machine.
 *
 * The graph is deliberately narrow: `outcome_unknown` can only move to
 * `reconciling` (never straight back to running or a terminal state), and
 * only `reconciling` may re-queue — the record must show that uncertainty
 * was resolved with the provider before any retry.
 *
 * @param from - The current status.
 * @param to - The desired status.
 * @returns `true` when the transition is valid.
 */
export function canTransitionProductionJob(from: ProductionJobStatus, to: ProductionJobStatus) {
  if (from === to) return true;
  if (from === "queued" && (to === "running" || to === "cancelled")) return true;
  if (from === "running" && (to === "succeeded" || to === "failed" || to === "cancelled" || to === "outcome_unknown"))
    return true;
  if (from === "outcome_unknown" && to === "reconciling") return true;
  if (from === "reconciling" && (to === "succeeded" || to === "failed" || to === "queued")) return true;
  return false;
}

function attemptErrorFromTransition(
  to: ProductionJobStatus,
  patch: Partial<ProductionJobRecord> & { structuredError?: ProductionJobError },
): ProductionJobError | undefined {
  if (patch.structuredError) return patch.structuredError;
  if (!patch.error) return undefined;
  return {
    code: to === "outcome_unknown" ? "outcome_unknown" : "job_failed",
    message: patch.error,
    retryable: to === "outcome_unknown",
  };
}

/**
 * Transitions a production job record to a new status, applying the patch
 * and updating the appropriate attempt timestamps and artifacts.
 *
 * Handles the special `reconciling → queued` retry path: the current attempt
 * is marked failed and a new queued attempt is appended.
 *
 * @param job - The current job record.
 * @param to - The target status.
 * @param patch - Optional updates to apply to the record.
 * @returns A new, validated job record reflecting the transition.
 * @throws When the transition is not allowed by the state machine.
 */
export function transitionProductionJob(
  job: ProductionJobRecord,
  to: ProductionJobStatus,
  patch: Partial<ProductionJobRecord> & { structuredError?: ProductionJobError } = {},
): ProductionJobRecord {
  if (!canTransitionProductionJob(job.status, to)) {
    throw new Error(`Invalid production job transition ${job.status} → ${to}`);
  }

  const updatedAt = patch.updatedAt ?? new Date().toISOString();
  const attempts: ProductionJobAttempt[] = job.attempts.map((attempt) => ({
    ...attempt,
    externalIds: attempt.externalIds ? [...attempt.externalIds] : undefined,
    sourceRevisions: { ...attempt.sourceRevisions },
    timestamps: { ...attempt.timestamps },
    artifacts: attempt.artifacts.map((artifact) => ({ ...artifact })),
    error: attempt.error
      ? { ...attempt.error, details: attempt.error.details ? { ...attempt.error.details } : undefined }
      : undefined,
  }));
  const current = attempts.at(-1)!;
  const transitionError = attemptErrorFromTransition(to, patch);
  const patchArtifacts = patch.artifacts ?? (patch.artifact ? [patch.artifact] : undefined);

  if (job.status === "reconciling" && to === "queued") {
    current.status = "failed";
    current.timestamps.finishedAt = updatedAt;
    current.error =
      transitionError ??
      ({
        code: "reconciled_not_accepted",
        message: "The provider confirmed that the previous attempt was not accepted; a retry may be queued.",
        retryable: true,
      } satisfies ProductionJobError);
    attempts.push({
      id: `${job.id}-attempt-${current.number + 1}`,
      number: current.number + 1,
      status: "queued",
      provider: current.provider,
      inputFingerprint: job.inputFingerprint,
      idempotencyKey: job.idempotencyKey,
      sourceRevisions: { ...current.sourceRevisions },
      timestamps: { createdAt: updatedAt },
      artifacts: [],
    });
  } else {
    current.status = to;
    if (to === "running") current.timestamps.startedAt ??= updatedAt;
    if (to === "outcome_unknown") current.timestamps.outcomeUnknownAt = updatedAt;
    if (to === "reconciling") current.timestamps.reconciliationStartedAt = updatedAt;
    if (isTerminalProductionJobStatus(to)) current.timestamps.finishedAt = updatedAt;
    if (transitionError) current.error = transitionError;
    if (patchArtifacts) {
      const artifactsById = new Map(current.artifacts.map((artifact) => [artifact.id, artifact]));
      for (const artifact of patchArtifacts) artifactsById.set(artifact.id, { ...artifact });
      current.artifacts = [...artifactsById.values()];
    }
  }

  const allArtifacts = attempts.flatMap((attempt) => attempt.artifacts);
  const { structuredError: _structuredError, ...recordPatch } = patch;
  return productionJobRecordSchema.parse({
    ...job,
    ...recordPatch,
    status: to,
    updatedAt,
    attempts,
    artifacts: allArtifacts,
    artifact: patch.artifact ?? job.artifact,
  });
}
