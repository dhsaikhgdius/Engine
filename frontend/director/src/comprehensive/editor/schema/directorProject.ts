import { protocolKeys } from "../../../../../../packages/protocol/src/primitives";
/**
 * Re-export barrel for every Director project type.
 *
 * All types originate from {@link ./directorProjectSchema.ts} and the
 * protocol packages; this file is the single import surface that the rest
 * of the frontend uses. It also defines the enum-like constant tuples and
 * their TypeScript types derived from the shared options JSON.
 */
export type {
  CharacterRigState,
  DirectorAnimationKeyframe,
  DirectorAnimationRecipeMetadata,
  DirectorAnimationTimingCurve,
  DirectorAssetRef,
  DirectorCameraAction,
  DirectorCameraCapture,
  DirectorCameraFollowAction,
  DirectorCameraPathAction,
  DirectorCameraShot,
  DirectorClippingPlane,
  DirectorCharacterIkState,
  DirectorCharacterIkTarget,
  DirectorCharacterMotionBlock,
  DirectorCharacterMotionState,
  DirectorCoverageSequence,
  DirectorCoverageShot,
  DirectorEntityAnimation,
  DirectorFogSettings,
  DirectorLight,
  DirectorLightType,
  DirectorMaterialSide,
  DirectorMaterialTextureSlot,
  DirectorNativeObjectSource,
  DirectorNativeScene,
  DirectorObject,
  DirectorObjectLayer,
  DirectorPbrMaterial,
  DirectorPbrTextureBindings,
  DirectorPerformanceEntityTrack,
  DirectorPerformanceTake,
  DirectorProduction,
  DirectorProceduralRecipe,
  DirectorProject,
  DirectorReferenceBinding,
  DirectorSceneAnchor,
  DirectorSceneAnnotation,
  DirectorSceneMeasurement,
  DirectorStoryboard,
  DirectorStoryboardGeneration,
  DirectorStoryboardGenerationOutput,
  DirectorStoryboardShot,
  DirectorTimeline,
  DirectorTimelineAudioClip,
  DirectorTimelineAudioTrack,
  DirectorToggleTransformInteraction,
  DirectorTrajectoryCircleGeometry,
  DirectorTransform,
  DirectorVehicleKind,
  DirectorVehicleProfile,
  DirectorWorld,
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldSettings,
  DirectorWorldTimeOfDay,
  DirectorWorldWaterBody,
  DirectorWorldWeather,
  DirectorWorldWildlifeGroup,
  DirectorWorldWind,
  MixamoCharacterMetadata,
  SceneSettings,
  WorldEffectKind,
  WorldWildlifeSpecies,
} from "./directorProjectSchema";
import directorProjectOptions from "./directorProjectOptions.json";

function labeledOptions<T extends Record<string, string>>(value: T) {
  return Object.entries(value).map(([id, label]) => ({ id: id as Extract<keyof T, string>, label }));
}

export type ViewMode = "director" | "camera";
export type RightPanelKind = "scene" | "character" | "prop" | "camera";
export const DIRECTOR_OBJECT_KINDS = protocolKeys(directorProjectOptions.objectKinds);
export type DirectorObjectKind = (typeof DIRECTOR_OBJECT_KINDS)[number];
/**
 * The portable placement intent shared by project JSON, Agent authoring, and
 * the spatial quality audit. Keep this tuple as the single source of truth:
 * `auto` preserves legacy documents, while every other value is an explicit
 * statement about why an object is allowed to occupy its world position.
 */
