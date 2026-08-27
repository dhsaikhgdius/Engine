import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  ArrowLeftToLine,
  Blend,
  CheckCircle2,
  Captions,
  Clapperboard,
  Copy,
  Download,
  Eye,
  EyeOff,
  Film,
  Image,
  Link2,
  Lock,
  Magnet,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  RotateCcw,
  Scissors,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  UnfoldHorizontal,
  Unlock,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  dispatchCreativeWorkspaceMediaProxyAttach,
  dispatchCreativeWorkspaceMediaRelink,
  dispatchCreativeWorkspaceMediaVerify,
  dispatchCreativeWorkspaceOperations,
  type CreativeWorkspaceOperationInput,
} from "../../../agent/dispatchCreativeWorkspaceOperations";
import {
  formatMediaProxyAttachSuccessMessage,
  parseMediaProxyAttachHonesty,
} from "../media/mediaProxyAttachPresentation";
import { formatMediaRelinkSuccessMessage, parseMediaRelinkHonesty } from "../media/mediaRelinkPresentation";
import { useLanguage } from "../../i18n/language";
import {
  DIRECTOR_COMMON_FRAME_RATES,
  formatDirectorFrameRate,
  frameRateToNumber,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  serializeDirectorFrameRate,
  supportsDirectorDropFrame,
  type DirectorTimelineTimebase,
} from "../timeline/frameRate";
import {
  directorTimelineTimecodeToFrame,
  formatDirectorTimelineTimecode,
  parseSmpteTimecode,
} from "../timeline/timecode";
import { probeCreativeMediaFile } from "../media/creativeMediaProbe";
import type { CreativeMediaPlaybackPreference } from "../media/creativeMediaEngineering";
import { MediaVerifyResultsList } from "../media/MediaVerifyResultsList";
import { creativeWorkspaceMediaVerifyResultSchema } from "../../../../../../packages/protocol/src/creativeWorkspaceProtocol";
import type { MediaVerifyUiState } from "../media/mediaVerifyPresentation";
import { persistentCreativeMediaLibrary } from "../media/persistentCreativeMediaStore";
import { MediaTranscriptionPanel } from "../media/MediaTranscriptionPanel";
import { useVideoRecordingStore } from "../video/videoRecordingStore";
import { CreativeMediaBrowser } from "./CreativeMediaBrowser";
import { CreativeMediaWaveform } from "./CreativeMediaWaveform";
import { useDirectorClipFilmstrip, type DirectorClipFilmstripRequest } from "./clipFilmstrip";
import { CreativeTransportDropdown } from "./CreativeTransportDropdown";
import { CreativeWorkspacePanelResizer, useCreativeWorkspacePanelLayout } from "./CreativeWorkspacePanelResizer";
import { installWindowPointerDrag } from "./windowPointerDrag";
import {
  CREATIVE_CLIP_NAME_MAX,
  insertDirectorCaptionCuesIntoTimeline,
  parseDirectorCaptionFile,
} from "./captionImport";
import { useDirectorStore } from "../store/directorStore";
import {
  CREATIVE_PROJECT_BUNDLE_FILE_NAME,
  exportCreativeProjectBundle,
  importCreativeProjectBundle,
  parseLegacyCreativeProjectJson,
} from "./creativeProjectBundle";
import {
  getDirectorMediaPreviewSource,
  importDirectorCreativeMediaProxyCandidate,
  persistDirectorMediaItem,
  useDirectorMediaLibrary,
  type DirectorMediaItem,
} from "./directorMediaLibrary";
import {
  exportDirectorTimelineVideo,
  getDirectorClipOpacityAtTime,
  getDirectorTimelineActiveAudioClips,
  getDirectorTimelineActiveLayers,
  getDirectorTimelineContentDuration,
  getDirectorTimelineRenderSize,
  type DirectorTimelineActiveLayer,
  type DirectorTimelineVideoFormat,
} from "./directorTimelineVideoExport";
import {
  DIRECTOR_MEDIA_DRAG_TYPE,
  findDirectorEditClip,
  findDirectorTransitionPredecessor,
  getDirectorEditDuration,
  getDirectorMediaDragSessionId,
  serializeDirectorCreativeWorkspacePersistedState,
  useDirectorCreativeWorkspaceStore,
  type DirectorEditClip,
  type DirectorEditTrack,
} from "./directorWorkspaceStore";
import {
  DIRECTOR_TIMELINE_BASE_PIXELS_PER_SECOND,
  DIRECTOR_TIMELINE_ZOOM_MAX,
  DIRECTOR_TIMELINE_ZOOM_MIN,
  clampDirectorTimelineZoom,
} from "./videoTimelineViewport";

const BASE_PIXELS_PER_SECOND = DIRECTOR_TIMELINE_BASE_PIXELS_PER_SECOND;
const TRACK_HEIGHT = 66;
const VIDEO_TITLEBAR_HEIGHT = 44;
const VIDEO_TRANSPORT_HEIGHT = 40;
const MIN_VIDEO_PREVIEW_HEIGHT = 220;
const MIN_VIDEO_TIMELINE_HEIGHT = 238;
const ASPECT_RATIO_OPTIONS = [
  { id: "16 / 9", label: "16:9" },
  { id: "9 / 16", label: "9:16" },
  { id: "1 / 1", label: "1:1" },
] as const;
// The workspace store clamps timeline zoom to [0.5, 4]; presets must stay inside.
const MIN_TIMELINE_ZOOM = DIRECTOR_TIMELINE_ZOOM_MIN;
const MAX_TIMELINE_ZOOM = DIRECTOR_TIMELINE_ZOOM_MAX;
const TIMELINE_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const CLIP_DRAG_THRESHOLD_PX = 4;
const MAGNETIC_SNAP_PX = 8;
const IMPORT_MESSAGE_TTL_MS = 6_000;
const TIMELINE_WINDOW_BUCKET_PX = 256;
const TIMELINE_WINDOW_OVERSCAN_PX = 512;

type VideoAssetDropTarget = {
  trackId: string;
  second: number;
};

export function snapDirectorTimelineSeconds(seconds: number, fps: number, enabled = true) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const safeFps = Math.max(1, Number.isFinite(fps) ? fps : 24);
  return enabled ? Math.round(safe * safeFps) / safeFps : safe;
}

/** Nearest edge within the threshold, or null so callers can fall back to frame snapping. */
export function magneticSnapDirectorTimelineSeconds(seconds: number, edges: readonly number[], thresholdSec: number) {
  let best: number | null = null;
  let bestDistance = Math.max(0, thresholdSec);
  for (const edge of edges) {
    if (!Number.isFinite(edge)) continue;
    const distance = Math.abs(edge - seconds);
    if (distance <= bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatRulerLabel(second: number) {
  const minutes = Math.floor(second / 60);
  const remainder = second % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function aspectRatioToNumber(aspectRatio: string) {
  const [width, height] = aspectRatio.split("/").map((part) => Number(part.trim()));
  return width && height ? width / height : 16 / 9;
}

/**
 * Visible pixel range of the timeline scroll viewport, used to window ruler
 * ticks and clips. The range snaps to 256px buckets with 512px of overscan on
 * both sides, so scrolling only re-renders the workspace when the window
 * crosses a bucket edge instead of on every pixel. When the container width is
 * unknown (jsdom, SSR, first paint) endPx is Infinity and everything renders,
 * which keeps behaviour identical to the unwindowed timeline.
 */
export function computeDirectorTimelineWindow(scrollLeft: number, clientWidth: number) {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) {
    return { startPx: 0, endPx: Number.POSITIVE_INFINITY };
  }
  const safeScrollLeft = Math.max(0, Number.isFinite(scrollLeft) ? scrollLeft : 0);
  return {
    startPx: Math.max(
      0,
      Math.floor((safeScrollLeft - TIMELINE_WINDOW_OVERSCAN_PX) / TIMELINE_WINDOW_BUCKET_PX) *
        TIMELINE_WINDOW_BUCKET_PX,
    ),
    endPx:
      Math.ceil((safeScrollLeft + clientWidth + TIMELINE_WINDOW_OVERSCAN_PX) / TIMELINE_WINDOW_BUCKET_PX) *
      TIMELINE_WINDOW_BUCKET_PX,
  };
}

/** Label seconds sparsely enough to stay readable at every zoom level (~≥96px apart). */
export function chooseDirectorRulerLabelInterval(pixelsPerSecond: number) {
  const intervals = [1, 2, 5, 10, 15, 30, 60];
  return intervals.find((interval) => interval * pixelsPerSecond >= 96) ?? 120;
}

/**
 * Playhead value the giant workspace renders from. During playback it is
 * quantized to 250ms buckets so the 60fps rAF loop only re-renders the main
 * component ~4 times per second (enough for button states like canSplit);
 * paused/scrubbing keeps full precision so interactions stay hand-tight.
 */
export function quantizeDirectorPlayheadForRender(seconds: number, playing: boolean) {
  return playing ? Math.floor(seconds * 4) / 4 : seconds;
}

/**
 * Cheap fingerprint of which clips are visible/audible at a given time.
 * Mirrors getDirectorTimelineActiveLayers + getDirectorTimelineActiveAudioClips
 * without allocating layer objects so it can run inside a store selector on
 * every 60fps playhead tick: the workspace re-renders exactly when the string
 * flips, i.e. at clip boundaries and track visibility/mute changes, keeping
 * preview layer switching frame-accurate despite the quantized playhead.
 */
export function computeDirectorActiveLayerSignature(
  tracks: DirectorEditTrack[],
  mediaById: ReadonlyMap<string, DirectorMediaItem>,
  timeSec: number,
) {
  let videoSignature = "";
  let audioSignature = "";
  for (const track of tracks) {
    if (track.kind === "video" && track.visible) {
      let active: DirectorEditClip | undefined;
      for (const clip of track.clips) {
        if (timeSec < clip.startSec || timeSec >= clip.startSec + clip.durationSec) continue;
        if (!active || clip.startSec >= active.startSec) active = clip;
      }
      if (active) videoSignature += `${track.id}:${active.id}|`;
    }
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (timeSec < clip.startSec || timeSec >= clip.startSec + clip.durationSec) continue;
      const media = mediaById.get(clip.mediaId);
      if (media && (media.kind === "audio" || media.kind === "video")) audioSignature += `${track.id}:${clip.id}|`;
    }
  }
  return `${videoSignature}~${audioSignature}`;
}

/** Desaturated professional palette: kind stays legible without neon tints. */
function getClipColor(media: DirectorMediaItem | undefined) {
  if (media?.kind === "audio") return "#4fae9d";
  if (media?.kind === "video") return "#d96d83";
  if (media?.kind === "shot") return "#45b3d6";
  return "#8f83d9";
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildPreviewLayerTransform(
  clip: Pick<DirectorEditClip, "positionX" | "positionY" | "scale" | "rotationDeg">,
  centered: boolean,
) {
  const x = `${(clip.positionX / 19.2).toFixed(4)}%`;
  const y = `${(clip.positionY / 10.8).toFixed(4)}%`;
  const translate = centered ? `translate3d(calc(-50% + ${x}), calc(-50% + ${y}), 0)` : `translate3d(${x}, ${y}, 0)`;
  return `${translate} scale(${clip.scale}) rotate(${clip.rotationDeg}deg)`;
}

function PreviewMediaLayer({
  layer,
  playheadSec,
  playing,
}: {
  layer: DirectorTimelineActiveLayer;
  playheadSec: number;
  playing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Root element of whichever branch rendered, for direct opacity writes while playing.
  const layerElRef = useRef<HTMLElement | null>(null);
  const { clip, media } = layer;
  const previewSource = media ? getDirectorMediaPreviewSource(media) : null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip || media?.kind !== "video" || !previewSource) return;
    // While playing the prop is quantized (~4Hz); read the store for the exact
    // time so this authoritative sync never fights the per-frame rAF driver.
    const timelineSec = playing ? useDirectorCreativeWorkspaceStore.getState().playheadSec : playheadSec;
    const desired = Math.min(
      clip.inSec + clip.durationSec * clip.playbackRate,
      Math.max(0, clip.inSec + (timelineSec - clip.startSec) * clip.playbackRate),
    );
    if (Number.isFinite(video.duration) && Math.abs(video.currentTime - desired) > 0.12) video.currentTime = desired;
    video.volume = 0;
    video.playbackRate = clip.playbackRate;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [clip, media?.kind, playheadSec, playing, previewSource]);

  // Playback self-drive: React stops feeding per-frame playhead values, so fade
  // opacity and currentTime drift correction write straight to the DOM at 60fps
  // without triggering renders. Transform/objectFit never depend on time and
  // stay owned by the render path below.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const timelineSec = useDirectorCreativeWorkspaceStore.getState().playheadSec;
      const element = layerElRef.current;
      if (element) {
        const nextOpacity = String(getDirectorClipOpacityAtTime(clip, timelineSec));
        if (element.style.opacity !== nextOpacity) element.style.opacity = nextOpacity;
      }
      const video = videoRef.current;
      if (video && media?.kind === "video") {
        const desired = Math.min(
          clip.inSec + clip.durationSec * clip.playbackRate,
          Math.max(0, clip.inSec + (timelineSec - clip.startSec) * clip.playbackRate),
        );
        if (Number.isFinite(video.duration) && Math.abs(video.currentTime - desired) > 0.12) {
          video.currentTime = desired;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clip, media?.kind, playing]);

  const setLayerElement = (node: HTMLElement | null) => {
    layerElRef.current = node;
  };
  const opacity = getDirectorClipOpacityAtTime(clip, playheadSec);
  const mediaStyle = {
    opacity,
    objectFit: clip.fit,
    transform: buildPreviewLayerTransform(clip, true),
  } as CSSProperties;

  if (layer.kind === "text") {
    return (
      <div
        className="creative-preview-title-overlay"
        ref={setLayerElement}
        style={{
          opacity,
          transform: buildPreviewLayerTransform(clip, false),
        }}
      >
        <span>{clip.name}</span>
      </div>
    );
  }
  if (!media || media.availability === "offline") {
    return (
      <div className="creative-preview-layer-missing" ref={setLayerElement} style={{ opacity }}>
        <TriangleAlert aria-hidden size={28} />
        <strong>素材离线，请重连</strong>
      </div>
    );
  }
  if (media.kind === "video" && previewSource) {
    return (
      <video
        className="creative-preview-media"
        muted
        playsInline
        preload="auto"
        poster={playing ? undefined : (media.thumbnailUrl ?? undefined)}
        ref={(node) => {
          videoRef.current = node;
          layerElRef.current = node;
        }}
        src={previewSource}
        style={mediaStyle}
      />
    );
  }
  if (previewSource) {
    return (
      <img
        alt={media.name}
        className="creative-preview-media"
        decoding="sync"
        draggable={false}
        ref={setLayerElement}
        src={previewSource}
        style={mediaStyle}
      />
    );
  }
  return (
    <div className="creative-preview-shot" ref={setLayerElement} style={{ opacity }}>
      <Clapperboard aria-hidden size={38} />
      <strong>{media.name}</strong>
      <span>{media.subtitle}</span>
    </div>
  );
}

function computePreviewAudioClipVolume(clip: DirectorEditClip, localTime: number) {
  const fadeIn = clip.fadeInSec > 0 ? Math.min(1, localTime / clip.fadeInSec) : 1;
  const fadeOut = clip.fadeOutSec > 0 ? Math.min(1, (clip.durationSec - localTime) / clip.fadeOutSec) : 1;
  return Math.max(0, Math.min(1, clip.volume * Math.min(fadeIn, fadeOut)));
}

function PreviewAudioClip({
  clip,
  media,
  playheadSec,
  playing,
}: {
  clip: DirectorEditClip;
  media: DirectorMediaItem;
  playheadSec: number;
  playing: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !media.sourceUrl) return;
    // Quantized prop while playing; the store carries the exact time (see PreviewMediaLayer).
    const timelineSec = playing ? useDirectorCreativeWorkspaceStore.getState().playheadSec : playheadSec;
    const localTime = Math.max(0, timelineSec - clip.startSec);
    const desired = Math.min(
      clip.inSec + clip.durationSec * clip.playbackRate,
      clip.inSec + localTime * clip.playbackRate,
    );
    if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - desired) > 0.12) audio.currentTime = desired;
    audio.volume = computePreviewAudioClipVolume(clip, localTime);
    audio.playbackRate = clip.playbackRate;
    if (playing) void audio.play().catch(() => undefined);
    else audio.pause();
  }, [clip, media.sourceUrl, playheadSec, playing]);

  // Playback self-drive: fade volume ramps and currentTime drift correction run
  // per frame against the live store playhead, without React renders.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) {
        const timelineSec = useDirectorCreativeWorkspaceStore.getState().playheadSec;
        const localTime = Math.max(0, timelineSec - clip.startSec);
        const desired = Math.min(
          clip.inSec + clip.durationSec * clip.playbackRate,
          clip.inSec + localTime * clip.playbackRate,
        );
        if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - desired) > 0.12) {
          audio.currentTime = desired;
        }
        const nextVolume = computePreviewAudioClipVolume(clip, localTime);
        if (audio.volume !== nextVolume) audio.volume = nextVolume;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clip, playing]);

  return <audio aria-hidden preload="auto" ref={audioRef} src={media.sourceUrl ?? undefined} />;
}

