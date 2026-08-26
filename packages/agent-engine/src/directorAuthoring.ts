import { z } from "zod";
import type {
  DirectorAssetRef,
  DirectorCameraAction,
  DirectorCameraShot,
  DirectorCoverageSequence,
  DirectorCoverageShot,
  DirectorEntityAnimation,
  DirectorLight,
  DirectorObject,
  DirectorObjectLayer,
  DirectorPerformanceTake,
  DirectorProject,
  DirectorSceneAnnotation,
  DirectorSceneMeasurement,
  DirectorStoryboard,
  DirectorTimelineAudioClip,
  DirectorTimelineAudioTrack,
  DirectorTransform,
  DirectorVehicleProfile,
  DirectorWorld,
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldWaterBody,
  DirectorWorldWildlifeGroup,
  WorldEffectKind,
  WorldWildlifeSpecies,
} from "@director/project-schema";
import {
  CHARACTER_BODY_TYPES,
  createDefaultDirectorFrameTimeline,
  DIRECTOR_ASSET_KINDS,
  DIRECTOR_CAMERA_HANDHELD_SHAKES,
  DIRECTOR_CAMERA_SENSOR_FORMATS,
  DIRECTOR_CHARACTER_IK_EFFECTORS,
  DIRECTOR_CHARACTER_MOTION_LOOPS,
  DIRECTOR_PLACEMENT_MODES,
  DIRECTOR_TRAJECTORY_MOTIONS,
  GEOMETRY_PRIMITIVE_TYPES,
  formatSceneItemName,
  getNextSequentialId,
} from "@director/project-schema";
import {
  directorAssetRefSchema,
  directorAnimationEntityTypeSchema,
  directorCameraActionSchema,
  directorCharacterIkTargetSchema,
  directorClippingPlaneSchema,
  directorCoverageSequenceSchema,
  directorCoverageShotSchema,
  directorCameraOpticsValueSchema,
  directorEntityAnimationSchema,
  directorEnvironmentSettingsSchema,
  directorFogSettingsSchema,
  directorLightCreateSchema,
  directorLightSchema,
  directorObjectLayerSchema,
  directorPbrMaterialSchema,
  directorPerformanceTakeSchema,
  directorReferenceBindingSchema,
  directorSceneAnnotationSchema,
  directorSceneMeasurementSchema,
  directorStoryboardSchema,
  directorTimelineAudioClipSchema,
  directorTimelineSchema,
  directorTransformSchema,
  directorVec3Schema,
} from "@director/project-schema";
import {
  DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
  DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
  DEFAULT_DIRECTOR_CAMERA_ACTION,
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
  DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  DEFAULT_DIRECTOR_CAMERA_ISO,
  DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
  getCameraRigPositionFromViewSnapshot,
  getCameraViewSnapshotFromShot,
  getVerticalFovFromFocalLength,
  normalizeDirectorCameraOptics,
} from "@director/project-schema";
import {
  CHARACTER_POSE_CONTROL_KEYS,
  getCharacterPoseControlValueLimits,
  POSE_PRESET_IDS,
} from "@director/project-schema";
import { getMannequinPosePreset, resolveCharacterPoseControls } from "@director/project-schema";
import { getDirectorCharacterMotion, isDirectorCharacterMotionId } from "./characterMotionCatalog";
import {
  createDefaultDirectorProduction,
  getDirectorProductionIssues,
  reconcileDirectorProduction,
} from "@director/project-schema";
import { findDirectorAgentCatalogAssetsByClaim, getDirectorAgentCatalogAsset } from "./directorAgentAssetCatalog";
import { DEFAULT_MIXAMO_CHARACTER_ASSET_ID } from "@director/dcc-interchange";
import { strictAction } from "@director/protocol/strictProtocolVariant";
import { directorCameraAspectRatioSchema as cameraAspect } from "@director/protocol/directorCameraProtocol";
import {
  createDefaultDirectorWorld,
  DIRECTOR_WORLD_MAX_EFFECTS,
  DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
  DIRECTOR_WORLD_MAX_ROADS,
  DIRECTOR_WORLD_MAX_WATER_BODIES,
  DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS,
  directorWorldEffectSchema,
  directorWorldFirePropagationSchema,
  directorWorldRiverSchema,
  directorWorldRoadSchema,
  directorWorldSettingsSchema,
  directorWorldTimeOfDaySchema,
  directorWorldWaterBodySchema,
  directorWorldWeatherEvolutionSchema,
  directorWorldWeatherSchema,
  directorWorldWildlifeGroupSchema,
  directorWorldWindSchema,
  WORLD_EFFECT_KINDS,
  WORLD_WILDLIFE_SPECIES,
  worldAnchorSchema,
  worldEmitterShapeSchema,
} from "@director/protocol/worldSystemsProtocol";
import {
  createDefaultDirectorCarProfile,
  DIRECTOR_VEHICLE_KINDS,
  directorVehicleProfileSchema,
} from "@director/protocol/vehicleProtocol";
import { buildDirectorBlockingActions, directorComposeBlockingActionSchema } from "./directorBlocking";
import {
  buildDirectorFrameShotActions,
  buildDirectorMarkCameraMoveActions,
  directorFrameShotActionSchema,
  directorMarkCameraMoveActionSchema,
} from "./directorFraming";
import {
  buildDirectorSpatialAuthoringActions,
  directorArrangeFacingPairActionSchema,
  directorArrangeGroupActionSchema,
  directorOrientTowardActionSchema,
  directorPlaceRelativeActionSchema,
  isDirectorSpatialAuthoringAction,
} from "./directorSpatialAuthoring";
import {
  directorApplyProceduralActionSchema,
  isDirectorProceduralAuthoringAction,
  previewDirectorProceduralRecipe,
} from "./directorProceduralAuthoring";
import { compileDirectorAnimationRecipe, directorAnimationRecipeInputSchema } from "@director/project-schema";
import { DIRECTOR_NATIVE_STAGE_PATCH_FIELDS } from "./directorKernelOwnership";

const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(240);
const color = z.string().trim().min(1).max(80);
const objectKind = z.enum(DIRECTOR_ASSET_KINDS);
const bodyType = z.enum(CHARACTER_BODY_TYPES);
const geometryType = z.enum(GEOMETRY_PRIMITIVE_TYPES);
const placementMode = z.enum(DIRECTOR_PLACEMENT_MODES);
const objectIds = z
  .array(id)
  .min(1)
  .max(256)
  .refine((values) => new Set(values).size === values.length, { message: "object_ids must be unique" });
const posePresetId = z.enum(POSE_PRESET_IDS);
const cameraSensorFormat = z.enum(DIRECTOR_CAMERA_SENSOR_FORMATS);
const handheldShake = z.enum(DIRECTOR_CAMERA_HANDHELD_SHAKES);
const cameraActionInputSchema = z.union([directorCameraActionSchema, z.enum(["still", "transform"])]);
const apertureFStop = directorCameraOpticsValueSchema("apertureFStop");
const focusDistanceM = directorCameraOpticsValueSchema("focusDistanceM");
const shutterAngle = directorCameraOpticsValueSchema("shutterAngle");
const cameraIso = directorCameraOpticsValueSchema("iso");
const nearClipM = directorCameraOpticsValueSchema("nearClipM");
const farClipM = directorCameraOpticsValueSchema("farClipM");
const anamorphicSqueeze = directorCameraOpticsValueSchema("anamorphicSqueeze");
const characterIkEffector = z.enum(DIRECTOR_CHARACTER_IK_EFFECTORS);
const characterPoseControlKey = z.enum(CHARACTER_POSE_CONTROL_KEYS);
const characterPoseControlInputSchema = z
  .strictObject({
    control: characterPoseControlKey,
    value: z.number().finite(),
  })
  .superRefine((entry, context) => {
    const limits = getCharacterPoseControlValueLimits(entry.control);
    if (entry.value < limits.min || entry.value > limits.max) {
      context.addIssue({
        code: "custom",
        message: `${entry.control} must be between ${limits.min} and ${limits.max}`,
        path: ["value"],
      });
    }
  });
const characterPoseControlsInputSchema = z
  .array(characterPoseControlInputSchema)
  .min(1)
  .max(CHARACTER_POSE_CONTROL_KEYS.length)
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.control)) {
        context.addIssue({
          code: "custom",
          message: `duplicate character control ${entry.control}`,
          path: [index, "control"],
        });
      }
      seen.add(entry.control);
    });
  });
const characterIkTargetInputSchema = z.strictObject({
  target: directorCharacterIkTargetSchema.shape.target,
  pole: directorCharacterIkTargetSchema.shape.pole,
  weight: directorCharacterIkTargetSchema.shape.weight.optional(),
  reach_clamp: directorCharacterIkTargetSchema.shape.reachClamp.optional(),
});
const characterMotionId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(isDirectorCharacterMotionId, { message: "unknown packaged character motion" });

const partialTransformSchema = z
  .strictObject({
    position: directorVec3Schema.optional(),
    rotation: directorVec3Schema.optional(),
    scale: directorVec3Schema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "transform patch cannot be empty" });

const toggleTransformInteractionInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(120).optional(),
  radius_m: z.number().finite().min(0.25).max(20).default(3),
  closed_transform: directorTransformSchema.optional(),
  open_transform: directorTransformSchema,
});

const scenePatchSchema = z
  .strictObject({
    scale: z.number().finite().positive().optional(),
    position: directorVec3Schema.optional(),
    rotation: directorVec3Schema.optional(),
    backgroundColor: color.optional(),
    panoramaYaw: z.number().finite().optional(),
    panoramaRadius: z.number().finite().positive().optional(),
    showLabels: z.boolean().optional(),
    snapToGrid: z.boolean().optional(),
    showGround: z.boolean().optional(),
    groundOpacity: z.number().finite().min(0).max(1).optional(),
    groundHeight: z.number().finite().optional(),
    fog: directorFogSettingsSchema.optional(),
    environment: directorEnvironmentSettingsSchema.optional(),
    clippingPlanes: z.array(directorClippingPlaneSchema).max(6).nullable().optional(),
    objectLayers: z.array(directorObjectLayerSchema).max(64).nullable().optional(),
    annotations: z.array(directorSceneAnnotationSchema).max(512).nullable().optional(),
    measurements: z.array(directorSceneMeasurementSchema).max(512).nullable().optional(),
    timeline: directorTimelineSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "scene patch cannot be empty" });

const objectUpdateSchema = z
  .strictObject({
    name: name.optional(),
    /** Display label shared by every member of the target's crowd; only valid on crowd characters. */
    crowd_label: z.string().trim().min(1).max(240).nullable().optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    layer: z.string().trim().min(1).max(80).nullable().optional(),
    pivot: directorVec3Schema.nullable().optional(),
    transform: partialTransformSchema.optional(),
    body_type: bodyType.nullable().optional(),
    character_source: z.literal("asset").optional(),
    color: color.nullable().optional(),
    material: directorPbrMaterialSchema.nullable().optional(),
    pose_preset_id: posePresetId.nullable().optional(),
    asset_id: id.nullable().optional(),
    geometry_type: geometryType.nullable().optional(),
    placement_mode: placementMode.nullable().optional(),
    parent_id: id.nullable().optional(),
    look_target_object_id: id.nullable().optional(),
    reference_bindings: z.array(directorReferenceBindingSchema).max(32).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "object patch cannot be empty" });

const cameraUpdateSchema = z
  .strictObject({
    name: name.optional(),
    position: directorVec3Schema.optional(),
    target: directorVec3Schema.optional(),
    target_object_id: id.nullable().optional(),
    focal_length_mm: z.number().finite().min(12).max(200).optional(),
    sensor_format: cameraSensorFormat.optional(),
    aperture_f_stop: apertureFStop.optional(),
    focus_distance_m: focusDistanceM.optional(),
    shutter_angle: shutterAngle.optional(),
    iso: cameraIso.optional(),
    near_clip_m: nearClipM.optional(),
    far_clip_m: farClipM.optional(),
    anamorphic_squeeze: anamorphicSqueeze.optional(),
    aspect_ratio: cameraAspect.optional(),
    handheld_shake: handheldShake.optional(),
    action: cameraActionInputSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "camera patch cannot be empty" });

const lightUpdateSchema = directorLightSchema
  .omit({ id: true, nativeSource: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "light patch cannot be empty" });

const performanceTakeUpdateSchema = directorPerformanceTakeSchema
  .omit({ id: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "performance take patch cannot be empty" });

const coverageSequenceUpdateSchema = directorCoverageSequenceSchema
  .omit({ id: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "coverage sequence patch cannot be empty" });

const coverageShotUpdateSchema = directorCoverageShotSchema
  .omit({ id: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "coverage shot patch cannot be empty" });

const annotationUpdateSchema = directorSceneAnnotationSchema
  .omit({ id: true, createdAt: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "annotation patch cannot be empty" });

const measurementUpdateSchema = directorSceneMeasurementSchema
  .omit({ id: true, createdAt: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "measurement patch cannot be empty" });

const worldEffectKind = z.enum(WORLD_EFFECT_KINDS);
const worldWildlifeSpecies = z.enum(WORLD_WILDLIFE_SPECIES);
const worldColorTint = directorWorldEffectSchema.shape.colorTint.unwrap();
const worldSurfaceShape = directorWorldWaterBodySchema.shape.surface.shape;
const worldAreaShape = directorWorldWildlifeGroupSchema.shape.area.shape;

const worldWindPatchSchema = z
  .strictObject({
    direction_degrees: directorWorldWindSchema.shape.directionDegrees.optional(),
    speed_mps: directorWorldWindSchema.shape.speedMps.optional(),
    gustiness: directorWorldWindSchema.shape.gustiness.optional(),
    turbulence: directorWorldWindSchema.shape.turbulence.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "wind patch cannot be empty" });

const worldTimeOfDayPatchSchema = z
  .strictObject({
    mode: directorWorldTimeOfDaySchema.shape.mode.optional(),
    hours: directorWorldTimeOfDaySchema.shape.hours.optional(),
    cycle_minutes: directorWorldTimeOfDaySchema.shape.cycleMinutes.optional(),
    drives_sky: directorWorldTimeOfDaySchema.shape.drivesSky.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "time_of_day patch cannot be empty" });

/** Absent period_seconds preserves the existing period (or the protocol default). */
const worldWeatherEvolutionInputSchema = z.strictObject({
  mode: directorWorldWeatherEvolutionSchema.shape.mode,
  period_seconds: directorWorldWeatherEvolutionSchema.shape.periodSeconds.unwrap().optional(),
});

const worldWeatherPatchSchema = z
  .strictObject({
    preset: directorWorldWeatherSchema.shape.preset.optional(),
    intensity: directorWorldWeatherSchema.shape.intensity.optional(),
    wetness: directorWorldWeatherSchema.shape.wetness.optional(),
    cloud_cover: directorWorldWeatherSchema.shape.cloudCover.optional(),
    /** null removes the block (static weather); an object replaces/merges it. */
    evolution: worldWeatherEvolutionInputSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "weather patch cannot be empty" });

const worldSettingsPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    seed: directorWorldSettingsSchema.shape.seed.optional(),
    wind: worldWindPatchSchema.optional(),
    time_of_day: worldTimeOfDayPatchSchema.optional(),
    weather: worldWeatherPatchSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "world settings patch cannot be empty" });

/** Object-bound world anchor; object_id null (or absent) means an unbound world-space anchor. */
const worldAnchorInputSchema = z.strictObject({
  object_id: id.nullable().optional(),
  position: worldAnchorSchema.shape.position.optional(),
});

/** Deterministic fire spread; only valid on kind "fire" with an unbound anchor. */
const worldFirePropagationInputSchema = z.strictObject({
  enabled: directorWorldFirePropagationSchema.shape.enabled,
  radius_m: directorWorldFirePropagationSchema.shape.radiusM.unwrap().optional(),
  spread_rate: directorWorldFirePropagationSchema.shape.spreadRate.unwrap().optional(),
});

const worldFirePropagationDefaults = directorWorldFirePropagationSchema.parse({ enabled: false });

const worldEffectFieldSchemas = {
  name: directorWorldEffectSchema.shape.name,
  anchor: worldAnchorInputSchema,
  shape: worldEmitterShapeSchema,
  intensity: directorWorldEffectSchema.shape.intensity,
  size_scale: directorWorldEffectSchema.shape.sizeScale,
  speed_scale: directorWorldEffectSchema.shape.speedScale,
  wind_influence: directorWorldEffectSchema.shape.windInfluence,
  seed_offset: directorWorldEffectSchema.shape.seedOffset,
} as const;

const worldEffectUpdateSchema = z
  .strictObject({
    name: worldEffectFieldSchemas.name.optional(),
    kind: worldEffectKind.optional(),
    anchor: worldAnchorInputSchema.optional(),
    shape: worldEffectFieldSchemas.shape.optional(),
    intensity: worldEffectFieldSchemas.intensity.optional(),
    size_scale: worldEffectFieldSchemas.size_scale.optional(),
    speed_scale: worldEffectFieldSchemas.speed_scale.optional(),
    color_tint: worldColorTint.nullable().optional(),
    wind_influence: worldEffectFieldSchemas.wind_influence.optional(),
    /** null removes fire propagation; an object replaces/merges it. */
    propagation: worldFirePropagationInputSchema.nullable().optional(),
    seed_offset: worldEffectFieldSchemas.seed_offset.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "world effect patch cannot be empty" });

const worldWaterSurfaceInputSchema = z.strictObject({
  center: worldSurfaceShape.center.optional(),
  size_x: worldSurfaceShape.sizeX.optional(),
  size_z: worldSurfaceShape.sizeZ.optional(),
  rotation_degrees: worldSurfaceShape.rotationDegrees.optional(),
});

const worldRiverInputSchema = z.strictObject({
  points: directorWorldRiverSchema.shape.points,
  width_m: directorWorldRiverSchema.shape.widthM,
  width_profile: directorWorldRiverSchema.shape.widthProfile.optional(),
});

const worldWaterBodyFieldSchemas = {
  name: directorWorldWaterBodySchema.shape.name,
  surface: worldWaterSurfaceInputSchema,
  river: worldRiverInputSchema,
  wave_amplitude: directorWorldWaterBodySchema.shape.waveAmplitude,
  wave_length_m: directorWorldWaterBodySchema.shape.waveLengthM,
  flow_direction_degrees: directorWorldWaterBodySchema.shape.flowDirectionDegrees,
  flow_speed_mps: directorWorldWaterBodySchema.shape.flowSpeedMps,
  color_shallow: directorWorldWaterBodySchema.shape.colorShallow,
  color_deep: directorWorldWaterBodySchema.shape.colorDeep,
  opacity: directorWorldWaterBodySchema.shape.opacity,
  foam_intensity: directorWorldWaterBodySchema.shape.foamIntensity,
} as const;

