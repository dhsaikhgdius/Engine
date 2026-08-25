/*
 * Video export adaptation from Flier123/agentic-3d-director at
 * a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */
import { normalizeDirectorFps } from "../timeline/frameTime";

// The deterministic exporter is deliberately separate from the real-time
// MediaRecorder implementation below, but re-exported here so callers can
// choose the truthful mode through one public video module.
export {
  MAX_DIRECTOR_DETERMINISTIC_CAPTURE_BYTES,
  MAX_DIRECTOR_DETERMINISTIC_OUTPUT_FRAMES,
  MAX_DIRECTOR_DETERMINISTIC_RASTER_PIXELS,
  MAX_DIRECTOR_DETERMINISTIC_VIDEO_BYTES,
  downloadDirectorDeterministicExport,
  exportDeterministicDirectorFrames,
  getDirectorDeterministicFramePlan,
  inspectDirectorPng,
} from "./deterministicFrameExport";
export type {
  DirectorDeterministicExportProgress,
  DirectorDeterministicFrameExport,
  DirectorDeterministicFrameManifest,
  DirectorDeterministicFrameSample,
  DirectorDeterministicVideoMuxer,
  DirectorDeterministicWebCodecsOptions,
  DirectorMuxedVideoExport,
  DirectorPngSequenceExport,
  ExportDeterministicDirectorFramesOptions,
} from "./deterministicFrameExport";

export const DIRECTOR_VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
] as const;

/** The result of a completed video recording session. */
export interface DirectorVideoRecording {
  blob: Blob;
  thumbnailDataUrl: string;
  extension: "webm" | "mp4";
  mimeType: string;
  frameStart: number;
  frameEnd: number;
  frameCount: number;
  sourceFps: number;
  outputFps: number;
  durationSec: number;
  fallbackFrom?: "mp4";
}

/** Options for the staged IN/OUT video recording pipeline. */
export interface RecordDirectorVideoOptions {
  frameStart: number;
  frameEnd: number;
  fps: number;
  format?: "auto" | "webm" | "mp4";
  captureFrame: (frame: number) => Promise<string>;
  onProgress?: (progress: number, frame: number) => void;
  signal?: AbortSignal;
  audioSource?: DirectorVideoAudioSource;
}

/** An optional audio source that can be mixed into the video recording. */
export interface DirectorVideoAudioSource {
  stream: MediaStream;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
}

/** A live video recorder that can append frames, pause, resume, and stop. */
export interface LiveDirectorVideoRecorder {
  appendFrame: (dataUrl: string, frame: number) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<DirectorVideoRecording>;
}

/** Options for creating a live video recorder. */
export interface CreateLiveDirectorVideoRecorderOptions {
  fps: number;
  format?: "auto" | "webm" | "mp4";
}

type CaptureStreamCanvas = HTMLCanvasElement & {
  captureStream?: (frameRate?: number) => MediaStream;
};

type RequestFrameTrack = MediaStreamTrack & {
  requestFrame?: () => void;
};

function createDirectorVideoCaptureStream(canvas: CaptureStreamCanvas, outputFps: number) {
  const captureStream = canvas.captureStream;
  if (typeof captureStream !== "function") {
    throw new Error("当前浏览器不支持画布视频流");
  }

  // A zero-rate canvas stream only emits frames explicitly requested below.
  // Timed sampling can skip successive canvas paints, especially with native
  // MP4 MediaRecorder implementations, which drops animation and camera cuts.
  const manualStream = captureStream.call(canvas, 0);
  const manualTrack = manualStream.getVideoTracks()[0] as RequestFrameTrack | undefined;
  if (typeof manualTrack?.requestFrame === "function") {
    return { stream: manualStream, videoTrack: manualTrack };
  }

  manualStream.getTracks().forEach((track) => track.stop());
  const timedStream = captureStream.call(canvas, outputFps);
  return {
    stream: timedStream,
    videoTrack: timedStream.getVideoTracks()[0] as RequestFrameTrack | undefined,
  };
}

type DecodedFrame = CanvasImageSource & {
  width: number;
  height: number;
  close?: () => void;
};

/** A single frame sample in the video export plan, with its source frame and output timestamp. */
export interface DirectorVideoFrameSample {
  frame: number;
  timeSec: number;
}