export const DIRECTOR_PLACEMENT_MODES = protocolKeys(directorProjectOptions.placementModes);
export type DirectorPlacementMode = (typeof DIRECTOR_PLACEMENT_MODES)[number];
export const GEOMETRY_PRIMITIVE_TYPES = protocolKeys(directorProjectOptions.geometryPrimitives);
export const GEOMETRY_PRIMITIVE_OPTIONS = Object.entries(directorProjectOptions.geometryPrimitives).map(
  ([type, label]) => ({ type: type as keyof typeof directorProjectOptions.geometryPrimitives, label }),
);
export type GeometryPrimitiveType = (typeof GEOMETRY_PRIMITIVE_TYPES)[number];
export const CHARACTER_RIG_TYPES = protocolKeys(directorProjectOptions.characterRigTypes);
export type CharacterRigType = (typeof CHARACTER_RIG_TYPES)[number];
export const CHARACTER_BODY_TYPES = protocolKeys(directorProjectOptions.characterBodyTypes);
export type CharacterBodyType = (typeof CHARACTER_BODY_TYPES)[number];
export const CHARACTER_SOURCES = protocolKeys(directorProjectOptions.characterSources);
export const DIRECTOR_ASSET_KINDS = protocolKeys(directorProjectOptions.assetKinds);
export type DirectorAssetKind = (typeof DIRECTOR_ASSET_KINDS)[number];
/** Where a model is resolved from. Remote catalog items retain their canonical URL in the scene. */
export const DIRECTOR_ASSET_SOURCES = protocolKeys(directorProjectOptions.assetSources);
export type DirectorAssetSource = (typeof DIRECTOR_ASSET_SOURCES)[number];
export const DIRECTOR_ASSET_SOURCE_TYPES = protocolKeys(directorProjectOptions.assetSourceTypes);
export const DIRECTOR_LIGHT_TYPES = protocolKeys(directorProjectOptions.lightTypes);
export const DIRECTOR_LIGHT_TYPE_OPTIONS = labeledOptions(directorProjectOptions.lightTypes);
export const DIRECTOR_MATERIAL_SIDES = protocolKeys(directorProjectOptions.materialSides);
export const DIRECTOR_MATERIAL_SIDE_OPTIONS = labeledOptions(directorProjectOptions.materialSides);
export const DIRECTOR_MATERIAL_TEXTURE_SLOTS = protocolKeys(directorProjectOptions.materialTextureSlots);
export const DIRECTOR_MATERIAL_TEXTURE_SLOT_OPTIONS = labeledOptions(directorProjectOptions.materialTextureSlots);
export const PANORAMA_PROJECTION_MODES = protocolKeys(directorProjectOptions.panoramaProjectionModes);
export type PanoramaProjectionMode = (typeof PANORAMA_PROJECTION_MODES)[number];

export const DIRECTOR_ANIMATION_INTERPOLATIONS = protocolKeys(directorProjectOptions.animationInterpolations);
export type DirectorAnimationInterpolation = (typeof DIRECTOR_ANIMATION_INTERPOLATIONS)[number];

export const DIRECTOR_TRAJECTORY_PRESET_IDS = protocolKeys(directorProjectOptions.trajectoryPresets);
export const DIRECTOR_TRAJECTORY_PRESETS = labeledOptions(directorProjectOptions.trajectoryPresets);

export type DirectorTrajectoryPreset = (typeof DIRECTOR_TRAJECTORY_PRESET_IDS)[number];
/**
 * `run` is retained to read documents created before the Flick-style movement
 * options were expanded. New authoring uses the four explicit pace presets.
 */
export const DIRECTOR_TRAJECTORY_MOTIONS = protocolKeys(directorProjectOptions.trajectoryMotions);
export type DirectorTrajectoryMotion = (typeof DIRECTOR_TRAJECTORY_MOTIONS)[number];
export const DIRECTOR_TRAJECTORY_SOURCES = protocolKeys(directorProjectOptions.trajectorySources);
export type DirectorTrajectorySource = (typeof DIRECTOR_TRAJECTORY_SOURCES)[number];

export const DIRECTOR_CHARACTER_IK_EFFECTORS = protocolKeys(directorProjectOptions.characterIkEffectors);

export type DirectorCharacterIkEffector = (typeof DIRECTOR_CHARACTER_IK_EFFECTORS)[number];

export const DIRECTOR_CHARACTER_MOTION_LOOPS = protocolKeys(directorProjectOptions.characterMotionLoops);
export type DirectorCharacterMotionLoop = (typeof DIRECTOR_CHARACTER_MOTION_LOOPS)[number];

