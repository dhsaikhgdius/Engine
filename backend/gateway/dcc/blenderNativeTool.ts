/**
 * Execution layer for the `blender_native` tool: turns typed tool requests
 * into Blender live-kernel jobs and turns raw job results into the public
 * agent contract (effect receipts, focused evidence, sanitized job records).
 *
 * Key invariants:
 * - Apply is guarded three ways: the kernel policy vets the operation batch,
 *   the observed scene epoch must still match at submit time, and every apply
 *   carries an intent id — caller-provided or derived from the observed
 *   (epoch, revision, operations) — so an exact retry replays the cached
 *   effect instead of editing twice.
 * - Uncertain failures (timeout, connection loss after submit) surface as
 *   `outcome_unknown` with a retry ticket bound to the same intent id rather
 *   than a plain error, because Blender may have committed the edit.
 * - Effect receipts report what actually changed by diffing before/after
 *   snapshots and cross-checking each operation's declared effect, so agents
 *   get evidence instead of trusting the request.
 * - Base64 payloads (captures, previews, snapshots) never leak into public
 *   job records; they travel once through dedicated channels.
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertBlenderKernelPolicy, BlenderKernelPolicyError } from "../../../packages/protocol/src/blenderKernel";
import {
  BLENDER_LIVE_CONTRACT,
  BLENDER_NATIVE_DESCRIBE_XOR_MESSAGE,
  blenderEffectReceiptSchema,
  blenderFocusedEvidenceSchema,
  blenderNativeApplyResultSchema,
  blenderLiveSceneSnapshotSchema,
  blenderObjectInspectionSchema,
  blenderScenePreviewSchema,
  type BlenderAgentOperation,
  type BlenderLiveOperation,
  type BlenderLiveJob,
  type BlenderLiveSceneSnapshot,
  type BlenderEffectReceipt,
  type BlenderFocusedEvidence,
  type BlenderNativeToolRequest,
} from "../../../packages/protocol/src/blenderLiveProtocol";
import { describeBlenderNativeTarget } from "../../../packages/protocol/src/blenderNativeDescribe";
import { asRecord } from "../../../packages/protocol/src/primitives";
import { blenderOperationEffect } from "../../../packages/protocol/src/blenderOperationManifest";
import type { DirectorProject } from "@director/project-schema";
import {
  describeDirectorCameraKernelOwnership,
  describeDirectorLightKernelOwnership,
  describeDirectorObjectKernelOwnership,
  describeUnmirroredBlenderKernelOwnership,
  type DirectorKernelOwnership,
} from "@director/agent-engine/kernel-ownership";
import { BlenderNativeSessionError, type BlenderNativeSession } from "./blenderNativeSession";

function isBlenderNativeCaptureOp(op: BlenderNativeToolRequest["op"]): op is "capture" | "capture_render" {
  return op === "capture" || op === "capture_render";
}

/**
 * Validates that a batch of live operations conforms to the Blender kernel
 * policy. Wraps the shared kernel policy assertion and translates its errors
 * into `BlenderNativeSessionError` with the appropriate HTTP status.
 *
 * @param operations - The live operations to validate.
 * @throws {BlenderNativeSessionError} When the policy is violated.
 */
export function assertBlenderLiveKernelPolicy(operations: BlenderLiveOperation[]) {
  try {
    assertBlenderKernelPolicy(operations);
  } catch (error) {
    if (error instanceof BlenderKernelPolicyError) {
      throw new BlenderNativeSessionError(error.message, 400, error.code);
    }
    throw error;
  }
}

/** Everything needed to replay one committed apply on an exact retry. */
type CachedEffect = {
  intent: EffectIntent;
  job: BlenderLiveJob;
  receipt: BlenderEffectReceipt;
  evidence: BlenderFocusedEvidence;
};
/** The identity an intent id is bound to; a retry with different content is a conflict. */
type EffectIntent = {
  expectedSceneEpoch: string;
  expectedRevision: number;
  operations: BlenderAgentOperation[];
};
// Keyed by session object so a reconnected/replaced session never replays
// receipts that belong to a previous kernel process.
const effectReceiptCache = new WeakMap<BlenderNativeSession, Map<string, CachedEffect>>();

function cachedEffect(session: BlenderNativeSession, intentId: string) {
  return effectReceiptCache.get(session)?.get(intentId);
}

// Bounded FIFO per session: 128 receipts is plenty for retry windows without
// letting a long-lived session accumulate snapshots indefinitely.
function rememberEffect(session: BlenderNativeSession, intentId: string, value: CachedEffect) {
  let cache = effectReceiptCache.get(session);
  if (!cache) {
    cache = new Map();
    effectReceiptCache.set(session, cache);
  }
  cache.set(intentId, value);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
}

/**
 * Derives a deterministic intent id for an apply request whose caller omitted one.
 * The id is a SHA-256 hash of the effective intent (observed scene epoch, revision
 * and operation batch) folded into an RFC 9562 UUIDv8, so an exact retry of the
 * same batch against the same observed scene replays the cached effect instead of
 * executing the edit twice, while a committed revision yields a fresh id.
 */
