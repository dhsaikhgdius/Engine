import { z } from "zod";
import {
  BLENDER_LIVE_CONTRACT,
  blenderLiveCommandBatchSchema,
  blenderLiveStatusSchema,
  blenderLiveJobAcceptedSchema,
  blenderLiveJobSchema,
  blenderLiveSceneSnapshotSchema,
  blenderNativeApplyResultSchema,
  blenderNativeToolRequestSchema,
  blenderObjectInspectionSchema,
  type BlenderAgentOperation,
  type BlenderLiveCommandBatch,
  type BlenderLiveStatus,
  type BlenderLiveJob,
  type BlenderLiveJobAccepted,
  type BlenderLiveSceneSnapshot,
  type BlenderNativeApplyResult,
  type BlenderNativeToolRequest,
  type BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import {
  blenderLiveLinkPollSchema,
  type BlenderLiveLinkPoll,
} from "../../../../../../packages/protocol/src/blenderLiveLinkProtocol";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  code: z.string().optional(),
  error: z.string().optional(),
});

const nativeInspectResultSchema = z.strictObject({
  job: blenderLiveJobSchema,
  result: blenderObjectInspectionSchema,
  inspection: blenderObjectInspectionSchema,
});

const nativeModelAssetSchema = z.strictObject({
  byteLength: z.number().int().positive(),
  fileName: z.string().min(1),
  url: z.string().startsWith("/native-models/"),
  /** Present when the upload was a 4DGS ZIP the gateway unpacked into a frame sequence. */
  splatSequence: z
    .strictObject({
      frameCount: z.number().int().min(1),
      fps: z.number().min(1).max(240),
    })
    .optional(),
});

