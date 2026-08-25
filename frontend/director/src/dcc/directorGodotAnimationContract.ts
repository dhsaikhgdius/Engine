import { z } from "zod";

/**
 * Godot connector receipt vocabulary consumed by the editor. The full bake
 * sidecar contract (time-sampled canonical transforms the Gateway writes for
 * the headless Godot connector) lives in
 * `packages/dcc-protocol/src/directorGodotAnimationContract.ts`; the editor
 * only ever sees the read-back import receipt embedded in the engine report.
 */
const rationalRateStringSchema = z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/);

/**
 * The Godot import receipt the connector embeds in its engine report. All
 * values are read back from the saved scene and authored animation resources,
 * so the receipt proves what was built, not what was requested.
 */
export const directorGodotImportReceiptSchema = z.strictObject({
  /** `res://` path of the AnimationPlayer's owning scene, when animation was keyed. */
  animationPlayerPath: z.string().trim().min(1).max(1_024).nullable(),
  /** Name of the AnimationLibrary that holds the Director timeline animation. */
  animationLibrary: z.string().trim().max(120).nullable(),
  /** Rational display rate applied when converting frames to seconds, e.g. `24000/1001`. */
  displayRate: rationalRateStringSchema.nullable(),
  /** Total animation keys written across all tracks. */
  bakedKeyCount: z.number().int().nonnegative().max(100_000_000),
  /** Number of transform (position/rotation/scale) track triples keyed on director_id nodes. */
  transformTrackCount: z.number().int().nonnegative().max(100_000),
  /** Number of camera fov property tracks keyed. */
  fovTrackCount: z.number().int().nonnegative().max(100_000),
  /** Discrete `Camera3D.current` camera-cut value tracks keyed from storyboard shots. */
  shotCutTrackCount: z.number().int().nonnegative().max(100_000),
  /** Storyboard shots that produced a camera-cut key (unmappable shots warn-and-omit). */
  mappedShotCount: z.number().int().nonnegative().max(100_000),
  /** glTF payload animations preserved from GLB assets (AnimationPlayer count). */
  payloadAnimationPlayerCount: z.number().int().nonnegative().max(100_000),
  /** Skinned payloads whose Skeleton3D was found, tagged, and left in bind pose. */
  importedSkeletonCount: z.number().int().nonnegative().max(100_000),
  /** Lights imported as OmniLight3D/SpotLight3D/DirectionalLight3D nodes. */
  importedLightCount: z.number().int().nonnegative().max(100_000),
  /** Whether an ambient/hemisphere light was baked into a WorldEnvironment ambient term. */
  worldEnvironmentAmbient: z.boolean(),
  /** Lights omitted with a structured warn-and-omit code (rect-area, duplicate ambient, …). */
  omittedLightCount: z.number().int().nonnegative().max(100_000),
  /** Director PBR materials applied to imported payload meshes. */
  appliedMaterialCount: z.number().int().nonnegative().max(100_000),
  /** Payload textures externalized to hashed `res://director/textures/` resources. */
  externalizedTextureCount: z.number().int().nonnegative().max(100_000),
});

/** A validated Godot import receipt embedded in the engine report. */
export type DirectorGodotImportReceipt = z.infer<typeof directorGodotImportReceiptSchema>;
