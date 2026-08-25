import { z } from "zod";
import {
  createDefaultDirectorProduction,
  getDirectorProductionIssues,
  reconcileDirectorProduction,
} from "./directorProduction";
import { DIRECTOR_CAMERA_OPTICS_LIMITS } from "./cameraGeometry";
import {
  CHARACTER_BODY_TYPES,
  CHARACTER_RIG_TYPES,
  CHARACTER_SOURCES,
  DIRECTOR_ANIMATION_INTERPOLATIONS,
  DIRECTOR_ASSET_KINDS,
  DIRECTOR_ASSET_SOURCES,
  DIRECTOR_ASSET_SOURCE_TYPES,
  DIRECTOR_CAMERA_HANDHELD_SHAKES,
  DIRECTOR_CAMERA_SENSOR_FORMATS,
  DIRECTOR_CAMERA_TARGET_MODES,
  DIRECTOR_CHARACTER_MOTION_LOOPS,
  DIRECTOR_CHARACTER_ROOT_MOTION_MODES,
  DIRECTOR_LIGHT_TYPES,
  DIRECTOR_MATERIAL_SIDES,
  DIRECTOR_MATERIAL_TEXTURE_SLOTS,
  DIRECTOR_OBJECT_KINDS,
  DIRECTOR_PLACEMENT_MODES,
  DIRECTOR_REFERENCE_KIND_IDS,
  DIRECTOR_STORYBOARD_MOVEMENT_IDS,
  DIRECTOR_STORYBOARD_SHOT_SIZE_IDS,
  DIRECTOR_TRAJECTORY_MOTIONS,
  DIRECTOR_TRAJECTORY_PRESET_IDS,
  DIRECTOR_TRAJECTORY_SOURCES,
  GEOMETRY_PRIMITIVE_TYPES,
  PANORAMA_PROJECTION_MODES,
} from "./directorProject";
import { POSE_PRESET_IDS } from "./poseSchema";
import { strictMode } from "@director/protocol/strict-variant";
import { directorCameraAspectRatioSchema } from "@director/protocol/camera";
import { referenceSceneReconstructionPlanSchema } from "@director/protocol/reference-scene";
import { directorProceduralRecipeSchema } from "@director/protocol/procedural";
import { DIRECTOR_GENERATED_3D_CONTRACT, generated3dProviderIdSchema } from "@director/protocol/generated-3d";
import { comfyGenerationParametersSchema } from "@director/protocol/comfy-generation";
import { directorWorldSchema } from "@director/protocol/world-systems";
import { directorVehicleProfileSchema } from "@director/protocol/vehicle";

export const directorFiniteNumberSchema = z.number().finite();
export const directorVec3Schema = z.tuple([
  directorFiniteNumberSchema,
  directorFiniteNumberSchema,
  directorFiniteNumberSchema,
]);

const finiteNumber = directorFiniteNumberSchema;
const vec3Schema = directorVec3Schema;
export const directorAssetKindSchema = z.enum(DIRECTOR_ASSET_KINDS);
export const directorAssetSourceTypeSchema = z.enum(DIRECTOR_ASSET_SOURCE_TYPES);
export const directorObjectKindSchema = z.enum(DIRECTOR_OBJECT_KINDS);
export const directorAnimationEntityTypeSchema = z.enum(["object", "camera"]);

export function directorCameraOpticsValueSchema(key: keyof typeof DIRECTOR_CAMERA_OPTICS_LIMITS) {
  const limits = DIRECTOR_CAMERA_OPTICS_LIMITS[key];
  return finiteNumber.min(limits.min).max(limits.max);
}

export const directorTransformSchema = z.strictObject({
  position: vec3Schema,
  rotation: vec3Schema,
  scale: vec3Schema,
});

const directorNativeEngineSchema = z.literal("blender");

export const directorNativeObjectSourceSchema = z.strictObject({
  engine: directorNativeEngineSchema,
  objectId: z.string().trim().min(1).max(200),
  provisioned: z.boolean().optional(),
});

/** Measured object-space bounds in metres, before the instance transform. */
export const directorLocalBoundsSchema = z
  .strictObject({
    min: vec3Schema,
    max: vec3Schema,
  })
  .refine(
    (bounds) =>
      bounds.max.every((value, axis) => value >= bounds.min[axis]) &&
      bounds.max.some((value, axis) => value > bounds.min[axis]),
    {
      message: "local bounds max must not precede min and at least one axis must have extent",
      path: ["max"],
    },
  );

export const directorPbrTextureBindingsSchema = z.strictObject(
  Object.fromEntries(DIRECTOR_MATERIAL_TEXTURE_SLOTS.map((slot) => [slot, z.string().trim().min(1).optional()])) as {
    [Slot in (typeof DIRECTOR_MATERIAL_TEXTURE_SLOTS)[number]]: z.ZodOptional<z.ZodString>;
  },
);

export const directorPbrMaterialSchema = z.strictObject({
  baseColor: z.string().trim().min(1).max(80).optional(),
  metalness: finiteNumber.min(0).max(1).optional(),
  roughness: finiteNumber.min(0).max(1).optional(),
  opacity: finiteNumber.min(0).max(1).optional(),
  emissiveColor: z.string().trim().min(1).max(80).optional(),
  emissiveIntensity: finiteNumber.min(0).max(100).optional(),
  transmission: finiteNumber.min(0).max(1).optional(),
  ior: finiteNumber.min(1).max(2.5).optional(),
  clearcoat: finiteNumber.min(0).max(1).optional(),
  clearcoatRoughness: finiteNumber.min(0).max(1).optional(),
  side: z.enum(DIRECTOR_MATERIAL_SIDES).optional(),
  wireframe: z.boolean().optional(),
  flatShading: z.boolean().optional(),
  textures: directorPbrTextureBindingsSchema.optional(),
});