export const MAX_DIRECTOR_VIDEO_OUTPUT_FRAMES = 7_200;
export const MAX_DIRECTOR_VIDEO_BYTES = 512 * 1024 * 1024;
// The browser encoder needs the source frames available before starting its
// real-time MediaRecorder pass.  Bound that staging area independently from
// the final encoded blob so a long/high-resolution clip fails clearly instead
// of exhausting the Director tab while collecting PNGs.
export const MAX_DIRECTOR_VIDEO_CAPTURE_BYTES = 256 * 1024 * 1024;

/**
 * Add frame bytes to the capture budget, throwing if the total exceeds
 * the page-session safety limit.
 *
 * @param currentBytes - Current accumulated capture bytes.
 * @param frameBytes - Bytes for the new frame.
 * @param maximumBytes - The safety limit (defaults to MAX_DIRECTOR_VIDEO_CAPTURE_BYTES).
 * @returns The new accumulated total.
 */
export function addDirectorVideoCaptureBytes(
  currentBytes: number,
  frameBytes: number,
  maximumBytes = MAX_DIRECTOR_VIDEO_CAPTURE_BYTES,
) {
  const totalBytes = currentBytes + frameBytes;
  if (
    !Number.isSafeInteger(currentBytes) ||
    currentBytes < 0 ||
    !Number.isSafeInteger(frameBytes) ||
    frameBytes < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0
  ) {
    throw new Error("视频预捕获大小无效");
  }
  if (totalBytes > maximumBytes) {
    throw new Error("视频预捕获超过 256 MiB 的页面会话安全上限，请缩短 IN/OUT 区间或减小视口");
  }
  return totalBytes;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Video export aborted", "AbortError");
}

function waitForFrameDuration(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Video export aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function startDirectorMediaRecorder(recorder: MediaRecorder, timeslice: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      recorder.removeEventListener("start", started);
      recorder.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const started = () => finish(resolve);
    const failed = () => finish(() => reject(new Error("视频录制失败")));
    const aborted = () => finish(() => reject(new DOMException("Video export aborted", "AbortError")));

    recorder.addEventListener("start", started, { once: true });
    recorder.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }

    try {
      recorder.start(timeslice);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function drawDirectorVideoFrame(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
) {
  // Every decoded viewport PNG already covers the complete output raster. A
  // separate clear creates a real black intermediate canvas that timed canvas
  // streams are allowed to sample, so replace the full bitmap atomically.
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
}

async function presentDirectorVideoFrame({
  canvas,
  context,
  image,
  signal,
  videoTrack,
}: {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  image: CanvasImageSource;
  signal?: AbortSignal;
  videoTrack?: RequestFrameTrack;
}) {
  throwIfAborted(signal);
  // Chromium's manual canvas track snapshots the canvas that already exists
  // when requestFrame() is called. Requesting first captures the previous
  // bitmap (the initial empty stage for an entire take in practice), so commit
  // the complete decoded viewport image before asking the encoder for it.
  drawDirectorVideoFrame(context, canvas, image);
  videoTrack?.requestFrame?.();
  // Yield one task so the canvas paint/capture algorithm can commit this bitmap
  // before the next frame replaces it or the recorder is stopped.
  await waitForFrameDuration(0, signal);
}

async function decodeBlob(blob: Blob): Promise<DecodedFrame> {
  if (typeof createImageBitmap === "function") {
    return (await createImageBitmap(blob)) as DecodedFrame;
  }

  return await new Promise<DecodedFrame>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.addEventListener(
      "load",
      () => {
        URL.revokeObjectURL(url);
        resolve(image as DecodedFrame);
      },
      { once: true },
    );
    image.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        reject(new Error("无法解码视口 PNG 帧"));
      },
      { once: true },
    );
    image.src = url;
  });
}

/**
 * Select the best available video MIME type for the requested format,
 * falling back through the candidate list in priority order.
 *
 * @param format - The desired container format ("auto", "webm", or "mp4").
 * @param isTypeSupported - Optional override for MediaRecorder.isTypeSupported.
 * @returns The best available MIME type string, or empty if none.
 */
export function selectDirectorVideoMimeType(
  format: "auto" | "webm" | "mp4" = "auto",
  isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
) {
  return (
    DIRECTOR_VIDEO_MIME_CANDIDATES.find(
      (mimeType) => (format === "auto" || mimeType.startsWith(`video/${format}`)) && isTypeSupported(mimeType),
    ) ?? ""
  );
}

