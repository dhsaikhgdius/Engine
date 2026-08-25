import { z } from "zod";
import {
  videoJobStatusSchema,
  videoProviderCapabilitySchema,
  videoProviderIdSchema,
  videoRuntimeSourceSchema,
  type VideoProviderCapability,
  type VideoProviderId,
} from "../../../../packages/protocol/src/videoGenerationProtocol";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const videoJobIdSchema = z.string().regex(/^video-[a-z0-9-]{8,80}$/i);

/** Allowed roles for conditioning inputs in a video generation request. */
export const videoConditioningRoleSchema = z.enum([
  "reference",
  "clean-frame",
  "depth",
  "normal",
  "object-id",
  "mask",
  "motion-track",
]);

/** Schema for a single conditioning input (reference image, depth map, etc.). */
export const videoConditioningInputSchema = z.strictObject({
  /** The conditioning role this input fulfills. */
  role: videoConditioningRoleSchema,
  /** URI of the conditioning asset. */
  uri: nonEmptyText(4_096),
  /** MIME type of the conditioning asset. */
  mimeType: nonEmptyText(160).optional(),
  /** Target frame index for this conditioning input. */
  frameIndex: z.number().int().min(0).max(1_440).default(0),
  /** Conditioning strength, 0–1. */
  strength: z.number().finite().min(0).max(1).default(1),
  /** CRF quality parameter for video encoding. */
  crf: z.number().int().min(0).max(51).default(19),
});

