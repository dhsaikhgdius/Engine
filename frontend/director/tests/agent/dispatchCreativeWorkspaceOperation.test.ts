import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatchSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/agent/dispatchCreativeWorkspaceOperation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent/dispatchCreativeWorkspaceOperation")>();
  dispatchSpy.mockImplementation(actual.dispatchCreativeWorkspaceOperation);
  return { ...actual, dispatchCreativeWorkspaceOperation: dispatchSpy };
});

import { executeCreativeWorkspaceAgentOperation } from "../../src/agent/creativeWorkspaceAgentContract";
import { dispatchCreativeWorkspaceOperation } from "../../src/agent/dispatchCreativeWorkspaceOperation";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
} from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import {
  findDirectorEditClip,
  useDirectorCreativeWorkspaceStore,
} from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

const VIDEO_ASSET: CreativeMediaAsset = {
  id: "media:video:take",
  kind: "video",
  name: "Take",
  fileName: "take.webm",
  mimeType: "video/webm",
  size: 4_096,
  createdAt: "2026-08-25T08:00:00.000Z",
  lastModified: null,
  durationSec: 12,
  width: 1_920,
  height: 1_080,
  source: "test",
  objectUrl: "blob:take-preview",
};

describe("creative workspace UI routing through the shared agent execute path", () => {
  beforeEach(() => {
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
    persistentCreativeMediaLibrary.store.setState({ assets: [{ ...VIDEO_ASSET }] });
    dispatchSpy.mockClear();
  });

  afterEach(() => {
    persistentCreativeMediaLibrary.store.setState({ assets: [] });
  });

  it("routes addBoardNode with fingerprint + idempotency and keeps one undo entry", () => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    const nodesBefore = store.boardNodes.length;
    const node = store.addBoardNode({ kind: "note", title: "分镜备注", x: 40, y: 60 });
    expect(node).not.toBeNull();

    const state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.boardNodes).toHaveLength(nodesBefore + 1);
    expect(state.selectedBoardNodeId).toBe(node!.id);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]![0]).toMatchObject({ op: "canvas.node.add", kind: "note", title: "分镜备注" });
    const receipt = dispatchSpy.mock.results[0]!.value as Record<string, unknown>;
    expect(receipt.ok).toBe(true);
    expect(String(receipt.idempotency_key)).toMatch(/^ui-creative:/);
    expect(receipt.snapshot_fingerprint).not.toBe(receipt.snapshot_fingerprint_before);

    expect(state.canUndo).toBe(true);
    state.undo();
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes).toHaveLength(nodesBefore);
  });

  it("keeps history-batched drags on the local path", () => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    const node = store.addBoardNode({ kind: "note", title: "拖拽", x: 0, y: 0 })!;
    dispatchSpy.mockClear();
    store.beginHistoryBatch();
    try {
      store.updateBoardNode(node.id, { x: 120, y: 80 });
    } finally {
      store.endHistoryBatch();
    }
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.find((item) => item.id === node.id)).toMatchObject({
      x: 120,
      y: 80,
    });
  });

  it("does not re-enter the contract while the agent executes an operation", () => {
    const nodesBefore = useDirectorCreativeWorkspaceStore.getState().boardNodes.length;
    const result = executeCreativeWorkspaceAgentOperation({
      op: "canvas.node.add",
      kind: "note",
      title: "Agent 备注",
      x: 10,
      y: 20,
    });
    expect(result.success).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes).toHaveLength(nodesBefore + 1);
  });

  it("routes addClip for cataloged media and falls back local for unknown media", () => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    const routedClip = store.addClip({
      trackId: "video-1",
      mediaId: VIDEO_ASSET.id,
      name: "已编目",
      startSec: 0,
      durationSec: 4,
    });
    expect(routedClip).not.toBeNull();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]![0]).toMatchObject({
      op: "edit.clip.add",
      track_id: "video-1",
      media_id: VIDEO_ASSET.id,
    });
    const afterRouted = useDirectorCreativeWorkspaceStore.getState();
    expect(afterRouted.selectedClipId).toBe(routedClip!.id);
    expect(afterRouted.playheadSec).toBe(routedClip!.startSec);

    dispatchSpy.mockClear();
    const localClip = afterRouted.addClip({
      trackId: "video-1",
      mediaId: "media:unknown",
      name: "未编目",
      startSec: 6,
      durationSec: 2,
    });
    expect(localClip).not.toBeNull();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("routes plain clip updates but leaves invariant-resolving updates local", () => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    const clip = store.addClip({
      trackId: "video-1",
      mediaId: VIDEO_ASSET.id,
      name: "渐变",
      startSec: 0,
      durationSec: 8,
      fadeInSec: 2,
      fadeOutSec: 2,
    })!;

    dispatchSpy.mockClear();
    useDirectorCreativeWorkspaceStore.getState().updateClip(clip.id, { opacity: 0.5, name: "重命名" });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]![0]).toMatchObject({ op: "edit.clip.update", clip_id: clip.id });
    const routed = findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clip.id)!.clip;
    expect(routed.opacity).toBe(0.5);
    expect(routed.name).toBe("重命名");

    // The strict path rejects fades exceeding the new duration; the local path
    // scales them down, so this intent must stay local.
    dispatchSpy.mockClear();
    useDirectorCreativeWorkspaceStore.getState().updateClip(clip.id, { durationSec: 2 });
    expect(dispatchSpy).not.toHaveBeenCalled();
    const clamped = findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clip.id)!.clip;
    expect(clamped.durationSec).toBe(2);
    expect(clamped.fadeInSec + clamped.fadeOutSec).toBeLessThanOrEqual(2 + 1e-9);
  });

  it("routes track add/remove but keeps locked-track removal local", () => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    const track = store.addTrack("audio")!;
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]![0]).toMatchObject({ op: "edit.track.add", kind: "audio" });

    dispatchSpy.mockClear();
    useDirectorCreativeWorkspaceStore.getState().toggleTrackLock(track.id);
    useDirectorCreativeWorkspaceStore.getState().removeTrack(track.id);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(useDirectorCreativeWorkspaceStore.getState().editTracks.some((item) => item.id === track.id)).toBe(false);
  });

  it("fails closed on strict-path rejections and stale fingerprints", () => {
    const missing = dispatchCreativeWorkspaceOperation({ op: "canvas.node.remove", node_id: "missing-node" });
    expect(missing).toMatchObject({ ok: false, code: "not_found" });

    const stale = dispatchCreativeWorkspaceOperation(
      { op: "canvas.node.remove", node_id: "missing-node" },
      { expectedSnapshotFingerprint: "creative-revision:v1:bogus" },
    );
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
  });
});