export const DIRECTOR_CHARACTER_ROOT_MOTION_MODES = protocolKeys(directorProjectOptions.characterRootMotionModes);
export type DirectorCharacterRootMotionMode = (typeof DIRECTOR_CHARACTER_ROOT_MOTION_MODES)[number];

/**
 * A portable, human-readable connection between a scene object and one of the
 * references used to direct it.  It deliberately stores an ID, relative label,
 * or prompt excerpt instead of a file URL or binary payload: scene documents
 * must remain safe to sync through ComfyUI, Blender, and the local MCP bridge.
 */
export const DIRECTOR_REFERENCE_KIND_IDS = protocolKeys(directorProjectOptions.referenceKinds);
export const DIRECTOR_REFERENCE_KINDS = labeledOptions(directorProjectOptions.referenceKinds);

export type DirectorReferenceKind = (typeof DIRECTOR_REFERENCE_KIND_IDS)[number];

export interface PromptReferenceVisualStyle {
  fontColor: string;
  fontSize: number;
  width: number;
  height: number;
  backgroundColor: string;
  borderColor: string;
}

export const DEFAULT_PROMPT_REFERENCE_VISUAL_STYLE: PromptReferenceVisualStyle = {
  fontColor: "#F3F7FF",
  fontSize: 16,
  width: 220,
  height: 72,
  backgroundColor: "transparent",
  borderColor: "transparent",
};

export function getPromptReferenceVisualStyle(
  style: Partial<PromptReferenceVisualStyle> | undefined,
): PromptReferenceVisualStyle {
  return { ...DEFAULT_PROMPT_REFERENCE_VISUAL_STYLE, ...style };
}

/** Output framing options mirrored by the Stage camera inspector. */
export { DIRECTOR_CAMERA_ASPECT_RATIOS } from "../../../../../../packages/protocol/src/directorCameraProtocol";
export type { DirectorCameraAspectRatio } from "../../../../../../packages/protocol/src/directorCameraProtocol";

/** A camera shake preset is persisted with the shot, rather than being a UI-only choice. */
export const DIRECTOR_CAMERA_HANDHELD_SHAKES = protocolKeys(directorProjectOptions.cameraHandheldShakes);
export type DirectorCameraHandheldShake = (typeof DIRECTOR_CAMERA_HANDHELD_SHAKES)[number];

/**
 * The camera actions exposed by the Stage.  They intentionally mirror the
 * authoring modes rather than a renderer implementation, so a saved scene and
 * an agent command describe the same editorial intent.
 */
export type DirectorCameraActionMode = "still" | "path" | "follow" | "transform";

/** Physical capture gate used to turn a real focal length into field of view. */
export const DIRECTOR_CAMERA_SENSOR_FORMATS = protocolKeys(directorProjectOptions.cameraSensorFormats);
export type DirectorCameraSensorFormat = (typeof DIRECTOR_CAMERA_SENSOR_FORMATS)[number];
export const DIRECTOR_CAMERA_TARGET_MODES = protocolKeys(directorProjectOptions.cameraTargetModes);
/** Editorial information is intentionally portable: each board card points to
 * the same timeline frames and camera objects that drive the actual viewport. */
export const DIRECTOR_STORYBOARD_SHOT_SIZE_IDS = protocolKeys(directorProjectOptions.storyboardShotSizes);
export const DIRECTOR_STORYBOARD_SHOT_SIZES = labeledOptions(directorProjectOptions.storyboardShotSizes);

export type DirectorStoryboardShotSize = (typeof DIRECTOR_STORYBOARD_SHOT_SIZE_IDS)[number];

export const DIRECTOR_STORYBOARD_MOVEMENT_IDS = protocolKeys(directorProjectOptions.storyboardMovements);
export const DIRECTOR_STORYBOARD_MOVEMENTS = labeledOptions(directorProjectOptions.storyboardMovements);

export type DirectorStoryboardMovement = (typeof DIRECTOR_STORYBOARD_MOVEMENT_IDS)[number];