/** Error thrown by Blender live API calls when the gateway rejects the request. */
export class BlenderLiveClientError extends Error {
  constructor(
    message: string,
    /** HTTP status code from the gateway response. */
    readonly status: number,
    /** Machine-readable error code from the gateway. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "BlenderLiveClientError";
  }
}

/** A preview GLB blob with its revision and scene epoch for concurrency control. */
export interface BlenderLivePreviewGlb {
  /** The GLB binary blob for rendering. */
  blob: Blob;
  /** Monotonic revision number from the Blender kernel. */
  revision: number;
  /** Scene epoch identifier for optimistic concurrency. */
  sceneEpoch: string;
}

/** The result of a native object inspection. */
export interface BlenderNativeInspectResult {
  job: BlenderLiveJob;
  result: BlenderObjectInspection;
  inspection: BlenderObjectInspection;
}

/** Mesh selection domain for edit operations. */
export type BlenderMeshDomain = "VERTEX" | "EDGE" | "FACE";
/** Supported mesh editing operations and their parameters. */
export type BlenderMeshEdit =
  | { tool: "subdivide"; cuts: number; smoothness: number }
  | { tool: "extrude"; distance: number }
  | { tool: "inset"; thickness: number; depth: number }
  | { tool: "bevel"; offset: number; segments: number };
/** PBR material parameters for assignment operations. */
export type BlenderMaterialParameters = {
  baseColor: [number, number, number];
  roughness: number;
  metallic: number;
  alpha: number;
};
type AssignMaterialOperation = Extract<BlenderAgentOperation, { op: "assign_material" }>;
type ProjectUvOperation = Extract<BlenderAgentOperation, { op: "project_uv" }>;
export type BlenderMaterialFaceScope = AssignMaterialOperation["faceScope"];
export type BlenderUvProjectionMethod = ProjectUvOperation["method"];
type CreateMaterialNodeOperation = Extract<BlenderAgentOperation, { op: "create_material_node" }>;
type SetMaterialNodeInputOperation = Extract<BlenderAgentOperation, { op: "set_material_node_input" }>;
type ConnectMaterialNodesOperation = Extract<BlenderAgentOperation, { op: "connect_material_nodes" }>;
type SelectPoseBonesOperation = Extract<BlenderAgentOperation, { op: "select_pose_bones" }>;
type SetPoseBoneTransformOperation = Extract<BlenderAgentOperation, { op: "set_pose_bone_transform" }>;
type InsertPoseKeyframesOperation = Extract<BlenderAgentOperation, { op: "insert_pose_keyframes" }>;
type ImportMixamoActionOperation = Extract<BlenderAgentOperation, { op: "import_mixamo_action" }>;
type AddNlaStripOperation = Extract<BlenderAgentOperation, { op: "add_nla_strip" }>;
type UpdateNlaStripOperation = Extract<BlenderAgentOperation, { op: "update_nla_strip" }>;
export type BlenderMaterialNodeType = CreateMaterialNodeOperation["nodeType"];
export type BlenderMaterialNodeInputValue = SetMaterialNodeInputOperation["value"];
export type BlenderMaterialNodeEndpoint = ConnectMaterialNodesOperation["from"];
export type BlenderPoseBoneSelectionAction = SelectPoseBonesOperation["action"];
export type BlenderPoseBoneLocalTransform = SetPoseBoneTransformOperation["local"];
export type BlenderPoseChannel = InsertPoseKeyframesOperation["channels"][number];
export type BlenderKeyframeInterpolation = InsertPoseKeyframesOperation["interpolation"];
export type BlenderMixamoRootMotion = ImportMixamoActionOperation["rootMotion"];
export type BlenderNlaBlendMode = AddNlaStripOperation["blendMode"];

async function readResult<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await directorControlPlaneFetch(path, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BlenderLiveClientError("Blender returned an unreadable response.", response.status);
  }
  if (!response.ok) {
    const failure = errorEnvelopeSchema.safeParse(payload);
    throw new BlenderLiveClientError(
      failure.success
        ? failure.data.error || `Blender request failed (${response.status}).`
        : `Blender request failed (${response.status}).`,
      response.status,
      failure.success ? failure.data.code : undefined,
    );
  }
  const envelope = z.object({ success: z.literal(true), result: schema }).safeParse(payload);
  if (!envelope.success) {
    throw new BlenderLiveClientError(
      "Blender returned an incompatible response.",
      response.status,
      "invalid_response",
    );
  }
  return envelope.data.result;
}

/**
 * Fetches the current Blender live kernel status.
 *
 * @param options - Optional abort signal for cancellation.
 * @returns The live kernel status including connection state.
 */
export function getBlenderLiveStatus(options: { signal?: AbortSignal } = {}): Promise<BlenderLiveStatus> {
  return readResult("/api/dcc/blender/status", blenderLiveStatusSchema, { signal: options.signal });
}

/**
 * Fetches the current preview GLB from the Blender live kernel.
 *
 * The response includes a revision header and scene epoch for optimistic
 * concurrency control when applying subsequent edits.
 *
 * @param options - Optional abort signal for cancellation.
 * @returns The preview GLB blob with revision and scene epoch.
 */
export async function getBlenderLivePreviewGlb(
  options: { signal?: AbortSignal } = {},
): Promise<BlenderLivePreviewGlb> {
  const response = await directorControlPlaneFetch("/api/dcc/blender/preview.glb", {
    signal: options.signal,
  });
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const failure = errorEnvelopeSchema.safeParse(payload);
    throw new BlenderLiveClientError(
      failure.success
        ? failure.data.error || `Blender request failed (${response.status}).`
        : `Blender request failed (${response.status}).`,
      response.status,
      failure.success ? failure.data.code : undefined,
    );
  }

  const revisionHeader = response.headers.get("X-Blender-Revision");
  const revision = revisionHeader === null ? Number.NaN : Number(revisionHeader);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new BlenderLiveClientError(
      "Blender preview did not include a valid revision.",
      response.status,
      "invalid_response",
    );
  }

  const sceneEpoch = response.headers.get("X-Blender-Scene-Epoch")?.trim();
  if (!sceneEpoch) {
    throw new BlenderLiveClientError(
      "Blender preview did not include a valid scene epoch.",
      response.status,
      "invalid_response",
    );
  }

  return { blob: await response.blob(), revision, sceneEpoch };
}

/**
 * Polls the preview-only live-link delta feed from the Blender live kernel.
 *
 * Frames are NEVER authoritative and never write into the Director project:
 * they only exist so the Stage can mirror an in-progress Blender edit with
 * low latency. Without a cursor the kernel answers with a resync directive;
 * with `(sceneEpoch, since)` it serves the contiguous frames after that
 * sequence number or an explicit resync.
 *
 * @param cursor - The `(sceneEpoch, since)` cursor from the replay guard, or undefined on first contact.
 * @param options - Optional abort signal for cancellation.
 * @returns The live-link poll response (frames or a resync directive).
 */
