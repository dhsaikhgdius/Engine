import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import {
  DIRECTOR_PROJECT_REVISION_PATTERN,
  getDirectorProjectRevision,
} from "../comprehensive/editor/schema/directorProjectRevision";
import {
  directorAssetKindSchema,
  directorAssetSourceTypeSchema,
  directorProjectSchema,
} from "../comprehensive/editor/schema/directorProjectSchema";
import { getDirectorCharacterAssetBindingIssues } from "../comprehensive/editor/modelLibrary/mixamoCharacterCatalog";
import { resolveCharacterPoseControls } from "../comprehensive/editor/presets/mannequinPosePresets";
import { DIRECTOR_CAMERA_SENSOR_FORMATS } from "../comprehensive/editor/schema/directorProject";
import type {
  DirectorAnimationKeyframe,
  DirectorAssetRef,
  DirectorCameraShot,
  DirectorLight,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
} from "../comprehensive/editor/schema/directorProject";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorCameraSensorGate,
  getFocalLengthFromVerticalFov,
  normalizeDirectorCameraOptics,
} from "../comprehensive/editor/schema/cameraGeometry";
import { normalizeDirectorTimebase } from "../comprehensive/editor/timeline/frameRate";
import {
  directorDccFiniteSchema,
  directorDccTransformSchema,
  directorDccVec3Schema,
  type DirectorDccTransform,
} from "./directorDccSharedContract";
import { directorDccImportPlanSchema } from "./directorDccReturnContract";
import { directorBlendSceneImportSelectionSchema } from "./directorBlendSceneImportContract";
import {
  directorEngineSceneImportSelectionSchema,
  directorEngineSceneProviderSchema,
} from "./directorEngineSceneImportContract";
import { directorDccGodotRunSceneSchema } from "./directorDccEngineRunContract";
import { strictOperation } from "../../../../packages/protocol/src/strictProtocolVariant";
import { directorCameraAspectRatioSchema } from "../../../../packages/protocol/src/directorCameraProtocol";
import { directorDccPortableExchangeFormatSchema, directorDccProviderIdSchema } from "./directorDccProviderContract";
import { directorDccConnectorProviderIdSchema, directorDccEngineIdSchema } from "./directorDccEngineSpace";

/**
 * Central Director ↔ DCC handoff contract.
 *
 * Defines the Director → DCC scene export package (objects, cameras, lights,
 * characters, animation, assets), the typed handoff operations the editor
 * submits to the gateway (export, open, return-import, engine send/run), and
 * the builders that project a live DirectorProject into the export wire
 * shape. Everything crossing this boundary is Zod-validated on both sides;
 * unsupported host features are warn-and-omit in receipts, never silently
 * dropped.
 */

// Re-exported so downstream modules can import the whole DCC vocabulary from
// this central contract without also depending on the shared-contract module.
export { directorDccTransformSchema } from "./directorDccSharedContract";
export type { DirectorDccTransform } from "./directorDccSharedContract";

/** Contract identifier for the Director → DCC scene export package. */
export const DIRECTOR_DCC_SCENE_CONTRACT = "director-dcc-scene-v1" as const;

const finite = directorDccFiniteSchema;
const vec3 = directorDccVec3Schema;

const directorDccAnimationKeyframeSchema = z.strictObject({
  frame: finite,
  interpolation: z.enum(["step", "linear", "smooth"]),
  transform: directorDccTransformSchema.optional(),
  lookTarget: vec3.optional(),
  poseValues: z.record(z.string(), finite).optional(),
  focalLengthMm: finite.positive().optional(),
});

/** DCC-facing asset descriptor within an export package. */
export const directorDccAssetSchema = z.strictObject({
  id: z.string(),
  kind: directorAssetKindSchema,
  sourceType: directorAssetSourceTypeSchema,
  fileName: z.string(),
  status: z.enum(["resolved", "missing", "unsupported"]),
  sourcePath: z.string().optional(),
  message: z.string().optional(),
});

const directorDccObjectSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    kind: directorAssetKindSchema,
    visible: z.boolean(),
    color: z.string().optional(),
    geometryType: z.enum(["box", "sphere", "cylinder", "torus", "cone", "pyramid"]).optional(),
    assetRefId: z.string().optional(),
    sourcePath: z.string().optional(),
    parentObjectId: z.string().optional(),
    transform: directorDccTransformSchema,
    animation: z.array(directorDccAnimationKeyframeSchema),
    /**
     * The character's resolved portable pose-control values at export time
     * (preset merged with overrides). The Blender bridge stamps these as
     * editable per-control custom properties so a reviewed return can carry
     * a `pose_update` back to the same Director character binding.
     */
    poseControls: z.record(z.string(), finite).optional(),
  })
  .superRefine((object, context) => {
    if (object.kind === "character" && !object.assetRefId) {
      context.addIssue({
        code: "custom",
        path: ["assetRefId"],
        message: "DCC character objects must retain a concrete Director assetRefId",
      });
    }
  });

const directorDccCameraSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  transform: directorDccTransformSchema,
  target: vec3,
  focalLengthMm: finite.positive(),
  sensorWidthMm: finite.positive(),
  sensorHeightMm: finite.positive(),
  /** Director sensor gate id; optional so pre-optics-return packages still parse. */
  sensorFormat: z.enum(DIRECTOR_CAMERA_SENSOR_FORMATS).optional(),
  apertureFStop: finite.positive(),
  focusDistanceM: finite.positive(),
  shutterAngle: finite.min(0).max(360),
  iso: finite.positive(),
  nearClipM: finite.positive(),
  farClipM: finite.positive(),
  anamorphicSqueeze: finite.min(1).max(2.5),
  aspectRatio: directorCameraAspectRatioSchema,
  animation: z.array(directorDccAnimationKeyframeSchema),
});

/** Director light types that map onto a concrete Blender light datablock. */
export const DIRECTOR_DCC_EXPORTABLE_LIGHT_TYPES = ["directional", "point", "spot", "rect-area"] as const;

/**
 * Deterministic Director-intensity → Blender-watts factors per light type.
 * The factor is stamped into the exported package (and onto the Blender
 * light) so the return exporter inverts the exact same mapping; the absolute
 * values only affect preview brightness, never roundtrip fidelity.
 * `directional` maps to Blender SUN irradiance (W/m²), the rest to watts.
 */
export const DIRECTOR_DCC_LIGHT_WATTS_PER_INTENSITY: Record<
  (typeof DIRECTOR_DCC_EXPORTABLE_LIGHT_TYPES)[number],
  number
> = {
  directional: 1,
  point: 50,
  spot: 50,
  "rect-area": 100,
};

const directorDccLightSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.enum(DIRECTOR_DCC_EXPORTABLE_LIGHT_TYPES),
  /** Wire-space world position (Blender Z-up for Blender packages). */
  position: vec3,
  /** Wire-space world point the light is aimed at (directional/spot/rect-area). */
  target: vec3.optional(),
  color: z.string(),
  /** Director light intensity (0-100). */
  intensity: finite.min(0).max(100),
  /** Precomputed Blender energy: intensity × wattsPerIntensity. */
  energy: finite.nonnegative(),
  /** The deterministic factor used to invert energy back to Director intensity. */
  wattsPerIntensity: finite.positive(),
  /** Spot half-angle in radians (Director convention; Blender spot_size is 2×). */
  angleRad: finite
    .positive()
    .max(Math.PI / 2)
    .optional(),
  penumbra: finite.min(0).max(1).optional(),
  /** Rect-area gate in metres. */
  widthM: finite.positive().optional(),
  heightM: finite.positive().optional(),
  castShadow: z.boolean(),
  visible: z.boolean(),
});

/** A single light record in a DCC scene package. */
export type DirectorDccLight = z.infer<typeof directorDccLightSchema>;

/**
 * Complete DCC scene package schema.
 *
 * The serialization format sent from Director to a DCC tool (e.g. Blender).
 * It carries the full project state in a DCC-friendly coordinate system
 * along with asset resolution metadata.
 */
