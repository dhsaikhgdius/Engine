import type { DirectorVideoRecording } from "../video/directorVideoExport";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorMediaItem } from "./directorMediaLibrary";
import {
  findDirectorTransitionPredecessor,
  type DirectorEditClip,
  type DirectorEditTrack,
} from "./directorWorkspaceStore";

/** Container format for an exported timeline video. */
export type DirectorTimelineVideoFormat = "auto" | "webm" | "mp4";

/** Supported output aspect ratios for timeline rendering and export. */
export type DirectorTimelineAspectRatio = "16 / 9" | "9 / 16" | "1 / 1";

/** Render quality tier that controls output resolution. */
export type DirectorTimelineRenderQuality = "preview" | "full";

/** One composited video layer at a specific point on the timeline. */
export interface DirectorTimelineActiveLayer {
  /** ID of the track this layer belongs to. */
  trackId: string;
  /** Zero-based position of the track in the track list. */
  trackIndex: number;
  /** Whether the owning track is muted. */
  trackMuted: boolean;
  /** The edit clip driving this layer. */
  clip: DirectorEditClip;
  /** The resolved media item, or null when the media is missing. */
  media: DirectorMediaItem | null;
  /** Time into the source media, accounting for in-point and playback rate. */
  sourceTimeSec: number;
  /** Classifier for the layer's content type. */
  kind: "media" | "text" | "missing";
  /**
   * Set on the outgoing clip drawn beneath an entering clip while that clip
   * cross-dissolves in; its sourceTimeSec extends past the clip's own end
   * and consumers clamp it to the last frame (a frozen-tail dissolve).
   */
  isTransitionTail?: boolean;
}

/** An audio clip that is active at a given timeline position. */
export interface DirectorTimelineActiveAudioClip {
  /** ID of the track this audio clip belongs to. */
  trackId: string;
  /** The edit clip driving this audio. */
  clip: DirectorEditClip;
  /** The resolved media item (guaranteed to have audible content). */
  media: DirectorMediaItem;
}

/** Progress snapshot emitted during timeline video export. */
export interface DirectorTimelineExportProgress {
  /** Current export phase. */
  phase: "rendering" | "encoding";
  /** Overall progress from 0 to 1. */
  progress: number;
  /** The frame number most recently rendered or encoded. */
  frame: number;
  /** Total number of frames in the export. */
  totalFrames: number;
}

/** Configuration for a full timeline video export. */
export interface ExportDirectorTimelineVideoOptions {
  /** Tracks to render, in display order (Video 1 is foreground). */
  tracks: DirectorEditTrack[];
  /** All media items referenced by the tracks. */
  mediaItems: DirectorMediaItem[];
  /** Output aspect ratio. */
  aspectRatio: DirectorTimelineAspectRatio;
  /** Render quality tier. Defaults to "preview". */
  quality?: DirectorTimelineRenderQuality;
  /** Frame rate for the exported video. Defaults to 24. */
  fps?: number;
  /** Container format. Defaults to "auto". */
  format?: DirectorTimelineVideoFormat;
  /** AbortSignal to cancel the export mid-flight. */
  signal?: AbortSignal;
  /** Callback invoked with progress updates during rendering and encoding. */
  onProgress?: (progress: DirectorTimelineExportProgress) => void;
}

/** Configuration for rendering a single clean timeline frame. */
export interface RenderDirectorTimelineFrameOptions {
  /** Tracks to render, in display order. */
  tracks: DirectorEditTrack[];
  /** All media items referenced by the tracks. */
  mediaItems: DirectorMediaItem[];
  /** Output aspect ratio. */
  aspectRatio: DirectorTimelineAspectRatio;
  /** Timeline position in seconds. */
  timeSec: number;
  /** Render quality tier. Defaults to "preview". */
  quality?: DirectorTimelineRenderQuality;
  /** AbortSignal to cancel the render. */
  signal?: AbortSignal;
}

/** Result of rendering a single timeline frame. */
export interface DirectorTimelineFrameCapture {
  /** PNG data URL of the rendered frame. */
  dataUrl: string;
  /** Rendered frame width in pixels. */
  width: number;
  /** Rendered frame height in pixels. */
  height: number;
  /** Timeline position of the captured frame in seconds. */
  timeSec: number;
  /** IDs of all clips that were active at this frame. */
  activeClipIds: string[];
}

const MEDIA_LOAD_TIMEOUT_MS = 15_000;
const EXPORT_BACKGROUND = "#111317";

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Timeline export aborted", "AbortError");
}