export const directorLightSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(240),
  type: z.enum(DIRECTOR_LIGHT_TYPES),
  visible: z.boolean(),
  locked: z.boolean(),
  color: z.string().trim().min(1).max(80),
  intensity: finiteNumber.min(0).max(100),
  position: vec3Schema.optional(),
  target: vec3Schema.optional(),
  groundColor: z.string().trim().min(1).max(80).optional(),
  distance: finiteNumber.min(0).max(1_000_000).optional(),
  decay: finiteNumber.min(0).max(10).optional(),
  angle: finiteNumber
    .min(0.001)
    .max(Math.PI / 2)
    .optional(),
  penumbra: finiteNumber.min(0).max(1).optional(),
  width: finiteNumber.positive().max(1_000_000).optional(),
  height: finiteNumber.positive().max(1_000_000).optional(),
  castShadow: z.boolean().optional(),
  nativeSource: directorNativeObjectSourceSchema.optional(),
});

/**
 * Authoring input for `add_light`. Stored lights still require `visible`/`locked`;
 * defaults live only on create so `update_light` patches do not rewrite them.
 */
export const directorLightCreateSchema = directorLightSchema.omit({ nativeSource: true }).extend({
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
});

export const directorClippingPlaneSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(160),
    enabled: z.boolean(),
    normal: vec3Schema,
    constant: finiteNumber.min(-1_000_000).max(1_000_000),
  })
  .refine((plane) => Math.hypot(...plane.normal) > 1e-6, {
    message: "clipping plane normal cannot be zero",
    path: ["normal"],
  });

export const directorObjectLayerSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  visible: z.boolean(),
  locked: z.boolean(),
});

export const directorSceneAnchorSchema = z.strictObject({
  objectId: z.string().trim().min(1).max(200).nullable().optional(),
  /** World position when unbound; object-local offset when objectId is present. */
  position: vec3Schema,
});

export const directorSceneAnnotationSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(10_000),
  anchor: directorSceneAnchorSchema,
  color: z.string().trim().min(1).max(80),
  visible: z.boolean(),
  createdAt: z.string().datetime(),
});

export const directorSceneMeasurementSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().max(500).optional(),
  start: directorSceneAnchorSchema,
  end: directorSceneAnchorSchema,
  color: z.string().trim().min(1).max(80),
  visible: z.boolean(),
  createdAt: z.string().datetime(),
});

function uniqueSceneEntries<T extends { id: string }>(schema: z.ZodType<T>, maximum: number, label: string) {
  return z
    .array(schema)
    .max(maximum)
    .refine((values) => new Set(values.map((value) => value.id)).size === values.length, {
      message: `${label} ids must be unique`,
    });
}

export const directorFogSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    mode: z.enum(["linear", "exponential"]),
    color: z.string().trim().min(1).max(80),
    near: finiteNumber.min(0),
    far: finiteNumber.positive(),
    density: finiteNumber.min(0).max(10),
  })
  .refine((fog) => fog.mode !== "linear" || fog.far > fog.near, {
    message: "linear fog far must be greater than near",
    path: ["far"],
  });

export const directorEnvironmentSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  usePanorama: z.boolean(),
  intensity: finiteNumber.min(0).max(20),
  rotation: vec3Schema,
});

export const directorTimelineAudioClipSchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(240),
  /** Durable creative media id (for example creative-media:audio:<hash>). */
  mediaId: z.string().trim().min(1).max(512),
  /** Direct source fallback for clips whose media id cannot be resolved locally. */
  sourceUrl: z.string().trim().min(1).max(8_192).optional(),
  /** Placement is frame-based to match the rest of the stage timeline. */
  startFrame: finiteNumber.int().min(0).max(1_000_000),
  durationFrames: finiteNumber.int().min(1).max(1_000_000),
  /** Source-side trim offset in seconds; media time is fps-independent. */
  inSec: finiteNumber.min(0).max(86_400),
  /** Cached source duration so an offline media library still bounds trims. */
  sourceDurationSec: finiteNumber.positive().max(86_400).optional(),
  volume: finiteNumber.min(0).max(1),
  fadeInSec: finiteNumber.min(0).max(60),
  fadeOutSec: finiteNumber.min(0).max(60),
  muted: z.boolean(),
});

export const directorTimelineAudioTrackSchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(240),
  muted: z.boolean(),
  clips: uniqueSceneEntries(directorTimelineAudioClipSchema, 128, "audio clip"),
});

export const directorTimelineSchema = z.strictObject({
  version: z.literal(1),
  fps: finiteNumber,
  timebase: z
    .strictObject({
      rate: z.strictObject({
        numerator: z.number().int().positive().max(1_000_000),
        denominator: z.number().int().positive().max(1_000_000),
      }),
      dropFrame: z.boolean(),
      startTimecode: z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/),
    })
    .optional(),
  frameStart: finiteNumber,
  frameEnd: finiteNumber,
  currentFrame: finiteNumber,
  loop: z.boolean(),
  trackKeys: z.array(z.string()).optional(),
  /** Optional so documents saved before stage audio existed keep parsing. */
  audioTracks: uniqueSceneEntries(directorTimelineAudioTrackSchema, 8, "audio track").optional(),
});

export const directorAnimationKeyframeSchema = z.strictObject({
  frame: finiteNumber,
  interpolation: z.enum(DIRECTOR_ANIMATION_INTERPOLATIONS).optional(),
  timingCurve: z
    .strictObject({
      x1: z.number().finite().min(0).max(1),
      y1: z.number().finite().min(-4).max(4),
      x2: z.number().finite().min(0).max(1),
      y2: z.number().finite().min(-4).max(4),
    })
    .optional(),
  transform: directorTransformSchema.optional(),
  curve: z
    .strictObject({
      in: vec3Schema.optional(),
      out: vec3Schema.optional(),
    })
    .optional(),
  poseValues: z.record(z.string(), finiteNumber).optional(),
  lookTarget: vec3Schema.optional(),
  lookTargetObjectId: z.string().nullable().optional(),
  fov: finiteNumber.optional(),
});

export const directorAnimationRecipeMetadataSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("orbit"),
    axis: z.enum(["x", "y", "z"]),
    center: vec3Schema,
    radius: finiteNumber.positive().max(1_000_000),
    cycles: finiteNumber.int().positive().max(64),
    clockwise: z.boolean(),
    faceCenter: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("wave"),
    axis: z.enum(["x", "y", "z"]),
    amplitude: finiteNumber.positive().max(1_000_000),
    cycles: finiteNumber.int().positive().max(64),
    phaseDegrees: finiteNumber,
  }),
  z.strictObject({
    type: z.literal("bounce"),
    height: finiteNumber.positive().max(1_000_000),
    bounces: finiteNumber.int().positive().max(32),
    squash: z.boolean(),
  }),
]);

