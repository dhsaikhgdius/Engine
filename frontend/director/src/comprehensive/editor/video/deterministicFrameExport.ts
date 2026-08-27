/**
 * Deterministic frame-sequence export from the Stage timeline: plans an exact
 * microsecond-timestamped sampling of source frames, captures each as PNG via
 * the viewport capture bridge, and packages the result either as a
 * reproducible ZIP (deterministicZip.ts, stable ordering and timestamps, so
 * the same project state yields byte-identical archives and sha256
 * fingerprints) or as a WebCodecs-muxed MP4/WebM. Size guards cap frame count,
 * raster dimensions, and total bytes so a misconfigured export cannot exhaust
 * browser memory. Consumed by the video editor's export flow and by agent
 * deliverable jobs, which rely on the manifest hashes for provenance.
 */
import { errorMessage } from "../../../../../../packages/protocol/src/primitives";
import { normalizeDirectorFps } from "../timeline/frameTime";
import type { DirectorCaptureBackgroundMode } from "../render/renderPassCapture";
import { stableArtifactStringify } from "../shot/shotPackage";
import { createDeterministicZipArchive } from "./deterministicZip";

export const MAX_DIRECTOR_DETERMINISTIC_OUTPUT_FRAMES = 7_200;
export const MAX_DIRECTOR_DETERMINISTIC_CAPTURE_BYTES = 256 * 1024 * 1024;
export const MAX_DIRECTOR_DETERMINISTIC_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_DIRECTOR_DETERMINISTIC_RASTER_PIXELS = 33_554_432;
const MAX_DIRECTOR_DETERMINISTIC_RASTER = 16_384;
const PNG_MIME_TYPE = "image/png" as const;
const ZIP_MIME_TYPE = "application/zip" as const;
const MICROSECONDS_PER_SECOND = 1_000_000;
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** A single sampled frame in the deterministic export plan. */
export interface DirectorDeterministicFrameSample {
  outputIndex: number;
  sourceFrame: number;
  timestampUs: number;
  durationUs: number;
}

/** A captured PNG frame with its metadata, path, and content hash. */
export interface DirectorDeterministicFrameArtifact extends DirectorDeterministicFrameSample {
  path: string;
  mimeType: typeof PNG_MIME_TYPE;
  byteLength: number;
  sha256: `sha256:${string}`;
}

export interface DirectorDeterministicFrameManifest {
  schemaVersion: 1;
  kind: "director-deterministic-frame-sequence";
  timebase: "microseconds";
  sampling: "nearest-endpoint-inclusive";
  sourceFrameStart: number;
  sourceFrameEnd: number;
  sourceFps: number;
  outputFps: number;
  outputFrameCount: number;
  durationUs: number;
  width: number;
  height: number;
  /**
   * Beauty background mode of the captured frames. Recorded as "transparent"
   * for alpha (绿幕/合成用) packages; omitted for the composited default so
   * pre-alpha packages stay byte-identical, fingerprint included.
   */
  background?: DirectorCaptureBackgroundMode;
  frames: DirectorDeterministicFrameArtifact[];
  packageFingerprint: `sha256:${string}`;
}

/** Progress callback payload for the deterministic export pipeline. */
export interface DirectorDeterministicExportProgress {
  phase: "capture" | "encode" | "package";
  completed: number;
  total: number;
  progress: number;
  sample?: DirectorDeterministicFrameSample;
}

export type DirectorPngFrameSource = string | Blob | Uint8Array | ArrayBuffer;

/** A single encoded video chunk produced by the WebCodecs encoder. */
export interface DirectorMuxedVideoChunk {
  type: EncodedVideoChunkType;
  timestampUs: number;
  durationUs: number;
  bytes: Uint8Array;
  decoderConfig?: DirectorMuxedVideoDecoderConfig;
}