export const directorDccScenePackageSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    contract: z.literal(DIRECTOR_DCC_SCENE_CONTRACT),
    packageId: z.string(),
    sourceRevision: z.string(),
    coordinateSystem: z.strictObject({
      source: z.literal("right-handed-y-up-negative-z-forward"),
      destination: z.literal("right-handed-z-up-negative-z-camera-forward"),
      unit: z.literal("meter"),
      linearMap: z.literal("(x,y,z)->(x,-z,y)"),
    }),
    timeline: z.strictObject({
      fps: finite.positive(),
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
      frameStart: finite,
      frameEnd: finite,
      currentFrame: finite,
    }),
    scene: z.strictObject({
      backgroundColor: z.string(),
      showGround: z.boolean(),
      groundHeight: finite,
      groundOpacity: finite.min(0).max(1),
    }),
    assets: z.array(directorDccAssetSchema),
    objects: z.array(directorDccObjectSchema),
    cameras: z.array(directorDccCameraSchema),
    /** Director lights with a Blender-mappable type; optional so older packages parse. */
    lights: z.array(directorDccLightSchema).optional(),
    activeCameraId: z.string().nullable(),
    warnings: z.array(z.string()),
  })
  .superRefine((scenePackage, context) => {
    const assetsById = new Map(scenePackage.assets.map((asset) => [asset.id, asset]));
    scenePackage.objects.forEach((object, index) => {
      if (object.kind !== "character" || !object.assetRefId) return;
      const asset = assetsById.get(object.assetRefId);
      if (!asset || asset.kind !== "character" || asset.sourceType !== "model") {
        context.addIssue({
          code: "custom",
          path: ["objects", index, "assetRefId"],
          message: `DCC character assetRefId "${object.assetRefId}" must resolve to a character model asset`,
        });
      }
    });
  });

/** Inferred type for a validated DCC scene package. */
export type DirectorDccScenePackage = z.infer<typeof directorDccScenePackageSchema>;
/** Inferred type for a validated DCC asset descriptor. */
export type DirectorDccAsset = z.infer<typeof directorDccAssetSchema>;

