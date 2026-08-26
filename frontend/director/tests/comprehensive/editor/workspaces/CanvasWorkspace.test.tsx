import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistentCreativeMediaLibrary } from "../../../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import type { DirectorMediaItem } from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";
import {
  DIRECTOR_MEDIA_DRAG_TYPE,
  useDirectorCreativeWorkspaceStore,
  type DirectorBoardNode,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

const mediaLibraryMock = vi.hoisted(() => ({
  items: [] as DirectorMediaItem[],
  persist: vi.fn(),
  relink: vi.fn(),
}));

const canvasProductionMocks = vi.hoisted(() => ({
  appendToTimeline: vi.fn(),
  startPipeline: vi.fn(),
  activePipeline: vi.fn(),
}));

const pipelineRuntimeMocks = vi.hoisted(() => ({
  listNodes: vi.fn(),
  listWorkflows: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/workspaces/directorMediaLibrary", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/comprehensive/editor/workspaces/directorMediaLibrary")>();
  return {
    ...actual,
    persistDirectorMediaItem: mediaLibraryMock.persist,
    relinkDirectorCreativeMedia: mediaLibraryMock.relink,
    useDirectorMediaLibrary: () => mediaLibraryMock.items,
  };
});

vi.mock("../../../../src/comprehensive/editor/workspaces/canvasPipeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/comprehensive/editor/workspaces/canvasPipeline")>();
  return {
    ...actual,
    getActiveDirectorCanvasPipelineHandle: canvasProductionMocks.activePipeline,
    startDirectorCanvasPipeline: canvasProductionMocks.startPipeline,
  };
});

vi.mock("../../../../src/comprehensive/editor/workspaces/canvasTimelineBridge", () => ({
  appendBoardNodeToTimeline: canvasProductionMocks.appendToTimeline,
}));

vi.mock("../../../../src/comprehensive/editor/workspaces/galleryGenerationBridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/comprehensive/editor/workspaces/galleryGenerationBridge")>();
  return {
    ...actual,
    listComfyGenerationNodes: pipelineRuntimeMocks.listNodes,
    listComfyGenerationWorkflows: pipelineRuntimeMocks.listWorkflows,
  };
});

import { CanvasWorkspace } from "../../../../src/comprehensive/editor/workspaces/CanvasWorkspace";

const videoItem: DirectorMediaItem = {
  id: "recording:canvas-video",
  kind: "video",
  collection: "recordings",
  name: "可剪辑镜头",
  subtitle: "5.0s · MP4",
  thumbnailUrl: null,
  sourceUrl: "blob:canvas-video",
  durationSec: 5,
  cameraId: null,
  frameStart: 0,
  frameEnd: 120,
};

const offlineVideoItem: DirectorMediaItem = {
  ...videoItem,
  id: "creative-media:video:missing-canvas-take",
  name: "离线镜头",
  subtitle: "离线素材 · 等待重连",
  sourceUrl: null,
  availability: "offline",
};

function seedOfflineCreativeMedia() {
  persistentCreativeMediaLibrary.store.setState({
    status: "ready",
    storageMode: "memory",
    warning: null,
    error: null,
    assets: [
      {
        id: offlineVideoItem.id,
        kind: "video",
        name: offlineVideoItem.name,
        fileName: "missing-canvas-take.mp4",
        mimeType: "video/mp4",
        size: 1_024,
        createdAt: "2026-07-31T08:00:00.000Z",
        lastModified: null,
        durationSec: 5,
        width: 1_280,
        height: 720,
        source: "test",
        objectUrl: null,
      },
    ],
  });
}

function mediaNode(): DirectorBoardNode {
  return {
    id: "board-node-media",
    kind: "video",
    title: videoItem.name,
    body: videoItem.subtitle,
    mediaId: videoItem.id,
    x: 120,
    y: 100,
    width: 320,
    height: 220,
    accent: "#ff6b8a",
  };
}