export function deriveBlenderIntentId(
  sceneEpoch: string,
  revision: number,
  operations: BlenderAgentOperation[],
): string {
  const digest = createHash("sha256").update(JSON.stringify({ sceneEpoch, revision, operations })).digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Extracts the intent identity from an apply request; missing boundary fields are a 409. */
function effectIntent(input: Extract<BlenderNativeToolRequest, { op: "apply" }>): EffectIntent {
  if (!input.expectedSceneEpoch || input.expectedRevision === undefined || !input.intentId) {
    throw new BlenderNativeSessionError(
      "Blender apply requires an exact scene epoch, revision, and intent id at the execution boundary.",
      409,
      "missing_agent_boundary",
    );
  }
  return structuredClone({
    expectedSceneEpoch: input.expectedSceneEpoch,
    expectedRevision: input.expectedRevision,
    operations: input.operations,
  });
}

/** An intent id may only ever replay the exact batch it was first bound to. */
function assertSameIntent(intentId: string, cached: CachedEffect, current: EffectIntent) {
  if (isDeepStrictEqual(cached.intent, current)) return;
  throw new BlenderNativeSessionError(
    `Blender intent ${intentId} is already bound to a different revision or operation batch.`,
    409,
    "intent_conflict",
  );
}

/** True for failures where Blender may have committed the edit anyway (timeouts, transport loss). */
function isUncertainNativeFailure(error: unknown) {
  return (
    error instanceof BlenderNativeSessionError &&
    (error.status >= 500 || error.code === "blender_timeout" || error.code === "blender_unavailable")
  );
}

// Wraps an uncertain apply failure as outcome_unknown with a retry ticket:
// the caller must retry the exact same intent (which replays the cached
// effect if Blender did commit) instead of composing a fresh edit.
function uncertainNativeApply(
  error: BlenderNativeSessionError,
  input: Extract<BlenderNativeToolRequest, { op: "apply" }>,
) {
  return new BlenderNativeSessionError(
    `Blender may have accepted the native edit before the connection failed. Retry only the exact operation with intent ${input.intentId}.`,
    409,
    "outcome_unknown",
    {
      operation: "blender_native.apply",
      outcome: "unknown",
      retry_requires_observe: false,
      cause: { code: error.code, message: error.message },
      retry_ticket: { input: structuredClone(input) },
    },
  );
}

/** Narrows a job result to a plain object record, else null. */
function resultRecord(job: BlenderLiveJob) {
  return job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? (job.result as Record<string, unknown>)
    : null;
}

/** Kernel-recorded before/after snapshots of the transaction, when the kernel attached them. */
function nativeTransactionSnapshots(job: BlenderLiveJob) {
  const result = resultRecord(job);
  const before = blenderLiveSceneSnapshotSchema.safeParse(result?.snapshotBefore);
  const after = blenderLiveSceneSnapshotSchema.safeParse(result?.snapshotAfter);
  return {
    before: before.success ? before.data : null,
    after: after.success ? after.data : null,
  };
}

// The compaction helpers below shrink inspect results for the model: only
// linked node sockets survive, so material/geometry graphs describe actual
// wiring instead of every unconnected input Blender exposes.
function compactInspectionSockets(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((socket) => {
    const record = asRecord(socket);
    if (!record || record.linked !== true) return [];
    return [
      {
        socketRef: record.socketRef,
        name: record.name,
        type: record.type,
        linked: true,
        enabled: record.enabled !== false,
        multiInput: record.multiInput === true,
      },
    ];
  });
}

function compactInspectionGraphNodes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((node) => {
    const record = asRecord(node);
    if (!record) return [];
    return [
      {
        ...record,
        inputs: compactInspectionSockets(record.inputs),
        outputs: compactInspectionSockets(record.outputs),
      },
    ];
  });
}

function compactBlenderInspection(value: unknown) {
  const inspection = blenderObjectInspectionSchema.parse(value);
  return blenderObjectInspectionSchema.parse({
    ...inspection,
    position: inspection.position ?? inspection.evaluatedBounds.center,
    materialGraphs: inspection.materialGraphs.map((graph) => ({
      ...graph,
      nodes: compactInspectionGraphNodes(graph.nodes),
    })),
    geometryGraphs: inspection.geometryGraphs.map((graph) => ({
      ...graph,
      nodes: compactInspectionGraphNodes(graph.nodes),
    })),
  });
}

/**
 * Kernel ownership for a natively inspected Blender datablock: resolved
 * against the persisted Director project so a mirrored Stage entity reports
 * the same ownership block as `director_workbench inspect` (including
 * Stage-owned projections with `provisioned: false`).
 */
async function blenderInspectionKernelOwnership(
  blenderObjectId: string,
  loadDirectorProject?: () => Promise<DirectorProject | null>,
): Promise<DirectorKernelOwnership> {
  const project = (await loadDirectorProject?.()) ?? null;
  const mirrorsBlenderId = (entity: { nativeSource?: { engine: "blender"; objectId: string } }) =>
    entity.nativeSource?.engine === "blender" && entity.nativeSource.objectId === blenderObjectId;
  if (project) {
    const object = project.objects.find(mirrorsBlenderId);
    if (object) {
      return {
        ...describeDirectorObjectKernelOwnership(object, project.assets),
        stage_entity: { entity: "object", id: object.id },
      };
    }
    const light = project.lights?.find(mirrorsBlenderId);
    if (light) {
      return { ...describeDirectorLightKernelOwnership(light), stage_entity: { entity: "light", id: light.id } };
    }
    const camera = project.cameras.find(mirrorsBlenderId);
    if (camera) {
      return { ...describeDirectorCameraKernelOwnership(camera), stage_entity: { entity: "camera", id: camera.id } };
    }
  }
  return describeUnmirroredBlenderKernelOwnership(blenderObjectId);
}

