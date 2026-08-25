import { logDirectorProjectRepairs, parseDirectorProjectForLoad, useDirectorStore } from "../store/directorStore";
import type { DirectorProject, ViewMode } from "../schema/directorProject";
import type { ViewportAspectRatio } from "@director/protocol/workbench-ui";
import { requestViewportCapture } from "./captureBridge";
import { resetDirectorSessionRuntime, updateDirectorSessionRuntime } from "../session/directorSessionRuntime";
import { applyDirectorTheme, getDirectorTheme } from "../../app/theme/directorTheme";

interface HostPanoramaPayload {
  edgeId?: unknown;
  sourceNodeId?: unknown;
  imageUrl?: unknown;
  fileName?: unknown;
}

interface HostSessionPayload {
  instanceId?: unknown;
  sceneId?: unknown;
  revision?: unknown;
  changeId?: unknown;
  theme?: unknown;
  projectJson?: unknown;
  viewMode?: unknown;
  viewportAspectRatio?: unknown;
}

/** A single capture item sent from the Director Desk to the host (e.g. for ComfyUI pipelines). */
export interface HostCaptureItemPayload {
  dataUrl?: unknown;
  fileName?: unknown;
}

/** A batch of captures sent from the Director Desk to the host. */
export interface HostCaptureBatchPayload {
  captures?: HostCaptureItemPayload[];
}

/** Result of sending a reference video to the host, containing the relative ComfyUI file name. */
export interface DirectorReferenceVideoResult {
  relativeName: string;
  nodeType: string | null;
}

interface HostConnectedPanorama {
  edgeId: string;
  sourceNodeId: string;
}

interface ProjectChange {
  instanceId: string;
  payloadKey: string;
  projectJson: string;
  viewMode: ViewMode;
  viewportAspectRatio: ViewportAspectRatio;
}

let initialized = false;
let hostConnectedPanorama: HostConnectedPanorama | null = null;
let removeUnsubscribe: (() => void) | null = null;
let suppressNextPanoramaRemovalNotice = false;
let currentInstanceId = "";
let currentHostRevision: number | null = null;
let removeProjectUnsubscribe: (() => void) | null = null;
let previousProjectPayload = "";
let isHydratingHostSession = false;
let awaitingHostRevisionAck = false;
let nextProjectChangeId = 1;
let latestProjectChangeId: number | null = null;
let hostBridgeGeneration = 0;
let nextVideoRequestId = 1;
const MAX_DIRECTOR_REFERENCE_VIDEO_BYTES = 512 * 1024 * 1024;
const DIRECTOR_REFERENCE_VIDEO_TIMEOUT_MS = 60_000;
const pendingVideoRequests = new Map<
  string,
  {
    resolve: (result: DirectorReferenceVideoResult) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }
>();

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isSafeRelativeComfyName(value: string) {
  return (
    Boolean(value) &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes("://") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function getHostOrigin() {
  return window.location.origin;
}

function normalizeTheme(value: unknown): "dark" | "light" | null {
  return value === "light" || value === "dark" ? value : null;
}

function normalizeViewMode(value: unknown): ViewMode | null {
  return value === "camera" || value === "director" ? value : null;
}

function normalizeViewportAspectRatio(value: unknown): ViewportAspectRatio | null {
  return value === "auto" ||
    value === "1:1" ||
    value === "2:1" ||
    value === "3:4" ||
    value === "4:3" ||
    value === "16:9" ||
    value === "21:9" ||
    value === "9:16"
    ? value
    : null;
}

function parseHostProject(value: unknown): DirectorProject | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const result = parseDirectorProjectForLoad(JSON.parse(value) as unknown);
    if (!result.success) {
      console.error(`宿主项目无法加载：${result.error}`);
      return null;
    }
    logDirectorProjectRepairs("加载宿主项目", result.repairs);
    return result.project;
  } catch {
    return null;
  }
}

function getInitialHostTheme() {
  try {
    return normalizeTheme(new URLSearchParams(window.location.search).get("theme"));
  } catch {
    return null;
  }
}

function createProjectChange(instanceId: string): ProjectChange {
  const state = useDirectorStore.getState();
  const projectJson = JSON.stringify(state.project);

  return {
    instanceId,
    payloadKey: `${projectJson}\n${state.viewMode}\n${state.viewportAspectRatio}`,
    projectJson,
    viewMode: state.viewMode,
    viewportAspectRatio: state.viewportAspectRatio,
  };
}