beforeEach(() => {
  window.localStorage.clear();
  persistentCreativeMediaLibrary.store.setState({ assets: [] });
  mediaLibraryMock.items = [];
  mediaLibraryMock.persist.mockReset();
  mediaLibraryMock.persist.mockImplementation(async (item: DirectorMediaItem) => item.id);
  mediaLibraryMock.relink.mockReset();
  canvasProductionMocks.appendToTimeline.mockReset();
  // The bridge returns a dispatch receipt; auto-send checks receipt.ok.
  canvasProductionMocks.appendToTimeline.mockReturnValue({ ok: true });
  canvasProductionMocks.startPipeline.mockReset();
  canvasProductionMocks.activePipeline.mockReset();
  canvasProductionMocks.activePipeline.mockReturnValue(null);
  pipelineRuntimeMocks.listNodes.mockReset();
  pipelineRuntimeMocks.listWorkflows.mockReset();
  pipelineRuntimeMocks.listNodes.mockResolvedValue([]);
  pipelineRuntimeMocks.listWorkflows.mockResolvedValue([]);
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [],
      boardEdges: [],
      boardViewport: { x: 0, y: 0, zoom: 1 },
      selectedBoardNodeId: null,
      canUndo: false,
      canRedo: false,
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("exposes canvas section, script import, and generation affordances", async () => {
  const user = userEvent.setup();
  const { container } = render(<CanvasWorkspace />);

  for (const input of container.querySelectorAll('input[type="file"].sr-only')) {
    expect(input).toHaveAccessibleName();
    expect(input).toHaveAttribute("tabindex", "-1");
  }

  expect(screen.getByRole("button", { name: "添加分区" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导入剧本" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "导入剧本" }));
  expect(screen.getByRole("dialog", { name: "导入 Fountain 剧本" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "添加节点" }));
  await user.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "image", title: "生成图片" })]),
  );
});

it("exposes all seven Flick-style add-node entry types", async () => {
  const user = userEvent.setup();
  render(<CanvasWorkspace />);

  await user.click(screen.getByRole("button", { name: "添加节点" }));
  const menu = screen.getByRole("menu");
  const entries = within(menu).getAllByRole("menuitem");

  expect(entries).toHaveLength(7);
  expect(within(menu).getByRole("menuitem", { name: /^上传/ })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: /^文本备注/ })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: /^生成图片/ })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: /^生成视频/ })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: /^生成语音/ })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: /^生成音乐/ })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: /^获取灵感/ })).toBeInTheDocument();
});

it("runs the canvas pipeline from the toolbar and forwards verified media to the timeline", async () => {
  const user = userEvent.setup();
  const now = new Date().toISOString();
  const asset = {
    id: "creative-media:image:generated",
    kind: "image" as const,
    name: "output.png",
    fileName: "output.png",
    mimeType: "image/png",
    size: 15,
    createdAt: now,
    lastModified: null,
    durationSec: null,
    width: 320,
    height: 220,
    source: "canvas-generation",
    objectUrl: "blob:generated-image",
  };
  vi.spyOn(persistentCreativeMediaLibrary, "getAsset").mockImplementation((mediaId) =>
    mediaId === asset.id ? asset : null,
  );
  canvasProductionMocks.startPipeline.mockImplementation((options: { targetNodeIds: string[] }) => {
    const nodeId =
      options.targetNodeIds[0] ?? useDirectorCreativeWorkspaceStore.getState().boardNodes[0]?.id ?? "missing-node";
    const run = {
      version: 1 as const,
      id: "canvas-run-ui",
      graphFingerprint: `sha256:${"a".repeat(64)}`,
      status: "succeeded" as const,
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      error: null,
      nodeRuns: [
        {
          nodeId,
          status: "succeeded" as const,
          requestFingerprint: `sha256:${"b".repeat(64)}`,
          jobId: "job-canvas-image",
          artifactId: "artifact-image",
          mediaId: asset.id,
          startedAt: now,
          finishedAt: now,
          error: null,
        },
      ],
    };
    return {
      runId: run.id,
      cancel: vi.fn(),
      promise: Promise.resolve().then(() => {
        useDirectorCreativeWorkspaceStore.getState().updateBoardNodeProduction(nodeId, {
          mediaId: asset.id,
          productionJobId: "job-canvas-image",
          productionJobStatus: "succeeded",
          productionRunId: run.id,
          productionError: null,
        });
        return run;
      }),
    };
  });
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().updateWorkspacePrefs({ autoSendToTimeline: true });
  });

  render(<CanvasWorkspace />);
  await user.click(screen.getByRole("button", { name: "添加节点" }));
  await user.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  await user.click(screen.getByRole("button", { name: "运行 Canvas 依赖图" }));

  expect(await screen.findByText("Canvas 流水线完成 · 1 个新产物 · 0 个缓存节点")).toBeInTheDocument();
  expect(canvasProductionMocks.startPipeline).toHaveBeenCalledWith({
    targetNodeIds: [],
    forceNodeIds: [],
    onProgress: expect.any(Function),
  });
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "image",
        mediaId: "creative-media:image:generated",
        productionJobId: "job-canvas-image",
        productionJobStatus: "succeeded",
      }),
    ]),
  );
  expect(canvasProductionMocks.appendToTimeline).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "creative-media:image:generated",
      thumbnailUrl: "blob:generated-image",
      sourceUrl: "blob:generated-image",
    }),
  );
});