/**
 * Resolve the MIME type and fallback for video recording, attempting
 * the requested format first and falling back to WebM when MP4 is
 * unavailable.
 *
 * @param format - The desired container format.
 * @param isTypeSupported - Optional override for MediaRecorder.isTypeSupported.
 * @returns The resolved MIME type and an optional fallback indicator.
 */
export function resolveDirectorVideoMimeSelection(
  format: "auto" | "webm" | "mp4",
  isTypeSupported?: (mimeType: string) => boolean,
) {
  const requestedMimeType = selectDirectorVideoMimeType(format, isTypeSupported);
  const fallbackMimeType =
    format === "mp4" && !requestedMimeType ? selectDirectorVideoMimeType("webm", isTypeSupported) : "";
  return {
    mimeType: requestedMimeType || fallbackMimeType,
    fallbackFrom: fallbackMimeType ? ("mp4" as const) : undefined,
  };
}

/** Keeps the first valid PNG as a lossless fallback when pixel readback fails. */
export function selectDirectorVideoThumbnailDataUrl(current: string, candidate: string) {
  if (!candidate.startsWith("data:image/png")) return current;
  return current || candidate;
}

/**
 * Measures visual information in a tiny RGBA raster. The score deliberately
 * combines global contrast, colour separation and local edges: a flat black or
 * empty stage scores low, while a framed character/prop scores higher. It is a
 * thumbnail heuristic only and never rejects or changes recorded video frames.
 */
export function scoreDirectorVideoThumbnailPixels(pixels: Uint8ClampedArray, width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    pixels.length < width * height * 4
  ) {
    return 0;
  }

  const luminance = new Float32Array(width * height);
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let chromaSum = 0;
  let edgeSum = 0;
  let edgeCount = 0;

  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    const alpha = pixels[offset + 3] / 255;
    const red = pixels[offset] * alpha;
    const green = pixels[offset + 1] * alpha;
    const blue = pixels[offset + 2] * alpha;
    const value = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminance[index] = value;
    luminanceSum += value;
    luminanceSquaredSum += value * value;
    chromaSum += Math.max(red, green, blue) - Math.min(red, green, blue);

    const x = index % width;
    if (x > 0) {
      edgeSum += Math.abs(value - luminance[index - 1]);
      edgeCount += 1;
    }
    if (index >= width) {
      edgeSum += Math.abs(value - luminance[index - width]);
      edgeCount += 1;
    }
  }

  const pixelCount = luminance.length;
  const mean = luminanceSum / pixelCount;
  const variance = Math.max(0, luminanceSquaredSum / pixelCount - mean * mean);
  const contrast = Math.sqrt(variance);
  const chroma = chromaSum / pixelCount;
  const edges = edgeCount > 0 ? edgeSum / edgeCount : 0;
  return contrast * 0.45 + chroma * 0.4 + edges * 0.15;
}

const DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_WIDTH = 48;
const DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_HEIGHT = 27;
const DIRECTOR_VIDEO_THUMBNAIL_MAX_WIDTH = 320;
const DIRECTOR_VIDEO_THUMBNAIL_MAX_HEIGHT = 180;

function createDirectorVideoThumbnailSelector() {
  let fallbackDataUrl = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  let thumbnailCanvas: HTMLCanvasElement | null = null;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_WIDTH;
  sampleCanvas.height = DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_HEIGHT;
  const sampleContext = sampleCanvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  const canReadPixels = typeof sampleContext?.getImageData === "function";

  function considerFallback(dataUrl: string) {
    fallbackDataUrl = selectDirectorVideoThumbnailDataUrl(fallbackDataUrl, dataUrl);
  }

  function consider(image: DecodedFrame, dataUrl = "") {
    considerFallback(dataUrl);
    if (!sampleContext || !canReadPixels) return;
    try {
      sampleContext.drawImage(
        image,
        0,
        0,
        DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_WIDTH,
        DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_HEIGHT,
      );
      const sample = sampleContext.getImageData(
        0,
        0,
        DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_WIDTH,
        DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_HEIGHT,
      );
      const score = scoreDirectorVideoThumbnailPixels(
        sample.data,
        DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_WIDTH,
        DIRECTOR_VIDEO_THUMBNAIL_SAMPLE_HEIGHT,
      );
      if (score <= bestScore) return;

      bestScore = score;
      thumbnailCanvas ??= document.createElement("canvas");
      const scale = Math.min(
        1,
        DIRECTOR_VIDEO_THUMBNAIL_MAX_WIDTH / Math.max(1, image.width),
        DIRECTOR_VIDEO_THUMBNAIL_MAX_HEIGHT / Math.max(1, image.height),
      );
      thumbnailCanvas.width = Math.max(1, Math.round(image.width * scale));
      thumbnailCanvas.height = Math.max(1, Math.round(image.height * scale));
      const thumbnailContext = thumbnailCanvas.getContext("2d", { alpha: false });
      if (!thumbnailContext) {
        thumbnailCanvas = null;
        return;
      }
      thumbnailContext.drawImage(image, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height);
    } catch {
      // Security-restricted/tainted canvases cannot expose pixels. The first
      // original PNG remains a valid thumbnail fallback in that environment.
    }
  }

  function getDataUrl() {
    if (!thumbnailCanvas) return fallbackDataUrl;
    try {
      return thumbnailCanvas.toDataURL("image/png") || fallbackDataUrl;
    } catch {
      return fallbackDataUrl;
    }
  }

  return { consider, considerFallback, getDataUrl };
}