/** Schema for a video generation request submitted to any provider. */
export const videoGenerationRequestSchema = z.strictObject({
  /** Unique idempotency key used to deduplicate submissions. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,160}$/),
  /** Primary text prompt describing the desired video. */
  prompt: nonEmptyText(6_000),
  /** Optional negative prompt for content to avoid. */
  negativePrompt: z.string().trim().max(2_000).optional(),
  /** Optional model identifier override. */
  model: nonEmptyText(160).optional(),
  /** Output video width in pixels. */
  width: z.number().int().min(256).max(4_096),
  /** Output video height in pixels. */
  height: z.number().int().min(256).max(4_096),
  /** Output frame rate in frames per second. */
  frameRate: z.number().finite().gt(0).max(60),
  /** Number of frames to generate. */
  numFrames: z.number().int().min(9).max(1_441),
  /** Random seed for deterministic generation. */
  seed: z.number().int().min(0).max(2_147_483_647),
  /** Whether to generate an audio track alongside the video. */
  generateAudio: z.boolean().default(true),
  /** Whether to expand the prompt before generation. */
  enhancePrompt: z.boolean().default(false),
  /** Conditioning inputs such as reference images or depth maps. */
  conditioning: z.array(videoConditioningInputSchema).max(16).default([]),
  /** Arbitrary metadata attached to the job. */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

/** Schema for a progress snapshot within a video generation job. */
export const videoProviderProgressSchema = z.strictObject({
  /** Human-readable phase label. */
  phase: nonEmptyText(120),
  /** Completion percentage, 0–100. */
  percent: z.number().finite().min(0).max(100),
});

/** Schema for a single output artifact produced by a video generation job. */
export const videoProviderOutputSchema = z.strictObject({
  /** The kind of output (video, audio, thumbnail, or metadata). */
  kind: z.enum(["video", "audio", "thumbnail", "metadata"]),
  /** URI at which the output can be retrieved. */
  uri: nonEmptyText(4_096),
  /** MIME type of the output. */
  mimeType: nonEmptyText(160),
  /** Optional byte size of the output. */
  bytes: z.number().int().nonnegative().optional(),
  /** Optional SHA-256 hash of the output. */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

/** Schema for a structured error attached to a failed video generation job. */
export const videoProviderErrorSchema = z.strictObject({
  /** Machine-readable error code. */
  code: nonEmptyText(160),
  /** Human-readable error message. */
  message: nonEmptyText(4_000),
  /** Whether the job can be retried. */
  retriable: z.boolean(),
});

/** Schema for a video generation job record. */
export const videoProviderJobSchema = z.strictObject({
  /** Unique job identifier. */
  id: videoJobIdSchema,
  /** Provider that owns this job. */
  provider: videoProviderIdSchema,
  /** Current job status. */
  status: videoJobStatusSchema,
  /** ISO 8601 timestamp of when the job was created. */
  createdAt: z.string().datetime({ offset: true }),
  /** ISO 8601 timestamp of when the job was last updated. */
  updatedAt: z.string().datetime({ offset: true }),
  /** Current progress snapshot, or null if not yet started. */
  progress: videoProviderProgressSchema.nullable(),
  /** Output artifacts produced so far. */
  outputs: z.array(videoProviderOutputSchema),
  /** Structured error if the job failed, or null. */
  error: videoProviderErrorSchema.nullable(),
  /** Whether cancellation has been requested. */
  cancelRequested: z.boolean().default(false),
  /** Non-fatal warnings attached to the job. */
  warnings: z.array(nonEmptyText(1_000)).default([]),
});

/** Schema for a provider health check response. */
export const videoProviderHealthSchema = z.strictObject({
  /** The provider identifier. */
  provider: videoProviderIdSchema,
  /** Current health status of the provider. */
  status: z.enum(["ready", "loading", "cold", "unconfigured", "degraded"]),
  /** Whether the model is loaded and ready. */
  modelLoaded: z.boolean(),
  /** ID of the currently active job, or null. */
  activeJobId: videoJobIdSchema.nullable(),
  /** Optional human-readable detail about the health status. */
  detail: z.string().max(2_000).nullable(),
  /** Optional runtime source descriptor. */
  runtimeSource: videoRuntimeSourceSchema.nullable().optional(),
});

export type VideoConditioningInput = z.infer<typeof videoConditioningInputSchema>;
export type VideoGenerationRequest = z.infer<typeof videoGenerationRequestSchema>;
export type VideoProviderJob = z.infer<typeof videoProviderJobSchema>;
export type VideoProviderHealth = z.infer<typeof videoProviderHealthSchema>;

/**
 * Contract that every video generation provider must implement.
 *
 * Providers encapsulate the lifecycle of a video generation job: capability
 * introspection, health checks, submission, polling, and cancellation.
 */
export interface VideoProvider {
  /** Stable provider identifier. */
  readonly id: VideoProviderId;
  /**
   * Returns the provider's capabilities.
   *
   * @param signal - Optional abort signal.
   * @returns A capability declaration.
   */
  capabilities(signal?: AbortSignal): Promise<VideoProviderCapability>;
  /**
   * Returns the provider's current health status.
   *
   * @param signal - Optional abort signal.
   * @returns A health report.
   */
  health(signal?: AbortSignal): Promise<VideoProviderHealth>;
  /**
   * Submits a new video generation job.
   *
   * @param request - The generation request.
   * @param signal - Optional abort signal.
   * @returns The created job record.
   */
  submit(request: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoProviderJob>;
  /**
   * Retrieves the current status of a previously submitted job.
   *
   * @param jobId - The provider-assigned job identifier.
   * @param signal - Optional abort signal.
   * @returns The current job record.
   */
  getJob(jobId: string, signal?: AbortSignal): Promise<VideoProviderJob>;
  /**
   * Cancels a running or queued job.
   *
   * @param jobId - The provider-assigned job identifier.
   * @param signal - Optional abort signal.
   * @returns The updated job record.
   */
  cancel(jobId: string, signal?: AbortSignal): Promise<VideoProviderJob>;
}

/**
 * Error thrown when a video provider's HTTP request fails.
 *
 * Carries the HTTP status code and a flag indicating whether the request
 * can be retried.
 */
export class VideoProviderHttpError extends Error {
  constructor(
    message: string,
    /** HTTP status code returned by the provider. */
    readonly status: number,
    /** Whether the error is transient and the request can be retried. */
    readonly retriable: boolean,
    /** Optional raw response body for debugging. */
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "VideoProviderHttpError";
  }
}

/**
 * Validates an unknown value against the video provider capability schema.
 *
 * @param value - The value to validate.
 * @returns A validated {@link VideoProviderCapability}.
 * @throws {ZodError} When the value does not conform to the schema.
 */
export function parseVideoProviderCapability(value: unknown) {
  return videoProviderCapabilitySchema.parse(value);
}

/**
 * Validates an unknown value against the video generation request schema.
 *
 * @param value - The value to validate.
 * @returns A validated {@link VideoGenerationRequest}.
 * @throws {ZodError} When the value does not conform to the schema.
 */
export function parseVideoGenerationRequest(value: unknown) {
  return videoGenerationRequestSchema.parse(value);
}

/**
 * Validates an unknown value against the video provider job schema.
 *
 * @param value - The value to validate.
 * @returns A validated {@link VideoProviderJob}.
 * @throws {ZodError} When the value does not conform to the schema.
 */
export function parseVideoProviderJob(value: unknown) {
  return videoProviderJobSchema.parse(value);
}

/**
 * Validates an unknown value against the video provider health schema.
 *
 * @param value - The value to validate.
 * @returns A validated {@link VideoProviderHealth}.
 * @throws {ZodError} When the value does not conform to the schema.
 */
export function parseVideoProviderHealth(value: unknown) {
  return videoProviderHealthSchema.parse(value);
}