function postProjectChange(instanceId: string) {
  if (isHydratingHostSession || !currentInstanceId || instanceId !== currentInstanceId) {
    return;
  }
  const change = createProjectChange(instanceId);
  if (change.payloadKey === previousProjectPayload) {
    return;
  }

  previousProjectPayload = change.payloadKey;
  const changeId = nextProjectChangeId;
  nextProjectChangeId += 1;
  latestProjectChangeId = changeId;
  // Until the host acknowledges the save, the visible project is no longer
  // known to match any persisted Director revision.
  currentHostRevision = null;
  awaitingHostRevisionAck = true;
  updateDirectorSessionRuntime({ revision: null, dirty: true, conflict: null });
  window.parent?.postMessage(
    {
      type: "storyai:director-desk-project-changed",
      payload: {
        instanceId: change.instanceId,
        changeId,
        projectJson: change.projectJson,
        viewMode: change.viewMode,
        viewportAspectRatio: change.viewportAspectRatio,
      },
    },
    getHostOrigin(),
  );
}

function notifyPanoramaRemoved() {
  if (!hostConnectedPanorama) {
    return;
  }

  window.parent?.postMessage(
    {
      type: "storyai:director-desk-panorama-removed",
      payload: hostConnectedPanorama,
    },
    getHostOrigin(),
  );
  hostConnectedPanorama = null;
}

function subscribeToPanoramaRemoval() {
  if (removeUnsubscribe) {
    return;
  }

  let previousPanoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;
  removeUnsubscribe = useDirectorStore.subscribe((state) => {
    const nextPanoramaAssetId = state.project.panoramaAssetId;

    if (previousPanoramaAssetId && !nextPanoramaAssetId) {
      if (suppressNextPanoramaRemovalNotice) {
        suppressNextPanoramaRemovalNotice = false;
        hostConnectedPanorama = null;
      } else {
        notifyPanoramaRemoved();
      }
    }

    previousPanoramaAssetId = nextPanoramaAssetId;
  });
}

function importHostPanorama(payload: HostPanoramaPayload) {
  const imageUrl = normalizeString(payload.imageUrl);
  if (!imageUrl) {
    return;
  }

  const fileName = normalizeString(payload.fileName) || "画布全景图.png";
  const edgeId = normalizeString(payload.edgeId);
  const sourceNodeId = normalizeString(payload.sourceNodeId);

  hostConnectedPanorama = edgeId && sourceNodeId ? { edgeId, sourceNodeId } : null;
  useDirectorStore.getState().addImportedAsset({
    kind: "panorama",
    name: fileName,
    fileName,
    url: imageUrl,
    projectionMode: "backdrop",
  });
}

function openHostSession(payload: HostSessionPayload) {
  const instanceId = normalizeString(payload.instanceId);
  const sceneId = normalizeString(payload.sceneId);
  const theme = normalizeTheme(payload.theme);
  const project = parseHostProject(payload.projectJson);
  const viewMode = normalizeViewMode(payload.viewMode);
  const viewportAspectRatio = normalizeViewportAspectRatio(payload.viewportAspectRatio);
  const revision = normalizeNonNegativeInteger(payload.revision);
  if (theme) {
    applyDirectorTheme(theme);
  }

  const hasAuthoritativeHydration = Boolean(project || viewMode || viewportAspectRatio);
  if (instanceId === currentInstanceId && !hasAuthoritativeHydration) {
    // A theme-only refresh may carry the host's last persisted revision.  It
    // must not re-arm capture while a newer local project is awaiting save.
    if (revision !== undefined && !awaitingHostRevisionAck) currentHostRevision = revision;
    updateDirectorSessionRuntime({
      instanceId,
      ...(sceneId ? { sceneId } : {}),
      revision: currentHostRevision,
      dirty: awaitingHostRevisionAck,
      comfyui: "connected",
    });
    return;
  }

  currentInstanceId = instanceId;
  currentHostRevision = revision ?? null;
  awaitingHostRevisionAck = false;
  latestProjectChangeId = null;
  updateDirectorSessionRuntime({
    instanceId,
    sceneId,
    revision: currentHostRevision,
    dirty: false,
    conflict: null,
    comfyui: "connected",
  });
  isHydratingHostSession = true;

  try {
    suppressNextPanoramaRemovalNotice = Boolean(useDirectorStore.getState().project.panoramaAssetId);
    useDirectorStore.getState().openScopedScene(instanceId || null);
    if (project) {
      useDirectorStore.getState().replaceProject(project);
    }
    if (viewMode) {
      useDirectorStore.getState().setViewMode(viewMode);
    }
    if (viewportAspectRatio) {
      useDirectorStore.getState().setViewportAspectRatio(viewportAspectRatio);
    }
  } finally {
    suppressNextPanoramaRemovalNotice = false;
    hostConnectedPanorama = null;
    isHydratingHostSession = false;
    previousProjectPayload = instanceId ? createProjectChange(instanceId).payloadKey : "";
  }
}