const directorCharacterMotionPlaybackFields = {
  clipId: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  loop: z.enum(DIRECTOR_CHARACTER_MOTION_LOOPS),
  speed: finiteNumber.min(0.1).max(4),
  weight: finiteNumber.min(0).max(1),
  blendInS: finiteNumber.min(0).max(10),
  blendOutS: finiteNumber.min(0).max(10),
  rootMotion: z.enum(DIRECTOR_CHARACTER_ROOT_MOTION_MODES),
};

export const directorCharacterMotionStateSchema = z.strictObject({
  ...directorCharacterMotionPlaybackFields,
  startFrame: finiteNumber.int().min(-1_000_000).max(1_000_000),
});

export const directorCharacterMotionBlockSchema = z
  .strictObject({
    ...directorCharacterMotionPlaybackFields,
    id: z.string().trim().min(1).max(120),
    frameStart: finiteNumber.int().min(-1_000_000).max(1_000_000),
    frameEnd: finiteNumber.int().min(-1_000_000).max(1_000_000),
    rootMotion: z.literal("in-place"),
  })
  .superRefine((block, context) => {
    if (block.frameEnd < block.frameStart) {
      context.addIssue({ code: "custom", path: ["frameEnd"], message: "frameEnd must be at or after frameStart" });
    }
  });

export const directorEntityAnimationSchema = z
  .strictObject({
    version: z.literal(1),
    keyframes: z.array(directorAnimationKeyframeSchema),
    enabled: z.boolean().optional(),
    preset: z.enum(DIRECTOR_TRAJECTORY_PRESET_IDS).optional(),
    circle: z
      .strictObject({
        center: vec3Schema,
        radius: finiteNumber,
        startAngle: finiteNumber,
        clockwise: z.boolean(),
      })
      .optional(),
    orientToPath: z.boolean().optional(),
    motion: z.enum(DIRECTOR_TRAJECTORY_MOTIONS).optional(),
    motionBlocks: z.array(directorCharacterMotionBlockSchema).max(128).optional(),
    speed: finiteNumber.optional(),
    actionPresetId: z.enum(POSE_PRESET_IDS).optional(),
    source: z.enum(DIRECTOR_TRAJECTORY_SOURCES).optional(),
    color: z.string().optional(),
    recipe: directorAnimationRecipeMetadataSchema.optional(),
  })
  .superRefine((animation, context) => {
    const seenIds = new Set<string>();
    const sortedBlocks = (animation.motionBlocks ?? [])
      .map((block, index) => ({ block, index }))
      .sort(
        (left, right) => left.block.frameStart - right.block.frameStart || left.block.frameEnd - right.block.frameEnd,
      );

    sortedBlocks.forEach(({ block, index }, sortedIndex) => {
      if (seenIds.has(block.id)) {
        context.addIssue({
          code: "custom",
          path: ["motionBlocks", index, "id"],
          message: `duplicate motion block ${block.id}`,
        });
      }
      seenIds.add(block.id);
      const previous = sortedBlocks[sortedIndex - 1]?.block;
      if (previous && block.frameStart <= previous.frameEnd) {
        context.addIssue({
          code: "custom",
          path: ["motionBlocks", index, "frameStart"],
          message: `motion block overlaps ${previous.id}`,
        });
      }
    });
  });

export const mixamoCharacterMetadataSchema = z.strictObject({
  heightM: finiteNumber.positive(),
  groundOffsetY: finiteNumber,
  visualCenter: vec3Schema,
  labelAnchorY: finiteNumber,
  rig: z.strictObject({
    type: z.literal("mixamo"),
    bonePrefix: z.string().optional(),
    boneCount: finiteNumber.int().positive(),
    boneNames: z.array(z.string().min(1)).max(512).optional(),
  }),
});

export const directorGeneratedAssetProvenanceSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GENERATED_3D_CONTRACT),
  jobId: z.string().trim().min(1).max(240),
  providerId: generated3dProviderIdSchema,
  externalId: z.string().trim().min(1).max(500),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  thumbnailSha256: z.string().regex(/^[a-f0-9]{64}$/),
  receiptArtifactId: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(600),
  createdAt: z.string().datetime(),
});

export const directorAssetRefSchema = z
  .strictObject({
    id: z.string(),
    kind: directorAssetKindSchema,
    sourceType: directorAssetSourceTypeSchema,
    fileName: z.string(),
    name: z.string().optional(),
    url: z.string(),
    assetSource: z.enum(DIRECTOR_ASSET_SOURCES).optional(),
    /** Keep authored scene bundles at their exact metric scale and origin. */
    modelNormalization: z.enum(["auto", "preserve"]).optional(),
    /** Measured normalized model bounds, shared by viewport and spatial tools. */
    localBoundsM: directorLocalBoundsSchema.optional(),
    /**
     * Real-world target size in meters (largest bounding-box dimension).
     * When present, generic model assets are normalized to this metric size so
     * the whole stage shares one consistent scale with characters and worlds.
     * Absent on legacy assets, which keep the historic display normalization.
     */
    realWorldSizeM: finiteNumber.min(0.001).max(10_000).optional(),
    /** Where realWorldSizeM came from, for auditing and UI affordances. */
    sizeSource: z.enum(["catalog", "user", "estimated"]).optional(),
    thumbnailUrl: z.string().trim().min(1).max(8_192).optional(),
    generation: directorGeneratedAssetProvenanceSchema.optional(),
    projectionMode: z.enum(PANORAMA_PROJECTION_MODES).optional(),
    characterMetadata: mixamoCharacterMetadataSchema.optional(),
    /**
     * 4D gaussian splatting sequence metadata. The asset URL points at the
     * gateway-generated frame manifest and playback flips one splat frame at a
     * time against the Director timeline clock.
     */
    splatSequence: z
      .strictObject({
        frameCount: z.number().int().min(1).max(100_000),
        fps: finiteNumber.min(1).max(240),
      })
      .optional(),
  })
  .superRefine((asset, context) => {
    if (asset.characterMetadata && (asset.kind !== "character" || asset.sourceType !== "model")) {
      context.addIssue({
        code: "custom",
        message: "characterMetadata 只能用于 character model 资产",
        path: ["characterMetadata"],
      });
    }
    if (asset.splatSequence && asset.sourceType !== "model") {
      context.addIssue({
        code: "custom",
        message: "splatSequence 只能用于 model 资产",
        path: ["splatSequence"],
      });
    }
    if (asset.sizeSource && asset.realWorldSizeM === undefined) {
      context.addIssue({
        code: "custom",
        message: "sizeSource 必须与 realWorldSizeM 一起出现",
        path: ["sizeSource"],
      });
    }
    if (asset.generation && asset.assetSource !== "generated") {
      context.addIssue({
        code: "custom",
        message: "generation provenance 只能用于 generated 资产",
        path: ["generation"],
      });
    }
    if (asset.assetSource === "generated") {
      if (!asset.generation) {
        context.addIssue({ code: "custom", message: "generated 资产必须保留生成回执", path: ["generation"] });
      }
      if (asset.sourceType !== "model") {
        context.addIssue({ code: "custom", message: "generated 资产必须是模型", path: ["sourceType"] });
      }
      if (asset.modelNormalization !== "preserve") {
        context.addIssue({
          code: "custom",
          message: "generated 资产必须保留服务端规范化后的米制尺度",
          path: ["modelNormalization"],
        });
      }
    }
  });