const worldWaterBodyUpdateSchema = z
  .strictObject({
    name: worldWaterBodyFieldSchemas.name.optional(),
    surface: worldWaterBodyFieldSchemas.surface.optional(),
    river: worldWaterBodyFieldSchemas.river.nullable().optional(),
    wave_amplitude: worldWaterBodyFieldSchemas.wave_amplitude.optional(),
    wave_length_m: worldWaterBodyFieldSchemas.wave_length_m.optional(),
    flow_direction_degrees: worldWaterBodyFieldSchemas.flow_direction_degrees.optional(),
    flow_speed_mps: worldWaterBodyFieldSchemas.flow_speed_mps.optional(),
    color_shallow: worldWaterBodyFieldSchemas.color_shallow.optional(),
    color_deep: worldWaterBodyFieldSchemas.color_deep.optional(),
    opacity: worldWaterBodyFieldSchemas.opacity.optional(),
    foam_intensity: worldWaterBodyFieldSchemas.foam_intensity.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "world water body patch cannot be empty" });

const worldWildlifeAreaInputSchema = z.strictObject({
  center: worldAreaShape.center.optional(),
  radius: worldAreaShape.radius.optional(),
});

const worldWildlifeAltitudeInputSchema = z
  .strictObject({
    min_m: z.number().finite().min(0).max(500),
    max_m: z.number().finite().min(0).max(500),
  })
  .refine((band) => band.max_m >= band.min_m, { message: "altitude max_m must be >= min_m" });

const worldWildlifeFieldSchemas = {
  name: directorWorldWildlifeGroupSchema.shape.name,
  count: directorWorldWildlifeGroupSchema.shape.count,
  speed_scale: directorWorldWildlifeGroupSchema.shape.speedScale,
  size_scale: directorWorldWildlifeGroupSchema.shape.sizeScale,
  seed_offset: directorWorldWildlifeGroupSchema.shape.seedOffset,
} as const;

const worldWildlifeUpdateSchema = z
  .strictObject({
    name: worldWildlifeFieldSchemas.name.optional(),
    species: worldWildlifeSpecies.optional(),
    count: worldWildlifeFieldSchemas.count.optional(),
    area: worldWildlifeAreaInputSchema.optional(),
    altitude: worldWildlifeAltitudeInputSchema.nullable().optional(),
    speed_scale: worldWildlifeFieldSchemas.speed_scale.optional(),
    size_scale: worldWildlifeFieldSchemas.size_scale.optional(),
    asset_id: id.nullable().optional(),
    seed_offset: worldWildlifeFieldSchemas.seed_offset.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "world wildlife patch cannot be empty" });

const worldRoadFieldSchemas = {
  name: directorWorldRoadSchema.shape.name,
  points: directorWorldRoadSchema.shape.points,
  width_m: directorWorldRoadSchema.shape.widthM,
  loop: directorWorldRoadSchema.shape.loop,
  vehicle_count: directorWorldRoadSchema.shape.vehicleCount,
  speed_kph: directorWorldRoadSchema.shape.speedKph,
  show_surface: directorWorldRoadSchema.shape.showSurface,
  seed_offset: directorWorldRoadSchema.shape.seedOffset,
} as const;

const worldRoadUpdateSchema = z
  .strictObject({
    name: worldRoadFieldSchemas.name.optional(),
    points: worldRoadFieldSchemas.points.optional(),
    width_m: worldRoadFieldSchemas.width_m.optional(),
    loop: worldRoadFieldSchemas.loop.optional(),
    vehicle_count: worldRoadFieldSchemas.vehicle_count.optional(),
    speed_kph: worldRoadFieldSchemas.speed_kph.optional(),
    show_surface: worldRoadFieldSchemas.show_surface.optional(),
    seed_offset: worldRoadFieldSchemas.seed_offset.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "world road patch cannot be empty" });

const vehicleKind = z.enum(DIRECTOR_VEHICLE_KINDS);
const vehicleProfileShape = directorVehicleProfileSchema.shape;
const vehicleCameraShape = vehicleProfileShape.camera.shape;

const vehicleCameraPatchSchema = z
  .strictObject({
    chase_distance_m: vehicleCameraShape.chaseDistanceM.optional(),
    chase_height_m: vehicleCameraShape.chaseHeightM.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "vehicle camera patch cannot be empty" });

/** Partial snake_case vehicle profile; an empty patch attaches pure defaults. */
const vehicleProfilePatchSchema = z.strictObject({
  kind: vehicleKind.optional(),
  drivable: vehicleProfileShape.drivable.optional(),
  mass_kg: vehicleProfileShape.massKg.optional(),
  engine_force_n: vehicleProfileShape.engineForceN.optional(),
  brake_force_n: vehicleProfileShape.brakeForceN.optional(),
  max_speed_kph: vehicleProfileShape.maxSpeedKph.optional(),
  reverse_speed_kph: vehicleProfileShape.reverseSpeedKph.optional(),
  steer_max_deg: vehicleProfileShape.steerMaxDeg.optional(),
  wheel_radius_m: vehicleProfileShape.wheelRadiusM.optional(),
  suspension_rest_m: vehicleProfileShape.suspensionRestM.optional(),
  suspension_stiffness: vehicleProfileShape.suspensionStiffness.optional(),
  center_of_mass_y_offset_m: vehicleProfileShape.centerOfMassYOffsetM.optional(),
  seat_offset: vehicleProfileShape.seatOffset.optional(),
  exit_offsets: vehicleProfileShape.exitOffsets.optional(),
  camera: vehicleCameraPatchSchema.optional(),
});

export const directorAuthoringActionSchema = z
  .discriminatedUnion("action", [
    strictAction("start_scene", {
      preserve_assets: z.boolean().optional(),
    }),
    strictAction("set_scene", { patch: scenePatchSchema }),
    strictAction("upsert_asset", { asset: directorAssetRefSchema }),
    strictAction("remove_assets", {
      asset_ids: z.array(id).min(1).max(128),
      cascade: z.boolean().optional(),
    }),
    strictAction("add_object", {
      id,
      name,
      kind: objectKind,
      transform: directorTransformSchema.optional(),
      body_type: bodyType.optional(),
      character_source: z.literal("asset").optional(),
      color: color.optional(),
      material: directorPbrMaterialSchema.optional(),
      pose_preset_id: posePresetId.optional(),
      asset_id: id.optional(),
      geometry_type: geometryType
        .optional()
        .describe(
          "Rejected on the public director_workbench agent wire. Instance catalog or project meshes with asset_id, or model with blender_native / generated_3d.",
        ),
      placement_mode: placementMode.optional(),
      parent_id: id.optional(),
      look_target_object_id: id.optional(),
      reference_bindings: z.array(directorReferenceBindingSchema).max(32).optional(),
      locked: z.boolean().optional(),
      layer: z.string().trim().min(1).max(80).optional(),
      pivot: directorVec3Schema.optional(),
      interaction: toggleTransformInteractionInputSchema.optional(),
    }),
    strictAction("update_object", {
      object_id: id,
      patch: objectUpdateSchema,
      force: z.boolean().optional(),
    }),
    strictAction("set_object_interaction", {
      object_id: id,
      interaction: toggleTransformInteractionInputSchema,
      force: z.boolean().optional(),
    }),
    strictAction("clear_object_interaction", {
      object_id: id,
      force: z.boolean().optional(),
    }),
    strictAction("batch_update_objects", {
      object_ids: objectIds,
      patch: objectUpdateSchema,
      force: z.boolean().optional(),
    }),
    strictAction("reset_transforms", {
      object_ids: objectIds,
      components: z
        .array(z.enum(["position", "rotation", "scale"]))
        .min(1)
        .max(3)
        .default(["position", "rotation", "scale"]),
      force: z.boolean().optional(),
    }),
    strictAction("align_objects", {
      object_ids: z
        .array(id)
        .min(2)
        .max(256)
        .refine((values) => new Set(values).size === values.length, { message: "object_ids must be unique" }),
      axis: z.enum(["x", "y", "z"]),
      mode: z.enum(["min", "center", "max"]).default("center"),
      force: z.boolean().optional(),
    }),
    strictAction("distribute_objects", {
      object_ids: z
        .array(id)
        .min(3)
        .max(256)
        .refine((values) => new Set(values).size === values.length, { message: "object_ids must be unique" }),
      axis: z.enum(["x", "y", "z"]),
      force: z.boolean().optional(),
    }),
    strictAction("isolate_objects", {
      object_ids: objectIds,
      force: z.boolean().optional(),
    }),
    strictAction("show_all_objects", {}),
    strictAction("set_object_pivot", {
      object_id: id,
      pivot: directorVec3Schema.nullable(),
      force: z.boolean().optional(),
    }),
    strictAction("group_objects", {
      group_id: id,
      name,
      object_ids: z.array(id).min(1).max(256),
    }),
    strictAction("ungroup_objects", {
      group_id: id,
      delete_group: z.boolean().default(true),
      force: z.boolean().optional(),
    }),
    strictAction("add_annotation", { annotation: directorSceneAnnotationSchema }),
    strictAction("update_annotation", { annotation_id: id, patch: annotationUpdateSchema }),
    strictAction("remove_annotations", { annotation_ids: z.array(id).min(1).max(512) }),
    strictAction("add_measurement", { measurement: directorSceneMeasurementSchema }),
    strictAction("update_measurement", { measurement_id: id, patch: measurementUpdateSchema }),
    strictAction("remove_measurements", { measurement_ids: z.array(id).min(1).max(512) }),
    strictAction("set_object_layer_state", {
      layer_id: z.string().trim().min(1).max(80),
      visible: z.boolean().optional(),
      locked: z.boolean().optional(),
    }),
    strictAction("reorder_object_layer", {
      layer_id: z.string().trim().min(1).max(80),
      before_layer_id: z.string().trim().min(1).max(80).nullable(),
    }),
    strictAction("focus_objects", { object_ids: objectIds }),
    strictAction("set_character_pose_controls", {
      object_id: id,
      controls: characterPoseControlsInputSchema,
      mode: z.enum(["merge", "replace"]).optional(),
      force: z.boolean().optional(),
    }),
    strictAction("clear_character_pose_controls", {
      object_id: id,
      force: z.boolean().optional(),
    }),
    strictAction("set_character_motion", {
      object_id: id,
      clip_id: characterMotionId,
      enabled: z.boolean().optional(),
      loop: z.enum(DIRECTOR_CHARACTER_MOTION_LOOPS).optional(),
      speed: z.number().finite().min(0.1).max(4).optional(),
      weight: z.number().finite().min(0).max(1).optional(),
      start_frame: z.number().int().min(-1_000_000).max(1_000_000).optional(),
      blend_in_s: z.number().finite().min(0).max(10).optional(),
      blend_out_s: z.number().finite().min(0).max(10).optional(),
      // `authored` remains readable in DirectorProject for legacy migration,
      // but new UI/Agent operations cannot create visual-root/collider drift.
      root_motion: z.literal("in-place").optional(),
      force: z.boolean().optional(),
    }),
    strictAction("clear_character_motion", {
      object_id: id,
      force: z.boolean().optional(),
    }),
    strictAction("set_character_ik", {
      object_id: id,
      effector: characterIkEffector,
      ...characterIkTargetInputSchema.shape,
      force: z.boolean().optional(),
    }),
    strictAction("clear_character_ik", {
      object_id: id,
      effector: characterIkEffector.optional(),
      force: z.boolean().optional(),
    }),
    strictAction("bind_character_agent", {
      object_id: id,
      /** Durable Agent session id (e.g. dsh-<harness session id>). */
      session_id: z.string().trim().min(1).max(160).optional(),
      /** Agent profile id; allows attaching before a live session exists. */
      profile_id: z.string().trim().min(1).max(160).optional(),
      role_id: z.string().trim().min(1).max(160).optional(),
      /** Only possess exists today: the bound Agent drives this character. */
      mode: z.literal("possess").optional(),
      force: z.boolean().optional(),
    }),
    strictAction("unbind_character_agent", {
      object_id: id,
      force: z.boolean().optional(),
    }),
    strictAction("delete_objects", {
      object_ids: z.array(id).min(1).max(256),
      cascade: z.boolean().optional(),
      force: z.boolean().optional(),
    }),
    strictAction("duplicate_objects", {
      object_ids: z
        .array(id)
        .min(1)
        .max(64)
        .refine((values) => new Set(values).size === values.length, { message: "object_ids must be unique" }),
      offset_m: z
        .number()
        .finite()
        .min(-100)
        .max(100)
        .optional()
        .describe("X/Z position offset in meters for every duplicate; defaults to 0.6."),
    }),
    strictAction("add_timeline_audio_clip", {
      id: id.optional(),
      track_id: id.optional(),
      name,
      media_id: z.string().trim().min(1).max(512),
      source_url: z.string().trim().min(1).max(8_192).optional(),
      start_frame: z.number().int().min(0).max(1_000_000).optional(),
      duration_frames: z.number().int().min(1).max(1_000_000),
      source_duration_sec: z.number().finite().positive().max(86_400).optional(),
    }),
    strictAction("update_timeline_audio_clip", {
      clip_id: id,
      patch: directorTimelineAudioClipSchema
        .omit({ id: true, mediaId: true })
        .partial()
        .refine((patch) => Object.keys(patch).length > 0, { message: "patch must not be empty" }),
    }),
    strictAction("remove_timeline_audio_clips", {
      clip_ids: z
        .array(id)
        .min(1)
        .max(128)
        .refine((values) => new Set(values).size === values.length, { message: "clip_ids must be unique" }),
    }),
    strictAction("set_timeline_audio_track_muted", {
      track_id: id,
      muted: z.boolean(),
    }),
    strictAction("add_light", { light: directorLightCreateSchema }),
    strictAction("update_light", {
      light_id: id,
      patch: lightUpdateSchema,
      force: z.boolean().optional(),
    }),
    strictAction("delete_lights", {
      light_ids: z.array(id).min(1).max(128),
      force: z.boolean().optional(),
    }),
    strictAction("add_camera", {
      id,
      /** Rig object id; omitted ids derive `${id}-rig` so callers invent one id. */
      object_id: id.optional(),
      name,
      position: directorVec3Schema,
      target: directorVec3Schema,
      target_object_id: id.nullable().optional(),
      focal_length_mm: z.number().finite().min(12).max(200).optional(),
      sensor_format: cameraSensorFormat.optional(),
      aperture_f_stop: apertureFStop.optional(),
      focus_distance_m: focusDistanceM.optional(),
      shutter_angle: shutterAngle.optional(),
      iso: cameraIso.optional(),
      near_clip_m: nearClipM.optional(),
      far_clip_m: farClipM.optional(),
      anamorphic_squeeze: anamorphicSqueeze.optional(),
      aspect_ratio: cameraAspect.optional(),
      handheld_shake: handheldShake.optional(),
      action_mode: cameraActionInputSchema.optional(),
      activate: z.boolean().optional(),
    }),
    strictAction("update_camera", { camera_id: id, patch: cameraUpdateSchema }),
    strictAction("delete_cameras", { camera_ids: z.array(id).min(1).max(64) }),
    strictAction("set_animation", {
      target_type: directorAnimationEntityTypeSchema,
      target_id: id,
      animation: directorEntityAnimationSchema.nullable(),
    }),
    strictAction("apply_animation_recipe", {
      target_type: directorAnimationEntityTypeSchema,
      target_id: id,
      frame_start: z.number().int().safe(),
      frame_end: z.number().int().safe(),
      recipe: directorAnimationRecipeInputSchema,
      motion: z.enum(DIRECTOR_TRAJECTORY_MOTIONS).optional(),
      force: z.boolean().optional(),
    }),
    strictAction("set_storyboard", { storyboard: directorStoryboardSchema.nullable() }),
    strictAction("set_active_camera", { camera_id: id.nullable() }),
    strictAction("add_performance_take", {
      take: directorPerformanceTakeSchema,
      activate: z.boolean().optional(),
    }),
    strictAction("update_performance_take", {
      take_id: id,
      patch: performanceTakeUpdateSchema,
      activate: z.boolean().optional(),
    }),
    strictAction("delete_performance_takes", {
      take_ids: z.array(id).min(1).max(128),
      cascade: z.boolean().optional(),
    }),
    strictAction("add_coverage_sequence", {
      sequence: directorCoverageSequenceSchema,
      activate: z.boolean().optional(),
    }),
    strictAction("update_coverage_sequence", {
      sequence_id: id,
      patch: coverageSequenceUpdateSchema,
      activate: z.boolean().optional(),
    }),
    strictAction("delete_coverage_sequences", {
      sequence_ids: z.array(id).min(1).max(128),
    }),
    strictAction("add_coverage_shot", {
      sequence_id: id,
      shot: directorCoverageShotSchema,
      activate: z.boolean().optional(),
    }),
    strictAction("update_coverage_shot", {
      shot_id: id,
      patch: coverageShotUpdateSchema,
      activate: z.boolean().optional(),
    }),
    strictAction("delete_coverage_shots", {
      shot_ids: z.array(id).min(1).max(256),
    }),
    strictAction("set_world_settings", { settings: worldSettingsPatchSchema }),
    strictAction("add_world_effect", {
      id: id.optional(),
      name: worldEffectFieldSchemas.name.optional(),
      kind: worldEffectKind,
      anchor: worldEffectFieldSchemas.anchor.optional(),
      shape: worldEffectFieldSchemas.shape.optional(),
      intensity: worldEffectFieldSchemas.intensity.optional(),
      size_scale: worldEffectFieldSchemas.size_scale.optional(),
      speed_scale: worldEffectFieldSchemas.speed_scale.optional(),
      color_tint: worldColorTint.optional(),
      wind_influence: worldEffectFieldSchemas.wind_influence.optional(),
      propagation: worldFirePropagationInputSchema.optional(),
      seed_offset: worldEffectFieldSchemas.seed_offset.optional(),
    }),
    strictAction("update_world_effect", { effect_id: id, patch: worldEffectUpdateSchema }),
    strictAction("remove_world_effects", {
      effect_ids: z.array(id).min(1).max(DIRECTOR_WORLD_MAX_EFFECTS),
    }),
    strictAction("add_world_water_body", {
      id: id.optional(),
      name: worldWaterBodyFieldSchemas.name.optional(),
      surface: worldWaterBodyFieldSchemas.surface.optional(),
      river: worldWaterBodyFieldSchemas.river.optional(),
      wave_amplitude: worldWaterBodyFieldSchemas.wave_amplitude.optional(),
      wave_length_m: worldWaterBodyFieldSchemas.wave_length_m.optional(),
      flow_direction_degrees: worldWaterBodyFieldSchemas.flow_direction_degrees.optional(),
      flow_speed_mps: worldWaterBodyFieldSchemas.flow_speed_mps.optional(),
      color_shallow: worldWaterBodyFieldSchemas.color_shallow.optional(),
      color_deep: worldWaterBodyFieldSchemas.color_deep.optional(),
      opacity: worldWaterBodyFieldSchemas.opacity.optional(),
      foam_intensity: worldWaterBodyFieldSchemas.foam_intensity.optional(),
    }),
    strictAction("update_world_water_body", { body_id: id, patch: worldWaterBodyUpdateSchema }),
    strictAction("remove_world_water_bodies", {
      body_ids: z.array(id).min(1).max(DIRECTOR_WORLD_MAX_WATER_BODIES),
    }),
    strictAction("add_world_wildlife_group", {
      id: id.optional(),
      name: worldWildlifeFieldSchemas.name.optional(),
      species: worldWildlifeSpecies,
      count: worldWildlifeFieldSchemas.count.optional(),
      area: worldWildlifeAreaInputSchema.optional(),
      altitude: worldWildlifeAltitudeInputSchema.optional(),
      speed_scale: worldWildlifeFieldSchemas.speed_scale.optional(),
      size_scale: worldWildlifeFieldSchemas.size_scale.optional(),
      asset_id: id.optional(),
      seed_offset: worldWildlifeFieldSchemas.seed_offset.optional(),
    }),
    strictAction("update_world_wildlife_group", { group_id: id, patch: worldWildlifeUpdateSchema }),
    strictAction("remove_world_wildlife_groups", {
      group_ids: z.array(id).min(1).max(DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS),
    }),
    strictAction("add_world_road", {
      id: id.optional(),
      name: worldRoadFieldSchemas.name.optional(),
      points: worldRoadFieldSchemas.points,
      width_m: worldRoadFieldSchemas.width_m.optional(),
      loop: worldRoadFieldSchemas.loop.optional(),
      vehicle_count: worldRoadFieldSchemas.vehicle_count.optional(),
      speed_kph: worldRoadFieldSchemas.speed_kph.optional(),
      show_surface: worldRoadFieldSchemas.show_surface.optional(),
      seed_offset: worldRoadFieldSchemas.seed_offset.optional(),
    }),
    strictAction("update_world_road", { road_id: id, patch: worldRoadUpdateSchema }),
    strictAction("remove_world_roads", {
      road_ids: z.array(id).min(1).max(DIRECTOR_WORLD_MAX_ROADS),
    }),
    strictAction("set_vehicle_profile", {
      object_id: id,
      /** Omitted (or {}) attaches the pure default car profile. */
      profile: vehicleProfilePatchSchema.optional(),
    }),
    strictAction("clear_vehicle_profile", { object_id: id }),
    directorComposeBlockingActionSchema,
    directorFrameShotActionSchema,
    directorMarkCameraMoveActionSchema,
    directorPlaceRelativeActionSchema,
    directorArrangeGroupActionSchema,
    directorArrangeFacingPairActionSchema,
    directorOrientTowardActionSchema,
    directorApplyProceduralActionSchema,
  ])
  .superRefine((action, context) => {
    if (action.action === "set_animation") {
      action.animation?.motionBlocks?.forEach((block, index) => {
        if (!isDirectorCharacterMotionId(block.clipId)) {
          context.addIssue({
            code: "custom",
            path: ["animation", "motionBlocks", index, "clipId"],
            message: "unknown packaged character motion",
          });
        }
      });
      return;
    }
    if (action.action === "upsert_asset") {
      const error = catalogAssetIdentityError(action.asset);
      if (error) context.addIssue({ code: "custom", path: ["asset"], message: error });
      return;
    }
    if (action.action === "bind_character_agent") {
      if (!action.session_id && !action.profile_id) {
        context.addIssue({
          code: "custom",
          path: ["session_id"],
          message: "bind_character_agent requires session_id or profile_id",
        });
      }
      // "http-default" is the gateway's shared fallback for untargeted HTTP
      // callers; binding it would hand possession to every anonymous caller.
      if (action.session_id === "http-default") {
        context.addIssue({
          code: "custom",
          path: ["session_id"],
          message:
            'bind_character_agent cannot bind the anonymous HTTP fallback session "http-default"; pass the durable Agent session id that drives this character (e.g. dsh-<session>) or a profile_id',
        });
      }
      return;
    }
    if (action.action !== "add_object") return;
    if (action.kind !== "character" && action.character_source !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["character_source"],
        message: "character_source is only valid for kind=character",
      });
      return;
    }
    if (action.kind !== "character") return;
    // Missing asset_id is intentional: execution resolves an exact character
    // alias or binds the canonical X Bot. Generic/assetless characters are not
    // part of the authoring contract anymore.
  });

