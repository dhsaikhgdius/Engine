/**
 * Creative workspace preview capture (`director_creative` preview branch).
 *
 * Renders a real PNG of the Canvas board (custom offscreen Canvas 2D
 * renderer) or a Video Editor frame (the shared timeline frame renderer) so
 * agents receive visual evidence instead of a description. Captures are
 * strictly read-only: tracks are deep-cloned, rendering happens on offscreen
 * canvases, and live Zustand state is never mutated. Every capture is guarded
 * by the caller's expected snapshot fingerprint — checked both before and
 * after the asynchronous render — so a preview can never silently show a
 * workspace that changed mid-capture.
 */
import {
  getDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
  type DirectorBoardEdge,
  type DirectorBoardNode,
  type DirectorCreativeWorkspaceState,
  type DirectorEditClip,
  type DirectorEditTrack,
} from "../comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  persistentCreativeMediaLibrary,
  type CreativeMediaAsset,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import type { DirectorMediaItem } from "../comprehensive/editor/workspaces/directorMediaLibrary";
import {
  renderDirectorTimelineFrame,
  type RenderDirectorTimelineFrameOptions,
} from "../comprehensive/editor/workspaces/directorTimelineVideoExport";
import {
  observeCreativeWorkspaceAgentSnapshot,
  type CreativeWorkspaceAgentContext,
  type CreativeWorkspaceAgentPreviewRequest,
  type CreativeWorkspaceAgentPreviewResult,
  type CreativeWorkspaceAgentToolResult,
} from "./creativeWorkspaceAgentContract";

/** The pixel width of canvas board preview renders. */
const CANVAS_PREVIEW_WIDTH = 1_440;
/** The pixel height of canvas board preview renders. */
const CANVAS_PREVIEW_HEIGHT = 900;
/** The pixel padding around the board world bounds in the preview viewport. */
const CANVAS_WORLD_PADDING = 72;
/** The maximum time (ms) to wait for a media asset to load before rejecting. */
const MEDIA_LOAD_TIMEOUT_MS = 12_000;
/**
 * The minimum time margin (seconds) from clip boundaries when selecting a
 * representative preview frame. Prevents the renderer from landing on
 * half-open clip edges.
 */
const VIDEO_PREVIEW_INTERIOR_MARGIN_SEC = 0.1;

/** The workspace area being previewed. */
type PreviewWorkspace = "canvas" | "video";

/** A media asset loaded into a form ready for Canvas 2D rendering. */
interface LoadedCanvasVisual {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Optional cleanup callback invoked after the render pass completes. */
  dispose?: () => void;
}

/** Metadata describing a canvas board preview capture. */
export interface CreativeCanvasBoardPreviewMetadata {
  kind: "canvas_board";
  /** Number of board nodes rendered. */
  nodeCount: number;
  /** Number of board edges rendered. */
  edgeCount: number;
  /** Number of media thumbnails successfully loaded and drawn. */
  mediaThumbnailCount: number;
  /** The bounding box of all nodes in board coordinates. */
  worldBounds: { x: number; y: number; width: number; height: number };
  /** The scale factor applied to fit the board into the preview canvas. */
  renderScale: number;
}

/** Metadata describing a video frame preview capture. */
export interface CreativeVideoFramePreviewMetadata {
  kind: "video_frame";
  /** The timestamp in seconds at which the frame was captured. */
  timeSec: number;
  /** The frames-per-second setting of the timeline. */
  fps: number;
  /** The aspect ratio of the video output. */
  aspectRatio: "16 / 9" | "9 / 16" | "1 / 1";
  /** The ids of clips that contributed visible pixels to this frame. */
  activeClipIds: string[];
}

/**
 * A captured preview image of a creative workspace.
 *
 * The capture is a helper-free, clean-frame PNG data URL suitable for
 * agent consumption and direct display.
 */
