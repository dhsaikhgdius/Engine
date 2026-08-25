import { z } from "zod";
import { strictKind, strictOperation } from "./strictProtocolVariant";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const videoJobId = z.string().regex(/^video-[a-z0-9-]{8,80}$/i);

/** Supported video generation providers. */
export const videoProviderIdSchema = z.enum(["ltx-2.3", "comfyui", "minimax-h3"]);
/** Lifecycle statuses for a video generation job. */
export const videoJobStatusSchema = z.enum(["prepared", "queued", "running", "completed", "failed", "cancelled"]);

/** Provenance metadata for an official provider runtime source. */
export const videoRuntimeSourceSchema = strictKind("official-source", {
  repository: nonEmptyText(4_096),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  packageVersion: nonEmptyText(80),
  pipeline: nonEmptyText(240),
});

const renderInputShape = {
  provider: videoProviderIdSchema.optional(),
  prompt: nonEmptyText(6_000),
  negative_prompt: z.string().trim().max(2_000).optional(),
  model: nonEmptyText(160).optional(),
  width: z.number().int().min(256).max(4_096).optional(),
  height: z.number().int().min(256).max(4_096).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  duration_s: z.number().finite().min(0.5).max(30).optional(),
  num_frames: z.number().int().min(9).max(1_441).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  generate_audio: z.boolean().optional(),
  enhance_prompt: z.boolean().optional(),
} as const;

/**
 * Operation-based protocol for video model interaction.
 *
 * Supports capabilities, prepare, render, submit, status, and cancel
 * operations, each discriminated by the `op` field.
 */
export const videoModelOperationSchema = z.discriminatedUnion("op", [
  strictOperation("capabilities", {}),
  strictOperation("prepare", renderInputShape),
  strictOperation("render", renderInputShape),
  strictOperation("submit", { job_id: videoJobId }),
  strictOperation("status", { job_id: videoJobId }),
  strictOperation("cancel", { job_id: videoJobId }),
]);

/** Advertised capability of a registered video generation provider. */
export const videoProviderCapabilitySchema = z.strictObject({
  id: videoProviderIdSchema,
  label: nonEmptyText(160),
  configured: z.boolean(),
  supportsImageConditioning: z.boolean(),
  supportsAudio: z.boolean(),
  supportsNegativePrompt: z.boolean(),
  dimensionMultiple: z.number().int().positive().nullable(),
  frameCountRule: z.enum(["any", "8k+1"]),
  model: z.string().nullable(),
  runtimeSource: videoRuntimeSourceSchema.nullable().optional(),
});

/** Response payload listing all available video providers and their capabilities. */
export const videoProviderCapabilitiesResponseSchema = z.strictObject({
  defaultProvider: videoProviderIdSchema,
  providers: z.array(videoProviderCapabilitySchema),
});

export type VideoProviderId = z.infer<typeof videoProviderIdSchema>;
export type VideoJobStatus = z.infer<typeof videoJobStatusSchema>;
export type VideoModelOperation = z.infer<typeof videoModelOperationSchema>;
export type VideoProviderCapability = z.infer<typeof videoProviderCapabilitySchema>;
export type VideoRuntimeSource = z.infer<typeof videoRuntimeSourceSchema>;

/**
 * Clamps and rounds a dimension to the nearest multiple of 64, within
 * the LTX valid range [256, 4096].
 *
 * @param value - The raw dimension value in pixels.
 * @returns The normalized dimension.
 */
export function normalizeLtxDimension(value: number) {
  return Math.min(4_096, Math.max(256, Math.round(value / 64) * 64));
}

/** LTX temporal VAEs accept frame counts in the form 8k+1. */
export function normalizeLtxFrameCount(value: number) {
  return Math.min(1_441, Math.max(9, Math.round((value - 1) / 8) * 8 + 1));
}