it("does not render a persistent pipeline status pill on the Canvas board", () => {
  act(() => {
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [mediaNode()],
      boardPipelineRuns: [
        {
          version: 1,
          id: "canvas-run-status",
          graphFingerprint: "pipeline-status-fingerprint",
          status: "succeeded",
          startedAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:01.000Z",
          finishedAt: "2026-08-12T00:00:01.000Z",
          error: null,
          nodeRuns: [],
        },
      ],
    });
  });

  const { container } = render(<CanvasWorkspace />);

  expect(container.querySelector(".creative-board-pipeline-status")).toBeNull();
});

it("does not render a persistent DAG status pill on the Canvas board", () => {
  act(() => {
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [mediaNode()],
      boardEdges: [],
    });
  });

  const { container } = render(<CanvasWorkspace />);

  expect(container.querySelector(".creative-board-dag-status")).toBeNull();
});

it("does not render a floating node inspector on the canvas board", () => {
  mediaLibraryMock.items = [videoItem];
  act(() => {
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [mediaNode()],
      boardEdges: [],
      selectedBoardNodeId: "board-node-media",
    });
  });

  render(<CanvasWorkspace />);

  expect(screen.queryByRole("complementary", { name: "节点属性" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "发送到视频编辑器" })).not.toBeInTheDocument();
  expect(screen.getByRole("toolbar", { name: "画布操作" })).toBeInTheDocument();
});

it("reconnects stale board media metadata and prefers the full-resolution source preview", () => {
  const imageItem: DirectorMediaItem = {
    id: "creative-media:image:current",
    kind: "image",
    collection: "imports",
    name: "机位02-截图06",
    subtitle: "机位02 · 21.713 mm · current",
    thumbnailUrl: "/preview-low.png",
    sourceUrl: "blob:full-resolution-preview",
    originalSourceUrl: "blob:original-high-resolution-preview",
    durationSec: 3,
    cameraId: "camera-02",
    frameStart: 0,
    frameEnd: 0,
  };
  mediaLibraryMock.items = [imageItem];
  act(() => {
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [
        {
          id: "board-node-stale-image",
          kind: "image",
          title: imageItem.name,
          body: imageItem.subtitle,
          mediaId: "creative-media:image:old",
          x: 120,
          y: 100,
          width: 320,
          height: 220,
          accent: "#9f87ff",
        },
      ],
      boardEdges: [],
      selectedBoardNodeId: null,
    });
  });

  const { container } = render(<CanvasWorkspace />);

  expect(container.querySelector(".creative-node-media img")).toHaveAttribute("src", imageItem.originalSourceUrl);
});

