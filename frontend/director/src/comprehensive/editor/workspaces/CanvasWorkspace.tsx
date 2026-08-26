import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import {
  BringToFront,
  Cable,
  Clapperboard,
  FileText,
  Flag,
  Hand,
  Image,
  Images,
  LayoutGrid,
  Lightbulb,
  LoaderCircle,
  Mic2,
  Music2,
  MousePointer2,
  PanelsTopLeft,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Server,
  Sparkles,
  Square,
  StickyNote,
  TriangleAlert,
  Type,
  Undo2,
  Upload,
  UserRound,
  Video,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import {
  dispatchCreativeWorkspaceMediaRelink,
  dispatchCreativeWorkspaceOperations,
  type CreativeWorkspaceOperationInput,
} from "../../../agent/dispatchCreativeWorkspaceOperations";
import { useLanguage } from "../../i18n/language";
import { buildScriptToCanvasPlan } from "../assistant/scriptToProductionPipeline";
import { ComfyNodesDialog, isComfyNodeAvailabilityError } from "../comfy/ComfyNodesDialog";
import { probeCreativeMediaFile } from "../media/creativeMediaProbe";
import { persistentCreativeMediaLibrary, type CreativeMediaAsset } from "../media/persistentCreativeMediaStore";
import { CreativeMediaBrowser } from "./CreativeMediaBrowser";
import { CreativeWorkspacePanelResizer, useCreativeWorkspacePanelLayout } from "./CreativeWorkspacePanelResizer";
import { installWindowPointerDrag } from "./windowPointerDrag";
import { analyzeDirectorCanvasDag } from "./canvasDag";
import {
  getActiveDirectorCanvasPipelineHandle,
  startDirectorCanvasPipeline,
  type DirectorCanvasPipelineHandle,
} from "./canvasPipeline";
import { resolveSectionForNode, type DirectorBoardSection } from "./canvasSections";
import { appendBoardNodeToTimeline } from "./canvasTimelineBridge";
import { persistDirectorMediaItem, useDirectorMediaLibrary, type DirectorMediaItem } from "./directorMediaLibrary";
import {
  DIRECTOR_MEDIA_DRAG_TYPE,
  getDirectorMediaDragSessionId,
  useDirectorCreativeWorkspaceStore,
  type DirectorBoardNode,
} from "./directorWorkspaceStore";

type CanvasTool = "select" | "hand" | "connect";
type CanvasAssetDropPreview = {
  x: number;
  y: number;
  title: string;
  detail: string;
  kind: DirectorBoardNode["kind"];
  source: "media" | "files";
  thumbnailUrl: string | null;
};

type CanvasStatusSeverity = "info" | "success" | "error";
type CanvasStatusMessage = {
  text: string;
  severity: CanvasStatusSeverity;
  autoDismiss: boolean;
};
type CanvasPipelineProgress = {
  completed: number;
  total: number;
  currentLevel: number;
  totalLevels: number;
};

const CANVAS_STATUS_DISMISS_MS = 6_000;
const COMPLETED_PIPELINE_NODE_STATUSES = new Set([
  "passthrough",
  "cached",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "stale",
]);

function getMediaNodeKind(item: DirectorMediaItem): DirectorBoardNode["kind"] {
  return item.kind === "audio" ? "audio" : item.kind === "video" ? "video" : item.kind === "shot" ? "shot" : "image";
}

/** Desaturated professional palette (mirrors the video editor's getClipColor). */
function getNodeAccent(item: DirectorMediaItem) {
  return item.kind === "audio"
    ? "#4fae9d"
    : item.kind === "video"
      ? "#d96d83"
      : item.kind === "shot"
        ? "#45b3d6"
        : "#8f83d9";
}

function resolveBoardMediaItem(
  node: DirectorBoardNode,
  itemById: Map<string, DirectorMediaItem>,
  items: DirectorMediaItem[],
) {
  const byId = node.mediaId ? itemById.get(node.mediaId) : undefined;
  if (byId) return byId;
  const exactMatch = items.find((item) => item.name === node.title && item.subtitle === node.body);
  if (exactMatch) return exactMatch;
  const sameTitle = items.filter((item) => item.name === node.title);
  return sameTitle.length === 1 ? sameTitle[0] : undefined;
}

function SectionKindIcon({ kind }: { kind: DirectorBoardSection["kind"] }) {
  const size = 14;
  switch (kind) {
    case "character":
      return <UserRound aria-hidden size={size} />;
    case "scene":
      return <Clapperboard aria-hidden size={size} />;
    case "generation":
      return <Sparkles aria-hidden size={size} />;
    case "final":
      return <Flag aria-hidden size={size} />;
    default:
      return <LayoutGrid aria-hidden size={size} />;
  }
}

function BoardNodeMedia({ node, item }: { node: DirectorBoardNode; item: DirectorMediaItem | undefined }) {
  const { t } = useLanguage();
  if (item?.availability === "offline" && item.kind !== "shot")
    return (
      <span className="creative-node-media-offline">
        <TriangleAlert aria-hidden size={22} />
        <span>{t("素材离线")}</span>
      </span>
    );
  const source =
    item?.kind === "image"
      ? (item.originalSourceUrl ?? item.sourceUrl ?? item.thumbnailUrl)
      : (item?.sourceUrl ?? item?.thumbnailUrl);
  if ((item?.kind === "image" || item?.kind === "shot") && source)
    return <img alt="" decoding="async" draggable={false} src={source} />;
  if (item?.kind === "video" && item.sourceUrl)
    return (
      <video
        aria-label={item.name}
        muted
        playsInline
        preload="metadata"
        poster={item.thumbnailUrl ?? undefined}
        src={item.sourceUrl}
      />
    );
  if (item?.thumbnailUrl) return <img alt="" decoding="async" draggable={false} src={item.thumbnailUrl} />;
  if (item?.kind === "audio" && item.sourceUrl)
    return <audio aria-label={item.name} controls preload="metadata" src={item.sourceUrl} />;
  if (node.kind === "note") return <StickyNote aria-hidden size={26} />;
  if (node.kind === "audio") return <Music2 aria-hidden size={26} />;
  if (node.kind === "video") return <Video aria-hidden size={26} />;
  return <Image aria-hidden size={26} />;
}

function persistentAssetToDirectorMediaItem(asset: CreativeMediaAsset): DirectorMediaItem {
  return {
    id: asset.id,
    kind: asset.kind,
    collection: "imports",
    name: asset.name,
    subtitle:
      asset.kind === "image"
        ? `${asset.width ?? "?"} × ${asset.height ?? "?"}`
        : `${(asset.durationSec ?? 0).toFixed(2)}s · ${asset.mimeType}`,
    thumbnailUrl: asset.kind === "audio" ? null : asset.objectUrl,
    sourceUrl: asset.objectUrl,
    durationSec: asset.durationSec ?? (asset.kind === "image" ? 3 : 0),
    cameraId: null,
    frameStart: null,
    frameEnd: null,
  };
}

export function CanvasWorkspace() {
  const { t } = useLanguage();
  const panelLayout = useCreativeWorkspacePanelLayout();
  const items = useDirectorMediaLibrary();
  const boardNodes = useDirectorCreativeWorkspaceStore((state) => state.boardNodes);
  const boardEdges = useDirectorCreativeWorkspaceStore((state) => state.boardEdges);
  const boardSections = useDirectorCreativeWorkspaceStore((state) => state.boardSections);
  const boardPipelineRuns = useDirectorCreativeWorkspaceStore((state) => state.boardPipelineRuns);
  const workspacePrefs = useDirectorCreativeWorkspaceStore((state) => state.workspacePrefs);
  const viewport = useDirectorCreativeWorkspaceStore((state) => state.boardViewport);
  const selectedNodeId = useDirectorCreativeWorkspaceStore((state) => state.selectedBoardNodeId);
  // Node/edge/layout authoring, import cataloging, undo/redo, and media
  // relink dispatch through the shared agent contract
  // (dispatchCreativeWorkspaceOperations / dispatchCreativeWorkspaceMediaRelink);
  // only drag-batch intermediate samples, z-order raises, view state, and
  // section bookkeeping (no semantic ops yet) keep direct store mutators.
  const updateBoardNode = useDirectorCreativeWorkspaceStore((state) => state.updateBoardNode);
  const bringBoardNodeToFront = useDirectorCreativeWorkspaceStore((state) => state.bringBoardNodeToFront);
  const selectBoardNode = useDirectorCreativeWorkspaceStore((state) => state.selectBoardNode);
  const setBoardViewport = useDirectorCreativeWorkspaceStore((state) => state.setBoardViewport);
  const addBoardSection = useDirectorCreativeWorkspaceStore((state) => state.addBoardSection);
  const applyScriptCanvasPlan = useDirectorCreativeWorkspaceStore((state) => state.applyScriptCanvasPlan);
  const assignBoardNodeSection = useDirectorCreativeWorkspaceStore((state) => state.assignBoardNodeSection);
  const beginHistoryBatch = useDirectorCreativeWorkspaceStore((state) => state.beginHistoryBatch);
  const endHistoryBatch = useDirectorCreativeWorkspaceStore((state) => state.endHistoryBatch);
  const canUndo = useDirectorCreativeWorkspaceStore((state) => state.canUndo);
  const canRedo = useDirectorCreativeWorkspaceStore((state) => state.canRedo);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [connectSourceId, setConnectSourceId] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [importMessage, setImportMessage] = useState<CanvasStatusMessage | null>(null);
  const [pipelineProgress, setPipelineProgress] = useState<CanvasPipelineProgress | null>(null);
  const [scriptModalOpen, setScriptModalOpen] = useState(false);
  const [scriptDraft, setScriptDraft] = useState("");
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [comfyNodesDialogOpen, setComfyNodesDialogOpen] = useState(false);
  const [comfyNodesHintVisible, setComfyNodesHintVisible] = useState(false);
  const [assetDropPreview, setAssetDropPreview] = useState<CanvasAssetDropPreview | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const scriptFileInputRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRelinkTargetRef = useRef<DirectorMediaItem | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const pipelineHandleRef = useRef<DirectorCanvasPipelineHandle | null>(null);
  const pipelineMountedRef = useRef(true);
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const nodeById = useMemo(() => new Map(boardNodes.map((node) => [node.id, node])), [boardNodes]);
  const dagAnalysis = useMemo(() => analyzeDirectorCanvasDag(boardNodes, boardEdges), [boardEdges, boardNodes]);
  const latestPipelineRun = boardPipelineRuns.at(-1) ?? null;
  const showImportMessage = (text: string, severity: CanvasStatusSeverity, options: { autoDismiss?: boolean } = {}) => {
    setComfyNodesHintVisible(false);
    setImportMessage({
      text,
      severity,
      autoDismiss: options.autoDismiss ?? severity !== "error",
    });
  };
  /**
   * Shared UI entry into the creative workspace agent contract. Applies one
   * atomic mutation (or batch) and surfaces contract rejections in the Canvas
   * status bar instead of silently no-oping.
   */
  const dispatchCanvas = useCallback(
    (operations: CreativeWorkspaceOperationInput | CreativeWorkspaceOperationInput[], failureTitle: string) => {
      const receipt = dispatchCreativeWorkspaceOperations(operations);
      if (!receipt.ok) {
        setComfyNodesHintVisible(false);
        setImportMessage({ text: `${failureTitle}：${receipt.error}`, severity: "error", autoDismiss: false });
      }
      return receipt;
    },
    [],
  );
  const updatePipelineProgress = (run: (typeof boardPipelineRuns)[number]) => {
    if (!pipelineMountedRef.current) return;
    const completed = run.nodeRuns.filter((nodeRun) => COMPLETED_PIPELINE_NODE_STATUSES.has(nodeRun.status)).length;
    const activeNodeIds = new Set(
      run.nodeRuns.filter((nodeRun) => nodeRun.status === "running").map((nodeRun) => nodeRun.nodeId),
    );
    const pendingNodeIds = new Set(
      run.nodeRuns.filter((nodeRun) => nodeRun.status === "pending").map((nodeRun) => nodeRun.nodeId),
    );
    let levelIndex = dagAnalysis.parallelLevels.findIndex((level) => level.some((nodeId) => activeNodeIds.has(nodeId)));
    if (levelIndex < 0) {
      levelIndex = dagAnalysis.parallelLevels.findIndex((level) => level.some((nodeId) => pendingNodeIds.has(nodeId)));
    }
    setPipelineProgress({
      completed,
      total: run.nodeRuns.length,
      currentLevel: Math.min(Math.max(levelIndex + 1, 1), Math.max(dagAnalysis.parallelLevels.length, 1)),
      totalLevels: Math.max(dagAnalysis.parallelLevels.length, 1),
    });
  };
  const cleanupActiveDrag = useCallback(() => {
    const cleanup = dragCleanupRef.current;
    dragCleanupRef.current = null;
    cleanup?.();
  }, []);

  useEffect(() => {
    pipelineMountedRef.current = true;
    const activeHandle = getActiveDirectorCanvasPipelineHandle();
    if (activeHandle) {
      pipelineHandleRef.current = activeHandle;
      setPipelineRunning(true);
      void activeHandle.promise
        .finally(() => {
          if (!pipelineMountedRef.current || pipelineHandleRef.current !== activeHandle) return;
          pipelineHandleRef.current = null;
          setPipelineRunning(false);
        })
        .catch(() => undefined);
    }
    return () => {
      pipelineMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!importMessage?.autoDismiss) return;
    const message = importMessage;
    const timer = window.setTimeout(() => {
      setImportMessage((current) => (current === message ? null : current));
    }, CANVAS_STATUS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [importMessage]);

  useEffect(() => {
    const clearAssetPreview = () => setAssetDropPreview(null);
    window.addEventListener("dragend", clearAssetPreview);
    window.addEventListener("drop", clearAssetPreview);
    return () => {
      window.removeEventListener("dragend", clearAssetPreview);
      window.removeEventListener("drop", clearAssetPreview);
      cleanupActiveDrag();
    };
  }, [cleanupActiveDrag]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.key === "Backspace" || event.key === "Delete") && selectedNodeId) {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        dispatchCanvas({ op: "canvas.node.remove", node_id: selectedNodeId }, t("节点删除失败"));
      }
      if (event.key === "Escape") setConnectSourceId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatchCanvas, selectedNodeId, t]);

  function canvasPoint(clientX: number, clientY: number) {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    return {
      x: (clientX - (bounds?.left ?? 0) - viewport.x) / viewport.zoom,
      y: (clientY - (bounds?.top ?? 0) - viewport.y) / viewport.zoom,
    };
  }

  async function addMediaNode(item: DirectorMediaItem, x?: number, y?: number) {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const fallback = canvasPoint(
      (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
      (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
    );
    let mediaId: string;
    try {
      mediaId = await persistDirectorMediaItem(item);
    } catch (error) {
      showImportMessage(error instanceof Error ? error.message : t("素材导入失败"), "error");
      return;
    }
    dispatchCanvas(
      {
        op: "canvas.node.add",
        kind: getMediaNodeKind(item),
        title: item.name,
        body: item.subtitle,
        media_id: mediaId,
        x: (x ?? fallback.x) - 160,
        y: (y ?? fallback.y) - 110,
        accent: getNodeAccent(item),
      },
      t("节点创建失败"),
    );
  }

  function addNote() {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const point = canvasPoint(
      (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
      (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
    );
    dispatchCanvas(
      {
        op: "canvas.node.add",
        kind: "note",
        title: "新想法",
        body: "双击右侧属性开始编辑。",
        x: point.x - 140,
        y: point.y - 78,
      },
      t("节点创建失败"),
    );
  }

  function addFrame() {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const point = canvasPoint(
      (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
      (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
    );
    dispatchCanvas(
      {
        op: "canvas.node.add",
        kind: "frame",
        title: "镜头组",
        body: "用分组整理同一场景、角色或生成阶段的素材。",
        x: point.x - 340,
        y: point.y - 210,
      },
      t("节点创建失败"),
    );
  }

  function addIdeaNode(
    kind: Extract<DirectorBoardNode["kind"], "image" | "video" | "audio" | "note">,
    title: string,
    body: string,
    accent: string,
  ) {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const point = canvasPoint(
      (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
      (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
    );
    dispatchCanvas(
      {
        op: "canvas.node.add",
        kind,
        title,
        body,
        x: point.x - 160,
        y: point.y - 110,
        accent,
      },
      t("节点创建失败"),
    );
    setAddMenuOpen(false);
  }

  async function runCanvasPipeline(targetNodeIds: readonly string[] = [], forceNodeIds: readonly string[] = []) {
    if (pipelineRunning) return;
    if (!dagAnalysis.valid || !boardNodes.length) {
      showImportMessage(t("依赖图包含循环、无效连接或没有节点，无法执行"), "error");
      return;
    }
    const existing = getActiveDirectorCanvasPipelineHandle();
    if (existing) {
      pipelineHandleRef.current = existing;
      setPipelineRunning(true);
      showImportMessage(t("已有 Canvas 流水线正在执行"), "info", { autoDismiss: false });
      return;
    }
    const handle = startDirectorCanvasPipeline({
      targetNodeIds,
      forceNodeIds,
      onProgress: updatePipelineProgress,
    });
    pipelineHandleRef.current = handle;
    setPipelineRunning(true);
    setPipelineProgress({
      completed: 0,
      total: boardNodes.length,
      currentLevel: 1,
      totalLevels: Math.max(dagAnalysis.parallelLevels.length, 1),
    });
    setComfyNodesHintVisible(false);
    showImportMessage(
      targetNodeIds.length
        ? `${t("当前节点分支已启动")} · ${targetNodeIds.length} ${t("个目标节点")}`
        : `${t("Canvas 流水线已启动")} · ${dagAnalysis.parallelLevels.length} ${t("层")}`,
      "info",
      { autoDismiss: false },
    );
    try {
      const run = await handle.promise;
      if (workspacePrefs.autoSendToTimeline) {
        for (const mediaId of [
          ...new Set(
            run.nodeRuns
              .filter((nodeRun) => nodeRun.status === "succeeded")
              .map((nodeRun) => nodeRun.mediaId)
              .filter((mediaId): mediaId is string => Boolean(mediaId)),
          ),
        ]) {
          const asset = persistentCreativeMediaLibrary.getAsset(mediaId);
          if (!asset) continue;
          const sent = appendBoardNodeToTimeline(persistentAssetToDirectorMediaItem(asset));
          if (!sent.ok) showImportMessage(`${t("自动加入时间线失败")}：${sent.error}`, "error");
        }
      }
      const succeeded = run.nodeRuns.filter((nodeRun) => nodeRun.status === "succeeded").length;
      const cached = run.nodeRuns.filter((nodeRun) => nodeRun.status === "cached").length;
      const failed = run.nodeRuns.filter((nodeRun) =>
        ["failed", "blocked", "cancelled", "stale"].includes(nodeRun.status),
      ).length;
      if (pipelineMountedRef.current) {
        showImportMessage(
          run.status === "succeeded"
            ? `${t("Canvas 流水线完成")} · ${succeeded} ${t("个新产物")} · ${cached} ${t("个缓存节点")}`
            : run.status === "cancelled"
              ? t("Canvas 流水线已取消；已完成产物仍保留")
              : `${t("Canvas 流水线部分完成")} · ${succeeded} ${t("成功")} · ${failed} ${t("失败或阻断")}`,
          run.status === "succeeded" ? "success" : run.status === "cancelled" ? "info" : "error",
        );
        if (
          run.status !== "succeeded" &&
          (isComfyNodeAvailabilityError(run.error) ||
            run.nodeRuns.some((nodeRun) => isComfyNodeAvailabilityError(nodeRun.error)))
        ) {
          setComfyNodesHintVisible(true);
        }
      }
    } catch (error) {
      if (pipelineMountedRef.current) {
        const message = error instanceof Error ? error.message : t("Canvas 流水线执行失败");
        showImportMessage(message, "error");
        if (isComfyNodeAvailabilityError(message)) setComfyNodesHintVisible(true);
      }
    } finally {
      if (pipelineHandleRef.current === handle) pipelineHandleRef.current = null;
      if (pipelineMountedRef.current) {
        setPipelineRunning(false);
        setPipelineProgress(null);
      }
    }
  }

  function cancelCanvasPipeline() {
    const handle = pipelineHandleRef.current ?? getActiveDirectorCanvasPipelineHandle();
    if (!handle) return;
    handle.cancel();
    showImportMessage(t("正在取消 Canvas 流水线和活动生成任务…"), "info", { autoDismiss: false });
  }

  function importScriptText(fountainText: string) {
    const trimmed = fountainText.trim();
    if (!trimmed) {
      showImportMessage(t("请先粘贴 Fountain 剧本文本"), "error");
      return;
    }
    const plan = buildScriptToCanvasPlan(trimmed);
    applyScriptCanvasPlan(plan);
    setScriptModalOpen(false);
    setScriptDraft("");
    showImportMessage(
      plan.warnings.length
        ? `${t("已导入剧本")} · ${plan.storyboardShotCount} ${t("个分镜")} · ${plan.warnings[0]}`
        : `${t("已导入剧本")} · ${plan.storyboardShotCount} ${t("个分镜")}`,
      plan.warnings.length ? "info" : "success",
    );
  }

  async function importScriptFile(file: File) {
    const text = await file.text();
    setScriptDraft(text);
    importScriptText(text);
  }

  function addSection() {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const point = canvasPoint(
      (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
      (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
    );
    addBoardSection({ x: point.x - 360, y: point.y - 210, title: t("新分区") });
  }

  async function importMediaFiles(files: File[], dropPoint?: { x: number; y: number }) {
    showImportMessage(t("正在导入素材…"), "info", { autoDismiss: false });
    setAddMenuOpen(false);
    let imported = 0;
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      try {
        const probe = await probeCreativeMediaFile(file);
        const asset = await persistentCreativeMediaLibrary.importFile(file, probe);
        // Cataloging is dispatched separately from the node add so a Canvas
        // capacity rejection still leaves the imported media in the Gallery.
        const cataloged = dispatchCreativeWorkspaceOperations({
          op: "gallery.media.update",
          media_id: asset.id,
          patch: { added_at: new Date().toISOString() },
        });
        if (!cataloged.ok) {
          failures.push(`${file.name}: ${cataloged.error}`);
          continue;
        }
        const bounds = surfaceRef.current?.getBoundingClientRect();
        const point =
          dropPoint ??
          canvasPoint(
            (bounds?.left ?? 0) + (bounds?.width ?? 800) / 2,
            (bounds?.top ?? 0) + (bounds?.height ?? 600) / 2,
          );
        const receipt = dispatchCreativeWorkspaceOperations({
          op: "canvas.node.add",
          kind: asset.kind,
          title: asset.name,
          body:
            asset.kind === "image"
              ? `${asset.width ?? "?"} × ${asset.height ?? "?"}`
              : `${(asset.durationSec ?? 0).toFixed(2)}s · ${asset.mimeType}`,
          media_id: asset.id,
          x: point.x - 160 + index * 26,
          y: point.y - 110 + index * 26,
          accent: asset.kind === "audio" ? "#4fae9d" : asset.kind === "video" ? "#d96d83" : "#8f83d9",
        });
        if (!receipt.ok) {
          failures.push(`${file.name}: ${receipt.error}`);
          continue;
        }
        imported += 1;
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : t("素材导入失败")}`);
      }
    }
    showImportMessage(
      failures.length
        ? `${t("已导入")} ${imported}/${files.length} · ${failures.slice(0, 2).join("；")}`
        : `${t("已导入")} ${imported} ${t("项素材")}`,
      failures.length ? "error" : "success",
    );
  }

  async function relinkPendingMedia(file: File) {
    const target = pendingRelinkTargetRef.current;
    pendingRelinkTargetRef.current = null;
    if (!target) return;
    showImportMessage(t("正在重连素材…"), "info", { autoDismiss: false });
    const receipt = await dispatchCreativeWorkspaceMediaRelink(target.id, file);
    if (!receipt.ok) {
      const detail = receipt.error.replace(/^Media relink failed:\s*/i, "").trim();
      showImportMessage(detail || t("素材重连失败"), "error");
      return;
    }
    const referencesUpdated = Number(receipt.execution.result.references_updated ?? 0);
    const waveformReady = Boolean(receipt.execution.result.waveform_ready);
    showImportMessage(
      `${t("素材已重连")} · ${referencesUpdated} ${t("处引用")} · ${waveformReady ? t("波形已缓存") : t("波形待生成")}`,
      "success",
    );
  }

  function beginPan(event: ReactPointerEvent) {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 0 && tool !== "hand" && event.currentTarget !== event.target) return;
    event.preventDefault();
    selectBoardNode(null);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = viewport;
    function move(pointerEvent: PointerEvent) {
      setBoardViewport({
        ...origin,
        x: origin.x + pointerEvent.clientX - startX,
        y: origin.y + pointerEvent.clientY - startY,
      });
    }
    cleanupActiveDrag();
    installWindowPointerDrag(dragCleanupRef, move);
  }

  function beginNodeDrag(event: ReactPointerEvent, node: DirectorBoardNode) {
    event.stopPropagation();
    if (tool === "connect") {
      if (!connectSourceId) setConnectSourceId(node.id);
      else {
        const receipt = dispatchCreativeWorkspaceOperations({
          op: "canvas.edge.add",
          source_node_id: connectSourceId,
          target_node_id: node.id,
        });
        showImportMessage(
          receipt.ok ? t("依赖连接已创建") : `${t("无法连接")}：${receipt.error}`,
          receipt.ok ? "success" : "error",
        );
        setConnectSourceId(null);
      }
      return;
    }
    if (tool === "hand") return;
    event.preventDefault();
    selectBoardNode(node.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = node.x;
    const originY = node.y;
    cleanupActiveDrag();
    beginHistoryBatch();
    function move(pointerEvent: PointerEvent) {
      updateBoardNode(node.id, {
        x: originX + (pointerEvent.clientX - startX) / viewport.zoom,
        y: originY + (pointerEvent.clientY - startY) / viewport.zoom,
      });
    }
    installWindowPointerDrag(dragCleanupRef, move, () => {
      endHistoryBatch();
      const current = useDirectorCreativeWorkspaceStore.getState().boardNodes.find((item) => item.id === node.id);
      if (current) {
        assignBoardNodeSection(
          node.id,
          resolveSectionForNode(current, useDirectorCreativeWorkspaceStore.getState().boardSections),
        );
      }
    });
  }

  function beginResize(event: ReactPointerEvent, node: DirectorBoardNode) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const width = node.width;
    const height = node.height;
    cleanupActiveDrag();
    beginHistoryBatch();
    function move(pointerEvent: PointerEvent) {
      updateBoardNode(node.id, {
        width: width + (pointerEvent.clientX - startX) / viewport.zoom,
        height: height + (pointerEvent.clientY - startY) / viewport.zoom,
      });
    }
    installWindowPointerDrag(dragCleanupRef, move, endHistoryBatch);
  }

  function zoomAt(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const nextZoom = Math.min(2.5, Math.max(0.1, viewport.zoom * Math.exp(-event.deltaY * 0.0012)));
    const worldX = (localX - viewport.x) / viewport.zoom;
    const worldY = (localY - viewport.y) / viewport.zoom;
    setBoardViewport({
      x: localX - worldX * nextZoom,
      y: localY - worldY * nextZoom,
      zoom: nextZoom,
    });
  }

  function fitBoard() {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const liveNodes = useDirectorCreativeWorkspaceStore.getState().boardNodes;
    if (!bounds || !liveNodes.length) return setBoardViewport({ x: 0, y: 0, zoom: 1 });
    const minX = Math.min(...liveNodes.map((node) => node.x));
    const minY = Math.min(...liveNodes.map((node) => node.y));
    const maxX = Math.max(...liveNodes.map((node) => node.x + node.width));
    const maxY = Math.max(...liveNodes.map((node) => node.y + node.height));
    const zoom = Math.min(
      1.35,
      Math.max(0.1, Math.min((bounds.width - 120) / (maxX - minX), (bounds.height - 120) / (maxY - minY))),
    );
    setBoardViewport({
      x: (bounds.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: (bounds.height - (maxY - minY) * zoom) / 2 - minY * zoom,
      zoom,
    });
  }

  function autoLayoutDag() {
    const receipt = dispatchCreativeWorkspaceOperations({ op: "canvas.dag.layout", direction: "horizontal" });
    if (!receipt.ok) {
      showImportMessage(`${t("无法自动排列")}：${receipt.error}`, "error");
      return;
    }
    showImportMessage(
      `${t("依赖图已排列")} · ${dagAnalysis.parallelLevels.length} ${t("层")} · ${dagAnalysis.roots.length} ${t("个入口")}`,
      "success",
    );
    window.requestAnimationFrame(fitBoard);
  }

  function updateAssetDropPreview(event: ReactDragEvent<HTMLDivElement>) {
    const isAssetDrag =
      event.dataTransfer.types.includes(DIRECTOR_MEDIA_DRAG_TYPE) || event.dataTransfer.types.includes("Files");
    if (!isAssetDrag) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const point = canvasPoint(event.clientX, event.clientY);
    // getData() stays empty until drop in real browsers; fall back to the in-app drag session.
    const mediaId = event.dataTransfer.getData(DIRECTOR_MEDIA_DRAG_TYPE) || getDirectorMediaDragSessionId() || "";
    const item = itemById.get(mediaId);
    setAssetDropPreview({
      x: point.x - 160,
      y: point.y - 110,
      title: item?.name ?? t("导入素材"),
      detail: item?.subtitle ?? t("松开以放置"),
      kind: item ? getMediaNodeKind(item) : "image",
      source: item ? "media" : "files",
      thumbnailUrl: item?.thumbnailUrl ?? null,
    });
    return true;
  }

  function clearAssetDropPreview() {
    setAssetDropPreview(null);
  }

  return (
    <main
      className="creative-workspace creative-canvas-workspace"
      aria-label={t("画布工作区")}
      style={panelLayout.style}
    >
      <aside className="creative-workspace-sidebar is-left">
        <CreativeMediaBrowser
          items={items}
          onAdd={addMediaNode}
          onImportFiles={importMediaFiles}
          onRelink={(item) => {
            pendingRelinkTargetRef.current = item;
            relinkInputRef.current?.click();
          }}
        />
      </aside>
      <CreativeWorkspacePanelResizer
        label={t("调整素材栏宽度")}
        onKeyDown={(event) => panelLayout.resizeFromKeyboard("media", event)}
        onPointerDown={(event) => panelLayout.beginResize("media", event)}
        panel="media"
      />
      <section className="creative-board-stage">
        <div
          aria-label={t("画布操作")}
          className="creative-board-toolbar creative-board-toolbar-secondary"
          role="toolbar"
        >
          <div className="creative-add-node-control">
            <button
              aria-expanded={addMenuOpen}
              aria-haspopup="menu"
              aria-label={t("添加节点")}
              className={addMenuOpen ? "is-active" : ""}
              onClick={() => setAddMenuOpen((current) => !current)}
              type="button"
            >
              <Plus aria-hidden size={16} />
            </button>
            {addMenuOpen ? (
              <div className="creative-add-node-menu" role="menu">
                <button onClick={() => importInputRef.current?.click()} role="menuitem" type="button">
                  <Upload aria-hidden size={15} />
                  <span>
                    <strong>{t("上传")}</strong>
                    <small>{t("导入图片、视频或音频")}</small>
                  </span>
                </button>
                <button
                  onClick={() => addIdeaNode("note", "文本备注", "写下剧情、台词或镜头意图。", "#c9a35f")}
                  role="menuitem"
                  type="button"
                >
                  <Type aria-hidden size={15} />
                  <span>
                    <strong>{t("文本备注")}</strong>
                    <small>{t("记录剧情与制作说明")}</small>
                  </span>
                </button>
                <button
                  onClick={() => addIdeaNode("image", "生成图片", "描述希望生成的构图、角色与风格。", "#8f83d9")}
                  role="menuitem"
                  type="button"
                >
                  <Images aria-hidden size={15} />
                  <span>
                    <strong>{t("生成图片")}</strong>
                    <small>{t("创建可交给 Agent 的图片任务")}</small>
                  </span>
                </button>
                <button
                  onClick={() => addIdeaNode("video", "生成视频", "描述镜头运动、主体动作与时长。", "#d96d83")}
                  role="menuitem"
                  type="button"
                >
                  <WandSparkles aria-hidden size={15} />
                  <span>
                    <strong>{t("生成视频")}</strong>
                    <small>{t("创建可交给 Agent 的视频任务")}</small>
                  </span>
                </button>
                <button
                  onClick={() => addIdeaNode("audio", "生成语音", "填写旁白、对白、语言与情绪。", "#4fae9d")}
                  role="menuitem"
                  type="button"
                >
                  <Mic2 aria-hidden size={15} />
                  <span>
                    <strong>{t("生成语音")}</strong>
                    <small>{t("创建旁白与对白任务")}</small>
                  </span>
                </button>
                <button
                  onClick={() => addIdeaNode("audio", "生成音乐", "描述配乐风格、节奏、情绪与时长。", "#4da58c")}
                  role="menuitem"
                  type="button"
                >
                  <Music2 aria-hidden size={15} />
                  <span>
                    <strong>{t("生成音乐")}</strong>
                    <small>{t("创建配乐与声音氛围任务")}</small>
                  </span>
                </button>
                <button
                  onClick={() => addIdeaNode("note", "灵感", "收集角色、场景和叙事方向。", "#6d92c4")}
                  role="menuitem"
                  type="button"
                >
                  <Lightbulb aria-hidden size={15} />
                  <span>
                    <strong>{t("获取灵感")}</strong>
                    <small>{t("展开故事与视觉方向")}</small>
                  </span>
                </button>
              </div>
            ) : null}
            <input
              accept="image/*,video/*,audio/*"
              aria-label={t("导入素材")}
              className="sr-only"
              multiple
              onChange={(event) => {
                const input = event.currentTarget;
                const files = Array.from(input.files ?? []);
                if (files.length > 0) void importMediaFiles(files);
                input.value = "";
              }}
              ref={importInputRef}
              tabIndex={-1}
              type="file"
            />
          </div>
          {(
            [
              ["select", MousePointer2, "选择"],
              ["hand", Hand, "手型浏览"],
              ["connect", Cable, "连接节点"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              aria-label={t(label)}
              aria-pressed={tool === id}
              className={tool === id ? "is-active" : ""}
              key={id}
              onClick={() => {
                setTool(id);
                setConnectSourceId(null);
              }}
              type="button"
            >
              <Icon aria-hidden size={16} />
            </button>
          ))}
          <span className="creative-toolbar-separator" />
          <button
            aria-label={t("撤销")}
            disabled={!canUndo}
            onClick={() => dispatchCanvas({ op: "workspace.undo" }, t("撤销失败"))}
            type="button"
          >
            <Undo2 aria-hidden size={16} />
          </button>
          <button
            aria-label={t("重做")}
            disabled={!canRedo}
            onClick={() => dispatchCanvas({ op: "workspace.redo" }, t("重做失败"))}
            type="button"
          >
            <Redo2 aria-hidden size={16} />
          </button>
          <span className="creative-toolbar-separator" />
          <button aria-label={t("添加便签")} onClick={addNote} type="button">
            <StickyNote aria-hidden size={16} />
          </button>
          <button aria-label={t("添加分区")} onClick={addSection} type="button">
            <LayoutGrid aria-hidden size={16} />
          </button>
          <button aria-label={t("导入剧本")} onClick={() => setScriptModalOpen(true)} type="button">
            <FileText aria-hidden size={16} />
          </button>
          <button
            aria-label={t("生成节点")}
            onClick={() => setComfyNodesDialogOpen(true)}
            title={t("ComfyUI 节点池")}
            type="button"
          >
            <Server aria-hidden size={16} />
          </button>
          <button aria-label={t("添加分组")} onClick={addFrame} type="button">
            <PanelsTopLeft aria-hidden size={16} />
          </button>
          <button
            aria-label={t("自动排列依赖图")}
            disabled={boardNodes.length === 0 || !dagAnalysis.valid}
            onClick={autoLayoutDag}
            title={dagAnalysis.valid ? t("按依赖层级排列，可并行节点位于同一列") : t("依赖图包含循环或无效连接")}
            type="button"
          >
            <Workflow aria-hidden size={16} />
          </button>
          <button
            aria-label={t("运行 Canvas 依赖图")}
            disabled={pipelineRunning || boardNodes.length === 0 || !dagAnalysis.valid}
            onClick={() => void runCanvasPipeline()}
            title={
              dagAnalysis.valid ? t("按拓扑层级执行；同层节点并行，失败只阻断其下游") : t("依赖图包含循环或无效连接")
            }
            type="button"
          >
            {pipelineRunning ? (
              <LoaderCircle aria-hidden className="creative-spin" size={16} />
            ) : (
              <Play aria-hidden size={16} />
            )}
          </button>
          {pipelineRunning ? (
            <button aria-label={t("取消 Canvas 流水线")} onClick={cancelCanvasPipeline} type="button">
              <Square aria-hidden size={15} />
            </button>
          ) : latestPipelineRun && ["partial", "failed", "cancelled"].includes(latestPipelineRun.status) ? (
            <button
              aria-label={t("重试失败的 Canvas 节点")}
              disabled={!dagAnalysis.valid}
              onClick={() => void runCanvasPipeline()}
              title={t("已成功或已有媒体的节点作为缓存复用，只重跑未完成分支")}
              type="button"
            >
              <RefreshCw aria-hidden size={15} />
            </button>
          ) : null}
        </div>
        {connectSourceId ? (
          <div className="creative-board-connection-tip">{t("选择另一个节点完成连接，Esc 取消")}</div>
        ) : null}
        {importMessage ? (
          <div
            className={`creative-board-import-status is-${importMessage.severity}`}
            role={importMessage.severity === "error" ? "alert" : "status"}
          >
            <div className="creative-board-status-content">
              <span>{importMessage.text}</span>
              {pipelineRunning && pipelineProgress ? (
                <div className="creative-board-pipeline-progress">
                  <span>
                    {`${pipelineProgress.completed}/${pipelineProgress.total} 个节点完成 · 第 ${pipelineProgress.currentLevel}/${pipelineProgress.totalLevels} 层`}
                  </span>
                  <span
                    aria-label={t("Canvas 流水线进度")}
                    aria-valuemax={pipelineProgress.total}
                    aria-valuemin={0}
                    aria-valuenow={pipelineProgress.completed}
                    className="creative-board-pipeline-progress-track"
                    role="progressbar"
                  >
                    <span
                      className="creative-board-pipeline-progress-fill"
                      style={
                        {
                          "--canvas-pipeline-progress":
                            pipelineProgress.total > 0
                              ? `${Math.round((pipelineProgress.completed / pipelineProgress.total) * 100)}%`
                              : "0%",
                        } as CSSProperties
                      }
                    />
                  </span>
                </div>
              ) : null}
            </div>
            {comfyNodesHintVisible ? (
              <button
                className="creative-board-import-action"
                onClick={() => setComfyNodesDialogOpen(true)}
                type="button"
              >
                {t("配置生成节点")}
              </button>
            ) : null}
            <button
              aria-label={t("关闭状态消息")}
              className="creative-board-status-close"
              onClick={() => {
                setImportMessage(null);
                setComfyNodesHintVisible(false);
              }}
              type="button"
            >
              <X aria-hidden size={12} />
            </button>
          </div>
        ) : null}
        <div
          className={`creative-board-surface is-tool-${tool}${assetDropPreview ? " is-asset-drag-over" : ""}`}
          onDragEnter={updateAssetDropPreview}
          onDragOver={(event) => {
            updateAssetDropPreview(event);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearAssetDropPreview();
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files ?? []).filter(
              (file) =>
                file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/"),
            );
            if (files.length) {
              event.preventDefault();
              clearAssetDropPreview();
              void importMediaFiles(files, canvasPoint(event.clientX, event.clientY));
              return;
            }
            const id = event.dataTransfer.getData(DIRECTOR_MEDIA_DRAG_TYPE);
            const item = itemById.get(id);
            if (!item) {
              clearAssetDropPreview();
              return;
            }
            event.preventDefault();
            clearAssetDropPreview();
            const point = canvasPoint(event.clientX, event.clientY);
            void addMediaNode(item, point.x, point.y);
          }}
          onPointerDown={beginPan}
          onWheel={zoomAt}
          ref={surfaceRef}
        >
          <div
            className="creative-board-grid"
            style={{
              backgroundPosition: `${viewport.x}px ${viewport.y}px`,
              backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
            }}
          />
          <svg
            aria-hidden
            className="creative-board-edges"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {boardEdges.map((edge) => {
              const source = nodeById.get(edge.sourceNodeId);
              const target = nodeById.get(edge.targetNodeId);
              if (!source || !target) return null;
              const x1 = source.x + source.width;
              const y1 = source.y + source.height / 2;
              const x2 = target.x;
              const y2 = target.y + target.height / 2;
              const bend = Math.max(64, Math.abs(x2 - x1) * 0.45);
              return (
                <g
                  className="creative-board-edge"
                  key={edge.id}
                  onClick={() => dispatchCanvas({ op: "canvas.edge.remove", edge_id: edge.id }, t("连接删除失败"))}
                >
                  <path
                    className="creative-board-edge-hit"
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  />
                  <path d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />
                </g>
              );
            })}
          </svg>
          <div
            className="creative-board-plane"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            {boardSections.map((section: DirectorBoardSection) => (
              <div
                className={`creative-board-section is-${section.kind}${section.collapsed ? " is-collapsed" : ""}`}
                key={section.id}
                style={
                  {
                    left: section.x,
                    top: section.y,
                    width: section.width,
                    height: section.collapsed ? 28 : section.height,
                    "--section-accent": section.accent,
                  } as CSSProperties
                }
              >
                <header className="creative-board-section-header">
                  <span className="creative-board-section-icon">
                    <SectionKindIcon kind={section.kind} />
                  </span>
                  <span className="creative-board-section-title">{section.title}</span>
                </header>
                {!section.collapsed ? <div aria-hidden className="creative-board-section-lane" /> : null}
              </div>
            ))}
            {boardNodes.map((node) => {
              const item = resolveBoardMediaItem(node, itemById, items);
              const selected = node.id === selectedNodeId;
              const offline = item?.availability === "offline" && item.kind !== "shot";
              const displayedStatus =
                offline && (node.productionJobStatus === "cached" || node.productionJobStatus === "succeeded")
                  ? "offline"
                  : node.productionJobStatus;
              return (
                <article
                  className={`creative-board-node is-${node.kind}${selected ? " is-selected" : ""}${offline ? " is-offline" : ""}${connectSourceId === node.id ? " is-connection-source" : ""}`}
                  key={node.id}
                  onPointerDown={(event) => beginNodeDrag(event, node)}
                  title={offline ? t("素材离线，请重连") : undefined}
                  style={
                    {
                      left: node.x,
                      top: node.y,
                      width: node.width,
                      height: node.height,
                      "--node-accent": node.accent,
                    } as CSSProperties
                  }
                >
                  <header>
                    <span className="creative-node-type">
                      {t(
                        node.kind === "frame"
                          ? "分组"
                          : node.kind === "note"
                            ? "便签"
                            : node.kind === "video"
                              ? "视频"
                              : node.kind === "audio"
                                ? "音频"
                                : node.kind === "shot"
                                  ? "3D 分镜"
                                  : "图片",
                      )}
                    </span>
                    <button
                      aria-label={t("置于顶层")}
                      className="creative-node-front-button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        bringBoardNodeToFront(node.id);
                      }}
                      type="button"
                    >
                      <BringToFront aria-hidden size={13} />
                    </button>
                  </header>
                  {node.kind !== "note" && node.kind !== "frame" ? (
                    <div className="creative-node-media">
                      <BoardNodeMedia item={item} node={node} />
                    </div>
                  ) : null}
                  <div className="creative-node-copy">
                    <strong data-i18n-user-content>{node.title}</strong>
                    <p data-i18n-user-content>{node.body}</p>
                    {displayedStatus ? (
                      <small className={`creative-node-job-status is-${displayedStatus}`}>
                        {displayedStatus === "offline" ? t("离线") : displayedStatus}
                      </small>
                    ) : null}
                  </div>
                  {node.kind !== "frame" ? (
                    <>
                      <span aria-hidden className="creative-node-port is-input" />
                      <span aria-hidden className="creative-node-port is-output" />
                    </>
                  ) : null}
                  {selected ? (
                    <button
                      aria-label={t("调整节点大小")}
                      className="creative-node-resizer"
                      onPointerDown={(event) => beginResize(event, node)}
                      type="button"
                    />
                  ) : null}
                </article>
              );
            })}
            {assetDropPreview ? (
              <div
                aria-hidden
                className={`creative-asset-drop-preview is-${assetDropPreview.source} is-${assetDropPreview.kind}`}
                style={{ left: assetDropPreview.x, top: assetDropPreview.y }}
              >
                <div className="creative-asset-drop-preview-media">
                  {assetDropPreview.thumbnailUrl ? (
                    <img alt="" draggable={false} src={assetDropPreview.thumbnailUrl} />
                  ) : (
                    <Upload aria-hidden size={24} />
                  )}
                </div>
                <div>
                  <strong>{assetDropPreview.title}</strong>
                  <small>{assetDropPreview.detail}</small>
                </div>
              </div>
            ) : null}
          </div>
          {!boardNodes.length ? (
            <div className="creative-board-empty">
              <div className="creative-board-empty-card">
                <span className="creative-board-empty-icon">
                  <Sparkles aria-hidden size={22} />
                </span>
                <div className="creative-board-empty-copy">
                  <strong>{t("无限画布，从这里开始")}</strong>
                  <span>{t("拖入素材、添加节点，或导入 Fountain 剧本自动编排")}</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
      <input
        accept="image/*,video/*,audio/*"
        aria-label={t("选择重连素材")}
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) void relinkPendingMedia(file);
          input.value = "";
        }}
        ref={relinkInputRef}
        tabIndex={-1}
        type="file"
      />
      {comfyNodesDialogOpen ? <ComfyNodesDialog onClose={() => setComfyNodesDialogOpen(false)} /> : null}
      {scriptModalOpen ? (
        <div
          className="creative-script-import-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("导入 Fountain 剧本")}
        >
          <div className="creative-script-import-dialog">
            <header>
              <strong>{t("导入 Fountain 剧本")}</strong>
              <button aria-label={t("关闭")} onClick={() => setScriptModalOpen(false)} type="button">
                ×
              </button>
            </header>
            <textarea
              onChange={(event) => setScriptDraft(event.currentTarget.value)}
              placeholder={t("粘贴 Fountain 格式剧本，或选择 .fountain / .txt 文件")}
              rows={12}
              value={scriptDraft}
            />
            <footer>
              <button onClick={() => scriptFileInputRef.current?.click()} type="button">
                <Upload aria-hidden size={14} />
                {t("选择文件")}
              </button>
              <button className="creative-primary-button" onClick={() => importScriptText(scriptDraft)} type="button">
                {t("导入到画布")}
              </button>
            </footer>
          </div>
        </div>
      ) : null}
      <input
        accept=".fountain,.txt,text/plain"
        aria-label={t("选择文件")}
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) void importScriptFile(file);
          input.value = "";
        }}
        ref={scriptFileInputRef}
        tabIndex={-1}
        type="file"
      />
    </main>
  );
}