function isAudibleMedia(media: DirectorMediaItem | undefined) {
  return media?.kind === "audio" || media?.kind === "video";
}

/**
 * Compute the total content duration across all tracks.
 *
 * Considers only tracks that contribute picture or sound: visible video
 * tracks and unmuted audio tracks (or unmuted video tracks whose media
 * has an audio stream).
 *
 * @param tracks - The timeline tracks to measure.
 * @param mediaById - Optional lookup of media items by ID for audio detection.
 * @returns The maximum end time across all contributing clips, in seconds.
 */
export function getDirectorTimelineContentDuration(
  tracks: DirectorEditTrack[],
  mediaById?: ReadonlyMap<string, DirectorMediaItem>,
) {
  let duration = 0;
  tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      const hasPicture = track.kind === "video" && track.visible;
      const hasSound = !track.muted && (track.kind === "audio" || isAudibleMedia(mediaById?.get(clip.mediaId)));
      if (!hasPicture && !hasSound) return;
      duration = Math.max(duration, clip.startSec + clip.durationSec);
    });
  });
  return duration;
}

/**
 * Collect all audio clips that are active at a given timeline position.
 *
 * Only unmuted tracks are considered; clips whose time range does not
 * cover the requested position are excluded.
 *
 * @param tracks - The timeline tracks to scan.
 * @param mediaById - Lookup of media items by ID.
 * @param timeSec - The timeline position to query, in seconds.
 * @returns Array of active audio clips at the given time.
 */
export function getDirectorTimelineActiveAudioClips(
  tracks: DirectorEditTrack[],
  mediaById: ReadonlyMap<string, DirectorMediaItem>,
  timeSec: number,
): DirectorTimelineActiveAudioClip[] {
  return tracks.flatMap((track) => {
    if (track.muted) return [];
    return track.clips.flatMap((clip) => {
      if (timeSec < clip.startSec || timeSec >= clip.startSec + clip.durationSec) return [];
      const media = mediaById.get(clip.mediaId);
      return media && isAudibleMedia(media) ? [{ trackId: track.id, clip, media }] : [];
    });
  });
}

/**
 * Compute the output render dimensions for a given aspect ratio and quality.
 *
 * @param aspectRatio - The desired output aspect ratio.
 * @param quality - The render quality tier.
 * @returns Width and height in pixels for the output canvas.
 */
export function getDirectorTimelineRenderSize(
  aspectRatio: DirectorTimelineAspectRatio,
  quality: DirectorTimelineRenderQuality,
) {
  const longEdge = quality === "full" ? 1920 : 1280;
  const shortEdge = quality === "full" ? 1080 : 720;
  if (aspectRatio === "9 / 16") return { width: shortEdge, height: longEdge };
  if (aspectRatio === "1 / 1") return { width: shortEdge, height: shortEdge };
  return { width: longEdge, height: shortEdge };
}

/**
 * Collect all visible video layers that are active at a given timeline position.
 *
 * Handles cross-dissolve transitions by pushing a frozen-tail predecessor
 * layer beneath the entering clip. Layers are sorted so lower track indices
 * (foreground) draw last, matching the editor preview.
 *
 * @param tracks - The timeline tracks to scan.
 * @param mediaById - Lookup of media items by ID.
 * @param timeSec - The timeline position to query, in seconds.
 * @returns Array of active layers sorted back-to-front for compositing.
 */
export function getDirectorTimelineActiveLayers(
  tracks: DirectorEditTrack[],
  mediaById: ReadonlyMap<string, DirectorMediaItem>,
  timeSec: number,
): DirectorTimelineActiveLayer[] {
  const layers: DirectorTimelineActiveLayer[] = [];
  tracks.forEach((track, trackIndex) => {
    if (track.kind !== "video" || !track.visible) return;
    const clip = track.clips
      .filter((item) => timeSec >= item.startSec && timeSec < item.startSec + item.durationSec)
      .sort((left, right) => left.startSec - right.startSec)
      .at(-1);
    if (!clip) return;
    const pushLayer = (layerClip: DirectorEditClip, isTransitionTail?: boolean) => {
      const media = mediaById.get(layerClip.mediaId) ?? null;
      layers.push({
        trackId: track.id,
        trackIndex,
        trackMuted: track.muted,
        clip: layerClip,
        media,
        sourceTimeSec: layerClip.inSec + Math.max(0, timeSec - layerClip.startSec) * layerClip.playbackRate,
        kind: layerClip.mediaId.startsWith("text:") ? "text" : media ? "media" : "missing",
        ...(isTransitionTail ? { isTransitionTail: true } : {}),
      });
    };
    const transitionInSec = clip.transitionInSec ?? 0;
    if (transitionInSec > 0 && timeSec < clip.startSec + transitionInSec) {
      // One level only: a predecessor that is itself dissolving in does not
      // recurse into its own predecessor.
      const predecessor = findDirectorTransitionPredecessor(track, clip.id);
      if (predecessor) pushLayer(predecessor, true);
    }
    pushLayer(clip);
  });
  // The first timeline row is the foreground track. Draw lower rows first so
  // Video 1 remains visually above Video 2, matching the editor preview.
  return layers.sort((left, right) => right.trackIndex - left.trackIndex);
}

