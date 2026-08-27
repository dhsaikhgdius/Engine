import { z } from "zod";
import { directorCameraAspectRatioSchema } from "@director/protocol/directorCameraProtocol";
import {
  stageCameraMoveSchema,
  stageCameraShakeSchema,
  stageGeometryKindSchema,
  stageLocomotionGaitSchema,
  stageTurnDirectionSchema,
} from "@director/protocol/stageProtocol";

/**
 * Wire schema for the Stage scene document — the single JSON shape shared by
 * the browser runtime, the gateway HTTP surface, and persisted project
 * revisions. Every scene that crosses a trust boundary (HTTP body, saved
 * file, agent tool argument) must pass this schema before use; in-memory
 * mutation code may then rely on the parsed invariants without re-checking.
 *
 * All object schemas are `strictObject` on purpose: unknown keys are a wire
 * error, not a forward-compat extension point, so schema evolution stays an
 * explicit, versioned decision rather than silent drift.
 */

// `finite()` everywhere: NaN/Infinity serialize to `null` in JSON and would
// otherwise round-trip into corrupted transforms.
const finiteNumber = z.number().finite();
/** [x, y, z] in Stage units (metres); rotations reuse the tuple as Euler radians. */
const vec3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const baseObject = {
  name: z.string().optional(),
  position: vec3,
  rotation: vec3,
  scale: vec3,
  /** Optional CSS hex colour for the clay/white-box look; renderer default applies when absent. */
  color: z.string().optional(),
  /** Id of the parent object for grouped hierarchies; absent means scene root. */
  parentId: z.string().optional(),
};

// One scene object, discriminated by `kind`. The variants deliberately carry
// only what the runtime needs to render and animate; richer authoring data
// (poses, animation recipes, production metadata) lives in the project schema
// and is resolved down to these primitives before hitting the Stage.
const stageObjectSchema = z.discriminatedUnion("kind", [
  // Animated character. `animation.clip` names a rig clip; `pose` optionally
  // pins a preset pose that overrides the clip's rest state.
  z.strictObject({
    ...baseObject,
    kind: z.literal("humanoid"),
    animation: z.strictObject({ clip: z.string(), playing: z.boolean() }),
    pose: z.string().optional(),
  }),
  // Physical camera: always aims at `targetId` (a target object id), so a
  // camera without a valid target is a scene integrity error, not a default.
  z.strictObject({
    ...baseObject,
    kind: z.literal("camera"),
    targetId: z.string(),
    focalLengthMm: finiteNumber,
    shake: stageCameraShakeSchema,
  }),
  // Invisible look-at / follow anchor referenced by cameras and moves.
  z.strictObject({ ...baseObject, kind: z.literal("target") }),
  // Primitive geometry; the allowed kinds come from the shared stage protocol
  // so the Stage and the gateway agree on the same vocabulary.
  z.strictObject({
    ...baseObject,
    kind: stageGeometryKindSchema,
  }),
  // Flat reference image placed in 3D. The image travels inline as a data URL
  // so a persisted scene stays self-contained; `depth` is the plane offset.
  z.strictObject({
    ...baseObject,
    kind: z.literal("image"),
    imageDataUrl: z.string(),
    depth: finiteNumber,
  }),
  // Catalog prop instanced by key (see PROP_CATALOG).
  z.strictObject({ ...baseObject, kind: z.literal("prop"), propKey: z.string() }),
  // Empty transform node that parents other objects via their `parentId`.
  z.strictObject({ ...baseObject, kind: z.literal("group") }),
]);

// Common timeline placement: `startS`/`durationS` are seconds on the show
// timeline. Items on one track may not assume any global ordering — overlap
// resolution is the player's concern, not the schema's.
const itemBase = {
  id: z.string(),
  startS: finiteNumber,
  durationS: finiteNumber,
};

// One show-track item, discriminated by `kind`. `cam-*` kinds drive the
// record camera; the rest animate the track's character. Subject/object ids
// are nullable rather than optional so "explicitly no subject" survives
// JSON round-trips distinctly from "field missing".
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
    // Where the camera looks while travelling: along the path ("travel"),
    // at `subjectId` ("subject"), or frozen at its starting aim ("locked").
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

/**
 * Older persisted scenes carried a numeric `v` version field that the strict
 * schema would now reject. Dropping it before validation keeps those saves
 * loadable without loosening the schema for everything else.
 */
function stripLegacyStageVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { v: _legacyVersion, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Runtime validation for untrusted HTTP and persisted Stage scene JSON. */
export const stageSceneSchema = z.strictObject({
  /** All scene objects keyed by stable object id; ids double as reference targets. */
  objects: z.record(z.string(), stageObjectSchema),
  /** The show: named timeline of per-character tracks driving playback and recording. */
  show: z.strictObject({
    name: z.string(),
    tracks: z.array(
      z.strictObject({
        id: z.string(),
        /** Object id of the humanoid (or camera owner) this track animates. */
        characterId: z.string(),
        items: z.array(stageItemSchema),
      }),
    ),
  }),
  /** Aspect ratio used when recording/rendering; constrained to the shared camera vocabulary. */
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
 * Failures return a typed result instead of throwing so HTTP handlers and
 * tool executors can surface the message directly. The message is user-facing
 * UI copy, hence Simplified Chinese (the product's source language), and it
 * names only the first offending path to stay actionable.
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