it("previews and durably stores a library asset at the Canvas drop point before committing it", async () => {
  mediaLibraryMock.items = [videoItem];
  // The dispatched canvas.node.add validates the persisted asset, so the mock
  // must land it in the persistent library exactly like the real import does.
  mediaLibraryMock.persist.mockImplementation(async () => {
    persistentCreativeMediaLibrary.store.setState((state) => ({
      status: "ready",
      assets: [
        ...state.assets,
        {
          id: "creative-media:video:canvas-video",
          kind: "video",
          name: videoItem.name,
          fileName: "canvas-video.mp4",
          mimeType: "video/mp4",
          size: 2_048,
          createdAt: "2026-07-31T08:00:00.000Z",
          lastModified: null,
          durationSec: videoItem.durationSec,
          width: 1_920,
          height: 1_080,
          source: "test",
          objectUrl: "blob:canvas-video-preview",
        },
      ],
    }));
    return "creative-media:video:canvas-video";
  });
  const { container } = render(<CanvasWorkspace />);
  const surface = container.querySelector<HTMLElement>(".creative-board-surface");
  expect(surface).not.toBeNull();
  const dataTransfer = {
    dropEffect: "none",
    files: [],
    getData: vi.fn((type: string) => (type === DIRECTOR_MEDIA_DRAG_TYPE ? videoItem.id : "")),
    types: [DIRECTOR_MEDIA_DRAG_TYPE],
  };
  // jsdom has no DragEvent, so fireEvent falls back to a plain Event that
  // drops MouseEvent coordinates; pin them explicitly like a real browser.
  const dragEventAt = (type: "dragOver" | "drop") => {
    const event = createEvent[type](surface!, { dataTransfer });
    Object.defineProperty(event, "clientX", { value: 260 });
    Object.defineProperty(event, "clientY", { value: 180 });
    return event;
  };

  fireEvent(surface!, dragEventAt("dragOver"));
  expect(surface).toHaveClass("is-asset-drag-over");
  expect(container.querySelector(".creative-asset-drop-preview")).toHaveClass("is-media");
  expect(container.querySelector(".creative-asset-drop-preview strong")).toHaveTextContent("可剪辑镜头");

  fireEvent(surface!, dragEventAt("drop"));
  await waitFor(() =>
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mediaId: "creative-media:video:canvas-video",
        }),
      ]),
    ),
  );
  expect(mediaLibraryMock.persist).toHaveBeenCalledWith(videoItem);
  expect(surface).not.toHaveClass("is-asset-drag-over");
  expect(container.querySelector(".creative-asset-drop-preview")).toBeNull();
});

it("resizes the media panel horizontally", () => {
  const { container } = render(<CanvasWorkspace />);
  const workspace = container.querySelector<HTMLElement>(".creative-workspace");
  expect(workspace).not.toBeNull();

  const mediaResizer = screen.getByRole("separator", {
    name: "调整素材栏宽度",
  });
  fireEvent.pointerDown(mediaResizer, { button: 0, clientX: 100 });
  fireEvent.pointerMove(window, { clientX: 180 });
  fireEvent.pointerUp(window, { clientX: 180 });
  expect(workspace?.style.getPropertyValue("--creative-media-width")).toBe("328px");

  expect(screen.queryByRole("separator", { name: "调整 Agent 栏宽度" })).not.toBeInTheDocument();
});

