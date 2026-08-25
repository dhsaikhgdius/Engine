import { z } from "zod";

/**
 * ComfyUI generation protocol: workflow records, parameter schemas, node
 * definitions, and generation submission requests.
 *
 * This module defines the transport contracts shared between the gateway's
 * ComfyUI integration layer, the MCP server, and the browser. Workflows are
 * imported as JSON graphs, inspected for extractable parameters, and then
 * submitted with user-provided overrides, input images, and provenance so
 * every generation is auditable.
 */

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** The kind of media a ComfyUI workflow produces. */
export const comfyMediaKindSchema = z.enum(["image", "video", "audio"]);

/** Records how a prompt was authored and whether it was subsequently edited. */
export const comfyPromptProvenanceSchema = z.strictObject({
  source: z.enum(["manual", "storyboard"]).default("manual"),
  catalogVersion: z.string().trim().min(1).max(160).optional(),
  targetModel: z.string().trim().min(1).max(160).optional(),
  presetId: z.string().trim().min(1).max(160).optional(),
  mode: z.enum(["live_action", "animation"]).optional(),
  editedAfterCompile: z.boolean().default(false),
});

/** The type of a workflow parameter, describing its UI control and value shape. */
export const comfyParameterTypeSchema = z.enum([
  "text",
  "number",
  "integer",
  "boolean",
  "enum",
  "image",
  "model",
  "lora",
  "sampler",
  "scheduler",
]);

/** The semantic role of a workflow parameter, used for cross-workflow mapping. */
export const comfyParameterSemanticSchema = z.enum([
  "prompt",
  "negative_prompt",
  "width",
  "height",
  "seed",
  "steps",
  "cfg",
  "sampler",
  "scheduler",
  "model",
  "lora",
  "reference_image",
  "duration_seconds",
  "sample_rate",
  "voice",
  "language",
  "audio_mode",
]);

/** A single parameter value for a generation submission: string, number, boolean, null, or a list of those. */
export const comfyGenerationParameterValueSchema = z.union([
  z.string().max(24_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()])).max(256),
]);

/**
 * Key-value map of workflow parameter overrides for a generation submission.
 * At most 256 parameters may be overridden.
 */
export const comfyGenerationParametersSchema = z
  .record(z.string().trim().min(1).max(240), comfyGenerationParameterValueSchema)
  .refine((value) => Object.keys(value).length <= 256, "A generation may override at most 256 workflow parameters");

/** A single node in a ComfyUI workflow graph. */
export const comfyWorkflowNodeSchema = z.looseObject({
  class_type: nonEmptyText(240),
  inputs: z.record(z.string(), z.unknown()),
  _meta: z.looseObject({ title: z.string().max(500).optional() }).optional(),
});

/**
 * A ComfyUI workflow graph: a map of node id to node definition.
 * Must contain at least one node and at most 2,000.
 */
export const comfyWorkflowGraphSchema = z
  .record(z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/), comfyWorkflowNodeSchema)
  .refine((workflow) => Object.keys(workflow).length > 0, "A ComfyUI workflow must contain at least one node")
  .refine((workflow) => Object.keys(workflow).length <= 2_000, "A ComfyUI workflow may contain at most 2,000 nodes");

/** A user-facing parameter extracted from a workflow, with type, semantic, and constraints. */
export const comfyWorkflowParameterSchema = z.strictObject({
  id: nonEmptyText(240),
  label: nonEmptyText(500),
  nodeId: nonEmptyText(160),
  inputName: nonEmptyText(240),
  type: comfyParameterTypeSchema,
  semantic: comfyParameterSemanticSchema.nullable(),
  defaultValue: comfyGenerationParameterValueSchema,
  options: z.array(z.string().max(1_000)).max(10_000).default([]),
  minimum: z.number().finite().nullable().default(null),
  maximum: z.number().finite().nullable().default(null),
  step: z.number().finite().positive().nullable().default(null),
});

/**
 * A persisted ComfyUI workflow record: the graph, extracted parameters, and
 * metadata used for browsing and submission.
 */
