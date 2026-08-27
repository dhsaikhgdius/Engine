import { z } from "zod";
import type { DirectorAgentTargetWire } from "@director/protocol/agentGatewayProtocol";
import type { StageScene, StageTrack, ToolExecution } from "@director/stage-protocol";
import { isRecord as isObject } from "@director/protocol/primitives";
import { validateStageScene } from "./commandEngine";
import { directorCameraAspectRatioSchema } from "@director/protocol/directorCameraProtocol";
import type {
  DirectorPossessionScopeRejection,
  DirectorPossessionTargetAmbiguity,
  DirectorPossessionWriteReceipt,
} from "./directorPossessionScope";

type JsonObject = Record<string, unknown>;

const nonnegativeInteger = z.number().int().nonnegative();

/** Which entity types changed during a stage tool execution. */
export const stageChangedEntitiesSchema = z.strictObject({
  object_ids: z.array(z.string()),
  track_ids: z.array(z.string()),
  scene_settings: z.boolean(),
});
/** Changed entity tracking after stage execution. */
export type StageChangedEntities = z.infer<typeof stageChangedEntitiesSchema>;

/** High-level scene summary returned after every stage tool execution. */
export const stageSceneHintSchema = z.strictObject({
  scene_name: z.string(),
  aspect: directorCameraAspectRatioSchema,
  object_count: nonnegativeInteger,
  renderable_object_count: nonnegativeInteger,
  camera_ids: z.array(z.string()),
  suggested_camera_id: z.string().nullable(),
  track_count: nonnegativeInteger,
  validation: z.strictObject({
    ready: z.boolean(),
    video_ready: z.boolean(),
    error_count: nonnegativeInteger,
    warning_count: nonnegativeInteger,
  }),
});
/** Scene hint type. */
export type StageSceneHint = z.infer<typeof stageSceneHintSchema>;

/** Minimal context about objects and tracks relevant to the current tool execution. */
export const stageFeedbackContextSchema = z.strictObject({
  objects: z.array(z.strictObject({ id: z.string(), kind: z.string(), name: z.string().nullable() })),
  tracks: z.array(z.strictObject({ id: z.string(), object_id: z.string(), item_count: nonnegativeInteger })),
});
/** Feedback context type. */
export type StageFeedbackContext = z.infer<typeof stageFeedbackContextSchema>;

/** Full feedback payload returned after every stage tool execution. */
export const stageToolFeedbackSchema = z.strictObject({
  changed: stageChangedEntitiesSchema,
  scene_hint: stageSceneHintSchema,
  context: stageFeedbackContextSchema,
  available_refs: z.record(z.string(), z.string()),
});
/** Tool feedback type. */
export type StageToolFeedback = z.infer<typeof stageToolFeedbackSchema>;

/** A viewport capture (screenshot) taken after a stage tool execution. */
export interface StageCapturePayload {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

/** Alias for the wire target type, used in gateway execution results. */
export type DirectorAgentTarget = DirectorAgentTargetWire;

/** Receipt proving a tool call passed the agent boundary guard checks. */
export const agentBoundaryReceiptSchema = z.strictObject({
  policy: z.literal("director-agent-public-boundary-v2"),
  tool: z.enum(["director_workbench", "director_creative"]),
  operation: z.string().min(1).max(160),
  exact_target: z.literal(true),
  preflight_observe: z.boolean(),
  guard: z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("revision"),
      field: z.enum([
        "expected_revision",
        "expected_production_revision",
        "expected_snapshot_fingerprint",
        "expected_collaboration_fingerprint",
      ]),
      source: z.enum(["caller", "preflight_observe", "remembered_retry"]),
      value: z.string().min(1).max(240),
    }),
    z.strictObject({ mode: z.literal("unconditional"), source: z.literal("caller") }),
    z.strictObject({ mode: z.literal("durable_job"), source: z.literal("gateway") }),
  ]),
  idempotency: z.strictObject({
    key: z.string().min(1).max(160),
    source: z.enum(["caller", "generated"]),
    stable_retry: z.literal(true),
  }),
});
/** Boundary receipt type. */
export type AgentBoundaryReceipt = z.infer<typeof agentBoundaryReceiptSchema>;

