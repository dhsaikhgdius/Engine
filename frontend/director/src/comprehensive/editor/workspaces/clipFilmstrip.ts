import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { clamp } from "../../../../../../packages/protocol/src/primitives";

/**
 * Filmstrip sampling for timeline video clips: renders a horizontal strip of
 * evenly spaced thumbnail tiles from a clip's source video. The module owns a
 * singleton LRU cache plus a bounded sampling pipeline so the UI can call
 * `useDirectorClipFilmstrip` per clip without coordinating decode work.
 */
export interface DirectorClipFilmstripRequest {
  /** Media identifier of the source video. */
  mediaId: string;
  /** Resolvable URL of the source video file. */
  sourceUrl: string;
  /** Clip in-point in source seconds. */
  inSec: number;
  /** Duration of the clip on the timeline in seconds. */
  timelineDurationSec: number;
  /** Playback rate multiplier; 1.0 means normal speed. */
  playbackRate: number;
  /** Rendered width of each tile in pixels. */
  tileWidth: number;
  /** Rendered height of each tile in pixels. */
  tileHeight: number;
  /** Number of evenly spaced tiles across the clip. */
  tileCount: number;
}

export interface DirectorClipFilmstrip {
  /** Opaque cache key derived from the normalized request. */
  key: string;
  /** Always exactly tileCount entries; null until (or when a seek fails) a tile is ready. */
  tiles: ReadonlyArray<string | null>;
  /** Whether every tile has been sampled (or failed) and the strip will not change further. */
  complete: boolean;
}

/** Maximum number of cached filmstrip entries before eviction. */
export const DIRECTOR_CLIP_FILMSTRIP_CACHE_LIMIT = 48;
/** Hard upper bound on tile count per strip. */
export const DIRECTOR_CLIP_FILMSTRIP_MAX_TILES = 240;
/** Minimum allowed tile edge dimension in pixels. */
export const DIRECTOR_CLIP_FILMSTRIP_MIN_TILE_EDGE = 8;
/** Maximum allowed tile edge dimension in pixels. */
export const DIRECTOR_CLIP_FILMSTRIP_MAX_TILE_EDGE = 512;

/** Two decoding videos saturate typical hardware without starving playback. */
const MAX_CONCURRENT_SAMPLERS = 2;
/** Per-step budget: covers both the initial load and every individual seek. */
const SEEK_TIMEOUT_MS = 8_000;
const TILE_JPEG_QUALITY = 0.6;

interface FilmstripTask {
  readonly key: string;
  readonly request: DirectorClipFilmstripRequest;
  cancelled: boolean;
}

// Map insertion order doubles as the LRU order: reads re-insert their entry so
// the first key is always the least recently used one.
const filmstripCache = new Map<string, DirectorClipFilmstrip>();
const filmstripListeners = new Set<() => void>();
const tasksByKey = new Map<string, FilmstripTask>();
const taskQueue: FilmstripTask[] = [];
let activeTaskCount = 0;

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeFilmstripRequest(request: DirectorClipFilmstripRequest): DirectorClipFilmstripRequest {
  const playbackRate = finiteOr(request.playbackRate, 1);
  return {
    ...request,
    inSec: Math.max(0, finiteOr(request.inSec, 0)),
    timelineDurationSec: Math.max(0, finiteOr(request.timelineDurationSec, 0)),
    playbackRate: playbackRate > 0 ? playbackRate : 1,
    tileWidth: Math.round(
      clamp(
        finiteOr(request.tileWidth, DIRECTOR_CLIP_FILMSTRIP_MIN_TILE_EDGE),
        DIRECTOR_CLIP_FILMSTRIP_MIN_TILE_EDGE,
        DIRECTOR_CLIP_FILMSTRIP_MAX_TILE_EDGE,
      ),
    ),
    tileHeight: Math.round(
      clamp(
        finiteOr(request.tileHeight, DIRECTOR_CLIP_FILMSTRIP_MIN_TILE_EDGE),
        DIRECTOR_CLIP_FILMSTRIP_MIN_TILE_EDGE,
        DIRECTOR_CLIP_FILMSTRIP_MAX_TILE_EDGE,
      ),
    ),
    tileCount: Math.round(clamp(finiteOr(request.tileCount, 1), 1, DIRECTOR_CLIP_FILMSTRIP_MAX_TILES)),
  };
}

// The key is derived from the clamped request so that two requests which
// normalize to identical sampling work share one cache entry and one task.
function filmstripKeyOf(normalized: DirectorClipFilmstripRequest) {
  return [
    normalized.mediaId,
    normalized.inSec.toFixed(3),
    normalized.timelineDurationSec.toFixed(3),
    normalized.playbackRate.toFixed(3),
    `${normalized.tileWidth}x${normalized.tileHeight}`,
    normalized.tileCount,
  ].join("|");
}