/**
 * Build the frame-sampling plan for a video export, mapping source frames
 * to output timestamps at the target output frame rate.
 *
 * @param frameStart - The inclusive start frame.
 * @param frameEnd - The inclusive end frame.
 * @param sourceFps - The source timeline frame rate.
 * @param requestedOutputFps - The desired output frame rate (capped at 60).
 * @returns An array of frame samples with timestamps.
 */
export function getDirectorVideoFrameSamples(
  frameStart: number,
  frameEnd: number,
  sourceFps: number,
  requestedOutputFps = Math.min(sourceFps, 60),
): DirectorVideoFrameSample[] {
  const start = Math.max(0, Math.round(Math.min(frameStart, frameEnd)));
  const end = Math.max(start, Math.round(Math.max(frameStart, frameEnd)));
  const normalizedSourceFps = normalizeDirectorFps(sourceFps);
  const outputFps = Math.min(normalizedSourceFps, 60, normalizeDirectorFps(requestedOutputFps));
  const durationSec = (end - start) / normalizedSourceFps;
  if (durationSec === 0) return [{ frame: start, timeSec: 0 }];

  const samples: DirectorVideoFrameSample[] = [];
  for (let outputIndex = 0; ; outputIndex += 1) {
    const timeSec = outputIndex / outputFps;
    if (timeSec >= durationSec) break;
    const frame = Math.min(end, Math.round(start + timeSec * normalizedSourceFps));
    if (samples[samples.length - 1]?.frame !== frame) samples.push({ frame, timeSec });
  }
  if (samples[samples.length - 1]?.frame === end) {
    samples[samples.length - 1] = { frame: end, timeSec: durationSec };
  } else {
    samples.push({ frame: end, timeSec: durationSec });
  }
  return samples;
}

/**
 * Build a flat list of source frame numbers for the video export,
 * derived from the frame-sampling plan.
 *
 * @param frameStart - The inclusive start frame.
 * @param frameEnd - The inclusive end frame.
 * @param sourceFps - The source timeline frame rate.
 * @param outputFps - The desired output frame rate.
 * @returns An array of source frame numbers.
 */
export function getDirectorVideoFrameSequence(
  frameStart: number,
  frameEnd: number,
  sourceFps = 60,
  outputFps = Math.min(sourceFps, 60),
) {
  return getDirectorVideoFrameSamples(frameStart, frameEnd, sourceFps, outputFps).map((sample) => sample.frame);
}

/**
 * Compute the total video duration in seconds for a frame range.
 *
 * @param frameStart - The inclusive start frame.
 * @param frameEnd - The inclusive end frame.
 * @param sourceFps - The source timeline frame rate.
 * @returns The duration in seconds.
 */
export function getDirectorVideoDurationSec(frameStart: number, frameEnd: number, sourceFps: number) {
  const start = Math.max(0, Math.round(Math.min(frameStart, frameEnd)));
  const end = Math.max(start, Math.round(Math.max(frameStart, frameEnd)));
  return (end - start + 1) / normalizeDirectorFps(sourceFps);
}

/**
 * Compute the hold duration for the final frame of a video export,
 * ensuring the encoder captures the inclusive OUT frame.
 *
 * @param outputFps - The output frame rate.
 * @returns Hold duration in milliseconds (at least 1ms).
 */