function applyExternalHostScene(payload: HostSessionPayload) {
  const project = parseHostProject(payload.projectJson);
  const viewMode = normalizeViewMode(payload.viewMode);
  const viewportAspectRatio = normalizeViewportAspectRatio(payload.viewportAspectRatio);
  const instanceId = normalizeString(payload.instanceId);
  const sceneId = normalizeString(payload.sceneId);
  const revision = normalizeNonNegativeInteger(payload.revision);
  if (!project && !viewMode && !viewportAspectRatio) return;
  if (instanceId && currentInstanceId && instanceId !== currentInstanceId) return;

  isHydratingHostSession = true;

  try {
    if (project) useDirectorStore.getState().replaceProject(project);
    if (viewMode) useDirectorStore.getState().setViewMode(viewMode);
    if (viewportAspectRatio) {
      useDirectorStore.getState().setViewportAspectRatio(viewportAspectRatio);
    }
  } finally {
    isHydratingHostSession = false;
    previousProjectPayload = currentInstanceId ? createProjectChange(currentInstanceId).payloadKey : "";
    currentHostRevision = revision ?? null;
    awaitingHostRevisionAck = false;
    latestProjectChangeId = null;
    updateDirectorSessionRuntime({
      ...(instanceId ? { instanceId } : {}),
      ...(sceneId ? { sceneId } : {}),
      revision: currentHostRevision,
      dirty: false,
      conflict: null,
      comfyui: "connected",
    });
  }
}

function acknowledgeHostRevision(payload: HostSessionPayload) {
  const instanceId = normalizeString(payload.instanceId);
  const revision = normalizeNonNegativeInteger(payload.revision);
  const changeId = normalizeNonNegativeInteger(payload.changeId);
  if (revision === undefined || instanceId !== currentInstanceId) return;

  // A save that started before a newer local edit may finish first.  Only the
  // acknowledgement for the newest visible edit is allowed to make capture
  // revision-safe again.  Legacy acknowledgements remain usable only when no
  // local edit is waiting for persistence.
  if (awaitingHostRevisionAck) {
    if (latestProjectChangeId === null || changeId !== latestProjectChangeId) return;
  } else if (changeId !== undefined) {
    return;
  }

  currentHostRevision = revision;
  awaitingHostRevisionAck = false;
  latestProjectChangeId = null;
  updateDirectorSessionRuntime({
    revision,
    dirty: false,
    conflict: null,
    comfyui: "connected",
  });
}

async function handleHostCaptureRequest(payload: Record<string, unknown>) {
  const requestId = normalizeString(payload.requestId);
  if (!requestId) return;
  const generation = hostBridgeGeneration;
  const instanceId = currentInstanceId;

  try {
    const preset = payload.preset === "four" || payload.preset === "twelve" ? payload.preset : "current";
    const revisionRequested = normalizeNonNegativeInteger(payload.revisionRequested);
    if (revisionRequested !== undefined && currentHostRevision !== revisionRequested) {
      throw new Error(`Capture revision r${revisionRequested} is not active in the Director Desk`);
    }
    const results = await requestViewportCapture({
      preset,
      source: "capture-panel",
      cameraId: normalizeString(payload.cameraId) || null,
      frame: normalizeNonNegativeInteger(payload.frame),
      revisionRequested,
    });
    if (revisionRequested !== undefined && currentHostRevision !== revisionRequested) {
      throw new Error(`Director scene changed away from r${revisionRequested} during capture`);
    }
    if (!initialized || generation !== hostBridgeGeneration || instanceId !== currentInstanceId) {
      return;
    }
    window.parent?.postMessage(
      {
        type: "storyai:director-desk-capture-result",
        payload: { requestId, captures: results },
      },
      getHostOrigin(),
    );
  } catch (error) {
    if (!initialized || generation !== hostBridgeGeneration || instanceId !== currentInstanceId) {
      return;
    }
    window.parent?.postMessage(
      {
        type: "storyai:director-desk-capture-result",
        payload: {
          requestId,
          captures: [],
          error: error instanceof Error ? error.message : "Viewport capture failed",
        },
      },
      getHostOrigin(),
    );
  }
}