/**
 * Compute the "contain" rectangle that fits source media inside an output
 * frame while preserving aspect ratio.
 *
 * The source is centered and scaled uniformly so it fits entirely within
 * the output dimensions.
 *
 * @param sourceWidth - Native width of the source media.
 * @param sourceHeight - Native height of the source media.
 * @param outputWidth - Width of the output frame.
 * @param outputHeight - Height of the output frame.
 * @returns Position and size of the contained media rectangle.
 */
export function getContainedMediaRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
) {
  const safeSourceWidth = Math.max(1, sourceWidth);
  const safeSourceHeight = Math.max(1, sourceHeight);
  const scale = Math.min(outputWidth / safeSourceWidth, outputHeight / safeSourceHeight);
  const width = safeSourceWidth * scale;
  const height = safeSourceHeight * scale;
  return {
    x: (outputWidth - width) / 2,
    y: (outputHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Compute the composited opacity of a clip at a given timeline position.
 *
 * Multiplicatively combines the clip's base opacity, fade-in, fade-out,
 * and cross-dissolve transition-in ramp.
 *
 * @param clip - The edit clip to evaluate.
 * @param timeSec - The timeline position in seconds.
 * @returns Opacity value between 0 (fully transparent) and 1 (fully opaque).
 */
export function getDirectorClipOpacityAtTime(clip: DirectorEditClip, timeSec: number) {
  const localTime = clamp(timeSec - clip.startSec, 0, clip.durationSec);
  const fadeIn = clip.fadeInSec > 0 ? clamp(localTime / clip.fadeInSec, 0, 1) : 1;
  const timeFromEnd = clip.durationSec - localTime;
  const fadeOut = clip.fadeOutSec > 0 ? clamp(timeFromEnd / clip.fadeOutSec, 0, 1) : 1;
  const transitionInSec = clip.transitionInSec ?? 0;
  // The cross-dissolve entry ramp stacks multiplicatively with fades so the
  // predecessor tail shows through while any fade-in still applies.
  const transitionIn = transitionInSec > 0 ? clamp(localTime / transitionInSec, 0, 1) : 1;
  return clamp(clip.opacity * Math.min(fadeIn, fadeOut) * transitionIn, 0, 1);
}

/**
 * Compute the output rectangle for a media clip, applying fit, scale,
 * and position transforms.
 *
 * The rectangle is positioned relative to the output frame, with position
 * offsets normalized against a 1920×1080 reference.
 *
 * @param sourceWidth - Native width of the source media.
 * @param sourceHeight - Native height of the source media.
 * @param outputWidth - Width of the output frame.
 * @param outputHeight - Height of the output frame.
 * @param clip - Clip with fit, scale, and position properties.
 * @returns Position and size of the transformed media rectangle.
 */
export function getDirectorMediaRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  clip: Pick<DirectorEditClip, "fit" | "scale" | "positionX" | "positionY">,
) {
  const safeSourceWidth = Math.max(1, sourceWidth);
  const safeSourceHeight = Math.max(1, sourceHeight);
  const baseScale =
    clip.fit === "cover"
      ? Math.max(outputWidth / safeSourceWidth, outputHeight / safeSourceHeight)
      : Math.min(outputWidth / safeSourceWidth, outputHeight / safeSourceHeight);
  const scale = baseScale * clip.scale;
  const width = safeSourceWidth * scale;
  const height = safeSourceHeight * scale;
  return {
    x: (outputWidth - width) / 2 + (clip.positionX * outputWidth) / 1920,
    y: (outputHeight - height) / 2 + (clip.positionY * outputHeight) / 1080,
    width,
    height,
  };
}

function waitForMediaEvent(
  target: HTMLImageElement | HTMLVideoElement,
  successEvent: "load" | "loadeddata" | "seeked",
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => finish(() => reject(new Error("素材读取超时"))), MEDIA_LOAD_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      target.removeEventListener(successEvent, loaded);
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
    const failed = () => finish(() => reject(new Error("素材无法解码或不允许跨域读取")));
    const aborted = () => finish(() => reject(new DOMException("Timeline export aborted", "AbortError")));
    target.addEventListener(successEvent, loaded, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

class DirectorTimelineFrameRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly mediaById: ReadonlyMap<string, DirectorMediaItem>;
  readonly tracks: DirectorEditTrack[];
  readonly signal?: AbortSignal;
  readonly imageCache = new Map<string, Promise<HTMLImageElement>>();
  readonly videoCache = new Map<string, Promise<HTMLVideoElement>>();

  constructor(
    tracks: DirectorEditTrack[],
    mediaById: ReadonlyMap<string, DirectorMediaItem>,
    width: number,
    height: number,
    signal?: AbortSignal,
  ) {
    this.tracks = tracks;
    this.mediaById = mediaById;
    this.signal = signal;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建时间线渲染画布");
    this.context = context;
  }

  private loadImage(media: DirectorMediaItem) {
    const existing = this.imageCache.get(media.id);
    if (existing) return existing;
    const source = media.sourceUrl ?? media.thumbnailUrl;
    if (!source) return Promise.reject(new Error(`${media.name} 没有可读取的图像源`));
    const promise = (async () => {
      const image = new Image();
      image.decoding = "async";
      image.crossOrigin = "anonymous";
      const loaded = waitForMediaEvent(image, "load", this.signal);
      image.src = source;
      await loaded;
      return image;
    })();
    this.imageCache.set(media.id, promise);
    return promise;
  }

  private loadVideo(media: DirectorMediaItem) {
    const existing = this.videoCache.get(media.id);
    if (existing) return existing;
    if (!media.sourceUrl) return Promise.reject(new Error(`${media.name} 没有可读取的视频源`));
    const promise = (async () => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      const loaded = waitForMediaEvent(video, "loadeddata", this.signal);
      video.src = media.sourceUrl!;
      video.load();
      await loaded;
      return video;
    })();
    this.videoCache.set(media.id, promise);
    return promise;
  }

  private async seekVideo(video: HTMLVideoElement, timeSec: number) {
    const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - 1 / 60) : timeSec;
    const target = clamp(timeSec, 0, maximum);
    if (Math.abs(video.currentTime - target) < 1 / 120 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }
    const seeked = waitForMediaEvent(video, "seeked", this.signal);
    video.currentTime = target;
    await seeked;
  }

  private drawMedia(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    clip: DirectorEditClip,
    timeSec: number,
  ) {
    const rect = getDirectorMediaRect(sourceWidth, sourceHeight, this.canvas.width, this.canvas.height, clip);
    this.context.save();
    this.context.globalAlpha = getDirectorClipOpacityAtTime(clip, timeSec);
    this.context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
    this.context.rotate((clip.rotationDeg * Math.PI) / 180);
    this.context.drawImage(source, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
    this.context.restore();
  }

  private drawText(clip: DirectorEditClip, timeSec: number) {
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const fontSize = Math.round(Math.max(34, Math.min(width, height) * 0.075));
    context.save();
    context.globalAlpha = getDirectorClipOpacityAtTime(clip, timeSec);
    context.font = `600 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineWidth = Math.max(4, Math.round(fontSize * 0.09));
    context.strokeStyle = "rgb(0 0 0 / 0.72)";
    context.fillStyle = "#ffffff";
    context.shadowColor = "rgb(0 0 0 / 0.5)";
    context.shadowBlur = Math.round(fontSize * 0.22);
    context.translate(width / 2 + (clip.positionX * width) / 1920, height / 2 + (clip.positionY * height) / 1080);
    context.rotate((clip.rotationDeg * Math.PI) / 180);
    context.scale(clip.scale, clip.scale);
    context.strokeText(clip.name, 0, 0, width * 0.82);
    context.fillText(clip.name, 0, 0, width * 0.82);
    context.restore();
  }

  private drawMissingLayer(clip: DirectorEditClip, timeSec: number) {
    const context = this.context;
    context.save();
    context.globalAlpha = getDirectorClipOpacityAtTime(clip, timeSec);
    context.fillStyle = "#202630";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "#aeb8c8";
    context.font = `500 ${Math.round(Math.min(this.canvas.width, this.canvas.height) * 0.035)}px Inter, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(clip.name, this.canvas.width / 2, this.canvas.height / 2, this.canvas.width * 0.75);
    context.restore();
  }

  async render(timeSec: number) {
    throwIfAborted(this.signal);
    this.context.fillStyle = EXPORT_BACKGROUND;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const layers = getDirectorTimelineActiveLayers(this.tracks, this.mediaById, timeSec);
    for (const layer of layers) {
      throwIfAborted(this.signal);
      if (layer.kind === "text") {
        this.drawText(layer.clip, timeSec);
        continue;
      }
      if (!layer.media) {
        this.drawMissingLayer(layer.clip, timeSec);
        continue;
      }
      if (layer.media.kind === "video") {
        const video = await this.loadVideo(layer.media);
        await this.seekVideo(video, layer.sourceTimeSec);
        this.drawMedia(video, video.videoWidth, video.videoHeight, layer.clip, timeSec);
      } else {
        const image = await this.loadImage(layer.media);
        this.drawMedia(image, image.naturalWidth, image.naturalHeight, layer.clip, timeSec);
      }
    }
    try {
      return this.canvas.toDataURL("image/png");
    } catch {
      throw new Error("素材服务器未允许跨域像素读取，无法安全导出该时间线");
    }
  }

  dispose() {
    this.videoCache.forEach((promise) => {
      void promise.then((video) => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      });
    });
    this.imageCache.clear();
    this.videoCache.clear();
  }
}

/**
 * Render one clean editor frame through the same compositor used by timeline
 * video export. The helper does not seek the workspace playhead and never
 * includes timeline chrome, selection handles, guides, or other editor UI.
 *
 * @param options - Render configuration including tracks, media, aspect ratio, and time.
 * @returns A frame capture with the PNG data URL, dimensions, and active clip IDs.
 */
export async function renderDirectorTimelineFrame({
  tracks,
  mediaItems,
  aspectRatio,
  timeSec,
  quality = "preview",
  signal,
}: RenderDirectorTimelineFrameOptions): Promise<DirectorTimelineFrameCapture> {
  throwIfAborted(signal);
  const normalizedTimeSec = Math.max(0, Number.isFinite(timeSec) ? timeSec : 0);
  const mediaById = new Map(mediaItems.map((media) => [media.id, media]));
  const { width, height } = getDirectorTimelineRenderSize(aspectRatio, quality);
  const activeLayers = getDirectorTimelineActiveLayers(tracks, mediaById, normalizedTimeSec);
  const renderer = new DirectorTimelineFrameRenderer(tracks, mediaById, width, height, signal);
  try {
    return {
      dataUrl: await renderer.render(normalizedTimeSec),
      width,
      height,
      timeSec: normalizedTimeSec,
      activeClipIds: activeLayers.map((layer) => layer.clip.id),
    };
  } finally {
    renderer.dispose();
  }
}

async function createDirectorTimelineAudioSource(
  tracks: DirectorEditTrack[],
  mediaById: ReadonlyMap<string, DirectorMediaItem>,
  signal?: AbortSignal,
) {
  const planned = tracks.flatMap((track) =>
    track.muted
      ? []
      : track.clips.flatMap((clip) => {
          const media = mediaById.get(clip.mediaId);
          return media?.sourceUrl && (media.kind === "audio" || media.kind === "video") ? [{ clip, media }] : [];
        }),
  );
  if (planned.length === 0) return undefined;
  if (typeof AudioContext === "undefined") {
    throw new Error("当前浏览器不支持音频混合，无法导出包含声音的时间线");
  }

  const context = new AudioContext({ sampleRate: 48_000 });
  const destination = context.createMediaStreamDestination();
  const bufferCache = new Map<string, Promise<AudioBuffer>>();
  const loadBuffer = (media: DirectorMediaItem) => {
    const cached = bufferCache.get(media.id);
    if (cached) return cached;
    const loading = (async () => {
      throwIfAborted(signal);
      const response = await fetch(media.sourceUrl!);
      if (!response.ok) throw new Error(`${media.name} 的音频源读取失败 (${response.status})`);
      const encoded = await response.arrayBuffer();
      throwIfAborted(signal);
      try {
        return await context.decodeAudioData(encoded.slice(0));
      } catch {
        throw new Error(`${media.name} 的音频轨无法解码`);
      }
    })();
    bufferCache.set(media.id, loading);
    return loading;
  };

  const decoded = await Promise.all(
    planned.map(async ({ clip, media }) => ({ clip, buffer: await loadBuffer(media) })),
  );
  const scheduled: AudioBufferSourceNode[] = [];
  let started = false;
  let stopped = false;

  return {
    stream: destination.stream,
    start: async () => {
      if (started || stopped) return;
      started = true;
      await context.resume();
      const origin = context.currentTime + 0.035;
      decoded.forEach(({ clip, buffer }) => {
        const available = Math.max(0, buffer.duration - clip.inSec);
        const timelineDuration = Math.min(clip.durationSec, available / clip.playbackRate);
        if (timelineDuration <= 0) return;
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.playbackRate.value = clip.playbackRate;
        source.connect(gain).connect(destination);
        const startAt = origin + clip.startSec;
        const endAt = startAt + timelineDuration;
        const volume = clamp(clip.volume, 0, 1);
        gain.gain.cancelScheduledValues(startAt);
        if (clip.fadeInSec > 0) {
          gain.gain.setValueAtTime(0, startAt);
          gain.gain.linearRampToValueAtTime(volume, Math.min(endAt, startAt + clip.fadeInSec));
        } else {
          gain.gain.setValueAtTime(volume, startAt);
        }
        if (clip.fadeOutSec > 0) {
          const fadeOutAt = Math.max(startAt, endAt - clip.fadeOutSec);
          gain.gain.setValueAtTime(volume, fadeOutAt);
          gain.gain.linearRampToValueAtTime(0, endAt);
        }
        source.start(startAt, clip.inSec, timelineDuration * clip.playbackRate);
        scheduled.push(source);
      });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      scheduled.forEach((source) => {
        try {
          source.stop();
        } catch {
          // A source that ended naturally is already detached from the graph.
        }
      });
      destination.stream.getTracks().forEach((track) => track.stop());
      if (context.state !== "closed") await context.close();
    },
  };
}

/**
 * Export the full timeline as a video file.
 *
 * Renders every frame through the timeline compositor, mixes audio from all
 * unmuted tracks, and encodes the result into the requested container format.
 * Missing media, empty timelines, and unsupported browser features are
 * surfaced as errors before rendering begins.
 *
 * @param options - Export configuration including tracks, media, aspect ratio, and format.
 * @returns A video recording handle that can be saved or previewed.
 */
export async function exportDirectorTimelineVideo({
  tracks,
  mediaItems,
  aspectRatio,
  quality = "preview",
  fps = 24,
  format = "auto",
  signal,
  onProgress,
}: ExportDirectorTimelineVideoOptions): Promise<DirectorVideoRecording> {
  const mediaById = new Map(mediaItems.map((media) => [media.id, media]));
  const durationSec = getDirectorTimelineContentDuration(tracks, mediaById);
  if (durationSec <= 0) throw new Error("时间线没有可导出的画面剪辑");
  const missingMedia = tracks.flatMap((track) =>
    track.clips.filter((clip) => {
      if (clip.mediaId.startsWith("text:")) return false;
      const media = mediaById.get(clip.mediaId);
      const contributesPicture = track.kind === "video" && track.visible && media?.kind !== "audio";
      const contributesSound =
        !track.muted && (media?.kind === "audio" || media?.kind === "video" || media === undefined);
      if (!contributesPicture && !contributesSound) return false;
      return !media || (!media.sourceUrl && !media.thumbnailUrl);
    }),
  );
  if (missingMedia.length > 0) {
    throw new Error(`有 ${missingMedia.length} 个剪辑的源素材已丢失，请重新导入后再导出`);
  }
  const normalizedFps = clamp(fps, 1, 60);
  const totalFrames = Math.max(1, Math.ceil(durationSec * normalizedFps));
  const { width, height } = getDirectorTimelineRenderSize(aspectRatio, quality);
  const renderer = new DirectorTimelineFrameRenderer(tracks, mediaById, width, height, signal);
  const audioSource = await createDirectorTimelineAudioSource(tracks, mediaById, signal);
  try {
    const { recordDirectorVideo } = await import("../video/directorVideoExport");
    return await recordDirectorVideo({
      frameStart: 0,
      frameEnd: totalFrames - 1,
      fps: normalizedFps,
      format,
      signal,
      audioSource,
      captureFrame: (frame) => renderer.render(frame / normalizedFps),
      onProgress: (progress, frame) =>
        onProgress?.({
          phase: progress < 0.8 ? "rendering" : "encoding",
          progress,
          frame,
          totalFrames,
        }),
    });
  } finally {
    renderer.dispose();
    await audioSource?.stop();
  }
}
