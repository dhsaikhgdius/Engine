import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { z } from "zod";
import {
  DIRECTOR_PROJECT_REVISION_PATTERN,
  getDirectorProjectRevision,
} from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";
import {
  directorAssetKindSchema,
  directorAssetSourceTypeSchema,
  directorProjectSchema,
} from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectSchema";
import { getDirectorCharacterAssetBindingIssues } from "../../../frontend/director/src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog";
import type {
  DirectorAnimationKeyframe,
  DirectorAssetRef,
  DirectorCameraShot,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
} from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorCameraSensorGate,
  getFocalLengthFromVerticalFov,
  normalizeDirectorCameraOptics,
} from "../../../frontend/director/src/comprehensive/editor/schema/cameraGeometry";
import { normalizeDirectorTimebase } from "../../../frontend/director/src/comprehensive/editor/timeline/frameRate";
import {
  directorDccFiniteSchema,
  directorDccTransformSchema,
  directorDccVec3Schema,
  type DirectorDccTransform,
} from "./directorDccSharedContract";
import { directorDccImportPlanSchema } from "./directorDccReturnContract";
import { directorBlendSceneImportSelectionSchema } from "./directorBlendSceneImportContract";
import { strictOperation } from "@director/protocol/strictProtocolVariant";
import { directorCameraAspectRatioSchema } from "@director/protocol/directorCameraProtocol";
import { directorDccPortableExchangeFormatSchema, directorDccProviderIdSchema } from "./directorDccProviderContract";

export { directorDccTransformSchema } from "./directorDccSharedContract";
export type { DirectorDccTransform } from "./directorDccSharedContract";

/** Contract identifier for the DCC scene package. */
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

/** A DCC asset record with resolution status, representing a single asset in the exchange package. */
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

/**
 * The full DCC scene package, containing the scene, assets, objects, cameras,
 * timeline, coordinate system mapping, and any warnings from the export process.
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

/** A DCC scene package (v1). */
export type DirectorDccScenePackage = z.infer<typeof directorDccScenePackageSchema>;

/** A single asset record in a DCC scene package. */
export type DirectorDccAsset = z.infer<typeof directorDccAssetSchema>;

/** Union of all DCC operations (discover, status, export, import, preview, apply). */
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
  strictOperation("import_return_package", {
    package_dir: z.string().trim().min(1).max(2_048),
    dry_run: z.boolean().optional().default(true),
  }),
  strictOperation("apply_import_plan", {
    plan: directorDccImportPlanSchema,
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
]);

/** A DCC operation (discover, status, export, import, preview, or apply). */
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
 * Convert a point from Director's right-handed Y-up coordinate system
 * to Blender's right-handed Z-up system.
 *
 * @param point - A 3D point in Director space (x, y, z).
 * @returns The same point expressed in Blender space.
 */
export function directorPointToBlender(point: [number, number, number]): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(DIRECTOR_TO_BLENDER_BASIS));
}

/**
 * Convert a point from Blender's right-handed Z-up coordinate system
 * to Director's right-handed Y-up system.
 *
 * @param point - A 3D point in Blender space (x, y, z).
 * @returns The same point expressed in Director space.
 */
export function blenderPointToDirector(point: [number, number, number]): [number, number, number] {
  return tuple3(new Vector3(...point).applyMatrix4(BLENDER_TO_DIRECTOR_BASIS));
}

/**
 * Convert a Director transform (Euler rotation, arbitrary scale) to a
 * Blender DCC transform (location, normalized quaternion, non-zero scale).
 * Optionally includes the scene transform for world-space conversion.
 *
 * @param transform - The Director transform to convert.
 * @param sceneTransform - Optional scene-level transform to apply.
 * @returns A DCC-native transform in Blender coordinates.
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
 * Convert a Blender DCC transform back to a Director transform (Euler rotation).
 * Optionally inverts the scene transform to recover local-space coordinates.
 *
 * @param transform - The DCC-native transform from Blender.
 * @param sceneTransform - Optional scene-level transform to invert.
 * @returns A Director transform with Euler rotation in XYZ order.
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
 * Convert a world-space point from Director coordinates to Blender coordinates,
 * applying the scene transform to get the world-space position first.
 *
 * @param point - A world-space point in Director coordinates.
 * @param sceneTransform - The scene transform to apply.
 * @returns The point in Blender world coordinates.
 */
export function directorWorldPointToBlender(
  point: [number, number, number],
  sceneTransform: DirectorTransform,
): [number, number, number] {
  const directorWorld = new Vector3(...point).applyMatrix4(matrixFromTransform(sceneTransform));
  return tuple3(directorWorld.applyMatrix4(DIRECTOR_TO_BLENDER_BASIS));
}

/** Resolution status for a single asset during DCC package building. */
export type DirectorDccAssetResolution = {
  status: "resolved" | "missing" | "unsupported";
  sourcePath?: string;
  message?: string;
};

/** Options for building a DCC scene package from a Director project. */
export interface BuildDirectorDccPackageOptions {
  resolveAsset: (asset: DirectorAssetRef) => DirectorDccAssetResolution;
  cameraId?: string;
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
 * Build a DCC scene package from a Director project.
 *
 * Resolves all assets, converts coordinates to Blender space, validates
 * character bindings, and assembles the full scene package with warnings
 * for any unresolved or incomplete assets.
 *
 * @param projectInput - The Director project to export.
 * @param options - Asset resolution, camera, and frame options.
 * @returns A validated DCC scene package ready for consumption by a DCC tool.
 * @throws If character bindings are invalid, the frame is out of range, or the camera does not exist.
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
    activeCameraId: requestedCameraId ?? project.cameras[0]?.id ?? null,
    warnings,
  });
}