/**
 * Strips internal-only fields (snapshotBefore, snapshotAfter, dataBase64)
 * from a native job result before exposing it to agents and browsers.
 *
 * @param job - The raw native job record.
 * @returns A sanitized copy safe for public consumption.
 */
export function publicBlenderJob(job: BlenderLiveJob): BlenderLiveJob {
  const result = resultRecord(job);
  if (!result) return job;
  const {
    snapshotBefore: _snapshotBefore,
    snapshotAfter: _snapshotAfter,
    dataBase64: _dataBase64,
    ...publicResult
  } = result;
  const operations = Array.isArray(publicResult.operations)
    ? publicResult.operations.map((operation) => {
        if (!operation || typeof operation !== "object" || Array.isArray(operation)) return operation;
        const { dataBase64: _operationDataBase64, ...publicOperation } = operation as Record<string, unknown>;
        return publicOperation;
      })
    : undefined;
  return {
    ...job,
    result: operations ? { ...publicResult, operations } : publicResult,
  };
}

/** Job poll deadline; keep below the MCP `blender_native` abort budget (300s). */
const NATIVE_JOB_TIMEOUT_MS = 280_000;

// Polls one native job to a terminal state with exponential backoff (5ms →
// 50ms cap): most kernel edits finish in milliseconds, so the first polls are
// nearly immediate while long renders don't hammer the session.
async function waitForNativeJob(
  session: BlenderNativeSession,
  jobId: string,
  options: { consumeTerminal?: boolean } = {},
): Promise<BlenderLiveJob> {
  const deadline = Date.now() + NATIVE_JOB_TIMEOUT_MS;
  let pollDelayMs = 5;
  while (true) {
    const job = options.consumeTerminal ? await session.job(jobId, { consume: true }) : await session.job(jobId);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new BlenderNativeSessionError(
        job.error || "Blender could not complete the native request.",
        409,
        job.code ?? "blender_job_failed",
      );
    }
    if (Date.now() >= deadline) {
      throw new BlenderNativeSessionError("Blender native edit is still running.", 504, "blender_timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
    pollDelayMs = Math.min(50, pollDelayMs * 2);
  }
}

/** Bind Blender to the one native scene owned by the current Director project. */
export async function bindBlenderNativeSessionProject(session: BlenderNativeSession, projectId: string) {
  const status = await session.status();
  if (!status.available) {
    throw new BlenderNativeSessionError(status.reason, 503, "blender_unavailable");
  }
  if (status.projectId === projectId) return session.snapshot();

  const requestId = randomUUID();
  const accepted = await session.submit({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    operations: [{ op: "bind_director_project", projectId }],
  });
  await waitForNativeJob(session, accepted.jobId, { consumeTerminal: true });
  const snapshot = await session.snapshot();
  if (snapshot.projectId !== projectId) {
    throw new BlenderNativeSessionError(
      `Blender did not bind Director project ${projectId}.`,
      409,
      "blender_project_mismatch",
    );
  }
  return snapshot;
}

/** Flattens NAME spatial-query hits into one objects list, or null when no NAME query ran. */
function nameQueryObjects(result: unknown): unknown[] | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const queries = (result as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) return null;
  const objects: unknown[] = [];
  let sawName = false;
  for (const query of queries) {
    if (!query || typeof query !== "object" || Array.isArray(query)) continue;
    const record = query as Record<string, unknown>;
    if (record.kind !== "NAME") continue;
    sawName = true;
    if (Array.isArray(record.objects)) objects.push(...record.objects);
  }
  return sawName ? objects : null;
}

/** First per-operation result of a job (single-operation reads use this). */
function operationResult(job: BlenderLiveJob) {
  if (!job.result || typeof job.result !== "object" || Array.isArray(job.result)) return undefined;
  const operations = (job.result as Record<string, unknown>).operations;
  return Array.isArray(operations) ? operations[0] : undefined;
}

/** All per-operation results of a job, index-aligned with the request batch. */
function operationResults(job: BlenderLiveJob): unknown[] {
  if (!job.result || typeof job.result !== "object" || Array.isArray(job.result)) return [];
  const operations = (job.result as Record<string, unknown>).operations;
  return Array.isArray(operations) ? operations : [];
}

// Revisions the transaction actually committed at. Kernel-recorded values win
// over the snapshots' revisions because an intent replay observes a later
// scene than the one the edit committed against.
function nativeTransactionRevisions(
  job: BlenderLiveJob,
  before: BlenderLiveSceneSnapshot,
  after: BlenderLiveSceneSnapshot,
) {
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result) ? job.result : null;
  const revisionBefore = result && "revisionBefore" in result ? result.revisionBefore : null;
  const revisionAfter = result && "revisionAfter" in result ? result.revisionAfter : null;
  return {
    revisionBefore:
      typeof revisionBefore === "number" && Number.isInteger(revisionBefore) && revisionBefore >= 0
        ? revisionBefore
        : before.revision,
    revisionAfter:
      typeof revisionAfter === "number" && Number.isInteger(revisionAfter) && revisionAfter >= 0
        ? revisionAfter
        : after.revision,
  };
}