export const directorCharacterIkTargetSchema = z.strictObject({
  target: vec3Schema,
  pole: vec3Schema,
  weight: finiteNumber.min(0).max(1),
  reachClamp: finiteNumber.min(0.05).max(1),
});

export const directorCharacterIkStateSchema = z.strictObject({
  leftHand: directorCharacterIkTargetSchema.optional(),
  rightHand: directorCharacterIkTargetSchema.optional(),
  leftFoot: directorCharacterIkTargetSchema.optional(),
  rightFoot: directorCharacterIkTargetSchema.optional(),
});

export const directorReferenceBindingSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(DIRECTOR_REFERENCE_KIND_IDS),
  label: z.string(),
  ref: z.string(),
  showInViewport: z.boolean().optional(),
  promptVisual: z
    .strictObject({
      fontColor: z.string().optional(),
      fontSize: finiteNumber.optional(),
      width: finiteNumber.optional(),
      height: finiteNumber.optional(),
      backgroundColor: z.string().optional(),
      borderColor: z.string().optional(),
    })
    .optional(),
});

export const directorNativeSceneSchema = z.strictObject({
  engine: directorNativeEngineSchema,
  projectId: z.string().trim().min(1).max(200),
  sceneEpoch: z.string().trim().min(1).max(200).optional(),
  revision: z.number().int().nonnegative().optional(),
  contentRevision: z.number().int().nonnegative().optional(),
});

export const directorToggleTransformInteractionSchema = z.strictObject({
  kind: z.literal("toggle-transform"),
  prompt: z.string().trim().min(1).max(120),
  radiusM: finiteNumber.min(0.25).max(20),
  closedTransform: directorTransformSchema,
  openTransform: directorTransformSchema,
});

export const directorObjectSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(DIRECTOR_OBJECT_KINDS),
  visible: z.boolean(),
  locked: z.boolean(),
  layer: z.string().trim().min(1).max(80).optional(),
  /** Local gizmo pivot. Viewport rotation/scale preserves this point in world space. */
  pivot: vec3Schema.optional(),
  /** Blender-measured object-space bounds override reusable asset bounds. */
  localBoundsM: directorLocalBoundsSchema.optional(),
  transform: directorTransformSchema,
  bodyType: z.enum(CHARACTER_BODY_TYPES).optional(),
  characterSource: z.enum(CHARACTER_SOURCES).optional(),
  color: z.string().optional(),
  material: directorPbrMaterialSchema.optional(),
  assetRefId: z.string().optional(),
  geometryType: z.enum(GEOMETRY_PRIMITIVE_TYPES).optional(),
  placementMode: z.enum(DIRECTOR_PLACEMENT_MODES).optional(),
  crowdId: z.string().optional(),
  crowdLabel: z.string().optional(),
  objectListId: z.string().optional(),
  objectListLabel: z.string().optional(),
  objectListDetached: z.boolean().optional(),
  isCompositeParent: z.boolean().optional(),
  parentObjectId: z.string().optional(),
  lookTargetObjectId: z.string().nullable().optional(),
  linkedCameraId: z.string().nullable().optional(),
  characterRig: z
    .strictObject({
      rigType: z.enum(CHARACTER_RIG_TYPES),
      posePresetId: z.string().nullable(),
      controls: z.record(z.string(), finiteNumber),
      ik: directorCharacterIkStateSchema.optional(),
      motion: directorCharacterMotionStateSchema.optional(),
    })
    .optional(),
  animation: directorEntityAnimationSchema.optional(),
  referenceBindings: z.array(directorReferenceBindingSchema).optional(),
  nativeSource: directorNativeObjectSourceSchema.optional(),
  /** Optional drivable-vehicle capability consumed by the live player session. */
  vehicle: directorVehicleProfileSchema.optional(),
  /** Optional proximity interaction consumed by the live player session. */
  interaction: directorToggleTransformInteractionSchema.optional(),
});

export const directorCameraActionSchema = z.discriminatedUnion("mode", [
  strictMode("still", {}),
  strictMode("path", {
    path: z.strictObject({
      speed: finiteNumber,
      lockTarget: z.boolean(),
      targetObjectId: z.string().nullable().optional(),
    }),
  }),
  strictMode("follow", {
    follow: z.strictObject({
      targetObjectId: z.string().nullable(),
      positionOffset: vec3Schema,
      targetOffset: vec3Schema,
    }),
  }),
  strictMode("transform", {}),
]);