export function getDirectorVideoFinalFrameHoldMs(outputFps: number) {
  return Math.max(1, Math.ceil(1000 / normalizeDirectorFps(outputFps)));
}

/**
 * Records viewport frames as they arrive from the timeline transport. Unlike
 * the staged IN/OUT MediaRecorder path below, this recorder deliberately keeps
 * one browser session open so a director can pause and continue a take without
 * stitching together multiple clips. Neither MediaRecorder path is presented
 * as deterministic; use exportDeterministicDirectorFrames for offline output.
 */
export function createLiveDirectorVideoRecorder({
  fps,
  format = "auto",
}: CreateLiveDirectorVideoRecorderOptions): LiveDirectorVideoRecorder {
  const sourceFps = normalizeDirectorFps(fps);
  const outputFps = Math.min(60, sourceFps);
  const { mimeType, fallbackFrom } = resolveDirectorVideoMimeSelection(format);
  const canvas = document.createElement("canvas") as CaptureStreamCanvas;
  const captureStream = canvas.captureStream;
  if (typeof MediaRecorder === "undefined" || typeof captureStream !== "function") {
    throw new Error("当前浏览器不支持 WebM/MP4 录制，请使用最新版 Chrome、Edge 或 Safari");
  }
  if (format !== "auto" && !mimeType) {
    throw new Error(`${format.toUpperCase()} 编码不可用，且没有安全的浏览器编码降级路径`);
  }

  let state: "recording" | "paused" | "stopping" | "stopped" = "recording";
  let stream: MediaStream | null = null;
  let videoTrack: RequestFrameTrack | undefined;
  let recorder: MediaRecorder | null = null;
  let stopped: Promise<Blob> | null = null;
  let context: CanvasRenderingContext2D | null = null;
  const thumbnailSelector = createDirectorVideoThumbnailSelector();
  let frameStart: number | null = null;
  let frameEnd: number | null = null;
  let frameCount = 0;
  let queue = Promise.resolve();

  let lastFrameDataUrl = "";

  async function initialize(image: DecodedFrame) {
    canvas.width = Math.max(1, image.width);
    canvas.height = Math.max(1, image.height);
    context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建视频编码画布");
    // Seed the canvas before captureStream() so the track can never originate
    // from the default transparent/black backing store.
    drawDirectorVideoFrame(context, canvas, image);
    const capture = createDirectorVideoCaptureStream(canvas, outputFps);
    stream = capture.stream;
    videoTrack = capture.videoTrack;
    const chunks: BlobPart[] = [];
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : { videoBitsPerSecond: 8_000_000 },
      );
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      throw error;
    }
    stopped = new Promise<Blob>((resolve, reject) => {
      recorder!.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder!.addEventListener("error", () => reject(new Error("视频录制失败")), { once: true });
      recorder!.addEventListener(
        "stop",
        () => {
          resolve(new Blob(chunks, { type: recorder!.mimeType || mimeType || "video/webm" }));
        },
        { once: true },
      );
    });
    await startDirectorMediaRecorder(recorder, Math.max(100, Math.round(1000 / outputFps) * 4));
    if (state === "paused") recorder.pause();
  }

  function appendFrame(dataUrl: string, frame: number) {
    if (state !== "recording") return Promise.resolve();
    if (!Number.isSafeInteger(frame) || frame < 0) {
      return Promise.reject(new Error("实时记录需要非负整数帧"));
    }
    queue = queue.then(async () => {
      const image = await decodeBlob(await (await fetch(dataUrl)).blob());
      try {
        if (!context) await initialize(image);
        await presentDirectorVideoFrame({ canvas, context: context!, image, videoTrack });
        thumbnailSelector.consider(image, dataUrl);
      } finally {
        image.close?.();
      }
      frameStart ??= frame;
      frameEnd = frame;
      frameCount += 1;
      lastFrameDataUrl = dataUrl;
    });
    return queue;
  }

  function pause() {
    if (state !== "recording") return;
    state = "paused";
    if (recorder?.state === "recording") recorder.pause();
  }

  function resume() {
    if (state !== "paused") return;
    state = "recording";
    if (recorder?.state === "paused") recorder.resume();
  }

  async function stop(): Promise<DirectorVideoRecording> {
    if (state === "stopped") throw new Error("此记录会话已经结束");
    state = "stopping";
    await queue;
    if (!recorder || !stopped || frameStart === null || frameEnd === null || frameCount === 0) {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      state = "stopped";
      throw new Error("记录尚未获得可写入的视频帧");
    }
    try {
      if (recorder.state === "paused") recorder.resume();
      // Repaint and explicitly request the terminal bitmap. Merely sleeping
      // after the previous request does not guarantee that the inclusive OUT
      // frame reached a manual canvas track.
      const finalImage = await decodeBlob(await (await fetch(lastFrameDataUrl)).blob());
      try {
        await presentDirectorVideoFrame({ canvas, context: context!, image: finalImage, videoTrack });
      } finally {
        finalImage.close?.();
      }
      await waitForFrameDuration(getDirectorVideoFinalFrameHoldMs(outputFps));
      if (recorder.state === "recording") recorder.requestData();
      if (recorder.state !== "inactive") recorder.stop();
      const blob = await stopped;
      if (blob.size === 0) throw new Error("浏览器没有生成有效的视频数据");
      if (blob.size > MAX_DIRECTOR_VIDEO_BYTES) {
        throw new Error("渲染视频超过 512 MiB 的页面会话安全上限");
      }
      const resolvedMimeType = blob.type || recorder.mimeType || mimeType || "video/webm";
      return {
        blob,
        thumbnailDataUrl: thumbnailSelector.getDataUrl(),
        extension: resolvedMimeType.startsWith("video/mp4") ? "mp4" : "webm",
        mimeType: resolvedMimeType,
        frameStart,
        frameEnd,
        frameCount,
        sourceFps,
        outputFps,
        durationSec: getDirectorVideoDurationSec(frameStart, frameEnd, sourceFps),
        ...(fallbackFrom ? { fallbackFrom } : {}),
      };
    } catch (error) {
      if (recorder.state !== "inactive") recorder.stop();
      throw error;
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      state = "stopped";
    }
  }

  return { appendFrame, pause, resume, stop };
}