export const comfyWorkflowRecordSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^comfy-workflow-[a-z0-9-]{3,100}$/i),
  name: nonEmptyText(240),
  description: z.string().trim().max(4_000).default(""),
  category: z.string().trim().max(160).default("Uncategorized"),
  mediaKind: comfyMediaKindSchema,
  workflow: comfyWorkflowGraphSchema,
  parameters: z.array(comfyWorkflowParameterSchema).max(256),
  workflowSha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["imported", "configured"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * The result of inspecting a workflow JSON before persisting it: extracted
 * parameters, detected class types, and any warnings.
 */
export const comfyWorkflowInspectionSchema = z.strictObject({
  mediaKind: comfyMediaKindSchema,
  nodeCount: z.number().int().positive(),
  parameters: z.array(comfyWorkflowParameterSchema),
  classTypes: z.array(nonEmptyText(240)),
  unsupportedClassTypes: z.array(nonEmptyText(240)),
  warnings: z.array(z.string().max(2_000)),
  workflowSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** A registered ComfyUI backend node that the gateway can dispatch jobs to. */
export const comfyNodeDefinitionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/i),
  label: nonEmptyText(160),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), "must use HTTP(S)"),
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(32).default(1),
});

/** The live status of a ComfyUI backend node. */
export const comfyNodeStatusSchema = z.enum(["online", "busy", "offline", "disabled"]);

/** A live snapshot of a ComfyUI backend node, including status and resource usage. */
export const comfyNodeSnapshotSchema = comfyNodeDefinitionSchema.extend({
  status: comfyNodeStatusSchema,
  activeJobs: z.number().int().nonnegative(),
  queuedJobs: z.number().int().nonnegative(),
  queueRemaining: z.number().int().nonnegative().nullable(),
  ramTotalBytes: z.number().nonnegative().nullable(),
  ramFreeBytes: z.number().nonnegative().nullable(),
  vramTotalBytes: z.number().nonnegative().nullable(),
  vramFreeBytes: z.number().nonnegative().nullable(),
  deviceName: z.string().max(500).nullable(),
  detail: z.string().max(2_000).nullable(),
  checkedAt: z.string().datetime(),
});

const comfyInputImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

/** A content-verified image accepted by one exact ComfyUI node. */
export const comfyUploadedInputImageSchema = z.strictObject({
  version: z.literal(1),
  nodeId: comfyNodeDefinitionSchema.shape.id,
  sourceMediaId: nonEmptyText(512),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  mimeType: comfyInputImageMimeTypeSchema,
  fileName: nonEmptyText(255),
  subfolder: z.string().max(240),
  storageType: z.literal("input"),
  workflowValue: nonEmptyText(500),
  uploadedAt: z.string().datetime(),
});

/** The upload receipt plus the exact exposed workflow input it satisfies. */
export const comfyGenerationInputImageSchema = comfyUploadedInputImageSchema.extend({
  parameterId: nonEmptyText(240),
});

const comfyGenerationContextValueSchema = z.union([z.string().max(4_000), z.number().finite(), z.boolean()]);

/** Context about the source of a generation request, used for provenance tracking. */
export const comfyGenerationSourceContextSchema = z.strictObject({
  source: z.enum(["manual", "storyboard"]).default("manual"),
  createdAt: z.string().datetime().optional(),
  targetModel: z.string().trim().min(1).max(160).optional(),
  metadata: z
    .record(z.string().trim().min(1).max(160), comfyGenerationContextValueSchema)
    .refine((value) => Object.keys(value).length <= 64, "Generation source metadata is limited to 64 entries")
    .default({}),
});

/** Request to import a new ComfyUI workflow from a raw JSON graph. */
export const comfyWorkflowImportRequestSchema = z.strictObject({
  name: nonEmptyText(240),
  description: z.string().trim().max(4_000).default(""),
  category: z.string().trim().max(160).default("Uncategorized"),
  mediaKind: comfyMediaKindSchema,
  workflow: comfyWorkflowGraphSchema,
});