export function pollBlenderLiveLink(
  cursor?: { sceneEpoch: string; since: number },
  options: { signal?: AbortSignal } = {},
): Promise<BlenderLiveLinkPoll> {
  const query = cursor ? `?epoch=${encodeURIComponent(cursor.sceneEpoch)}&since=${cursor.since}` : "";
  return readResult(`/api/dcc/blender/live-link${query}`, blenderLiveLinkPollSchema, { signal: options.signal });
}

/**
 * Fetches the full scene snapshot from the Blender live kernel.
 *
 * @param options - Optional abort signal for cancellation.
 * @returns The live scene snapshot with all objects.
 */
export function getBlenderLiveScene(
  options: { signal?: AbortSignal } = {},
): Promise<BlenderLiveSceneSnapshot> {
  return readResult("/api/dcc/blender/scene", blenderLiveSceneSnapshotSchema, {
    signal: options.signal,
  });
}

/**
 * Uploads a 3D model file to the Blender live kernel.
 *
 * @param file - The model file blob (GLB, FBX, OBJ, etc.).
 * @param fileName - The original file name.
 * @param assetId - Optional asset id to assign.
 * @returns The uploaded asset metadata including URL and byte length.
 */
export function uploadBlenderModelAsset(file: Blob, fileName: string, assetId?: string) {
  const query = new URLSearchParams({ fileName, ...(assetId ? { assetId } : {}) });
  return readResult(`/api/dcc/blender/assets?${query}`, nativeModelAssetSchema, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
}

function postNativeApply(input: Extract<BlenderNativeToolRequest, { op: "apply" }>, signal?: AbortSignal) {
  return readResult("/api/tools/blender_native", blenderNativeApplyResultSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal,
  });
}

/**
 * Applies a sequence of native Blender operations with optimistic concurrency.
 *
 * The expectedSceneEpoch and expectedRevision are used to detect conflicts:
 * if the scene has changed since they were read, the request is rejected.
 *
 * @param options - The operations, expected epoch/revision, and optional intent id.
 * @returns The apply result.
 */
export function applyBlenderNativeOperations(options: {
  expectedSceneEpoch: string;
  expectedRevision: number;
  operations: BlenderAgentOperation[];
  intentId?: string;
  signal?: AbortSignal;
}): Promise<BlenderNativeApplyResult> {
  const input = blenderNativeToolRequestSchema.parse({
    op: "apply",
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    intentId: options.intentId,
    operations: options.operations,
  });
  if (input.op !== "apply") throw new Error("Blender apply input is invalid.");
  return postNativeApply(input, options.signal);
}

/**
 * Applies a pre-validated command batch to the Blender live kernel.
 *
 * @param batch - The command batch to apply.
 * @param options - Optional abort signal for cancellation.
 * @returns The apply result.
 */
export function applyBlenderNativeBatch(
  batch: BlenderLiveCommandBatch,
  options: { signal?: AbortSignal } = {},
): Promise<BlenderNativeApplyResult> {
  const input = blenderNativeToolRequestSchema.parse({
    op: "apply",
    expectedSceneEpoch: batch.expectedSceneEpoch,
    expectedRevision: batch.expectedRevision,
    intentId: batch.requestId,
    operations: batch.operations,
  });
  if (input.op !== "apply") throw new Error("Blender apply input is invalid.");
  return postNativeApply(input, options.signal);
}

/**
 * Inspects a live Blender object's mesh, materials, and rig data.
 *
 * @param id - The object id to inspect.
 * @param options - Expected scene epoch and revision for concurrency control.
 * @returns The inspection result with mesh, material, and rig information.
 */
export function inspectBlenderLiveObject(
  id: string,
  options: {
    expectedSceneEpoch: string;
    expectedRevision: number;
    signal?: AbortSignal;
  },
): Promise<BlenderNativeInspectResult> {
  const input = blenderNativeToolRequestSchema.parse({
    op: "inspect",
    id,
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
  });
  return readResult("/api/tools/blender_native", nativeInspectResultSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
    signal: options.signal,
  });
}

export function blenderMeshSelectionOperation(options: {
  objectId: string;
  domain: BlenderMeshDomain;
  action: "ALL" | "NONE" | "RESET";
}): BlenderAgentOperation {
  return {
    op: "select_mesh_elements",
    id: options.objectId,
    domain: options.domain,
    indices: [],
    // Starting a different Blender selection domain clears the old domain's
    // element selection while staying within the public native operation schema.
    action: options.action === "RESET" ? "NONE" : options.action,
  };
}