export type DirectorAuthoringAction = z.infer<typeof directorAuthoringActionSchema>;

export interface DirectorAuthoringResult {
  project: DirectorProject;
  created: DirectorAuthoringChangedIds;
  updated: DirectorAuthoringChangedIds;
  deleted: DirectorAuthoringChangedIds;
  action_count: number;
  /** Human-readable side effects, e.g. the world block being created on demand. */
  notes: string[];
}

interface DirectorAuthoringChangedIds {
  asset_ids: string[];
  object_ids: string[];
  camera_ids: string[];
  light_ids: string[];
  performance_take_ids: string[];
  coverage_sequence_ids: string[];
  coverage_shot_ids: string[];
  annotation_ids: string[];
  measurement_ids: string[];
  layer_ids: string[];
  world_effect_ids: string[];
  world_water_body_ids: string[];
  world_wildlife_group_ids: string[];
  world_road_ids: string[];
  timeline_audio_clip_ids: string[];
  timeline_audio_track_ids: string[];
}

function createChangedIds(): DirectorAuthoringChangedIds {
  return {
    asset_ids: [],
    object_ids: [],
    camera_ids: [],
    light_ids: [],
    performance_take_ids: [],
    coverage_sequence_ids: [],
    coverage_shot_ids: [],
    annotation_ids: [],
    measurement_ids: [],
    layer_ids: [],
    world_effect_ids: [],
    world_water_body_ids: [],
    world_wildlife_group_ids: [],
    world_road_ids: [],
    timeline_audio_clip_ids: [],
    timeline_audio_track_ids: [],
  };
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

const MAX_TIMELINE_AUDIO_TRACKS = 8;
const MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK = 128;

/** Ensure the project has a frame timeline and return a mutable audioTracks array. */
function ensureTimelineAudioTracks(project: DirectorProject): {
  timeline: NonNullable<DirectorProject["scene"]["timeline"]>;
  tracks: DirectorTimelineAudioTrack[];
} {
  const timeline: NonNullable<DirectorProject["scene"]["timeline"]> = project.scene.timeline ?? {
    ...createDefaultDirectorFrameTimeline(),
  };
  project.scene.timeline = timeline;
  const tracks: DirectorTimelineAudioTrack[] = timeline.audioTracks ? [...timeline.audioTracks] : [];
  timeline.audioTracks = tracks;
  return { timeline, tracks };
}

function requireTimelineAudioClip(
  tracks: DirectorTimelineAudioTrack[],
  clipId: string,
): { track: DirectorTimelineAudioTrack; clip: DirectorTimelineAudioClip; trackIndex: number; clipIndex: number } {
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
    const track = tracks[trackIndex]!;
    const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
    if (clipIndex >= 0) {
      return { track, clip: track.clips[clipIndex]!, trackIndex, clipIndex };
    }
  }
  throw new Error(`Timeline audio clip "${clipId}" was not found.`);
}

function ensureAvailableId(project: DirectorProject, value: string, label: string) {
  const exists =
    project.assets.some((item) => item.id === value) ||
    project.objects.some((item) => item.id === value) ||
    project.cameras.some((item) => item.id === value) ||
    project.lights?.some((item) => item.id === value) ||
    project.storyboard?.shots.some((item) => item.id === value) ||
    project.production?.takes.some(
      (take) => take.id === value || take.entityTracks.some((track) => track.id === value),
    ) ||
    project.production?.sequences.some(
      (sequence) => sequence.id === value || sequence.shots.some((shot) => shot.id === value),
    ) ||
    project.scene.annotations?.some((annotation) => annotation.id === value) ||
    project.scene.measurements?.some((measurement) => measurement.id === value);
  if (exists) throw new Error(`${label} id "${value}" already exists.`);
}

function requireAsset(project: DirectorProject, assetId: string) {
  const asset = project.assets.find((item) => item.id === assetId);
  if (!asset) {
    throw new Error(`No asset with id "${assetId}" exists. Add it before referencing it.`);
  }
  return asset;
}

function requireCompatibleAsset(project: DirectorProject, assetId: string, objectKind: DirectorObject["kind"]) {
  const asset = requireAsset(project, assetId);
  if (asset.kind !== objectKind) {
    throw new Error(
      `Asset "${assetId}" has kind "${asset.kind}" and cannot be bound to a "${objectKind}" object. Character, prop, scene, and panorama assets require the matching object kind.`,
    );
  }
  return asset;
}

function catalogAssetIdentityError(asset: DirectorAssetRef) {
  const packagedUrl =
    asset.url.startsWith("/mixamo-characters/") ||
    asset.url.startsWith("/flick-stage-props/") ||
    asset.url.startsWith("/director-characters/");
  if (asset.assetSource !== "library" && !packagedUrl) return null;
  const catalogItem = getDirectorAgentCatalogAsset(asset.id);
  if (!catalogItem) {
    return `Library asset "${asset.id}" is not an exact catalog identity. Discover it with director_workbench catalog and reuse item.asset unchanged; local user imports must use assetSource="local".`;
  }
  const expected = catalogItem.asset;
  // Only the fields that decide what actually loads are locked to the catalog;
  // display name and projectionMode stay customizable.
  const differs =
    asset.id !== expected.id ||
    asset.url !== expected.url ||
    asset.fileName !== expected.fileName ||
    asset.sourceType !== expected.sourceType ||
    JSON.stringify(asset.characterMetadata ?? null) !== JSON.stringify(expected.characterMetadata ?? null);
  return differs
    ? `Library asset "${asset.id}" does not exactly match its catalog id, url, fileName, sourceType, or characterMetadata. Reuse those fields from catalog item.asset unchanged; name and projectionMode may be customized.`
    : null;
}

function assertCatalogAssetIdentity(asset: DirectorAssetRef) {
  const error = catalogAssetIdentityError(asset);
  if (error) throw new Error(error);
}

function assertCharacterIdentityIntent(input: {
  kind: DirectorObject["kind"];
  name: string;
  assetId?: string;
  characterSource?: "asset";
}) {
  if (input.kind !== "character") {
    if (input.characterSource !== undefined) throw new Error("character_source is only valid for character objects.");
    return;
  }
  if (input.characterSource === "asset" && !input.assetId) {
    throw new Error("character_source=asset requires a concrete asset_id.");
  }
  if (!input.assetId) throw new Error(`Character "${input.name}" must bind a concrete asset_id.`);
}

function resolveAgentCharacterAssetId(name: string) {
  const characterClaims = findDirectorAgentCatalogAssetsByClaim(name).filter((item) => item.kind === "character");
  if (characterClaims.length > 1) {
    throw new Error(
      `Character name "${name}" is ambiguous: ${characterClaims.map((item) => item.id).join(", ")}. Pass asset_id explicitly.`,
    );
  }
  return characterClaims[0]?.id ?? DEFAULT_MIXAMO_CHARACTER_ASSET_ID;
}

function requireObject(project: DirectorProject, objectId: string) {
  const object = project.objects.find((item) => item.id === objectId);
  if (!object) throw new Error(`No object with id "${objectId}" exists.`);
  return object;
}

function isAuthoringObjectLocked(project: DirectorProject, object: DirectorObject) {
  if (object.locked) return true;
  const layerId = object.layer?.trim() || "default";
  return project.scene.objectLayers?.find((layer) => layer.id === layerId)?.locked ?? false;
}

function requireLight(project: DirectorProject, lightId: string) {
  const light = project.lights?.find((item) => item.id === lightId);
  if (!light) throw new Error(`No light with id "${lightId}" exists.`);
  return light;
}

function hasBlenderLightRepresentation(type: DirectorLight["type"]) {
  return type === "directional" || type === "point" || type === "spot" || type === "rect-area";
}

const WORLD_EFFECT_DEFAULT_NAMES: Record<WorldEffectKind, string> = {
  fire: "火焰",
  smoke: "烟雾",
  steam: "蒸汽",
  sparks: "火花",
  fireflies: "萤火虫",
  dust: "尘埃",
  rain: "雨幕",
  snow: "飘雪",
};

/** How strongly each preset is advected by the global wind by default. */
const WORLD_EFFECT_DEFAULT_WIND_INFLUENCE: Record<WorldEffectKind, number> = {
  fire: 0.35,
  smoke: 0.8,
  steam: 0.7,
  sparks: 0.5,
  fireflies: 0.25,
  dust: 0.9,
  rain: 1,
  snow: 1,
};

const WORLD_WATER_DEFAULT_NAME = "水体";

const WORLD_ROAD_DEFAULT_NAME = "道路";
/** First≈last control point implies a closed circuit when `loop` is omitted. */
const WORLD_ROAD_LOOP_INFER_EPSILON_M = 1e-6;

const WORLD_WILDLIFE_DEFAULT_NAMES: Record<WorldWildlifeSpecies, string> = {
  birds: "鸟群",
  butterflies: "蝴蝶群",
  fish: "鱼群",
  deer: "鹿群",
  rabbits: "兔群",
  wolves: "狼群",
  sheep: "羊群",
};

const WORLD_WILDLIFE_DEFAULT_COUNTS: Record<WorldWildlifeSpecies, number> = {
  birds: 24,
  butterflies: 16,
  fish: 40,
  deer: 6,
  rabbits: 8,
  wolves: 4,
  sheep: 10,
};

/** Default flight bands for aerial species; grounded herds stay on the terrain. */
const WORLD_WILDLIFE_DEFAULT_ALTITUDES: Partial<Record<WorldWildlifeSpecies, { minM: number; maxM: number }>> = {
  birds: { minM: 8, maxM: 25 },
  butterflies: { minM: 0.5, maxM: 3 },
};

function ensureWorld(project: DirectorProject, notes: string[]) {
  if (!project.world) {
    project.world = createDefaultDirectorWorld();
    notes.push("The project had no world block; created project.world with default settings (enabled: true).");
  }
  return project.world;
}

function ensureAvailableWorldId(world: DirectorWorld, value: string, label: string) {
  const exists =
    world.effects.some((entry) => entry.id === value) ||
    world.waterBodies.some((entry) => entry.id === value) ||
    world.wildlife.some((entry) => entry.id === value) ||
    // Pre-roads in-memory world blocks may lack the defaulted collection.
    (world.roads ?? []).some((entry) => entry.id === value);
  if (exists) throw new Error(`${label} id "${value}" already exists.`);
}

function nextWorldEntryId(world: DirectorWorld, prefix: string) {
  const used = new Set([
    ...world.effects.map((entry) => entry.id),
    ...world.waterBodies.map((entry) => entry.id),
    ...world.wildlife.map((entry) => entry.id),
    ...(world.roads ?? []).map((entry) => entry.id),
  ]);
  let ordinal = 1;
  while (used.has(`${prefix}_${ordinal}`)) ordinal += 1;
  return { id: `${prefix}_${ordinal}`, ordinal };
}

function formatWorldEntryName(label: string, ordinal: number) {
  return `${label}${String(ordinal).padStart(2, "0")}`;
}

/** Stable per-collection increment that decorrelates new emitters from existing ones. */
function nextWorldSeedOffset(entries: ReadonlyArray<{ seedOffset: number }>) {
  return entries.reduce((next, entry) => Math.max(next, entry.seedOffset + 1), 0) % 65_536;
}

function assertWorldCapacity(count: number, limit: number, label: string, removeAction: string) {
  if (count >= limit) {
    throw new Error(
      `The world already contains the maximum of ${limit} ${label}. Remove existing entries with ${removeAction} first.`,
    );
  }
}

function requireWorldEffect(project: DirectorProject, effectId: string) {
  const effect = project.world?.effects.find((entry) => entry.id === effectId);
  if (!effect) throw new Error(`No world effect with id "${effectId}" exists.`);
  return effect;
}

function requireWorldWaterBody(project: DirectorProject, bodyId: string) {
  const body = project.world?.waterBodies.find((entry) => entry.id === bodyId);
  if (!body) throw new Error(`No world water body with id "${bodyId}" exists.`);
  return body;
}

function requireWorldWildlifeGroup(project: DirectorProject, groupId: string) {
  const group = project.world?.wildlife.find((entry) => entry.id === groupId);
  if (!group) throw new Error(`No world wildlife group with id "${groupId}" exists.`);
  return group;
}

function requireWorldRoad(project: DirectorProject, roadId: string) {
  const road = project.world?.roads?.find((entry) => entry.id === roadId);
  if (!road) throw new Error(`No world road with id "${roadId}" exists.`);
  return road;
}

function assertUnlockedWorldEntry(
  entry: { id: string; locked: boolean },
  patch: Record<string, unknown>,
  label: string,
  updateAction: string,
) {
  const unlockOnly = Object.keys(patch).length === 1 && patch.locked === false;
  if (entry.locked && !unlockOnly) {
    throw new Error(
      `${label} "${entry.id}" is locked. Unlock it first with an ${updateAction} patch {"locked": false}.`,
    );
  }
}

/** Fire propagation is a simulation contract: fire-kind only, unbound anchor only. */
function assertFirePropagationTarget(kind: DirectorWorldEffect["kind"], objectId: string | null | undefined) {
  if (kind !== "fire") {
    throw new Error('World effect propagation requires kind "fire". Remove propagation or change the kind.');
  }
  if (objectId) {
    throw new Error(
      "World effect propagation requires an unbound anchor (anchor.object_id null); spread history cannot track a moving object.",
    );
  }
}