/**
 * Request to submit a generation job to one or more ComfyUI nodes.
 *
 * Includes the workflow, prompt, dimensions, seed strategy, input images,
 * provenance, and an optional idempotency key so the gateway can deduplicate
 * retried submissions.
 */
export const comfyGenerationSubmitRequestSchema = z.strictObject({
  kind: z.enum(["image.generate", "video.generate", "audio.generate"]),
  workflowId: nonEmptyText(160),
  prompt: nonEmptyText(12_000),
  negativePrompt: z.string().trim().max(12_000).optional(),
  width: z.number().int().min(64).max(8_192).default(1_024),
  height: z.number().int().min(64).max(8_192).default(1_024),
  seed: z.number().int().min(0).max(2_147_483_647).default(0),
  durationSeconds: z.number().positive().max(600).default(5),
  fps: z.number().positive().max(240).default(24),
  audioMode: z.enum(["sound-effect", "music", "speech"]).default("sound-effect"),
  sampleRate: z.number().int().min(8_000).max(192_000).default(48_000),
  voice: z.string().trim().min(1).max(240).optional(),
  language: z.string().trim().min(1).max(80).optional(),
  parameters: comfyGenerationParametersSchema.default({}),
  inputImages: z.array(comfyGenerationInputImageSchema).max(64).default([]),
  sourceArtifactIds: z.array(nonEmptyText(512)).max(64).default([]),
  sourceContext: comfyGenerationSourceContextSchema.default({ source: "manual", metadata: {} }),
  nodeIds: z.array(comfyNodeDefinitionSchema.shape.id).max(32).default([]),
  copies: z.number().int().min(1).max(32).default(1),
  seedStrategy: z.enum(["fixed", "increment", "random"]).default("increment"),
  promptProvenance: comfyPromptProvenanceSchema.default({ source: "manual", editedAfterCompile: false }),
  /** Rewrite the prompt into the target workflow's dialect at the gateway before submission. */
  enhancePrompt: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(1).max(180).optional(),
});

/** The kind of media a ComfyUI workflow produces. */
export type ComfyMediaKind = z.infer<typeof comfyMediaKindSchema>;
/** A single parameter value for a generation submission. */
export type ComfyGenerationParameterValue = z.infer<typeof comfyGenerationParameterValueSchema>;
/** Key-value map of workflow parameter overrides. */
export type ComfyGenerationParameters = z.infer<typeof comfyGenerationParametersSchema>;
/** A ComfyUI workflow graph. */
export type ComfyWorkflowGraph = z.infer<typeof comfyWorkflowGraphSchema>;
/** A user-facing parameter extracted from a workflow. */
export type ComfyWorkflowParameter = z.infer<typeof comfyWorkflowParameterSchema>;
/** A persisted ComfyUI workflow record. */
export type ComfyWorkflowRecord = z.infer<typeof comfyWorkflowRecordSchema>;
/** The result of inspecting a workflow JSON before persisting it. */
export type ComfyWorkflowInspection = z.infer<typeof comfyWorkflowInspectionSchema>;
/** A registered ComfyUI backend node definition. */
export type ComfyNodeDefinition = z.infer<typeof comfyNodeDefinitionSchema>;
/** A live snapshot of a ComfyUI backend node. */
export type ComfyNodeSnapshot = z.infer<typeof comfyNodeSnapshotSchema>;
/** A content-verified image uploaded to a ComfyUI node. */
export type ComfyUploadedInputImage = z.infer<typeof comfyUploadedInputImageSchema>;
/** An uploaded input image bound to a specific workflow parameter. */
export type ComfyGenerationInputImage = z.infer<typeof comfyGenerationInputImageSchema>;
/** Context about the source of a generation request. */
export type ComfyGenerationSourceContext = z.infer<typeof comfyGenerationSourceContextSchema>;
/** A request to submit a generation job to ComfyUI nodes. */
export type ComfyGenerationSubmitRequest = z.infer<typeof comfyGenerationSubmitRequestSchema>;
/** Records how a prompt was authored and whether it was subsequently edited. */
export type ComfyPromptProvenance = z.infer<typeof comfyPromptProvenanceSchema>;