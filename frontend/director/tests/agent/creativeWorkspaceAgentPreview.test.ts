import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreativeMediaAsset,
  PersistentCreativeMediaState,
} from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { useDirectorCreativeWorkspaceStore } from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  creativeWorkspaceAgentPreviewResultSchema,
  creativeWorkspaceAgentRequestSchema,
  getCreativeWorkspaceAgentCapabilities,
  observeCreativeWorkspaceAgentSnapshot,
  type CreativeWorkspaceAgentContext,
} from "../../src/agent/creativeWorkspaceAgentContract";
import {
  captureCreativeWorkspacePreview,
  executeCreativeWorkspaceAgentPreviewRequest,
  type CreativeWorkspacePreviewDependencies,
} from "../../src/agent/creativeWorkspaceAgentPreview";

const IMAGE_ASSET: CreativeMediaAsset = {
  id: "media:image:board",
  kind: "image",
  name: "Board image",
  fileName: "board.png",
  mimeType: "image/png",
  size: 512,
  createdAt: "2026-07-31T08:00:00.000Z",
  lastModified: null,
  durationSec: null,
  width: 1_920,
  height: 1_080,
  source: "test",
  objectUrl: "blob:board-image",
};

function mediaState(assets: readonly CreativeMediaAsset[] = [IMAGE_ASSET]): PersistentCreativeMediaState {
  return {
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets,
  };
}

function context(assets: readonly CreativeMediaAsset[] = [IMAGE_ASSET]): CreativeWorkspaceAgentContext {
  return {
    workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
    media: { getState: () => mediaState(assets) },
  };
}

