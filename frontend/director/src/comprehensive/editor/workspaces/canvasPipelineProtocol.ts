import { z } from "zod";
import { comfyGenerationParametersSchema } from "../../../../../../packages/protocol/src/comfyGenerationProtocol";

/** Maximum number of pipeline runs retained in the Canvas pipeline history. */
export const DIRECTOR_CANVAS_PIPELINE_HISTORY_LIMIT = 40;

/** Maximum number of output records retained per Canvas node. */
export const DIRECTOR_CANVAS_NODE_OUTPUT_HISTORY_LIMIT = 32;

/** Zod schema for a Canvas production node's generation configuration. */
export const directorCanvasProductionConfigSchema = z.strictObject({
  workflowId: z.string().trim().min(1).max(160).nullable().default(null),
  nodeIds: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  negativePrompt: z.string().trim().max(12_000).default(""),
  seed: z.number().int().min(0).max(2_147_483_647).default(0),
  durationSeconds: z.number().positive().max(600).default(5),
  fps: z.number().positive().max(240).default(24),
  audioMode: z.enum(["sound-effect", "music", "speech"]).default("sound-effect"),
  sampleRate: z.number().int().min(8_000).max(192_000).default(48_000),
  voice: z.string().trim().max(240).default(""),
  language: z.string().trim().max(80).default(""),
  parameters: comfyGenerationParametersSchema.default({}),
});

/** Configuration for a Canvas production node's generation parameters. */
export type DirectorCanvasProductionConfig = z.infer<typeof directorCanvasProductionConfigSchema>;

/**
 * Creates a production config with every field set to its schema default.
 *
 * @returns A fully defaulted production config.
 */
export function createDefaultDirectorCanvasProductionConfig(): DirectorCanvasProductionConfig {
  return directorCanvasProductionConfigSchema.parse({});
}

/** Zod schema for a single output artifact produced by a Canvas node during a pipeline run. */
export const directorCanvasNodeOutputSchema = z.strictObject({
  runId: z.string().trim().min(1).max(160),
  requestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["succeeded", "failed", "cancelled", "stale"]),
  jobId: z.string().trim().min(1).max(200).nullable(),
  artifactId: z.string().trim().min(1).max(200).nullable(),
  mediaId: z.string().trim().min(1).max(512).nullable(),
  workflowId: z.string().trim().min(1).max(160).nullable(),
  nodeId: z.string().trim().min(1).max(80).nullable(),
  createdAt: z.string().datetime(),
  error: z.string().trim().max(12_000).nullable(),
});

/** A single output artifact produced by a Canvas node during a pipeline run. */
export type DirectorCanvasNodeOutput = z.infer<typeof directorCanvasNodeOutputSchema>;

/** Zod schema for the status of a node within a pipeline run. */
export const directorCanvasPipelineNodeStatusSchema = z.enum([
  "pending",
  "running",
  "passthrough",
  "cached",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "stale",
]);

/** The status of a node within a pipeline run. */
export type DirectorCanvasPipelineNodeStatus = z.infer<typeof directorCanvasPipelineNodeStatusSchema>;

/** Zod schema for a single node's execution record within a pipeline run. */
export const directorCanvasPipelineNodeRunSchema = z.strictObject({
  nodeId: z.string().trim().min(1).max(200),
  status: directorCanvasPipelineNodeStatusSchema,
  requestFingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  jobId: z.string().trim().min(1).max(200).nullable(),
  artifactId: z.string().trim().min(1).max(200).nullable(),
  mediaId: z.string().trim().min(1).max(512).nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().trim().max(12_000).nullable(),
});

/** A single node's execution record within a pipeline run. */
export type DirectorCanvasPipelineNodeRun = z.infer<typeof directorCanvasPipelineNodeRunSchema>;

/** Zod schema for a complete pipeline execution run across the Canvas DAG. */
export const directorCanvasPipelineRunSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().trim().min(1).max(160),
  graphFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["running", "succeeded", "partial", "failed", "cancelled"]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  nodeRuns: z.array(directorCanvasPipelineNodeRunSchema).max(240),
  error: z.string().trim().max(12_000).nullable(),
  agentRequest: z
    .strictObject({
      idempotencyKey: z.string().trim().min(8).max(160),
      targetNodeIds: z.array(z.string().trim().min(1).max(200)).max(240),
      forceNodeIds: z.array(z.string().trim().min(1).max(200)).max(240),
      maxParallel: z.number().int().min(1).max(16),
    })
    .optional(),
});

/** A complete pipeline execution run across the Canvas DAG. */
export type DirectorCanvasPipelineRun = z.infer<typeof directorCanvasPipelineRunSchema>;