export const directorCameraShotSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    fov: finiteNumber,
    focalLengthMm: finiteNumber.optional(),
    sensorFormat: z.enum(DIRECTOR_CAMERA_SENSOR_FORMATS).optional(),
    apertureFStop: directorCameraOpticsValueSchema("apertureFStop").optional(),
    focusDistanceM: directorCameraOpticsValueSchema("focusDistanceM").optional(),
    shutterAngle: directorCameraOpticsValueSchema("shutterAngle").optional(),
    iso: directorCameraOpticsValueSchema("iso").optional(),
    nearClipM: directorCameraOpticsValueSchema("nearClipM").optional(),
    farClipM: directorCameraOpticsValueSchema("farClipM").optional(),
    anamorphicSqueeze: directorCameraOpticsValueSchema("anamorphicSqueeze").optional(),
    aspectRatio: directorCameraAspectRatioSchema.optional(),
    handheldShake: z.enum(DIRECTOR_CAMERA_HANDHELD_SHAKES).optional(),
    action: directorCameraActionSchema.optional(),
    transform: directorTransformSchema,
    targetMode: z.enum(DIRECTOR_CAMERA_TARGET_MODES),
    targetObjectId: z.string().nullable().optional(),
    target: vec3Schema,
    lastCaptureUrl: z.string().nullable().optional(),
    captures: z
      .array(
        z.strictObject({
          id: z.string(),
          index: finiteNumber,
          name: z.string(),
          dataUrl: z.string(),
        }),
      )
      .optional(),
    animation: directorEntityAnimationSchema.optional(),
    referenceBindings: z.array(directorReferenceBindingSchema).optional(),
    nativeSource: directorNativeObjectSourceSchema.optional(),
    projectionType: z.enum(["perspective", "orthographic"]).optional(),
    orthographicScaleM: finiteNumber.positive().optional(),
    sensorFit: z.enum(["auto", "horizontal", "vertical"]).optional(),
    sensorWidthMm: finiteNumber.positive().optional(),
    sensorHeightMm: finiteNumber.positive().optional(),
    lensShiftX: finiteNumber.optional(),
    lensShiftY: finiteNumber.optional(),
  })
  .refine(
    (camera) => camera.nearClipM === undefined || camera.farClipM === undefined || camera.farClipM > camera.nearClipM,
    { message: "farClipM must be greater than nearClipM", path: ["farClipM"] },
  );

export const directorStoryboardGenerationOutputSchema = z.strictObject({
  jobId: z.string().trim().min(1).max(240),
  kind: z.enum(["image.generate", "video.generate", "audio.generate"]),
  workflowId: z.string().trim().min(1).max(160),
  mediaIds: z
    .array(z.string().trim().min(1).max(240))
    .min(1)
    .max(64)
    .refine((values) => new Set(values).size === values.length, { message: "mediaIds must be unique" }),
  artifactIds: z
    .array(z.string().trim().min(1).max(240))
    .max(64)
    .refine((values) => new Set(values).size === values.length, { message: "artifactIds must be unique" }),
  prompt: z.string().max(12_000),
  negativePrompt: z.string().max(12_000),
  seed: z.number().int().min(0).max(2_147_483_647),
  promotedAt: z.string().datetime(),
});

export const directorStoryboardGenerationSchema = z.strictObject({
  workflowId: z.string().trim().min(1).max(160),
  nodeIds: z
    .array(z.string().trim().min(1).max(80))
    .max(32)
    .refine((values) => new Set(values).size === values.length, { message: "nodeIds must be unique" }),
  parameters: comfyGenerationParametersSchema,
  referenceImages: z
    .array(
      z.strictObject({
        parameterId: z.string().trim().min(1).max(240),
        mediaId: z.string().trim().min(1).max(512),
      }),
    )
    .max(64)
    .refine((values) => new Set(values.map((value) => value.parameterId)).size === values.length, {
      message: "referenceImages parameter IDs must be unique",
    })
    .optional(),
  outputs: z.array(directorStoryboardGenerationOutputSchema).max(128),
});

export const directorStoryboardSchema = z.strictObject({
  version: z.literal(1),
  title: z.string(),
  logline: z.string(),
  shots: z.array(
    z.strictObject({
      id: z.string(),
      scriptBeatId: z.string().optional(),
      title: z.string(),
      cameraId: z.string().nullable(),
      frameStart: finiteNumber,
      frameEnd: finiteNumber,
      shotSize: z.enum(DIRECTOR_STORYBOARD_SHOT_SIZE_IDS),
      movement: z.enum(DIRECTOR_STORYBOARD_MOVEMENT_IDS),
      action: z.string(),
      notes: z.string().max(20_000).optional(),
      rating: z.number().int().min(0).max(5).optional(),
      generation: directorStoryboardGenerationSchema.optional(),
      thumbnail: z
        .strictObject({
          mediaId: z.string().trim().min(1).max(240),
          cameraId: z.string().trim().min(1).max(200),
          frame: finiteNumber.int().nonnegative(),
          width: finiteNumber.int().positive().max(4096),
          height: finiteNumber.int().positive().max(4096),
          capturedAt: z.string().datetime(),
        })
        .optional(),
    }),
  ),
});

export const directorPerformanceEntityTrackSchema = z.strictObject({
  id: z.string(),
  objectId: z.string(),
  animation: directorEntityAnimationSchema,
});

export const directorPerformanceTakeSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  frameStart: finiteNumber,
  frameEnd: finiteNumber,
  objectIds: z.array(z.string()),
  entityTracks: z.array(directorPerformanceEntityTrackSchema),
});

export const directorCoverageShotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  takeId: z.string(),
  cameraId: z.string(),
  frameStart: finiteNumber,
  frameEnd: finiteNumber,
  storyboardShotId: z.string().optional(),
});

export const directorCoverageSequenceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  shots: z.array(directorCoverageShotSchema),
});

export const directorProductionSchema = z.strictObject({
  version: z.literal(1),
  takes: z.array(directorPerformanceTakeSchema),
  sequences: z.array(directorCoverageSequenceSchema),
  activeTakeId: z.string().nullable(),
  activeSequenceId: z.string().nullable(),
});

