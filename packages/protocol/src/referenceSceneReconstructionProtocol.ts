import { z } from "zod";

/** Protocol version for the reference scene reconstruction format. */
export const DIRECTOR_REFERENCE_SCENE_PROTOCOL_VERSION = 1 as const;
/** Maximum number of objects in a reconstructed scene. */
export const DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS = 16;
/** Maximum number of lights in a reconstructed scene. */
export const DIRECTOR_REFERENCE_SCENE_MAX_LIGHTS = 4;
/** Maximum byte size of a reference image submitted for analysis. */
export const DIRECTOR_REFERENCE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Supported primitive geometry types for scene reconstruction. */
export const DIRECTOR_REFERENCE_SCENE_GEOMETRY_TYPES = [
  "box",
  "sphere",
  "cylinder",
  "torus",
  "cone",
  "pyramid",
] as const;

/** Supported light types for scene reconstruction. */
export const DIRECTOR_REFERENCE_SCENE_LIGHT_TYPES = [
  "ambient",
  "hemisphere",
  "directional",
  "point",
  "spot",
  "rect-area",
] as const;

const finite = z.number().finite();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const color = z.string().regex(/^#[0-9a-f]{6}$/i, "must be a six-digit hex color");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i, "must be a SHA-256 hex digest");
const base64 = z
  .string()
  .min(16)
  .max(7_100_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be canonical base64 without a data URL prefix");

const vec3 = (minimum: number, maximum: number) =>
  z.tuple([finite.min(minimum).max(maximum), finite.min(minimum).max(maximum), finite.min(minimum).max(maximum)]);

/** Computed image metrics used by the analysis pipeline to estimate scene properties. */
export const referenceImageMetricsSchema = z.strictObject({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  palette: z.array(color).min(1).max(8),
  meanLuminance: finite.min(0).max(1),
  edgeDensity: finite.min(0).max(1),
  foregroundCoverage: finite.min(0).max(1),
});

/** Source image payload for a reference scene analysis request. */
export const referenceSceneSourceImageRequestSchema = z.strictObject({
  fileName: boundedText(240),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  base64,
  sha256,
  metrics: referenceImageMetricsSchema,
});

/**
 * Client request to analyze a reference image and reconstruct a 3D scene.
 *
 * Specifies the analysis mode (auto, vision, or local), whether to append
 * or replace existing scene objects, and a cap on the number of objects.
 */
export const referenceSceneAnalysisRequestSchema = z.strictObject({
  version: z.literal(DIRECTOR_REFERENCE_SCENE_PROTOCOL_VERSION),
  projectRevision: boundedText(240),
  prompt: z.string().trim().max(2_000),
  applyMode: z.enum(["append", "replace"]),
  analysisMode: z.enum(["auto", "vision", "local"]),
  profileId: boundedText(160).nullable(),
  maxObjects: z.number().int().min(1).max(DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS),
  image: referenceSceneSourceImageRequestSchema,
});

/** PBR material parameters for a vision-detected object. */
export const referenceSceneVisionMaterialSchema = z.strictObject({
  baseColor: color,
  metalness: finite.min(0).max(1),
  roughness: finite.min(0).max(1),
  emissiveColor: color,
  emissiveIntensity: finite.min(0).max(20),
  opacity: finite.min(0.05).max(1),
});

/** A vision-detected object with geometry, transform, material, and confidence. */
export const referenceSceneVisionObjectSchema = z.strictObject({
  name: boundedText(120),
  geometryType: z.enum(DIRECTOR_REFERENCE_SCENE_GEOMETRY_TYPES),
  position: vec3(-100, 100),
  rotationDegrees: vec3(-360, 360),
  scale: vec3(0.05, 100),
  grounded: z.boolean(),
  material: referenceSceneVisionMaterialSchema,
  confidence: finite.min(0).max(1),
  rationale: boundedText(400),
});

/** A vision-detected light with type, position, target, and shadow settings. */
export const referenceSceneVisionLightSchema = z.strictObject({
  name: boundedText(120),
  type: z.enum(DIRECTOR_REFERENCE_SCENE_LIGHT_TYPES),
  color,
  intensity: finite.min(0).max(20),
  position: vec3(-100, 100),
  target: vec3(-100, 100),
  castShadow: z.boolean(),
  rationale: boundedText(400),
});

/** Strict provider output. IDs, provenance, and target revisions are server-owned. */
export const referenceSceneVisionOutputSchema = z.strictObject({
  summary: boundedText(1_000),
  confidence: finite.min(0).max(1),
  backgroundColor: color,
  objects: z.array(referenceSceneVisionObjectSchema).min(1).max(DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS),
  lights: z.array(referenceSceneVisionLightSchema).max(DIRECTOR_REFERENCE_SCENE_MAX_LIGHTS),
  warnings: z.array(boundedText(400)).max(12),
});

/** A planned object in the reconstruction plan, with stable id and placement mode. */
export const referenceScenePlanObjectSchema = z.strictObject({
  id: boundedText(200),
  enabled: z.boolean(),
  name: boundedText(120),
  geometryType: z.enum(DIRECTOR_REFERENCE_SCENE_GEOMETRY_TYPES),
  transform: z.strictObject({
    position: vec3(-100, 100),
    rotation: vec3(-Math.PI * 2, Math.PI * 2),
    scale: vec3(0.05, 100),
  }),
  placementMode: z.enum(["auto", "grounded", "floating"]),
  material: referenceSceneVisionMaterialSchema,
  confidence: finite.min(0).max(1),
  rationale: boundedText(400),
});

/** A planned light in the reconstruction plan, with stable id and enabled flag. */
export const referenceScenePlanLightSchema = z.strictObject({
  id: boundedText(200),
  enabled: z.boolean(),
  name: boundedText(120),
  type: z.enum(DIRECTOR_REFERENCE_SCENE_LIGHT_TYPES),
  color,
  intensity: finite.min(0).max(20),
  position: vec3(-100, 100),
  target: vec3(-100, 100),
  castShadow: z.boolean(),
  rationale: boundedText(400),
});

const referenceSceneUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

/**
 * The full reconstruction plan: source image, analysis results, background
 * color, objects, lights, and optional application metadata.
 */
export const referenceSceneReconstructionPlanSchema = z.strictObject({
  version: z.literal(DIRECTOR_REFERENCE_SCENE_PROTOCOL_VERSION),
  id: boundedText(200),
  status: z.enum(["draft", "applied"]),
  createdAt: z.string().datetime({ offset: true }),
  expectedProjectRevision: boundedText(240),
  prompt: z.string().trim().max(2_000),
  applyMode: z.enum(["append", "replace"]),
  source: z.strictObject({
    fileName: boundedText(240),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    sha256,
    metrics: referenceImageMetricsSchema,
  }),
  analysis: z.strictObject({
    status: z.enum(["ready", "degraded"]),
    mode: z.enum(["vision", "local"]),
    profileId: boundedText(160).nullable(),
    model: boundedText(320).nullable(),
    summary: boundedText(1_000),
    confidence: finite.min(0).max(1),
    warnings: z.array(boundedText(400)).max(16),
    usage: referenceSceneUsageSchema.nullable(),
  }),
  backgroundColor: color,
  objects: z.array(referenceScenePlanObjectSchema).min(1).max(DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS),
  lights: z.array(referenceScenePlanLightSchema).max(DIRECTOR_REFERENCE_SCENE_MAX_LIGHTS),
  application: z
    .strictObject({
      appliedAt: z.string().datetime({ offset: true }),
      sourceAssetId: boundedText(200),
      objectIds: z.array(boundedText(200)).max(DIRECTOR_REFERENCE_SCENE_MAX_OBJECTS),
      lightIds: z.array(boundedText(200)).max(DIRECTOR_REFERENCE_SCENE_MAX_LIGHTS),
    })
    .optional(),
});

/** Response wrapping the reconstruction plan returned from an analysis request. */
export const referenceSceneAnalysisResponseSchema = z.strictObject({
  plan: referenceSceneReconstructionPlanSchema,
});

/** Computed image metrics for scene analysis. */
export type ReferenceImageMetrics = z.infer<typeof referenceImageMetricsSchema>;
/** Client request to analyze a reference image. */
export type ReferenceSceneAnalysisRequest = z.infer<typeof referenceSceneAnalysisRequestSchema>;
/** Strict provider output from the vision pipeline. */
export type ReferenceSceneVisionOutput = z.infer<typeof referenceSceneVisionOutputSchema>;
/** A planned object in the reconstruction plan. */
export type ReferenceScenePlanObject = z.infer<typeof referenceScenePlanObjectSchema>;
/** A planned light in the reconstruction plan. */
export type ReferenceScenePlanLight = z.infer<typeof referenceScenePlanLightSchema>;
/** The full reconstruction plan with source, analysis, and scene elements. */
export type ReferenceSceneReconstructionPlan = z.infer<typeof referenceSceneReconstructionPlanSchema>;