/**
 * Pure sample-time mapping, exported for tests and for the UI to reason about
 * hover previews: tile i samples the source at the center of its slice.
 */
export function directorFilmstripTileTimeSec(request: DirectorClipFilmstripRequest, tileIndex: number) {
  return request.inSec + ((tileIndex + 0.5) / request.tileCount) * request.timelineDurationSec * request.playbackRate;
}

function createStrip(key: string, tileCount: number, complete: boolean): DirectorClipFilmstrip {
  return Object.freeze({
    key,
    tiles: Object.freeze(new Array<string | null>(tileCount).fill(null)),
    complete,
  });
}

function emitFilmstripChange() {
  [...filmstripListeners].forEach((listener) => listener());
}

/** Re-insert to mark the entry as most recently used. */
function touchCacheEntry(key: string) {
  const entry = filmstripCache.get(key);
  if (!entry) return null;
  filmstripCache.delete(key);
  filmstripCache.set(key, entry);
  return entry;
}

function evictFilmstrip(key: string) {
  filmstripCache.delete(key);
  const task = tasksByKey.get(key);
  if (!task) return;
  task.cancelled = true;
  tasksByKey.delete(key);
  const queuedIndex = taskQueue.indexOf(task);
  if (queuedIndex >= 0) taskQueue.splice(queuedIndex, 1);
}

function evictLeastRecentlyUsed() {
  while (filmstripCache.size > DIRECTOR_CLIP_FILMSTRIP_CACHE_LIMIT) {
    const oldestKey = filmstripCache.keys().next().value;
    if (oldestKey === undefined) return;
    evictFilmstrip(oldestKey);
  }
}

function publishFilmstrip(task: FilmstripTask, tiles: ReadonlyArray<string | null>, complete: boolean) {
  // An evicted (cancelled) task must not resurrect its cache entry.
  if (task.cancelled || !filmstripCache.has(task.key)) return;
  filmstripCache.set(task.key, Object.freeze({ key: task.key, tiles: Object.freeze([...tiles]), complete }));
  emitFilmstripChange();
}

type MediaWaitResult = "ok" | "timeout" | "error";

// Resolves with a status instead of rejecting so the sampling loop can treat
// timeouts (skip one tile) and media errors (abort the strip) differently
// without try/catch plumbing.
function waitForFilmstripEvent(
  video: HTMLVideoElement,
  successEvent: "loadeddata" | "seeked",
): Promise<MediaWaitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MediaWaitResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener(successEvent, onSuccess);
      video.removeEventListener("error", onError);
      resolve(result);
    };
    const onSuccess = () => finish("ok");
    const onError = () => finish("error");
    const timer = window.setTimeout(() => finish("timeout"), SEEK_TIMEOUT_MS);
    video.addEventListener(successEvent, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function seekFilmstripVideo(video: HTMLVideoElement, timeSec: number): Promise<MediaWaitResult> {
  // Seeking to the exact duration often yields a black frame; back off a tick.
  const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - 1 / 60) : timeSec;
  const target = clamp(timeSec, 0, maximum);
  if (Math.abs(video.currentTime - target) < 1 / 120 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return "ok";
  }
  const seeked = waitForFilmstripEvent(video, "seeked");
  video.currentTime = target;
  return seeked;
}

function captureFilmstripTile(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  tileWidth: number,
  tileHeight: number,
): string | null {
  try {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      // Cover crop: scale the source so it fills the tile, trimming overflow.
      const scale = Math.max(tileWidth / video.videoWidth, tileHeight / video.videoHeight);
      const sourceWidth = tileWidth / scale;
      const sourceHeight = tileHeight / scale;
      context.drawImage(
        video,
        (video.videoWidth - sourceWidth) / 2,
        (video.videoHeight - sourceHeight) / 2,
        sourceWidth,
        sourceHeight,
        0,
        0,
        tileWidth,
        tileHeight,
      );
    } else {
      // Dimensions unknown (metadata still pending): draw stretched rather
      // than dropping the tile; a slightly distorted thumb beats a hole.
      context.drawImage(video, 0, 0, tileWidth, tileHeight);
    }
    return canvas.toDataURL("image/jpeg", TILE_JPEG_QUALITY);
  } catch {
    // Tainted canvas (cross-origin source without CORS) or draw failure.
    return null;
  }
}

function releaseFilmstripVideo(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch {
    // jsdom stubs pause() as not-implemented; releasing src below still works.
  }
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    // Same jsdom caveat as pause(); the element is dropped either way.
  }
}