it("relinks offline media through the shared async media.relink contract", async () => {
  const user = userEvent.setup();
  mediaLibraryMock.items = [offlineVideoItem];
  seedOfflineCreativeMedia();
  mediaLibraryMock.relink.mockResolvedValue({
    ok: true,
    operation: "media.relink",
    oldMediaId: offlineVideoItem.id,
    newMediaId: "creative-media:video:replacement",
    referencesUpdated: 2,
    waveformReady: true,
  });
  render(<CanvasWorkspace />);
  const replacement = new File(["replacement"], "replacement.mp4", {
    type: "video/mp4",
  });

  await user.click(screen.getByRole("button", { name: "重连 离线镜头" }));
  await user.upload(screen.getByLabelText("选择重连素材"), replacement);

  expect(mediaLibraryMock.relink).toHaveBeenCalledWith(offlineVideoItem.id, replacement, "video");
  expect(await screen.findByText("素材已重连 · 2 处引用 · 波形已缓存")).toBeInTheDocument();
});

it("marks an offline Canvas node explicitly instead of presenting a missing asset as cached", () => {
  mediaLibraryMock.items = [offlineVideoItem];
  act(() => {
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [
        {
          ...mediaNode(),
          mediaId: offlineVideoItem.id,
          title: offlineVideoItem.name,
          body: offlineVideoItem.subtitle,
          productionJobStatus: "cached",
        },
      ],
      boardEdges: [],
    });
  });

  const { container } = render(<CanvasWorkspace />);
  const node = container.querySelector<HTMLElement>(".creative-board-node");

  expect(node).toHaveClass("is-offline");
  expect(node).toHaveAttribute("title", "素材离线，请重连");
  expect(within(node!).getByText("素材离线")).toBeInTheDocument();
  expect(within(node!).getByText("离线", { exact: true })).toHaveClass("creative-node-job-status", "is-offline");
  expect(node?.querySelector("img, video, audio")).toBeNull();
});

it("does not label an uncaptured 3D shot as missing media", () => {
  mediaLibraryMock.items = [
    {
      id: "shot:uncaptured",
      kind: "shot",
      collection: "shots",
      name: "Uncaptured shot",
      subtitle: "Scene 1 · F0–F95",
      thumbnailUrl: null,
      sourceUrl: null,
      durationSec: 4,
      cameraId: "camera-1",
      frameStart: 0,
      frameEnd: 95,
      availability: "offline",
    },
  ];
  act(() => {
    useDirectorCreativeWorkspaceStore.setState({
      boardNodes: [
        {
          id: "board-node-shot",
          kind: "shot",
          title: "Uncaptured shot",
          body: "Scene 1 · F0–F95",
          mediaId: "shot:uncaptured",
          x: 20,
          y: 20,
          width: 320,
          height: 220,
          accent: "#29d6ff",
          productionJobStatus: "passthrough",
        },
      ],
      boardEdges: [],
    });
  });

  const { container } = render(<CanvasWorkspace />);
  const node = container.querySelector<HTMLElement>(".creative-board-node");

  expect(node).not.toHaveClass("is-offline");
  expect(node).not.toHaveAttribute("title", "素材离线，请重连");
  expect(within(node!).queryByText("素材离线")).not.toBeInTheDocument();
  expect(within(node!).getByText("passthrough")).toBeInTheDocument();
});

it("shows relink validation failures without adding another Canvas node", async () => {
  const user = userEvent.setup();
  mediaLibraryMock.items = [offlineVideoItem];
  seedOfflineCreativeMedia();
  mediaLibraryMock.relink.mockRejectedValue(new Error("重连类型不匹配：需要 video，收到 audio"));
  render(<CanvasWorkspace />);
  const wrongFile = new File(["audio"], "wrong.wav", { type: "audio/wav" });

  await user.click(screen.getByRole("button", { name: "重连 离线镜头" }));
  await user.upload(screen.getByLabelText("选择重连素材"), wrongFile);

  expect(await screen.findByText("重连类型不匹配：需要 video，收到 audio")).toBeInTheDocument();
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes).toEqual([]);
});

