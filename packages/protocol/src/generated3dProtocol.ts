import { z } from "zod";

/**
 * Shared contract identifier for the generated-3D artifact protocol.
 *
 * Every receipt, normalization report, and promotion payload carries this
 * literal so consumers can validate the wire format before deserializing.
 */
export const DIRECTOR_GENERATED_3D_CONTRACT = "director-generated-3d-v1" as const;

/** Maximum byte size of a source image accepted for 3D generation. */
export const DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/** Maximum byte size of a generated 3D model file (GLB). */
export const DIRECTOR_GENERATED_3D_MAX_MODEL_BYTES = 512 * 1024 * 1024;

/** Maximum byte size of a generated 3D thumbnail image. */
export const DIRECTOR_GENERATED_3D_MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;

/** Hard ceiling on triangle count for any normalized generated model. */
export const DIRECTOR_GENERATED_3D_MAX_TRIANGLES = 5_000_000;

const nonEmpty = (maximum: number) => z.string().trim().min(1).max(maximum);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const imageMimeType = z.enum(["image/jpeg", "image/png"]);

/** Supported third-party 3D generation providers. */
export const generated3dProviderIdSchema = z.enum(["meshy", "tripo", "infinigen"]);

/** Generation mode: text prompt or image conditioning. */
export const generated3dModeSchema = z.enum(["text-to-3d", "image-to-3d"]);

/** Target mesh topology for the generated model. */
export const generated3dTopologySchema = z.enum(["triangle", "quad", "lowpoly"]);

/** Metadata for a source image used as conditioning input. */
export const generated3dSourceImageSchema = z.strictObject({
  sha256,
  mimeType: imageMimeType,
  bytes: z.number().int().min(1).max(DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES),
});

const generated3dJobFields = {
  mode: generated3dModeSchema,
  providerId: generated3dProviderIdSchema,
  name: nonEmpty(160),
  prompt: nonEmpty(600),
  negativePrompt: z.string().trim().max(255).optional(),
  sourceImage: generated3dSourceImageSchema.nullable().default(null),
  targetHeightMeters: z.number().finite().min(0.01).max(100).default(1),
  topology: generated3dTopologySchema.default("triangle"),
  targetPolygonCount: z.number().int().min(100).max(2_000_000).default(50_000),
  texture: z.boolean().default(true),
  pbr: z.boolean().default(true),
  seed: z.number().int().min(0).max(2_147_483_647).default(0),
  modelVersion: nonEmpty(160).optional(),
};

/**
 * Validated job input for a 3D generation run.
 *
 * Cross-validates mode and source image constraints: image-to-3d requires a
 * source image, text-to-3d forbids one, and PBR output requires texture
 * generation to be enabled.
 */
export const generated3dJobInputSchema = z.strictObject(generated3dJobFields).superRefine((input, context) => {
  if (input.mode === "image-to-3d" && !input.sourceImage) {
    context.addIssue({ code: "custom", path: ["sourceImage"], message: "image-to-3d requires a source image" });
  }
  if (input.mode === "text-to-3d" && input.sourceImage) {
    context.addIssue({ code: "custom", path: ["sourceImage"], message: "text-to-3d cannot carry a source image" });
  }
  if (!input.texture && input.pbr) {
    context.addIssue({ code: "custom", path: ["pbr"], message: "PBR output requires texture generation" });
  }
});

const generated3dSourceDataUrlSchema = z
  .string()
  .max(Math.ceil((DIRECTOR_GENERATED_3D_MAX_SOURCE_BYTES * 4) / 3) + 128)
  .regex(/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/);

/**
 * Client-facing submit request for a 3D generation job.
 *
 * Accepts a base64 data URL for the source image rather than the pre-hashed
 * metadata required by the internal job input. An optional idempotency key
 * prevents duplicate submissions within the same project.
 */
export const generated3dSubmitRequestSchema = z
  .strictObject({
    mode: generated3dModeSchema,
    providerId: generated3dProviderIdSchema.optional(),
    name: nonEmpty(160),
    prompt: nonEmpty(600),
    negativePrompt: z.string().trim().max(255).optional(),
    sourceImageDataUrl: generated3dSourceDataUrlSchema.optional(),
    /** Omit to let the gateway estimate a plausible real-world height from the prompt. */
    targetHeightMeters: z.number().finite().min(0.01).max(100).optional(),
    topology: generated3dJobFields.topology,
    targetPolygonCount: generated3dJobFields.targetPolygonCount,
    texture: generated3dJobFields.texture,
    pbr: generated3dJobFields.pbr,
    seed: generated3dJobFields.seed,
    modelVersion: generated3dJobFields.modelVersion,
    idempotencyKey: z.string().trim().min(1).max(180).optional(),
  })
  .superRefine((input, context) => {
    if (input.mode === "image-to-3d" && !input.sourceImageDataUrl) {
      context.addIssue({
        code: "custom",
        path: ["sourceImageDataUrl"],
        message: "image-to-3d requires sourceImageDataUrl",
      });
    }
    if (input.mode === "text-to-3d" && input.sourceImageDataUrl) {
      context.addIssue({
        code: "custom",
        path: ["sourceImageDataUrl"],
        message: "text-to-3d cannot carry sourceImageDataUrl",
      });
    }
    if (!input.texture && input.pbr) {
      context.addIssue({ code: "custom", path: ["pbr"], message: "PBR output requires texture generation" });
    }
  });