/** Discriminated union of all DCC operations the gateway accepts. */
export const directorDccOperationSchema = z.discriminatedUnion("op", [
  strictOperation("discover", {}),
  strictOperation("status", {
    provider: directorDccProviderIdSchema.optional(),
  }),
  strictOperation("export_exchange_package", {
    provider: directorDccProviderIdSchema,
    formats: z.array(directorDccPortableExchangeFormatSchema).min(1).max(2).optional(),
    camera_id: z.string().trim().min(1).max(160).optional(),
    frame: z.number().finite().nonnegative().optional(),
  }),
  strictOperation("export_blend", {
    render_preview: z.boolean().optional().default(false),
    camera_id: z.string().trim().min(1).max(160).optional(),
    frame: z.number().finite().nonnegative().optional(),
  }),
  strictOperation("send_to_engine", {
    provider: directorDccEngineIdSchema,
    formats: z.array(directorDccPortableExchangeFormatSchema).min(1).max(2).optional(),
    camera_id: z.string().trim().min(1).max(160).optional(),
    frame: z.number().finite().nonnegative().optional(),
    /** Unreal-only: also render one clean still (no gizmos/labels) and attach its receipt. */
    clean_frame: z.boolean().optional(),
  }),
  strictOperation("receive_from_engine", {
    provider: directorDccEngineIdSchema,
    package_dir: z.string().trim().min(1).max(2_048),
    dry_run: z.boolean().optional().default(true),
    /**
     * Opt in to planning `object_addition` changes (engine objects stamped
     * with a fresh director_id after the export snapshot). Off by default:
     * Director never auto-imports new engine objects without review. The
     * Director-authored connectors emit transform-only returns today, so this
     * only matters for hand-authored or third-party return packages.
     */
    include_new_objects: z.boolean().optional().default(false),
  }),
  strictOperation("import_return_package", {
    package_dir: z.string().trim().min(1).max(2_048),
    dry_run: z.boolean().optional().default(true),
    /**
     * Opt in to planning `object_addition` changes (objects that gained a
     * fresh director_id in the DCC after the export snapshot). Off by
     * default: Director never auto-imports new DCC objects without review.
     */
    include_new_objects: z.boolean().optional().default(false),
  }),
  strictOperation("apply_import_plan", {
    plan: directorDccImportPlanSchema,
    /** Connector provider whose job root holds the return package (defaults to blender). */
    provider: directorDccConnectorProviderIdSchema.optional(),
    expected_revision: z.string().trim().min(1).max(240),
    idempotency_key: z.string().trim().min(1).max(240),
  }),
  strictOperation("preview_blend_scene_import", {
    package_dir: z.string().trim().min(1).max(2_048),
    selection: directorBlendSceneImportSelectionSchema.optional(),
  }),
  strictOperation("apply_blend_scene_import", {
    plan_id: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
        { message: "plan_id must be a safe relative identifier" },
      ),
    expected_revision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    idempotency_key: z.string().trim().min(1).max(240),
  }),
  strictOperation("preview_engine_scene_import", {
    provider: directorEngineSceneProviderSchema,
    package_dir: z.string().trim().min(1).max(2_048),
    selection: directorEngineSceneImportSelectionSchema.optional(),
  }),
  strictOperation("apply_engine_scene_import", {
    plan_id: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
        { message: "plan_id must be a safe relative identifier" },
      ),
    expected_revision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    idempotency_key: z.string().trim().min(1).max(240),
  }),
  strictOperation("extract_engine_scene", {
    provider: directorEngineSceneProviderSchema,
    project_dir: z.string().trim().min(1).max(2_048),
    scene: z.string().trim().min(1).max(512).optional(),
  }),
  strictOperation("start_engine_session", {
    provider: z.enum(["unity", "godot", "unreal"]),
    label: z.string().trim().min(1).max(120).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    allow_code: z.boolean().optional().default(false),
    authority: z.enum(["director", "engine"]).optional().default("director"),
  }),
  strictOperation("engine_session_command", {
    provider: z.enum(["unity", "godot", "unreal"]),
    session_id: z.string().trim().min(1).max(240),
    command: z.enum(["capture_frame", "execute_code", "sync_scene"]),
    camera: z.string().trim().min(1).max(240).optional(),
    width: z.number().int().min(64).max(1_920).optional(),
    height: z.number().int().min(64).max(1_080).optional(),
    code: z.string().min(1).max(100_000).optional(),
  }),
  strictOperation("engine_session_command_status", {
    provider: z.enum(["unity", "godot", "unreal"]),
    session_id: z.string().trim().min(1).max(240),
    command_id: z.string().trim().min(1).max(240),
  }),
  strictOperation("stop_engine_session", {
    provider: z.enum(["unity", "godot", "unreal"]),
    session_id: z.string().trim().min(1).max(240),
  }),
  strictOperation("sync_engine_session_to_director", {
    provider: z.enum(["unity", "godot", "unreal"]),
    session_id: z.string().trim().min(1).max(240),
    command_id: z.string().trim().min(1).max(240),
    expected_revision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    idempotency_key: z.string().trim().min(1).max(240),
  }),
  strictOperation("launch_engine_editor", {
    provider: directorDccEngineIdSchema,
  }),
  strictOperation("run_engine_project", {
    provider: directorDccEngineIdSchema,
    /** Godot-only today: a res:// scene inside the configured project (defaults to the main scene). */
    scene: directorDccGodotRunSceneSchema.optional(),
    /** Run without a window; output capture is unchanged. */
    headless: z.boolean().optional(),
  }),
  strictOperation("engine_run_status", {
    provider: directorDccEngineIdSchema,
  }),
  strictOperation("stop_engine_project", {
    provider: directorDccEngineIdSchema,
  }),
  strictOperation("render_engine_frame", {
    provider: directorDccEngineIdSchema,
    /** Unreal: required send-job id (renders that job's imported level); Unity: optional (resolves the imported scene). */
    job_id: z.string().trim().min(1).max(240).optional(),
    /** Godot: res:// scene (defaults to the main scene); Unity: project scene path. */
    scene: z.string().trim().min(1).max(1_024).optional(),
    /** Unreal: Director camera id; Unity: camera object name. */
    camera: z.string().trim().min(1).max(240).optional(),
    width: z.number().int().min(64).max(1_920).optional(),
    height: z.number().int().min(64).max(1_080).optional(),
    /** Unreal-only: the Director timeline frame to scrub to before rendering. */
    frame: z.number().int().nonnegative().max(1_000_000).optional(),
  }),
]);