it("opens the ComfyUI node-pool dialog from the Canvas toolbar", async () => {
  const user = userEvent.setup();
  render(<CanvasWorkspace />);

  await user.click(screen.getByRole("button", { name: "生成节点" }));

  const dialog = await screen.findByRole("dialog", { name: "ComfyUI 节点池" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(pipelineRuntimeMocks.listNodes).toHaveBeenCalled();
  expect(await screen.findByText("尚未配置 ComfyUI 节点。可在此添加，或设置 COMFYUI_URL。")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog", { name: "ComfyUI 节点池" })).not.toBeInTheDocument();
});

it("offers a node-pool entry beside the status message when the pipeline lacks ComfyUI nodes", async () => {
  const user = userEvent.setup();
  const now = new Date().toISOString();
  canvasProductionMocks.startPipeline.mockImplementation(() => {
    const nodeId = useDirectorCreativeWorkspaceStore.getState().boardNodes[0]?.id ?? "missing-node";
    return {
      runId: "canvas-run-no-nodes",
      cancel: vi.fn(),
      promise: Promise.resolve({
        version: 1 as const,
        id: "canvas-run-no-nodes",
        graphFingerprint: `sha256:${"c".repeat(64)}`,
        status: "failed" as const,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        error: "没有在线的 ComfyUI 执行节点",
        nodeRuns: [
          {
            nodeId,
            status: "failed" as const,
            requestFingerprint: `sha256:${"d".repeat(64)}`,
            jobId: null,
            artifactId: null,
            mediaId: null,
            startedAt: now,
            finishedAt: now,
            error: "没有在线的 ComfyUI 执行节点",
          },
        ],
      }),
    };
  });

  render(<CanvasWorkspace />);
  await user.click(screen.getByRole("button", { name: "添加节点" }));
  await user.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  await user.click(screen.getByRole("button", { name: "运行 Canvas 依赖图" }));

  expect(await screen.findByText("Canvas 流水线部分完成 · 0 成功 · 1 失败或阻断")).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "配置生成节点" }));
  expect(await screen.findByRole("dialog", { name: "ComfyUI 节点池" })).toBeInTheDocument();
});

it("does not offer the node-pool entry for unrelated pipeline failures", async () => {
  const user = userEvent.setup();
  const now = new Date().toISOString();
  canvasProductionMocks.startPipeline.mockImplementation(() => {
    const nodeId = useDirectorCreativeWorkspaceStore.getState().boardNodes[0]?.id ?? "missing-node";
    return {
      runId: "canvas-run-other-failure",
      cancel: vi.fn(),
      promise: Promise.resolve({
        version: 1 as const,
        id: "canvas-run-other-failure",
        graphFingerprint: `sha256:${"e".repeat(64)}`,
        status: "failed" as const,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        error: "生成任务 failed",
        nodeRuns: [
          {
            nodeId,
            status: "failed" as const,
            requestFingerprint: `sha256:${"f".repeat(64)}`,
            jobId: null,
            artifactId: null,
            mediaId: null,
            startedAt: now,
            finishedAt: now,
            error: "生成任务 failed",
          },
        ],
      }),
    };
  });

  render(<CanvasWorkspace />);
  await user.click(screen.getByRole("button", { name: "添加节点" }));
  await user.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  await user.click(screen.getByRole("button", { name: "运行 Canvas 依赖图" }));

  expect(await screen.findByText("Canvas 流水线部分完成 · 0 成功 · 1 失败或阻断")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "配置生成节点" })).not.toBeInTheDocument();
});

it("auto-dismisses successful status messages after six seconds", async () => {
  vi.useFakeTimers();
  const now = new Date().toISOString();
  canvasProductionMocks.startPipeline.mockImplementation(() => {
    const nodeId = useDirectorCreativeWorkspaceStore.getState().boardNodes[0]?.id ?? "missing-node";
    return {
      runId: "canvas-run-success-ttl",
      cancel: vi.fn(),
      promise: Promise.resolve({
        version: 1 as const,
        id: "canvas-run-success-ttl",
        graphFingerprint: `sha256:${"a".repeat(64)}`,
        status: "succeeded" as const,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        error: null,
        nodeRuns: [
          {
            nodeId,
            status: "succeeded" as const,
            requestFingerprint: `sha256:${"b".repeat(64)}`,
            jobId: "job-success-ttl",
            artifactId: null,
            mediaId: null,
            startedAt: now,
            finishedAt: now,
            error: null,
          },
        ],
      }),
    };
  });

  render(<CanvasWorkspace />);
  fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  fireEvent.click(screen.getByRole("button", { name: "运行 Canvas 依赖图" }));
  await act(async () => Promise.resolve());

  expect(screen.getByRole("status")).toHaveClass("is-success");
  expect(screen.getByText("Canvas 流水线完成 · 1 个新产物 · 0 个缓存节点")).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(6_000);
  });
  expect(screen.queryByText("Canvas 流水线完成 · 1 个新产物 · 0 个缓存节点")).not.toBeInTheDocument();
});