const directorProjectBaseSchema = z.strictObject({
  version: z.literal(1),
  nativeScene: directorNativeSceneSchema.optional(),
  scene: z.strictObject({
    scale: finiteNumber,
    position: vec3Schema,
    rotation: vec3Schema,
    backgroundColor: z.string(),
    panoramaYaw: finiteNumber,
    panoramaRadius: finiteNumber,
    showLabels: z.boolean(),
    snapToGrid: z.boolean(),
    showGround: z.boolean(),
    groundOpacity: finiteNumber,
    groundHeight: finiteNumber,
    fog: directorFogSettingsSchema.optional(),
    environment: directorEnvironmentSettingsSchema.optional(),
    clippingPlanes: z.array(directorClippingPlaneSchema).max(6).optional(),
    objectLayers: uniqueSceneEntries(directorObjectLayerSchema, 64, "object layer").optional(),
    annotations: uniqueSceneEntries(directorSceneAnnotationSchema, 512, "annotation").optional(),
    measurements: uniqueSceneEntries(directorSceneMeasurementSchema, 512, "measurement").optional(),
    timeline: directorTimelineSchema.optional(),
  }),
  assets: z.array(directorAssetRefSchema),
  objects: z.array(directorObjectSchema),
  lights: z.array(directorLightSchema).optional(),
  cameras: z.array(directorCameraShotSchema),
  storyboard: directorStoryboardSchema.optional(),
  production: directorProductionSchema.optional(),
  referenceReconstructions: z.array(referenceSceneReconstructionPlanSchema).max(64).optional(),
  proceduralRecipes: z.array(directorProceduralRecipeSchema).max(128).optional(),
  world: directorWorldSchema.optional(),
  activeCameraId: z.string().nullable(),
  panoramaAssetId: z.string().nullable(),
});

type DirectorProjectShape = z.infer<typeof directorProjectBaseSchema>;

function addDirectorProjectStructuralIssues(project: DirectorProjectShape, context: z.RefinementCtx) {
  const lightIds = new Set<string>();
  project.lights?.forEach((light, index) => {
    if (lightIds.has(light.id)) {
      context.addIssue({ code: "custom", path: ["lights", index, "id"], message: `duplicate light id ${light.id}` });
    }
    lightIds.add(light.id);
  });

  const reconstructionIds = new Set<string>();
  project.referenceReconstructions?.forEach((plan, planIndex) => {
    if (reconstructionIds.has(plan.id)) {
      context.addIssue({
        code: "custom",
        path: ["referenceReconstructions", planIndex, "id"],
        message: `duplicate reference reconstruction id ${plan.id}`,
      });
    }
    reconstructionIds.add(plan.id);
  });

  const proceduralRecipeIds = new Set<string>();
  project.proceduralRecipes?.forEach((recipe, recipeIndex) => {
    if (proceduralRecipeIds.has(recipe.id)) {
      context.addIssue({
        code: "custom",
        path: ["proceduralRecipes", recipeIndex, "id"],
        message: `duplicate procedural recipe id ${recipe.id}`,
      });
    }
    proceduralRecipeIds.add(recipe.id);
  });

  const storyboardGenerationJobIds = new Set<string>();
  project.storyboard?.shots.forEach((shot, shotIndex) => {
    shot.generation?.outputs.forEach((output, outputIndex) => {
      if (storyboardGenerationJobIds.has(output.jobId)) {
        context.addIssue({
          code: "custom",
          path: ["storyboard", "shots", shotIndex, "generation", "outputs", outputIndex, "jobId"],
          message: `duplicate storyboard generation job id ${output.jobId}`,
        });
      }
      storyboardGenerationJobIds.add(output.jobId);
    });
  });
}

function addDirectorProjectReferenceIssues(project: DirectorProjectShape, context: z.RefinementCtx) {
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const objectIds = new Set(project.objects.map((object) => object.id));
  project.scene.annotations?.forEach((annotation, annotationIndex) => {
    if (annotation.anchor.objectId && !objectIds.has(annotation.anchor.objectId)) {
      context.addIssue({
        code: "custom",
        path: ["scene", "annotations", annotationIndex, "anchor", "objectId"],
        message: `annotation object ${annotation.anchor.objectId} does not exist`,
      });
    }
  });
  project.scene.measurements?.forEach((measurement, measurementIndex) => {
    (["start", "end"] as const).forEach((endpoint) => {
      const objectId = measurement[endpoint].objectId;
      if (objectId && !objectIds.has(objectId)) {
        context.addIssue({
          code: "custom",
          path: ["scene", "measurements", measurementIndex, endpoint, "objectId"],
          message: `measurement object ${objectId} does not exist`,
        });
      }
    });
  });
  project.world?.effects.forEach((effect, effectIndex) => {
    if (effect.anchor.objectId && !objectIds.has(effect.anchor.objectId)) {
      context.addIssue({
        code: "custom",
        path: ["world", "effects", effectIndex, "anchor", "objectId"],
        message: `world effect object ${effect.anchor.objectId} does not exist`,
      });
    }
  });
  project.world?.wildlife.forEach((group, groupIndex) => {
    if (group.assetId && !assetsById.has(group.assetId)) {
      context.addIssue({
        code: "custom",
        path: ["world", "wildlife", groupIndex, "assetId"],
        message: `wildlife asset ${group.assetId} does not exist`,
      });
    }
  });
  project.objects.forEach((object, objectIndex) => {
    Object.entries(object.material?.textures ?? {}).forEach(([slot, assetId]) => {
      if (!assetId) return;
      const asset = assetsById.get(assetId);
      if (!asset) {
        context.addIssue({
          code: "custom",
          path: ["objects", objectIndex, "material", "textures", slot],
          message: `material texture asset ${assetId} does not exist`,
        });
      } else if (asset.sourceType !== "image") {
        context.addIssue({
          code: "custom",
          path: ["objects", objectIndex, "material", "textures", slot],
          message: `material texture asset ${assetId} must be an image`,
        });
      }
    });
  });

  getDirectorProductionIssues(project).forEach((issue) => {
    context.addIssue({
      code: "custom",
      path: issue.path.split(".").map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment)),
      message: issue.message,
      params: { production_issue_code: issue.code },
    });
  });
}

/**
 * Structure-only boundary for the load/import paths: field shapes and
 * duplicate-id corruption still reject the document, while dangling references
 * are left for repairDirectorProjectReferences to fix instead of blocking open.
 */
