import { blenderOperationEffect } from "../../../../../../packages/protocol/src/blenderOperationManifest";
import type {
  BlenderAgentOperation,
  BlenderLiveCommandBatch,
  BlenderLiveOperation,
  BlenderLiveSceneSnapshot,
  BlenderNativeApplyResult,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import {
  applyBlenderNativeBatch,
  applyBlenderNativeOperations,
  BlenderLiveClientError,
} from "../api/blenderLiveClient";
import { useBlenderRuntimeStore } from "./blenderRuntimeStore";

function mergeEvidence<T extends { id: string }>(current: T[], evidence: T[], deleted: ReadonlySet<string>): T[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const currentIds = new Set(current.map((item) => item.id));
  return [
    ...current.filter((item) => !deleted.has(item.id)).map((item) => evidenceById.get(item.id) ?? item),
    ...evidence.filter((item) => !deleted.has(item.id) && !currentIds.has(item.id)),
  ];
}

/** Projects a native transaction receipt into the shared scene snapshot without a second full-scene fetch. */
export function projectBlenderRuntimeTransaction(
  snapshot: BlenderLiveSceneSnapshot,
  result: BlenderNativeApplyResult,
  operations: readonly BlenderLiveOperation[],
): BlenderLiveSceneSnapshot | null {
  if (
    snapshot.sceneEpoch !== result.receipt.sceneEpoch ||
    snapshot.revision !== result.receipt.revisionBefore ||
    result.evidence.sceneEpoch !== result.receipt.sceneEpoch ||
    result.evidence.revision !== result.receipt.revisionAfter
  ) {
    return null;
  }

  const deleted = new Set(result.receipt.deletedObjectIds);
  const frameOperation = [...operations].reverse().find((operation) => operation.op === "set_scene_frame");
  const changesVisibleContent = operations.some((operation) => {
    const effect = blenderOperationEffect(operation.op);
    return effect === "content" || effect === "history";
  });

  return {
    ...snapshot,
    revision: result.receipt.revisionAfter,
    contentRevision: changesVisibleContent ? result.receipt.revisionAfter : snapshot.contentRevision,
    frame: frameOperation?.op === "set_scene_frame" ? frameOperation.frame : snapshot.frame,
    objects: mergeEvidence(snapshot.objects, result.evidence.objects, deleted),
    cameras: mergeEvidence(snapshot.cameras, result.evidence.cameras, deleted),
    lights: mergeEvidence(snapshot.lights, result.evidence.lights, deleted),
    selectedObjectIds: result.receipt.selection.selectedObjectIds,
    activeObjectId: result.receipt.selection.activeObjectId,
  };
}

function publishTransaction(result: BlenderNativeApplyResult, operations: readonly BlenderLiveOperation[]) {
  const runtime = useBlenderRuntimeStore.getState();
  const projected = runtime.snapshot ? projectBlenderRuntimeTransaction(runtime.snapshot, result, operations) : null;
  if (projected) runtime.publishSnapshot(projected);

  const needsImmediateRefresh =
    !projected ||
    operations.some((operation) => {
      const effect = blenderOperationEffect(operation.op);
      return effect === undefined || effect === "content" || effect === "history";
    });
  if (needsImmediateRefresh) runtime.requestRefresh();
  return projected;
}

function refreshAfterConflict(error: unknown) {
  if (error instanceof BlenderLiveClientError && error.status === 409) {
    useBlenderRuntimeStore.getState().requestRefresh();
  }
}

export type BlenderRuntimeTransactionResult = BlenderNativeApplyResult & {
  projectedSnapshot: BlenderLiveSceneSnapshot | null;
};

/** Commits typed operations through one revision-bound Director transaction boundary. */
export async function applyBlenderRuntimeOperations(options: {
  expectedSceneEpoch: string;
  expectedRevision: number;
  operations: BlenderAgentOperation[];
  intentId?: string;
  signal?: AbortSignal;
  beforePublish?: (result: BlenderNativeApplyResult) => void;
}): Promise<BlenderRuntimeTransactionResult> {
  try {
    const { beforePublish, ...request } = options;
    const result = await applyBlenderNativeOperations({
      ...request,
      intentId: options.intentId ?? crypto.randomUUID(),
    });
    beforePublish?.(result);
    return { ...result, projectedSnapshot: publishTransaction(result, options.operations) };
  } catch (error) {
    refreshAfterConflict(error);
    throw error;
  }
}

/** Commits an already validated live command batch through the same projection boundary. */
export async function applyBlenderRuntimeBatch(
  batch: BlenderLiveCommandBatch,
  options: { signal?: AbortSignal } = {},
): Promise<BlenderRuntimeTransactionResult> {
  try {
    const result = await applyBlenderNativeBatch(batch, options);
    return { ...result, projectedSnapshot: publishTransaction(result, batch.operations) };
  } catch (error) {
    refreshAfterConflict(error);
    throw error;
  }
}