type SceneEntity =
  | BlenderLiveSceneSnapshot["objects"][number]
  | BlenderLiveSceneSnapshot["cameras"][number]
  | BlenderLiveSceneSnapshot["lights"][number];

/** De-duplicated, locale-stable sort so receipt id lists are deterministic. */
function sorted(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** All scene entities (objects, cameras, lights) indexed by id for diffing. */
function entityMap(scene: BlenderLiveSceneSnapshot) {
  return new Map<string, SceneEntity>(
    [...scene.objects, ...scene.cameras, ...(scene.lights ?? [])].map((entity) => [entity.id, entity]),
  );
}

function sceneMetrics(scene: BlenderLiveSceneSnapshot) {
  return {
    entities: scene.objects.length + scene.cameras.length + (scene.lights ?? []).length,
    objects: scene.objects.length,
    cameras: scene.cameras.length,
    lights: (scene.lights ?? []).length,
  };
}

// Recursively harvests every object id an untyped result mentions
// (object_id/objectId fields plus createdObjectIds arrays), because operator
// and script results have no fixed shape.
function objectIdsFromResult(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => objectIdsFromResult(entry, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const record = value as Record<string, unknown>;
  for (const key of ["object_id", "objectId"] as const) {
    if (typeof record[key] === "string") output.add(record[key]);
  }
  for (const key of ["createdObjectIds"] as const) {
    if (Array.isArray(record[key])) {
      record[key].forEach((candidate) => {
        if (typeof candidate === "string") output.add(candidate);
      });
    }
  }
  Object.values(record).forEach((entry) => objectIdsFromResult(entry, output));
  return output;
}

/** Ids a result explicitly declares as touched/selected/dirty (top level only). */
function changedObjectIdsFromResult(value: unknown) {
  const output = new Set<string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  const record = value as Record<string, unknown>;
  for (const key of ["selectedObjectIds", "touchedObjectIds", "affectedObjectIds", "dirtyObjectIds"] as const) {
    if (!Array.isArray(record[key])) continue;
    record[key].forEach((candidate) => {
      if (typeof candidate === "string") output.add(candidate);
    });
  }
  if (typeof record.activeObjectId === "string") output.add(record.activeObjectId);
  return output;
}

/** Only the ids a result marks as actually modified (excludes mere selection). */
function explicitDirtyObjectIdsFromResult(value: unknown) {
  const output = new Set<string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return output;
  const record = value as Record<string, unknown>;
  for (const key of ["affectedObjectIds", "dirtyObjectIds"] as const) {
    if (!Array.isArray(record[key])) continue;
    record[key].forEach((candidate) => {
      if (typeof candidate === "string") output.add(candidate);
    });
  }
  return output;
}

/** Coarse effect class: reads never dirty anything, selection ops dirty nothing durable. */
type OperationEffectTrait = "read" | "selection" | "content";

// Pose/animation edits mutate armature data without changing the scene graph,
// so snapshot diffing misses them; the target object is marked changed by name.
const ARMATURE_CONTENT_OPERATION_NAMES = new Set<string>([
  "set_pose_bone_transform",
  "apply_pose_offsets",
  "create_action",
  "set_active_action",
  "insert_pose_keyframes",
  "delete_pose_keyframes",
  "import_mixamo_action",
  "create_nla_track",
  "add_nla_strip",
  "update_nla_strip",
  "remove_nla_strip",
]);

function operationEffectTrait(operation: BlenderLiveOperation): OperationEffectTrait {
  const effect = blenderOperationEffect(operation.op);
  if (effect === "read") return "read";
  if (effect === "selection" || effect === "frame") return "selection";
  return "content";
}

// Selection state after one operation, best-effort: the result's own report
// wins, then the operation's declared context, then the observed scene.
function operationSelection(operation: BlenderLiveOperation, result: unknown, scene: BlenderLiveSceneSnapshot) {
  const resultRecord =
    result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  const context = "context" in operation && operation.context ? operation.context : null;
  const selectedFromResult = Array.isArray(resultRecord?.selectedObjectIds)
    ? resultRecord.selectedObjectIds.filter((value): value is string => typeof value === "string")
    : null;
  return {
    mode:
      (typeof resultRecord?.mode === "string" && resultRecord.mode) ||
      (context && context.mode) ||
      (operation.op === "set_selection" ? operation.mode : "OBJECT"),
    activeObjectId:
      (typeof resultRecord?.activeObjectId === "string" ? resultRecord.activeObjectId : null) ??
      context?.activeId ??
      scene.activeObjectId ??
      null,
    selectedObjectIds: sorted(selectedFromResult ?? context?.selectedIds ?? scene.selectedObjectIds ?? []),
  };
}

function collectResultWarning(result: unknown, warnings: string[]) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const warning = (result as { warning?: unknown }).warning;
  if (typeof warning === "string" && warning.trim()) warnings.push(warning);
}

function isSkippedOperationResult(result: unknown) {
  return Boolean(
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as { skipped?: unknown }).skipped === true,
  );
}