/**
 * The only components that re-render on every 60fps playhead tick: each
 * subscribes to the raw playheadSec itself and renders a single element, so
 * playback never repaints the surrounding workspace.
 */
function TimelinePlayheadIndicator({
  pixelsPerSecond,
  onHandlePointerDown,
  handleTitle,
}: {
  pixelsPerSecond: number;
  onHandlePointerDown: (event: ReactPointerEvent) => void;
  handleTitle: string;
}) {
  const playheadSec = useDirectorCreativeWorkspaceStore((state) => state.playheadSec);
  return (
    <div className="creative-timeline-playhead" style={{ left: playheadSec * pixelsPerSecond }}>
      <span onPointerDown={onHandlePointerDown} title={handleTitle} />
    </div>
  );
}

/**
 * Transport timecode readout; clicking swaps it for a SMPTE input so the
 * playhead can jump straight to a typed timecode (Enter commits, Esc cancels).
 */
function TransportTimecode({
  editTimebase,
  exportFps,
  onSeek,
}: {
  editTimebase: DirectorTimelineTimebase;
  exportFps: number;
  onSeek: (seconds: number) => void;
}) {
  const { t } = useLanguage();
  const playheadSec = useDirectorCreativeWorkspaceStore((state) => state.playheadSec);
  const [draft, setDraft] = useState<string | null>(null);
  const display = formatDirectorTimelineTimecode(Math.round(playheadSec * exportFps), editTimebase);
  if (draft !== null) {
    const commit = () => {
      const frame = directorTimelineTimecodeToFrame(draft, editTimebase);
      if (frame !== null) onSeek(Math.max(0, frame) / exportFps);
      setDraft(null);
    };
    return (
      <input
        aria-label={t("输入时码跳转")}
        autoFocus
        className="creative-transport-timecode-input"
        onBlur={commit}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") setDraft(null);
        }}
        spellCheck={false}
        value={draft}
      />
    );
  }
  return (
    <button
      className="creative-transport-timecode"
      onClick={() => setDraft(display)}
      title={`${formatTime(playheadSec)} · ${t("点击输入时码跳转")}`}
      type="button"
    >
      <time>{display}</time>
    </button>
  );
}

function PreviewTimecodeReadout({
  durationSec,
  editTimebase,
  exportFps,
}: {
  durationSec: number;
  editTimebase: DirectorTimelineTimebase;
  exportFps: number;
}) {
  const playheadSec = useDirectorCreativeWorkspaceStore((state) => state.playheadSec);
  return (
    <time title={`${formatTime(playheadSec)} / ${formatTime(durationSec)}`}>
      {formatDirectorTimelineTimecode(Math.round(playheadSec * exportFps), editTimebase)} /{" "}
      {formatDirectorTimelineTimecode(Math.round(durationSec * exportFps), editTimebase)}
    </time>
  );
}

function PreviewSurface({
  layers,
  playheadSec,
  playing,
  aspectRatio,
}: {
  layers: DirectorTimelineActiveLayer[];
  playheadSec: number;
  playing: boolean;
  aspectRatio: string;
}) {
  const previewStyle = { aspectRatio, "--preview-ar": aspectRatioToNumber(aspectRatio) } as CSSProperties;
  if (layers.length === 0) {
    return (
      <div className="creative-preview-empty" style={previewStyle}>
        <span className="creative-preview-empty-icon">
          <Film aria-hidden size={28} />
        </span>
        <div className="creative-preview-empty-copy">
          <strong>将素材添加到时间线</strong>
          <span>播放头经过剪辑时，这里会显示真实画面。</span>
        </div>
      </div>
    );
  }
  return (
    <div className="creative-preview-stack" style={previewStyle}>
      {layers.map((layer) => (
        <PreviewMediaLayer
          key={`${layer.trackId}:${layer.clip.id}`}
          layer={layer}
          playheadSec={playheadSec}
          playing={playing}
        />
      ))}
    </div>
  );
}

const FILMSTRIP_TILE_EDGE = 46;
const FILMSTRIP_DEBOUNCE_MS = 300;

/**
 * Filmstrip thumbnails for a video clip. The request is debounced so trim /
 * zoom churn keeps rendering the previous strip instead of resampling per frame.
 */
function ClipFilmstripStrip({
  mediaId,
  sourceUrl,
  inSec,
  timelineDurationSec,
  playbackRate,
  widthPx,
}: {
  mediaId: string;
  sourceUrl: string;
  inSec: number;
  timelineDurationSec: number;
  playbackRate: number;
  widthPx: number;
}) {
  const tileCount = Math.max(1, Math.min(240, Math.ceil(widthPx / FILMSTRIP_TILE_EDGE)));
  const desired = useMemo<DirectorClipFilmstripRequest>(
    () => ({
      mediaId,
      sourceUrl,
      inSec,
      timelineDurationSec,
      playbackRate,
      tileWidth: FILMSTRIP_TILE_EDGE,
      tileHeight: FILMSTRIP_TILE_EDGE,
      tileCount,
    }),
    [inSec, mediaId, playbackRate, sourceUrl, tileCount, timelineDurationSec],
  );
  const [settled, setSettled] = useState<DirectorClipFilmstripRequest | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(desired), FILMSTRIP_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [desired]);
  const filmstrip = useDirectorClipFilmstrip(settled);
  if (!filmstrip) return null;
  return (
    <div aria-hidden className="creative-clip-filmstrip">
      {filmstrip.tiles.map((tile, index) =>
        tile ? <img alt="" draggable={false} key={index} src={tile} /> : <span key={index} />,
      )}
    </div>
  );
}

interface ClipNumericFieldProps {
  label: ReactNode;
  value: number | string;
  ariaLabel?: string;
  disabled?: boolean;
  max?: number;
  min?: number;
  step?: number | string;
  type?: "number" | "range";
  onValueChange?: (value: number) => void;
}

type DirectorEditClipNumericField = {
  [Field in keyof DirectorEditClip]-?: DirectorEditClip[Field] extends number ? Field : never;
}[keyof DirectorEditClip];

/**
 * Property-panel number inputs commit discrete values, so they dispatch as
 * edit.clip.update patch fields through the shared agent contract. Range
 * sliders (opacity / volume / scale) are absent on purpose: they stream
 * continuous samples and keep the local store mutator.
 */
const CLIP_NUMERIC_PATCH_FIELDS = {
  startSec: "start_sec",
  durationSec: "duration_sec",
  inSec: "in_sec",
  playbackRate: "playback_rate",
  fadeInSec: "fade_in_sec",
  fadeOutSec: "fade_out_sec",
  positionX: "position_x",
  positionY: "position_y",
  rotationDeg: "rotation_deg",
} as const satisfies Partial<Record<DirectorEditClipNumericField, string>>;

function ClipNumericField({
  label,
  value,
  ariaLabel,
  disabled,
  max,
  min,
  step,
  type = "number",
  onValueChange,
}: ClipNumericFieldProps) {
  return (
    <label>
      <span>{label}</span>
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        max={max}
        min={min}
        onChange={onValueChange ? (event) => onValueChange(Number(event.currentTarget.value)) : undefined}
        step={step}
        type={type}
        value={value}
      />
    </label>
  );
}