export function blenderMeshEditOperation(
  objectId: string,
  edit: BlenderMeshEdit,
): BlenderAgentOperation {
  const context = { selectedIds: [objectId], activeId: objectId, mode: "EDIT" };
  switch (edit.tool) {
    case "subdivide":
      return {
        op: "invoke_operator",
        operator: "mesh.subdivide",
        properties: { number_cuts: edit.cuts, smoothness: edit.smoothness },
        context,
      };
    case "extrude":
      return {
        op: "invoke_operator",
        operator: "mesh.extrude_region_shrink_fatten",
        properties: {
          MESH_OT_extrude_region: {},
          TRANSFORM_OT_shrink_fatten: { value: edit.distance },
        },
        context,
      };
    case "inset":
      return {
        op: "invoke_operator",
        operator: "mesh.inset",
        properties: { thickness: edit.thickness, depth: edit.depth },
        context,
      };
    case "bevel":
      return {
        op: "invoke_operator",
        operator: "mesh.bevel",
        properties: { offset: edit.offset, segments: edit.segments },
        context,
      };
  }
}

export function blenderAssignMaterialOperation(options: {
  objectId: string;
  materialName: string;
  createIfMissing: boolean;
  faceScope: BlenderMaterialFaceScope;
  parameters: BlenderMaterialParameters;
}): BlenderAgentOperation {
  return {
    op: "assign_material",
    id: options.objectId,
    materialName: options.materialName,
    createIfMissing: options.createIfMissing,
    faceScope: options.faceScope,
    parameters: options.parameters,
  };
}

export function blenderProjectUvOperation(options: {
  objectId: string;
  method: BlenderUvProjectionMethod;
  uvLayerName: string;
  replaceExisting: boolean;
}): BlenderAgentOperation {
  return {
    op: "project_uv",
    id: options.objectId,
    method: options.method,
    uvLayerName: options.uvLayerName,
    replaceExisting: options.replaceExisting,
  };
}

export function blenderCreateMaterialNodeOperation(options: {
  objectId: string;
  materialName: string;
  nodeRef: string;
  nodeType: BlenderMaterialNodeType;
  location?: [number, number];
  label?: string;
}): BlenderAgentOperation {
  return {
    op: "create_material_node",
    id: options.objectId,
    materialName: options.materialName,
    nodeRef: options.nodeRef,
    nodeType: options.nodeType,
    ...(options.location ? { location: options.location } : {}),
    ...(options.label ? { label: options.label } : {}),
  };
}

export function blenderDeleteMaterialNodeOperation(options: {
  objectId: string;
  materialName: string;
  nodeRef: string;
}): BlenderAgentOperation {
  return {
    op: "delete_material_node",
    id: options.objectId,
    materialName: options.materialName,
    nodeRef: options.nodeRef,
  };
}

export function blenderSetMaterialNodeInputOperation(options: {
  objectId: string;
  materialName: string;
  nodeRef: string;
  inputSocketRef: string;
  value: BlenderMaterialNodeInputValue;
}): BlenderAgentOperation {
  return {
    op: "set_material_node_input",
    id: options.objectId,
    materialName: options.materialName,
    nodeRef: options.nodeRef,
    inputSocketRef: options.inputSocketRef,
    value: options.value,
  };
}

export function blenderConnectMaterialNodesOperation(options: {
  objectId: string;
  materialName: string;
  from: BlenderMaterialNodeEndpoint;
  to: BlenderMaterialNodeEndpoint;
}): BlenderAgentOperation {
  return {
    op: "connect_material_nodes",
    id: options.objectId,
    materialName: options.materialName,
    from: options.from,
    to: options.to,
  };
}

export function blenderDisconnectMaterialNodeInputOperation(options: {
  objectId: string;
  materialName: string;
  nodeRef: string;
  inputSocketRef: string;
}): BlenderAgentOperation {
  return {
    op: "disconnect_material_node_input",
    id: options.objectId,
    materialName: options.materialName,
    nodeRef: options.nodeRef,
    inputSocketRef: options.inputSocketRef,
  };
}