// Per-operation declared effect: what this operation says it created,
// changed, or deleted, derived from its typed shape (typed ops name their
// targets) plus whatever ids the untyped result reports. Open-ended ops
// (invoke_operator, execute_code, imports) fall back to harvested result ids
// and warn when nothing is attributable.
function declaredOperationEffect(operation: BlenderLiveOperation, result: unknown) {
  const created = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const warnings: string[] = [];
  collectResultWarning(result, warnings);
  const resultIds = objectIdsFromResult(result);
  const trait = operationEffectTrait(operation);
  if (trait !== "content") return { created, changed, deleted, warnings };
  if (isSkippedOperationResult(result)) return { created, changed, deleted, warnings };
  if (ARMATURE_CONTENT_OPERATION_NAMES.has(operation.op)) {
    const objectId = (operation as BlenderLiveOperation & { id?: unknown }).id;
    if (typeof objectId === "string") changed.add(objectId);
    explicitDirtyObjectIdsFromResult(result).forEach((id) => changed.add(id));
    return { created, changed, deleted, warnings };
  }
  switch (operation.op) {
    case "create_primitive":
    case "create_curve":
    case "create_text":
    case "create_camera":
    case "create_light":
      created.add(operation.id);
      break;
    case "create_opening":
      created.add(operation.id);
      changed.add(operation.targetId);
      break;
    case "create_blockout":
      resultIds.forEach((id) => created.add(id));
      break;
    case "duplicate_object":
      created.add(operation.newId);
      break;
    case "delete_object":
      deleted.add(operation.id);
      break;
    case "update_transform":
    case "set_object_name":
    case "set_object_visibility":
    case "set_camera_data":
    case "set_light_data":
    case "set_curve_data":
    case "set_text_data":
    case "project_uv":
    case "set_parent":
    case "add_constraint":
    case "remove_constraint":
    case "set_active_camera":
      changed.add(operation.id);
      break;
    case "assign_material":
    case "create_material_node":
    case "delete_material_node":
    case "set_material_node_input":
    case "connect_material_nodes":
    case "disconnect_material_node_input":
    case "ensure_geometry_nodes":
    case "create_geometry_node":
    case "delete_geometry_node":
    case "set_geometry_node_input":
    case "connect_geometry_nodes":
    case "disconnect_geometry_node_input":
      changed.add(operation.id);
      changedObjectIdsFromResult(result).forEach((id) => changed.add(id));
      break;
    case "move_to_collection":
      operation.ids.forEach((id) => changed.add(id));
      break;
    case "invoke_operator":
    case "execute_code":
    case "polyhaven_import":
    case "sketchfab_import":
      resultIds.forEach((id) => created.add(id));
      if (operation.op === "invoke_operator") {
        operation.context?.selectedIds.forEach((id) => changed.add(id));
      }
      if (operation.op === "polyhaven_import" && operation.objectId) changed.add(operation.objectId);
      changedObjectIdsFromResult(result).forEach((id) => {
        if (!created.has(id)) changed.add(id);
      });
      if (!changed.size && !resultIds.size) {
        warnings.push("Operator effect is scene-level; call inspect on the active object for detailed evidence.");
      }
      break;
    case "set_rna_property":
      if ("objectId" in operation.target) changed.add(operation.target.objectId);
      else warnings.push("RNA change is not directly attributable to one stable object ID.");
      break;
    case "add_modifier":
    case "set_modifier":
    case "remove_modifier":
    case "reorder_modifier":
    case "apply_modifier":
      changed.add(operation.id);
      break;
    case "set_geometry_modifier_input":
    case "assign_geometry_node_group":
      changed.add(operation.id);
      break;
    case "set_selection":
    case "select_mesh_elements":
    case "discover_operators":
    case "describe_operator":
    case "inspect_object":
    case "capture_render":
    case "undo_scene":
    case "redo_scene":
      break;
  }
  return { created, changed, deleted, warnings };
}