export function VideoEditorWorkspace() {
  const { t } = useLanguage();
  const panelLayout = useCreativeWorkspacePanelLayout();
  const mediaItems = useDirectorMediaLibrary();
  const [playing, setPlaying] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  // Render-phase mirror so the store selector below can read the playback flag
  // without being re-created through state.
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const tracks = useDirectorCreativeWorkspaceStore((state) => state.editTracks);
  const selectedClipId = useDirectorCreativeWorkspaceStore((state) => state.selectedClipId);
  /**
   * The workspace no longer subscribes to the raw 60fps playhead. While playing
   * this value snaps to 250ms buckets (zustand v5 skips the re-render when the
   * selected number is Object.is-equal); paused/scrubbing it is exact.
   * Frame-accurate preview switching is covered by the signature subscription
   * declared after mediaById below.
   */
  const renderPlayheadSec = useDirectorCreativeWorkspaceStore((state) =>
    quantizeDirectorPlayheadForRender(state.playheadSec, playingRef.current),
  );
  const timelineZoom = useDirectorCreativeWorkspaceStore((state) => state.timelineZoom);
  const editSettings = useDirectorCreativeWorkspaceStore((state) => state.editSettings);
  // Clip add ("+" placement / duplicate-after), split/remove/transition, discrete
  // fade steps, keyboard frame nudges, clip rename / title text, track
  // management, settings, import cataloging, undo/redo, media relink, proxy
  // attach, and media-less text/caption clips (`text:` / `text:caption:…`)
  // dispatch through the shared agent contract
  // (dispatchCreativeWorkspaceOperations / dispatchCreativeWorkspaceMediaRelink).
  // Mid-gesture clip drag/trim stays locally batched; pointer-up commits via
  // edit.clip.move / edit.clip.update with overwrite:true (same resolver +
  // receipt effects Agents see). Continuous fade drags, range sliders, and
  // mid-typing name states the contract cannot express keep the direct store
  // mutators. Explicit media drops, keyboard nudges, and duplicate-after share
  // overwrite placement. Discrete timeline zoom (presets, +/- buttons, fit)
  // shares edit.timeline.set_zoom / edit.timeline.fit; continuous
  // ctrl/cmd-wheel zoom and scroll anchoring stay local.
  const updateClip = useDirectorCreativeWorkspaceStore((state) => state.updateClip);
  const moveClipToTrack = useDirectorCreativeWorkspaceStore((state) => state.moveClipToTrack);
  const selectClip = useDirectorCreativeWorkspaceStore((state) => state.selectClip);
  const setPlayhead = useDirectorCreativeWorkspaceStore((state) => state.setPlayhead);
  const beginHistoryBatch = useDirectorCreativeWorkspaceStore((state) => state.beginHistoryBatch);
  const endHistoryBatch = useDirectorCreativeWorkspaceStore((state) => state.endHistoryBatch);
  const canUndo = useDirectorCreativeWorkspaceStore((state) => state.canUndo);
  const canRedo = useDirectorCreativeWorkspaceStore((state) => state.canRedo);
  const addRecording = useVideoRecordingStore((state) => state.addRecording);
  const loadCreativeWorkspace = useDirectorCreativeWorkspaceStore((state) => state.loadCreativeWorkspace);
  const [inspectorTab, setInspectorTab] = useState<"properties" | "effects">("properties");
  const [exportOpen, setExportOpen] = useState(false);
  const [transcriptionMediaId, setTranscriptionMediaId] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<DirectorTimelineVideoFormat>("auto");
  const [exportProgress, setExportProgress] = useState<{
    phase: "rendering" | "encoding";
    progress: number;
    frame: number;
    totalFrames: number;
  } | null>(null);
  const [exportError, setExportError] = useState("");
  const [exportResult, setExportResult] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [mediaVerifyState, setMediaVerifyState] = useState<MediaVerifyUiState>({ status: "idle" });
  const [projectBusy, setProjectBusy] = useState(false);
  // Loading a project replaces the timeline and clears undo history, so a
  // non-empty timeline requires an inline confirmation before the file loads.
  const [pendingProjectImport, setPendingProjectImport] = useState<File | null>(null);
  const [startTimecodeDraft, setStartTimecodeDraft] = useState("00:00:00:00");
  const [trackMenuId, setTrackMenuId] = useState<string | null>(null);
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  const [trackNameDraft, setTrackNameDraft] = useState("");
  const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
  const [assetDropTarget, setAssetDropTarget] = useState<VideoAssetDropTarget | null>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [clipContextMenu, setClipContextMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const [trimmingClip, setTrimmingClip] = useState<{ clipId: string; side: "start" | "end" } | null>(null);
  // Timeline windowing state; starts unbounded until the viewport is measured.
  const [timelineWindow, setTimelineWindow] = useState(() => computeDirectorTimelineWindow(0, 0));
  const clipContextMenuRef = useRef<HTMLDivElement | null>(null);
  const videoMainRef = useRef<HTMLElement | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingZoomAnchorRef = useRef<{ timeSec: number; offsetPx: number } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const projectImportRef = useRef<HTMLInputElement | null>(null);
  const captionImportRef = useRef<HTMLInputElement | null>(null);
  const relinkInputRef = useRef<HTMLInputElement | null>(null);
  const proxyInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMediaTargetRef = useRef<DirectorMediaItem | null>(null);
  const waveformInFlightRef = useRef(new Set<string>());
  const playbackStartedRef = useRef({ time: 0, playhead: 0 });
  const mediaById = useMemo(() => new Map(mediaItems.map((item) => [item.id, item])), [mediaItems]);
  /**
   * Frame-accurate boundary detection: this string only changes when the set of
   * active preview layers / audible clips changes, so during playback the
   * workspace re-renders exactly at clip edges instead of every frame.
   */
  const activeLayerSignature = useDirectorCreativeWorkspaceStore((state) =>
    computeDirectorActiveLayerSignature(state.editTracks, mediaById, state.playheadSec),
  );
  const { aspectRatio, exportQuality, snapEnabled } = editSettings;
  const editTimebase = useMemo(
    () => normalizeDirectorTimebase(editSettings.timebase, editSettings.fps),
    [editSettings.fps, editSettings.timebase],
  );
  const exportFps = frameRateToNumber(editTimebase.rate);
  const selected = findDirectorEditClip(tracks, selectedClipId);
  const selectedMedia = selected ? mediaById.get(selected.clip.mediaId) : undefined;
  const selectedPersistentMedia = selectedMedia ? persistentCreativeMediaLibrary.getAsset(selectedMedia.id) : null;
  const transcriptionAsset = transcriptionMediaId
    ? persistentCreativeMediaLibrary.getAsset(transcriptionMediaId)
    : null;
  const selectedIsTimedMedia = selectedMedia?.kind === "video" || selectedMedia?.kind === "audio";
  /**
   * Shared UI entry into the creative workspace agent contract. Applies one
   * atomic mutation (or batch) and surfaces contract rejections in the status
   * line instead of silently no-oping.
   */
  const dispatchVideo = useCallback(
    (operations: CreativeWorkspaceOperationInput | CreativeWorkspaceOperationInput[], failureTitle: string) => {
      const receipt = dispatchCreativeWorkspaceOperations(operations);
      if (!receipt.ok) setImportMessage(`${failureTitle}：${receipt.error}`);
      return receipt;
    },
    [],
  );
  const updateSelectedClipNumber = (field: DirectorEditClipNumericField, value: number) => {
    // Number inputs emit NaN while the field is being cleared mid-typing.
    if (!selected || !Number.isFinite(value)) return;
    const patchField = CLIP_NUMERIC_PATCH_FIELDS[field as keyof typeof CLIP_NUMERIC_PATCH_FIELDS];
    if (patchField) {
      dispatchVideo(
        { op: "edit.clip.update", clip_id: selected.clip.id, patch: { [patchField]: value } },
        t("剪辑更新失败"),
      );
      return;
    }
    // Range sliders (opacity / volume / scale) stream continuous samples and keep the local mutator.
    updateClip(selected.clip.id, { [field]: value } as Partial<DirectorEditClip>);
  };
  /**
   * Clip rename (and title/caption text, which renders the clip name) shares
   * `edit.clip.update` with Agents, mirroring the Stage object-rename policy:
   * every expressible keystroke round-trips the contract so a locked track
   * surfaces a rejection instead of silently no-oping. Only mid-typing states
   * the contract cannot express — an emptied field or leading/trailing
   * whitespace the schema would trim away — keep the legacy writer.
   */
  const updateSelectedClipName = (value: string) => {
    if (!selected) return;
    if (!value.trim() || value !== value.trim() || value.length > CREATIVE_CLIP_NAME_MAX) {
      updateClip(selected.clip.id, { name: value });
      return;
    }
    dispatchVideo({ op: "edit.clip.update", clip_id: selected.clip.id, patch: { name: value } }, t("剪辑重命名失败"));
  };
  const duration = getDirectorEditDuration(tracks);
  const contentDuration = getDirectorTimelineContentDuration(tracks, mediaById);
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * timelineZoom;
  const timelineWidth = Math.max(960, duration * pixelsPerSecond);
  // Keyed by the layer signature instead of the raw playhead: within one clip
  // interval the layer set is identical, and at boundaries the signature
  // subscription forces a render where the live store playhead is exact.
  const activeLayers = useMemo(
    () => getDirectorTimelineActiveLayers(tracks, mediaById, useDirectorCreativeWorkspaceStore.getState().playheadSec),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeLayerSignature stands in for playheadSec
    [mediaById, tracks, activeLayerSignature],
  );
  const activeAudioClips = useMemo(
    () =>
      getDirectorTimelineActiveAudioClips(tracks, mediaById, useDirectorCreativeWorkspaceStore.getState().playheadSec),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeLayerSignature stands in for playheadSec
    [mediaById, tracks, activeLayerSignature],
  );
  const totalClipCount = useMemo(() => tracks.reduce((count, track) => count + track.clips.length, 0), [tracks]);

  useEffect(() => setStartTimecodeDraft(editTimebase.startTimecode), [editTimebase.startTimecode]);

  // The edit.settings.update contract re-derives drop-frame validity and
  // converts the start timecode separator, so the UI only states the intent.
  function updateEditFrameRate(serializedRate: string) {
    const rate = normalizeDirectorFrameRate(serializedRate, editTimebase.rate);
    dispatchVideo(
      {
        op: "edit.settings.update",
        patch: { frame_rate: { numerator: rate.numerator, denominator: rate.denominator } },
      },
      t("时间基准更新失败"),
    );
  }

  function toggleEditDropFrame() {
    if (!supportsDirectorDropFrame(editTimebase.rate)) return;
    dispatchVideo(
      { op: "edit.settings.update", patch: { drop_frame: !editTimebase.dropFrame } },
      t("时间基准更新失败"),
    );
  }

  function commitEditStartTimecode() {
    const parsed = parseSmpteTimecode(startTimecodeDraft, editTimebase.rate, {
      dropFrame: editTimebase.dropFrame,
    });
    if (!parsed) {
      setStartTimecodeDraft(editTimebase.startTimecode);
      return;
    }
    const receipt = dispatchVideo(
      { op: "edit.settings.update", patch: { start_timecode: parsed.timecode } },
      t("时间基准更新失败"),
    );
    if (!receipt.ok) setStartTimecodeDraft(editTimebase.startTimecode);
  }

  /**
   * Keep the anchored timeline instant under the same viewport pixel across a
   * discrete zoom change. The zoom write itself dispatches the shared
   * `edit.timeline.set_zoom`, the same op Agents send; only the scroll anchor
   * stays a local DOM concern.
   */
  function applyTimelineZoom(zoomInput: number, anchor?: { timeSec: number; offsetPx: number }) {
    const nextZoom = clampDirectorTimelineZoom(zoomInput);
    if (nextZoom === timelineZoom) return;
    const scroller = timelineScrollRef.current;
    if (scroller) {
      const playheadSec = useDirectorCreativeWorkspaceStore.getState().playheadSec;
      const playheadOffset = playheadSec * pixelsPerSecond - scroller.scrollLeft;
      pendingZoomAnchorRef.current = anchor ?? {
        timeSec: playheadSec,
        offsetPx: Math.min(Math.max(playheadOffset, 0), scroller.clientWidth),
      };
    }
    const receipt = dispatchVideo({ op: "edit.timeline.set_zoom", zoom: nextZoom }, t("时间线缩放失败"));
    if (!receipt.ok) pendingZoomAnchorRef.current = null;
  }

  const followPlayhead = useCallback((seconds: number, mode: "playback" | "seek") => {
    const scroller = timelineScrollRef.current;
    if (!scroller || scroller.clientWidth === 0) return;
    const zoom = useDirectorCreativeWorkspaceStore.getState().timelineZoom;
    const playheadX = seconds * BASE_PIXELS_PER_SECOND * zoom;
    const margin = 48;
    if (playheadX < scroller.scrollLeft + margin) {
      scroller.scrollLeft = Math.max(0, playheadX - margin);
    } else if (playheadX > scroller.scrollLeft + scroller.clientWidth - margin) {
      const lead = mode === "playback" ? scroller.clientWidth * 0.15 : scroller.clientWidth - margin;
      scroller.scrollLeft = Math.max(0, playheadX - lead);
    }
  }, []);

  /** Restart from the top when play is pressed at the very end of the timeline. */
  function togglePlayback() {
    if (!playing && useDirectorCreativeWorkspaceStore.getState().playheadSec >= duration - 1 / exportFps) {
      setPlayhead(0);
    }
    setPlaying((current) => !current);
  }

  /** Pause, clamp to the timeline, move the playhead, and keep it in view. */
  function seekTransportTo(seconds: number) {
    setPlaying(false);
    const next = Math.min(duration, Math.max(0, seconds));
    setPlayhead(next);
    followPlayhead(next, "seek");
  }

  /**
   * Fit the whole edited content into the visible timeline viewport through
   * the shared `edit.timeline.fit` (the executor derives the content span the
   * same way for the UI and for Agents; only the live width is measured here).
   */
  function zoomTimelineToFit() {
    const scroller = timelineScrollRef.current;
    if (!scroller || scroller.clientWidth <= 0) return;
    pendingZoomAnchorRef.current = { timeSec: 0, offsetPx: 0 };
    const receipt = dispatchVideo(
      { op: "edit.timeline.fit", surface_width: scroller.clientWidth },
      t("时间线缩放失败"),
    );
    if (!receipt.ok) {
      pendingZoomAnchorRef.current = null;
      return;
    }
    if ((receipt.execution.result as { unchanged?: boolean }).unchanged) {
      pendingZoomAnchorRef.current = null;
      scroller.scrollLeft = 0;
    }
  }

  function collectTimelineSnapEdges(excludeClipId?: string) {
    const edges = [0, useDirectorCreativeWorkspaceStore.getState().playheadSec];
    tracks.forEach((track) =>
      track.clips.forEach((clip) => {
        if (clip.id === excludeClipId) return;
        edges.push(clip.startSec, clip.startSec + clip.durationSec);
      }),
    );
    return edges;
  }

  const topPreviewLayer = activeLayers.at(-1);
  const exportSize = getDirectorTimelineRenderSize(aspectRatio, exportQuality);
  const exporting = exportProgress !== null;

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      exportAbortRef.current?.abort();
    },
    [],
  );

  // Closing the tab mid-export silently discards minutes of rendering work, so
  // the browser must ask for confirmation while an export runs.
  useEffect(() => {
    if (!exporting) return;
    function warnBeforeUnloadDuringExport(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeUnloadDuringExport);
    return () => window.removeEventListener("beforeunload", warnBeforeUnloadDuringExport);
  }, [exporting]);

  useEffect(() => {
    const clearAssetDropTarget = () => setAssetDropTarget(null);
    window.addEventListener("dragend", clearAssetDropTarget);
    window.addEventListener("drop", clearAssetDropTarget);
    return () => {
      window.removeEventListener("dragend", clearAssetDropTarget);
      window.removeEventListener("drop", clearAssetDropTarget);
    };
  }, []);

  useLayoutEffect(() => {
    const anchor = pendingZoomAnchorRef.current;
    const scroller = timelineScrollRef.current;
    if (!anchor || !scroller) return;
    pendingZoomAnchorRef.current = null;
    scroller.scrollLeft = Math.max(0, anchor.timeSec * BASE_PIXELS_PER_SECOND * timelineZoom - anchor.offsetPx);
  }, [timelineZoom]);

  /** Re-measure the timeline window; only sets state when a bucket edge was crossed. */
  const syncTimelineWindow = useCallback(() => {
    const scroller = timelineScrollRef.current;
    const next = scroller
      ? computeDirectorTimelineWindow(scroller.scrollLeft, scroller.clientWidth)
      : computeDirectorTimelineWindow(0, 0);
    setTimelineWindow((current) => (current.startPx === next.startPx && current.endPx === next.endPx ? current : next));
  }, []);

  /**
   * Zoom rescales content width and the anchor effect above rewrites
   * scrollLeft in the same commit, so re-measure the window right after it.
   * Declared below the anchor effect on purpose: layout effects run in order.
   */
  useLayoutEffect(() => {
    syncTimelineWindow();
  }, [syncTimelineWindow, timelineZoom]);

  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    syncTimelineWindow();
    let frame = 0;
    // Every scrollLeft writer lands here as a scroll event (user scrolling,
    // autoScrollTimeline, followPlayhead, wheel-zoom anchoring), so the window
    // never assumes who moved the viewport. Leading call keeps the window
    // hand-tight; the trailing rAF coalesces scroll streams to one check per
    // frame.
    function scheduleTimelineWindowSync() {
      if (frame) return;
      syncTimelineWindow();
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncTimelineWindow();
      });
    }
    scroller.addEventListener("scroll", scheduleTimelineWindowSync, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleTimelineWindowSync) : null;
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", scheduleTimelineWindowSync);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [syncTimelineWindow]);

  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    // Native listener: React marks onWheel passive, which forbids preventDefault.
    function zoomFromWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const store = useDirectorCreativeWorkspaceStore.getState();
      const nextZoom = clampDirectorTimelineZoom(store.timelineZoom * Math.exp(-event.deltaY * 0.0024));
      if (nextZoom === store.timelineZoom || !scroller) return;
      const offsetX = event.clientX - scroller.getBoundingClientRect().left;
      pendingZoomAnchorRef.current = {
        timeSec: (scroller.scrollLeft + offsetX) / (BASE_PIXELS_PER_SECOND * store.timelineZoom),
        offsetPx: offsetX,
      };
      store.setTimelineZoom(nextZoom);
    }
    scroller.addEventListener("wheel", zoomFromWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", zoomFromWheel);
  }, []);

  useEffect(() => {
    if (!trackMenuId) return;
    function dismissTrackMenu(event: Event) {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".creative-track-menu") || target?.closest?.("button.is-menu")) return;
      setTrackMenuId(null);
    }
    window.addEventListener("pointerdown", dismissTrackMenu, true);
    return () => window.removeEventListener("pointerdown", dismissTrackMenu, true);
  }, [trackMenuId]);

  useEffect(() => {
    if (!clipContextMenu) return;
    function dismissClipContextMenu(event: Event) {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".creative-clip-context-menu")) return;
      setClipContextMenu(null);
    }
    window.addEventListener("pointerdown", dismissClipContextMenu, true);
    return () => window.removeEventListener("pointerdown", dismissClipContextMenu, true);
  }, [clipContextMenu]);

  useEffect(() => {
    if (clipContextMenu && !findDirectorEditClip(tracks, clipContextMenu.clipId)) setClipContextMenu(null);
  }, [clipContextMenu, tracks]);

  /** Keep the fixed context menu on screen: flip across the pointer, then clamp to the viewport. */
  useLayoutEffect(() => {
    const menu = clipContextMenuRef.current;
    if (!menu || !clipContextMenu) return;
    const { width, height } = menu.getBoundingClientRect();
    let left = clipContextMenu.x;
    let top = clipContextMenu.y;
    if (left + width > window.innerWidth - 8) left = Math.max(8, clipContextMenu.x - width);
    if (top + height > window.innerHeight - 8) top = Math.max(8, clipContextMenu.y - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [clipContextMenu]);

  useEffect(() => {
    if (!exportOpen) return;
    function closeExportOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && exportAbortRef.current === null) setExportOpen(false);
    }
    window.addEventListener("keydown", closeExportOnEscape);
    return () => window.removeEventListener("keydown", closeExportOnEscape);
  }, [exportOpen]);

  useEffect(() => {
    if (!importMessage || projectBusy) return;
    const timer = window.setTimeout(() => setImportMessage(""), IMPORT_MESSAGE_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [importMessage, projectBusy]);

  useEffect(() => {
    setMediaVerifyState({ status: "idle" });
  }, [selectedClipId]);

  useEffect(() => {
    const referencedIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.mediaId)));
    mediaItems.forEach((media) => {
      const waveformAssetId = media.playbackSource?.variant === "proxy" ? media.playbackSource.assetId : media.id;
      if (
        !referencedIds.has(media.id) ||
        media.waveform ||
        (media.kind !== "audio" && media.kind !== "video") ||
        !waveformAssetId ||
        waveformInFlightRef.current.has(waveformAssetId) ||
        !persistentCreativeMediaLibrary.getAsset(waveformAssetId)
      ) {
        return;
      }
      waveformInFlightRef.current.add(waveformAssetId);
      void persistentCreativeMediaLibrary
        .ensureWaveform(waveformAssetId)
        .catch(() => undefined)
        .finally(() => waveformInFlightRef.current.delete(waveformAssetId));
    });
  }, [mediaItems, tracks]);

  useEffect(() => {
    function handleEditorShortcut(event: KeyboardEvent) {
      if (exportOpen) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && (target.isContentEditable || target.getAttribute("role") === "separator"))
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === "z") {
        event.preventDefault();
        // Empty history stays a silent no-op for shortcuts (the contract
        // rejects with a conflict), matching the pre-dispatch behavior.
        if (event.shiftKey) {
          if (canRedo) dispatchVideo({ op: "workspace.redo" }, t("重做失败"));
        } else if (canUndo) {
          dispatchVideo({ op: "workspace.undo" }, t("撤销失败"));
        }
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && key === "y") {
        event.preventDefault();
        if (canRedo) dispatchVideo({ op: "workspace.redo" }, t("重做失败"));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === "d") {
        event.preventDefault();
        if (selected) duplicateClip(selected.clip, selected.track);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " " || event.code === "Space") {
        // A focused button/link keeps its native Space activation.
        if (target instanceof HTMLElement && target.closest("button, a, [role='menuitem'], [role='tab']")) return;
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (event.key === "Escape") {
        if (clipContextMenu) setClipContextMenu(null);
        else if (trackMenuId) setTrackMenuId(null);
        else if (selectedClipId) selectClip(null);
        return;
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedClipId) {
        event.preventDefault();
        // Shift+Delete ripple-deletes: later clips on the track close the gap.
        dispatchVideo(
          { op: "edit.clip.remove", clip_id: selectedClipId, ...(event.shiftKey ? { ripple: true } : {}) },
          t("剪辑删除失败"),
        );
        return;
      }
      if (key === "s" && selected) {
        const playheadSec = useDirectorCreativeWorkspaceStore.getState().playheadSec;
        const canCut =
          playheadSec > selected.clip.startSec + 0.1 &&
          playheadSec < selected.clip.startSec + selected.clip.durationSec - 0.1;
        if (canCut) {
          event.preventDefault();
          dispatchVideo({ op: "edit.clip.split", clip_id: selected.clip.id, at_sec: playheadSec }, t("剪辑分割失败"));
        }
        return;
      }
      // Match the physical , / . keys too, since Shift turns them into < / > on many layouts.
      const nudgeDirection =
        event.code === "Comma" || event.key === "," || event.key === "<"
          ? -1
          : event.code === "Period" || event.key === "." || event.key === ">"
            ? 1
            : 0;
      if (nudgeDirection !== 0 && selected) {
        event.preventDefault();
        const step = (event.shiftKey ? 1 : 1 / exportFps) * nudgeDirection;
        dispatchVideo(
          {
            op: "edit.clip.update",
            clip_id: selected.clip.id,
            patch: { start_sec: Math.max(0, selected.clip.startSec + step) },
            overwrite: true,
          },
          t("剪辑微移失败"),
        );
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setPlaying(false);
        const next = event.key === "Home" ? 0 : Math.min(duration, contentDuration);
        setPlayhead(next);
        followPlayhead(next, "seek");
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        const step = event.shiftKey ? 1 : 1 / exportFps;
        const playheadSec = useDirectorCreativeWorkspaceStore.getState().playheadSec;
        const next = Math.min(duration, Math.max(0, playheadSec + (event.key === "ArrowLeft" ? -step : step)));
        setPlayhead(next);
        followPlayhead(next, "seek");
      }
    }
    window.addEventListener("keydown", handleEditorShortcut);
    return () => window.removeEventListener("keydown", handleEditorShortcut);
  });

  useEffect(() => {
    if (!playing) return;
    playbackStartedRef.current = {
      time: performance.now(),
      playhead: useDirectorCreativeWorkspaceStore.getState().playheadSec,
    };
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = (now - playbackStartedRef.current.time) / 1000;
      const next = playbackStartedRef.current.playhead + elapsed;
      if (next >= duration) {
        if (loopPlayback && duration > 0) {
          playbackStartedRef.current = { time: now, playhead: 0 };
          setPlayhead(0);
          followPlayhead(0, "playback");
          frame = requestAnimationFrame(tick);
          return;
        }
        setPlayhead(0);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      followPlayhead(next, "playback");
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, followPlayhead, loopPlayback, playing, setPlayhead]);

  async function beginVideoExport() {
    setPlaying(false);
    setExportError("");
    setExportResult("");
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    setExportProgress({ phase: "rendering", progress: 0, frame: 0, totalFrames: 1 });
    try {
      const recording = await exportDirectorTimelineVideo({
        tracks,
        mediaItems,
        aspectRatio,
        quality: exportQuality,
        fps: exportFps,
        format: exportFormat,
        signal: controller.signal,
        onProgress: setExportProgress,
      });
      const libraryRecording = addRecording(recording);
      try {
        await persistentCreativeMediaLibrary.importBlob(recording.blob, {
          kind: "video",
          name: libraryRecording.name,
          fileName: libraryRecording.fileName,
          durationSec: recording.durationSec,
          source: "video-editor-export",
        });
      } catch (persistError) {
        setImportMessage(
          `${t("视频已导出，但未能写入持久媒体库")}：${
            persistError instanceof Error ? persistError.message : t("未知错误")
          }`,
        );
      }
      const { downloadDirectorVideo } = await import("../video/directorVideoExport");
      downloadDirectorVideo(recording, "director-edit");
      setExportResult(
        `${recording.extension.toUpperCase()} · ${recording.frameCount} 帧 · ${recording.durationSec.toFixed(2)}s${
          recording.fallbackFrom ? " · MP4 不可用，已安全降级" : ""
        }`,
      );
      selectClip(null);
      setPlayhead(0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setExportError("已取消导出");
      } else {
        setExportError(error instanceof Error ? error.message : "视频导出失败");
      }
    } finally {
      exportAbortRef.current = null;
      setExportProgress(null);
    }
  }

  async function importMediaFiles(files: File[]) {
    setImportMessage(t("正在导入素材…"));
    let imported = 0;
    try {
      for (const file of files) {
        const probe = await probeCreativeMediaFile(file);
        const asset = await persistentCreativeMediaLibrary.importFile(file, probe);
        // Cataloging routes through the shared agent contract so UI imports
        // produce the same gallery revision and receipts as agent imports.
        const cataloged = dispatchCreativeWorkspaceOperations({
          op: "gallery.media.update",
          media_id: asset.id,
          patch: { added_at: new Date().toISOString() },
        });
        if (!cataloged.ok) throw new Error(`${file.name}: ${cataloged.error}`);
        imported += 1;
      }
      setImportMessage(`${t("已导入")} ${imported} ${t("项素材")}`);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : t("素材导入失败"));
    }
  }

  function requestCreativeProjectImport(file: File) {
    if (totalClipCount > 0) {
      setPendingProjectImport(file);
      return;
    }
    void importCreativeProject(file);
  }

  async function importCreativeProject(file: File) {
    setProjectBusy(true);
    setImportMessage(t("正在导入工程…"));
    try {
      const isZip = file.name.toLowerCase().endsWith(".zip") || file.type.includes("zip");
      if (isZip) {
        const imported = await importCreativeProjectBundle(file);
        if (!loadCreativeWorkspace(imported.serialized)) throw new Error(t("工程文件格式无效或已损坏"));
        if (imported.stageProject) useDirectorStore.getState().replaceProject(imported.stageProject);
        setImportMessage(imported.stageProject ? t("工程包、3D 片场与媒体已完整恢复") : t("工程包与媒体已完整恢复"));
        return;
      }
      const serialized = parseLegacyCreativeProjectJson(await file.text());
      if (!loadCreativeWorkspace(serialized)) throw new Error(t("工程文件格式无效或已损坏"));
      setImportMessage(t("工程已恢复；缺失的外部素材会在媒体库中明确标记"));
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : t("工程导入失败"));
    } finally {
      setProjectBusy(false);
    }
  }

  async function exportCreativeProject() {
    setProjectBusy(true);
    setImportMessage(t("正在打包工程与媒体…"));
    try {
      const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
      const bundle = await exportCreativeProjectBundle({
        serialized,
        stageProject: useDirectorStore.getState().project,
        mediaSources: mediaItems.map((item) => ({
          id: item.id,
          sourceUrl: item.sourceUrl ?? item.thumbnailUrl,
          kind: item.kind === "shot" ? "image" : item.kind,
          name: item.name,
          fileName: item.fileName ?? undefined,
          mimeType: item.mimeType ?? undefined,
          durationSec: item.durationSec,
          source: item.collection,
          embeddedMetadata: item.embeddedMetadata ?? null,
          transcript: item.transcript ?? null,
        })),
      });
      downloadBlob(bundle, CREATIVE_PROJECT_BUNDLE_FILE_NAME);
      setImportMessage(t("工程包已导出，包含 3D 片场与所有被引用的本地媒体"));
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : t("工程导出失败"));
    } finally {
      setProjectBusy(false);
    }
  }

  function resolveDefaultTrackId(kind: DirectorEditTrack["kind"]) {
    const candidates = tracks.filter((track) => track.kind === kind);
    return (candidates.find((track) => !track.locked) ?? candidates[0])?.id ?? null;
  }

  /** First position at or after desiredStart where the track has room for durationSec. */
  function findTrackFreeStart(track: DirectorEditTrack, desiredStart: number, durationSec: number) {
    const epsilon = 1e-6;
    const ranges = track.clips
      .map((clip) => ({ start: clip.startSec, end: clip.startSec + clip.durationSec }))
      .sort((left, right) => left.start - right.start);
    let candidate = desiredStart;
    for (const range of ranges) {
      if (range.end <= candidate + epsilon) continue;
      if (range.start >= candidate + durationSec - epsilon) break;
      candidate = range.end;
    }
    return candidate;
  }

  /**
   * With an explicit start (drag & drop) the clip lands exactly there and
   * overwrites whatever it covers; without one (the + button) it queues into
   * the first free slot at or after the playhead so repeated adds line up
   * instead of eating each other.
   */
  async function addMediaToTimeline(item: DirectorMediaItem, trackId?: string, start?: number) {
    const explicitPlacement = start !== undefined;
    const targetTrackId = trackId ?? resolveDefaultTrackId(item.kind === "audio" ? "audio" : "video");
    const targetTrack = tracks.find((track) => track.id === targetTrackId);
    if (!targetTrackId || !targetTrack) {
      setImportMessage(t(item.kind === "audio" ? "没有可用的音频轨道" : "没有可用的视频轨道"));
      return;
    }
    let mediaId: string;
    try {
      mediaId = await persistDirectorMediaItem(item);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : t("素材写入媒体库失败"));
      return;
    }
    const durationSec = Math.min(Math.max(item.durationSec || 3, 0.1), 60 * 60);
    const desiredStart = snapDirectorTimelineSeconds(
      start ?? useDirectorCreativeWorkspaceStore.getState().playheadSec,
      exportFps,
      snapEnabled,
    );
    if (!explicitPlacement) {
      // "+" placement queues into the first free slot, so the add is a plain
      // edit.clip.add with no overwrite and routes through the shared contract.
      dispatchVideo(
        {
          op: "edit.clip.add",
          track_id: targetTrackId,
          media_id: mediaId,
          name: item.name.trim().slice(0, 200) || t("未命名剪辑"),
          start_sec: findTrackFreeStart(targetTrack, desiredStart, durationSec),
          duration_sec: durationSec,
          source_duration_sec: item.kind === "video" || item.kind === "audio" ? durationSec : 60 * 60,
        },
        t("加入时间线失败"),
      );
      return;
    }
    // Explicit drops land exactly where released and overwrite what they
    // cover via the shared edit.clip.add overwrite flag (same resolver as
    // commitClipPlacement).
    dispatchVideo(
      {
        op: "edit.clip.add",
        track_id: targetTrackId,
        media_id: mediaId,
        name: item.name.trim().slice(0, 200) || t("未命名剪辑"),
        start_sec: desiredStart,
        duration_sec: durationSec,
        source_duration_sec: item.kind === "video" || item.kind === "audio" ? durationSec : 60 * 60,
        overwrite: true,
      },
      t("加入时间线失败"),
    );
  }

  function addTextClip() {
    const videoTracks = tracks.filter((track) => track.kind === "video" && !track.locked);
    const target = videoTracks.find((track) => track.id === "video-2") ?? videoTracks[1] ?? videoTracks[0];
    if (!target) {
      setImportMessage(t("没有可用的视频轨道"));
      return;
    }
    const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}`;
    dispatchVideo(
      {
        op: "edit.clip.add",
        track_id: target.id,
        media_id: `text:${id}`,
        name: "标题文字",
        start_sec: snapDirectorTimelineSeconds(
          useDirectorCreativeWorkspaceStore.getState().playheadSec,
          exportFps,
          snapEnabled,
        ),
        duration_sec: 3,
        source_duration_sec: 60 * 60,
        overwrite: true,
      },
      t("加入时间线失败"),
    );
  }

  async function importCaptionFile(file: File) {
    const cues = parseDirectorCaptionFile(await file.text());
    if (!cues.length) {
      setImportMessage(t("字幕文件没有可用片段"));
      return;
    }
    const result = insertDirectorCaptionCuesIntoTimeline(cues, { fps: exportFps });
    if (!result.inserted) {
      setImportMessage(t("无法创建字幕轨道"));
      return;
    }
    setImportMessage(`${t("已导入")} ${result.inserted} ${t("条字幕")}`);
  }

  async function relinkSelectedMedia(file: File) {
    const target = pendingMediaTargetRef.current;
    pendingMediaTargetRef.current = null;
    if (!target) return;
    setImportMessage(t("正在重连素材…"));
    const receipt = await dispatchCreativeWorkspaceMediaRelink(target.id, file);
    if (!receipt.ok) {
      const detail = receipt.error.replace(/^Media relink failed:\s*/i, "").trim();
      setImportMessage(detail || t("素材重连失败"));
      return;
    }
    const referencesUpdated = Number(receipt.execution.result.references_updated ?? 0);
    const waveformReady = Boolean(receipt.execution.result.waveform_ready);
    setImportMessage(
      formatMediaRelinkSuccessMessage({
        referencesUpdated,
        waveformReady,
        honesty: parseMediaRelinkHonesty(receipt.execution.result),
        t,
      }),
    );
  }

  async function verifySelectedMediaBytes() {
    if (!selectedMedia) return;
    const mediaIds = [selectedMedia.id];
    setMediaVerifyState({ status: "pending", mediaIds });
    setImportMessage(t("正在验证字节…"));
    const receipt = await dispatchCreativeWorkspaceMediaVerify(mediaIds);
    if (!receipt.ok) {
      setMediaVerifyState({ status: "error", message: receipt.error });
      setImportMessage(receipt.error || t("字节验证失败"));
      return;
    }
    const parsed = creativeWorkspaceMediaVerifyResultSchema.safeParse(receipt.execution.result);
    if (!parsed.success) {
      setMediaVerifyState({ status: "error", message: t("字节验证回执无效") });
      setImportMessage(t("字节验证回执无效"));
      return;
    }
    setMediaVerifyState({ status: "done", result: parsed.data });
    setImportMessage(t("字节验证完成"));
  }

  async function attachSelectedMediaProxy(file: File) {
    const target = pendingMediaTargetRef.current;
    pendingMediaTargetRef.current = null;
    if (!target) return;
    setImportMessage(t("正在关联代理媒体…"));
    try {
      const proxy = await importDirectorCreativeMediaProxyCandidate(target.id, file);
      const receipt = await dispatchCreativeWorkspaceMediaProxyAttach(target.id, proxy.id);
      if (!receipt.ok) {
        setImportMessage(receipt.error || t("代理媒体关联失败"));
        return;
      }
      setImportMessage(
        formatMediaProxyAttachSuccessMessage({
          proxyId: proxy.id,
          waveformReady: Boolean(proxy.waveform),
          honesty: parseMediaProxyAttachHonesty(receipt.execution.result),
          t,
        }),
      );
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : t("代理媒体关联失败"));
    }
  }

  function timelineSecondFromClientX(clientX: number) {
    const bounds = timelineScrollRef.current?.getBoundingClientRect();
    const scrollLeft = timelineScrollRef.current?.scrollLeft ?? 0;
    return Math.max(0, (clientX - (bounds?.left ?? 0) + scrollLeft) / pixelsPerSecond);
  }

  /** Nudge the scroll container while a drag hovers near its horizontal edges. */
  function autoScrollTimeline(clientX: number) {
    const scroller = timelineScrollRef.current;
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    if (bounds.width === 0) return;
    const edge = 44;
    if (clientX < bounds.left + edge) {
      scroller.scrollLeft -= Math.min(24, (bounds.left + edge - clientX) * 0.4);
    } else if (clientX > bounds.right - edge) {
      scroller.scrollLeft += Math.min(24, (clientX - (bounds.right - edge)) * 0.4);
    }
  }

  /**
   * Browsers hide DataTransfer payloads until drop, so dragover falls back to
   * the in-app drag session registered by the media browser.
   */
  function resolveMediaDragId(dataTransfer: DataTransfer) {
    return dataTransfer.getData(DIRECTOR_MEDIA_DRAG_TYPE) || getDirectorMediaDragSessionId() || "";
  }

  function resolveTimelineDropSecond(clientX: number) {
    const raw = timelineSecondFromClientX(clientX);
    let second = snapDirectorTimelineSeconds(raw, exportFps, snapEnabled);
    if (snapEnabled) {
      const magnetic = magneticSnapDirectorTimelineSeconds(
        raw,
        collectTimelineSnapEdges(),
        MAGNETIC_SNAP_PX / pixelsPerSecond,
      );
      if (magnetic !== null) second = magnetic;
    }
    return Math.max(0, second);
  }

  function canDropMediaOnTrack(
    item: DirectorMediaItem | undefined,
    track: DirectorEditTrack,
  ): item is DirectorMediaItem {
    return Boolean(item && !track.locked && (item.kind === "audio" ? track.kind === "audio" : track.kind === "video"));
  }

  function updateAssetDropTarget(event: ReactDragEvent<HTMLDivElement>, track: DirectorEditTrack) {
    if (!event.dataTransfer.types.includes(DIRECTOR_MEDIA_DRAG_TYPE)) return false;
    const item = mediaById.get(resolveMediaDragId(event.dataTransfer));
    if (!canDropMediaOnTrack(item, track)) {
      setAssetDropTarget(null);
      return false;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    autoScrollTimeline(event.clientX);
    setAssetDropTarget({ trackId: track.id, second: resolveTimelineDropSecond(event.clientX) });
    return true;
  }

  function clearAssetDropTarget(trackId?: string) {
    setAssetDropTarget((current) => (!trackId || current?.trackId === trackId ? null : current));
  }

  function seekPlayhead(seconds: number) {
    const next = Math.min(duration, snapDirectorTimelineSeconds(seconds, exportFps, snapEnabled));
    setPlayhead(next);
    if (playing) playbackStartedRef.current = { time: performance.now(), playhead: next };
  }

  function getVideoTimelineResizeMetrics() {
    const mainHeight = videoMainRef.current?.getBoundingClientRect().height ?? 0;
    const timelineBounds = timelineRef.current?.getBoundingClientRect();
    const maximumHeight = Math.max(
      MIN_VIDEO_TIMELINE_HEIGHT,
      mainHeight - VIDEO_TITLEBAR_HEIGHT - MIN_VIDEO_PREVIEW_HEIGHT - VIDEO_TRANSPORT_HEIGHT,
    );
    const currentHeight = timelineBounds?.height || timelineHeight || mainHeight * 0.38 || MIN_VIDEO_TIMELINE_HEIGHT;

    return {
      currentHeight: Math.min(maximumHeight, Math.max(MIN_VIDEO_TIMELINE_HEIGHT, currentHeight)),
      maximumHeight,
    };
  }

  function setVideoTimelineHeight(nextHeight: number, maximumHeight: number) {
    setTimelineHeight(Math.round(Math.min(maximumHeight, Math.max(MIN_VIDEO_TIMELINE_HEIGHT, nextHeight))));
  }

  function beginTimelineResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanupRef.current?.();
    const { currentHeight, maximumHeight } = getVideoTimelineResizeMetrics();
    const startY = event.clientY;
    setVideoTimelineHeight(currentHeight, maximumHeight);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    function move(pointerEvent: PointerEvent) {
      setVideoTimelineHeight(currentHeight - (pointerEvent.clientY - startY), maximumHeight);
    }

    installWindowPointerDrag(dragCleanupRef, move, () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    });
  }

  function resizeTimelineFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const { currentHeight, maximumHeight } = getVideoTimelineResizeMetrics();
    let nextHeight = currentHeight;
    if (event.key === "ArrowUp") nextHeight += 16;
    else if (event.key === "ArrowDown") nextHeight -= 16;
    else if (event.key === "Home") nextHeight = MIN_VIDEO_TIMELINE_HEIGHT;
    else if (event.key === "End") nextHeight = maximumHeight;
    else return;
    event.preventDefault();
    setVideoTimelineHeight(nextHeight, maximumHeight);
  }

  function beginTimelineScrub(event: ReactPointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".creative-timeline-clip")) return;
    event.preventDefault();
    // Clicking empty lane space clears the selection, like every NLE.
    if (target.closest(".creative-timeline-track") && selectedClipId) selectClip(null);
    const update = (clientX: number) => seekPlayhead(timelineSecondFromClientX(clientX));
    update(event.clientX);
    function move(pointerEvent: PointerEvent) {
      autoScrollTimeline(pointerEvent.clientX);
      update(pointerEvent.clientX);
    }
    dragCleanupRef.current?.();
    installWindowPointerDrag(dragCleanupRef, move);
  }

  function beginClipDrag(event: ReactPointerEvent, clip: DirectorEditClip, trackId: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectClip(clip.id);
    const startX = event.clientX;
    // Absolute positioning (pointer time minus grab offset) keeps the clip
    // under the cursor even while the container auto-scrolls at the edges.
    const grabOffsetSec = timelineSecondFromClientX(event.clientX) - clip.startSec;
    const snapEdges = collectTimelineSnapEdges(clip.id);
    const magneticThreshold = MAGNETIC_SNAP_PX / pixelsPerSecond;
    let targetTrackId = trackId;
    let engaged = false;
    dragCleanupRef.current?.();
    beginHistoryBatch();
    function move(pointerEvent: PointerEvent) {
      // A small threshold keeps plain clicks from nudging the clip.
      if (!engaged && Math.abs(pointerEvent.clientX - startX) < CLIP_DRAG_THRESHOLD_PX) return;
      if (!engaged) {
        engaged = true;
        setDraggingClipId(clip.id);
      }
      autoScrollTimeline(pointerEvent.clientX);
      const row = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-track-id]");
      if (row?.dataset.trackId) targetTrackId = row.dataset.trackId;
      const rawStart = timelineSecondFromClientX(pointerEvent.clientX) - grabOffsetSec;
      let nextStart = snapDirectorTimelineSeconds(rawStart, exportFps, snapEnabled);
      if (snapEnabled) {
        const rawEnd = rawStart + clip.durationSec;
        const startEdge = magneticSnapDirectorTimelineSeconds(rawStart, snapEdges, magneticThreshold);
        const endEdge = magneticSnapDirectorTimelineSeconds(rawEnd, snapEdges, magneticThreshold);
        const startWins =
          startEdge !== null && (endEdge === null || Math.abs(startEdge - rawStart) <= Math.abs(endEdge - rawEnd));
        if (startWins && startEdge !== null) nextStart = startEdge;
        else if (endEdge !== null) nextStart = endEdge - clip.durationSec;
      }
      moveClipToTrack(clip.id, targetTrackId, Math.max(0, nextStart));
    }
    installWindowPointerDrag(dragCleanupRef, move, () => {
      setDraggingClipId(null);
      // Mid-drag keeps neighbours intact; pointer-up shares edit.clip.move
      // overwrite with Agents (same resolveDirectorTrackOverwrite path).
      if (engaged) {
        const state = useDirectorCreativeWorkspaceStore.getState();
        const owner = state.editTracks.find((track) => track.clips.some((item) => item.id === clip.id));
        if (owner) {
          dispatchVideo(
            {
              op: "edit.clip.move",
              clip_id: clip.id,
              track_id: owner.id,
              start_sec: owner.clips.find((item) => item.id === clip.id)!.startSec,
              overwrite: true,
            },
            t("剪辑落位失败"),
          );
        }
        // A cross dissolve only makes sense against an adjacent predecessor;
        // clear it when the drag broke that adjacency.
        if ((clip.transitionInSec ?? 0) > 0) {
          const live = useDirectorCreativeWorkspaceStore.getState();
          const liveOwner = live.editTracks.find((track) => track.clips.some((item) => item.id === clip.id));
          if (liveOwner && !findDirectorTransitionPredecessor(liveOwner, clip.id)) {
            live.setClipTransition(clip.id, 0);
          }
        }
      }
      endHistoryBatch();
    });
  }

  /** Shared by the clip context menu and the Ctrl/⌘+D shortcut. */
  function duplicateClip(clip: DirectorEditClip, track: DirectorEditTrack) {
    if (track.locked) return;
    dispatchVideo(
      {
        op: "edit.clip.add",
        track_id: track.id,
        media_id: clip.mediaId,
        name: clip.name,
        start_sec: clip.startSec + clip.durationSec,
        duration_sec: clip.durationSec,
        source_duration_sec: clip.sourceDurationSec,
        playback_rate: clip.playbackRate,
        in_sec: clip.inSec,
        opacity: clip.opacity,
        volume: clip.volume,
        fade_in_sec: clip.fadeInSec,
        fade_out_sec: clip.fadeOutSec,
        scale: clip.scale,
        position_x: clip.positionX,
        position_y: clip.positionY,
        rotation_deg: clip.rotationDeg,
        fit: clip.fit,
        overwrite: true,
      },
      t("复制剪辑失败"),
    );
  }

  function openClipContextMenu(event: ReactMouseEvent, clip: DirectorEditClip) {
    event.preventDefault();
    selectClip(clip.id);
    setClipContextMenu({ clipId: clip.id, x: event.clientX, y: event.clientY });
  }

  function beginTrim(event: ReactPointerEvent, clip: DirectorEditClip, side: "start" | "end") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = {
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      inSec: clip.inSec,
      playbackRate: clip.playbackRate,
    };
    const originEdge = side === "start" ? origin.startSec : origin.startSec + origin.durationSec;
    const grabOffsetSec = timelineSecondFromClientX(event.clientX) - originEdge;
    const snapEdges = collectTimelineSnapEdges(clip.id);
    const magneticThreshold = MAGNETIC_SNAP_PX / pixelsPerSecond;
    dragCleanupRef.current?.();
    beginHistoryBatch();
    setTrimmingClip({ clipId: clip.id, side });
    function snapTrimEdge(rawEdge: number) {
      const framed = snapDirectorTimelineSeconds(rawEdge, exportFps, true);
      const magnetic = magneticSnapDirectorTimelineSeconds(rawEdge, snapEdges, magneticThreshold);
      return magnetic ?? framed;
    }
    function move(pointerEvent: PointerEvent) {
      autoScrollTimeline(pointerEvent.clientX);
      const rawEdge = timelineSecondFromClientX(pointerEvent.clientX) - grabOffsetSec;
      const nextEdge = snapEnabled ? snapTrimEdge(rawEdge) : rawEdge;
      const delta = nextEdge - originEdge;
      if (side === "start") {
        const applied = Math.min(
          origin.durationSec - 0.1,
          Math.max(-origin.inSec / origin.playbackRate, -origin.startSec, delta),
        );
        updateClip(clip.id, {
          startSec: origin.startSec + applied,
          durationSec: origin.durationSec - applied,
          inSec: origin.inSec + applied * origin.playbackRate,
        });
      } else {
        updateClip(clip.id, { durationSec: origin.durationSec + delta });
      }
    }
    installWindowPointerDrag(dragCleanupRef, move, () => {
      setTrimmingClip(null);
      // Mid-trim stays local; pointer-up shares edit.clip.update overwrite.
      const live = useDirectorCreativeWorkspaceStore
        .getState()
        .editTracks.flatMap((track) => track.clips)
        .find((item) => item.id === clip.id);
      if (live) {
        dispatchVideo(
          {
            op: "edit.clip.update",
            clip_id: clip.id,
            patch: {
              start_sec: live.startSec,
              duration_sec: live.durationSec,
              in_sec: live.inSec,
            },
            overwrite: true,
          },
          t("剪辑落位失败"),
        );
      }
      endHistoryBatch();
    });
  }

  function beginFadeDrag(event: ReactPointerEvent, clip: DirectorEditClip, side: "in" | "out") {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const originFade = side === "in" ? clip.fadeInSec : clip.fadeOutSec;
    const maxFade = Math.max(0, clip.durationSec - (side === "in" ? clip.fadeOutSec : clip.fadeInSec));
    dragCleanupRef.current?.();
    beginHistoryBatch();
    function move(pointerEvent: PointerEvent) {
      const deltaSec = (pointerEvent.clientX - startX) / pixelsPerSecond;
      const next = side === "in" ? originFade + deltaSec : originFade - deltaSec;
      const clamped = Math.max(0, Math.min(maxFade, next));
      updateClip(clip.id, side === "in" ? { fadeInSec: clamped } : { fadeOutSec: clamped });
    }
    installWindowPointerDrag(dragCleanupRef, move, endHistoryBatch);
  }

  function adjustFadeFromKeyboard(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    clip: DirectorEditClip,
    side: "in" | "out",
  ) {
    // ArrowLeft always moves the handle left on screen: shorter fade-in, longer fade-out.
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = side === "in" ? clip.fadeInSec : clip.fadeOutSec;
    const maxFade = Math.max(0, clip.durationSec - (side === "in" ? clip.fadeOutSec : clip.fadeInSec));
    const next = current + 0.1 * (side === "in" ? direction : -direction);
    const clamped = Math.max(0, Math.min(maxFade, next));
    // Each keypress is one discrete step, so it dispatches like the inspector
    // fields; only the pointer drag stays a locally batched interaction.
    dispatchVideo(
      {
        op: "edit.clip.update",
        clip_id: clip.id,
        patch: side === "in" ? { fade_in_sec: clamped } : { fade_out_sec: clamped },
      },
      t("剪辑更新失败"),
    );
  }

  const rulerTicks = Array.from({ length: duration + 1 }, (_, index) => index);
  const rulerLabelInterval = chooseDirectorRulerLabelInterval(pixelsPerSecond);
  // Windowing: only ruler ticks / clips near the viewport are mounted. With an
  // unmeasured viewport the window is [0, Infinity) and everything passes.
  const rulerWindowStartSec = Math.floor(timelineWindow.startPx / pixelsPerSecond);
  const rulerWindowEndSec = Math.ceil(timelineWindow.endPx / pixelsPerSecond);
  const visibleRulerTicks = rulerTicks.filter((second) => second >= rulerWindowStartSec && second <= rulerWindowEndSec);
  const clipIntersectsTimelineWindow = (clip: DirectorEditClip) =>
    clip.startSec * pixelsPerSecond < timelineWindow.endPx &&
    (clip.startSec + clip.durationSec) * pixelsPerSecond > timelineWindow.startPx;
  // Interaction targets stay mounted even off-window: unmounting them would
  // break an active drag/trim gesture, the context menu, or the selection's
  // fade handles while auto-scroll moves the viewport past them.
  const clipMustStayMounted = (clip: DirectorEditClip) =>
    clip.id === selectedClipId ||
    clip.id === draggingClipId ||
    clip.id === clipContextMenu?.clipId ||
    clip.id === trimmingClip?.clipId;
  // Button/menu enablement may lag up to 250ms while playing (quantized value);
  // the click handlers themselves split at the exact live playhead.
  const canSplit = Boolean(
    selected &&
    renderPlayheadSec > selected.clip.startSec + 0.1 &&
    renderPlayheadSec < selected.clip.startSec + selected.clip.durationSec - 0.1,
  );
  const contextMenuTarget = clipContextMenu ? findDirectorEditClip(tracks, clipContextMenu.clipId) : null;
  const contextMenuPredecessor = contextMenuTarget
    ? findDirectorTransitionPredecessor(contextMenuTarget.track, contextMenuTarget.clip.id)
    : null;
  const selectedTransitionPredecessor = selected
    ? findDirectorTransitionPredecessor(selected.track, selected.clip.id)
    : null;
  const contextMenuCanSplit = Boolean(
    contextMenuTarget &&
    !contextMenuTarget.track.locked &&
    renderPlayheadSec > contextMenuTarget.clip.startSec + 0.1 &&
    renderPlayheadSec < contextMenuTarget.clip.startSec + contextMenuTarget.clip.durationSec - 0.1,
  );

  return (
    <main
      className="creative-workspace creative-video-workspace"
      aria-label={t("视频编辑器工作区")}
      style={
        {
          ...panelLayout.style,
          ...(timelineHeight === null ? {} : { "--creative-timeline-height": `${timelineHeight}px` }),
        } as CSSProperties
      }
    >
      <aside className="creative-workspace-sidebar is-left">
        <CreativeMediaBrowser
          items={mediaItems}
          onAdd={(item) => void addMediaToTimeline(item)}
          onImportFiles={importMediaFiles}
          onRelink={(item) => {
            pendingMediaTargetRef.current = item;
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
      <section className="creative-video-main" ref={videoMainRef}>
        <header className="creative-video-titlebar">
          <div className="creative-video-titlebar-leading">
            <span className="creative-video-project-badge">
              <Film aria-hidden size={16} />
            </span>
            <div className="creative-video-titlebar-copy">
              <strong>{t("未命名剪辑")}</strong>
              <span title={formatTime(duration)}>
                {formatDirectorTimelineTimecode(Math.round(duration * exportFps), editTimebase)}
              </span>
            </div>
            {importMessage ? <span className="creative-video-import-status">{importMessage}</span> : null}
          </div>
          <div className="creative-video-export-actions">
            <button
              className="is-secondary"
              disabled={projectBusy}
              onClick={() => projectImportRef.current?.click()}
              type="button"
            >
              {t("导入工程")}
            </button>
            <input
              accept=".director.zip,.zip,.json,application/zip,application/json"
              aria-label={t("导入工程")}
              className="sr-only"
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (file) requestCreativeProjectImport(file);
                input.value = "";
              }}
              ref={projectImportRef}
              tabIndex={-1}
              type="file"
            />
            {pendingProjectImport ? (
              <div aria-label={t("确认导入工程")} className="creative-project-import-confirm" role="alertdialog">
                <span>{t("导入工程将替换当前剪辑与 3D 片场，且无法通过撤销恢复。")}</span>
                <button className="is-secondary" onClick={() => setPendingProjectImport(null)} type="button">
                  {t("取消导入")}
                </button>
                <button
                  className="is-primary"
                  onClick={() => {
                    const file = pendingProjectImport;
                    setPendingProjectImport(null);
                    void importCreativeProject(file);
                  }}
                  type="button"
                >
                  {t("确认导入并替换")}
                </button>
              </div>
            ) : null}
            <button
              className="is-secondary"
              disabled={projectBusy}
              onClick={() => void exportCreativeProject()}
              type="button"
            >
              {t("导出工程")}
            </button>
            <button
              className="is-primary"
              disabled={contentDuration <= 0}
              onClick={() => {
                setExportError("");
                setExportResult("");
                setExportOpen(true);
              }}
              type="button"
            >
              <Download aria-hidden size={14} />
              {t("导出视频")}
            </button>
          </div>
        </header>
        <div className="creative-preview-shell">
          <PreviewSurface
            aspectRatio={aspectRatio}
            layers={activeLayers}
            playheadSec={renderPlayheadSec}
            playing={playing}
          />
          {activeAudioClips.map(({ trackId, clip, media }) => (
            <PreviewAudioClip
              clip={clip}
              key={`${trackId}:${clip.id}`}
              media={media}
              playheadSec={renderPlayheadSec}
              playing={playing}
            />
          ))}
          <div className="creative-preview-meta">
            <span>{topPreviewLayer?.media?.name ?? topPreviewLayer?.clip.name ?? t("暂无画面")}</span>
            <PreviewTimecodeReadout durationSec={duration} editTimebase={editTimebase} exportFps={exportFps} />
          </div>
        </div>
        <div className="creative-transport-bar">
          <div className="creative-transport-group is-playback">
            <button
              aria-label={t("回到开头")}
              onClick={() => seekTransportTo(0)}
              title={`${t("回到开头")} (Home)`}
              type="button"
            >
              <SkipBack aria-hidden size={15} />
            </button>
            <button
              aria-label={t(playing ? "暂停" : "播放")}
              className="creative-play-button"
              onClick={togglePlayback}
              title={`${t(playing ? "暂停" : "播放")} (Space)`}
              type="button"
            >
              {playing ? <Pause aria-hidden size={16} /> : <Play aria-hidden size={16} />}
            </button>
            <button
              aria-label={t("跳到结尾")}
              onClick={() => seekTransportTo(Math.min(duration, contentDuration))}
              title={`${t("跳到结尾")} (End)`}
              type="button"
            >
              <SkipForward aria-hidden size={15} />
            </button>
            <button
              aria-label={t("循环播放")}
              aria-pressed={loopPlayback}
              onClick={() => setLoopPlayback((current) => !current)}
              title={t(loopPlayback ? "循环播放已开启" : "循环播放已关闭")}
              type="button"
            >
              <Repeat aria-hidden size={14} />
            </button>
            <TransportTimecode editTimebase={editTimebase} exportFps={exportFps} onSeek={seekTransportTo} />
          </div>
          <span aria-hidden className="creative-transport-divider" />
          <div className="creative-transport-group is-history">
            <button
              aria-label={t("撤销")}
              disabled={!canUndo}
              onClick={() => dispatchVideo({ op: "workspace.undo" }, t("撤销失败"))}
              title={`${t("撤销")} (Ctrl/⌘+Z)`}
              type="button"
            >
              <Undo2 aria-hidden size={14} />
            </button>
            <button
              aria-label={t("重做")}
              disabled={!canRedo}
              onClick={() => dispatchVideo({ op: "workspace.redo" }, t("重做失败"))}
              title={`${t("重做")} (Shift+Ctrl/⌘+Z)`}
              type="button"
            >
              <Redo2 aria-hidden size={14} />
            </button>
          </div>
          <span className="creative-transport-spacer" />
          <div className="creative-transport-group is-edit">
            <button
              aria-label={t(snapEnabled ? "关闭磁吸" : "开启磁吸")}
              aria-pressed={snapEnabled}
              onClick={() =>
                dispatchVideo({ op: "edit.settings.update", patch: { snap_enabled: !snapEnabled } }, t("设置更新失败"))
              }
              title={t(snapEnabled ? "磁吸对齐已开启" : "磁吸对齐已关闭")}
              type="button"
            >
              <Magnet aria-hidden size={15} />
            </button>
            <CreativeTransportDropdown
              ariaLabel={t("画幅比例")}
              onSelect={(nextAspectRatio) =>
                dispatchVideo(
                  { op: "edit.settings.update", patch: { aspect_ratio: nextAspectRatio as typeof aspectRatio } },
                  t("设置更新失败"),
                )
              }
              options={ASPECT_RATIO_OPTIONS.map((option) => ({ ...option }))}
              trigger={ASPECT_RATIO_OPTIONS.find((option) => option.id === aspectRatio)?.label ?? "16:9"}
              value={aspectRatio}
            />
            <button
              className="creative-transport-action"
              disabled={!canSplit}
              onClick={() =>
                selected &&
                dispatchVideo(
                  {
                    op: "edit.clip.split",
                    clip_id: selected.clip.id,
                    at_sec: useDirectorCreativeWorkspaceStore.getState().playheadSec,
                  },
                  t("剪辑分割失败"),
                )
              }
              title={`${t("在播放头处分割选中剪辑")} (S)`}
              type="button"
            >
              <Scissors aria-hidden size={14} /> {t("分割")}
            </button>
            <button className="creative-transport-action" onClick={addTextClip} type="button">
              <Type aria-hidden size={14} /> {t("添加文字")}
            </button>
            <button
              className="creative-transport-action"
              onClick={() => captionImportRef.current?.click()}
              type="button"
            >
              CC {t("字幕")}
            </button>
            <input
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              aria-label={t("字幕")}
              className="sr-only"
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (file) void importCaptionFile(file);
                input.value = "";
              }}
              ref={captionImportRef}
              tabIndex={-1}
              type="file"
            />
            <CreativeTransportDropdown
              ariaLabel={t("添加轨道")}
              onSelect={(trackKind) =>
                dispatchVideo({ op: "edit.track.add", kind: trackKind as "video" | "audio" }, t("轨道创建失败"))
              }
              options={[
                { id: "video", label: t("视频轨"), icon: <Video aria-hidden size={14} /> },
                { id: "audio", label: t("音频轨"), icon: <Volume2 aria-hidden size={14} /> },
              ]}
              trigger={
                <>
                  <Plus aria-hidden size={14} />
                  {t("轨道")}
                </>
              }
            />
          </div>
          <span aria-hidden className="creative-transport-divider" />
          <div className="creative-transport-group is-zoom">
            <button
              aria-label={t("适配全片")}
              disabled={totalClipCount === 0}
              onClick={zoomTimelineToFit}
              title={t("适配全片")}
              type="button"
            >
              <UnfoldHorizontal aria-hidden size={15} />
            </button>
            <CreativeTransportDropdown
              align="right"
              ariaLabel={t("时间线缩放")}
              onSelect={(preset) => applyTimelineZoom(Number(preset))}
              options={TIMELINE_ZOOM_PRESETS.map((preset) => ({
                id: String(preset),
                label: `${Math.round(preset * 100)}%`,
              }))}
              trigger={`${Math.round(timelineZoom * 100)}%`}
              value={String(
                TIMELINE_ZOOM_PRESETS.reduce(
                  (closest, preset) =>
                    Math.abs(preset - timelineZoom) < Math.abs(closest - timelineZoom) ? preset : closest,
                  TIMELINE_ZOOM_PRESETS[0],
                ),
              )}
            />
            <button
              aria-label={t("缩小时间线")}
              disabled={timelineZoom <= MIN_TIMELINE_ZOOM}
              onClick={() => applyTimelineZoom(timelineZoom / 1.2)}
              type="button"
            >
              <ZoomOut aria-hidden size={15} />
            </button>
            <button
              aria-label={t("放大时间线")}
              disabled={timelineZoom >= MAX_TIMELINE_ZOOM}
              onClick={() => applyTimelineZoom(timelineZoom * 1.2)}
              type="button"
            >
              <ZoomIn aria-hidden size={15} />
            </button>
          </div>
        </div>
        <section className="creative-edit-timeline" aria-label={t("视频时间线")} ref={timelineRef}>
          <div
            aria-label={t("调整时间线高度")}
            aria-orientation="horizontal"
            aria-valuemin={MIN_VIDEO_TIMELINE_HEIGHT}
            aria-valuenow={timelineHeight ?? undefined}
            className="creative-timeline-resizer"
            onKeyDown={resizeTimelineFromKeyboard}
            onPointerDown={beginTimelineResize}
            role="separator"
            tabIndex={0}
          />
          <div
            className="creative-track-labels"
            style={{ gridTemplateRows: `36px repeat(${tracks.length}, ${TRACK_HEIGHT}px)` }}
          >
            <div className="creative-track-label-ruler">{t("轨道")}</div>
            {tracks.map((track) => (
              <div
                className={`creative-track-label is-${track.kind}${track.locked ? " is-locked" : ""}${trackMenuId === track.id ? " is-menu-open" : ""}`}
                key={track.id}
              >
                <span className="creative-track-kind-badge" aria-hidden="true">
                  {track.kind === "video" ? <Video aria-hidden size={12} /> : <Volume2 aria-hidden size={12} />}
                </span>
                <div className="creative-track-label-copy">
                  {renamingTrackId === track.id ? (
                    <input
                      aria-label={`${t("重命名轨道")} ${t(track.name)}`}
                      autoFocus
                      className="creative-track-name-input"
                      onBlur={() => {
                        const name = trackNameDraft.trim();
                        if (name && name !== track.name) {
                          dispatchVideo(
                            { op: "edit.track.update", track_id: track.id, patch: { name } },
                            t("轨道重命名失败"),
                          );
                        }
                        setRenamingTrackId(null);
                      }}
                      onChange={(event) => setTrackNameDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenamingTrackId(null);
                      }}
                      value={trackNameDraft}
                    />
                  ) : (
                    <strong
                      onDoubleClick={() => {
                        setTrackNameDraft(track.name);
                        setRenamingTrackId(track.id);
                      }}
                      title={`${track.name} · ${t("双击重命名")}`}
                    >
                      {t(track.name)}
                    </strong>
                  )}
                </div>
                <div className="creative-track-label-actions">
                  {track.kind === "video" ? (
                    <button
                      aria-label={`${t(track.visible ? "隐藏画面" : "显示画面")} ${t(track.name)}`}
                      aria-pressed={track.visible}
                      className={track.visible ? "" : "is-off"}
                      onClick={() =>
                        dispatchVideo(
                          { op: "edit.track.update", track_id: track.id, patch: { visible: !track.visible } },
                          t("轨道更新失败"),
                        )
                      }
                      type="button"
                    >
                      {track.visible ? <Eye aria-hidden size={12} /> : <EyeOff aria-hidden size={12} />}
                    </button>
                  ) : null}
                  <button
                    aria-label={`${t(track.muted ? "取消静音" : "静音")} ${t(track.name)}`}
                    aria-pressed={!track.muted}
                    className={track.muted ? "is-off" : ""}
                    onClick={() =>
                      dispatchVideo(
                        { op: "edit.track.update", track_id: track.id, patch: { muted: !track.muted } },
                        t("轨道更新失败"),
                      )
                    }
                    type="button"
                  >
                    {track.muted ? <VolumeX aria-hidden size={12} /> : <Volume2 aria-hidden size={12} />}
                  </button>
                  <button
                    aria-label={`${t(track.locked ? "解锁" : "锁定")} ${t(track.name)}`}
                    aria-pressed={track.locked}
                    className={track.locked ? "is-active" : ""}
                    onClick={() =>
                      dispatchVideo(
                        { op: "edit.track.update", track_id: track.id, patch: { locked: !track.locked } },
                        t("轨道更新失败"),
                      )
                    }
                    type="button"
                  >
                    {track.locked ? <Lock aria-hidden size={12} /> : <Unlock aria-hidden size={12} />}
                  </button>
                  <button
                    aria-expanded={trackMenuId === track.id}
                    aria-haspopup="menu"
                    aria-label={`${t("轨道菜单")} ${t(track.name)}`}
                    className="is-menu"
                    onClick={() => setTrackMenuId((current) => (current === track.id ? null : track.id))}
                    type="button"
                  >
                    <MoreHorizontal aria-hidden size={12} />
                  </button>
                </div>
                {trackMenuId === track.id ? (
                  <div className="creative-track-menu" role="menu">
                    <button
                      onClick={() => {
                        setTrackNameDraft(track.name);
                        setRenamingTrackId(track.id);
                        setTrackMenuId(null);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {t("重命名轨道")}
                    </button>
                    <button
                      className="is-danger"
                      disabled={track.kind === "video" && tracks.filter((item) => item.kind === "video").length <= 1}
                      onClick={() => {
                        dispatchVideo({ op: "edit.track.remove", track_id: track.id }, t("轨道删除失败"));
                        setTrackMenuId(null);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {t("删除轨道")}
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="creative-timeline-scroll" ref={timelineScrollRef}>
            <div
              className="creative-timeline-content"
              style={
                {
                  width: timelineWidth,
                  "--timeline-grid-size": `${pixelsPerSecond}px`,
                } as CSSProperties
              }
            >
              <div className="creative-timeline-ruler" onPointerDown={beginTimelineScrub}>
                {visibleRulerTicks.map((second) => (
                  <span
                    className={second % rulerLabelInterval === 0 ? "is-major" : "is-second"}
                    key={second}
                    style={{ left: second * pixelsPerSecond }}
                  >
                    {second % rulerLabelInterval === 0 ? formatRulerLabel(second) : null}
                  </span>
                ))}
              </div>
              {tracks.map((track) => (
                <div
                  className={`creative-timeline-track${track.locked ? " is-locked" : ""}${assetDropTarget?.trackId === track.id ? " is-drop-target" : ""}`}
                  data-track-id={track.id}
                  key={track.id}
                  onDragEnter={(event) => {
                    updateAssetDropTarget(event, track);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      clearAssetDropTarget(track.id);
                  }}
                  onDragOver={(event) => updateAssetDropTarget(event, track)}
                  onDrop={(event) => {
                    const item = mediaById.get(resolveMediaDragId(event.dataTransfer));
                    if (!canDropMediaOnTrack(item, track)) {
                      clearAssetDropTarget(track.id);
                      return;
                    }
                    event.preventDefault();
                    clearAssetDropTarget(track.id);
                    void addMediaToTimeline(item, track.id, resolveTimelineDropSecond(event.clientX));
                  }}
                  onPointerDown={beginTimelineScrub}
                  style={{ height: TRACK_HEIGHT }}
                >
                  {track.clips
                    .filter((clip) => clipMustStayMounted(clip) || clipIntersectsTimelineWindow(clip))
                    .map((clip) => {
                      const media = mediaById.get(clip.mediaId);
                      const isTextClip = clip.mediaId.startsWith("text:");
                      const isOffline = !isTextClip && (media?.availability === "offline" || !media);
                      const clipWidth = Math.max(30, clip.durationSec * pixelsPerSecond);
                      const isSelected = clip.id === selectedClipId;
                      return (
                        <article
                          className={`creative-timeline-clip${isSelected ? " is-selected" : ""}${
                            isOffline ? " is-offline" : ""
                          }${clip.id === draggingClipId ? " is-dragging" : ""}`}
                          key={clip.id}
                          onContextMenu={(event) => openClipContextMenu(event, clip)}
                          onPointerDown={(event) => beginClipDrag(event, clip, track.id)}
                          style={
                            {
                              left: clip.startSec * pixelsPerSecond,
                              width: clipWidth,
                              "--clip-color": getClipColor(media),
                            } as CSSProperties
                          }
                          title={`${clip.name} · ${clip.durationSec.toFixed(2)}s`}
                        >
                          <button
                            aria-label={t("裁切剪辑起点")}
                            className="creative-clip-trim is-start"
                            onPointerDown={(event) => beginTrim(event, clip, "start")}
                            type="button"
                          />
                          <div className="creative-clip-cover">
                            {isTextClip ? (
                              <Type aria-hidden size={15} />
                            ) : media?.thumbnailUrl ? (
                              <img alt="" draggable={false} src={media.thumbnailUrl} />
                            ) : media?.kind === "video" ? (
                              <Video aria-hidden size={15} />
                            ) : media?.kind === "audio" ? (
                              <Volume2 aria-hidden size={15} />
                            ) : (
                              <Image aria-hidden size={15} />
                            )}
                          </div>
                          {media?.kind === "video" && clipWidth > 70 && getDirectorMediaPreviewSource(media) ? (
                            <ClipFilmstripStrip
                              inSec={clip.inSec}
                              mediaId={media.id}
                              playbackRate={clip.playbackRate}
                              sourceUrl={getDirectorMediaPreviewSource(media)!}
                              timelineDurationSec={clip.durationSec}
                              widthPx={clipWidth - FILMSTRIP_TILE_EDGE}
                            />
                          ) : null}
                          {media?.waveform ? (
                            <CreativeMediaWaveform
                              label={`${clip.name} ${t("音频波形")}`}
                              waveform={media.waveform}
                              window={{
                                inSec: clip.inSec,
                                durationSec: clip.durationSec,
                                playbackRate: clip.playbackRate,
                              }}
                            />
                          ) : null}
                          <div>
                            <strong data-i18n-user-content>{clip.name}</strong>
                            <small>{clip.durationSec.toFixed(2)}s</small>
                          </div>
                          {(clip.transitionInSec ?? 0) > 0 ? (
                            <span
                              aria-hidden
                              className="creative-clip-transition"
                              style={{ width: Math.min((clip.transitionInSec ?? 0) * pixelsPerSecond, clipWidth) }}
                              title={`${t("交叉溶解")} ${(clip.transitionInSec ?? 0).toFixed(2)}s`}
                            />
                          ) : null}
                          {clip.fadeInSec > 0 ? (
                            <span
                              aria-hidden
                              className="creative-clip-fade is-in"
                              style={{ width: Math.min(clip.fadeInSec * pixelsPerSecond, clipWidth) }}
                            />
                          ) : null}
                          {clip.fadeOutSec > 0 ? (
                            <span
                              aria-hidden
                              className="creative-clip-fade is-out"
                              style={{ width: Math.min(clip.fadeOutSec * pixelsPerSecond, clipWidth) }}
                            />
                          ) : null}
                          {isSelected && !track.locked ? (
                            <>
                              <button
                                aria-label={`${t("调整淡入")} ${clip.fadeInSec.toFixed(2)}s`}
                                className="creative-clip-fade-handle is-in"
                                onKeyDown={(event) => adjustFadeFromKeyboard(event, clip, "in")}
                                onPointerDown={(event) => beginFadeDrag(event, clip, "in")}
                                style={{
                                  left: Math.max(7, Math.min(clip.fadeInSec * pixelsPerSecond, clipWidth - 18)),
                                }}
                                title={`${t("淡入")} ${clip.fadeInSec.toFixed(2)}s`}
                                type="button"
                              />
                              <button
                                aria-label={`${t("调整淡出")} ${clip.fadeOutSec.toFixed(2)}s`}
                                className="creative-clip-fade-handle is-out"
                                onKeyDown={(event) => adjustFadeFromKeyboard(event, clip, "out")}
                                onPointerDown={(event) => beginFadeDrag(event, clip, "out")}
                                style={{
                                  right: Math.max(7, Math.min(clip.fadeOutSec * pixelsPerSecond, clipWidth - 18)),
                                }}
                                title={`${t("淡出")} ${clip.fadeOutSec.toFixed(2)}s`}
                                type="button"
                              />
                            </>
                          ) : null}
                          <button
                            aria-label={t("裁切剪辑终点")}
                            className="creative-clip-trim is-end"
                            onPointerDown={(event) => beginTrim(event, clip, "end")}
                            type="button"
                          />
                          {trimmingClip?.clipId === clip.id ? (
                            <span aria-hidden className={`creative-clip-trim-badge is-${trimmingClip.side}`}>
                              {clip.durationSec.toFixed(2)}s
                            </span>
                          ) : null}
                        </article>
                      );
                    })}
                  {assetDropTarget?.trackId === track.id ? (
                    <div
                      aria-hidden
                      className="creative-timeline-drop-indicator"
                      style={{ left: assetDropTarget.second * pixelsPerSecond }}
                    >
                      <span>{formatTime(assetDropTarget.second)}</span>
                    </div>
                  ) : null}
                </div>
              ))}
              <TimelinePlayheadIndicator
                handleTitle={t("拖动播放头")}
                onHandlePointerDown={beginTimelineScrub}
                pixelsPerSecond={pixelsPerSecond}
              />
            </div>
          </div>
        </section>
      </section>
      <aside className="creative-workspace-sidebar is-right creative-video-inspector">
        <div className="creative-inspector-tabs" role="tablist" aria-label={t("剪辑检查器")}>
          <button
            aria-selected={inspectorTab === "properties"}
            className={inspectorTab === "properties" ? "is-active" : ""}
            onClick={() => setInspectorTab("properties")}
            role="tab"
            type="button"
          >
            {t("属性")}
          </button>
          <button
            aria-selected={inspectorTab === "effects"}
            className={inspectorTab === "effects" ? "is-active" : ""}
            onClick={() => setInspectorTab("effects")}
            role="tab"
            type="button"
          >
            {t("音效")}
          </button>
        </div>
        {selected ? (
          <div className="creative-inspector-form">
            <header className="creative-selected-clip-heading">
              <span style={{ background: getClipColor(selectedMedia) }} />
              <div>
                <strong data-i18n-user-content>{selected.clip.name}</strong>
                <small>{t(selected.track.name)}</small>
              </div>
            </header>
            {selectedMedia ? (
              <section className="creative-media-engineering-status" aria-label={t("媒体工程状态")}>
                <div>
                  <span
                    className={`creative-media-status-dot is-${selectedMedia.availability ?? "unverified"}`}
                    aria-hidden
                  />
                  <strong>
                    {t(
                      selectedMedia.availability === "offline"
                        ? "素材离线"
                        : selectedMedia.availability === "online"
                          ? "素材在线"
                          : "素材未验证",
                    )}
                  </strong>
                  <small>
                    {selectedMedia.playbackSource?.variant === "proxy"
                      ? t("正在使用代理媒体")
                      : selectedMedia.waveform
                        ? t("原始媒体 · 波形已缓存")
                        : t("原始媒体")}
                  </small>
                </div>
                {selectedPersistentMedia ? (
                  <label className="creative-media-playback-choice">
                    <span>{t("播放媒体版本")}</span>
                    <select
                      aria-label={t("播放媒体版本")}
                      onChange={(event) => {
                        const preference = event.currentTarget.value as CreativeMediaPlaybackPreference;
                        void persistentCreativeMediaLibrary
                          .setPlaybackPreference(selectedPersistentMedia.id, preference)
                          .then(() => setImportMessage(t("播放媒体版本已更新")))
                          .catch((error) =>
                            setImportMessage(error instanceof Error ? error.message : t("播放媒体版本更新失败")),
                          );
                      }}
                      value={selectedMedia.playbackPreference ?? selectedPersistentMedia.playbackPreference ?? "auto"}
                    >
                      <option value="auto">{t("自动")}</option>
                      <option value="original">{t("原始媒体")}</option>
                      <option disabled={!selectedMedia.playbackSource?.proxyAssetId} value="proxy">
                        {t("代理媒体")}
                      </option>
                    </select>
                  </label>
                ) : null}
                <div className="creative-media-engineering-actions">
                  <button
                    onClick={() => {
                      pendingMediaTargetRef.current = selectedMedia;
                      relinkInputRef.current?.click();
                    }}
                    type="button"
                  >
                    <Link2 aria-hidden size={13} /> {t("重连")}
                  </button>
                  <button
                    disabled={!selectedPersistentMedia}
                    onClick={() => {
                      pendingMediaTargetRef.current = selectedMedia;
                      proxyInputRef.current?.click();
                    }}
                    type="button"
                  >
                    <Film aria-hidden size={13} /> {t("关联代理")}
                  </button>
                  <button
                    aria-busy={mediaVerifyState.status === "pending"}
                    disabled={mediaVerifyState.status === "pending"}
                    onClick={() => void verifySelectedMediaBytes()}
                    type="button"
                  >
                    <ShieldCheck aria-hidden size={13} /> {t("验证字节")}
                  </button>
                  {selectedPersistentMedia &&
                  !selectedPersistentMedia.proxyOf &&
                  (selectedPersistentMedia.kind === "audio" || selectedPersistentMedia.kind === "video") ? (
                    <button onClick={() => setTranscriptionMediaId(selectedPersistentMedia.id)} type="button">
                      <Captions aria-hidden size={13} />
                      {t(selectedPersistentMedia.transcript ? "查看转录" : "转录与字幕")}
                    </button>
                  ) : null}
                </div>
                <MediaVerifyResultsList state={mediaVerifyState} t={t} />
              </section>
            ) : null}
            {inspectorTab === "properties" ? (
              <>
                <label>
                  <span>{t("名称")}</span>
                  <input
                    maxLength={CREATIVE_CLIP_NAME_MAX}
                    onChange={(event) => updateSelectedClipName(event.currentTarget.value)}
                    value={selected.clip.name}
                  />
                </label>
                <div className="creative-inspector-grid">
                  <ClipNumericField
                    label={t("开始")}
                    min={0}
                    onValueChange={(value) => updateSelectedClipNumber("startSec", value)}
                    step="0.01"
                    value={selected.clip.startSec.toFixed(2)}
                  />
                  <ClipNumericField
                    label={t("时长")}
                    min={0.1}
                    onValueChange={(value) => updateSelectedClipNumber("durationSec", value)}
                    step="0.01"
                    value={selected.clip.durationSec.toFixed(2)}
                  />
                  {selectedIsTimedMedia ? (
                    <>
                      <ClipNumericField
                        label="In"
                        min={0}
                        onValueChange={(value) => updateSelectedClipNumber("inSec", value)}
                        step="0.01"
                        value={selected.clip.inSec.toFixed(2)}
                      />
                      <ClipNumericField
                        disabled
                        label="Out"
                        value={(selected.clip.inSec + selected.clip.durationSec * selected.clip.playbackRate).toFixed(
                          2,
                        )}
                      />
                      <ClipNumericField
                        ariaLabel={t("播放速度")}
                        label={t("速度")}
                        max={4}
                        min={0.25}
                        onValueChange={(value) => updateSelectedClipNumber("playbackRate", value)}
                        step="0.05"
                        value={selected.clip.playbackRate.toFixed(2)}
                      />
                    </>
                  ) : null}
                </div>
                <ClipNumericField
                  label={`${t("不透明度")} · ${Math.round(selected.clip.opacity * 100)}%`}
                  max={1}
                  min={0}
                  onValueChange={(value) => updateSelectedClipNumber("opacity", value)}
                  step="0.01"
                  type="range"
                  value={selected.clip.opacity}
                />
                <div className="creative-inspector-grid">
                  <ClipNumericField
                    label={`${t("淡入")} (s)`}
                    max={selected.clip.durationSec}
                    min={0}
                    onValueChange={(value) => updateSelectedClipNumber("fadeInSec", value)}
                    step="0.05"
                    value={selected.clip.fadeInSec.toFixed(2)}
                  />
                  <ClipNumericField
                    label={`${t("淡出")} (s)`}
                    max={selected.clip.durationSec}
                    min={0}
                    onValueChange={(value) => updateSelectedClipNumber("fadeOutSec", value)}
                    step="0.05"
                    value={selected.clip.fadeOutSec.toFixed(2)}
                  />
                </div>
                {selectedTransitionPredecessor || (selected.clip.transitionInSec ?? 0) > 0 ? (
                  <ClipNumericField
                    ariaLabel={t("交叉溶解时长")}
                    label={`${t("交叉溶解")} (s)`}
                    max={
                      selectedTransitionPredecessor
                        ? Math.min(selected.clip.durationSec, selectedTransitionPredecessor.durationSec)
                        : selected.clip.durationSec
                    }
                    min={0}
                    onValueChange={(value) => {
                      if (!Number.isFinite(value)) return;
                      dispatchVideo(
                        {
                          op: "edit.clip.update",
                          clip_id: selected.clip.id,
                          patch: { transition_in_sec: Math.max(0, value) },
                        },
                        t("剪辑更新失败"),
                      );
                    }}
                    step="0.1"
                    value={(selected.clip.transitionInSec ?? 0).toFixed(2)}
                  />
                ) : null}
                <ClipNumericField
                  label={`${t("缩放")} · ${Math.round(selected.clip.scale * 100)}%`}
                  max={3}
                  min={0.05}
                  onValueChange={(value) => updateSelectedClipNumber("scale", value)}
                  step="0.01"
                  type="range"
                  value={selected.clip.scale}
                />
                <div className="creative-inspector-grid">
                  <ClipNumericField
                    label="X"
                    onValueChange={(value) => updateSelectedClipNumber("positionX", value)}
                    step="1"
                    value={Math.round(selected.clip.positionX)}
                  />
                  <ClipNumericField
                    label="Y"
                    onValueChange={(value) => updateSelectedClipNumber("positionY", value)}
                    step="1"
                    value={Math.round(selected.clip.positionY)}
                  />
                  <ClipNumericField
                    label={t("旋转")}
                    onValueChange={(value) => updateSelectedClipNumber("rotationDeg", value)}
                    step="0.1"
                    value={selected.clip.rotationDeg.toFixed(1)}
                  />
                  <label>
                    <span>{t("适配")}</span>
                    <select
                      onChange={(event) =>
                        dispatchVideo(
                          {
                            op: "edit.clip.update",
                            clip_id: selected.clip.id,
                            patch: { fit: event.currentTarget.value as DirectorEditClip["fit"] },
                          },
                          t("剪辑更新失败"),
                        )
                      }
                      value={selected.clip.fit}
                    >
                      <option value="contain">{t("完整显示")}</option>
                      <option value="cover">{t("填满画面")}</option>
                    </select>
                  </label>
                </div>
                <div className="creative-clip-align-actions">
                  <button
                    onClick={() =>
                      dispatchVideo(
                        { op: "edit.clip.update", clip_id: selected.clip.id, patch: { position_x: 0 } },
                        t("剪辑更新失败"),
                      )
                    }
                    title={t("水平居中")}
                    type="button"
                  >
                    <AlignCenterHorizontal aria-hidden size={14} /> {t("水平居中")}
                  </button>
                  <button
                    onClick={() =>
                      dispatchVideo(
                        { op: "edit.clip.update", clip_id: selected.clip.id, patch: { position_y: 0 } },
                        t("剪辑更新失败"),
                      )
                    }
                    title={t("垂直居中")}
                    type="button"
                  >
                    <AlignCenterVertical aria-hidden size={14} /> {t("垂直居中")}
                  </button>
                  <button
                    className="creative-clip-reset-transform"
                    onClick={() =>
                      dispatchVideo(
                        {
                          op: "edit.clip.update",
                          clip_id: selected.clip.id,
                          patch: { scale: 1, position_x: 0, position_y: 0, rotation_deg: 0 },
                        },
                        t("剪辑更新失败"),
                      )
                    }
                    title={t("重置变换")}
                    type="button"
                  >
                    <RotateCcw aria-hidden size={14} /> {t("重置变换")}
                  </button>
                </div>
              </>
            ) : (
              <ClipNumericField
                label={`${t("音量")} · ${Math.round(selected.clip.volume * 100)}%`}
                max={1}
                min={0}
                onValueChange={(value) => updateSelectedClipNumber("volume", value)}
                step="0.01"
                type="range"
                value={selected.clip.volume}
              />
            )}
            <button
              className="creative-danger-button"
              onClick={() => dispatchVideo({ op: "edit.clip.remove", clip_id: selected.clip.id }, t("剪辑删除失败"))}
              title={`${t("删除剪辑")} (Delete)`}
              type="button"
            >
              <Trash2 aria-hidden size={14} />
              {t("删除剪辑")}
            </button>
          </div>
        ) : (
          <div className="creative-inspector-empty">
            <Scissors aria-hidden size={22} />
            <strong>{t("选择一个剪辑")}</strong>
            <span>{t("可以移动、裁切并调整画面与音量。")}</span>
          </div>
        )}
      </aside>
      <CreativeWorkspacePanelResizer
        label={t("调整属性栏宽度")}
        onKeyDown={(event) => panelLayout.resizeFromKeyboard("inspector", event)}
        onPointerDown={(event) => panelLayout.beginResize("inspector", event)}
        panel="inspector"
      />
      <input
        aria-label={t("选择重连素材")}
        accept="image/*,video/*,audio/*"
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) void relinkSelectedMedia(file);
          input.value = "";
        }}
        ref={relinkInputRef}
        tabIndex={-1}
        type="file"
      />
      <input
        aria-label={t("选择代理媒体")}
        accept="image/*,video/*,audio/*"
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) void attachSelectedMediaProxy(file);
          input.value = "";
        }}
        ref={proxyInputRef}
        tabIndex={-1}
        type="file"
      />
      {clipContextMenu && contextMenuTarget ? (
        <div
          aria-label={t("剪辑菜单")}
          className="creative-clip-context-menu"
          ref={clipContextMenuRef}
          role="menu"
          style={{ left: clipContextMenu.x, top: clipContextMenu.y }}
        >
          <button
            disabled={!contextMenuCanSplit}
            onClick={() => {
              dispatchVideo(
                {
                  op: "edit.clip.split",
                  clip_id: contextMenuTarget.clip.id,
                  at_sec: useDirectorCreativeWorkspaceStore.getState().playheadSec,
                },
                t("剪辑分割失败"),
              );
              setClipContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            <Scissors aria-hidden size={13} />
            {t("在播放头处分割")}
            <kbd>S</kbd>
          </button>
          <button
            disabled={contextMenuTarget.track.locked}
            onClick={() => {
              duplicateClip(contextMenuTarget.clip, contextMenuTarget.track);
              setClipContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            <Copy aria-hidden size={13} />
            {t("创建副本")}
            <kbd>Ctrl/⌘+D</kbd>
          </button>
          <button
            disabled={
              contextMenuTarget.track.locked ||
              (!contextMenuPredecessor && (contextMenuTarget.clip.transitionInSec ?? 0) <= 0)
            }
            onClick={() => {
              const clip = contextMenuTarget.clip;
              const nextTransition =
                (clip.transitionInSec ?? 0) > 0
                  ? 0
                  : contextMenuPredecessor
                    ? Math.min(0.5, clip.durationSec, contextMenuPredecessor.durationSec)
                    : null;
              if (nextTransition !== null) {
                dispatchVideo(
                  { op: "edit.clip.update", clip_id: clip.id, patch: { transition_in_sec: nextTransition } },
                  t("剪辑更新失败"),
                );
              }
              setClipContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            <Blend aria-hidden size={13} />
            {t((contextMenuTarget.clip.transitionInSec ?? 0) > 0 ? "移除交叉溶解" : "添加交叉溶解")}
          </button>
          <button
            disabled={contextMenuTarget.track.locked}
            onClick={() => {
              dispatchVideo(
                { op: "edit.clip.remove", clip_id: contextMenuTarget.clip.id, ripple: true },
                t("剪辑删除失败"),
              );
              setClipContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            <ArrowLeftToLine aria-hidden size={13} />
            {t("波纹删除")}
            <kbd>⇧Delete</kbd>
          </button>
          <button
            className="is-danger"
            disabled={contextMenuTarget.track.locked}
            onClick={() => {
              dispatchVideo({ op: "edit.clip.remove", clip_id: contextMenuTarget.clip.id }, t("剪辑删除失败"));
              setClipContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            <Trash2 aria-hidden size={13} />
            {t("删除")}
            <kbd>Delete</kbd>
          </button>
        </div>
      ) : null}
      {transcriptionAsset ? (
        <MediaTranscriptionPanel
          asset={transcriptionAsset}
          captionOffsetSec={selected?.clip.startSec ?? 0}
          onClose={() => setTranscriptionMediaId(null)}
          onInserted={(count) => setImportMessage(`${count} ${t("条字幕已加入时间线")}`)}
        />
      ) : null}
      {exportOpen ? (
        <div
          className="creative-export-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !exporting) setExportOpen(false);
          }}
        >
          <section
            aria-labelledby="creative-export-title"
            aria-modal="true"
            className="creative-export-dialog"
            role="dialog"
          >
            <header>
              <div>
                <Film aria-hidden size={17} />
                <div>
                  <strong id="creative-export-title">{t("导出时间线视频")}</strong>
                  <span>{t("将当前画面轨道合成为可播放文件")}</span>
                </div>
              </div>
              <button disabled={exporting} onClick={() => setExportOpen(false)} type="button">
                {t("关闭")}
              </button>
            </header>
            <div className="creative-export-summary">
              <div>
                <span>{t("内容时长")}</span>
                <strong title={formatTime(contentDuration)}>
                  {formatDirectorTimelineTimecode(Math.round(contentDuration * exportFps), editTimebase)}
                </strong>
              </div>
              <div>
                <span>{t("输出尺寸")}</span>
                <strong>
                  {exportSize.width} × {exportSize.height}
                </strong>
              </div>
              <div>
                <span>{t("输出帧数")}</span>
                <strong>{Math.ceil(contentDuration * exportFps)}</strong>
              </div>
            </div>
            <div className="creative-export-settings">
              <label>
                <span>{t("质量")}</span>
                <select
                  disabled={exporting}
                  onChange={(event) =>
                    dispatchVideo(
                      {
                        op: "edit.settings.update",
                        patch: { export_quality: event.currentTarget.value as typeof exportQuality },
                      },
                      t("设置更新失败"),
                    )
                  }
                  value={exportQuality}
                >
                  <option value="preview">720p</option>
                  <option value="full">1080p</option>
                </select>
              </label>
              <label>
                <span>FPS</span>
                <select
                  disabled={exporting}
                  onChange={(event) => updateEditFrameRate(event.currentTarget.value)}
                  value={serializeDirectorFrameRate(editTimebase.rate)}
                >
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.film23976)}>23.976</option>
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.film24)}>24</option>
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.pal25)}>25</option>
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.ntsc2997)}>29.97</option>
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.video30)}>30</option>
                  <option value="50/1">50</option>
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.ntsc5994)}>59.94</option>
                  <option value={serializeDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.video60)}>60</option>
                </select>
              </label>
              <label>
                <span>{t("时码模式")}</span>
                <button
                  aria-pressed={editTimebase.dropFrame}
                  className={editTimebase.dropFrame ? "is-active" : ""}
                  disabled={exporting || !supportsDirectorDropFrame(editTimebase.rate)}
                  onClick={toggleEditDropFrame}
                  title={formatDirectorFrameRate(editTimebase.rate, editTimebase.dropFrame)}
                  type="button"
                >
                  {editTimebase.dropFrame ? "DF" : "NDF"}
                </button>
              </label>
              <label>
                <span>{t("起始时码")}</span>
                <input
                  aria-label={t("起始 SMPTE 时间码")}
                  disabled={exporting}
                  inputMode="text"
                  onBlur={commitEditStartTimecode}
                  onChange={(event) => setStartTimecodeDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitEditStartTimecode();
                  }}
                  value={startTimecodeDraft}
                />
              </label>
              <label>
                <span>{t("格式")}</span>
                <select
                  disabled={exporting}
                  onChange={(event) => setExportFormat(event.currentTarget.value as DirectorTimelineVideoFormat)}
                  value={exportFormat}
                >
                  <option value="auto">{t("自动（推荐）")}</option>
                  <option value="webm">WebM</option>
                  <option value="mp4">MP4</option>
                </select>
              </label>
            </div>
            <p className="creative-export-note">
              {t("使用逐帧画面与 Web Audio 混合导出；MP4 不可用时会自动降级为 WebM。")}
            </p>
            {exportProgress ? (
              <div className="creative-export-progress" role="status">
                <div>
                  <span>{t(exportProgress.phase === "rendering" ? "正在合成画面" : "正在编码视频")}</span>
                  <strong>{Math.round(exportProgress.progress * 100)}%</strong>
                </div>
                <progress max={1} value={exportProgress.progress} />
                <small>
                  F{Math.min(exportProgress.frame + 1, exportProgress.totalFrames)} / F{exportProgress.totalFrames}
                </small>
              </div>
            ) : null}
            {exportError ? <p className="creative-export-message is-error">{t(exportError)}</p> : null}
            {exportResult ? (
              <p className="creative-export-message is-success">
                <CheckCircle2 aria-hidden size={15} /> {t("导出完成并已加入素材库")} · {exportResult}
              </p>
            ) : null}
            <footer>
              {exporting ? (
                <button className="is-secondary" onClick={() => exportAbortRef.current?.abort()} type="button">
                  {t("取消导出")}
                </button>
              ) : (
                <button className="is-secondary" onClick={() => setExportOpen(false)} type="button">
                  {t(exportResult ? "完成" : "取消")}
                </button>
              )}
              <button
                className="is-primary"
                disabled={exporting || contentDuration <= 0}
                onClick={() => void beginVideoExport()}
                type="button"
              >
                <Download aria-hidden size={14} />
                {t(exportResult ? "再次导出" : "开始导出")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}