export function blenderSelectPoseBonesOperation(options: {
  objectId: string;
  boneRefs?: string[];
  activeBoneRef?: string;
  action: BlenderPoseBoneSelectionAction;
}): BlenderAgentOperation {
  return {
    op: "select_pose_bones",
    id: options.objectId,
    boneRefs: options.boneRefs ?? [],
    ...(options.activeBoneRef ? { activeBoneRef: options.activeBoneRef } : {}),
    action: options.action,
  };
}

export function blenderSetPoseBoneTransformOperation(options: {
  objectId: string;
  boneRef: string;
  local: BlenderPoseBoneLocalTransform;
}): BlenderAgentOperation {
  return {
    op: "set_pose_bone_transform",
    id: options.objectId,
    boneRef: options.boneRef,
    local: options.local,
  };
}

export function blenderApplyPoseOffsetsOperation(options: {
  objectId: string;
  stateToken: string;
  resetPose: boolean;
  bones: Array<{
    boneRef: string;
    rotationOffsetQuaternion: [number, number, number, number];
    locationOffset?: [number, number, number];
  }>;
}): BlenderAgentOperation {
  return {
    op: "apply_pose_offsets",
    id: options.objectId,
    stateToken: options.stateToken,
    resetPose: options.resetPose,
    bones: options.bones,
  };
}

export function blenderCreateActionOperation(objectId: string, actionName: string): BlenderAgentOperation {
  return { op: "create_action", id: objectId, actionName };
}

export function blenderSetActiveActionOperation(objectId: string, actionName: string): BlenderAgentOperation {
  return { op: "set_active_action", id: objectId, actionName };
}

export function blenderSetSceneFrameOperation(frame: number): BlenderAgentOperation {
  return { op: "set_scene_frame", frame };
}

export function blenderImportMixamoActionOperation(
  options: { objectId: string } & Pick<
    ImportMixamoActionOperation,
    "motionId" | "actionName" | "rootMotion" | "replaceExisting"
  >,
): BlenderAgentOperation {
  return {
    op: "import_mixamo_action",
    id: options.objectId,
    motionId: options.motionId,
    ...(options.actionName ? { actionName: options.actionName } : {}),
    rootMotion: options.rootMotion,
    replaceExisting: options.replaceExisting,
  };
}

export function blenderCreateNlaTrackOperation(objectId: string, trackName: string): BlenderAgentOperation {
  return { op: "create_nla_track", id: objectId, trackName };
}

export function blenderAddNlaStripOperation(
  options: { objectId: string } & Omit<AddNlaStripOperation, "op" | "id" | "scale"> &
    Partial<Pick<AddNlaStripOperation, "scale">>,
): BlenderAgentOperation {
  return {
    op: "add_nla_strip",
    id: options.objectId,
    trackName: options.trackName,
    stripName: options.stripName,
    actionName: options.actionName,
    startFrame: options.startFrame,
    blendMode: options.blendMode,
    influence: options.influence,
    repeat: options.repeat,
    scale: options.scale ?? 1,
  };
}

export function blenderUpdateNlaStripOperation(
  options: { objectId: string } & Omit<UpdateNlaStripOperation, "op" | "id">,
): BlenderAgentOperation {
  return {
    op: "update_nla_strip",
    id: options.objectId,
    trackName: options.trackName,
    stripName: options.stripName,
    ...(options.blendMode === undefined ? {} : { blendMode: options.blendMode }),
    ...(options.influence === undefined ? {} : { influence: options.influence }),
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
    ...(options.scale === undefined ? {} : { scale: options.scale }),
  };
}

export function blenderRemoveNlaStripOperation(
  objectId: string,
  trackName: string,
  stripName: string,
): BlenderAgentOperation {
  return { op: "remove_nla_strip", id: objectId, trackName, stripName };
}

export function blenderInsertPoseKeyframesOperation(options: {
  objectId: string;
  actionName: string;
  frame: number;
  boneRefs: string[];
  channels: BlenderPoseChannel[];
  interpolation: BlenderKeyframeInterpolation;
}): BlenderAgentOperation {
  return {
    op: "insert_pose_keyframes",
    id: options.objectId,
    actionName: options.actionName,
    frame: options.frame,
    boneRefs: options.boneRefs,
    channels: options.channels,
    interpolation: options.interpolation,
  };
}