export interface CreativeWorkspacePreviewCapture {
  /** The workspace area that was captured. */
  workspace: PreviewWorkspace;
  /** The snapshot fingerprint at the time capture began. */
  snapshotFingerprint: string;
  mimeType: "image/png";
  /** The PNG data URL of the captured frame. */
  dataUrl: string;
  /** The pixel width of the rendered image. */
  width: number;
  /** The pixel height of the rendered image. */
  height: number;
  /** Guaranteed `true` — no UI chrome or overlays are present. */
  cleanFrame: true;
  /** Guaranteed `false` — no selection handles or guides are present. */
  helpersIncluded: false;
  /** Workspace-specific metadata about the capture. */
  metadata: CreativeCanvasBoardPreviewMetadata | CreativeVideoFramePreviewMetadata;
}

/**
 * Injectable dependencies for preview rendering.
 *
 * Allows tests and alternative environments to supply custom canvas
 * creation, media loading, and timeline rendering implementations.
 */
export interface CreativeWorkspacePreviewDependencies {
  /** Creates a canvas element of the given dimensions. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** Loads a media asset into a Canvas 2D renderable visual. */
  loadCanvasVisual?: (asset: CreativeMediaAsset, signal?: AbortSignal) => Promise<LoadedCanvasVisual | null>;
  /** Renders a single frame of the timeline at the given time. */
  renderTimelineFrame?: typeof renderDirectorTimelineFrame;
}

/**
 * Error thrown when a creative workspace preview capture fails.
 *
 * {@link code} `"stale_snapshot"` means the workspace changed since the
 * agent observed it; `"render_failed"` means the capture itself failed
 * (e.g. cross-origin pixel reads, media decode errors).
 */
export class CreativeWorkspacePreviewError extends Error {
  constructor(
    readonly code: "stale_snapshot" | "render_failed",
    message: string,
    /** The current fingerprint when the error was raised, for diagnostics. */
    readonly currentSnapshotFingerprint?: string,
  ) {
    super(message);
    this.name = "CreativeWorkspacePreviewError";
  }
}

const defaultContext: CreativeWorkspaceAgentContext = {
  workspace: { getState: () => useDirectorCreativeWorkspaceStore.getState() },
  media: { getState: () => persistentCreativeMediaLibrary.store.getState() },
  getScopeId: getDirectorCreativeWorkspaceScope,
};

/** Creates a fresh {@link DOMException} with the standard "AbortError" name. */
function abortError() {
  return new DOMException("Creative workspace preview aborted", "AbortError");
}

/** Throws an {@link AbortError} if the given signal is already aborted. */
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** Deep-clones an array of edit tracks so the preview does not mutate live state. */
function cloneTracks(tracks: DirectorEditTrack[]): DirectorEditTrack[] {
  return tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip })) }));
}

/** Creates an off-screen canvas element sized for preview rendering. */
function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Waits for a media element to reach a specific event, with a timeout and
 * abort-signal guard. Resolves when the event fires; rejects on timeout,
 * decode error, or abort.
 */