function removeWorldEntries<T extends { id: string; locked: boolean }>(
  entries: T[],
  requestedIds: string[],
  label: string,
  updateAction: string,
) {
  const existing = new Set(entries.map((entry) => entry.id));
  requestedIds.forEach((entryId) => {
    if (!existing.has(entryId)) throw new Error(`No ${label} with id "${entryId}" exists.`);
  });
  const requested = new Set(requestedIds);
  const locked = entries.filter((entry) => requested.has(entry.id) && entry.locked);
  if (locked.length) {
    throw new Error(
      `Locked ${label}(s) ${locked.map((entry) => entry.id).join(", ")} cannot be removed. Unlock them first with an ${updateAction} patch {"locked": false}.`,
    );
  }
  return entries.filter((entry) => !requested.has(entry.id));
}

/**
 * Object kinds that may carry the drivable-vehicle capability. Vehicles are
 * physical set pieces: cameras are rig proxies, characters are actors, and
 * panoramas are 360° backdrops, so only prop and scene objects qualify.
 */
const VEHICLE_CAPABLE_OBJECT_KINDS = new Set<DirectorObject["kind"]>(["prop", "scene"]);

function requireVehicleCapableObject(project: DirectorProject, objectId: string) {
  const object = requireObject(project, objectId);
  if (!VEHICLE_CAPABLE_OBJECT_KINDS.has(object.kind)) {
    throw new Error(
      `Only prop and scene objects can carry a drivable vehicle profile; "${object.id}" is a ${object.kind} object.`,
    );
  }
  return object;
}

function validateMaterialTextureReferences(project: DirectorProject, material: DirectorObject["material"]) {
  Object.entries(material?.textures ?? {}).forEach(([slot, assetId]) => {
    if (!assetId) return;
    const asset = requireAsset(project, assetId);
    if (asset.sourceType !== "image") {
      throw new Error(`Material texture ${slot} must reference an image asset; "${assetId}" is ${asset.sourceType}.`);
    }
  });
}

function requireEditableCharacter(
  project: DirectorProject,
  objectId: string,
  force: boolean | undefined,
  feature: string,
) {
  const object = requireObject(project, objectId);
  if (object.kind !== "character") throw new Error(`Only characters can have ${feature}.`);
  if (isAuthoringObjectLocked(project, object) && !force) {
    throw new Error(`Object "${object.id}" is locked. Unlock it first or pass force:true for an explicit override.`);
  }
  return object;
}

function requireCamera(project: DirectorProject, cameraId: string) {
  const camera = project.cameras.find((item) => item.id === cameraId);
  if (!camera) throw new Error(`No camera with id "${cameraId}" exists.`);
  return camera;
}

function ensureProduction(project: DirectorProject) {
  project.production ??= { version: 1, takes: [], sequences: [], activeTakeId: null, activeSequenceId: null };
  return project.production;
}

function requirePerformanceTake(project: DirectorProject, takeId: string) {
  const take = project.production?.takes.find((item) => item.id === takeId);
  if (!take) throw new Error(`No performance_take with id "${takeId}" exists.`);
  return take;
}

function requireCoverageSequence(project: DirectorProject, sequenceId: string) {
  const sequence = project.production?.sequences.find((item) => item.id === sequenceId);
  if (!sequence) throw new Error(`No coverage_sequence with id "${sequenceId}" exists.`);
  return sequence;
}

function requireCoverageShot(project: DirectorProject, shotId: string) {
  for (const sequence of project.production?.sequences ?? []) {
    const shot = sequence.shots.find((item) => item.id === shotId);
    if (shot) return { sequence, shot };
  }
  throw new Error(`No coverage_shot with id "${shotId}" exists.`);
}

function validatePerformanceTakeReferences(project: DirectorProject, take: DirectorPerformanceTake) {
  const participantIds = new Set(take.objectIds);
  take.objectIds.forEach((objectId) => requireObject(project, objectId));
  take.entityTracks.forEach((track) => {
    requireObject(project, track.objectId);
    if (!participantIds.has(track.objectId)) {
      throw new Error(`Entity track "${track.id}" object "${track.objectId}" must also appear in take.objectIds.`);
    }
  });
}

function validateCoverageShotReferences(project: DirectorProject, shot: DirectorCoverageShot) {
  requirePerformanceTake(project, shot.takeId);
  requireCamera(project, shot.cameraId);
  if (shot.storyboardShotId && !project.storyboard?.shots.some((item) => item.id === shot.storyboardShotId)) {
    throw new Error(`No storyboard_shot with id "${shot.storyboardShotId}" exists.`);
  }
}

function validateCoverageSequenceReferences(project: DirectorProject, sequence: DirectorCoverageSequence) {
  sequence.shots.forEach((shot) => validateCoverageShotReferences(project, shot));
}

function mergeTransform(current: DirectorTransform, patch: Partial<DirectorTransform>): DirectorTransform {
  return {
    position: patch.position ? [...patch.position] : [...current.position],
    rotation: patch.rotation ? [...patch.rotation] : [...current.rotation],
    scale: patch.scale ? [...patch.scale] : [...current.scale],
  };
}

function assignOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined) {
  if (value === undefined) return;
  if (value === null) delete target[key];
  else target[key] = value;
}

function normalizeCameraActionInput(value: DirectorCameraAction | "still" | "transform"): DirectorCameraAction {
  return typeof value === "string" ? { mode: value } : value;
}

function cameraRigObject(project: DirectorProject, cameraId: string) {
  return project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === cameraId);
}

function assertAcyclicParent(project: DirectorProject, objectId: string, parentId: string) {
  const objectById = new Map(project.objects.map((object) => [object.id, object]));
  const visited = new Set<string>();
  let currentId: string | undefined = parentId;
  while (currentId) {
    if (currentId === objectId) {
      throw new Error(`Parenting "${objectId}" under "${parentId}" would create an object parent cycle.`);
    }
    if (visited.has(currentId)) {
      throw new Error(`The existing parent chain for "${parentId}" already contains a cycle.`);
    }
    visited.add(currentId);
    currentId = objectById.get(currentId)?.parentObjectId;
  }
}

function referencedChildren(project: DirectorProject, ids: Set<string>) {
  return project.objects.filter((object) => object.parentObjectId && ids.has(object.parentObjectId));
}

function deleteObjectSet(project: DirectorProject, requestedIds: string[], cascade: boolean, force: boolean) {
  const ids = new Set(requestedIds);
  requestedIds.forEach((objectId) => {
    const object = requireObject(project, objectId);
    if (isAuthoringObjectLocked(project, object) && !force) {
      throw new Error(`Object "${objectId}" or its layer is locked. Pass force:true to delete it.`);
    }
  });
  let children = referencedChildren(project, ids);
  if (children.length && !cascade) {
    throw new Error(
      `Objects are parents of ${children.map((item) => item.id).join(", ")}. Pass cascade:true to delete descendants.`,
    );
  }
  while (children.length) {
    children.forEach((child) => ids.add(child.id));
    children = referencedChildren(project, ids).filter((child) => !ids.has(child.id));
  }

  const linkedCameraIds = project.objects
    .filter((object) => ids.has(object.id) && object.linkedCameraId)
    .map((object) => object.linkedCameraId as string);
  const annotationIds = (project.scene.annotations ?? [])
    .filter((annotation) => annotation.anchor.objectId && ids.has(annotation.anchor.objectId))
    .map((annotation) => annotation.id);
  const measurementIds = (project.scene.measurements ?? [])
    .filter(
      (measurement) =>
        Boolean(measurement.start.objectId && ids.has(measurement.start.objectId)) ||
        Boolean(measurement.end.objectId && ids.has(measurement.end.objectId)),
    )
    .map((measurement) => measurement.id);
  project.objects = project.objects.filter((object) => !ids.has(object.id));
  project.scene.annotations = (project.scene.annotations ?? []).filter(
    (annotation) => !annotation.anchor.objectId || !ids.has(annotation.anchor.objectId),
  );
  project.scene.measurements = (project.scene.measurements ?? []).filter(
    (measurement) =>
      (!measurement.start.objectId || !ids.has(measurement.start.objectId)) &&
      (!measurement.end.objectId || !ids.has(measurement.end.objectId)),
  );
  project.cameras = project.cameras.filter((camera) => !linkedCameraIds.includes(camera.id));
  project.objects = project.objects.map((object) => {
    const parentRemoved = Boolean(object.parentObjectId && ids.has(object.parentObjectId));
    const lookTargetRemoved = Boolean(object.lookTargetObjectId && ids.has(object.lookTargetObjectId));
    return parentRemoved || lookTargetRemoved
      ? {
          ...object,
          ...(parentRemoved ? { parentObjectId: undefined } : {}),
          ...(lookTargetRemoved ? { lookTargetObjectId: null } : {}),
        }
      : object;
  });
  project.cameras = project.cameras.map((camera) => {
    const targetRemoved = Boolean(camera.targetObjectId && ids.has(camera.targetObjectId));
    const followRemoved =
      camera.action?.mode === "follow" &&
      Boolean(camera.action.follow?.targetObjectId && ids.has(camera.action.follow.targetObjectId));
    const pathRemoved =
      camera.action?.mode === "path" &&
      Boolean(camera.action.path?.targetObjectId && ids.has(camera.action.path.targetObjectId));
    if (!targetRemoved && !followRemoved && !pathRemoved) return camera;
    return {
      ...camera,
      ...(targetRemoved ? { targetMode: "manual" as const, targetObjectId: null } : {}),
      ...(followRemoved || pathRemoved ? { action: DEFAULT_DIRECTOR_CAMERA_ACTION } : {}),
    };
  });
  if (project.activeCameraId && linkedCameraIds.includes(project.activeCameraId)) {
    project.activeCameraId = project.cameras[0]?.id ?? null;
  }
  project.storyboard = project.storyboard
    ? {
        ...project.storyboard,
        shots: project.storyboard.shots.map((shot) =>
          linkedCameraIds.includes(shot.cameraId ?? "") ? { ...shot, cameraId: null } : shot,
        ),
      }
    : undefined;
  return { objectIds: [...ids], cameraIds: linkedCameraIds, annotationIds, measurementIds };
}

/** Default X/Z duplicate offset in meters; the Stage paste uses the same value. */
export const DIRECTOR_DUPLICATE_POSITION_OFFSET_M = 0.6;

/**
 * Allocate the sequential id a duplicate of `source` receives. Shared with the
 * Stage clipboard paste so UI and Agent duplicates land identical ids.
 */
export function getDirectorDuplicateObjectId(
  existingObjects: ReadonlyArray<Pick<DirectorObject, "id" | "kind">>,
  source: Pick<DirectorObject, "kind" | "geometryType">,
) {
  if (source.kind === "camera") {
    return getNextSequentialId(
      existingObjects.map((item) => item.id),
      "cam_object_",
      existingObjects.filter((item) => item.kind === "camera").length + 1,
    );
  }
  if (source.kind === "character") {
    return getNextSequentialId(
      existingObjects.map((item) => item.id),
      "char_paste_",
      existingObjects.filter((item) => item.kind === "character").length + 1,
    );
  }
  if (source.geometryType) {
    return getNextSequentialId(
      existingObjects.map((item) => item.id),
      `geo_${source.geometryType}_copy_`,
      existingObjects.length + 1,
    );
  }
  return getNextSequentialId(
    existingObjects.map((item) => item.id),
    "obj_",
    existingObjects.length + 1,
  );
}

/**
 * Duplicate existing objects (and linked camera shots) with new sequential
 * ids, the Stage paste naming, and an X/Z offset. References are remapped
 * only within the duplicated set: duplicated children of non-duplicated
 * parents intentionally become independent, and duplicated object-focused
 * cameras follow their target's duplicate when that target is duplicated too.
 * Existing scene entities are never rewritten; the UI-only focus-height
 * recompute of the legacy paste stays a Stage fallback.
 */
function duplicateObjectSet(project: DirectorProject, requestedIds: string[], offset: number) {
  const sources = requestedIds.map((objectId) => requireObject(project, objectId));
  sources.forEach((source) => {
    if (source.nativeSource) {
      const asset = source.assetRefId ? project.assets.find((item) => item.id === source.assetRefId) : undefined;
      if (!asset || asset.sourceType !== "model") {
        throw new Error(
          `Blender-native object "${source.id}" has no importable model asset and cannot be duplicated. Author the copy in Blender through the DCC handoff instead.`,
        );
      }
    }
    if (source.kind === "camera" && !project.cameras.some((camera) => camera.id === source.linkedCameraId)) {
      throw new Error(
        `Camera object "${source.id}" has no linked camera shot to duplicate. Use add_camera to create a new camera instead.`,
      );
    }
  });

  const applyDuplicateOffset = (position: [number, number, number]): [number, number, number] => [
    position[0] + offset,
    position[1],
    position[2] + offset,
  ];
  const idMap = new Map<string, string>();
  const crowdIdMap = new Map<string, string>();
  const duplicatedObjectIds: string[] = [];
  const duplicatedCameraIds: string[] = [];

  function duplicateCrowdIdFor(sourceCrowdId: string) {
    const existing = crowdIdMap.get(sourceCrowdId);
    if (existing) return existing;
    const nextCrowdId = getNextSequentialId(
      project.objects.map((item) => item.crowdId).filter((value): value is string => typeof value === "string"),
      "crowd_",
      1,
    );
    crowdIdMap.set(sourceCrowdId, nextCrowdId);
    return nextCrowdId;
  }

  sources.forEach((source) => {
    const sourceCamera =
      source.kind === "camera" && source.linkedCameraId
        ? project.cameras.find((camera) => camera.id === source.linkedCameraId)
        : undefined;
    if (source.kind === "camera" && sourceCamera) {
      const cameraIndex = project.cameras.length + 1;
      const nextCameraId = getNextSequentialId(
        project.cameras.map((camera) => camera.id),
        "cam_",
        cameraIndex,
      );
      const nextObjectId = getDirectorDuplicateObjectId(project.objects, source);
      idMap.set(source.id, nextObjectId);
      idMap.set(sourceCamera.id, nextCameraId);
      const nextCamera: DirectorCameraShot = {
        ...structuredClone(sourceCamera),
        id: nextCameraId,
        name: formatSceneItemName("机位", cameraIndex),
        transform: {
          ...structuredClone(sourceCamera.transform),
          position: applyDuplicateOffset(sourceCamera.transform.position),
        },
        target:
          sourceCamera.targetMode === "manual"
            ? applyDuplicateOffset(sourceCamera.target)
            : ([...sourceCamera.target] as [number, number, number]),
        captures: [],
        lastCaptureUrl: null,
      };
      const nextCameraObject: DirectorObject = {
        ...structuredClone(source),
        id: nextObjectId,
        name: nextCamera.name,
        linkedCameraId: nextCamera.id,
        transform: structuredClone(nextCamera.transform),
      };
      project.cameras.push(nextCamera);
      project.objects.push(nextCameraObject);
      duplicatedObjectIds.push(nextObjectId);
      duplicatedCameraIds.push(nextCameraId);
      return;
    }

    const nextObjectId = getDirectorDuplicateObjectId(project.objects, source);
    idMap.set(source.id, nextObjectId);
    const nextCharacterCount =
      source.kind === "character" ? project.objects.filter((item) => item.kind === "character").length + 1 : null;
    const duplicatedObject: DirectorObject = {
      ...structuredClone(source),
      id: nextObjectId,
      name:
        source.kind === "character" && nextCharacterCount
          ? formatSceneItemName("角色", nextCharacterCount)
          : source.name,
      ...(source.crowdId ? { crowdId: duplicateCrowdIdFor(source.crowdId) } : {}),
      transform: {
        ...structuredClone(source.transform),
        position: applyDuplicateOffset(source.transform.position),
      },
      ...(source.nativeSource
        ? { nativeSource: { engine: "blender" as const, objectId: nextObjectId, provisioned: false as const } }
        : {}),
    };
    project.objects.push(duplicatedObject);
    duplicatedObjectIds.push(nextObjectId);
  });

  // A duplicated child must never silently reattach to the original
  // composition: reconnect the duplicated pair when its parent was duplicated
  // too, otherwise the copy intentionally becomes an independent object.
  const duplicatedObjectIdSet = new Set(duplicatedObjectIds);
  project.objects = project.objects.map((object) => {
    if (!duplicatedObjectIdSet.has(object.id) || !object.parentObjectId) return object;
    const mappedParentId = idMap.get(object.parentObjectId);
    const remapped = { ...object };
    if (mappedParentId) remapped.parentObjectId = mappedParentId;
    else delete remapped.parentObjectId;
    return remapped;
  });

  // Duplicated object-focused cameras follow their target's duplicate (which
  // moved by exactly the duplicate offset); other cameras are left untouched.
  const duplicatedCameraIdSet = new Set(duplicatedCameraIds);
  project.cameras = project.cameras.map((camera) => {
    if (!duplicatedCameraIdSet.has(camera.id)) return camera;
    if (camera.targetMode !== "object" || !camera.targetObjectId) return camera;
    const mappedTargetObjectId = idMap.get(camera.targetObjectId) ?? camera.targetObjectId;
    if (!project.objects.some((object) => object.id === mappedTargetObjectId)) {
      return { ...camera, targetMode: "manual" as const, targetObjectId: null };
    }
    if (mappedTargetObjectId === camera.targetObjectId) return camera;
    return {
      ...camera,
      targetObjectId: mappedTargetObjectId,
      target: applyDuplicateOffset(camera.target),
    };
  });

  // Match the Stage paste: duplicating a camera hands it the viewport.
  const lastDuplicatedObject = duplicatedObjectIds.length
    ? project.objects.find((object) => object.id === duplicatedObjectIds[duplicatedObjectIds.length - 1])
    : undefined;
  if (lastDuplicatedObject?.kind === "camera" && lastDuplicatedObject.linkedCameraId) {
    project.activeCameraId = lastDuplicatedObject.linkedCameraId;
  }

  return { objectIds: duplicatedObjectIds, cameraIds: duplicatedCameraIds };
}