// Builds the effect receipt by reconciling two evidence sources: the
// observed before/after snapshot diff (ground truth for what exists) and each
// operation's declared effect (attribution of who did it). On a replayed
// intent the snapshots were observed later than the commit, so declared
// creates/deletes that contradict the current scene are kept as-is; on a
// fresh commit they are downgraded to "changed" when the entity existed both
// before and after.
function buildEffectReceipt(
  requestId: string,
  operations: BlenderLiveOperation[],
  results: unknown[],
  before: BlenderLiveSceneSnapshot,
  after: BlenderLiveSceneSnapshot,
  job: BlenderLiveJob,
) {
  const beforeEntities = entityMap(before);
  const afterEntities = entityMap(after);
  const transactionRevisions = nativeTransactionRevisions(job, before, after);
  const replayedIntent = transactionRevisions.revisionBefore !== before.revision;
  const hasContentOperation = operations.some((operation) => operationEffectTrait(operation) === "content");
  const created = new Set(hasContentOperation ? [...afterEntities.keys()].filter((id) => !beforeEntities.has(id)) : []);
  const deleted = new Set(hasContentOperation ? [...beforeEntities.keys()].filter((id) => !afterEntities.has(id)) : []);
  const changed = new Set(
    hasContentOperation
      ? [...afterEntities.entries()]
          .filter(
            ([id, entity]) =>
              beforeEntities.has(id) && JSON.stringify(beforeEntities.get(id)) !== JSON.stringify(entity),
          )
          .map(([id]) => id)
      : [],
  );
  const operationEffects = operations.map((operation, index) => {
    const result = results[index];
    const declared = declaredOperationEffect(operation, result);
    if (operations.length === 1 && operationEffectTrait(operation) === "content") {
      created.forEach((id) => declared.created.add(id));
      changed.forEach((id) => declared.changed.add(id));
      deleted.forEach((id) => declared.deleted.add(id));
    }
    if (!replayedIntent) {
      declared.created.forEach((id) => {
        if (beforeEntities.has(id) && afterEntities.has(id)) {
          declared.created.delete(id);
          declared.changed.add(id);
        }
      });
      declared.deleted.forEach((id) => {
        if (afterEntities.has(id)) {
          declared.deleted.delete(id);
          declared.changed.add(id);
        }
      });
    }
    declared.created.forEach((id) => created.add(id));
    declared.changed.forEach((id) => changed.add(id));
    declared.deleted.forEach((id) => deleted.add(id));
    const dirty = sorted([...declared.created, ...declared.changed, ...declared.deleted]);
    const selection = operationSelection(operation, result, after);
    return {
      index,
      op: operation.op,
      createdObjectIds: sorted(declared.created),
      changedObjectIds: sorted(declared.changed),
      deletedObjectIds: sorted(declared.deleted),
      dirtyObjectIds: dirty,
      ...selection,
      metrics: {
        created: declared.created.size,
        changed: declared.changed.size,
        deleted: declared.deleted.size,
        dirty: dirty.length,
      },
      warnings: declared.warnings,
    };
  });
  const dirty = sorted([...created, ...changed, ...deleted]);
  const lastSelection = operationEffects.at(-1) ?? {
    mode: "OBJECT",
    activeObjectId: after.activeObjectId,
    selectedObjectIds: after.selectedObjectIds,
  };
  const warnings = operationEffects.flatMap((effect) => effect.warnings);
  if (replayedIntent) {
    warnings.push(
      `Intent originally committed at revisions ${transactionRevisions.revisionBefore}-${transactionRevisions.revisionAfter}; focused evidence was observed at revision ${after.revision}.`,
    );
  } else if (job.revision !== null && job.revision !== after.revision) {
    warnings.push(`Job revision ${job.revision} differs from observed scene revision ${after.revision}.`);
  }
  return blenderEffectReceiptSchema.parse({
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch: after.sceneEpoch,
    requestId,
    revisionBefore: transactionRevisions.revisionBefore,
    revisionAfter: transactionRevisions.revisionAfter,
    createdObjectIds: sorted(created),
    changedObjectIds: sorted(changed),
    deletedObjectIds: sorted(deleted),
    dirtyObjectIds: dirty,
    selection: {
      mode: lastSelection.mode,
      activeObjectId: lastSelection.activeObjectId,
      selectedObjectIds: lastSelection.selectedObjectIds,
    },
    metrics: { before: sceneMetrics(before), after: sceneMetrics(after) },
    operations: operationEffects,
    warnings: sorted(warnings),
  });
}

/** Post-edit state of only the dirty entities — the compact proof an agent inspects. */
function focusedEvidence(scene: BlenderLiveSceneSnapshot, dirtyObjectIds: string[]) {
  const dirty = new Set(dirtyObjectIds);
  return blenderFocusedEvidenceSchema.parse({
    sceneEpoch: scene.sceneEpoch,
    revision: scene.revision,
    objects: scene.objects.filter((object) => dirty.has(object.id)),
    cameras: scene.cameras.filter((camera) => dirty.has(camera.id)),
    lights: (scene.lights ?? []).filter((light) => dirty.has(light.id)),
  });
}

/** Lowers one public tool request to the kernel operation batch it executes as. */
function nativeRequest(input: Exclude<BlenderNativeToolRequest, { op: "status" | "scene" | "live_link" }>): {
  operations: BlenderLiveOperation[];
  expectedSceneEpoch?: string;
  expectedRevision?: number;
} {
  switch (input.op) {
    case "catalog":
      return {
        operations: [
          {
            op: "discover_operators",
            query: input.query,
            category: input.category,
            scope: input.scope,
            availableOnly: input.availableOnly,
            limit: input.limit,
          },
        ],
      };
    case "describe":
      if (!input.operator) {
        throw new BlenderNativeSessionError(BLENDER_NATIVE_DESCRIBE_XOR_MESSAGE, 400, "invalid_describe");
      }
      return {
        operations: [{ op: "describe_operator", operator: input.operator }],
      };
    case "inspect":
      return {
        operations: [{ op: "inspect_object", id: input.id }],
        expectedSceneEpoch: input.expectedSceneEpoch,
        expectedRevision: input.expectedRevision,
      };
    case "capture":
    case "capture_render":
      return {
        operations: [
          {
            op: "capture_render",
            cameraId: input.cameraId,
            width: input.width,
            height: input.height,
            transparent: input.transparent,
          },
        ],
      };
    case "query":
      return { operations: [{ op: "query_spatial", queries: input.queries }] };
    case "polyhaven_search":
      return {
        operations: [
          {
            op: "polyhaven_search",
            assetType: input.assetType,
            categories: input.categories,
            query: input.query,
            limit: input.limit,
          },
        ],
      };
    case "sketchfab_search":
      return {
        operations: [
          {
            op: "sketchfab_search",
            query: input.query,
            count: input.count,
          },
        ],
      };
    case "apply":
      return {
        operations: input.operations,
        expectedSceneEpoch: input.expectedSceneEpoch,
        expectedRevision: input.expectedRevision,
      };
  }
}