export const directorProjectStructuralSchema = directorProjectBaseSchema.superRefine((project, context) => {
  addDirectorProjectStructuralIssues(project, context);
});

/**
 * The trust boundary for persisted, imported, and host-supplied Director JSON.
 * Optional fields deliberately cover documents saved before camera actions,
 * timeline track keys, and the storyboard were introduced; migration happens
 * only after this structural validation succeeds.
 */
export const directorProjectSchema = directorProjectBaseSchema.superRefine((project, context) => {
  addDirectorProjectStructuralIssues(project, context);
  addDirectorProjectReferenceIssues(project, context);
});

export type DirectorTransform = z.infer<typeof directorTransformSchema>;
export type DirectorTimeline = z.infer<typeof directorTimelineSchema>;
export type DirectorTimelineAudioClip = z.infer<typeof directorTimelineAudioClipSchema>;
export type DirectorTimelineAudioTrack = z.infer<typeof directorTimelineAudioTrackSchema>;
export type DirectorAnimationKeyframe = z.infer<typeof directorAnimationKeyframeSchema>;
export type DirectorAnimationTimingCurve = NonNullable<DirectorAnimationKeyframe["timingCurve"]>;
export type DirectorAnimationRecipeMetadata = z.infer<typeof directorAnimationRecipeMetadataSchema>;
export type DirectorTrajectoryCircleGeometry = NonNullable<z.infer<typeof directorEntityAnimationSchema>["circle"]>;
export type DirectorEntityAnimation = z.infer<typeof directorEntityAnimationSchema>;
export type DirectorCharacterMotionBlock = z.infer<typeof directorCharacterMotionBlockSchema>;
export type MixamoCharacterMetadata = z.infer<typeof mixamoCharacterMetadataSchema>;
export type DirectorAssetRef = z.infer<typeof directorAssetRefSchema>;
export type DirectorSplatSequenceMetadata = NonNullable<DirectorAssetRef["splatSequence"]>;
export type DirectorPbrTextureBindings = z.infer<typeof directorPbrTextureBindingsSchema>;
export type DirectorPbrMaterial = z.infer<typeof directorPbrMaterialSchema>;
export type DirectorMaterialTextureSlot = (typeof DIRECTOR_MATERIAL_TEXTURE_SLOTS)[number];
export type DirectorMaterialSide = (typeof DIRECTOR_MATERIAL_SIDES)[number];
export type DirectorLight = z.infer<typeof directorLightSchema>;
export type DirectorLightType = DirectorLight["type"];
export type DirectorFogSettings = z.infer<typeof directorFogSettingsSchema>;
export type DirectorCharacterIkTarget = z.infer<typeof directorCharacterIkTargetSchema>;
export type DirectorCharacterIkState = z.infer<typeof directorCharacterIkStateSchema>;
export type DirectorCharacterMotionState = z.infer<typeof directorCharacterMotionStateSchema>;
export type DirectorClippingPlane = z.infer<typeof directorClippingPlaneSchema>;
export type DirectorObjectLayer = z.infer<typeof directorObjectLayerSchema>;
export type DirectorSceneAnchor = z.infer<typeof directorSceneAnchorSchema>;
export type DirectorSceneAnnotation = z.infer<typeof directorSceneAnnotationSchema>;
export type DirectorSceneMeasurement = z.infer<typeof directorSceneMeasurementSchema>;
export type DirectorReferenceBinding = NonNullable<z.infer<typeof directorObjectSchema>["referenceBindings"]>[number];
export type DirectorNativeScene = z.infer<typeof directorNativeSceneSchema>;
export type DirectorNativeObjectSource = z.infer<typeof directorNativeObjectSourceSchema>;
export type CharacterRigState = NonNullable<z.infer<typeof directorObjectSchema>["characterRig"]>;
export type DirectorToggleTransformInteraction = z.infer<typeof directorToggleTransformInteractionSchema>;
export type DirectorObject = z.infer<typeof directorObjectSchema>;
type ParsedDirectorCameraAction = z.infer<typeof directorCameraActionSchema>;
export type DirectorCameraPathAction = Extract<ParsedDirectorCameraAction, { mode: "path" }>["path"];
export type DirectorCameraFollowAction = Extract<ParsedDirectorCameraAction, { mode: "follow" }>["follow"];
/** Kept permissive for consumers that prepare path/follow data before switching modes. */
export interface DirectorCameraAction {
  mode: ParsedDirectorCameraAction["mode"];
  path?: DirectorCameraPathAction;
  follow?: DirectorCameraFollowAction;
}
export type DirectorCameraShot = Omit<z.infer<typeof directorCameraShotSchema>, "action"> & {
  action?: DirectorCameraAction;
};
export type DirectorCameraCapture = NonNullable<DirectorCameraShot["captures"]>[number];
export type DirectorStoryboard = z.infer<typeof directorStoryboardSchema>;
export type DirectorStoryboardShot = DirectorStoryboard["shots"][number];
export type DirectorStoryboardGeneration = z.infer<typeof directorStoryboardGenerationSchema>;
export type DirectorStoryboardGenerationOutput = z.infer<typeof directorStoryboardGenerationOutputSchema>;
export type DirectorPerformanceEntityTrack = z.infer<typeof directorPerformanceEntityTrackSchema>;
export type DirectorPerformanceTake = z.infer<typeof directorPerformanceTakeSchema>;
export type DirectorCoverageShot = z.infer<typeof directorCoverageShotSchema>;
export type DirectorCoverageSequence = z.infer<typeof directorCoverageSequenceSchema>;
export type DirectorProduction = z.infer<typeof directorProductionSchema>;
export type DirectorProceduralRecipe = z.infer<typeof directorProceduralRecipeSchema>;
export type {
  DirectorWorld,
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldSettings,
  DirectorWorldWaterBody,
  DirectorWorldWildlifeGroup,
  DirectorWorldWind,
  DirectorWorldTimeOfDay,
  DirectorWorldWeather,
  WorldEffectKind,
  WorldWildlifeSpecies,
} from "@director/protocol/world-systems";
export type { DirectorVehicleProfile, DirectorVehicleKind } from "@director/protocol/vehicle";
export type DirectorProject = Omit<z.infer<typeof directorProjectSchema>, "cameras"> & {
  cameras: DirectorCameraShot[];
};
export type SceneSettings = DirectorProject["scene"];