export function applyDirectorAuthoringActions(
  source: DirectorProject,
  actions: DirectorAuthoringAction[],
): DirectorAuthoringResult {
  const startSceneIndexes = actions.flatMap((action, index) => (action.action === "start_scene" ? [index] : []));
  if (startSceneIndexes.length > 1) throw new Error("Only one start_scene action is allowed per atomic author batch.");
  if (startSceneIndexes[0] !== undefined && startSceneIndexes[0] !== 0) {
    throw new Error("start_scene must be the first action in an atomic author batch.");
  }
  const project = structuredClone(source);
  const result: DirectorAuthoringResult = {
    project,
    created: createChangedIds(),
    updated: createChangedIds(),
    deleted: createChangedIds(),
    action_count: actions.length,
    notes: [],
  };
  let rebuildProduction = false;

  const pendingActions = [...actions];
  for (let actionIndex = 0; actionIndex < pendingActions.length; actionIndex += 1) {
    const item = pendingActions[actionIndex];
    if (item.action === "compose_blocking") {
      pendingActions.splice(actionIndex, 1, ...buildDirectorBlockingActions(item, project.scene.groundHeight));
      actionIndex -= 1;
      continue;
    }
    if (item.action === "frame_shot") {
      const expansion = buildDirectorFrameShotActions(project, item);
      result.notes.push(...expansion.notes);
      pendingActions.splice(actionIndex, 1, ...expansion.actions);
      actionIndex -= 1;
      continue;
    }
    if (item.action === "mark_camera_move") {
      const expansion = buildDirectorMarkCameraMoveActions(project, item);
      result.notes.push(...expansion.notes);
      pendingActions.splice(actionIndex, 1, ...expansion.actions);
      actionIndex -= 1;
      continue;
    }
    if (isDirectorSpatialAuthoringAction(item)) {
      pendingActions.splice(actionIndex, 1, ...buildDirectorSpatialAuthoringActions(project, item));
      actionIndex -= 1;
      continue;
    }
    if (isDirectorProceduralAuthoringAction(item)) {
      const preview = previewDirectorProceduralRecipe(project, item);
      project.proceduralRecipes = [...(project.proceduralRecipes ?? []), preview.recipe].slice(-128);
      pendingActions.splice(actionIndex, 1, ...preview.actions);
      actionIndex -= 1;
      continue;
    }
    if (item.action === "batch_update_objects") {
      pendingActions.splice(
        actionIndex,
        1,
        ...item.object_ids.map((objectId) => ({
          action: "update_object" as const,
          object_id: objectId,
          patch: structuredClone(item.patch),
          ...(item.force ? { force: true } : {}),
        })),
      );
      actionIndex -= 1;
      continue;
    }
    if (item.action === "reset_transforms") {
      const components = new Set(item.components);
      pendingActions.splice(
        actionIndex,
        1,
        ...item.object_ids.map((objectId) => ({
          action: "update_object" as const,
          object_id: objectId,
          patch: {
            transform: {
              ...(components.has("position")
                ? { position: [0, project.scene.groundHeight, 0] as [number, number, number] }
                : {}),
              ...(components.has("rotation") ? { rotation: [0, 0, 0] as [number, number, number] } : {}),
              ...(components.has("scale") ? { scale: [1, 1, 1] as [number, number, number] } : {}),
            },
          },
          ...(item.force ? { force: true } : {}),
        })),
      );
      actionIndex -= 1;
      continue;
    }
    if (item.action === "align_objects" || item.action === "distribute_objects") {
      const axisIndex = item.axis === "x" ? 0 : item.axis === "y" ? 1 : 2;
      const targets = item.object_ids.map((objectId) => {
        const object = requireObject(project, objectId);
        if (object.kind === "camera") throw new Error(`Use camera authoring actions for camera object "${object.id}".`);
        return object;
      });
      const coordinateById = new Map<string, number>();
      if (item.action === "align_objects") {
        const values = targets.map((object) => object.transform.position[axisIndex]);
        const coordinate =
          item.mode === "min"
            ? Math.min(...values)
            : item.mode === "max"
              ? Math.max(...values)
              : values.reduce((sum, value) => sum + value, 0) / values.length;
        targets.forEach((object) => coordinateById.set(object.id, coordinate));
      } else {
        const sorted = [...targets].sort(
          (left, right) =>
            left.transform.position[axisIndex] - right.transform.position[axisIndex] || left.id.localeCompare(right.id),
        );
        const first = sorted[0]!.transform.position[axisIndex];
        const last = sorted.at(-1)!.transform.position[axisIndex];
        const step = (last - first) / (sorted.length - 1);
        sorted.forEach((object, index) => coordinateById.set(object.id, first + step * index));
      }
      pendingActions.splice(
        actionIndex,
        1,
        ...targets.map((object) => ({
          action: "update_object" as const,
          object_id: object.id,
          patch: {
            transform: {
              position: object.transform.position.map((value, index) =>
                index === axisIndex ? coordinateById.get(object.id)! : value,
              ) as [number, number, number],
            },
          },
          ...(item.force ? { force: true } : {}),
        })),
      );
      actionIndex -= 1;
      continue;
    }
    if (item.action === "isolate_objects") {
      const selectedIds = new Set(item.object_ids);
      item.object_ids.forEach((objectId) => requireObject(project, objectId));
      pendingActions.splice(
        actionIndex,
        1,
        ...project.objects
          .filter((object) => object.kind !== "camera")
          .map((object) => ({
            action: "update_object" as const,
            object_id: object.id,
            patch: { visible: selectedIds.has(object.id) },
            ...(item.force ? { force: true } : {}),
          })),
      );
      actionIndex -= 1;
      continue;
    }
    switch (item.action) {
      case "start_scene": {
        project.objects.forEach((object) => addUnique(result.deleted.object_ids, object.id));
        project.cameras.forEach((camera) => addUnique(result.deleted.camera_ids, camera.id));
        project.production?.takes.forEach((take) => addUnique(result.deleted.performance_take_ids, take.id));
        project.production?.sequences.forEach((sequence) => {
          addUnique(result.deleted.coverage_sequence_ids, sequence.id);
          sequence.shots.forEach((shot) => addUnique(result.deleted.coverage_shot_ids, shot.id));
        });
        project.scene.annotations?.forEach((annotation) => addUnique(result.deleted.annotation_ids, annotation.id));
        project.scene.measurements?.forEach((measurement) => addUnique(result.deleted.measurement_ids, measurement.id));
        project.objects = [];
        project.cameras = [];
        project.activeCameraId = null;
        project.panoramaAssetId = null;
        delete project.storyboard;
        delete project.referenceReconstructions;
        delete project.proceduralRecipes;
        project.scene.annotations = [];
        project.scene.measurements = [];
        project.scene.objectLayers = [{ id: "default", visible: true, locked: false }];
        if (item.preserve_assets === false) {
          project.assets.forEach((asset) => addUnique(result.deleted.asset_ids, asset.id));
          project.assets = [];
        }
        rebuildProduction = true;
        break;
      }
      case "set_scene": {
        const { timeline, clippingPlanes, objectLayers, annotations, measurements, ...patch } = item.patch;
        project.scene = { ...project.scene, ...patch };
        if (timeline === null) delete project.scene.timeline;
        else if (timeline !== undefined) project.scene.timeline = timeline;
        if (clippingPlanes === null) delete project.scene.clippingPlanes;
        else if (clippingPlanes !== undefined) project.scene.clippingPlanes = structuredClone(clippingPlanes);
        if (objectLayers === null) delete project.scene.objectLayers;
        else if (objectLayers !== undefined) project.scene.objectLayers = structuredClone(objectLayers);
        if (annotations === null) delete project.scene.annotations;
        else if (annotations !== undefined) project.scene.annotations = structuredClone(annotations);
        if (measurements === null) delete project.scene.measurements;
        else if (measurements !== undefined) project.scene.measurements = structuredClone(measurements);
        break;
      }
      case "upsert_asset": {
        assertCatalogAssetIdentity(item.asset as DirectorAssetRef);
        const index = project.assets.findIndex((asset) => asset.id === item.asset.id);
        if (index < 0) {
          ensureAvailableId(project, item.asset.id, "Asset");
          project.assets.push(item.asset as DirectorAssetRef);
          addUnique(result.created.asset_ids, item.asset.id);
        } else {
          project.assets[index] = item.asset as DirectorAssetRef;
          addUnique(result.updated.asset_ids, item.asset.id);
        }
        break;
      }
      case "remove_assets": {
        const requested = new Set(item.asset_ids);
        item.asset_ids.forEach((assetId) => requireAsset(project, assetId));
        const referenced = project.objects.filter((object) => object.assetRefId && requested.has(object.assetRefId));
        const materialReferenced = project.objects.filter((object) =>
          Object.values(object.material?.textures ?? {}).some((assetId) => assetId && requested.has(assetId)),
        );
        if ((referenced.length || materialReferenced.length) && !item.cascade) {
          throw new Error(
            `Assets are used by ${[...new Set([...referenced, ...materialReferenced].map((object) => object.id))].join(", ")}. Pass cascade:true to remove primary objects and clear material texture bindings.`,
          );
        }
        if (referenced.length) {
          const deleted = deleteObjectSet(
            project,
            referenced.map((object) => object.id),
            true,
            true,
          );
          deleted.objectIds.forEach((value) => addUnique(result.deleted.object_ids, value));
          deleted.cameraIds.forEach((value) => addUnique(result.deleted.camera_ids, value));
          deleted.annotationIds.forEach((value) => addUnique(result.deleted.annotation_ids, value));
          deleted.measurementIds.forEach((value) => addUnique(result.deleted.measurement_ids, value));
        }
        if (materialReferenced.length) {
          project.objects = project.objects.map((object) => {
            if (!object.material?.textures) return object;
            const textures = Object.fromEntries(
              Object.entries(object.material.textures).filter(([, assetId]) => !assetId || !requested.has(assetId)),
            );
            return { ...object, material: { ...object.material, textures } };
          });
          materialReferenced.forEach((object) => addUnique(result.updated.object_ids, object.id));
        }
        project.assets = project.assets.filter((asset) => !requested.has(asset.id));
        if (project.panoramaAssetId && requested.has(project.panoramaAssetId)) project.panoramaAssetId = null;
        item.asset_ids.forEach((value) => addUnique(result.deleted.asset_ids, value));
        break;
      }
      case "add_object": {
        ensureAvailableId(project, item.id, "Object");
        let resolvedAssetId = item.asset_id;
        if (item.kind === "character" && !resolvedAssetId) {
          resolvedAssetId = resolveAgentCharacterAssetId(item.name);
        }
        if (
          item.kind === "character" &&
          resolvedAssetId &&
          !project.assets.some((asset) => asset.id === resolvedAssetId)
        ) {
          const catalogItem = getDirectorAgentCatalogAsset(resolvedAssetId);
          if (catalogItem?.kind === "character") {
            project.assets.push(structuredClone(catalogItem.asset) as DirectorAssetRef);
            addUnique(result.created.asset_ids, catalogItem.id);
          }
        }
        if (resolvedAssetId) requireCompatibleAsset(project, resolvedAssetId, item.kind);
        validateMaterialTextureReferences(project, item.material);
        assertCharacterIdentityIntent({
          kind: item.kind,
          name: item.name,
          assetId: resolvedAssetId,
          characterSource: item.kind === "character" ? "asset" : undefined,
        });
        if (item.parent_id) requireObject(project, item.parent_id);
        const posePreset = getMannequinPosePreset(item.pose_preset_id ?? "stand");
        const transform = item.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        const object: DirectorObject = {
          id: item.id,
          name: item.name,
          kind: item.kind,
          visible: true,
          locked: item.locked ?? false,
          ...(item.layer ? { layer: item.layer } : {}),
          ...(item.pivot ? { pivot: [...item.pivot] as [number, number, number] } : {}),
          transform,
          ...(item.body_type ? { bodyType: item.body_type } : {}),
          ...(item.kind === "character" ? { characterSource: "asset" as const } : {}),
          ...(item.color ? { color: item.color } : {}),
          ...(item.material ? { material: structuredClone(item.material) } : {}),
          ...(resolvedAssetId ? { assetRefId: resolvedAssetId } : {}),
          ...(item.geometry_type ? { geometryType: item.geometry_type } : {}),
          ...(item.placement_mode ? { placementMode: item.placement_mode } : {}),
          ...(item.parent_id ? { parentObjectId: item.parent_id } : {}),
          ...(item.look_target_object_id ? { lookTargetObjectId: item.look_target_object_id } : {}),
          ...(item.reference_bindings ? { referenceBindings: structuredClone(item.reference_bindings) } : {}),
          ...(item.interaction
            ? {
                interaction: {
                  kind: "toggle-transform" as const,
                  prompt: item.interaction.prompt ?? item.name,
                  radiusM: item.interaction.radius_m,
                  closedTransform: structuredClone(item.interaction.closed_transform ?? transform),
                  openTransform: structuredClone(item.interaction.open_transform),
                },
              }
            : {}),
          ...(item.kind === "character"
            ? {
                bodyType: item.body_type ?? "mannequin",
                color: item.color ?? "#d19a3a",
                characterRig: {
                  rigType: "mixamo",
                  posePresetId: item.pose_preset_id ?? "stand",
                  controls: { ...(posePreset?.controls ?? {}) },
                },
              }
            : {}),
        };
        project.objects.push(object);
        if (item.layer && !project.scene.objectLayers?.some((layer) => layer.id === item.layer)) {
          project.scene.objectLayers = [
            ...(project.scene.objectLayers ?? [{ id: "default", visible: true, locked: false }]),
            { id: item.layer, visible: true, locked: false },
          ];
          addUnique(result.created.layer_ids, item.layer);
        }
        addUnique(result.created.object_ids, object.id);
        break;
      }
      case "update_object": {
        const object = requireObject(project, item.object_id);
        if (object.kind === "camera") throw new Error(`Use update_camera for camera object "${object.id}".`);
        const patch = item.patch;
        const patchKeys = Object.keys(patch);
        if (object.nativeSource?.engine === "blender" && object.nativeSource.provisioned !== false) {
          const nativePatchFields: readonly string[] = DIRECTOR_NATIVE_STAGE_PATCH_FIELDS;
          const unsupported = patchKeys.filter((key) => !nativePatchFields.includes(key));
          if (unsupported.length) {
            throw new Error(
              `Native Blender object "${object.id}" cannot apply ${unsupported.join(", ")} through director_workbench; use blender_native for material, geometry, parenting, and asset edits.`,
            );
          }
        }
        const unlockOnly = patchKeys.length === 1 && patch.locked === false;
        if (isAuthoringObjectLocked(project, object) && !item.force && !unlockOnly) {
          throw new Error(
            `Object "${object.id}" is locked. Unlock it first or pass force:true for an explicit override.`,
          );
        }
        if (patch.asset_id) requireCompatibleAsset(project, patch.asset_id, object.kind);
        if (patch.material) validateMaterialTextureReferences(project, patch.material);
        if (patch.character_source !== undefined && object.kind !== "character") {
          throw new Error("character_source is only valid for character objects.");
        }
        if (patch.crowd_label !== undefined && (object.kind !== "character" || !object.crowdId)) {
          throw new Error(
            `crowd_label is only valid for crowd characters; object "${object.id}" is not a crowd member. Rename standalone objects with the name patch instead.`,
          );
        }
        const nextAssetId = patch.asset_id === undefined ? object.assetRefId : (patch.asset_id ?? undefined);
        const nextCharacterSource = object.kind === "character" ? ("asset" as const) : undefined;
        if (object.kind === "character" && patch.asset_id === null) {
          throw new Error(`Character asset_id cannot be cleared; bind another catalog or local character asset.`);
        }
        if (patch.name !== undefined || patch.asset_id !== undefined || patch.character_source !== undefined) {
          assertCharacterIdentityIntent({
            kind: object.kind,
            name: patch.name ?? object.name,
            assetId: nextAssetId,
            characterSource: nextCharacterSource,
          });
        }
        if (patch.parent_id) {
          requireObject(project, patch.parent_id);
          assertAcyclicParent(project, object.id, patch.parent_id);
        }
        if (patch.look_target_object_id) {
          requireObject(project, patch.look_target_object_id);
          if (patch.look_target_object_id === object.id) throw new Error("An object cannot look at itself.");
        }
        if (patch.name !== undefined) object.name = patch.name;
        assignOptional(object, "crowdLabel", patch.crowd_label);
        if (patch.visible !== undefined) object.visible = patch.visible;
        if (patch.locked !== undefined) object.locked = patch.locked;
        assignOptional(object, "layer", patch.layer);
        assignOptional(object, "pivot", patch.pivot ? [...patch.pivot] : patch.pivot);
        if (patch.layer && !project.scene.objectLayers?.some((layer) => layer.id === patch.layer)) {
          project.scene.objectLayers = [
            ...(project.scene.objectLayers ?? [{ id: "default", visible: true, locked: false }]),
            { id: patch.layer, visible: true, locked: false },
          ];
          addUnique(result.created.layer_ids, patch.layer);
        }
        if (patch.transform) object.transform = mergeTransform(object.transform, patch.transform);
        assignOptional(object, "bodyType", patch.body_type);
        assignOptional(object, "characterSource", patch.character_source);
        assignOptional(object, "color", patch.color);
        assignOptional(object, "material", patch.material ? structuredClone(patch.material) : patch.material);
        assignOptional(object, "assetRefId", patch.asset_id);
        if (object.kind === "character" && patch.asset_id) object.characterSource = "asset";
        assignOptional(object, "geometryType", patch.geometry_type);
        assignOptional(object, "placementMode", patch.placement_mode);
        assignOptional(object, "parentObjectId", patch.parent_id);
        assignOptional(object, "lookTargetObjectId", patch.look_target_object_id);
        assignOptional(
          object,
          "referenceBindings",
          patch.reference_bindings ? structuredClone(patch.reference_bindings) : patch.reference_bindings,
        );
        if (patch.pose_preset_id !== undefined) {
          if (object.kind !== "character") throw new Error(`Only characters can have a pose preset.`);
          object.characterRig = object.characterRig ?? {
            rigType: "mixamo",
            posePresetId: "stand",
            controls: {},
          };
          object.characterRig.posePresetId = patch.pose_preset_id;
          object.characterRig.controls = {
            ...(getMannequinPosePreset(patch.pose_preset_id)?.controls ?? {}),
          };
        }
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "set_object_interaction": {
        const object = requireObject(project, item.object_id);
        if (object.kind === "camera") throw new Error("Camera rigs cannot be proximity interactables.");
        if (isAuthoringObjectLocked(project, object) && !item.force) {
          throw new Error(`Object "${object.id}" is locked. Pass force:true to update its interaction.`);
        }
        object.interaction = {
          kind: "toggle-transform",
          prompt: item.interaction.prompt ?? object.name,
          radiusM: item.interaction.radius_m,
          closedTransform: structuredClone(item.interaction.closed_transform ?? object.transform),
          openTransform: structuredClone(item.interaction.open_transform),
        };
        if (object.animation?.enabled) object.animation = { ...object.animation, enabled: false };
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "clear_object_interaction": {
        const object = requireObject(project, item.object_id);
        if (isAuthoringObjectLocked(project, object) && !item.force) {
          throw new Error(`Object "${object.id}" is locked. Pass force:true to clear its interaction.`);
        }
        delete object.interaction;
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "show_all_objects": {
        project.objects.forEach((object) => {
          if (object.kind === "camera" || object.visible) return;
          object.visible = true;
          addUnique(result.updated.object_ids, object.id);
        });
        project.scene.objectLayers = project.scene.objectLayers?.map((layer) => {
          if (layer.visible) return layer;
          addUnique(result.updated.layer_ids, layer.id);
          return { ...layer, visible: true };
        });
        break;
      }
      case "set_object_pivot": {
        const object = requireObject(project, item.object_id);
        if (object.kind === "camera") throw new Error("Camera rigs do not use object pivots.");
        if (isAuthoringObjectLocked(project, object) && !item.force) {
          throw new Error(`Object "${object.id}" is locked. Pass force:true to update its pivot.`);
        }
        assignOptional(object, "pivot", item.pivot ? ([...item.pivot] as [number, number, number]) : item.pivot);
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "group_objects": {
        ensureAvailableId(project, item.group_id, "Group");
        const requested = [...new Set(item.object_ids)];
        const children = requested.map((objectId) => requireObject(project, objectId));
        if (children.some((object) => object.kind === "camera" || object.isCompositeParent)) {
          throw new Error("Groups can contain modeled objects, not cameras or another composite parent.");
        }
        if (children.some((object) => isAuthoringObjectLocked(project, object))) {
          throw new Error("Locked objects or objects on locked layers cannot be grouped.");
        }
        const position = children.reduce<[number, number, number]>(
          (sum, object) => [
            sum[0] + object.transform.position[0],
            sum[1] + object.transform.position[1],
            sum[2] + object.transform.position[2],
          ],
          [0, 0, 0],
        );
        const count = children.length;
        const parent: DirectorObject = {
          id: item.group_id,
          name: item.name,
          kind: "prop",
          visible: true,
          locked: false,
          isCompositeParent: true,
          ...(children.every((object) => object.layer === children[0]?.layer) && children[0]?.layer
            ? { layer: children[0].layer }
            : {}),
          transform: {
            position: [position[0] / count, position[1] / count, position[2] / count],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          },
        };
        children.forEach((object) => {
          object.parentObjectId = parent.id;
          addUnique(result.updated.object_ids, object.id);
        });
        project.objects.push(parent);
        addUnique(result.created.object_ids, parent.id);
        break;
      }
      case "ungroup_objects": {
        const group = requireObject(project, item.group_id);
        if (!group.isCompositeParent) throw new Error(`Object "${group.id}" is not a composite group.`);
        const children = project.objects.filter((object) => object.parentObjectId === group.id);
        if (
          (isAuthoringObjectLocked(project, group) ||
            children.some((object) => isAuthoringObjectLocked(project, object))) &&
          !item.force
        ) {
          throw new Error(`Group "${group.id}" or one of its children is locked. Pass force:true to ungroup.`);
        }
        children.forEach((object) => {
          delete object.parentObjectId;
          addUnique(result.updated.object_ids, object.id);
        });
        if (item.delete_group) {
          project.objects = project.objects.filter((object) => object.id !== group.id);
          addUnique(result.deleted.object_ids, group.id);
        } else {
          addUnique(result.updated.object_ids, group.id);
        }
        break;
      }
      case "add_annotation": {
        ensureAvailableId(project, item.annotation.id, "Annotation");
        if (item.annotation.anchor.objectId) requireObject(project, item.annotation.anchor.objectId);
        project.scene.annotations = [
          ...(project.scene.annotations ?? []),
          structuredClone(item.annotation) as DirectorSceneAnnotation,
        ];
        addUnique(result.created.annotation_ids, item.annotation.id);
        break;
      }
      case "update_annotation": {
        const annotation = project.scene.annotations?.find((entry) => entry.id === item.annotation_id);
        if (!annotation) throw new Error(`No annotation with id "${item.annotation_id}" exists.`);
        if (item.patch.anchor?.objectId) requireObject(project, item.patch.anchor.objectId);
        Object.assign(annotation, structuredClone(item.patch));
        addUnique(result.updated.annotation_ids, annotation.id);
        break;
      }
      case "remove_annotations": {
        const annotations = project.scene.annotations ?? [];
        const existing = new Set(annotations.map((annotation) => annotation.id));
        item.annotation_ids.forEach((annotationId) => {
          if (!existing.has(annotationId)) throw new Error(`No annotation with id "${annotationId}" exists.`);
        });
        const requested = new Set(item.annotation_ids);
        project.scene.annotations = annotations.filter((annotation) => !requested.has(annotation.id));
        item.annotation_ids.forEach((annotationId) => addUnique(result.deleted.annotation_ids, annotationId));
        break;
      }
      case "add_measurement": {
        ensureAvailableId(project, item.measurement.id, "Measurement");
        if (item.measurement.start.objectId) requireObject(project, item.measurement.start.objectId);
        if (item.measurement.end.objectId) requireObject(project, item.measurement.end.objectId);
        project.scene.measurements = [
          ...(project.scene.measurements ?? []),
          structuredClone(item.measurement) as DirectorSceneMeasurement,
        ];
        addUnique(result.created.measurement_ids, item.measurement.id);
        break;
      }
      case "update_measurement": {
        const measurement = project.scene.measurements?.find((entry) => entry.id === item.measurement_id);
        if (!measurement) throw new Error(`No measurement with id "${item.measurement_id}" exists.`);
        if (item.patch.start?.objectId) requireObject(project, item.patch.start.objectId);
        if (item.patch.end?.objectId) requireObject(project, item.patch.end.objectId);
        Object.assign(measurement, structuredClone(item.patch));
        addUnique(result.updated.measurement_ids, measurement.id);
        break;
      }
      case "remove_measurements": {
        const measurements = project.scene.measurements ?? [];
        const existing = new Set(measurements.map((measurement) => measurement.id));
        item.measurement_ids.forEach((measurementId) => {
          if (!existing.has(measurementId)) throw new Error(`No measurement with id "${measurementId}" exists.`);
        });
        const requested = new Set(item.measurement_ids);
        project.scene.measurements = measurements.filter((measurement) => !requested.has(measurement.id));
        item.measurement_ids.forEach((measurementId) => addUnique(result.deleted.measurement_ids, measurementId));
        break;
      }
      case "set_object_layer_state": {
        if (item.visible === undefined && item.locked === undefined) {
          throw new Error("set_object_layer_state requires visible or locked.");
        }
        const layers = project.scene.objectLayers ?? [];
        const existing = layers.find((layer) => layer.id === item.layer_id);
        const next: DirectorObjectLayer = {
          id: item.layer_id,
          visible: item.visible ?? existing?.visible ?? true,
          locked: item.locked ?? existing?.locked ?? false,
        };
        project.scene.objectLayers = existing
          ? layers.map((layer) => (layer.id === item.layer_id ? next : layer))
          : [...layers, next];
        addUnique(existing ? result.updated.layer_ids : result.created.layer_ids, item.layer_id);
        break;
      }
      case "reorder_object_layer": {
        const layers = [...(project.scene.objectLayers ?? [])];
        const index = layers.findIndex((layer) => layer.id === item.layer_id);
        if (index < 0) throw new Error(`No object layer with id "${item.layer_id}" exists.`);
        const [layer] = layers.splice(index, 1);
        if (item.before_layer_id === null) layers.push(layer!);
        else {
          const beforeIndex = layers.findIndex((candidate) => candidate.id === item.before_layer_id);
          if (beforeIndex < 0) throw new Error(`No object layer with id "${item.before_layer_id}" exists.`);
          layers.splice(beforeIndex, 0, layer!);
        }
        project.scene.objectLayers = layers;
        addUnique(result.updated.layer_ids, item.layer_id);
        break;
      }
      case "focus_objects": {
        item.object_ids.forEach((objectId) => requireObject(project, objectId));
        break;
      }
      case "set_character_pose_controls": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "pose controls");
        const rig = object.characterRig ?? {
          rigType: "mixamo" as const,
          posePresetId: "stand",
          controls: {},
        };
        const controls = item.mode === "replace" ? {} : { ...resolveCharacterPoseControls(rig) };
        item.controls.forEach((entry) => {
          controls[entry.control] = entry.value;
        });
        object.characterRig = {
          ...rig,
          posePresetId: null,
          controls,
        };
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "clear_character_pose_controls": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "pose controls");
        if (!object.characterRig) break;
        object.characterRig = {
          ...object.characterRig,
          posePresetId: null,
          controls: {},
        };
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "set_character_motion": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "skeletal motion clips");
        const catalogItem = getDirectorCharacterMotion(item.clip_id);
        if (!catalogItem) throw new Error(`Unknown packaged character motion "${item.clip_id}".`);
        const rig = object.characterRig ?? {
          rigType: "mixamo" as const,
          posePresetId: "stand",
          controls: {},
        };
        object.characterRig = {
          ...rig,
          posePresetId: null,
          motion: {
            clipId: catalogItem.id,
            enabled: item.enabled ?? true,
            loop: item.loop ?? catalogItem.defaultLoop,
            speed: item.speed ?? 1,
            weight: item.weight ?? 1,
            startFrame: item.start_frame ?? project.scene.timeline?.currentFrame ?? 0,
            blendInS: item.blend_in_s ?? 0.12,
            blendOutS: item.blend_out_s ?? (catalogItem.defaultLoop === "once" ? 0.15 : 0),
            rootMotion: item.root_motion ?? catalogItem.recommendedRootMotion,
          },
        };
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "clear_character_motion": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "skeletal motion clips");
        if (!object.characterRig?.motion) break;
        object.characterRig = { ...object.characterRig, motion: undefined };
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "set_character_ik": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "IK effectors");
        object.characterRig = object.characterRig ?? {
          rigType: "mixamo",
          posePresetId: "stand",
          controls: {},
        };
        object.characterRig.ik = {
          ...object.characterRig.ik,
          [item.effector]: {
            target: [...item.target],
            pole: [...item.pole],
            weight: item.weight ?? 1,
            reachClamp: item.reach_clamp ?? 1,
          },
        };
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "clear_character_ik": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "IK effectors");
        if (!object.characterRig?.ik) break;
        if (!item.effector) {
          delete object.characterRig.ik;
        } else {
          delete object.characterRig.ik[item.effector];
          if (!Object.keys(object.characterRig.ik).length) delete object.characterRig.ik;
        }
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "bind_character_agent": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "an agent binding");
        const previous = object.agentBinding;
        // Last write wins: one character carries at most one binding, and a
        // rebind replaces it atomically under the normal revision guard.
        object.agentBinding = {
          mode: "possess",
          ...(item.session_id ? { sessionId: item.session_id } : {}),
          ...(item.profile_id ? { profileId: item.profile_id } : {}),
          ...(item.role_id ? { roleId: item.role_id } : {}),
        };
        if (previous) {
          result.notes.push(
            `Character "${object.id}" was rebound from ${previous.sessionId ?? previous.profileId ?? "unknown"} to ${
              item.session_id ?? item.profile_id
            }.`,
          );
        }
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "unbind_character_agent": {
        const object = requireEditableCharacter(project, item.object_id, item.force, "an agent binding");
        if (!object.agentBinding) {
          result.notes.push(`Character "${object.id}" had no agent binding; unbind_character_agent left it unchanged.`);
          break;
        }
        delete object.agentBinding;
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "delete_objects": {
        const deleted = deleteObjectSet(project, item.object_ids, Boolean(item.cascade), Boolean(item.force));
        deleted.objectIds.forEach((value) => addUnique(result.deleted.object_ids, value));
        deleted.cameraIds.forEach((value) => addUnique(result.deleted.camera_ids, value));
        deleted.annotationIds.forEach((value) => addUnique(result.deleted.annotation_ids, value));
        deleted.measurementIds.forEach((value) => addUnique(result.deleted.measurement_ids, value));
        break;
      }
      case "duplicate_objects": {
        const duplicated = duplicateObjectSet(
          project,
          item.object_ids,
          item.offset_m ?? DIRECTOR_DUPLICATE_POSITION_OFFSET_M,
        );
        duplicated.objectIds.forEach((value) => addUnique(result.created.object_ids, value));
        duplicated.cameraIds.forEach((value) => addUnique(result.created.camera_ids, value));
        break;
      }
      case "add_timeline_audio_clip": {
        const { timeline, tracks } = ensureTimelineAudioTracks(project);
        let trackIndex = item.track_id
          ? tracks.findIndex((track) => track.id === item.track_id)
          : tracks.findIndex((track) => track.clips.length < MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK);
        if (item.track_id && trackIndex < 0) {
          throw new Error(`Timeline audio track "${item.track_id}" was not found.`);
        }
        if (trackIndex >= 0 && tracks[trackIndex]!.clips.length >= MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK) {
          throw new Error(
            `Timeline audio track "${tracks[trackIndex]!.id}" already holds ${MAX_TIMELINE_AUDIO_CLIPS_PER_TRACK} clips.`,
          );
        }
        if (trackIndex < 0) {
          if (tracks.length >= MAX_TIMELINE_AUDIO_TRACKS) {
            throw new Error(`Projects support at most ${MAX_TIMELINE_AUDIO_TRACKS} timeline audio tracks.`);
          }
          const trackId = getNextSequentialId(
            tracks.map((track) => track.id),
            "audio_track_",
          );
          tracks.push({
            id: trackId,
            name: `音频轨 ${tracks.length + 1}`,
            muted: false,
            clips: [],
          });
          trackIndex = tracks.length - 1;
          addUnique(result.created.timeline_audio_track_ids, trackId);
        }
        const clipId =
          item.id ??
          getNextSequentialId(
            tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
            "audio_clip_",
          );
        if (tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) {
          throw new Error(`Timeline audio clip "${clipId}" already exists.`);
        }
        const startFrame = Math.max(
          0,
          Math.min(
            1_000_000,
            Math.round(
              item.start_frame !== undefined && Number.isFinite(item.start_frame)
                ? item.start_frame
                : Math.max(timeline.currentFrame, 0),
            ),
          ),
        );
        const clip: DirectorTimelineAudioClip = {
          id: clipId,
          name: item.name,
          mediaId: item.media_id,
          ...(item.source_url ? { sourceUrl: item.source_url } : {}),
          startFrame,
          durationFrames: item.duration_frames,
          inSec: 0,
          ...(item.source_duration_sec !== undefined ? { sourceDurationSec: item.source_duration_sec } : {}),
          volume: 1,
          fadeInSec: 0,
          fadeOutSec: 0,
          muted: false,
        };
        tracks[trackIndex] = {
          ...tracks[trackIndex]!,
          clips: [...tracks[trackIndex]!.clips, clip],
        };
        timeline.audioTracks = tracks;
        addUnique(result.created.timeline_audio_clip_ids, clipId);
        break;
      }
      case "update_timeline_audio_clip": {
        const { timeline, tracks } = ensureTimelineAudioTracks(project);
        const found = requireTimelineAudioClip(tracks, item.clip_id);
        const patch = item.patch;
        const next: DirectorTimelineAudioClip = { ...found.clip };
        if (patch.name !== undefined) next.name = patch.name;
        if (patch.sourceUrl !== undefined) next.sourceUrl = patch.sourceUrl;
        if (patch.startFrame !== undefined) next.startFrame = patch.startFrame;
        if (patch.durationFrames !== undefined) next.durationFrames = patch.durationFrames;
        if (patch.inSec !== undefined) next.inSec = patch.inSec;
        if (patch.sourceDurationSec !== undefined) next.sourceDurationSec = patch.sourceDurationSec;
        if (patch.volume !== undefined) next.volume = patch.volume;
        if (patch.fadeInSec !== undefined) next.fadeInSec = patch.fadeInSec;
        if (patch.fadeOutSec !== undefined) next.fadeOutSec = patch.fadeOutSec;
        if (patch.muted !== undefined) next.muted = patch.muted;
        const nextClips = [...found.track.clips];
        nextClips[found.clipIndex] = next;
        tracks[found.trackIndex] = { ...found.track, clips: nextClips };
        timeline.audioTracks = tracks;
        addUnique(result.updated.timeline_audio_clip_ids, item.clip_id);
        break;
      }
      case "remove_timeline_audio_clips": {
        const { timeline, tracks } = ensureTimelineAudioTracks(project);
        for (const clipId of item.clip_ids) requireTimelineAudioClip(tracks, clipId);
        const requested = new Set(item.clip_ids);
        timeline.audioTracks = tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => !requested.has(clip.id)),
        }));
        item.clip_ids.forEach((clipId) => addUnique(result.deleted.timeline_audio_clip_ids, clipId));
        break;
      }
      case "set_timeline_audio_track_muted": {
        const { timeline, tracks } = ensureTimelineAudioTracks(project);
        const trackIndex = tracks.findIndex((track) => track.id === item.track_id);
        if (trackIndex < 0) throw new Error(`Timeline audio track "${item.track_id}" was not found.`);
        if (tracks[trackIndex]!.muted === item.muted) break;
        tracks[trackIndex] = { ...tracks[trackIndex]!, muted: item.muted };
        timeline.audioTracks = tracks;
        addUnique(result.updated.timeline_audio_track_ids, item.track_id);
        break;
      }
      case "add_light": {
        ensureAvailableId(project, item.light.id, "Light");
        project.lights ??= [];
        const light = structuredClone(item.light) as DirectorLight;
        if (project.nativeScene && hasBlenderLightRepresentation(light.type)) {
          light.nativeSource = { engine: "blender", objectId: light.id, provisioned: false };
        }
        project.lights.push(light);
        addUnique(result.created.light_ids, item.light.id);
        break;
      }
      case "update_light": {
        const light = requireLight(project, item.light_id);
        const patchKeys = Object.keys(item.patch);
        const unlockOnly = patchKeys.length === 1 && item.patch.locked === false;
        if (light.locked && !item.force && !unlockOnly) {
          throw new Error(
            `Light "${light.id}" is locked. Unlock it first or pass force:true for an explicit override.`,
          );
        }
        Object.assign(light, structuredClone(item.patch));
        if (!hasBlenderLightRepresentation(light.type)) {
          delete light.nativeSource;
        } else if (project.nativeScene && !light.nativeSource) {
          light.nativeSource = { engine: "blender", objectId: light.id, provisioned: false };
        }
        addUnique(result.updated.light_ids, light.id);
        break;
      }
      case "delete_lights": {
        const lights = item.light_ids.map((lightId) => requireLight(project, lightId));
        const locked = lights.filter((light) => light.locked);
        if (locked.length && !item.force) {
          throw new Error(
            `Light(s) ${locked.map((light) => light.id).join(", ")} are locked. Unlock them first or pass force:true.`,
          );
        }
        const requested = new Set(item.light_ids);
        project.lights = (project.lights ?? []).filter((light) => !requested.has(light.id));
        item.light_ids.forEach((lightId) => addUnique(result.deleted.light_ids, lightId));
        break;
      }
      case "add_camera": {
        const cameraObjectId = item.object_id ?? `${item.id}-rig`;
        ensureAvailableId(project, item.id, "Camera");
        ensureAvailableId(project, cameraObjectId, "Camera object");
        if (item.target_object_id) requireObject(project, item.target_object_id);
        const aspectRatio = item.aspect_ratio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
        const sensorFormat = item.sensor_format ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
        const focalLengthMm = item.focal_length_mm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM;
        const requestedNearClipM = item.near_clip_m ?? DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M;
        const requestedFarClipM = item.far_clip_m ?? DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M;
        if (requestedFarClipM <= requestedNearClipM) {
          throw new Error("Camera far_clip_m must be greater than near_clip_m.");
        }
        const optics = normalizeDirectorCameraOptics({
          apertureFStop: item.aperture_f_stop ?? DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
          focusDistanceM: item.focus_distance_m ?? DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
          shutterAngle: item.shutter_angle ?? DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
          iso: item.iso ?? DEFAULT_DIRECTOR_CAMERA_ISO,
          nearClipM: requestedNearClipM,
          farClipM: requestedFarClipM,
          anamorphicSqueeze: item.anamorphic_squeeze ?? DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
        });
        const viewSnapshot = {
          fov: getVerticalFovFromFocalLength(focalLengthMm, aspectRatio, sensorFormat),
          position: [...item.position] as [number, number, number],
          target: [...item.target] as [number, number, number],
        };
        const transform: DirectorTransform = {
          position: getCameraRigPositionFromViewSnapshot(viewSnapshot),
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        };
        const camera: DirectorCameraShot = {
          id: item.id,
          name: item.name,
          fov: viewSnapshot.fov,
          focalLengthMm,
          sensorFormat,
          ...optics,
          aspectRatio,
          handheldShake: item.handheld_shake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
          action: normalizeCameraActionInput(item.action_mode ?? DEFAULT_DIRECTOR_CAMERA_ACTION),
          transform,
          targetMode: item.target_object_id ? "object" : "manual",
          targetObjectId: item.target_object_id ?? null,
          target: [...item.target],
          lastCaptureUrl: null,
          captures: [],
          ...(project.nativeScene
            ? { nativeSource: { engine: "blender" as const, objectId: item.id, provisioned: false as const } }
            : {}),
        };
        project.cameras.push(camera);
        project.objects.push({
          id: cameraObjectId,
          name: item.name,
          kind: "camera",
          visible: true,
          locked: false,
          linkedCameraId: camera.id,
          transform: structuredClone(transform),
        });
        if (item.activate !== false || !project.activeCameraId) project.activeCameraId = camera.id;
        addUnique(result.created.camera_ids, camera.id);
        addUnique(result.created.object_ids, cameraObjectId);
        break;
      }
      case "update_camera": {
        const camera = requireCamera(project, item.camera_id);
        const rig = cameraRigObject(project, camera.id);
        if (!rig && camera.nativeSource?.engine !== "blender") {
          throw new Error(`Camera "${camera.id}" has no linked workbench object.`);
        }
        const patch = item.patch;
        if (patch.target_object_id) requireObject(project, patch.target_object_id);
        const nextNearClipM = patch.near_clip_m ?? camera.nearClipM ?? DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M;
        const nextFarClipM = patch.far_clip_m ?? camera.farClipM ?? DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M;
        if (nextFarClipM <= nextNearClipM) {
          throw new Error("Camera far_clip_m must be greater than near_clip_m.");
        }
        if (patch.name !== undefined) {
          camera.name = patch.name;
          if (rig) rig.name = patch.name;
        }
        if (patch.position !== undefined || patch.target !== undefined) {
          const currentView = getCameraViewSnapshotFromShot(camera);
          const nextTarget: [number, number, number] = patch.target ? [...patch.target] : [...camera.target];
          const nextViewPosition: [number, number, number] = patch.position
            ? [...patch.position]
            : currentView.position;
          camera.target = nextTarget;
          const rigPosition = getCameraRigPositionFromViewSnapshot({
            fov: camera.fov,
            position: nextViewPosition,
            target: nextTarget,
          });
          camera.transform.position = rigPosition;
          if (rig) rig.transform.position = rigPosition;
        }
        if (patch.target_object_id !== undefined) {
          camera.targetObjectId = patch.target_object_id;
          camera.targetMode = patch.target_object_id ? "object" : "manual";
        }
        if (patch.aspect_ratio !== undefined) camera.aspectRatio = patch.aspect_ratio;
        if (patch.sensor_format !== undefined) camera.sensorFormat = patch.sensor_format;
        if (patch.focal_length_mm !== undefined) camera.focalLengthMm = patch.focal_length_mm;
        if (patch.aperture_f_stop !== undefined) camera.apertureFStop = patch.aperture_f_stop;
        if (patch.focus_distance_m !== undefined) camera.focusDistanceM = patch.focus_distance_m;
        if (patch.shutter_angle !== undefined) camera.shutterAngle = patch.shutter_angle;
        if (patch.iso !== undefined) camera.iso = patch.iso;
        if (patch.near_clip_m !== undefined) camera.nearClipM = patch.near_clip_m;
        if (patch.far_clip_m !== undefined) camera.farClipM = patch.far_clip_m;
        if (patch.anamorphic_squeeze !== undefined) camera.anamorphicSqueeze = patch.anamorphic_squeeze;
        if (patch.handheld_shake !== undefined) camera.handheldShake = patch.handheld_shake;
        if (patch.action !== undefined) {
          camera.action =
            patch.action === null ? DEFAULT_DIRECTOR_CAMERA_ACTION : normalizeCameraActionInput(patch.action);
        }
        const focalLengthMm = camera.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM;
        camera.fov = getVerticalFovFromFocalLength(
          focalLengthMm,
          camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
          camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
        );
        addUnique(result.updated.camera_ids, camera.id);
        if (rig) addUnique(result.updated.object_ids, rig.id);
        break;
      }
      case "delete_cameras": {
        const cameras = item.camera_ids.map((cameraId) => requireCamera(project, cameraId));
        const requested = new Set(item.camera_ids);
        const rigIds = project.objects
          .filter((object) => object.linkedCameraId && requested.has(object.linkedCameraId))
          .map((object) => object.id);
        project.cameras = project.cameras.filter((camera) => !requested.has(camera.id));
        project.objects = project.objects.filter(
          (object) => !object.linkedCameraId || !requested.has(object.linkedCameraId),
        );
        project.storyboard = project.storyboard
          ? {
              ...project.storyboard,
              shots: project.storyboard.shots.map((shot) =>
                shot.cameraId && requested.has(shot.cameraId) ? { ...shot, cameraId: null } : shot,
              ),
            }
          : undefined;
        if (project.activeCameraId && requested.has(project.activeCameraId))
          project.activeCameraId = project.cameras[0]?.id ?? null;
        item.camera_ids.forEach((value) => addUnique(result.deleted.camera_ids, value));
        rigIds.forEach((value) => addUnique(result.deleted.object_ids, value));
        break;
      }
      case "set_animation": {
        if (item.target_type === "object") {
          const object = requireObject(project, item.target_id);
          if (item.animation === null) delete object.animation;
          else object.animation = item.animation as DirectorEntityAnimation;
          addUnique(result.updated.object_ids, object.id);
        } else {
          const camera = requireCamera(project, item.target_id);
          if (item.animation === null) delete camera.animation;
          else camera.animation = item.animation as DirectorEntityAnimation;
          addUnique(result.updated.camera_ids, camera.id);
        }
        break;
      }
      case "apply_animation_recipe": {
        const timeline = project.scene.timeline;
        if (!timeline) throw new Error("The project has no frame timeline for animation recipes.");
        if (
          item.frame_start < timeline.frameStart ||
          item.frame_end > timeline.frameEnd ||
          item.frame_start >= item.frame_end
        ) {
          throw new Error(
            `Animation recipe frames must satisfy ${timeline.frameStart} <= frame_start < frame_end <= ${timeline.frameEnd}.`,
          );
        }
        if (item.target_type === "object") {
          const object = requireObject(project, item.target_id);
          if (object.kind === "camera") {
            throw new Error(`Use target_type "camera" for camera object "${object.id}".`);
          }
          if (object.locked && !item.force)
            throw new Error(`Object "${object.id}" is locked; set force=true to animate it.`);
          object.animation = compileDirectorAnimationRecipe({
            baseTransform: object.transform,
            frameStart: item.frame_start,
            frameEnd: item.frame_end,
            recipe: item.recipe,
            existingAnimation: object.animation,
            motion: item.motion,
            source: "assistant",
            color: object.animation?.color ?? object.color,
          });
          addUnique(result.updated.object_ids, object.id);
        } else {
          const camera = requireCamera(project, item.target_id);
          camera.animation = compileDirectorAnimationRecipe({
            baseTransform: camera.transform,
            frameStart: item.frame_start,
            frameEnd: item.frame_end,
            recipe: item.recipe,
            existingAnimation: camera.animation,
            cameraTarget: camera.target,
            cameraFov: camera.fov,
            source: "assistant",
            color: camera.animation?.color,
          });
          addUnique(result.updated.camera_ids, camera.id);
        }
        break;
      }
      case "set_storyboard":
        if (item.storyboard === null) delete project.storyboard;
        else project.storyboard = item.storyboard as DirectorStoryboard;
        break;
      case "set_active_camera":
        if (item.camera_id) requireCamera(project, item.camera_id);
        project.activeCameraId = item.camera_id;
        break;
      case "add_performance_take": {
        const production = ensureProduction(project);
        ensureAvailableId(project, item.take.id, "Performance take");
        item.take.entityTracks.forEach((track) => ensureAvailableId(project, track.id, "Entity track"));
        const take = structuredClone(item.take) as DirectorPerformanceTake;
        validatePerformanceTakeReferences(project, take);
        production.takes.push(take);
        if (item.activate !== false || !production.activeTakeId) production.activeTakeId = take.id;
        addUnique(result.created.performance_take_ids, take.id);
        break;
      }
      case "update_performance_take": {
        const production = ensureProduction(project);
        const take = requirePerformanceTake(project, item.take_id);
        const updated = { ...take, ...structuredClone(item.patch) } as DirectorPerformanceTake;
        validatePerformanceTakeReferences(project, updated);
        Object.assign(take, updated);
        if (item.activate === true) production.activeTakeId = take.id;
        addUnique(result.updated.performance_take_ids, take.id);
        break;
      }
      case "delete_performance_takes": {
        const production = ensureProduction(project);
        item.take_ids.forEach((takeId) => requirePerformanceTake(project, takeId));
        const requested = new Set(item.take_ids);
        const referencedShots = production.sequences.flatMap((sequence) =>
          sequence.shots.filter((shot) => requested.has(shot.takeId)),
        );
        if (referencedShots.length && !item.cascade) {
          throw new Error(
            `Performance takes are used by coverage shots ${referencedShots.map((shot) => shot.id).join(", ")}. Pass cascade:true to delete those shots too.`,
          );
        }
        if (referencedShots.length) {
          production.sequences.forEach((sequence) => {
            sequence.shots = sequence.shots.filter((shot) => !requested.has(shot.takeId));
          });
          referencedShots.forEach((shot) => addUnique(result.deleted.coverage_shot_ids, shot.id));
        }
        production.takes = production.takes.filter((take) => !requested.has(take.id));
        if (production.activeTakeId && requested.has(production.activeTakeId)) {
          production.activeTakeId = production.takes[0]?.id ?? null;
        }
        item.take_ids.forEach((takeId) => addUnique(result.deleted.performance_take_ids, takeId));
        break;
      }
      case "add_coverage_sequence": {
        const production = ensureProduction(project);
        ensureAvailableId(project, item.sequence.id, "Coverage sequence");
        item.sequence.shots.forEach((shot) => ensureAvailableId(project, shot.id, "Coverage shot"));
        const sequence = structuredClone(item.sequence) as DirectorCoverageSequence;
        validateCoverageSequenceReferences(project, sequence);
        production.sequences.push(sequence);
        if (item.activate !== false || !production.activeSequenceId) production.activeSequenceId = sequence.id;
        addUnique(result.created.coverage_sequence_ids, sequence.id);
        sequence.shots.forEach((shot) => addUnique(result.created.coverage_shot_ids, shot.id));
        break;
      }
      case "update_coverage_sequence": {
        const production = ensureProduction(project);
        const sequence = requireCoverageSequence(project, item.sequence_id);
        const previousShotIds = new Set(sequence.shots.map((shot) => shot.id));
        const updated = { ...sequence, ...structuredClone(item.patch) } as DirectorCoverageSequence;
        updated.shots.forEach((shot) => {
          if (!previousShotIds.has(shot.id)) ensureAvailableId(project, shot.id, "Coverage shot");
        });
        validateCoverageSequenceReferences(project, updated);
        Object.assign(sequence, updated);
        if (item.activate === true) production.activeSequenceId = sequence.id;
        const updatedShotIds = new Set(sequence.shots.map((shot) => shot.id));
        previousShotIds.forEach((shotId) => {
          if (!updatedShotIds.has(shotId)) addUnique(result.deleted.coverage_shot_ids, shotId);
        });
        sequence.shots.forEach((shot) =>
          addUnique(
            previousShotIds.has(shot.id) ? result.updated.coverage_shot_ids : result.created.coverage_shot_ids,
            shot.id,
          ),
        );
        addUnique(result.updated.coverage_sequence_ids, sequence.id);
        break;
      }
      case "delete_coverage_sequences": {
        const production = ensureProduction(project);
        const requested = new Set(item.sequence_ids);
        item.sequence_ids.forEach((sequenceId) => requireCoverageSequence(project, sequenceId));
        production.sequences
          .filter((sequence) => requested.has(sequence.id))
          .flatMap((sequence) => sequence.shots)
          .forEach((shot) => addUnique(result.deleted.coverage_shot_ids, shot.id));
        production.sequences = production.sequences.filter((sequence) => !requested.has(sequence.id));
        if (production.activeSequenceId && requested.has(production.activeSequenceId)) {
          production.activeSequenceId = production.sequences[0]?.id ?? null;
        }
        item.sequence_ids.forEach((sequenceId) => addUnique(result.deleted.coverage_sequence_ids, sequenceId));
        break;
      }
      case "add_coverage_shot": {
        const production = ensureProduction(project);
        const sequence = requireCoverageSequence(project, item.sequence_id);
        ensureAvailableId(project, item.shot.id, "Coverage shot");
        const shot = structuredClone(item.shot) as DirectorCoverageShot;
        validateCoverageShotReferences(project, shot);
        sequence.shots.push(shot);
        if (item.activate !== false) {
          production.activeSequenceId = sequence.id;
          production.activeTakeId = shot.takeId;
        }
        addUnique(result.created.coverage_shot_ids, shot.id);
        break;
      }
      case "update_coverage_shot": {
        const production = ensureProduction(project);
        const { sequence, shot } = requireCoverageShot(project, item.shot_id);
        const updated = { ...shot, ...structuredClone(item.patch) } as DirectorCoverageShot;
        validateCoverageShotReferences(project, updated);
        Object.assign(shot, updated);
        if (item.activate === true) {
          production.activeSequenceId = sequence.id;
          production.activeTakeId = shot.takeId;
        }
        addUnique(result.updated.coverage_shot_ids, shot.id);
        break;
      }
      case "delete_coverage_shots": {
        const production = ensureProduction(project);
        item.shot_ids.forEach((shotId) => requireCoverageShot(project, shotId));
        const requested = new Set(item.shot_ids);
        production.sequences.forEach((sequence) => {
          sequence.shots = sequence.shots.filter((shot) => !requested.has(shot.id));
        });
        item.shot_ids.forEach((shotId) => addUnique(result.deleted.coverage_shot_ids, shotId));
        break;
      }
      case "set_world_settings": {
        const world = ensureWorld(project, result.notes);
        const settings = item.settings;
        world.settings = {
          ...world.settings,
          ...(settings.enabled === undefined ? {} : { enabled: settings.enabled }),
          ...(settings.seed === undefined ? {} : { seed: settings.seed }),
          wind: {
            ...world.settings.wind,
            ...(settings.wind?.direction_degrees === undefined
              ? {}
              : { directionDegrees: settings.wind.direction_degrees }),
            ...(settings.wind?.speed_mps === undefined ? {} : { speedMps: settings.wind.speed_mps }),
            ...(settings.wind?.gustiness === undefined ? {} : { gustiness: settings.wind.gustiness }),
            ...(settings.wind?.turbulence === undefined ? {} : { turbulence: settings.wind.turbulence }),
          },
          timeOfDay: {
            ...world.settings.timeOfDay,
            ...(settings.time_of_day?.mode === undefined ? {} : { mode: settings.time_of_day.mode }),
            ...(settings.time_of_day?.hours === undefined ? {} : { hours: settings.time_of_day.hours }),
            ...(settings.time_of_day?.cycle_minutes === undefined
              ? {}
              : { cycleMinutes: settings.time_of_day.cycle_minutes }),
            ...(settings.time_of_day?.drives_sky === undefined ? {} : { drivesSky: settings.time_of_day.drives_sky }),
          },
          weather: {
            ...world.settings.weather,
            ...(settings.weather?.preset === undefined ? {} : { preset: settings.weather.preset }),
            ...(settings.weather?.intensity === undefined ? {} : { intensity: settings.weather.intensity }),
            ...(settings.weather?.wetness === undefined ? {} : { wetness: settings.weather.wetness }),
            ...(settings.weather?.cloud_cover === undefined ? {} : { cloudCover: settings.weather.cloud_cover }),
          },
        };
        if (settings.weather?.evolution !== undefined) {
          assignOptional(
            world.settings.weather,
            "evolution",
            settings.weather.evolution === null
              ? null
              : {
                  mode: settings.weather.evolution.mode,
                  periodSeconds:
                    settings.weather.evolution.period_seconds ??
                    world.settings.weather.evolution?.periodSeconds ??
                    DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
                },
          );
        }
        break;
      }
      case "add_world_effect": {
        const world = ensureWorld(project, result.notes);
        assertWorldCapacity(world.effects.length, DIRECTOR_WORLD_MAX_EFFECTS, "effects", "remove_world_effects");
        if (item.anchor?.object_id) requireObject(project, item.anchor.object_id);
        if (item.id) ensureAvailableWorldId(world, item.id, "World effect");
        if (item.propagation) assertFirePropagationTarget(item.kind, item.anchor?.object_id);
        const generated = nextWorldEntryId(world, `fx_${item.kind}`);
        const effect: DirectorWorldEffect = {
          id: item.id ?? generated.id,
          name: item.name ?? formatWorldEntryName(WORLD_EFFECT_DEFAULT_NAMES[item.kind], generated.ordinal),
          kind: item.kind,
          anchor: {
            objectId: item.anchor?.object_id ?? null,
            position: item.anchor?.position ? [...item.anchor.position] : [0, 0, 0],
          },
          shape: item.shape ? structuredClone(item.shape) : { type: "point" },
          intensity: item.intensity ?? 1,
          sizeScale: item.size_scale ?? 1,
          speedScale: item.speed_scale ?? 1,
          ...(item.color_tint ? { colorTint: item.color_tint } : {}),
          windInfluence: item.wind_influence ?? WORLD_EFFECT_DEFAULT_WIND_INFLUENCE[item.kind],
          ...(item.propagation
            ? {
                propagation: {
                  enabled: item.propagation.enabled,
                  radiusM: item.propagation.radius_m ?? worldFirePropagationDefaults.radiusM,
                  spreadRate: item.propagation.spread_rate ?? worldFirePropagationDefaults.spreadRate,
                },
              }
            : {}),
          seedOffset: item.seed_offset ?? nextWorldSeedOffset(world.effects),
          visible: true,
          locked: false,
          createdAt: new Date().toISOString(),
        };
        world.effects.push(effect);
        addUnique(result.created.world_effect_ids, effect.id);
        break;
      }
      case "update_world_effect": {
        const effect = requireWorldEffect(project, item.effect_id);
        const patch = item.patch;
        assertUnlockedWorldEntry(effect, patch, "World effect", "update_world_effect");
        if (patch.anchor?.object_id) requireObject(project, patch.anchor.object_id);
        if (patch.name !== undefined) effect.name = patch.name;
        if (patch.kind !== undefined) effect.kind = patch.kind;
        if (patch.anchor) {
          effect.anchor = {
            objectId: patch.anchor.object_id === undefined ? (effect.anchor.objectId ?? null) : patch.anchor.object_id,
            position: patch.anchor.position ? [...patch.anchor.position] : [...effect.anchor.position],
          };
        }
        if (patch.shape !== undefined) effect.shape = structuredClone(patch.shape);
        if (patch.intensity !== undefined) effect.intensity = patch.intensity;
        if (patch.size_scale !== undefined) effect.sizeScale = patch.size_scale;
        if (patch.speed_scale !== undefined) effect.speedScale = patch.speed_scale;
        assignOptional(effect, "colorTint", patch.color_tint);
        if (patch.wind_influence !== undefined) effect.windInfluence = patch.wind_influence;
        if (patch.propagation !== undefined) {
          if (patch.propagation) assertFirePropagationTarget(effect.kind, effect.anchor.objectId);
          assignOptional(
            effect,
            "propagation",
            patch.propagation === null
              ? null
              : {
                  enabled: patch.propagation.enabled,
                  radiusM:
                    patch.propagation.radius_m ?? effect.propagation?.radiusM ?? worldFirePropagationDefaults.radiusM,
                  spreadRate:
                    patch.propagation.spread_rate ??
                    effect.propagation?.spreadRate ??
                    worldFirePropagationDefaults.spreadRate,
                },
          );
        }
        if (patch.seed_offset !== undefined) effect.seedOffset = patch.seed_offset;
        if (patch.visible !== undefined) effect.visible = patch.visible;
        if (patch.locked !== undefined) effect.locked = patch.locked;
        addUnique(result.updated.world_effect_ids, effect.id);
        break;
      }
      case "remove_world_effects": {
        const world = project.world;
        const remaining = removeWorldEntries(
          world?.effects ?? [],
          item.effect_ids,
          "world effect",
          "update_world_effect",
        );
        if (world) world.effects = remaining;
        item.effect_ids.forEach((effectId) => addUnique(result.deleted.world_effect_ids, effectId));
        break;
      }
      case "add_world_water_body": {
        const world = ensureWorld(project, result.notes);
        assertWorldCapacity(
          world.waterBodies.length,
          DIRECTOR_WORLD_MAX_WATER_BODIES,
          "water bodies",
          "remove_world_water_bodies",
        );
        if (item.id) ensureAvailableWorldId(world, item.id, "World water body");
        const generated = nextWorldEntryId(world, "water");
        const body: DirectorWorldWaterBody = {
          id: item.id ?? generated.id,
          name: item.name ?? formatWorldEntryName(WORLD_WATER_DEFAULT_NAME, generated.ordinal),
          surface: {
            center: item.surface?.center ? [...item.surface.center] : [0, 0, 0],
            sizeX: item.surface?.size_x ?? 20,
            sizeZ: item.surface?.size_z ?? 20,
            rotationDegrees: item.surface?.rotation_degrees ?? 0,
          },
          ...(item.river
            ? {
                river: {
                  points: item.river.points.map((point) => [...point] as [number, number, number]),
                  widthM: item.river.width_m,
                  ...(item.river.width_profile ? { widthProfile: [...item.river.width_profile] } : {}),
                },
              }
            : {}),
          waveAmplitude: item.wave_amplitude ?? 0.12,
          waveLengthM: item.wave_length_m ?? 8,
          flowDirectionDegrees: item.flow_direction_degrees ?? 90,
          flowSpeedMps: item.flow_speed_mps ?? 0.4,
          colorShallow: item.color_shallow ?? "#4fa8c7",
          colorDeep: item.color_deep ?? "#0b2e4f",
          opacity: item.opacity ?? 0.92,
          foamIntensity: item.foam_intensity ?? 0.5,
          visible: true,
          locked: false,
        };
        world.waterBodies.push(body);
        addUnique(result.created.world_water_body_ids, body.id);
        break;
      }
      case "update_world_water_body": {
        const body = requireWorldWaterBody(project, item.body_id);
        const patch = item.patch;
        assertUnlockedWorldEntry(body, patch, "World water body", "update_world_water_body");
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.surface) {
          body.surface = {
            center: patch.surface.center ? [...patch.surface.center] : [...body.surface.center],
            sizeX: patch.surface.size_x ?? body.surface.sizeX,
            sizeZ: patch.surface.size_z ?? body.surface.sizeZ,
            rotationDegrees: patch.surface.rotation_degrees ?? body.surface.rotationDegrees,
          };
        }
        if (patch.river === null) {
          delete body.river;
        } else if (patch.river) {
          body.river = {
            points: patch.river.points.map((point) => [...point] as [number, number, number]),
            widthM: patch.river.width_m,
            ...(patch.river.width_profile ? { widthProfile: [...patch.river.width_profile] } : {}),
          };
        }
        if (patch.wave_amplitude !== undefined) body.waveAmplitude = patch.wave_amplitude;
        if (patch.wave_length_m !== undefined) body.waveLengthM = patch.wave_length_m;
        if (patch.flow_direction_degrees !== undefined) body.flowDirectionDegrees = patch.flow_direction_degrees;
        if (patch.flow_speed_mps !== undefined) body.flowSpeedMps = patch.flow_speed_mps;
        if (patch.color_shallow !== undefined) body.colorShallow = patch.color_shallow;
        if (patch.color_deep !== undefined) body.colorDeep = patch.color_deep;
        if (patch.opacity !== undefined) body.opacity = patch.opacity;
        if (patch.foam_intensity !== undefined) body.foamIntensity = patch.foam_intensity;
        if (patch.visible !== undefined) body.visible = patch.visible;
        if (patch.locked !== undefined) body.locked = patch.locked;
        addUnique(result.updated.world_water_body_ids, body.id);
        break;
      }
      case "remove_world_water_bodies": {
        const world = project.world;
        const remaining = removeWorldEntries(
          world?.waterBodies ?? [],
          item.body_ids,
          "world water body",
          "update_world_water_body",
        );
        if (world) world.waterBodies = remaining;
        item.body_ids.forEach((bodyId) => addUnique(result.deleted.world_water_body_ids, bodyId));
        break;
      }
      case "add_world_wildlife_group": {
        const world = ensureWorld(project, result.notes);
        assertWorldCapacity(
          world.wildlife.length,
          DIRECTOR_WORLD_MAX_WILDLIFE_GROUPS,
          "wildlife groups",
          "remove_world_wildlife_groups",
        );
        if (item.asset_id) requireAsset(project, item.asset_id);
        if (item.id) ensureAvailableWorldId(world, item.id, "World wildlife group");
        const generated = nextWorldEntryId(world, `wildlife_${item.species}`);
        const defaultAltitude = WORLD_WILDLIFE_DEFAULT_ALTITUDES[item.species];
        const altitude = item.altitude
          ? { minM: item.altitude.min_m, maxM: item.altitude.max_m }
          : defaultAltitude
            ? { ...defaultAltitude }
            : undefined;
        const group: DirectorWorldWildlifeGroup = {
          id: item.id ?? generated.id,
          name: item.name ?? formatWorldEntryName(WORLD_WILDLIFE_DEFAULT_NAMES[item.species], generated.ordinal),
          species: item.species,
          count: item.count ?? WORLD_WILDLIFE_DEFAULT_COUNTS[item.species],
          area: {
            center: item.area?.center ? [...item.area.center] : [0, 0, 0],
            radius: item.area?.radius ?? 15,
          },
          ...(altitude ? { altitude } : {}),
          speedScale: item.speed_scale ?? 1,
          sizeScale: item.size_scale ?? 1,
          ...(item.asset_id ? { assetId: item.asset_id } : {}),
          seedOffset: item.seed_offset ?? nextWorldSeedOffset(world.wildlife),
          visible: true,
          locked: false,
        };
        world.wildlife.push(group);
        addUnique(result.created.world_wildlife_group_ids, group.id);
        break;
      }
      case "update_world_wildlife_group": {
        const group = requireWorldWildlifeGroup(project, item.group_id);
        const patch = item.patch;
        assertUnlockedWorldEntry(group, patch, "World wildlife group", "update_world_wildlife_group");
        if (patch.asset_id) requireAsset(project, patch.asset_id);
        if (patch.name !== undefined) group.name = patch.name;
        if (patch.species !== undefined) group.species = patch.species;
        if (patch.count !== undefined) group.count = patch.count;
        if (patch.area) {
          group.area = {
            center: patch.area.center ? [...patch.area.center] : [...group.area.center],
            radius: patch.area.radius ?? group.area.radius,
          };
        }
        assignOptional(
          group,
          "altitude",
          patch.altitude ? { minM: patch.altitude.min_m, maxM: patch.altitude.max_m } : patch.altitude,
        );
        if (patch.speed_scale !== undefined) group.speedScale = patch.speed_scale;
        if (patch.size_scale !== undefined) group.sizeScale = patch.size_scale;
        assignOptional(group, "assetId", patch.asset_id);
        if (patch.seed_offset !== undefined) group.seedOffset = patch.seed_offset;
        if (patch.visible !== undefined) group.visible = patch.visible;
        if (patch.locked !== undefined) group.locked = patch.locked;
        addUnique(result.updated.world_wildlife_group_ids, group.id);
        break;
      }
      case "remove_world_wildlife_groups": {
        const world = project.world;
        const remaining = removeWorldEntries(
          world?.wildlife ?? [],
          item.group_ids,
          "world wildlife group",
          "update_world_wildlife_group",
        );
        if (world) world.wildlife = remaining;
        item.group_ids.forEach((groupId) => addUnique(result.deleted.world_wildlife_group_ids, groupId));
        break;
      }
      case "add_world_road": {
        const world = ensureWorld(project, result.notes);
        // Guard pre-roads in-memory blocks that predate the defaulted field.
        world.roads ??= [];
        assertWorldCapacity(world.roads.length, DIRECTOR_WORLD_MAX_ROADS, "roads", "remove_world_roads");
        if (item.id) ensureAvailableWorldId(world, item.id, "World road");
        const generated = nextWorldEntryId(world, "road");
        const first = item.points[0]!;
        const last = item.points[item.points.length - 1]!;
        const closesOnItself =
          Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < WORLD_ROAD_LOOP_INFER_EPSILON_M;
        const road: DirectorWorldRoad = {
          id: item.id ?? generated.id,
          name: item.name ?? formatWorldEntryName(WORLD_ROAD_DEFAULT_NAME, generated.ordinal),
          points: item.points.map((point) => [...point] as [number, number, number]),
          widthM: item.width_m ?? 8,
          loop: item.loop ?? closesOnItself,
          vehicleCount: item.vehicle_count ?? 6,
          speedKph: item.speed_kph ?? 40,
          showSurface: item.show_surface ?? true,
          seedOffset: item.seed_offset ?? nextWorldSeedOffset(world.roads),
          visible: true,
          locked: false,
        };
        world.roads.push(road);
        addUnique(result.created.world_road_ids, road.id);
        break;
      }
      case "update_world_road": {
        const road = requireWorldRoad(project, item.road_id);
        const patch = item.patch;
        assertUnlockedWorldEntry(road, patch, "World road", "update_world_road");
        if (patch.name !== undefined) road.name = patch.name;
        if (patch.points) road.points = patch.points.map((point) => [...point] as [number, number, number]);
        if (patch.width_m !== undefined) road.widthM = patch.width_m;
        if (patch.loop !== undefined) road.loop = patch.loop;
        if (patch.vehicle_count !== undefined) road.vehicleCount = patch.vehicle_count;
        if (patch.speed_kph !== undefined) road.speedKph = patch.speed_kph;
        if (patch.show_surface !== undefined) road.showSurface = patch.show_surface;
        if (patch.seed_offset !== undefined) road.seedOffset = patch.seed_offset;
        if (patch.visible !== undefined) road.visible = patch.visible;
        if (patch.locked !== undefined) road.locked = patch.locked;
        addUnique(result.updated.world_road_ids, road.id);
        break;
      }
      case "remove_world_roads": {
        const world = project.world;
        const remaining = removeWorldEntries(world?.roads ?? [], item.road_ids, "world road", "update_world_road");
        if (world) world.roads = remaining;
        item.road_ids.forEach((roadId) => addUnique(result.deleted.world_road_ids, roadId));
        break;
      }
      case "set_vehicle_profile": {
        const object = requireVehicleCapableObject(project, item.object_id);
        const patch = item.profile ?? {};
        // Mirror of the world unlock-only exception: the standalone safety
        // patch may disable driving on an existing profile without unlocking,
        // but it cannot author a brand-new profile onto a locked object.
        const disableOnly = Boolean(object.vehicle) && Object.keys(patch).length === 1 && patch.drivable === false;
        if (isAuthoringObjectLocked(project, object) && !disableOnly) {
          throw new Error(
            `Object "${object.id}" is locked. Unlock it first with an update_object patch {"locked": false}; only the standalone safety patch {"drivable": false} bypasses the lock.`,
          );
        }
        const existing = object.vehicle;
        const base = existing ?? createDefaultDirectorCarProfile();
        const profile: DirectorVehicleProfile = {
          ...base,
          ...(patch.kind === undefined ? {} : { kind: patch.kind }),
          ...(patch.drivable === undefined ? {} : { drivable: patch.drivable }),
          ...(patch.mass_kg === undefined ? {} : { massKg: patch.mass_kg }),
          ...(patch.engine_force_n === undefined ? {} : { engineForceN: patch.engine_force_n }),
          ...(patch.brake_force_n === undefined ? {} : { brakeForceN: patch.brake_force_n }),
          ...(patch.max_speed_kph === undefined ? {} : { maxSpeedKph: patch.max_speed_kph }),
          ...(patch.reverse_speed_kph === undefined ? {} : { reverseSpeedKph: patch.reverse_speed_kph }),
          ...(patch.steer_max_deg === undefined ? {} : { steerMaxDeg: patch.steer_max_deg }),
          ...(patch.wheel_radius_m === undefined ? {} : { wheelRadiusM: patch.wheel_radius_m }),
          ...(patch.suspension_rest_m === undefined ? {} : { suspensionRestM: patch.suspension_rest_m }),
          ...(patch.suspension_stiffness === undefined ? {} : { suspensionStiffness: patch.suspension_stiffness }),
          ...(patch.center_of_mass_y_offset_m === undefined
            ? {}
            : { centerOfMassYOffsetM: patch.center_of_mass_y_offset_m }),
          ...(patch.seat_offset ? { seatOffset: [...patch.seat_offset] } : {}),
          ...(patch.exit_offsets ? { exitOffsets: structuredClone(patch.exit_offsets) } : {}),
          camera: {
            ...base.camera,
            ...(patch.camera?.chase_distance_m === undefined ? {} : { chaseDistanceM: patch.camera.chase_distance_m }),
            ...(patch.camera?.chase_height_m === undefined ? {} : { chaseHeightM: patch.camera.chase_height_m }),
          },
        };
        object.vehicle = profile;
        result.notes.push(
          existing
            ? `Patched the existing vehicle profile on object "${object.id}".`
            : `Object "${object.id}" had no vehicle profile; attached the default car profile${Object.keys(patch).length ? " and applied the patch" : ""}.`,
        );
        addUnique(result.updated.object_ids, object.id);
        break;
      }
      case "clear_vehicle_profile": {
        const object = requireObject(project, item.object_id);
        if (!object.vehicle) {
          result.notes.push(`Object "${object.id}" had no vehicle profile; clear_vehicle_profile left it unchanged.`);
          break;
        }
        if (isAuthoringObjectLocked(project, object)) {
          throw new Error(
            `Locked object "${object.id}" cannot have its vehicle profile cleared. Unlock it first with an update_object patch {"locked": false}.`,
          );
        }
        delete object.vehicle;
        addUnique(result.updated.object_ids, object.id);
        break;
      }
    }
  }

  if (rebuildProduction) {
    project.production = createDefaultDirectorProduction(project);
  } else if (project.production) {
    project.production = reconcileDirectorProduction(project, project.production)!;
  }

  const productionIssues = getDirectorProductionIssues(project);
  if (productionIssues.length) {
    throw new Error(
      `Production semantics are invalid: ${productionIssues
        .slice(0, 8)
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }

  return result;
}