/**
 * Executes a Blender native tool request against the live session.
 *
 * Read operations (status, scene, catalog, describe, inspect, capture,
 * capture_render, query, polyhaven_search, sketchfab_search) are forwarded
 * directly. Apply operations
 * are wrapped with intent-based
 * idempotency: if the caller provides an `intentId`, the effect is cached
 * and replayed on exact retry. When the caller omits `intentId`, one is derived
 * from the scene epoch, revision, and operation batch.
 *
 * For apply operations, the result includes a focused evidence snapshot
 * containing only the objects, cameras, and lights that changed.
 *
 * @param session - The Blender native session client.
 * @param input - The tool request (status, scene, catalog, describe, inspect, capture, capture_render, query, live_link, or apply).
 * @param options - Optional dependencies; `loadDirectorProject` resolves the
 *   persisted Director project so inspect results carry kernel ownership.
 * @returns A typed result depending on the operation kind.
 * @throws {BlenderNativeSessionError} On contract mismatch, timeout, or native failure.
 */
export async function executeBlenderNativeTool(
  session: BlenderNativeSession,
  input: BlenderNativeToolRequest,
  options: { loadDirectorProject?: () => Promise<DirectorProject | null> } = {},
) {
  if (input.op === "status") return session.status();
  if (input.op === "scene") return session.snapshot();
  if (input.op === "live_link") {
    // Preview-only delta feed: served straight from the kernel buffer and
    // never authoritative. Consumers resync from `scene` on epoch changes,
    // gaps, or evicted history.
    return session.liveLink(
      input.sceneEpoch !== undefined && input.since !== undefined
        ? { sceneEpoch: input.sceneEpoch, since: input.since }
        : undefined,
    );
  }
  if (input.op === "describe" && input.target) {
    const described = describeBlenderNativeTarget(input.target);
    if (!described.success) {
      throw new BlenderNativeSessionError(described.error, 400, "invalid_describe_target");
    }
    return { result: described.result, described: described.result };
  }

  // Fill missing boundary fields from a live observation: applies without an
  // explicit epoch/revision/intent get them derived here, which is what makes
  // an unadorned retry of the same batch idempotent against the same scene.
  let observed: BlenderLiveSceneSnapshot | null = null;
  if (input.op === "apply" && (!input.expectedSceneEpoch || input.expectedRevision === undefined || !input.intentId)) {
    observed = await session.snapshot();
    const expectedSceneEpoch = input.expectedSceneEpoch ?? observed.sceneEpoch;
    const expectedRevision = input.expectedRevision ?? observed.revision;
    input = {
      ...input,
      expectedSceneEpoch,
      expectedRevision,
      intentId: input.intentId ?? deriveBlenderIntentId(expectedSceneEpoch, expectedRevision, input.operations),
    };
  } else if (input.op === "inspect" && (!input.expectedSceneEpoch || input.expectedRevision === undefined)) {
    observed = await session.snapshot();
    input = {
      ...input,
      expectedSceneEpoch: input.expectedSceneEpoch ?? observed.sceneEpoch,
      expectedRevision: input.expectedRevision ?? observed.revision,
    };
  }

  // Gateway-side intent replay: an exact retry of a committed apply returns
  // the cached receipt without touching Blender at all.
  if (input.op === "apply" && input.intentId) {
    const cached = cachedEffect(session, input.intentId);
    if (cached) {
      assertSameIntent(input.intentId, cached, effectIntent(input));
      return blenderNativeApplyResultSchema.parse({
        sceneEpoch: cached.receipt.sceneEpoch,
        job: cached.job,
        receipt: cached.receipt,
        evidence: cached.evidence,
      });
    }
  }

  const request = nativeRequest(input);
  assertBlenderLiveKernelPolicy(request.operations);
  const before = input.op === "apply" ? (observed ?? (await session.snapshot())) : null;
  if (input.op === "apply" && before?.sceneEpoch !== input.expectedSceneEpoch) {
    throw new BlenderNativeSessionError(
      `Blender scene changed: expected epoch ${input.expectedSceneEpoch}, current epoch ${before?.sceneEpoch}.`,
      409,
      "scene_epoch_conflict",
    );
  }
  const requestId = input.op === "apply" && input.intentId ? input.intentId : crypto.randomUUID();
  try {
    const accepted = await session.submit({
      contract: BLENDER_LIVE_CONTRACT,
      requestId,
      expectedSceneEpoch: request.expectedSceneEpoch,
      expectedRevision: request.expectedRevision,
      operations: request.operations,
    });
    // Capture is read-only and retry-safe, so consume its terminal record and
    // free the detached PNG payload inside Blender. Apply records must stay
    // for Blender-side idempotent intent replay.
    const job = await waitForNativeJob(session, accepted.jobId, {
      consumeTerminal: isBlenderNativeCaptureOp(input.op),
    });
    if (input.op === "apply") {
      const transactionSnapshots = nativeTransactionSnapshots(job);
      const receiptBefore = transactionSnapshots.before ?? before!;
      const scene = transactionSnapshots.after ?? (await session.snapshot());
      const receipt = buildEffectReceipt(requestId, input.operations, operationResults(job), receiptBefore, scene, job);
      const evidence = focusedEvidence(scene, receipt.dirtyObjectIds);
      const exposedJob = publicBlenderJob(job);
      if (input.intentId) {
        rememberEffect(session, input.intentId, {
          intent: effectIntent(input),
          job: exposedJob,
          receipt,
          evidence,
        });
      }
      return blenderNativeApplyResultSchema.parse({
        sceneEpoch: scene.sceneEpoch,
        job: exposedJob,
        receipt,
        evidence,
      });
    }

    const result = operationResult(job);
    if (input.op === "inspect") {
      const compacted = compactBlenderInspection(result);
      const inspection = {
        ...compacted,
        kernel_ownership: await blenderInspectionKernelOwnership(compacted.id, options.loadDirectorProject),
      };
      return { result: inspection, inspection };
    }
    if (input.op === "query") {
      const objects = nameQueryObjects(result);
      const shaped =
        objects && result && typeof result === "object" && !Array.isArray(result)
          ? { ...(result as Record<string, unknown>), objects }
          : result;
      return { job: publicBlenderJob(job), result: shaped };
    }
    if (!isBlenderNativeCaptureOp(input.op)) return { job: publicBlenderJob(job), result };
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new BlenderNativeSessionError(
        "Blender capture completed without an image.",
        502,
        "blender_capture_invalid",
      );
    }
    const capture = result as Record<string, unknown>;
    if (typeof capture.dataBase64 !== "string" || typeof capture.mimeType !== "string") {
      throw new BlenderNativeSessionError("Blender capture returned an invalid image.", 502, "blender_capture_invalid");
    }
    const { dataBase64: _dataBase64, ...captureResult } = capture;
    return { result: captureResult, capture };
  } catch (error) {
    if (input.op === "apply" && input.intentId && isUncertainNativeFailure(error)) {
      throw uncertainNativeApply(error as BlenderNativeSessionError, input);
    }
    throw error;
  }
}