function fakeCanvasDependencies() {
  const calls: string[] = [];
  const context2d = {
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    quadraticCurveTo: () => calls.push("quadraticCurveTo"),
    bezierCurveTo: () => calls.push("bezierCurveTo"),
    closePath: () => calls.push("closePath"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    setLineDash: () => calls.push("setLineDash"),
    fillRect: () => calls.push("fillRect"),
    fillText: () => calls.push("fillText"),
    measureText: (text: string) => ({ width: text.length * 7 }),
    translate: () => calls.push("translate"),
    scale: () => calls.push("scale"),
    drawImage: () => calls.push("drawImage"),
    clip: () => calls.push("clip"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context2d),
    toDataURL: vi.fn(() => "data:image/png;base64,Y2FudmFz"),
  } as unknown as HTMLCanvasElement;
  const dependencies: CreativeWorkspacePreviewDependencies = {
    createCanvas: () => canvas,
    loadCanvasVisual: vi.fn(async () => ({
      source: {} as CanvasImageSource,
      width: 1_920,
      height: 1_080,
    })),
  };
  return { calls, canvas, dependencies };
}

beforeEach(() => {
  localStorage.clear();
  useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
});

describe("creative workspace Agent preview", () => {
  it("publishes a fingerprint-bound clean preview contract", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    expect(
      creativeWorkspaceAgentRequestSchema.safeParse({
        op: "preview",
        workspace: "video",
        time_sec: 1.25,
        expected_snapshot_fingerprint: fingerprint,
      }).success,
    ).toBe(true);
    expect(creativeWorkspaceAgentRequestSchema.safeParse({ op: "preview", workspace: "canvas" }).success).toBe(true);
    expect(getCreativeWorkspaceAgentCapabilities()).toMatchObject({
      request_ops: expect.arrayContaining(["preview"]),
      concurrency: { required_for: expect.arrayContaining(["preview"]) },
      preview: { format: "image/png", clean_frame: true, mutates_playhead: false },
      recommended_loop: expect.arrayContaining([expect.stringContaining("preview")]),
    });
  });

  it("renders the complete Canvas board with real media thumbnails and no editor helpers", async () => {
    const runtime = context();
    const state = useDirectorCreativeWorkspaceStore.getState();
    const noteNode = state.addBoardNode({
      kind: "note",
      title: "Opening beat",
      body: "Establish the room",
      x: 120,
      y: 80,
    });
    const imageNode = state.addBoardNode({
      kind: "image",
      title: "Reference",
      body: "Hero silhouette",
      mediaId: IMAGE_ASSET.id,
      x: 620,
      y: 140,
    });
    if (!noteNode || !imageNode) throw new Error("Expected Canvas nodes");
    state.addBoardEdge(noteNode.id, imageNode.id);
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const boardBefore = JSON.stringify(before.board);
    const { calls, dependencies } = fakeCanvasDependencies();

    const capture = await captureCreativeWorkspacePreview(
      {
        op: "preview",
        workspace: "canvas",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
      },
      runtime,
      undefined,
      dependencies,
    );

    expect(capture).toMatchObject({
      workspace: "canvas",
      snapshotFingerprint: before.snapshot_fingerprint,
      dataUrl: expect.stringMatching(/^data:image\/png/),
      width: 1_440,
      height: 900,
      cleanFrame: true,
      helpersIncluded: false,
      metadata: {
        kind: "canvas_board",
        nodeCount: 2,
        edgeCount: 1,
        mediaThumbnailCount: 1,
        worldBounds: { width: expect.any(Number), height: expect.any(Number) },
      },
    });
    expect(calls).toEqual(expect.arrayContaining(["bezierCurveTo", "drawImage", "fillText"]));
    expect(JSON.stringify(observeCreativeWorkspaceAgentSnapshot(runtime).board)).toBe(boardBefore);

    const wire = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "canvas",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
      },
      runtime,
      undefined,
      dependencies,
    );
    expect(creativeWorkspaceAgentPreviewResultSchema.safeParse(wire.preview).success).toBe(true);
    expect(wire).toMatchObject({
      op: "preview",
      preview: {
        success: true,
        workspace: "canvas",
        clean_frame: true,
        helpers_included: false,
        metadata: { kind: "canvas_board", node_count: 2, edge_count: 1 },
      },
    });
  });

  it("renders a requested Video time through the export compositor without seeking the live playhead", async () => {
    const runtime = context();
    const state = useDirectorCreativeWorkspaceStore.getState();
    state.addClip({
      trackId: "video-1",
      mediaId: IMAGE_ASSET.id,
      name: "Reference hold",
      startSec: 1,
      durationSec: 4,
      sourceDurationSec: 60,
    });
    const playheadBefore = useDirectorCreativeWorkspaceStore.getState().playheadSec;
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const renderTimelineFrame = vi.fn(async (options: { timeSec: number }) => ({
      dataUrl: "data:image/png;base64,dmlkZW8=",
      width: 1_280,
      height: 720,
      timeSec: options.timeSec,
      activeClipIds: [useDirectorCreativeWorkspaceStore.getState().editTracks[0]!.clips[0]!.id],
    }));

    const result = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "auto",
        time_sec: 2.5,
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
      },
      runtime,
      undefined,
      {
        renderTimelineFrame:
          renderTimelineFrame as typeof import("../../src/comprehensive/editor/workspaces/directorTimelineVideoExport").renderDirectorTimelineFrame,
      },
    );

    expect(renderTimelineFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        timeSec: 2.5,
        aspectRatio: "16 / 9",
        quality: "preview",
        mediaItems: [expect.objectContaining({ id: IMAGE_ASSET.id, sourceUrl: IMAGE_ASSET.objectUrl })],
      }),
    );
    expect(result).toMatchObject({
      op: "preview",
      preview: {
        success: true,
        workspace: "video",
        metadata: {
          kind: "video_frame",
          time_sec: 2.5,
          fps: 24,
          active_layer_count: 1,
        },
      },
    });
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBe(playheadBefore);
  });

  it("chooses a deterministic visible interior when the omitted Video time points at a fade boundary", async () => {
    const runtime = context();
    const state = useDirectorCreativeWorkspaceStore.getState();
    const clip = state.addClip({
      trackId: "video-1",
      mediaId: IMAGE_ASSET.id,
      name: "Faded reference",
      startSec: 4,
      durationSec: 4,
      sourceDurationSec: 60,
      fadeInSec: 1,
      fadeOutSec: 1,
    });
    if (!clip) throw new Error("Expected faded clip");
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBe(4);
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const renderTimelineFrame = vi.fn(async (options: { timeSec: number }) => ({
      dataUrl: "data:image/png;base64,cmVwcmVzZW50YXRpdmU=",
      width: 1_280,
      height: 720,
      timeSec: options.timeSec,
      activeClipIds: [clip.id],
    }));

    const result = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "video",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
      },
      runtime,
      undefined,
      {
        renderTimelineFrame:
          renderTimelineFrame as typeof import("../../src/comprehensive/editor/workspaces/directorTimelineVideoExport").renderDirectorTimelineFrame,
      },
    );

    expect(renderTimelineFrame).toHaveBeenCalledWith(expect.objectContaining({ timeSec: 6 }));
    expect(result).toMatchObject({
      preview: { success: true, metadata: { kind: "video_frame", time_sec: 6, active_clip_ids: [clip.id] } },
    });
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBe(4);
  });

  it("keeps an omitted Video time at the current playhead when it is meaningfully inside visible content", async () => {
    const runtime = context();
    const state = useDirectorCreativeWorkspaceStore.getState();
    const clip = state.addClip({
      trackId: "video-1",
      mediaId: IMAGE_ASSET.id,
      name: "Current reference",
      startSec: 2,
      durationSec: 5,
      sourceDurationSec: 60,
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
    });
    if (!clip) throw new Error("Expected current clip");
    state.setPlayhead(3.25);
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const renderTimelineFrame = vi.fn(async (options: { timeSec: number }) => ({
      dataUrl: "data:image/png;base64,cGxheWhlYWQ=",
      width: 1_280,
      height: 720,
      timeSec: options.timeSec,
      activeClipIds: [clip.id],
    }));

    const result = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "video",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
      },
      runtime,
      undefined,
      {
        renderTimelineFrame:
          renderTimelineFrame as typeof import("../../src/comprehensive/editor/workspaces/directorTimelineVideoExport").renderDirectorTimelineFrame,
      },
    );

    expect(renderTimelineFrame).toHaveBeenCalledWith(expect.objectContaining({ timeSec: 3.25 }));
    expect(result).toMatchObject({
      preview: { success: true, metadata: { kind: "video_frame", time_sec: 3.25 } },
    });
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBe(3.25);
  });

  it("fits even widely separated Canvas nodes into the complete-board preview", async () => {
    const runtime = context();
    const state = useDirectorCreativeWorkspaceStore.getState();
    state.addBoardNode({
      kind: "note",
      title: "Near beat",
      x: 0,
      y: 0,
    });
    state.addBoardNode({
      kind: "note",
      title: "Distant beat",
      x: 1_000_000,
      y: 1_000_000,
    });
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const capture = await captureCreativeWorkspacePreview(
      {
        op: "preview",
        workspace: "canvas",
        expected_snapshot_fingerprint: before.snapshot_fingerprint,
      },
      runtime,
      undefined,
      fakeCanvasDependencies().dependencies,
    );
    expect(capture.metadata).toMatchObject({
      kind: "canvas_board",
      nodeCount: 2,
      worldBounds: { width: expect.any(Number), height: expect.any(Number) },
      renderScale: expect.any(Number),
    });
    if (capture.metadata.kind !== "canvas_board") throw new Error("Expected Canvas metadata");
    expect(capture.metadata.worldBounds.width).toBeGreaterThan(999_000);
    expect(capture.metadata.renderScale).toBeLessThan(0.05);
  });

  it("fails closed for stale, concurrent, and aborted preview evidence", async () => {
    const runtime = context();
    const before = observeCreativeWorkspaceAgentSnapshot(runtime);
    const stale = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "canvas",
        expected_snapshot_fingerprint: `sha256:${"0".repeat(64)}`,
      },
      runtime,
      undefined,
      fakeCanvasDependencies().dependencies,
    );
    expect(stale).toMatchObject({ preview: { success: false, code: "stale_snapshot" } });

    useDirectorCreativeWorkspaceStore.getState().addClip({
      trackId: "video-1",
      mediaId: IMAGE_ASSET.id,
      name: "Concurrent frame",
      startSec: 0,
      durationSec: 3,
      sourceDurationSec: 60,
    });
    const videoBefore = observeCreativeWorkspaceAgentSnapshot(runtime);
    const concurrent = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "video",
        expected_snapshot_fingerprint: videoBefore.snapshot_fingerprint,
      },
      runtime,
      undefined,
      {
        renderTimelineFrame: (async () => {
          useDirectorCreativeWorkspaceStore.getState().setPlayhead(1);
          return {
            dataUrl: "data:image/png;base64,Y29uY3VycmVudA==",
            width: 1_280,
            height: 720,
            timeSec: 0,
            activeClipIds: [],
          };
        }) as typeof import("../../src/comprehensive/editor/workspaces/directorTimelineVideoExport").renderDirectorTimelineFrame,
      },
    );
    expect(concurrent).toMatchObject({ preview: { success: false, code: "stale_snapshot" } });

    const controller = new AbortController();
    controller.abort();
    const aborted = await executeCreativeWorkspaceAgentPreviewRequest(
      {
        op: "preview",
        workspace: "canvas",
        expected_snapshot_fingerprint: observeCreativeWorkspaceAgentSnapshot(runtime).snapshot_fingerprint,
      },
      runtime,
      controller.signal,
      fakeCanvasDependencies().dependencies,
    );
    expect(aborted).toMatchObject({ preview: { success: false, code: "aborted" } });
  });
});