/** Extended tool execution result with feedback, capture, and boundary guard metadata. */
export interface StageGatewayExecution extends ToolExecution {
  code?: string;
  feedback?: StageToolFeedback;
  capture?: StageCapturePayload;
  target?: DirectorAgentTarget;
  agent_boundary?: AgentBoundaryReceipt;
  /** Sole-possession auto-fill receipt on successful writes, ambiguity detail, or rejection detail on scope violations. */
  possession?: DirectorPossessionWriteReceipt | DirectorPossessionTargetAmbiguity | DirectorPossessionScopeRejection;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Computes a structural diff between two scene snapshots.
 *
 * @param before - The scene before tool execution.
 * @param after - The scene after tool execution.
 * @returns Which object ids, track ids, and scene settings changed.
 */
export function diffStageScenes(before: StageScene, after: StageScene): StageChangedEntities {
  const objectIds = new Set([...Object.keys(before.objects), ...Object.keys(after.objects)]);
  const beforeTracks = new Map(before.show.tracks.map((track) => [track.id, track]));
  const afterTracks = new Map(after.show.tracks.map((track) => [track.id, track]));
  const trackIds = new Set([...beforeTracks.keys(), ...afterTracks.keys()]);

  return {
    object_ids: [...objectIds].filter((id) => !sameJson(before.objects[id], after.objects[id])).sort(),
    track_ids: [...trackIds].filter((id) => !sameJson(beforeTracks.get(id), afterTracks.get(id))).sort(),
    scene_settings: before.recordAspect !== after.recordAspect || before.show.name !== after.show.name,
  };
}

/**
 * Builds a high-level scene summary including object counts, camera ids, and validation status.
 *
 * @param scene - The current stage scene.
 * @returns A compact scene hint for agent feedback.
 */
export function createStageSceneHint(scene: StageScene): StageSceneHint {
  const cameraIds = Object.entries(scene.objects)
    .filter(([, object]) => object.kind === "camera")
    .map(([id]) => id);
  const renderableObjectCount = Object.values(scene.objects).filter(
    (object) => object.kind !== "camera" && object.kind !== "target" && object.kind !== "group",
  ).length;
  const validation = validateStageScene(scene);
  return {
    scene_name: scene.show.name,
    aspect: scene.recordAspect,
    object_count: Object.keys(scene.objects).length,
    renderable_object_count: renderableObjectCount,
    camera_ids: cameraIds,
    suggested_camera_id: cameraIds[0] ?? null,
    track_count: scene.show.tracks.length,
    validation: {
      ready: validation.ready,
      video_ready: validation.video_ready,
      error_count: validation.issues.filter((issue) => issue.severity === "error").length,
      warning_count: validation.issues.filter((issue) => issue.severity === "warning").length,
    },
  };
}

function inputOperations(input: unknown): JsonObject[] {
  // Normalize: a single operation or a batch { ops: [...] } both produce an array.
  if (!isObject(input)) return [];
  const values = Array.isArray(input.ops) ? input.ops : [input];
  return values.filter(isObject);
}

function resolveKnownRef(value: unknown, refs: ReadonlyMap<string, string>) {
  return typeof value === "string" ? (refs.get(value) ?? value) : null;
}

function requestedIds(input: unknown, refs: ReadonlyMap<string, string>) {
  // Extract all object and track ids referenced by the tool input,
  // resolving any symbolic refs to their concrete values.
  const objectIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const operation of inputOperations(input)) {
    for (const key of ["object_id", "camera_id", "subject_id", "follow_object_id", "on"] as const) {
      const id = resolveKnownRef(operation[key], refs);
      if (id && id !== "ground") objectIds.add(id);
    }
    if (Array.isArray(operation.object_ids)) {
      operation.object_ids.forEach((value) => {
        const id = resolveKnownRef(value, refs);
        if (id) objectIds.add(id);
      });
    }
    const trackId = resolveKnownRef(operation.track_id, refs);
    if (trackId) trackIds.add(trackId);
  }
  return { objectIds, trackIds };
}

function summarizeTrack(track: StageTrack) {
  return { id: track.id, object_id: track.characterId, item_count: track.items.length };
}

/**
 * Creates a full feedback payload after a stage tool execution.
 *
 * Computes the scene diff, identifies requested entities, and builds
 * a context map of changed and referenced objects/tracks.
 *
 * @param input.before - The scene snapshot before execution.
 * @param input.execution - The tool execution result.
 * @param input.toolInput - The raw tool input that was executed.
 * @param input.refs - The ref map active during execution.
 * @param input.tool - Optional tool name for context.
 * @returns A structured feedback payload for the agent.
 */
export function createStageFeedback(input: {
  before: StageScene;
  execution: ToolExecution;
  toolInput: unknown;
  refs: ReadonlyMap<string, string>;
  tool?: string;
}): StageToolFeedback {
  const changed = diffStageScenes(input.before, input.execution.scene);
  const requested = requestedIds(input.toolInput, input.refs);
  const contextObjectIds = new Set([...changed.object_ids, ...requested.objectIds]);
  const contextTrackIds = new Set([...changed.track_ids, ...requested.trackIds]);
  const objects = [...contextObjectIds].flatMap((id) => {
    const object = input.execution.scene.objects[id] ?? input.before.objects[id];
    return object ? [{ id, kind: object.kind, name: object.name ?? null }] : [];
  });
  const tracks = [...contextTrackIds].flatMap((id) => {
    const track =
      input.execution.scene.show.tracks.find((entry) => entry.id === id) ??
      input.before.show.tracks.find((entry) => entry.id === id);
    return track ? [summarizeTrack(track)] : [];
  });

  return {
    changed,
    scene_hint: createStageSceneHint(input.execution.scene),
    context: { objects, tracks },
    available_refs: Object.fromEntries([...input.refs.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}