/** A binary GLB scene preview ready for HTTP response streaming. */
export type BlenderScenePreviewBinary = {
  /** The scene epoch at the time the preview was captured. */
  sceneEpoch: string;
  /** The scene revision at the time the preview was captured. */
  revision: number;
  /** Always `model/gltf-binary`. */
  mimeType: "model/gltf-binary";
  /** Raw GLB bytes. */
  bytes: Buffer;
  /** Total byte length of the preview. */
  byteLength: number;
};

async function downloadScenePreviewBytes(session: BlenderNativeSession, jobId: string) {
  try {
    return await session.previewGlb(jobId, { consume: true });
  } catch (error) {
    if (!(error instanceof BlenderNativeSessionError) || error.status !== 404) throw error;
    // Version skew: an older native session has no binary preview endpoint.
    // Re-read the job with consume=1 so it reattaches the detached base64
    // payload, and decode that payload once here.
    const consumed = await session.job(jobId, { consume: true });
    const attached = blenderScenePreviewSchema.parse(operationResult(consumed));
    if (!attached.dataBase64) throw error;
    return {
      bytes: Buffer.from(attached.dataBase64, "base64"),
      sceneEpoch: attached.sceneEpoch,
      revision: attached.revision,
    };
  }
}

/**
 * Exports a full-scene GLB preview from the native session for the
 * authenticated browser route. Handles version skew gracefully: if the native
 * session does not support the binary preview endpoint, the base64 payload
 * from the job result is decoded instead.
 *
 * @param session - The Blender native session client.
 * @returns The public job record and binary GLB preview.
 * @throws {BlenderNativeSessionError} When the preview fails or byte lengths mismatch.
 */
export async function exportBlenderScenePreview(
  session: BlenderNativeSession,
): Promise<{ job: BlenderLiveJob; preview: BlenderScenePreviewBinary }> {
  const requestId = crypto.randomUUID();
  const accepted = await session.submit({
    contract: BLENDER_LIVE_CONTRACT,
    requestId,
    operations: [{ op: "export_scene_preview" }],
  });
  // Poll without consuming so the detached GLB stays available for the binary
  // endpoint, then let that endpoint discard the record after a full download.
  const job = await waitForNativeJob(session, accepted.jobId);
  const metadata = blenderScenePreviewSchema.parse(operationResult(job));
  const { bytes, sceneEpoch, revision } = await downloadScenePreviewBytes(session, accepted.jobId);
  if (bytes.byteLength !== metadata.byteLength) {
    throw new BlenderNativeSessionError(
      "Blender preview byte length did not match the native result.",
      502,
      "blender_preview_invalid",
    );
  }
  return {
    job: publicBlenderJob(job),
    preview: {
      sceneEpoch,
      revision,
      mimeType: metadata.mimeType,
      bytes,
      byteLength: bytes.byteLength,
    },
  };
}