it("keeps error messages until the user dismisses them", async () => {
  vi.useFakeTimers();
  const now = new Date().toISOString();
  canvasProductionMocks.startPipeline.mockImplementation(() => {
    const nodeId = useDirectorCreativeWorkspaceStore.getState().boardNodes[0]?.id ?? "missing-node";
    return {
      runId: "canvas-run-error-persistent",
      cancel: vi.fn(),
      promise: Promise.resolve({
        version: 1 as const,
        id: "canvas-run-error-persistent",
        graphFingerprint: `sha256:${"c".repeat(64)}`,
        status: "failed" as const,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        error: "渲染节点失败",
        nodeRuns: [
          {
            nodeId,
            status: "failed" as const,
            requestFingerprint: `sha256:${"d".repeat(64)}`,
            jobId: null,
            artifactId: null,
            mediaId: null,
            startedAt: now,
            finishedAt: now,
            error: "渲染节点失败",
          },
        ],
      }),
    };
  });

  render(<CanvasWorkspace />);
  fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  fireEvent.click(screen.getByRole("button", { name: "运行 Canvas 依赖图" }));
  await act(async () => Promise.resolve());

  expect(screen.getByRole("alert")).toHaveClass("is-error");
  act(() => {
    vi.advanceTimersByTime(12_000);
  });
  expect(screen.getByText("Canvas 流水线部分完成 · 0 成功 · 1 失败或阻断")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭状态消息" }));
  expect(screen.queryByText("Canvas 流水线部分完成 · 0 成功 · 1 失败或阻断")).not.toBeInTheDocument();
});

it("renders node and dependency-level progress reported by the pipeline", () => {
  const now = new Date().toISOString();
  canvasProductionMocks.startPipeline.mockImplementation(
    (options: {
      onProgress?: (
        run: ReturnType<typeof useDirectorCreativeWorkspaceStore.getState>["boardPipelineRuns"][number],
      ) => void;
    }) => {
      const nodeId = useDirectorCreativeWorkspaceStore.getState().boardNodes[0]?.id ?? "missing-node";
      options.onProgress?.({
        version: 1,
        id: "canvas-run-progress",
        graphFingerprint: `sha256:${"e".repeat(64)}`,
        status: "running",
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
        nodeRuns: [
          {
            nodeId,
            status: "running",
            requestFingerprint: `sha256:${"f".repeat(64)}`,
            jobId: "job-progress",
            artifactId: null,
            mediaId: null,
            startedAt: now,
            finishedAt: null,
            error: null,
          },
        ],
      });
      return {
        runId: "canvas-run-progress",
        cancel: vi.fn(),
        promise: new Promise(() => undefined),
      };
    },
  );

  render(<CanvasWorkspace />);
  fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^生成图片/ }));
  fireEvent.click(screen.getByRole("button", { name: "运行 Canvas 依赖图" }));

  const progress = screen.getByRole("progressbar", { name: "Canvas 流水线进度" });
  expect(progress).toHaveAttribute("aria-valuenow", "0");
  expect(progress).toHaveAttribute("aria-valuemax", "1");
  expect(screen.getByText("0/1 个节点完成 · 第 1/1 层")).toBeInTheDocument();
});