/** Inferred type for a DCC operation. */
export type DirectorDccOperation = z.infer<typeof directorDccOperationSchema>;

const DIRECTOR_TO_BLENDER_BASIS = new Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
const BLENDER_TO_DIRECTOR_BASIS = DIRECTOR_TO_BLENDER_BASIS.clone().invert();

function matrixFromTransform(transform: DirectorTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
}

function sceneAsTransform(project: DirectorProject): DirectorTransform {
  return {
    position: project.scene.position,
    rotation: project.scene.rotation,
    scale: [project.scene.scale, project.scene.scale, project.scene.scale],
  };
}

function tuple3(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function tuple4(value: Quaternion): [number, number, number, number] {
  return [value.x, value.y, value.z, value.w];
}

/**
 * Converts a point from Director's coordinate system to Blender's.
 *
 * Director: right-handed, Y-up, -Z-forward.
 * Blender:  right-handed, Z-up, -Z-camera-forward.
 *
 * @param point - A point in Director space [x, y, z].
 * @returns The same point in Blender space.
 */
export function directorPointToBlender(point: [number, number, number]): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(DIRECTOR_TO_BLENDER_BASIS));
}

/**
 * Converts a point from Blender's coordinate system to Director's.
 *
 * @param point - A point in Blender space [x, y, z].
 * @returns The same point in Director space.
 */
export function blenderPointToDirector(point: [number, number, number]): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(BLENDER_TO_DIRECTOR_BASIS));
}

/**
 * Converts a Director transform (Euler-rotation) to a DCC transform
 * (quaternion-rotation) in Blender's coordinate system.
 *
 * @param transform - A Director transform with Euler rotation.
 * @param sceneTransform - Optional scene-level transform to compose.
 * @returns A DCC transform with quaternion rotation.
 */
export function directorTransformToBlender(
  transform: DirectorTransform,
  sceneTransform?: DirectorTransform,
): DirectorDccTransform {
  const directorMatrix = sceneTransform
    ? matrixFromTransform(sceneTransform).multiply(matrixFromTransform(transform))
    : matrixFromTransform(transform);
  const blenderMatrix = DIRECTOR_TO_BLENDER_BASIS.clone().multiply(directorMatrix).multiply(BLENDER_TO_DIRECTOR_BASIS);
  const location = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  blenderMatrix.decompose(location, rotation, scale);
  return { location: tuple3(location), rotationQuaternion: tuple4(rotation.normalize()), scale: tuple3(scale) };
}

/**
 * Converts a DCC transform (quaternion-rotation) back to a Director
 * transform (Euler-rotation).
 *
 * @param transform - A DCC transform with quaternion rotation.
 * @param sceneTransform - Optional scene-level transform to factor out.
 * @returns A Director transform with Euler rotation.
 */
export function blenderTransformToDirector(
  transform: DirectorDccTransform,
  sceneTransform?: DirectorTransform,
): DirectorTransform {
  const parsed = directorDccTransformSchema.parse(transform);
  const blenderMatrix = new Matrix4().compose(
    new Vector3(...parsed.location),
    new Quaternion(...parsed.rotationQuaternion).normalize(),
    new Vector3(...parsed.scale),
  );
  const directorWorldMatrix = BLENDER_TO_DIRECTOR_BASIS.clone()
    .multiply(blenderMatrix)
    .multiply(DIRECTOR_TO_BLENDER_BASIS);
  const directorMatrix = sceneTransform
    ? matrixFromTransform(sceneTransform).invert().multiply(directorWorldMatrix)
    : directorWorldMatrix;
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  directorMatrix.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation.normalize(), "XYZ");
  return {
    position: tuple3(position),
    rotation: [euler.x, euler.y, euler.z],
    scale: tuple3(scale),
  };
}