async function runFilmstripTask(task: FilmstripTask) {
  const { request } = task;
  const tiles: Array<string | null> = new Array<string | null>(request.tileCount).fill(null);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  try {
    const loaded = waitForFilmstripEvent(video, "loadeddata");
    video.src = request.sourceUrl;
    try {
      video.load();
    } catch {
      // jsdom's load() is not implemented; the loadeddata wait still governs.
    }
    const loadResult = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? ("ok" as const) : await loaded;
    if (task.cancelled) return;
    if (loadResult !== "ok") {
      // Undecodable or unreachable source: finish the strip with null tiles so
      // callers stop waiting instead of re-requesting forever.
      publishFilmstrip(task, tiles, true);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = request.tileWidth;
    canvas.height = request.tileHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      publishFilmstrip(task, tiles, true);
      return;
    }

    // Seek in ascending source time to avoid expensive backwards seeks; the
    // sort is a no-op for positive playback rates but keeps the invariant.
    const samples = Array.from({ length: request.tileCount }, (_, index) => ({
      index,
      timeSec: directorFilmstripTileTimeSec(request, index),
    })).sort((left, right) => left.timeSec - right.timeSec);

    for (const sample of samples) {
      const seekResult = await seekFilmstripVideo(video, sample.timeSec);
      if (task.cancelled) return;
      if (seekResult === "error") break;
      if (seekResult === "ok") {
        tiles[sample.index] = captureFilmstripTile(context, canvas, video, request.tileWidth, request.tileHeight);
      }
      // A timed-out seek leaves this tile null but the strip keeps going.
      publishFilmstrip(task, tiles, false);
    }
    publishFilmstrip(task, tiles, true);
  } finally {
    tasksByKey.delete(task.key);
    releaseFilmstripVideo(video);
  }
}

function pumpFilmstripQueue() {
  while (activeTaskCount < MAX_CONCURRENT_SAMPLERS && taskQueue.length > 0) {
    const task = taskQueue.shift();
    if (!task) return;
    activeTaskCount += 1;
    void runFilmstripTask(task).finally(() => {
      activeTaskCount -= 1;
      pumpFilmstripQueue();
    });
  }
}

/** Synchronous cache read; never schedules sampling. Reads refresh LRU order. */
export function getDirectorClipFilmstrip(request: DirectorClipFilmstripRequest): DirectorClipFilmstrip | null {
  return touchCacheEntry(filmstripKeyOf(normalizeFilmstripRequest(request)));
}

/**
 * Idempotently request sampling. Returns the current (possibly incomplete)
 * strip immediately; subscribers are notified as tiles land.
 */
export function requestDirectorClipFilmstrip(request: DirectorClipFilmstripRequest): DirectorClipFilmstrip {
  const normalized = normalizeFilmstripRequest(request);
  const key = filmstripKeyOf(normalized);
  if (typeof document === "undefined") {
    // SSR: no decode pipeline; hand back a settled all-null strip.
    return createStrip(key, normalized.tileCount, true);
  }
  const cached = touchCacheEntry(key);
  if (cached) return cached;

  const strip = createStrip(key, normalized.tileCount, false);
  filmstripCache.set(key, strip);
  evictLeastRecentlyUsed();
  const task: FilmstripTask = { key, request: normalized, cancelled: false };
  tasksByKey.set(key, task);
  taskQueue.push(task);
  pumpFilmstripQueue();
  // Wake subscribers so hooks that rendered before this entry existed re-read.
  emitFilmstripChange();
  return filmstripCache.get(key) ?? strip;
}

/** Notifies whenever any strip gains tiles, completes, or the cache resets. */
export function subscribeDirectorClipFilmstrips(listener: () => void) {
  filmstripListeners.add(listener);
  return () => {
    filmstripListeners.delete(listener);
  };
}

/**
 * Cancels every in-flight and queued sampling task, then clears the entire
 * filmstrip cache. All active subscribers are notified so they can re-request
 * strips on next render.
 */
export function clearDirectorClipFilmstripCache() {
  tasksByKey.forEach((task) => {
    task.cancelled = true;
  });
  tasksByKey.clear();
  taskQueue.length = 0;
  filmstripCache.clear();
  emitFilmstripChange();
}

/**
 * React bridge. Snapshots are referentially stable per key: the cache entry
 * object only changes when a new tile lands, so useSyncExternalStore never
 * loops. A null request renders nothing and subscribes to nothing meaningful.
 */
export function useDirectorClipFilmstrip(request: DirectorClipFilmstripRequest | null): DirectorClipFilmstrip | null {
  const key = request ? filmstripKeyOf(normalizeFilmstripRequest(request)) : null;
  const requestRef = useRef(request);
  requestRef.current = request;

  // Kick off (or dedupe into) sampling whenever the derived key changes; the
  // ref keeps per-render request object identity out of the dependency list.
  useEffect(() => {
    if (!key) return;
    const current = requestRef.current;
    if (current) requestDirectorClipFilmstrip(current);
  }, [key]);

  const getSnapshot = useCallback(() => {
    if (!key) return null;
    return touchCacheEntry(key);
  }, [key]);

  return useSyncExternalStore(subscribeDirectorClipFilmstrips, getSnapshot, getSnapshot);
}