export function blenderDeletePoseKeyframesOperation(options: {
  objectId: string;
  actionName: string;
  frame: number;
  boneRefs: string[];
  channels: BlenderPoseChannel[];
}): BlenderAgentOperation {
  return {
    op: "delete_pose_keyframes",
    id: options.objectId,
    actionName: options.actionName,
    frame: options.frame,
    boneRefs: options.boneRefs,
    channels: options.channels,
  };
}

/**
 * Submits a command batch to the Blender live kernel and returns a job id.
 *
 * The job is processed asynchronously; poll with {@link pollBlenderLiveJob}
 * or check with {@link getBlenderLiveJob}.
 *
 * @param batch - The command batch to submit.
 * @param options - Optional abort signal for cancellation.
 * @returns The accepted job with its id.
 */
export function submitBlenderLiveCommands(
  batch: BlenderLiveCommandBatch,
  options: { signal?: AbortSignal } = {},
): Promise<BlenderLiveJobAccepted> {
  const input = blenderLiveCommandBatchSchema.parse(batch);
  return readResult("/api/dcc/blender/commands", blenderLiveJobAcceptedSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  });
}

/**
 * Fetches the current status of a Blender live job.
 *
 * @param jobId - The job id returned by {@link submitBlenderLiveCommands}.
 * @param options - Optional abort signal for cancellation.
 * @returns The job with its current status.
 */
export function getBlenderLiveJob(
  jobId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BlenderLiveJob> {
  return readResult(`/api/dcc/blender/jobs/${encodeURIComponent(jobId)}`, blenderLiveJobSchema, {
    signal: options.signal,
  });
}

/**
 * Polls a Blender live job until it succeeds, fails, or times out.
 *
 * @param jobId - The job id to poll.
 * @param options - Polling interval, timeout, and optional abort signal.
 * @returns The completed job.
 * @throws {BlenderLiveClientError} If the job fails or times out.
 */
export async function pollBlenderLiveJob(
  jobId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<BlenderLiveJob> {
  const intervalMs = Math.max(0, options.intervalMs ?? 300);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 20_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (options.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const job = await getBlenderLiveJob(jobId, { signal: options.signal });
    if (job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new BlenderLiveClientError(
        job.error || "Blender could not apply the scene edit.",
        409,
        "job_failed",
      );
    }
    if (Date.now() >= deadline) {
      throw new BlenderLiveClientError("Blender did not finish the scene edit in time.", 408, "job_timeout");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, intervalMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        },
        { once: true },
      );
    });
  }
}

/**
 * Binds a Director project to the Blender live kernel and returns the
 * synchronized scene snapshot.
 *
 * @param projectId - The Director project id to bind.
 * @param options - Optional abort signal for cancellation.
 * @returns The live scene snapshot after binding.
 */
export async function bindBlenderDirectorProject(
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BlenderLiveSceneSnapshot> {
  const batch = blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId: crypto.randomUUID(),
    operations: [{ op: "bind_director_project", projectId }],
  });
  const accepted = await submitBlenderLiveCommands(batch, options);
  await pollBlenderLiveJob(accepted.jobId, { signal: options.signal });
  return getBlenderLiveScene(options);
}

/** Preset architectural blockout shapes. */
export type BlenderBlockoutPreset = "floor" | "room" | "corridor" | "stairs";

/**
 * Creates a command batch for a blockout geometry preset.
 *
 * @param options - The preset type, dimensions, and optional origin.
 * @returns A validated command batch ready for submission.
 */
export function createBlenderBlockoutBatch(options: {
  preset: BlenderBlockoutPreset;
  expectedSceneEpoch: string;
  expectedRevision?: number;
  width: number;
  depth: number;
  height: number;
  wallThickness?: number;
  stepCount?: number;
  origin?: [number, number, number];
}): BlenderLiveCommandBatch {
  const requestId = crypto.randomUUID();
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    operations: [
      {
        op: "create_blockout",
        preset: options.preset,
        idPrefix: `${options.preset}-${requestId}`,
        origin: options.origin ?? [0, 0, 0],
        width: options.width,
        depth: options.depth,
        height: options.height,
        wallThickness: options.wallThickness ?? 0.18,
        stepCount: options.stepCount ?? 12,
      },
    ],
  });
}

/**
 * Creates a command batch for a geometric primitive.
 *
 * @param options - The primitive type, dimensions, position, and epoch.
 * @returns A validated command batch ready for submission.
 */