function subscribeToProjectChanges() {
  if (removeProjectUnsubscribe) {
    return;
  }

  removeProjectUnsubscribe = useDirectorStore.subscribe(() => {
    if (!currentInstanceId || isHydratingHostSession) {
      return;
    }

    postProjectChange(currentInstanceId);
  });
}

/**
 * Posts one or more Director Desk captures to the host (e.g. StoryAI) via postMessage.
 * Invalid data URLs are silently dropped; the call is a no-op when no valid captures remain.
 *
 * @param captures - Array of data URL + optional file name pairs.
 */
export function postDirectorDeskCapturesToHost(
  captures: Array<{
    dataUrl: string;
    fileName?: string;
  }>,
) {
  const normalizedCaptures = captures
    .map((capture, index) => {
      const dataUrl = normalizeString(capture.dataUrl);
      if (!dataUrl) {
        return null;
      }

      return {
        dataUrl,
        fileName: normalizeString(capture.fileName) || `director-desk-capture-${index + 1}.png`,
      };
    })
    .filter((capture): capture is { dataUrl: string; fileName: string } => Boolean(capture));

  if (normalizedCaptures.length === 0) {
    return;
  }

  window.parent?.postMessage(
    {
      type: "storyai:director-desk-captures-sent",
      payload: {
        captures: normalizedCaptures,
      },
    },
    getHostOrigin(),
  );
}

/**
 * Sends a rendered reference video to the host for ComfyUI processing.
 * Validates the blob, mime type, frame range, FPS, and duration before posting.
 *
 * @param video - The video blob, file name, mime type, frame range, FPS, and duration.
 * @returns A promise that resolves with the ComfyUI relative file name and node type.
 */
export function postDirectorDeskVideoToHost(video: {
  blob: Blob;
  fileName: string;
  mimeType: string;
  frameStart: number;
  frameEnd: number;
  fps: number;
  durationSec: number;
}) {
  if (!(video.blob instanceof Blob) || video.blob.size <= 0) {
    return Promise.reject(new Error("渲染视频没有有效的二进制内容"));
  }
  if (video.blob.size > MAX_DIRECTOR_REFERENCE_VIDEO_BYTES) {
    return Promise.reject(new Error("渲染视频超过 512 MiB 的 ComfyUI 上传上限"));
  }
  const mimeType = normalizeString(video.mimeType || video.blob.type)
    .split(";", 1)[0]
    .toLowerCase();
  if (mimeType !== "video/webm" && mimeType !== "video/mp4") {
    return Promise.reject(new Error("仅支持 WebM 或 MP4 参考视频"));
  }
  const blobMimeType = normalizeString(video.blob.type).split(";", 1)[0].toLowerCase();
  if (blobMimeType && blobMimeType !== mimeType) {
    return Promise.reject(new Error("参考视频 Blob 类型与声明格式不一致"));
  }
  const frameStart = normalizeNonNegativeInteger(video.frameStart);
  const frameEnd = normalizeNonNegativeInteger(video.frameEnd);
  const fps = normalizeNonNegativeInteger(video.fps);
  const durationSec = Number(video.durationSec);
  if (
    frameStart === undefined ||
    frameEnd === undefined ||
    frameEnd < frameStart ||
    fps === undefined ||
    fps < 1 ||
    fps > 240 ||
    !Number.isFinite(durationSec) ||
    durationSec < 0 ||
    durationSec > 86_400
  ) {
    return Promise.reject(new Error("参考视频帧范围、FPS 或时长无效"));
  }
  const extension = mimeType === "video/mp4" ? "mp4" : "webm";
  const baseName = normalizeString(video.fileName)
    .replace(/[\\/]/g, "-")
    .replace(/\.(webm|mp4)$/i, "")
    .slice(0, 170);
  if (!baseName) return Promise.reject(new Error("参考视频文件名无效"));
  const fileName = `${baseName}.${extension}`;

  const requestId = `director-video-${Date.now()}-${nextVideoRequestId}`;
  nextVideoRequestId += 1;
  return new Promise<DirectorReferenceVideoResult>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingVideoRequests.delete(requestId);
      reject(new Error("发送参考视频到 ComfyUI 超时"));
    }, DIRECTOR_REFERENCE_VIDEO_TIMEOUT_MS);
    pendingVideoRequests.set(requestId, { resolve, reject, timeoutId });
    window.parent?.postMessage(
      {
        type: "storyai:director-desk-video-sent",
        payload: {
          requestId,
          video: {
            blob: video.blob,
            fileName,
            mimeType,
            frameStart,
            frameEnd,
            fps,
            durationSec,
          },
        },
      },
      getHostOrigin(),
    );
  });
}