/** Decoder configuration carried alongside a muxed video chunk. */
export interface DirectorMuxedVideoDecoderConfig {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  displayAspectWidth?: number;
  displayAspectHeight?: number;
  colorSpace?: VideoColorSpaceInit;
  hardwareAcceleration?: HardwareAcceleration;
  optimizeForLatency?: boolean;
  description?: Uint8Array;
}

export interface DirectorDeterministicVideoMuxer {
  /** Must describe a real, self-contained playable container. */
  container: "mp4" | "webm";
  mimeType: "video/mp4" | "video/webm";
  extension: "mp4" | "webm";
  addVideoChunk: (chunk: DirectorMuxedVideoChunk) => void | Promise<void>;
  finalize: () => Blob | Uint8Array | Promise<Blob | Uint8Array>;
  abort?: (reason?: unknown) => void;
}

/** A simplified WebCodecs VideoEncoder interface for testability and DI. */
export interface DirectorWebCodecsEncoderLike {
  readonly encodeQueueSize: number;
  configure: (config: VideoEncoderConfig) => void;
  encode: (frame: VideoFrame, options?: VideoEncoderEncodeOptions) => void;
  flush: () => Promise<void>;
  reset: () => void;
  close: () => void;
}

/** A simplified WebCodecs runtime for testability and dependency injection. */
export interface DirectorWebCodecsRuntime {
  isConfigSupported: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;
  createEncoder: (init: VideoEncoderInit) => DirectorWebCodecsEncoderLike;
  decodePng: (bytes: Uint8Array) => Promise<CanvasImageSource & { close?: () => void }>;
  createVideoFrame: (source: CanvasImageSource, init: VideoFrameInit) => VideoFrame;
}

export interface DirectorDeterministicWebCodecsOptions {
  codec?: string;
  bitrate?: number;
  keyFrameInterval?: number;
  maxEncodeQueueSize?: number;
  runtime?: DirectorWebCodecsRuntime;
  createMuxer: (configuration: {
    encoderConfig: VideoEncoderConfig;
    width: number;
    height: number;
    fps: number;
    frameCount: number;
  }) => DirectorDeterministicVideoMuxer | Promise<DirectorDeterministicVideoMuxer>;
}

export interface ExportDeterministicDirectorFramesOptions {
  frameStart: number;
  frameEnd: number;
  sourceFps: number;
  outputFps?: number;
  captureFrame: (
    sourceFrame: number,
    sample: Readonly<DirectorDeterministicFrameSample>,
    signal?: AbortSignal,
  ) => Promise<DirectorPngFrameSource>;
  onProgress?: (progress: DirectorDeterministicExportProgress) => void;
  signal?: AbortSignal;
  maxFrames?: number;
  maxCaptureBytes?: number;
  maxEncodedBytes?: number;
  maxRasterPixels?: number;
  /**
   * Beauty background mode of the frames `captureFrame` returns; recorded in
   * the manifest. "transparent" additionally requires WebCodecs muxing (when
   * configured) to genuinely keep alpha — a VP9 `alpha: "keep"` WebM — and
   * otherwise falls back to the RGBA PNG package. Defaults to "composited".
   */
  background?: DirectorCaptureBackgroundMode;
  webCodecs?: DirectorDeterministicWebCodecsOptions;
}

interface CapturedPngFrame {
  sample: DirectorDeterministicFrameSample;
  path: string;
  bytes: Uint8Array;
  sha256: `sha256:${string}`;
  width: number;
  height: number;
}

/** The PNG-sequence ZIP archive result from a deterministic export. */
export interface DirectorPngSequenceExport {
  kind: "png-sequence";
  mimeType: typeof ZIP_MIME_TYPE;
  extension: "zip";
  fileName: string;
  archive: Blob;
  manifest: DirectorDeterministicFrameManifest;
  files: Array<{ path: string; mimeType: typeof PNG_MIME_TYPE; bytes: Uint8Array }>;
  fallbackReason?: string;
}

/** The WebCodecs-muxed video result from a deterministic export. */
export interface DirectorMuxedVideoExport {
  kind: "video";
  timing: "explicit-webcodecs-timestamps";
  container: "mp4" | "webm";
  mimeType: "video/mp4" | "video/webm";
  extension: "mp4" | "webm";
  blob: Blob;
  manifest: DirectorDeterministicFrameManifest;
}