/**
 * Converts a world-space point in Director to Blender's coordinate system,
 * applying the scene transform first.
 *
 * @param point - A world-space point in Director.
 * @param sceneTransform - The scene's transform.
 * @returns The point in Blender space.
 */
export function directorWorldPointToBlender(
  point: [number, number, number],
  sceneTransform: DirectorTransform,
): [number, number, number] {
  const directorWorld = new Vector3(...point).applyMatrix4(matrixFromTransform(sceneTransform));
  return tuple3(directorWorld.applyMatrix4(DIRECTOR_TO_BLENDER_BASIS));
}

/**
 * Convert a Blender world-space point back to Director coordinates,
 * inverting the scene transform to recover the scene-local position.
 * Exact inverse of {@link directorWorldPointToBlender}.
 *
 * @param point - A world-space point in Blender coordinates.
 * @param sceneTransform - The scene transform to invert.
 * @returns The point in Director scene-local coordinates.
 */
export function blenderWorldPointToDirector(
  point: [number, number, number],
  sceneTransform: DirectorTransform,
): [number, number, number] {
  const directorWorld = new Vector3(...point).applyMatrix4(BLENDER_TO_DIRECTOR_BASIS);
  return tuple3(directorWorld.applyMatrix4(matrixFromTransform(sceneTransform).invert()));
}

/** Resolution status for a single asset during DCC package construction. */
export type DirectorDccAssetResolution = {
  status: "resolved" | "missing" | "unsupported";
  sourcePath?: string;
  message?: string;
};

/** Options for building a DCC scene export package. */
export interface BuildDirectorDccPackageOptions {
  /** Resolves an asset reference to its filesystem status. */
  resolveAsset: (asset: DirectorAssetRef) => DirectorDccAssetResolution;
  /** Optional camera to mark as active in the export. */
  cameraId?: string;
  /** Optional frame to snapshot for the export. */
  frame?: number;
}

function animationKeyframes(
  keyframes: DirectorAnimationKeyframe[] | undefined,
  sceneTransform: DirectorTransform,
): DirectorDccScenePackage["objects"][number]["animation"] {
  return (keyframes ?? []).map((keyframe) => ({
    frame: keyframe.frame,
    interpolation: keyframe.interpolation ?? "linear",
    ...(keyframe.transform ? { transform: directorTransformToBlender(keyframe.transform, sceneTransform) } : {}),
    ...(keyframe.lookTarget ? { lookTarget: directorWorldPointToBlender(keyframe.lookTarget, sceneTransform) } : {}),
    ...(keyframe.poseValues ? { poseValues: { ...keyframe.poseValues } } : {}),
  }));
}

function resolvedAssetRecord(asset: DirectorAssetRef, resolution: DirectorDccAssetResolution): DirectorDccAsset {
  return {
    id: asset.id,
    kind: asset.kind,
    sourceType: asset.sourceType,
    fileName: asset.fileName,
    status: resolution.status,
    ...(resolution.sourcePath ? { sourcePath: resolution.sourcePath } : {}),
    ...(resolution.message ? { message: resolution.message } : {}),
  };
}