/** Advertised capability of a registered 3D generation provider. */
export const generated3dProviderCapabilitySchema = z.strictObject({
  id: generated3dProviderIdSchema,
  label: nonEmpty(160),
  configured: z.boolean(),
  modes: z.array(generated3dModeSchema).min(1).max(2),
  modelVersion: z.string().max(160).nullable(),
  cancellation: z.enum(["remote", "local-only"]),
  documentationUrl: z.string().url(),
});

const boundsSchema = z.strictObject({
  min: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  max: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
});

/**
 * Post-import normalization report for a generated 3D model.
 *
 * Records the coordinate system, applied scale, pre/post bounds, and
 * triangle/node counts after the normalizer has processed the raw provider
 * output into a Director-ready GLB.
 */
export const generated3dNormalizationReportSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GENERATED_3D_CONTRACT),
  adapter: z.literal("director-generated-3d-normalizer-v1"),
  stableAssetId: nonEmpty(240),
  sourceSha256: sha256,
  normalizedSha256: sha256,
  coordinateSystem: z.strictObject({
    linearUnit: z.literal("meter"),
    metersPerUnit: z.literal(1),
    upAxis: z.literal("Y"),
    handedness: z.literal("right"),
  }),
  targetHeightMeters: z.number().finite().min(0.01).max(100),
  appliedScale: z.number().finite().positive(),
  sourceBounds: boundsSchema,
  normalizedBounds: boundsSchema,
  nodeCount: z.number().int().positive(),
  meshCount: z.number().int().positive(),
  materialCount: z.number().int().nonnegative(),
  triangleCount: z.number().int().positive().max(DIRECTOR_GENERATED_3D_MAX_TRIANGLES),
  animationCount: z.number().int().nonnegative(),
  skinCount: z.number().int().nonnegative(),
  removedCameraCount: z.number().int().nonnegative(),
  decodedCompressionExtensions: z.array(z.enum(["EXT_meshopt_compression", "KHR_draco_mesh_compression"])),
  warnings: z.array(z.string().trim().min(1).max(1_000)).max(50),
});

/**
 * Provider-agnostic receipt for a completed 3D generation job.
 *
 * Carries the full provenance chain: job and attempt ids, provider and model
 * version, external id, the normalization report, and a two-entry artifact
 * manifest (primary model + thumbnail).
 */
export const generated3dReceiptSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GENERATED_3D_CONTRACT),
  jobId: nonEmpty(240),
  attemptId: nonEmpty(240),
  providerId: generated3dProviderIdSchema,
  providerModelVersion: z.string().max(160).nullable(),
  externalId: nonEmpty(500),
  mode: generated3dModeSchema,
  promptSha256: sha256,
  sourceImageSha256: sha256.nullable(),
  completedAt: z.string().datetime(),
  providerOutputHosts: z.array(nonEmpty(253)).max(8),
  normalization: generated3dNormalizationReportSchema,
  artifacts: z
    .array(
      z.strictObject({
        role: z.enum(["primary", "thumbnail"]),
        fileName: nonEmpty(255),
        mimeType: nonEmpty(160),
        bytes: z.number().int().positive(),
        sha256,
      }),
    )
    .length(2),
});

/**
 * Promotion payload emitted when a generated 3D model graduates into the
 * project asset catalog. It encodes the stable filesystem paths and the
 * full receipt for audit.
 */
export const generated3dPromotionSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GENERATED_3D_CONTRACT),
  jobId: nonEmpty(240),
  modelPath: z.string().regex(/^\/generated-3d\/[a-f0-9]{64}\/model\.glb$/),
  thumbnailPath: z.string().regex(/^\/generated-3d\/[a-f0-9]{64}\/thumbnail\.(?:png|jpg|webp)$/),
  receipt: generated3dReceiptSchema,
});

/** Identifier of a supported 3D generation provider. */
export type Generated3DProviderId = z.infer<typeof generated3dProviderIdSchema>;
/** Generation mode: text-to-3d or image-to-3d. */
export type Generated3DMode = z.infer<typeof generated3dModeSchema>;
/** Target mesh topology for a generated model. */
export type Generated3DTopology = z.infer<typeof generated3dTopologySchema>;
/** Validated input for a 3D generation job run. */
export type Generated3DJobInput = z.infer<typeof generated3dJobInputSchema>;
/** Client-facing submit request for a 3D generation job. */
export type Generated3DSubmitRequest = z.infer<typeof generated3dSubmitRequestSchema>;
/** Advertised capability of a registered 3D generation provider. */
export type Generated3DProviderCapability = z.infer<typeof generated3dProviderCapabilitySchema>;
/** Post-import normalization report for a generated 3D model. */
export type Generated3DNormalizationReport = z.infer<typeof generated3dNormalizationReportSchema>;
/** Provider-agnostic receipt for a completed 3D generation job. */
export type Generated3DReceipt = z.infer<typeof generated3dReceiptSchema>;
/** Promotion payload linking a generated model into the asset catalog. */
export type Generated3DPromotion = z.infer<typeof generated3dPromotionSchema>;