function completeDirectorDeskVideoRequest(payload: Record<string, unknown>) {
  const requestId = normalizeString(payload.requestId);
  const pending = pendingVideoRequests.get(requestId);
  if (!pending) return;
  window.clearTimeout(pending.timeoutId);
  pendingVideoRequests.delete(requestId);
  if (payload.ok !== true) {
    pending.reject(new Error(normalizeString(payload.error) || "ComfyUI 参考视频上传失败"));
    return;
  }
  const relativeName = normalizeString(payload.relativeName);
  if (!isSafeRelativeComfyName(relativeName)) {
    pending.reject(new Error("ComfyUI 没有返回参考视频文件名"));
    return;
  }
  pending.resolve({
    relativeName,
    nodeType: normalizeString(payload.nodeType) || null,
  });
}

function handleHostMessage(event: MessageEvent) {
  if (event.origin !== getHostOrigin() || event.source !== window.parent) {
    return;
  }

  if (event.data?.type === "storyai:director-desk-session") {
    openHostSession((event.data.payload || {}) as HostSessionPayload);
    return;
  }

  if (event.data?.type === "storyai:director-desk-external-scene") {
    applyExternalHostScene((event.data.payload || {}) as HostSessionPayload);
    return;
  }

  if (event.data?.type === "storyai:director-desk-revision-ack") {
    acknowledgeHostRevision((event.data.payload || {}) as HostSessionPayload);
    return;
  }

  if (event.data?.type === "storyai:director-desk-capture-request") {
    void handleHostCaptureRequest((event.data.payload || {}) as Record<string, unknown>);
    return;
  }

  if (event.data?.type === "storyai:director-desk-video-result") {
    completeDirectorDeskVideoRequest((event.data.payload || {}) as Record<string, unknown>);
    return;
  }

  if (event.data?.type === "storyai:director-desk-panorama") {
    importHostPanorama((event.data.payload || {}) as HostPanoramaPayload);
  }
}

/**
 * Initializes the host bridge: subscribes to postMessage events from the parent
 * frame, wires up panorama and project change subscriptions, and applies the
 * initial theme. Idempotent — subsequent calls are no-ops until the bridge is cleared.
 */
export function initDirectorDeskHostBridge() {
  if (initialized) {
    return;
  }

  initialized = true;
  hostBridgeGeneration += 1;
  applyDirectorTheme(getInitialHostTheme() ?? getDirectorTheme(), { notify: false });
  window.addEventListener("message", handleHostMessage);
  subscribeToPanoramaRemoval();
  subscribeToProjectChanges();
}

/**
 * Apply browser-only selection/playback/view controls without treating them as
 * an authoritative scene edit or asking the host to allocate a new revision.
 */
export function applyDirectorDeskTransientState(apply: () => void) {
  const wasHydrating = isHydratingHostSession;
  isHydratingHostSession = true;
  try {
    apply();
  } finally {
    isHydratingHostSession = wasHydrating;
    previousProjectPayload = currentInstanceId ? createProjectChange(currentInstanceId).payloadKey : "";
  }
}

/** Tears down the host bridge: removes the message listener, unsubscribes from store listeners, and resets state. */
export function clearDirectorDeskHostBridge() {
  isHydratingHostSession = false;
  awaitingHostRevisionAck = false;
  nextProjectChangeId = 1;
  latestProjectChangeId = null;
  hostBridgeGeneration += 1;
  nextVideoRequestId = 1;
  pendingVideoRequests.forEach((pending) => {
    window.clearTimeout(pending.timeoutId);
    pending.reject(new Error("Director Desk 已关闭，参考视频发送已取消"));
  });
  pendingVideoRequests.clear();
  resetDirectorSessionRuntime();

  if (!initialized) {
    return;
  }

  initialized = false;
  hostConnectedPanorama = null;
  suppressNextPanoramaRemovalNotice = false;
  currentInstanceId = "";
  currentHostRevision = null;
  previousProjectPayload = "";
  window.removeEventListener("message", handleHostMessage);
  removeUnsubscribe?.();
  removeUnsubscribe = null;
  removeProjectUnsubscribe?.();
  removeProjectUnsubscribe = null;
}