function waitForMediaEvent(
  target: HTMLImageElement | HTMLVideoElement,
  eventName: "load" | "loadeddata" | "seeked",
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = globalThis.setTimeout(
      () => finish(() => reject(new Error("Canvas media preview timed out"))),
      MEDIA_LOAD_TIMEOUT_MS,
    );
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      target.removeEventListener(eventName, loaded);
      target.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const loaded = () => finish(resolve);
    const failed = () => finish(() => reject(new Error("Canvas media could not be decoded or read across origins")));
    const aborted = () => finish(() => reject(abortError()));
    target.addEventListener(eventName, loaded, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/**
 * Loads a creative media asset into a Canvas 2D renderable visual.
 *
 * Returns `null` for audio-only assets or assets without a usable object URL.
 * Video elements are muted and configured for inline playback.
 */
async function loadCanvasVisual(asset: CreativeMediaAsset, signal?: AbortSignal): Promise<LoadedCanvasVisual | null> {
  throwIfAborted(signal);
  if (!asset.objectUrl || asset.kind === "audio") return null;
  if (asset.kind === "video") {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const loaded = waitForMediaEvent(video, "loadeddata", signal);
    video.src = asset.objectUrl;
    video.load();
    await loaded;
    throwIfAborted(signal);
    return {
      source: video,
      width: video.videoWidth || asset.width || 1,
      height: video.videoHeight || asset.height || 1,
      dispose: () => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      },
    };
  }
  const image = new Image();
  image.decoding = "async";
  image.crossOrigin = "anonymous";
  const loaded = waitForMediaEvent(image, "load", signal);
  image.src = asset.objectUrl;
  await loaded;
  throwIfAborted(signal);
  return {
    source: image,
    width: image.naturalWidth || asset.width || 1,
    height: image.naturalHeight || asset.height || 1,
  };
}

/** Computes the bounding box that encloses all board nodes in board coordinates. */
function boardBounds(nodes: DirectorBoardNode[]) {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...nodes.map((node) => node.x));
  const y = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Draws a rounded rectangle path onto the canvas context, clamping the radius. */
function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(Math.max(0, radius), width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

/** Truncates a string with an ellipsis to fit within a given pixel width. */
function truncateLine(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (context.measureText(normalized).width <= maxWidth) return normalized;
  let text = normalized;
  while (text.length > 1 && context.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

/** Draws a visual centered and scaled to fit within a bounding rectangle. */
function drawContainedVisual(
  context: CanvasRenderingContext2D,
  visual: LoadedCanvasVisual,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(width / Math.max(1, visual.width), height / Math.max(1, visual.height));
  const drawWidth = visual.width * scale;
  const drawHeight = visual.height * scale;
  context.drawImage(visual.source, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

/** Draws a Bézier-curved edge connecting two board nodes. */
function drawBoardEdge(
  context: CanvasRenderingContext2D,
  edge: DirectorBoardEdge,
  nodeById: ReadonlyMap<string, DirectorBoardNode>,
  renderScale: number,
) {
  const source = nodeById.get(edge.sourceNodeId);
  const target = nodeById.get(edge.targetNodeId);
  if (!source || !target) return;
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const bend = Math.max(64, Math.abs(x2 - x1) * 0.45);
  context.save();
  context.strokeStyle = "#7592b8";
  context.lineWidth = 2 / renderScale;
  context.beginPath();
  context.moveTo(x1, y1);
  context.bezierCurveTo(x1 + bend, y1, x2 - bend, y2, x2, y2);
  context.stroke();
  context.restore();
}

/**
 * Draws a single board node card, including its media thumbnail (if any),
 * title, body, and kind badge. Frame nodes are rendered as dashed outlines
 * without a media slot.
 */
function drawBoardNode(
  context: CanvasRenderingContext2D,
  node: DirectorBoardNode,
  visual: LoadedCanvasVisual | null,
  renderScale: number,
) {
  context.save();
  if (node.kind === "frame") {
    context.fillStyle = "rgba(40, 54, 75, 0.34)";
    roundedRectPath(context, node.x, node.y, node.width, node.height, 18);
    context.fill();
    context.strokeStyle = node.accent || "#607b9f";
    context.lineWidth = 2 / renderScale;
    context.setLineDash([10 / renderScale, 8 / renderScale]);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#dbe7f8";
    context.font = "600 17px Inter, ui-sans-serif, system-ui, sans-serif";
    context.fillText(truncateLine(context, node.title, node.width - 32), node.x + 16, node.y + 28);
    context.restore();
    return;
  }

  context.shadowColor = "rgba(0, 0, 0, 0.3)";
  context.shadowBlur = 18 / renderScale;
  context.shadowOffsetY = 5 / renderScale;
  context.fillStyle = node.kind === "note" ? "#26344b" : "#161e2c";
  roundedRectPath(context, node.x, node.y, node.width, node.height, 16);
  context.fill();
  context.shadowColor = "transparent";
  context.strokeStyle = node.accent || "#728bad";
  context.lineWidth = 2 / renderScale;
  context.stroke();

  context.fillStyle = node.accent || "#9bb8dd";
  context.font = "600 12px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(node.kind.toUpperCase(), node.x + 16, node.y + 23);

  const copyBottom = node.y + node.height - 16;
  if (node.kind !== "note") {
    const mediaY = node.y + 36;
    const mediaHeight = Math.max(24, node.height - 105);
    context.fillStyle = "#0c121d";
    roundedRectPath(context, node.x + 12, mediaY, node.width - 24, mediaHeight, 10);
    context.fill();
    if (visual) {
      context.save();
      roundedRectPath(context, node.x + 12, mediaY, node.width - 24, mediaHeight, 10);
      context.clip();
      drawContainedVisual(context, visual, node.x + 12, mediaY, node.width - 24, mediaHeight);
      context.restore();
    } else {
      context.fillStyle = "#6f819c";
      context.font = "500 13px Inter, ui-sans-serif, system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText(node.kind === "audio" ? "AUDIO" : "MEDIA", node.x + node.width / 2, mediaY + mediaHeight / 2);
      context.textAlign = "start";
    }
  }

  context.fillStyle = "#f5f8fd";
  context.font = "600 16px Inter, ui-sans-serif, system-ui, sans-serif";
  const titleY = node.kind === "note" ? node.y + 54 : copyBottom - 25;
  context.fillText(truncateLine(context, node.title, node.width - 32), node.x + 16, titleY);
  context.fillStyle = "#aebbd0";
  context.font = "400 12px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(truncateLine(context, node.body, node.width - 32), node.x + 16, Math.min(copyBottom, titleY + 21));
  context.restore();
}

/**
 * Renders the canvas board as a PNG data URL.
 *
 * Loads all media thumbnails in parallel, then draws nodes and edges at a
 * computed scale that fits the board within the preview canvas. Disposes
 * visual resources in a `finally` block.
 */
async function renderCanvasBoard(
  nodes: DirectorBoardNode[],
  edges: DirectorBoardEdge[],
  assets: readonly CreativeMediaAsset[],
  signal: AbortSignal | undefined,
  dependencies: CreativeWorkspacePreviewDependencies,
) {
  throwIfAborted(signal);
  const width = CANVAS_PREVIEW_WIDTH;
  const height = CANVAS_PREVIEW_HEIGHT;
  const canvas = (dependencies.createCanvas ?? createCanvas)(width, height);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Unable to create Canvas preview renderer");

  const worldBounds = boardBounds(nodes);
  const fitBounds =
    worldBounds.width > 0 && worldBounds.height > 0 ? worldBounds : { x: 0, y: 0, width: 640, height: 360 };
  // Extremely small positive floor: prevents division by zero when the
  // world bounds or canvas dimensions are zero, while still producing a
  // legitimate (if tiny) render scale.
  const renderScale = Math.max(
    0.000_001,
    Math.min(
      (width - CANVAS_WORLD_PADDING * 2) / fitBounds.width,
      (height - CANVAS_WORLD_PADDING * 2) / fitBounds.height,
      2,
    ),
  );
  const offsetX = (width - fitBounds.width * renderScale) / 2 - fitBounds.x * renderScale;
  const offsetY = (height - fitBounds.height * renderScale) / 2 - fitBounds.y * renderScale;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const visualLoader = dependencies.loadCanvasVisual ?? loadCanvasVisual;
  const visuals = new Map<string, LoadedCanvasVisual>();
  const disposers: Array<() => void> = [];

  await Promise.all(
    [...new Set(nodes.flatMap((node) => (node.mediaId ? [node.mediaId] : [])))].map(async (mediaId) => {
      const asset = assetById.get(mediaId);
      if (!asset) return;
      try {
        const visual = await visualLoader(asset, signal);
        if (!visual) return;
        visuals.set(mediaId, visual);
        if (visual.dispose) disposers.push(visual.dispose);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        // A broken thumbnail must not hide the rest of a valid board preview.
      }
    }),
  );

  try {
    throwIfAborted(signal);
    context.fillStyle = "#0b111c";
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(offsetX, offsetY);
    context.scale(renderScale, renderScale);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    edges.forEach((edge) => drawBoardEdge(context, edge, nodeById, renderScale));
    nodes.forEach((node) =>
      drawBoardNode(context, node, node.mediaId ? (visuals.get(node.mediaId) ?? null) : null, renderScale),
    );
    context.restore();
    if (nodes.length === 0) {
      context.fillStyle = "#c5d2e6";
      context.font = "600 30px Inter, ui-sans-serif, system-ui, sans-serif";
      context.textAlign = "center";
      context.fillText("Empty Canvas", width / 2, height / 2);
    }
    throwIfAborted(signal);
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      throw new Error("Canvas media server did not allow cross-origin pixel reads");
    }
    if (!dataUrl.startsWith("data:image/png")) throw new Error("Canvas preview did not produce PNG output");
    return {
      dataUrl,
      width,
      height,
      metadata: {
        kind: "canvas_board" as const,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        mediaThumbnailCount: visuals.size,
        worldBounds,
        renderScale,
      },
    };
  } finally {
    disposers.forEach((dispose) => dispose());
  }
}

/** Converts creative media assets to the timeline media item format expected by the renderer. */
function creativeAssetsToTimelineMedia(assets: readonly CreativeMediaAsset[]): DirectorMediaItem[] {
  return assets.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    collection: "imports",
    name: asset.name,
    subtitle:
      asset.kind === "image"
        ? `${asset.width ?? "?"} × ${asset.height ?? "?"}`
        : `${(asset.durationSec ?? 0).toFixed(1)}s · ${asset.mimeType || asset.kind}`,
    thumbnailUrl: asset.kind === "image" ? asset.objectUrl : null,
    sourceUrl: asset.objectUrl,
    durationSec: asset.durationSec ?? (asset.kind === "image" ? 3 : 1),
    cameraId: null,
    frameStart: null,
    frameEnd: null,
  }));
}

/**
 * Resolves the preview workspace from the request and current app state.
 *
 * `"auto"` resolves to the active workspace mode, or to `"video"` when
 * a time hint or non-empty edit tracks are present, falling back to `"canvas"`.
 */
function resolvePreviewWorkspace(
  request: CreativeWorkspaceAgentPreviewRequest,
  state: DirectorCreativeWorkspaceState,
): PreviewWorkspace {
  if (request.workspace !== "auto") return request.workspace;
  if (state.mode === "canvas" || state.mode === "video") return state.mode;
  if (request.time_sec !== undefined || state.editTracks.some((track) => track.clips.length > 0)) return "video";
  return "canvas";
}

/** A visible timeline clip with its track and within-track indices. */
interface VisibleTimelineClip {
  clip: DirectorEditClip;
  trackIndex: number;
  clipIndex: number;
}

/** Returns all visible video-track clips sorted by start time, then track, then clip index. */
function visibleTimelineClips(tracks: DirectorEditTrack[]): VisibleTimelineClip[] {
  return tracks
    .flatMap((track, trackIndex) =>
      track.kind === "video" && track.visible
        ? track.clips.flatMap((clip, clipIndex) =>
            clip.opacity > 0 && clip.durationSec > 0 ? [{ clip, trackIndex, clipIndex }] : [],
          )
        : [],
    )
    .sort(
      (left, right) =>
        left.clip.startSec - right.clip.startSec ||
        left.trackIndex - right.trackIndex ||
        left.clipIndex - right.clipIndex ||
        left.clip.id.localeCompare(right.clip.id),
    );
}

/**
 * Computes the interior time range of a clip where the preview frame is
 * representative — excluding edge margins and fade regions.
 *
 * When fades consume the entire clip, falls back to the peak-visibility
 * point, clamped away from the renderer's half-open clip boundaries.
 */
function meaningfulClipInterior(clip: DirectorEditClip) {
  const startSec = clip.startSec;
  const endSec = startSec + clip.durationSec;
  const edgeInsetSec = Math.min(VIDEO_PREVIEW_INTERIOR_MARGIN_SEC, clip.durationSec / 4);
  const interiorStartSec = startSec + edgeInsetSec;
  const interiorEndSec = endSec - edgeInsetSec;
  const fullyVisibleStartSec = startSec + Math.min(clip.fadeInSec, clip.durationSec);
  const fullyVisibleEndSec = endSec - Math.min(clip.fadeOutSec, clip.durationSec);
  const meaningfulStartSec = Math.max(interiorStartSec, fullyVisibleStartSec);
  const meaningfulEndSec = Math.min(interiorEndSec, fullyVisibleEndSec);

  if (meaningfulStartSec <= meaningfulEndSec) {
    return { startSec: meaningfulStartSec, endSec: meaningfulEndSec };
  }

  // A fade may consume the whole clip. Its highest-opacity point is still a
  // useful deterministic frame, but keep it away from the renderer's
  // half-open clip boundaries so the selected layer remains active.
  const peakVisibilitySec = (fullyVisibleStartSec + fullyVisibleEndSec) / 2;
  const safePeakSec = Math.min(interiorEndSec, Math.max(interiorStartSec, peakVisibilitySec));
  return { startSec: safePeakSec, endSec: safePeakSec };
}

/**
 * Resolves the best preview time for the video workspace.
 *
 * If the playhead lands within a meaningful clip interior, it is used
 * directly. Otherwise, the midpoint of the earliest visible clip's interior
 * is selected as the most representative frame.
 */
function resolveVideoPreviewTime(tracks: DirectorEditTrack[], playheadSec: number) {
  const visibleClips = visibleTimelineClips(tracks);
  const playheadIsRepresentative = visibleClips.some(({ clip }) => {
    const interior = meaningfulClipInterior(clip);
    return playheadSec >= interior.startSec && playheadSec <= interior.endSec;
  });
  if (playheadIsRepresentative) return playheadSec;

  const earliest = visibleClips[0];
  if (!earliest) return playheadSec;
  const interior = meaningfulClipInterior(earliest.clip);
  return (interior.startSec + interior.endSec) / 2;
}

/** Returns the current snapshot fingerprint for staleness guards. */
function currentFingerprint(context: CreativeWorkspaceAgentContext) {
  return observeCreativeWorkspaceAgentSnapshot(context).snapshot_fingerprint;
}

/** Capture a real, helper-free PNG without mutating Canvas or timeline state. */
export async function captureCreativeWorkspacePreview(
  request: CreativeWorkspaceAgentPreviewRequest,
  context: CreativeWorkspaceAgentContext = defaultContext,
  signal?: AbortSignal,
  dependencies: CreativeWorkspacePreviewDependencies = {},
): Promise<CreativeWorkspacePreviewCapture> {
  throwIfAborted(signal);
  const beforeFingerprint = currentFingerprint(context);
  if (beforeFingerprint !== request.expected_snapshot_fingerprint) {
    throw new CreativeWorkspacePreviewError(
      "stale_snapshot",
      `Creative workspace changed since observe (expected ${request.expected_snapshot_fingerprint}, current ${beforeFingerprint}).`,
      beforeFingerprint,
    );
  }

  const liveState = context.workspace.getState();
  const workspace = resolvePreviewWorkspace(request, liveState);
  const nodes = liveState.boardNodes.map((node) => ({ ...node }));
  const edges = liveState.boardEdges.map((edge) => ({ ...edge }));
  const tracks = cloneTracks(liveState.editTracks);
  const settings = { ...liveState.editSettings };
  const playheadSec = liveState.playheadSec;
  const assets = context.media.getState().assets.map((asset) => ({ ...asset }));

  let capture: Omit<
    CreativeWorkspacePreviewCapture,
    "snapshotFingerprint" | "mimeType" | "cleanFrame" | "helpersIncluded" | "workspace"
  >;
  try {
    if (workspace === "canvas") {
      const rendered = await renderCanvasBoard(nodes, edges, assets, signal, dependencies);
      capture = {
        dataUrl: rendered.dataUrl,
        width: rendered.width,
        height: rendered.height,
        metadata: rendered.metadata,
      };
    } else {
      const timeSec = request.time_sec ?? resolveVideoPreviewTime(tracks, playheadSec);
      const renderTimeline = dependencies.renderTimelineFrame ?? renderDirectorTimelineFrame;
      const rendered = await renderTimeline({
        tracks,
        mediaItems: creativeAssetsToTimelineMedia(assets),
        aspectRatio: settings.aspectRatio,
        quality: settings.exportQuality,
        timeSec,
        signal,
      } satisfies RenderDirectorTimelineFrameOptions);
      capture = {
        dataUrl: rendered.dataUrl,
        width: rendered.width,
        height: rendered.height,
        metadata: {
          kind: "video_frame",
          timeSec,
          fps: settings.fps,
          aspectRatio: settings.aspectRatio,
          activeClipIds: rendered.activeClipIds,
        },
      };
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new CreativeWorkspacePreviewError("render_failed", error instanceof Error ? error.message : String(error));
  }

  throwIfAborted(signal);
  const afterFingerprint = currentFingerprint(context);
  if (afterFingerprint !== beforeFingerprint) {
    throw new CreativeWorkspacePreviewError(
      "stale_snapshot",
      `Creative workspace changed while the preview was rendering (started ${beforeFingerprint}, current ${afterFingerprint}).`,
      afterFingerprint,
    );
  }
  return {
    workspace,
    snapshotFingerprint: beforeFingerprint,
    mimeType: "image/png",
    dataUrl: capture.dataUrl,
    width: capture.width,
    height: capture.height,
    cleanFrame: true,
    helpersIncluded: false,
    metadata: capture.metadata,
  };
}

/**
 * Builds a failure result payload from a preview error.
 *
 * Maps {@link CreativeWorkspacePreviewError} codes and abort signals into
 * the structured failure shape with diagnostic context and suggested next
 * steps for the agent.
 */
function previewFailure(
  request: CreativeWorkspaceAgentPreviewRequest,
  error: unknown,
  context: CreativeWorkspaceAgentContext,
): CreativeWorkspaceAgentPreviewResult {
  const aborted = error instanceof DOMException && error.name === "AbortError";
  const typed = error instanceof CreativeWorkspacePreviewError ? error : null;
  const code = aborted ? "aborted" : (typed?.code ?? "render_failed");
  const current = typed?.currentSnapshotFingerprint ?? currentFingerprint(context);
  return {
    success: false,
    code,
    error: error instanceof Error ? error.message : String(error),
    expected_snapshot_fingerprint: request.expected_snapshot_fingerprint ?? current,
    current_snapshot_fingerprint: current,
    suggested_next:
      code === "stale_snapshot"
        ? "Observe again and request preview with the current snapshot_fingerprint."
        : code === "aborted"
          ? "Retry preview when a visual result is still required."
          : "Inspect media availability and browser decoding/CORS support, then retry preview.",
  };
}

/** Async browser executor intended for the gateway's `director_creative` preview branch. */
export async function executeCreativeWorkspaceAgentPreviewRequest(
  request: CreativeWorkspaceAgentPreviewRequest,
  context: CreativeWorkspaceAgentContext = defaultContext,
  signal?: AbortSignal,
  dependencies: CreativeWorkspacePreviewDependencies = {},
): Promise<Extract<CreativeWorkspaceAgentToolResult, { op: "preview" }>> {
  if (!request.expected_snapshot_fingerprint) {
    const current = currentFingerprint(context);
    return {
      op: "preview",
      preview: {
        success: false,
        code: "stale_snapshot",
        error: "Creative preview requires expected_snapshot_fingerprint at the browser execution boundary.",
        expected_snapshot_fingerprint: current,
        current_snapshot_fingerprint: current,
        suggested_next: "Use the public Agent boundary so it can observe and inject the current guard.",
      },
    };
  }
  try {
    const capture = await captureCreativeWorkspacePreview(request, context, signal, dependencies);
    const metadata =
      capture.metadata.kind === "canvas_board"
        ? {
            kind: capture.metadata.kind,
            node_count: capture.metadata.nodeCount,
            edge_count: capture.metadata.edgeCount,
            media_thumbnail_count: capture.metadata.mediaThumbnailCount,
            world_bounds: {
              x: capture.metadata.worldBounds.x,
              y: capture.metadata.worldBounds.y,
              width: capture.metadata.worldBounds.width,
              height: capture.metadata.worldBounds.height,
            },
            render_scale: capture.metadata.renderScale,
          }
        : {
            kind: capture.metadata.kind,
            time_sec: capture.metadata.timeSec,
            fps: capture.metadata.fps,
            aspect_ratio: capture.metadata.aspectRatio,
            active_layer_count: capture.metadata.activeClipIds.length,
            active_clip_ids: capture.metadata.activeClipIds,
          };
    return {
      op: "preview",
      preview: {
        success: true,
        workspace: capture.workspace,
        snapshot_fingerprint: capture.snapshotFingerprint,
        mime_type: capture.mimeType,
        data_url: capture.dataUrl,
        width: capture.width,
        height: capture.height,
        clean_frame: capture.cleanFrame,
        helpers_included: capture.helpersIncluded,
        metadata,
      },
    };
  } catch (error) {
    return { op: "preview", preview: previewFailure(request, error, context) };
  }
}