export type DirectorDeterministicFrameExport = DirectorPngSequenceExport | DirectorMuxedVideoExport;

function assertFrame(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
}

function normalizeStrictFps(value: number, label: string): number {
  const normalized = normalizeDirectorFps(value);
  if (!Number.isInteger(value) || value !== normalized) {
    throw new Error(`${label} must be an integer between 1 and 240.`);
  }
  return normalized;
}

function normalizeBoundedLimit(value: number | undefined, maximum: number, label: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return resolved;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Deterministic frame export aborted", "AbortError");
}

/**
 * Builds a constant-output-rate plan. Every entry is captured independently,
 * including repeated source frames required when the output rate is higher
 * than the authored timeline rate. IN and OUT are both always represented.
 */
export function getDirectorDeterministicFramePlan(
  frameStart: number,
  frameEnd: number,
  sourceFps: number,
  outputFps = sourceFps,
): DirectorDeterministicFrameSample[] {
  assertFrame(frameStart, "frameStart");
  assertFrame(frameEnd, "frameEnd");
  if (frameEnd < frameStart) throw new Error("frameEnd cannot be before frameStart.");
  const normalizedSourceFps = normalizeStrictFps(sourceFps, "sourceFps");
  const normalizedOutputFps = normalizeStrictFps(outputFps, "outputFps");
  const sourceFrameCount = frameEnd - frameStart + 1;
  if (!Number.isSafeInteger(sourceFrameCount)) throw new Error("Deterministic source frame count is not safe.");
  const outputFrameCount = Math.max(1, Math.round((sourceFrameCount * normalizedOutputFps) / normalizedSourceFps));
  if (!Number.isSafeInteger(outputFrameCount) || outputFrameCount > MAX_DIRECTOR_DETERMINISTIC_OUTPUT_FRAMES) {
    throw new Error(
      `Deterministic export requires ${outputFrameCount} frames, above the ${MAX_DIRECTOR_DETERMINISTIC_OUTPUT_FRAMES}-frame hard limit.`,
    );
  }

  return Array.from({ length: outputFrameCount }, (_, outputIndex) => {
    const timestampUs = Math.round((outputIndex * MICROSECONDS_PER_SECOND) / normalizedOutputFps);
    const nextTimestampUs = Math.round(((outputIndex + 1) * MICROSECONDS_PER_SECOND) / normalizedOutputFps);
    const sourceFrame =
      outputFrameCount === 1
        ? frameStart
        : outputIndex === outputFrameCount - 1
          ? frameEnd
          : frameStart + Math.round((outputIndex * (frameEnd - frameStart)) / (outputFrameCount - 1));
    return {
      outputIndex,
      sourceFrame,
      timestampUs,
      durationUs: nextTimestampUs - timestampUs,
    };
  });
}

function readPngDimension(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

/**
 * Inspect a PNG byte array and return its raster dimensions.
 * Validates the PNG signature and IHDR header.
 *
 * @param bytes - The raw PNG bytes.
 * @returns The width and height of the PNG image.
 * @throws If the bytes are not a valid PNG or exceed size limits.
 */
export function inspectDirectorPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Deterministic export capture must return a real PNG frame.");
  }
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
    throw new Error("Deterministic export PNG is missing its IHDR header.");
  }
  const width = readPngDimension(bytes, 16);
  const height = readPngDimension(bytes, 20);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIRECTOR_DETERMINISTIC_RASTER ||
    height > MAX_DIRECTOR_DETERMINISTIC_RASTER
  ) {
    throw new Error("Deterministic export PNG raster is invalid or exceeds 16384 pixels per side.");
  }
  return { width, height };
}