export function createBlenderPrimitiveBatch(options: {
  expectedSceneEpoch: string;
  primitive?: "cube" | "sphere" | "cylinder" | "cone" | "plane";
  expectedRevision?: number;
  dimensions?: [number, number, number];
  position?: [number, number, number];
}): BlenderLiveCommandBatch {
  const requestId = crypto.randomUUID();
  const primitive = options.primitive ?? "cube";
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    operations: [
      {
        op: "create_primitive",
        id: `${primitive}-${requestId}`,
        primitive,
        name: primitive === "cube" ? "Blockout cube" : `Blockout ${primitive}`,
        dimensions: options.dimensions ?? [2, 2, 2],
        transform: { position: options.position ?? [0, 1, 0] },
      },
    ],
  });
}

export function createBlenderCameraBatch(
  expectedRevision: number,
  expectedSceneEpoch: string,
): BlenderLiveCommandBatch {
  const requestId = crypto.randomUUID();
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    expectedSceneEpoch,
    expectedRevision,
    operations: [
      {
        op: "create_camera",
        id: `camera-${requestId}`,
        name: "Director camera",
        position: [8, 5, 8],
        target: [0, 1.5, 0],
        focalLengthMm: 35,
        sensorWidthMm: 36,
      },
    ],
  });
}

export function createBlenderLightBatch(
  expectedRevision: number,
  expectedSceneEpoch: string,
): BlenderLiveCommandBatch {
  const requestId = crypto.randomUUID();
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    expectedSceneEpoch,
    expectedRevision,
    operations: [
      {
        op: "create_light",
        id: `light-${requestId}`,
        kind: "area",
        name: "Director key light",
        position: [4, 6, 4],
        target: [0, 1.5, 0],
        color: [1, 0.94, 0.86],
        energy: 1_000,
        size: 4,
      },
    ],
  });
}

export function createBlenderOpeningBatch(options: {
  targetId: string;
  kind: "door" | "window";
  expectedSceneEpoch: string;
  expectedRevision?: number;
  width?: number;
  height?: number;
  sillHeight?: number;
  offset?: number;
}): BlenderLiveCommandBatch {
  const requestId = crypto.randomUUID();
  const isWindow = options.kind === "window";
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    operations: [
      {
        op: "create_opening",
        id: `opening-${requestId}`,
        targetId: options.targetId,
        kind: options.kind,
        name: `Director ${options.kind}`,
        width: options.width ?? (isWindow ? 1.4 : 0.9),
        height: options.height ?? (isWindow ? 1.2 : 2.1),
        sillHeight: options.sillHeight ?? (isWindow ? 0.9 : 0),
        offset: options.offset ?? 0,
      },
    ],
  });
}

export function createBlenderCollectionBatch(options: {
  objectIds: string[];
  collection: string;
  expectedSceneEpoch: string;
  expectedRevision?: number;
}): BlenderLiveCommandBatch {
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId: crypto.randomUUID(),
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    operations: [
      {
        op: "move_to_collection",
        ids: options.objectIds,
        collection: options.collection,
      },
    ],
  });
}

export function createBlenderParentBatch(options: {
  objectId: string;
  parentId: string | null;
  expectedSceneEpoch: string;
  expectedRevision?: number;
  keepWorldTransform?: boolean;
}): BlenderLiveCommandBatch {
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId: crypto.randomUUID(),
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    operations: [
      {
        op: "set_parent",
        id: options.objectId,
        parentId: options.parentId,
        keepWorldTransform: options.keepWorldTransform ?? true,
      },
    ],
  });
}

export function createBlenderConstraintBatch(options: {
  objectId: string;
  targetId: string;
  expectedSceneEpoch: string;
  kind: "track_to" | "copy_location" | "copy_rotation" | "copy_transforms";
  expectedRevision?: number;
  influence?: number;
}): BlenderLiveCommandBatch {
  return blenderLiveCommandBatchSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    requestId: crypto.randomUUID(),
    expectedSceneEpoch: options.expectedSceneEpoch,
    expectedRevision: options.expectedRevision,
    operations: [
      {
        op: "add_constraint",
        id: options.objectId,
        targetId: options.targetId,
        kind: options.kind,
        influence: options.influence ?? 1,
      },
    ],
  });
}