export function parseDirectorProject(value: unknown): DirectorProject {
  return directorProjectSchema.parse(value);
}

export function safeParseDirectorProject(
  value: unknown,
): { success: true; project: DirectorProject } | { success: false; error: string } {
  const result = directorProjectSchema.safeParse(value);
  if (result.success) return { success: true, project: result.data };

  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "project";
  return { success: false, error: `项目数据无效：${path} ${issue?.message ?? "格式错误"}` };
}

export function safeParseDirectorProjectStructural(
  value: unknown,
): { success: true; project: DirectorProject } | { success: false; error: string } {
  const result = directorProjectStructuralSchema.safeParse(value);
  if (result.success) return { success: true, project: result.data };

  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "project";
  return { success: false, error: `项目数据无效：${path} ${issue?.message ?? "格式错误"}` };
}

export interface DirectorProjectRepairResult {
  project: DirectorProject;
  repairs: string[];
}

/** Fixes dangling references in a structurally valid project so it satisfies the strict schema. */
export function repairDirectorProjectReferences(project: DirectorProject): DirectorProjectRepairResult {
  const repairs: string[] = [];
  let next = project;

  const objectIds = new Set(next.objects.map((object) => object.id));
  const assetsById = new Map(next.assets.map((asset) => [asset.id, asset]));

  const annotations = next.scene.annotations;
  if (annotations?.some((annotation) => annotation.anchor.objectId && !objectIds.has(annotation.anchor.objectId))) {
    const repaired = annotations.map((annotation) => {
      if (!annotation.anchor.objectId || objectIds.has(annotation.anchor.objectId)) return annotation;
      repairs.push(`标注 ${annotation.id} 引用的对象 ${annotation.anchor.objectId} 不存在，已改为世界坐标锚点`);
      return { ...annotation, anchor: { ...annotation.anchor, objectId: null } };
    });
    next = { ...next, scene: { ...next.scene, annotations: repaired } };
  }

  const measurements = next.scene.measurements;
  if (
    measurements?.some((measurement) =>
      (["start", "end"] as const).some(
        (endpoint) => measurement[endpoint].objectId && !objectIds.has(measurement[endpoint].objectId!),
      ),
    )
  ) {
    const repaired = measurements.map((measurement) => {
      let updated = measurement;
      (["start", "end"] as const).forEach((endpoint) => {
        const objectId = updated[endpoint].objectId;
        if (!objectId || objectIds.has(objectId)) return;
        repairs.push(`测量 ${measurement.id} 引用的对象 ${objectId} 不存在，已改为世界坐标锚点`);
        updated = { ...updated, [endpoint]: { ...updated[endpoint], objectId: null } };
      });
      return updated;
    });
    next = { ...next, scene: { ...next.scene, measurements: repaired } };
  }

  const world = next.world;
  if (world) {
    let repairedWorld = world;
    if (world.effects.some((effect) => effect.anchor.objectId && !objectIds.has(effect.anchor.objectId))) {
      const repairedEffects = world.effects.map((effect) => {
        if (!effect.anchor.objectId || objectIds.has(effect.anchor.objectId)) return effect;
        repairs.push(`效果 ${effect.id} 引用的对象 ${effect.anchor.objectId} 不存在，已改为世界坐标锚点`);
        return { ...effect, anchor: { ...effect.anchor, objectId: null } };
      });
      repairedWorld = { ...repairedWorld, effects: repairedEffects };
    }
    if (world.wildlife.some((group) => group.assetId && !assetsById.has(group.assetId))) {
      const repairedWildlife = world.wildlife.map((group) => {
        if (!group.assetId || assetsById.has(group.assetId)) return group;
        repairs.push(`野生动物群 ${group.id} 引用的资产 ${group.assetId} 不存在，已改用占位模型`);
        const { assetId: _assetId, ...rest } = group;
        return rest;
      });
      repairedWorld = { ...repairedWorld, wildlife: repairedWildlife };
    }
    if (repairedWorld !== world) next = { ...next, world: repairedWorld };
  }

  const hasBrokenTexture = (object: DirectorObject) =>
    Object.values(object.material?.textures ?? {}).some((assetId) => {
      if (!assetId) return false;
      const asset = assetsById.get(assetId);
      return !asset || asset.sourceType !== "image";
    });
  if (next.objects.some(hasBrokenTexture)) {
    const repairedObjects = next.objects.map((object) => {
      if (!hasBrokenTexture(object)) return object;
      const textures = { ...(object.material?.textures ?? {}) };
      Object.entries(textures).forEach(([slot, assetId]) => {
        if (!assetId) return;
        const asset = assetsById.get(assetId);
        if (asset && asset.sourceType === "image") return;
        repairs.push(
          asset
            ? `对象 ${object.id} 的材质贴图 ${slot} 引用的资产 ${assetId} 不是图片，已解除绑定`
            : `对象 ${object.id} 的材质贴图 ${slot} 引用的资产 ${assetId} 不存在，已解除绑定`,
        );
        delete textures[slot as keyof typeof textures];
      });
      return { ...object, material: { ...object.material, textures } };
    });
    next = { ...next, objects: repairedObjects };
  }

  const productionIssues = next.production ? getDirectorProductionIssues(next) : [];
  if (productionIssues.length > 0) {
    productionIssues.forEach((issue) => {
      repairs.push(`拍摄数据 ${issue.path}：${issue.message}，已自动修复`);
    });
    const reconciled = { ...next, production: reconcileDirectorProduction(next) };
    if (getDirectorProductionIssues(reconciled).length === 0) {
      next = reconciled;
    } else {
      const rebuilt = { ...next, production: createDefaultDirectorProduction(next) };
      next = getDirectorProductionIssues(rebuilt).length === 0 ? rebuilt : { ...next, production: undefined };
      repairs.push("拍摄数据无法就地修复，已重建默认拍摄结构");
    }
  }

  return { project: next, repairs };
}
