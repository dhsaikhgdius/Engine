import { z } from "zod";
import { directorCameraAspectRatioSchema } from "@director/protocol/directorCameraProtocol";
import {
  stageCameraMoveSchema,
  stageCameraShakeSchema,
  stageGeometryKindSchema,
  stageLocomotionGaitSchema,
  stageTurnDirectionSchema,
} from "@director/protocol/stageProtocol";

const finiteNumber = z.number().finite();
const vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const baseObject = {
  name: z.string().optional(),
  position: vec3,
  rotation: vec3,
  scale: vec3,
  color: z.string().optional(),
  parentId: z.string().optional(),
};

const stageObjectSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...baseObject,
    kind: z.literal("humanoid"),
    animation: z.strictObject({ clip: z.string(), playing: z.boolean() }),
    pose: z.string().optional(),
  }),
  z.strictObject({
    ...baseObject,
    kind: z.literal("camera"),
    targetId: z.string(),
    focalLengthMm: finiteNumber,
    shake: stageCameraShakeSchema,
  }),
  z.strictObject({ ...baseObject, kind: z.literal("target") }),
  z.strictObject({
    ...baseObject,
    kind: stageGeometryKindSchema,
  }),
  z.strictObject({
    ...baseObject,
    kind: z.literal("image"),
    imageDataUrl: z.string(),
    depth: finiteNumber,
  }),
  z.strictObject({ ...baseObject, kind: z.literal("prop"), propKey: z.string() }),
  z.strictObject({ ...baseObject, kind: z.literal("group") }),
]);

const itemBase = {
  id: z.string(),
  startS: finiteNumber,
  durationS: finiteNumber,
};

const stageItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...itemBase,
    kind: z.literal("cam-move"),
    move: stageCameraMoveSchema,
    subjectId: z.string().nullable(),
    direction: stageTurnDirectionSchema,
    angleDeg: finiteNumber,
    heightDeltaUnits: finiteNumber,
    distanceScale: finiteNumber,
    focalLengthMm: finiteNumber.optional(),
  }),
  z.strictObject({ ...itemBase, kind: z.literal("cam-still"), focalLengthMm: finiteNumber.optional() }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("cam-path"),
    points: z.array(vec3),
    speedUnitsPerS: finiteNumber,
    aim: z.enum(["travel", "subject", "locked"]),
    subjectId: z.string().nullable(),
  }),
  z.strictObject({ ...itemBase, kind: z.literal("cam-follow"), objectId: z.string().nullable() }),
  z.strictObject({ ...itemBase, kind: z.enum(["cam-transform", "cam-manual"]) }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("transform"),
    keys: z.array(
      z.strictObject({
        tS: finiteNumber,
        position: vec3,
        rotation: vec3,
        scale: vec3,
      }),
    ),
  }),
  z.strictObject({ ...itemBase, kind: z.literal("clip"), clip: z.string(), loop: z.boolean().optional() }),
  z.strictObject({
    ...itemBase,
    kind: z.literal("path"),
    points: z.array(vec3),
    speedUnitsPerS: finiteNumber,
    gait: stageLocomotionGaitSchema,
  }),
]);

function stripLegacyStageVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { v: _legacyVersion, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Runtime validation for untrusted HTTP and persisted Stage scene JSON. */
export const stageSceneSchema = z.strictObject({
  objects: z.record(z.string(), stageObjectSchema),
  show: z.strictObject({
    name: z.string(),
    tracks: z.array(
      z.strictObject({
        id: z.string(),
        characterId: z.string(),
        items: z.array(stageItemSchema),
      }),
    ),
  }),
  recordAspect: directorCameraAspectRatioSchema,
});

/** Parsed Stage scene, including objects, show tracks, and record aspect ratio. */
export type StageScene = z.infer<typeof stageSceneSchema>;

/** Any object in the Stage scene. */
export type StageObject = StageScene["objects"][string];

/** The kind discriminator for Stage objects. */
export type StageObjectKind = StageObject["kind"];

/** A 3D vector tuple [x, y, z]. */
export type Vec3 = StageObject["position"];

/** The common base fields shared by all Stage objects. */
export type BaseStageObject = Pick<
  StageObject,
  "kind" | "name" | "position" | "rotation" | "scale" | "color" | "parentId"
>;
/** A humanoid character with animation and optional pose. */
export type HumanoidObject = Extract<StageObject, { kind: "humanoid" }>;

/** A camera object with target, focal length, and shake settings. */
export type CameraObject = Extract<StageObject, { kind: "camera" }>;

/** A target object used as a look-at or follow point. */
export type TargetObject = Extract<StageObject, { kind: "target" }>;

/** A primitive geometry object (cube, sphere, cylinder, etc.). */
export type PrimitiveObject = Extract<
  StageObject,
  { kind: "cube" | "sphere" | "cylinder" | "cone" | "plane" | "torus" | "pyramid" }
>;
/** An image reference object with a data URL and depth. */
export type ImageReferenceObject = Extract<StageObject, { kind: "image" }>;

/** A prop object identified by its prop key. */
export type PropObject = Extract<StageObject, { kind: "prop" }>;

/** A group object that can contain child objects. */
export type GroupObject = Extract<StageObject, { kind: "group" }>;

/** A single track in the show, containing a sequence of items for one character. */
export type StageTrack = StageScene["show"]["tracks"][number];

/** Any item on a Stage track. */
export type StageItem = StageTrack["items"][number];

/** Common base fields for all track items. */
export type ItemBase = Pick<StageItem, "id" | "startS" | "durationS">;

/** A camera movement item. */
export type CameraMoveItem = Extract<StageItem, { kind: "cam-move" }>;

/** A static camera still item. */
export type CameraStillItem = Extract<StageItem, { kind: "cam-still" }>;

/** A camera path item with waypoints. */
export type CameraPathItem = Extract<StageItem, { kind: "cam-path" }>;

/** A camera follow item tracking an object. */
export type CameraFollowItem = Extract<StageItem, { kind: "cam-follow" }>;

/** A camera transform or manual control item. */
export type CameraTransformItem = Extract<StageItem, { kind: "cam-transform" | "cam-manual" }>;

/** A transform keyframe animation item. */
export type TransformItem = Extract<StageItem, { kind: "transform" }>;

/** A single keyframe within a transform item. */
export type TransformKeyframe = TransformItem["keys"][number];

/** A clip (animation) playback item. */
export type ClipItem = Extract<StageItem, { kind: "clip" }>;

/** A locomotion path item. */
export type PathItem = Extract<StageItem, { kind: "path" }>;

/**
 * Parse and validate an untrusted value as a Stage scene.
 * Strips legacy `v` version fields before validation.
 *
 * @param value - The untrusted input to parse.
 * @returns Either a success with the parsed scene, or a failure with an error message.
 */
export function parseStageScene(
  value: unknown,
): { success: true; scene: StageScene } | { success: false; error: string } {
  const result = stageSceneSchema.safeParse(stripLegacyStageVersion(value));
  if (result.success) return { success: true, scene: result.data as StageScene };

  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "scene";
  return { success: false, error: `场景数据无效：${path} ${issue?.message ?? "格式错误"}` };
}