function decodePngDataUrl(dataUrl: string, maximumBytes: number): Uint8Array {
  const match = /^data:image\/png;base64,([a-z\d+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error("Deterministic export capture must return a base64 PNG data URL.");
  if (match[1]!.replace(/\s+/g, "").length > Math.ceil((maximumBytes * 4) / 3) + 4) {
    throw new Error(`Deterministic PNG capture exceeds the ${maximumBytes}-byte memory limit.`);
  }
  let binary: string;
  try {
    binary = atob(match[1]!.replace(/\s+/g, ""));
  } catch {
    throw new Error("Deterministic export capture returned invalid PNG base64 data.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function normalizePngSource(source: DirectorPngFrameSource, maximumBytes: number): Promise<Uint8Array> {
  if (typeof source === "string") return decodePngDataUrl(source, maximumBytes);
  if (source instanceof Blob) {
    if (source.type && source.type !== PNG_MIME_TYPE) {
      throw new Error(`Deterministic export capture returned ${source.type}, not image/png.`);
    }
    if (source.size > maximumBytes) {
      throw new Error(`Deterministic PNG capture exceeds the ${maximumBytes}-byte memory limit.`);
    }
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source.byteLength > maximumBytes) {
    throw new Error(`Deterministic PNG capture exceeds the ${maximumBytes}-byte memory limit.`);
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(source);
}

async function sha256(bytes: Uint8Array | string): Promise<`sha256:${string}`> {
  // Digest the view directly; see shotPackage.ts sha256 for the realm rationale.
  const sourceBytes = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", sourceBytes));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function pathForOutputFrame(outputIndex: number): string {
  return `frames/frame-${String(outputIndex).padStart(6, "0")}.png`;
}

function reportProgress(
  callback: ExportDeterministicDirectorFramesOptions["onProgress"],
  phase: DirectorDeterministicExportProgress["phase"],
  completed: number,
  total: number,
  progress: number,
  sample?: DirectorDeterministicFrameSample,
): void {
  callback?.({ phase, completed, total, progress: Math.max(0, Math.min(1, progress)), ...(sample ? { sample } : {}) });
}

async function createManifest(
  frames: CapturedPngFrame[],
  sourceFrameStart: number,
  sourceFrameEnd: number,
  sourceFps: number,
  outputFps: number,
  width: number,
  height: number,
  background: DirectorCaptureBackgroundMode,
): Promise<DirectorDeterministicFrameManifest> {
  const frameArtifacts = frames.map(({ sample, path, bytes, sha256: frameSha256 }) => ({
    ...sample,
    path,
    mimeType: PNG_MIME_TYPE as typeof PNG_MIME_TYPE,
    byteLength: bytes.byteLength,
    sha256: frameSha256,
  }));
  const payload = {
    schemaVersion: 1 as const,
    kind: "director-deterministic-frame-sequence" as const,
    timebase: "microseconds" as const,
    sampling: "nearest-endpoint-inclusive" as const,
    sourceFrameStart,
    sourceFrameEnd,
    sourceFps,
    outputFps,
    outputFrameCount: frames.length,
    durationUs: frames.at(-1)!.sample.timestampUs + frames.at(-1)!.sample.durationUs,
    width,
    height,
    // Serialized only for transparent packages: composited manifests (and
    // their package fingerprints) must remain byte-identical to pre-alpha
    // exports, so absence is the recorded form of "composited".
    ...(background === "transparent" ? { background } : {}),
    frames: frameArtifacts,
  };
  return { ...payload, packageFingerprint: await sha256(stableArtifactStringify(payload)) };
}

function createPngSequenceExport(
  frames: CapturedPngFrame[],
  manifest: DirectorDeterministicFrameManifest,
  fallbackReason?: string,
): DirectorPngSequenceExport {
  const manifestBytes = new TextEncoder().encode(stableArtifactStringify(manifest));
  const files = frames.map((frame) => ({
    path: frame.path,
    mimeType: PNG_MIME_TYPE as typeof PNG_MIME_TYPE,
    bytes: frame.bytes,
  }));
  const archive = createDeterministicZipArchive([
    { path: "manifest.json", bytes: manifestBytes },
    ...files.map(({ path, bytes }) => ({ path, bytes })),
  ]);
  return {
    kind: "png-sequence",
    mimeType: ZIP_MIME_TYPE,
    extension: "zip",
    fileName: `director-png-sequence-f${String(manifest.sourceFrameStart).padStart(6, "0")}-f${String(
      manifest.sourceFrameEnd,
    ).padStart(6, "0")}.zip`,
    archive: archive.blob,
    manifest,
    files,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

function createDefaultWebCodecsRuntime(): DirectorWebCodecsRuntime | null {
  if (
    typeof globalThis.VideoEncoder === "undefined" ||
    typeof globalThis.VideoFrame === "undefined" ||
    typeof globalThis.createImageBitmap !== "function"
  ) {
    return null;
  }
  return {
    isConfigSupported: (config) => globalThis.VideoEncoder.isConfigSupported(config),
    createEncoder: (init) => new globalThis.VideoEncoder(init),
    decodePng: async (bytes) => await createImageBitmap(new Blob([bytes as BlobPart], { type: PNG_MIME_TYPE })),
    createVideoFrame: (source, init) => new globalThis.VideoFrame(source, init),
  };
}

function copyBufferSource(source: AllowSharedBufferSource | undefined): Uint8Array | undefined {
  if (!source) return undefined;
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

function normalizeDecoderConfig(config: VideoDecoderConfig | undefined): DirectorMuxedVideoDecoderConfig | undefined {
  if (!config) return undefined;
  return {
    codec: config.codec,
    ...(config.codedWidth !== undefined ? { codedWidth: config.codedWidth } : {}),
    ...(config.codedHeight !== undefined ? { codedHeight: config.codedHeight } : {}),
    ...(config.displayAspectWidth !== undefined ? { displayAspectWidth: config.displayAspectWidth } : {}),
    ...(config.displayAspectHeight !== undefined ? { displayAspectHeight: config.displayAspectHeight } : {}),
    ...(config.colorSpace ? { colorSpace: { ...config.colorSpace } } : {}),
    ...(config.hardwareAcceleration ? { hardwareAcceleration: config.hardwareAcceleration } : {}),
    ...(config.optimizeForLatency !== undefined ? { optimizeForLatency: config.optimizeForLatency } : {}),
    ...(config.description ? { description: copyBufferSource(config.description) } : {}),
  };
}

function assertMuxerIdentity(muxer: DirectorDeterministicVideoMuxer): void {
  if (muxer.container === "mp4" && (muxer.mimeType !== "video/mp4" || muxer.extension !== "mp4")) {
    throw new Error("MP4 muxer identity is inconsistent.");
  }
  if (muxer.container === "webm" && (muxer.mimeType !== "video/webm" || muxer.extension !== "webm")) {
    throw new Error("WebM muxer identity is inconsistent.");
  }
}

async function normalizeMuxedBlob(
  value: Blob | Uint8Array,
  muxer: DirectorDeterministicVideoMuxer,
  maximumBytes: number,
): Promise<Blob> {
  const blob =
    value instanceof Blob
      ? new Blob([value], { type: muxer.mimeType })
      : new Blob([value as BlobPart], { type: muxer.mimeType });
  if (!blob.size) throw new Error("The container muxer returned an empty video.");
  if (blob.size > maximumBytes) throw new Error("Muxed video exceeds the configured page-session byte limit.");
  const signature = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (muxer.container === "mp4") {
    if (signature.byteLength < 8 || String.fromCharCode(...signature.subarray(4, 8)) !== "ftyp") {
      throw new Error("The MP4 muxer did not return a self-contained ISO BMFF container.");
    }
  } else if (
    signature.byteLength < 4 ||
    signature[0] !== 0x1a ||
    signature[1] !== 0x45 ||
    signature[2] !== 0xdf ||
    signature[3] !== 0xa3
  ) {
    throw new Error("The WebM muxer did not return a self-contained EBML container.");
  }
  return blob;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError");
}

async function tryEncodeWithWebCodecs(
  frames: CapturedPngFrame[],
  manifest: DirectorDeterministicFrameManifest,
  options: DirectorDeterministicWebCodecsOptions,
  background: DirectorCaptureBackgroundMode,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  onProgress: ExportDeterministicDirectorFramesOptions["onProgress"],
): Promise<DirectorMuxedVideoExport | { fallbackReason: string }> {
  const runtime = options.runtime ?? createDefaultWebCodecsRuntime();
  if (!runtime) return { fallbackReason: "WebCodecs VideoEncoder is unavailable in this browser." };
  const keyFrameInterval = normalizeBoundedLimit(
    options.keyFrameInterval,
    MAX_DIRECTOR_DETERMINISTIC_OUTPUT_FRAMES,
    "keyFrameInterval",
  );
  const maxEncodeQueueSize = normalizeBoundedLimit(options.maxEncodeQueueSize, 64, "maxEncodeQueueSize");
  const bitrate = options.bitrate ?? 8_000_000;
  if (!Number.isSafeInteger(bitrate) || bitrate < 1 || bitrate > 1_000_000_000) {
    return { fallbackReason: "WebCodecs bitrate must be an integer between 1 and 1000000000." };
  }
  const requireAlpha = background === "transparent";
  const requestedConfig: VideoEncoderConfig = {
    codec: options.codec ?? "vp09.00.10.08",
    width: manifest.width,
    height: manifest.height,
    bitrate,
    framerate: manifest.outputFps,
    latencyMode: "quality",
    // Feature detection, not a request to drop alpha: encoders that cannot
    // keep alpha either report unsupported or strip the key from the
    // negotiated config, and both cases fall back to the RGBA PNG package.
    ...(requireAlpha ? { alpha: "keep" as const } : {}),
  };

  let muxer: DirectorDeterministicVideoMuxer | null = null;
  let encoder: DirectorWebCodecsEncoderLike | null = null;
  try {
    throwIfAborted(signal);
    const support = await runtime.isConfigSupported(requestedConfig);
    throwIfAborted(signal);
    if (!support.supported) return { fallbackReason: `WebCodecs codec "${requestedConfig.codec}" is unsupported.` };
    const encoderConfig = support.config ?? requestedConfig;
    if (
      encoderConfig.width !== manifest.width ||
      encoderConfig.height !== manifest.height ||
      encoderConfig.framerate !== manifest.outputFps
    ) {
      return { fallbackReason: "WebCodecs support negotiation changed the requested raster or frame rate." };
    }
    if (requireAlpha && encoderConfig.alpha !== "keep") {
      return {
        fallbackReason:
          'WebCodecs encoder cannot keep the alpha channel (alpha: "keep" unsupported); the RGBA PNG package preserves transparency.',
      };
    }
    muxer = await options.createMuxer({
      encoderConfig,
      width: manifest.width,
      height: manifest.height,
      fps: manifest.outputFps,
      frameCount: manifest.outputFrameCount,
    });
    assertMuxerIdentity(muxer);
    if (requireAlpha && muxer.container !== "webm") {
      const reason = "Alpha video requires a WebM (VP9) container; the RGBA PNG package preserves transparency.";
      muxer.abort?.(new Error(reason));
      muxer = null;
      return { fallbackReason: reason };
    }

    const intendedDurationByTimestamp = new Map(
      frames.map((frame) => [frame.sample.timestampUs, frame.sample.durationUs] as const),
    );
    let encoderFailure: Error | null = null;
    let encodedChunkBytes = 0;
    let muxerQueue: Promise<void> = Promise.resolve();
    encoder = runtime.createEncoder({
      output: (chunk, metadata) => {
        encodedChunkBytes += chunk.byteLength;
        if (!Number.isSafeInteger(encodedChunkBytes) || encodedChunkBytes > maximumBytes) {
          encoderFailure = new Error("Encoded WebCodecs chunks exceed the configured page-session byte limit.");
          return;
        }
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const normalizedChunk: DirectorMuxedVideoChunk = {
          type: chunk.type,
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? intendedDurationByTimestamp.get(chunk.timestamp) ?? 0,
          bytes,
          ...(metadata?.decoderConfig ? { decoderConfig: normalizeDecoderConfig(metadata.decoderConfig) } : {}),
        };
        muxerQueue = muxerQueue.then(() => muxer!.addVideoChunk(normalizedChunk));
      },
      error: (error) => {
        encoderFailure = error instanceof Error ? error : new Error(String(error));
      },
    });
    encoder.configure(encoderConfig);

    for (let index = 0; index < frames.length; index += 1) {
      throwIfAborted(signal);
      const captured = frames[index]!;
      const image = await runtime.decodePng(captured.bytes);
      let videoFrame: VideoFrame | null = null;
      try {
        throwIfAborted(signal);
        videoFrame = runtime.createVideoFrame(image, {
          timestamp: captured.sample.timestampUs,
          duration: captured.sample.durationUs,
        });
        encoder.encode(videoFrame, { keyFrame: index === 0 || index % keyFrameInterval === 0 });
      } finally {
        videoFrame?.close();
        image.close?.();
      }
      if (encoder.encodeQueueSize >= maxEncodeQueueSize) {
        await encoder.flush();
        await muxerQueue;
      }
      if (encoderFailure) throw encoderFailure;
      reportProgress(
        onProgress,
        "encode",
        index + 1,
        frames.length,
        0.7 + ((index + 1) / frames.length) * 0.28,
        captured.sample,
      );
    }

    await encoder.flush();
    await muxerQueue;
    if (encoderFailure) throw encoderFailure;
    throwIfAborted(signal);
    reportProgress(onProgress, "package", 0, 1, 0.99);
    const blob = await normalizeMuxedBlob(await muxer.finalize(), muxer, maximumBytes);
    throwIfAborted(signal);
    reportProgress(onProgress, "package", 1, 1, 1);
    return {
      kind: "video",
      timing: "explicit-webcodecs-timestamps",
      container: muxer.container,
      mimeType: muxer.mimeType,
      extension: muxer.extension,
      blob,
      manifest,
    };
  } catch (error) {
    try {
      encoder?.reset();
    } catch {
      // An encoder can already be closed after an asynchronous failure.
    }
    muxer?.abort?.(error);
    if (isAbortError(error, signal)) throw error;
    return { fallbackReason: `WebCodecs container export failed: ${errorMessage(error)}` };
  } finally {
    try {
      encoder?.close();
    } catch {
      // Ignore a redundant close after reset/failure.
    }
  }
}

/**
 * Captures one PNG for every planned output frame without consulting a wall
 * clock or running the timeline transport. If a real muxer is supplied, the
 * same frames are fed to WebCodecs with explicit microsecond timing. Otherwise
 * the reliable result is a deterministic PNG-sequence ZIP, never a fake MP4.
 */
export async function exportDeterministicDirectorFrames(
  options: ExportDeterministicDirectorFramesOptions,
): Promise<DirectorDeterministicFrameExport> {
  const sourceFps = normalizeStrictFps(options.sourceFps, "sourceFps");
  const outputFps = normalizeStrictFps(options.outputFps ?? sourceFps, "outputFps");
  const background: DirectorCaptureBackgroundMode = options.background ?? "composited";
  if (background !== "composited" && background !== "transparent") {
    throw new Error('Deterministic export background must be "composited" or "transparent".');
  }
  const maximumFrames = normalizeBoundedLimit(options.maxFrames, MAX_DIRECTOR_DETERMINISTIC_OUTPUT_FRAMES, "maxFrames");
  const maximumCaptureBytes = normalizeBoundedLimit(
    options.maxCaptureBytes,
    MAX_DIRECTOR_DETERMINISTIC_CAPTURE_BYTES,
    "maxCaptureBytes",
  );
  const maximumEncodedBytes = normalizeBoundedLimit(
    options.maxEncodedBytes,
    MAX_DIRECTOR_DETERMINISTIC_VIDEO_BYTES,
    "maxEncodedBytes",
  );
  const maximumRasterPixels = normalizeBoundedLimit(
    options.maxRasterPixels,
    MAX_DIRECTOR_DETERMINISTIC_RASTER_PIXELS,
    "maxRasterPixels",
  );
  const plan = getDirectorDeterministicFramePlan(options.frameStart, options.frameEnd, sourceFps, outputFps);
  if (plan.length > maximumFrames) {
    throw new Error(`Deterministic export requires ${plan.length} frames, above the ${maximumFrames}-frame limit.`);
  }

  const frames: CapturedPngFrame[] = [];
  let captureBytes = 0;
  let width = 0;
  let height = 0;
  const captureProgressWeight = options.webCodecs ? 0.7 : 0.98;
  for (let index = 0; index < plan.length; index += 1) {
    const sample = plan[index]!;
    throwIfAborted(options.signal);
    const bytes = await normalizePngSource(
      await options.captureFrame(sample.sourceFrame, Object.freeze({ ...sample }), options.signal),
      maximumCaptureBytes - captureBytes,
    );
    throwIfAborted(options.signal);
    const dimensions = inspectDirectorPng(bytes);
    if (index === 0) {
      width = dimensions.width;
      height = dimensions.height;
      if (width * height > maximumRasterPixels) {
        throw new Error(`Deterministic export raster exceeds the ${maximumRasterPixels}-pixel limit.`);
      }
    } else if (dimensions.width !== width || dimensions.height !== height) {
      throw new Error(
        `Deterministic export frame ${sample.outputIndex} is ${dimensions.width}x${dimensions.height}; expected ${width}x${height}.`,
      );
    }
    captureBytes += bytes.byteLength;
    if (!Number.isSafeInteger(captureBytes) || captureBytes > maximumCaptureBytes) {
      throw new Error(`Deterministic PNG capture exceeds the ${maximumCaptureBytes}-byte memory limit.`);
    }
    const frameSha256 = await sha256(bytes);
    throwIfAborted(options.signal);
    frames.push({ sample, path: pathForOutputFrame(sample.outputIndex), bytes, sha256: frameSha256, width, height });
    reportProgress(
      options.onProgress,
      "capture",
      index + 1,
      plan.length,
      ((index + 1) / plan.length) * captureProgressWeight,
      sample,
    );
  }

  const manifest = await createManifest(
    frames,
    options.frameStart,
    options.frameEnd,
    sourceFps,
    outputFps,
    width,
    height,
    background,
  );
  throwIfAborted(options.signal);

  if (options.webCodecs) {
    const encoded = await tryEncodeWithWebCodecs(
      frames,
      manifest,
      options.webCodecs,
      background,
      maximumEncodedBytes,
      options.signal,
      options.onProgress,
    );
    if ("kind" in encoded) return encoded;
    reportProgress(options.onProgress, "package", 0, 1, 0.99);
    const fallback = createPngSequenceExport(frames, manifest, encoded.fallbackReason);
    reportProgress(options.onProgress, "package", 1, 1, 1);
    return fallback;
  }

  reportProgress(options.onProgress, "package", 0, 1, 0.99);
  const pngSequence = createPngSequenceExport(frames, manifest);
  reportProgress(options.onProgress, "package", 1, 1, 1);
  return pngSequence;
}

/**
 * Trigger a browser download for a deterministic export result
 * (either a PNG-sequence ZIP or a WebCodecs-muxed video).
 *
 * @param result - The deterministic export result.
 * @param baseName - The base file name for the download.
 */
export function downloadDirectorDeterministicExport(
  result: DirectorDeterministicFrameExport,
  baseName = "director-deterministic-render",
): void {
  const blob = result.kind === "video" ? result.blob : result.archive;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseName}-f${result.manifest.sourceFrameStart}-f${result.manifest.sourceFrameEnd}.${result.extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
