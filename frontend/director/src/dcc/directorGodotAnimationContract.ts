import { z } from "zod";

/**
 * Godot connector receipt vocabulary consumed by the editor. The full bake
 * sidecar contract (time-sampled canonical transforms the Gateway writes for
 * the headless Godot connector) lives in
 * `packages/dcc-protocol/src/directorGodotAnimationContract.ts`; the editor
 * only ever sees the read-back import receipt embedded in the engine report.
 */
const rationalRateStringSchema = z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/);

/** Structured warn-and-omit codes the Godot light importer stamps into receipts. */
export const directorGodotOmittedLightCodeSchema = z.enum([
  "light_rect_area_unsupported",
  "light_ambient_duplicate",
  "light_ambient_invisible",
  "light_type_unknown",
]);

/** One typed Godot light omission (agents read this instead of scraping warnings). */
export const directorGodotOmittedLightSchema = z.strictObject({
  directorId: z.string().trim().min(1).max(200),
  code: directorGodotOmittedLightCodeSchema,
  lightType: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(600),
});

/** A validated structured Godot omitted-light record. */
export type DirectorGodotOmittedLight = z.infer<typeof directorGodotOmittedLightSchema>;

/**
 * Structured warn-and-omit codes the Godot material path stamps into receipts.
 * `unsupported_channels` still applies the StandardMaterial3D override for the
 * channels Godot can carry; `no_mesh_target` and `custom_shader` are whole omits.
 */
export const directorGodotOmittedMaterialCodeSchema = z.enum([
  "unsupported_channels",
  "no_mesh_target",
  "custom_shader",
]);

/** One typed Godot material omission (agents read this instead of scraping warnings). */
export const directorGodotOmittedMaterialSchema = z.strictObject({
  directorId: z.string().trim().min(1).max(200),
  code: directorGodotOmittedMaterialCodeSchema,
  reason: z.string().trim().min(1).max(600),
});

/** A validated structured Godot omitted-material record. */
export type DirectorGodotOmittedMaterial = z.infer<typeof directorGodotOmittedMaterialSchema>;

/**
 * The Godot import receipt the connector embeds in its engine report. All
 * values are read back from the saved scene and authored animation resources,
 * so the receipt proves what was built, not what was requested.
 */
export const directorGodotImportReceiptSchema = z
  .strictObject({
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
    /**
     * Typed omit records for Agent/UI honesty. Optional for older connectors that
     * only stamped free-text warnings; when present, length must match
     * `omittedLightCount`.
     */
    omittedLights: z.array(directorGodotOmittedLightSchema).max(1_024).optional(),
    /** Director PBR materials applied to imported payload meshes. */
    appliedMaterialCount: z.number().int().nonnegative().max(100_000),
    /**
     * Material warn-and-omit count (unsupported channels, no mesh target, custom
     * ShaderMaterial). Always present on connector ≥0.3.1; older receipts omit
     * the field and Agents fall back to free-text warnings.
     */
    omittedMaterialCount: z.number().int().nonnegative().max(100_000).optional(),
    /**
     * Typed material omit records. Optional for older connectors; when present,
     * length must equal omittedMaterialCount.
     */
    omittedMaterials: z.array(directorGodotOmittedMaterialSchema).max(1_024).optional(),
    /** Payload textures externalized to hashed `res://director/textures/` resources. */
    externalizedTextureCount: z.number().int().nonnegative().max(100_000),
  })
  .superRefine((receipt, context) => {
    if (receipt.omittedLights !== undefined && receipt.omittedLights.length !== receipt.omittedLightCount) {
      context.addIssue({
        code: "custom",
        path: ["omittedLights"],
        message: "omittedLights length must equal omittedLightCount",
      });
    }
    if (receipt.omittedMaterials !== undefined) {
      if (receipt.omittedMaterialCount === undefined) {
        context.addIssue({
          code: "custom",
          path: ["omittedMaterialCount"],
          message: "omittedMaterialCount is required when omittedMaterials is present",
        });
      } else if (receipt.omittedMaterials.length !== receipt.omittedMaterialCount) {
        context.addIssue({
          code: "custom",
          path: ["omittedMaterials"],
          message: "omittedMaterials length must equal omittedMaterialCount",
        });
      }
    }
  });

/** A validated Godot import receipt embedded in the engine report. */
export type DirectorGodotImportReceipt = z.infer<typeof directorGodotImportReceiptSchema>;