/**
 * Stage an IN-to-OUT video recording: capture all frames, decode them,
 * and feed them through a MediaRecorder at the target output frame rate.
 * This is the two-pass pipeline suitable for timeline IN/OUT exports.
 *
 * @param options - Frame range, FPS, capture callback, and optional audio.
 * @returns The completed video recording with blob, thumbnail, and metadata.
 */
export async function recordDirectorVideo({
  frameStart,
  frameEnd,
  fps,
  format = "auto",
  captureFrame,
  onProgress,
  signal,
  audioSource,
}: RecordDirectorVideoOptions): Promise<DirectorVideoRecording> {
  const sourceFps = normalizeDirectorFps(fps);
  const outputFps = Math.min(60, sourceFps);
  const samples = getDirectorVideoFrameSamples(frameStart, frameEnd, sourceFps, outputFps);
  if (samples.length > MAX_DIRECTOR_VIDEO_OUTPUT_FRAMES) {
    throw new Error(`视频导出超过 ${MAX_DIRECTOR_VIDEO_OUTPUT_FRAMES} 个输出帧的安全上限`);
  }
  const durationSec = getDirectorVideoDurationSec(samples[0].frame, samples[samples.length - 1].frame, sourceFps);
  const { mimeType, fallbackFrom } = resolveDirectorVideoMimeSelection(format);
  const canvas = document.createElement("canvas") as CaptureStreamCanvas;
  const captureStream = canvas.captureStream;
  if (typeof MediaRecorder === "undefined" || typeof captureStream !== "function") {
    throw new Error("当前浏览器不支持 WebM/MP4 录制，请使用最新版 Chrome、Edge 或 Safari");
  }
  if (format !== "auto" && !mimeType) {
    throw new Error(`${format.toUpperCase()} 编码不可用，且没有安全的浏览器编码降级路径`);
  }

  const capturedFrames: Blob[] = [];
  let capturedBytes = 0;
  const thumbnailSelector = createDirectorVideoThumbnailSelector();
  for (let index = 0; index < samples.length; index += 1) {
    throwIfAborted(signal);
    const dataUrl = await captureFrame(samples[index].frame);
    throwIfAborted(signal);
    thumbnailSelector.considerFallback(dataUrl);
    const capturedFrame = await (await fetch(dataUrl)).blob();
    capturedBytes = addDirectorVideoCaptureBytes(capturedBytes, capturedFrame.size);
    capturedFrames.push(capturedFrame);
    onProgress?.(((index + 1) / samples.length) * 0.8, samples[index].frame);
  }

  const firstImage = await decodeBlob(capturedFrames[0]);
  capturedFrames[0] = new Blob();
  canvas.width = Math.max(1, firstImage.width);
  canvas.height = Math.max(1, firstImage.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    firstImage.close?.();
    throw new Error("无法创建视频编码画布");
  }
  // A canvas capture track snapshots its existing backing store. Seed it with
  // the first real frame before creating the stream instead of starting from
  // an empty alpha-false canvas, which browsers expose as black.
  drawDirectorVideoFrame(context, canvas, firstImage);
  const { stream, videoTrack } = createDirectorVideoCaptureStream(canvas, outputFps);
  audioSource?.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  const chunks: BlobPart[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : { videoBitsPerSecond: 8_000_000 },
    );
  } catch (error) {
    firstImage.close?.();
    stream.getTracks().forEach((track) => track.stop());
    await audioSource?.stop();
    throw error;
  }

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => reject(new Error("视频录制失败")), { once: true });
    recorder.addEventListener(
      "stop",
      () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" }));
      },
      { once: true },
    );
  });

  const openImages = new Set<DecodedFrame>([firstImage]);
  try {
    await startDirectorMediaRecorder(recorder, Math.max(100, Math.round(1000 / outputFps) * 4), signal);
    await audioSource?.start();
    const startedAt = performance.now();
    let finalImage: DecodedFrame | undefined;
    for (let index = 0; index < samples.length; index += 1) {
      throwIfAborted(signal);
      const sample = samples[index];
      const image = index === 0 ? firstImage : await decodeBlob(capturedFrames[index]);
      openImages.add(image);
      capturedFrames[index] = new Blob();
      try {
        thumbnailSelector.consider(image);
        const delay = startedAt + sample.timeSec * 1000 - performance.now();
        if (delay > 0) await waitForFrameDuration(delay, signal);
        await presentDirectorVideoFrame({ canvas, context, image, signal, videoTrack });
      } finally {
        if (index === samples.length - 1) {
          finalImage = image;
        } else {
          image.close?.();
          openImages.delete(image);
        }
      }
      onProgress?.(0.8 + ((index + 1) / samples.length) * 0.2, sample.frame);
    }
    if (!finalImage) throw new Error("视频导出没有可提交的末帧");
    await presentDirectorVideoFrame({ canvas, context, image: finalImage, signal, videoTrack });
    // Keep the inclusive OUT frame on the capture stream for one encoder
    // interval. Stopping immediately after requestFrame drops that terminal
    // camera/object state in Chromium MediaRecorder (the upstream bug produced
    // 23 decoded frames for F1-F24 at 24 FPS).
    await waitForFrameDuration(getDirectorVideoFinalFrameHoldMs(outputFps), signal);
    if (recorder.state === "recording") recorder.requestData();
    recorder.stop();
    const blob = await stopped;
    if (blob.size === 0) throw new Error("浏览器没有生成有效的视频数据");
    if (blob.size > MAX_DIRECTOR_VIDEO_BYTES) {
      throw new Error("渲染视频超过 512 MiB 的页面会话安全上限");
    }
    const resolvedMimeType = blob.type || recorder.mimeType || mimeType || "video/webm";
    return {
      blob,
      thumbnailDataUrl: thumbnailSelector.getDataUrl(),
      extension: resolvedMimeType.startsWith("video/mp4") ? "mp4" : "webm",
      mimeType: resolvedMimeType,
      frameStart: samples[0].frame,
      frameEnd: samples[samples.length - 1].frame,
      frameCount: samples.length,
      sourceFps,
      outputFps,
      durationSec,
      ...(fallbackFrom ? { fallbackFrom } : {}),
    };
  } catch (error) {
    if (recorder.state !== "inactive") recorder.stop();
    throw error;
  } finally {
    openImages.forEach((image) => image.close?.());
    stream.getTracks().forEach((track) => track.stop());
    await audioSource?.stop();
  }
}

/**
 * Trigger a browser download for a completed video recording.
 *
 * @param recording - The completed video recording.
 * @param baseName - The base file name for the download.
 */
export function downloadDirectorVideo(recording: DirectorVideoRecording, baseName = "director-timeline") {
  const url = URL.createObjectURL(recording.blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `${baseName}-${recording.frameStart}-${recording.frameEnd}-${timestamp}.${recording.extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