function buildDccObject(
  object: DirectorObject,
  project: DirectorProject,
  assetById: Map<string, DirectorDccAsset>,
): DirectorDccScenePackage["objects"][number] {
  const sceneTransform = sceneAsTransform(project);
  const asset = object.assetRefId ? assetById.get(object.assetRefId) : undefined;
  const sourcePath = asset?.sourcePath;
  const poseControls =
    object.kind === "character" && object.characterRig ? resolveCharacterPoseControls(object.characterRig) : undefined;
  return {
    id: object.id,
    name: object.name,
    kind: object.kind === "camera" ? "prop" : object.kind,
    visible: object.visible,
    ...(object.color ? { color: object.color } : {}),
    ...(object.geometryType ? { geometryType: object.geometryType } : {}),
    ...(object.assetRefId ? { assetRefId: object.assetRefId } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(object.parentObjectId ? { parentObjectId: object.parentObjectId } : {}),
    transform: directorTransformToBlender(object.transform, sceneTransform),
    animation: animationKeyframes(object.animation?.keyframes, sceneTransform),
    ...(poseControls && Object.keys(poseControls).length ? { poseControls: { ...poseControls } } : {}),
  };
}

function isExportableLightType(type: DirectorLight["type"]): type is DirectorDccLight["type"] {
  return (DIRECTOR_DCC_EXPORTABLE_LIGHT_TYPES as readonly string[]).includes(type);
}

/**
 * Build the DCC record of one Director light, or a warning when the light
 * cannot be represented as a Blender light datablock. Ambient and hemisphere
 * lights are environment terms, not objects; they stay authoritative in
 * Director (Preserve) and are reported, never silently flattened.
 */
function buildDccLight(
  light: DirectorLight,
  project: DirectorProject,
): { light: DirectorDccLight } | { warning: string } {
  if (!isExportableLightType(light.type)) {
    return {
      warning: `Light ${light.id} (${light.type}) has no Blender light-object equivalent; it stays authoritative in Director and is not exported.`,
    };
  }
  if (!light.position) {
    return {
      warning: `Light ${light.id} (${light.type}) has no position; it stays authoritative in Director and is not exported.`,
    };
  }
  const sceneTransform = sceneAsTransform(project);
  const wattsPerIntensity = DIRECTOR_DCC_LIGHT_WATTS_PER_INTENSITY[light.type];
  return {
    light: {
      id: light.id,
      name: light.name,
      type: light.type,
      position: directorWorldPointToBlender(light.position, sceneTransform),
      ...(light.target ? { target: directorWorldPointToBlender(light.target, sceneTransform) } : {}),
      color: light.color,
      intensity: light.intensity,
      energy: light.intensity * wattsPerIntensity,
      wattsPerIntensity,
      ...(light.type === "spot" && light.angle !== undefined ? { angleRad: light.angle } : {}),
      ...(light.type === "spot" && light.penumbra !== undefined ? { penumbra: light.penumbra } : {}),
      ...(light.type === "rect-area" && light.width !== undefined ? { widthM: light.width } : {}),
      ...(light.type === "rect-area" && light.height !== undefined ? { heightM: light.height } : {}),
      castShadow: light.castShadow ?? false,
      visible: light.visible,
    },
  };
}

function buildDccCamera(camera: DirectorCameraShot, project: DirectorProject) {
  const optics = normalizeDirectorCameraOptics(camera);
  const aspectRatio = camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const sensorFormat = camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const sensor = getDirectorCameraSensorGate(sensorFormat);
  const focalLengthMm = camera.focalLengthMm ?? getFocalLengthFromVerticalFov(camera.fov, aspectRatio, sensorFormat);
  const sceneTransform = sceneAsTransform(project);
  const animation = animationKeyframes(camera.animation?.keyframes, sceneTransform).map((keyframe, index) => {
    const source = camera.animation?.keyframes[index];
    return source?.fov === undefined
      ? keyframe
      : {
          ...keyframe,
          focalLengthMm: getFocalLengthFromVerticalFov(source.fov, aspectRatio, sensorFormat),
        };
  });
  return {
    id: camera.id,
    name: camera.name,
    transform: directorTransformToBlender(camera.transform, sceneTransform),
    target: directorWorldPointToBlender(camera.target, sceneTransform),
    focalLengthMm,
    sensorWidthMm: sensor.width,
    sensorHeightMm: sensor.height,
    sensorFormat,
    apertureFStop: optics.apertureFStop,
    focusDistanceM: optics.focusDistanceM,
    shutterAngle: optics.shutterAngle,
    iso: optics.iso,
    nearClipM: optics.nearClipM,
    farClipM: optics.farClipM,
    anamorphicSqueeze: optics.anamorphicSqueeze,
    aspectRatio,
    animation,
  } satisfies DirectorDccScenePackage["cameras"][number];
}

/**
 * Builds a validated DCC scene package from a Director project.
 *
 * Validates the project against the Director schema, resolves all assets
 * through the provided callback, converts coordinate systems, and produces
 * a complete package ready for DCC consumption.
 *
 * @param projectInput - The raw Director project to export.
 * @param options - Asset resolution and export options.
 * @returns A fully validated `DirectorDccScenePackage`.
 * @throws If the project has invalid character bindings or the export frame is out of range.
 */
export function buildDirectorDccScenePackage(
  projectInput: DirectorProject,
  options: BuildDirectorDccPackageOptions,
): DirectorDccScenePackage {
  const project = directorProjectSchema.parse(projectInput) as DirectorProject;
  const characterBindingIssues = getDirectorCharacterAssetBindingIssues(project);
  if (characterBindingIssues.length) {
    throw new Error(
      `DCC export rejected invalid character asset bindings: ${characterBindingIssues.slice(0, 8).join("; ")}`,
    );
  }
  const revision = getDirectorProjectRevision(project);
  const timeline = project.scene.timeline ?? {
    version: 1 as const,
    fps: 24,
    frameStart: 0,
    frameEnd: 120,
    currentFrame: 0,
    loop: false,
  };
  const currentFrame = options.frame ?? timeline.currentFrame;
  const timebase = normalizeDirectorTimebase(timeline.timebase, timeline.fps);
  if (currentFrame < timeline.frameStart || currentFrame > timeline.frameEnd) {
    throw new Error(`DCC export frame ${currentFrame} is outside ${timeline.frameStart}-${timeline.frameEnd}.`);
  }

  const resolutions = new Map(project.assets.map((asset) => [asset.id, options.resolveAsset(asset)]));
  const assets = project.assets.map((asset) => resolvedAssetRecord(asset, resolutions.get(asset.id)!));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const warnings = assets
    .filter((asset) => asset.status !== "resolved")
    .map((asset) => `Asset ${asset.id} (${asset.fileName}) was not resolved: ${asset.message ?? asset.status}.`);
  const objects = project.objects
    .filter((object) => object.kind !== "camera")
    .map((object) => {
      if (object.characterRig && object.animation?.keyframes.some((keyframe) => keyframe.poseValues)) {
        warnings.push(
          `Character ${object.id} pose controls are preserved as metadata but are not baked to bones in bridge v1.`,
        );
      }
      return buildDccObject(object, project, assetById);
    });
  const requestedCameraId = options.cameraId ?? project.activeCameraId;
  if (requestedCameraId && !project.cameras.some((camera) => camera.id === requestedCameraId)) {
    throw new Error(`DCC export camera "${requestedCameraId}" does not exist.`);
  }

  const lights: DirectorDccLight[] = [];
  for (const light of project.lights ?? []) {
    const built = buildDccLight(light, project);
    if ("warning" in built) warnings.push(built.warning);
    else lights.push(built.light);
  }

  const sceneTransform = sceneAsTransform(project);
  return directorDccScenePackageSchema.parse({
    schemaVersion: 1,
    contract: DIRECTOR_DCC_SCENE_CONTRACT,
    packageId: `director-dcc:${revision.slice(-24)}:${currentFrame}`,
    sourceRevision: revision,
    coordinateSystem: {
      source: "right-handed-y-up-negative-z-forward",
      destination: "right-handed-z-up-negative-z-camera-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,-z,y)",
    },
    timeline: {
      // Keep the decimal field for director-dcc-scene-v1 consumers while
      // carrying the exact rational rate for Blender and other DCCs.
      fps: timebase.rate.numerator / timebase.rate.denominator,
      timebase,
      frameStart: timeline.frameStart,
      frameEnd: timeline.frameEnd,
      currentFrame,
    },
    scene: {
      backgroundColor: project.scene.backgroundColor,
      showGround: project.scene.showGround,
      groundHeight: directorWorldPointToBlender([0, project.scene.groundHeight, 0], sceneTransform)[2],
      groundOpacity: project.scene.groundOpacity,
    },
    assets,
    objects,
    cameras: project.cameras.map((camera) => buildDccCamera(camera, project)),
    lights,
    activeCameraId: requestedCameraId ?? project.cameras[0]?.id ?? null,
    warnings,
  });
}
