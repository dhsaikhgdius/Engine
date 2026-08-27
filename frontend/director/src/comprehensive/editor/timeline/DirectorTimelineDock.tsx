/*
 * Multitrack timeline adaptation from Flier123/agentic-3d-director at
 * a939ec5fd84ae32fcbb3b6b6cb5865216f6d7195.
 * Copyright (c) 2026 YZ. Licensed under the MIT License.
 */
/**
 * Bottom timeline dock of the 3D Stage workspace.
 *
 * One component hosts three tab views: the multitrack frame timeline
 * (storyboard clip row, transform/pose tracks, character motion blocks,
 * audio tracks, record markers), the scene thumbnail browser, and the
 * storyboard editor. The dock reads project data from the Director store
 * and writes every edit back through store actions, so agent-driven edits
 * through the gateway and human edits through this UI stay in sync.
 *
 * Playhead position is deliberately NOT React state here: it lives in
 * `timelineRuntimeStore` and is subscribed to only by the few leaf
 * components that render it (playhead, timecode field), so 60 fps playback
 * does not re-render the whole track tree.
 */
import {
  Box,
  Camera,
  ChevronDown,
  Circle,
  CircleX,
  Clapperboard,
  Database,
  Film,
  Images,
  Layers,
  ListPlus,
  LoaderCircle,
  Minus,
  MonitorPlay,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Replace,
  Route,
  Rows3,
  SkipBack,
  SlidersHorizontal,
  Square,
  Trash2,
  UserRound,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  DirectorCharacterMotionBlock,
  DirectorEntityAnimation,
  DirectorProject,
  DirectorStoryboard,
  DirectorStoryboardShot,
  DirectorTimeline,
  DirectorTimelineAudioClip,
  DirectorTrajectoryPreset,
} from "../schema/directorProject";
import { DIRECTOR_TRAJECTORY_PRESETS } from "../schema/directorProject";
import { MANNEQUIN_POSE_PRESETS, resolveCharacterPoseControls } from "../presets/mannequinPosePresets";
import {
  DIRECTOR_CHARACTER_MOTION_CATALOG,
  getDirectorCharacterMotion,
} from "@director/agent-engine/character-motions";
import type { PosePresetId } from "../schema/poseSchema";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { useDirectorStore } from "../store/directorStore";
import { usePersistentCreativeMediaAssets } from "../media/persistentCreativeMediaStore";
import { ProductionPanel } from "../production/ProductionPanel";
import { DirectorStoryboardPanel } from "../storyboard/DirectorStoryboardPanel";
import {
  createEmptyDirectorStoryboard,
  insertStoryboardShotAtFrame,
  sortStoryboardShots,
} from "../storyboard/directorStoryboard";
import {
  createFramePoseActionAnimation,
  createFrameTrajectoryAnimation,
  resampleTrajectoryDrawingPoints,
} from "../trajectory/trajectoryMath";
import { compileDirectorAnimationRecipe, type DirectorAnimationRecipeInput } from "@director/project-schema";
import {
  clampDirectorCharacterMotionBlockRange,
  createDirectorCharacterMotionBlock,
  insertDirectorCharacterMotionBlock,
  removeDirectorCharacterMotionBlock,
  updateDirectorCharacterMotionBlock,
} from "./characterMotionBlocks";
import {
  getDirectorFrameTracks,
  getEffectiveTimelineEndFrame,
  getDirectorTrackTargetForObject,
  getDirectorTrackTargetByKey,
  removeTransformTrack,
  updateAnimationKeyframe,
  type DirectorFrameTrackTarget,
} from "./frameTimeline";
import { clampTimelineFrame, isDirectorTimelineFrame, MAX_DIRECTOR_TIMELINE_FRAME } from "./frameTime";
import {
  formatDirectorFrameRate,
  frameRateToNumber,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  serializeDirectorFrameRate,
  supportsDirectorDropFrame,
} from "./frameRate";
import { directorTimelineTimecodeToFrame, formatDirectorTimelineTimecode, parseSmpteTimecode } from "./timecode";
import type {
  DirectorTimelineRecordingAction,
  DirectorTimelineRecordingSettings,
  DirectorTimelineRecordingStatus,
} from "./timelineRecording";
import {
  getMaximumTimelineHeight,
  MIN_TIMELINE_HEIGHT,
  PANEL_SASH_CLICK_DRAG_THRESHOLD_PX,
  TIMELINE_COLLAPSE_OVERDRAG_PX,
} from "../../app/layout/workspaceLayout";
import { createAnimationFrameScheduler } from "../../app/layout/animationFrameScheduler";
import type { DirectorMultimodalFrameExportSelection } from "../video/multimodalFrameExport";
import type { DirectorCaptureBackgroundMode } from "../render/renderPassCapture";
import type { DirectorShotRenderPassId } from "../shot/shotPackage";
import { DirectorDatasetOptions } from "./DirectorDatasetOptions";
import { useLanguage } from "../../i18n/language";

/** Container format requested for realtime video export; "auto" lets the encoder pick. */
export type DirectorVideoFormat = "auto" | "webm" | "mp4";

/** Hard cap so extreme zoom x frame counts cannot create an unrenderable DOM canvas. */
const MAX_TIMELINE_CANVAS_WIDTH_PX = 200_000;
const MAX_TIMELINE_TICKS = 240;
const TIMELINE_TICK_LABEL_MIN_SPACING_PX = 64;
const TIMELINE_RULER_ROW_HEIGHT_PX = 36;
const TIMELINE_TRACK_ROW_HEIGHT_PX = 44;
const RECORD_MARKER_LABEL_COLLISION_DISTANCE_PX = 208;
const RECORD_MARKER_EDGE_INSET_PX = 112;
const CLIP_LABEL_MIN_WIDTH_PX = 72;
const KEYFRAME_COLLISION_DISTANCE_PX = 18;
const CHARACTER_MOTION_BLOCK_NUMBER_FIELDS = [
  { field: "speed", label: "速度", ariaLabel: "动作区块速度", minimum: 0.1, maximum: 4, step: 0.05 },
  { field: "weight", label: "权重", ariaLabel: "动作区块权重", minimum: 0, maximum: 1, step: 0.05 },
  { field: "blendInS", label: "淡入 s", ariaLabel: "动作区块淡入（秒）", minimum: 0, maximum: 10, step: 0.05 },
  { field: "blendOutS", label: "淡出 s", ariaLabel: "动作区块淡出（秒）", minimum: 0, maximum: 10, step: 0.05 },
] as const;

const TRAJECTORY_PRESET_ICONS = {
  line: Minus,
  circle: Circle,
  rectangle: Square,
  custom: Pencil,
} as const;

const TOOLBAR_ICON = { size: 14, strokeWidth: 1.75 } as const;

/**
 * Outcome of one export run, reported back so the toolbar can surface the
 * produced file name/range. `packageFingerprint` identifies deterministic
 * frame packages; `fallbackFrom` marks an mp4 request that fell back to webm.
 */
export interface DirectorTimelineExportResult {
  extension: "webm" | "mp4" | "zip";
  frameStart: number;
  frameEnd: number;
  name: string;
  kind?: "video" | "png-sequence" | "multimodal-dataset";
  frameCount?: number;
  packageFingerprint?: string;
  fallbackFrom?: "mp4";
}

/**
 * Playback, recording, and export are owned by the Stage workspace (which
 * drives the actual render loop); the dock only reflects their state and
 * requests transitions through these callbacks.
 */
interface DirectorTimelineDockProps {
  height: number;
  isPlaying: boolean;
  project: DirectorProject;
  timeline: DirectorTimeline;
  onExport: (
    format: DirectorVideoFormat,
    frameStart: number,
    frameEnd: number,
    onProgress: (progress: number, frame: number) => void,
  ) => Promise<DirectorTimelineExportResult>;
  onDeterministicExport: (
    frameStart: number,
    frameEnd: number,
    onProgress: (progress: number, frame: number, phase: "capture" | "encode" | "package") => void,
    options?: { background?: DirectorCaptureBackgroundMode },
  ) => Promise<DirectorTimelineExportResult>;
  onMultimodalExport: (
    frameStart: number,
    frameEnd: number,
    selection: DirectorMultimodalFrameExportSelection,
    onProgress: (progress: number, frame: number, renderPass: DirectorShotRenderPassId) => void,
  ) => Promise<DirectorTimelineExportResult>;
  onCancelDeterministicExport: () => void;
  onRecordingControl: (action: DirectorTimelineRecordingAction) => void;
  onRecordingSettingsChange: (settings: DirectorTimelineRecordingSettings) => void;
  onCollapse: () => void;
  onFrameChange: (frame: number) => void;
  onFrameCommit: (frame: number) => void;
  onHeightChange: (height: number) => void;
  onReset: () => void;
  onTogglePlaying: () => void;
  recordingSettings: DirectorTimelineRecordingSettings;
  recordingStatus: DirectorTimelineRecordingStatus;
}

function TrackIcon({ kind }: { kind: DirectorFrameTrackTarget["kind"] }) {
  if (kind === "camera") return <Camera aria-hidden size={13} />;
  if (kind === "character") return <UserRound aria-hidden size={13} />;
  return <Box aria-hidden size={13} />;
}

/**
 * Keep event props stable while always dispatching to the latest render.
 *
 * Timeline playback changes `currentFrame` many times per second. Stable event
 * identities let the memoized track tree stay mounted without retaining stale
 * editing callbacks when the project or selection changes.
 */
function useTimelineEvent<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

/**
 * Editable SMPTE timecode readout for the playhead.
 *
 * Isolated into its own component so that the per-frame playhead updates from
 * `timelineRuntimeStore` re-render only this input, not the toolbar. While the
 * field is focused it shows the user's draft instead of the live timecode;
 * an unparseable draft reverts on commit rather than moving the playhead.
 */
function TimelineTimecodeField({
  exporting,
  onFrameChange,
  onFrameCommit,
  timeline,
  timelineTimebase,
}: {
  exporting: boolean;
  onFrameChange: (frame: number) => void;
  onFrameCommit: (frame: number) => void;
  timeline: DirectorTimeline;
  timelineTimebase: ReturnType<typeof normalizeDirectorTimebase>;
}) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  const displayedTimecode = useMemo(
    () => formatDirectorTimelineTimecode(currentFrame, timelineTimebase),
    [currentFrame, timelineTimebase],
  );
  const [timeDraft, setTimeDraft] = useState(displayedTimecode);
  const [editingTimeDraft, setEditingTimeDraft] = useState(false);

  function commitTimeDraft() {
    const parsedFrame = directorTimelineTimecodeToFrame(timeDraft, timelineTimebase);
    if (parsedFrame === null) {
      setTimeDraft(displayedTimecode);
      return;
    }
    const frame = clampTimelineFrame(parsedFrame, timeline.frameStart, timeline.frameEnd);
    onFrameChange(frame);
    onFrameCommit(frame);
    setTimeDraft(formatDirectorTimelineTimecode(frame, timelineTimebase));
  }

  return (
    <input
      aria-label="当前 SMPTE 时间码"
      disabled={exporting}
      inputMode="text"
      onBlur={() => {
        commitTimeDraft();
        setEditingTimeDraft(false);
      }}
      onChange={(event) => setTimeDraft(event.currentTarget.value)}
      onFocus={() => {
        setTimeDraft(displayedTimecode);
        setEditingTimeDraft(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") commitTimeDraft();
      }}
      value={editingTimeDraft ? timeDraft : displayedTimecode}
    />
  );
}

/**
 * The vertical playhead line over the track canvas. Subscribes to the runtime
 * store directly so playback moves only this element (and the timecode field),
 * leaving the memoized track rows untouched.
 */
function TimelinePlayhead({
  frameSpan,
  onPointerDown,
  timeline,
}: {
  frameSpan: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  timeline: DirectorTimeline;
}) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  return (
    <div
      aria-label="时间轴播放头"
      aria-valuemax={timeline.frameEnd}
      aria-valuemin={timeline.frameStart}
      aria-valuenow={Math.round(currentFrame)}
      className="animation-timeline-playhead"
      onPointerDown={onPointerDown}
      role="slider"
      style={{ left: `${((currentFrame - timeline.frameStart) / frameSpan) * 100}%` }}
      tabIndex={0}
    >
      <span />
    </div>
  );
}

/** Bridges the runtime playhead into the storyboard panel's `currentFrame` prop. */
function PlayheadStoryboardPanel(props: Omit<ComponentProps<typeof DirectorStoryboardPanel>, "currentFrame">) {
  const currentFrame = useTimelineRuntimeStore((state) => state.playheadFrame);
  return <DirectorStoryboardPanel {...props} currentFrame={currentFrame} />;
}

/**
 * Second-based ruler label for a frame, or null when the frame does not land
 * close enough to a whole/tenth second to deserve a label at all.
 */
function formatTimelineRulerLabel(frame: number, fps: number) {
  const seconds = frame / fps;
  const whole = Math.round(seconds);
  if (Math.abs(seconds - whole) < 0.5 / fps) return `${whole}s`;
  const tenth = Math.round(seconds * 10) / 10;
  if (Math.abs(seconds - tenth) < 0.5 / fps) return `${tenth.toFixed(tenth % 1 === 0 ? 0 : 1)}s`;
  return null;
}

/** Human-readable summary of what an animation track contains (for labels/aria). */
function motionLabel(animation: DirectorEntityAnimation) {
  if (animation.motionBlocks?.length) return `${animation.motionBlocks.length} 段动作`;
  const action = animation.actionPresetId
    ? MANNEQUIN_POSE_PRESETS.find((preset) => preset.id === animation.actionPresetId)
    : undefined;
  if (action) return action.label;
  if (animation.motion === "slow-walk") return "缓步行走";
  if (animation.motion === "walk") return "连续行走";
  if (animation.motion === "jog") return "慢跑";
  if (animation.motion === "sprint") return "冲刺";
  if (animation.motion === "run") return "连续跑动";
  if (animation.recipe?.type === "orbit") return "环绕配方";
  if (animation.recipe?.type === "wave") return "正弦波配方";
  if (animation.recipe?.type === "bounce") return "弹跳配方";
  return "位移";
}

/** Whether a track has anything to render (keyframes or motion blocks). */
function hasTimelineTrackContent(animation: DirectorEntityAnimation | undefined) {
  return Boolean(animation?.keyframes.length || animation?.motionBlocks?.length);
}

/** Converts a pointer position over the track canvas into a clamped frame number. */
function frameAtClientX(clientX: number, rect: DOMRect, timeline: DirectorTimeline) {
  const progress = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  return clampTimelineFrame(
    timeline.frameStart + progress * (timeline.frameEnd - timeline.frameStart),
    timeline.frameStart,
    timeline.frameEnd,
  );
}

function formatAudioClipDurationSec(durationFrames: number, fps: number) {
  return (durationFrames / (fps > 0 ? fps : 24)).toFixed(1);
}

function frameToCanvasPixels(frame: number, timeline: DirectorTimeline, frameSpan: number, canvasWidth: number) {
  return ((frame - timeline.frameStart) / frameSpan) * canvasWidth;
}

/**
 * Assigns each record marker (IN/OUT/manual) a stacking lane so labels of
 * markers that sit close together do not overlap. Bounded to 3 lanes.
 */
function assignRecordMarkerLabelLanes(markerPositions: number[]) {
  const placedMarkers: Array<{ lane: number; position: number }> = [];
  return markerPositions.map((position) => {
    let lane = 0;
    while (
      placedMarkers.some(
        (marker) =>
          marker.lane === lane && Math.abs(marker.position - position) < RECORD_MARKER_LABEL_COLLISION_DISTANCE_PX,
      )
    ) {
      lane += 1;
    }
    const boundedLane = Math.min(lane, 2);
    placedMarkers.push({ lane: boundedLane, position });
    return boundedLane;
  });
}

/**
 * Alternates crowded keyframe markers between two vertical lanes so adjacent
 * diamonds stay individually clickable when they are closer than the marker
 * hit area.
 */
function computeKeyframeLanes(
  keyframes: DirectorEntityAnimation["keyframes"],
  timeline: DirectorTimeline,
  frameSpan: number,
  canvasWidth: number,
) {
  const lanes: Array<0 | 1> = [];
  let previousLane: 0 | 1 = 0;
  for (let index = 0; index < keyframes.length; index += 1) {
    if (index === 0) {
      lanes.push(0);
      continue;
    }
    const separation =
      frameToCanvasPixels(keyframes[index].frame, timeline, frameSpan, canvasWidth) -
      frameToCanvasPixels(keyframes[index - 1].frame, timeline, frameSpan, canvasWidth);
    if (separation < KEYFRAME_COLLISION_DISTANCE_PX) {
      previousLane = previousLane === 0 ? 1 : 0;
    } else {
      previousLane = 0;
    }
    lanes.push(previousLane);
  }
  return lanes;
}

/**
 * One draggable keyframe diamond. During a drag the marker renders a local
 * draft frame and streams scrub feedback via `onFrameChange`; the project
 * store is only written on pointer-up through `onCommit`, keeping undo
 * history to one entry per drag.
 */
function KeyframeMarker({
  frame,
  index,
  lane = 0,
  selected,
  timeline,
  track,
  onCommit,
  onFrameChange,
  onSelect,
}: {
  frame: number;
  index: number;
  lane?: 0 | 1;
  selected: boolean;
  timeline: DirectorTimeline;
  track: DirectorFrameTrackTarget;
  onCommit: (frame: number) => void;
  onFrameChange: (frame: number) => void;
  onSelect: () => void;
}) {
  const [draftFrame, setDraftFrame] = useState<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const displayFrame = draftFrame ?? frame;
  const span = Math.max(1, timeline.frameEnd - timeline.frameStart);

  useEffect(() => () => cleanupRef.current?.(), []);

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    let nextFrame = frameAtClientX(event.clientX, rect, timeline);
    setDraftFrame(nextFrame);
    onFrameChange(nextFrame);
    onSelect();

    function cleanup() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      cleanupRef.current = null;
    }
    function handlePointerMove(pointerEvent: PointerEvent) {
      nextFrame = frameAtClientX(pointerEvent.clientX, rect, timeline);
      setDraftFrame(nextFrame);
      onFrameChange(nextFrame);
    }
    function handlePointerUp(pointerEvent: PointerEvent) {
      nextFrame = frameAtClientX(pointerEvent.clientX, rect, timeline);
      cleanup();
      setDraftFrame(null);
      onCommit(nextFrame);
    }
    function handlePointerCancel() {
      cleanup();
      setDraftFrame(null);
    }
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerCancel, { once: true });
  }

  return (
    <button
      aria-label={`${track.label} 关键帧 ${index + 1}，第 ${displayFrame} 帧`}
      className={`animation-timeline-keyframe${selected ? " is-active" : ""}${lane === 1 ? " is-lane-1" : ""}`}
      onClick={onSelect}
      onPointerDown={beginDrag}
      style={
        {
          left: `${((displayFrame - timeline.frameStart) / span) * 100}%`,
          "--keyframe-color": track.color,
        } as CSSProperties
      }
      type="button"
    />
  );
}

// Custom comparator: event handlers are intentionally excluded because the
// parent wraps them in stable identities via useTimelineEvent.
const MemoizedKeyframeMarker = memo(
  KeyframeMarker,
  (previous, next) =>
    previous.frame === next.frame &&
    previous.index === next.index &&
    previous.lane === next.lane &&
    previous.selected === next.selected &&
    previous.timeline === next.timeline &&
    previous.track === next.track,
);

/**
 * Left-hand column of track name rows: static camera row, then one row per
 * animation track with enable toggle, "add action" affordance for empty
 * tracks, and a delete button. Row order must mirror TimelineTrackRows so the
 * shared grid template keeps labels and canvases aligned.
 */
function TimelineTrackLabels({
  onCommitAnimation,
  onRemoveTrack,
  onRequestAction,
  onSelectCamera,
  onSelectTrack,
  selectedTrackKey,
  staticCameraTrack,
  tracks,
}: {
  onCommitAnimation: (target: DirectorFrameTrackTarget, animation: DirectorEntityAnimation | undefined) => void;
  onRemoveTrack: (target: DirectorFrameTrackTarget) => void;
  onRequestAction: (target: DirectorFrameTrackTarget) => void;
  onSelectCamera: (cameraId: string) => void;
  onSelectTrack: (target: DirectorFrameTrackTarget, keyframeIndex?: number | null) => void;
  selectedTrackKey: string | null;
  staticCameraTrack: DirectorFrameTrackTarget | null;
  tracks: DirectorFrameTrackTarget[];
}) {
  const { t } = useLanguage();
  return (
    <>
      {staticCameraTrack ? (
        <div
          aria-label={`${staticCameraTrack.label} 静止机位`}
          className="animation-timeline-label is-static-camera"
          onClick={() => onSelectCamera(staticCameraTrack.ownerId)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelectCamera(staticCameraTrack.ownerId);
          }}
          role="button"
          tabIndex={0}
        >
          <span className="animation-timeline-track-color" style={{ background: staticCameraTrack.color }} />
          <TrackIcon kind="camera" />
          <span>
            <strong data-i18n-user-content>{t(staticCameraTrack.label)}</strong>
            <small>静止机位</small>
          </span>
        </div>
      ) : null}
      {tracks.map((track) => (
        <div
          aria-label={`${track.label} ${hasTimelineTrackContent(track.animation) ? motionLabel(track.animation!) : "待添加动作"}`}
          className={`animation-timeline-label${track.key === selectedTrackKey ? " is-active" : ""}${hasTimelineTrackContent(track.animation) ? "" : " is-empty-track"}`}
          key={track.key}
          onClick={() => onSelectTrack(track)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") onSelectTrack(track);
          }}
          role="button"
          tabIndex={0}
        >
          <span className="animation-timeline-track-color" style={{ background: track.color }} />
          <TrackIcon kind={track.kind} />
          <span>
            <strong data-i18n-user-content>{t(track.label)}</strong>
            <small>{hasTimelineTrackContent(track.animation) ? motionLabel(track.animation!) : "待添加动作"}</small>
          </span>
          {hasTimelineTrackContent(track.animation) ? (
            <input
              aria-label={`${track.label} 启用轨道`}
              className="animation-timeline-track-toggle"
              checked={track.animation!.enabled !== false}
              onChange={(event) => {
                event.stopPropagation();
                onCommitAnimation(track, { ...track.animation!, enabled: event.currentTarget.checked });
              }}
              onClick={(event) => event.stopPropagation()}
              type="checkbox"
            />
          ) : (
            <button
              aria-label={`为 ${track.label} 添加动作`}
              className="animation-timeline-empty-track-action"
              onClick={(event) => {
                event.stopPropagation();
                onRequestAction(track);
              }}
              type="button"
            >
              添加动作
            </button>
          )}
          <button
            aria-label={`删除 ${track.label} 轨道`}
            className="animation-timeline-delete-track"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveTrack(track);
            }}
            type="button"
          >
            <Trash2 aria-hidden size={12} />
          </button>
        </div>
      ))}
    </>
  );
}

const MemoizedTimelineTrackLabels = memo(TimelineTrackLabels);

/**
 * The track canvas rows: for each animation track it renders the keyframe
 * span clip, character motion blocks, and individual keyframe markers.
 * Memoized (with stable handlers from useTimelineEvent) so playhead movement
 * and unrelated toolbar state never re-render this potentially large tree.
 */
function TimelineTrackRows({
  canvasWidth,
  frameSpan,
  onCommitKeyframe,
  onCommitMotionBlockRange,
  onFrameChange,
  onFrameCommit,
  onRequestAction,
  onSelectMotionBlock,
  onSelectTrack,
  selectedKeyframeIndex,
  selectedMotionBlock,
  selectedTrackKey,
  staticCameraTrack,
  storyboardShotCount,
  timeline,
  tracks,
}: {
  canvasWidth: number;
  frameSpan: number;
  onCommitKeyframe: (target: DirectorFrameTrackTarget, keyframeIndex: number, frame: number) => void;
  onCommitMotionBlockRange: (
    target: DirectorFrameTrackTarget,
    blockId: string,
    range: Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd">,
    mode: MotionBlockEditMode,
  ) => Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd"> | null;
  onFrameChange: (frame: number) => void;
  onFrameCommit: (frame: number) => void;
  onRequestAction: (target: DirectorFrameTrackTarget) => void;
  onSelectMotionBlock: (target: DirectorFrameTrackTarget, blockId: string) => void;
  onSelectTrack: (target: DirectorFrameTrackTarget, keyframeIndex?: number | null) => void;
  selectedKeyframeIndex: number | null;
  selectedMotionBlock: { blockId: string; trackKey: string } | null;
  selectedTrackKey: string | null;
  staticCameraTrack: DirectorFrameTrackTarget | null;
  storyboardShotCount: number;
  timeline: DirectorTimeline;
  tracks: DirectorFrameTrackTarget[];
}) {
  const { locale } = useLanguage();
  return (
    <>
      {staticCameraTrack ? (
        <div
          aria-label={`${staticCameraTrack.label} 静止机位轨道`}
          className="animation-timeline-track-row is-static-camera"
        >
          <span className="animation-timeline-static-camera-clip">静止机位 · 添加动作即可设置运镜</span>
        </div>
      ) : null}
      {tracks.map((track) => {
        const animation = track.animation;
        if (!hasTimelineTrackContent(animation)) {
          return (
            <div
              aria-label={`${track.label} 待添加动作轨道`}
              className={`animation-timeline-track-row is-empty-track${track.key === selectedTrackKey ? " is-active" : ""}`}
              key={track.key}
              onClick={() => onSelectTrack(track)}
            >
              <button
                aria-label={`为 ${track.label} 添加动作`}
                className="animation-timeline-empty-track-clip"
                onClick={(event) => {
                  event.stopPropagation();
                  onRequestAction(track);
                }}
                type="button"
              >
                <Plus aria-hidden size={12} />
                待添加动作
              </button>
            </div>
          );
        }
        const keyframes = animation!.keyframes;
        const motionBlocks = animation!.motionBlocks ?? [];
        const firstFrame = keyframes.length ? Math.min(...keyframes.map((keyframe) => keyframe.frame)) : 0;
        const lastFrame = keyframes.length ? Math.max(...keyframes.map((keyframe) => keyframe.frame)) : 0;
        const spanFrames = Math.max(1, lastFrame - firstFrame);
        const clipWidthPx = (spanFrames / frameSpan) * canvasWidth;
        const showClip = keyframes.length > 0 && firstFrame !== lastFrame;
        const showClipLabel = showClip && clipWidthPx >= CLIP_LABEL_MIN_WIDTH_PX;
        const keyframeLanes = computeKeyframeLanes(keyframes, timeline, frameSpan, canvasWidth);
        return (
          <div
            className={`animation-timeline-track-row${track.key === selectedTrackKey ? " is-active" : ""}`}
            key={track.key}
            onClick={() => onSelectTrack(track)}
          >
            {showClip ? (
              <div
                className={`animation-timeline-clip${showClipLabel ? "" : " is-compact"}${motionBlocks.length ? " is-under-motion" : ""}`}
                style={
                  {
                    "--track-clip-color": track.color,
                    left: `${((firstFrame - timeline.frameStart) / frameSpan) * 100}%`,
                    width: `${(spanFrames / frameSpan) * 100}%`,
                  } as CSSProperties
                }
              >
                {showClipLabel ? <span>{motionLabel(animation!)}</span> : null}
              </div>
            ) : null}
            {motionBlocks.map((block) => (
              <CharacterMotionTimelineBlock
                block={block}
                color={track.color}
                key={block.id}
                label={
                  locale === "en-US"
                    ? (getDirectorCharacterMotion(block.clipId)?.name ?? block.clipId)
                    : (getDirectorCharacterMotion(block.clipId)?.nameZh ?? block.clipId)
                }
                onFrameChange={onFrameChange}
                onFrameCommit={onFrameCommit}
                onRangeCommit={(range, mode) => onCommitMotionBlockRange(track, block.id, range, mode)}
                onSelect={() => onSelectMotionBlock(track, block.id)}
                selected={selectedMotionBlock?.trackKey === track.key && selectedMotionBlock.blockId === block.id}
                timeline={timeline}
              />
            ))}
            {keyframes.map((keyframe, keyframeIndex) => (
              <MemoizedKeyframeMarker
                frame={keyframe.frame}
                index={keyframeIndex}
                key={`${keyframe.frame}-${keyframeIndex}`}
                lane={keyframeLanes[keyframeIndex]}
                selected={track.key === selectedTrackKey && keyframeIndex === selectedKeyframeIndex}
                timeline={timeline}
                track={track}
                onFrameChange={onFrameChange}
                onSelect={() => onSelectTrack(track, keyframeIndex)}
                onCommit={(frame) => onCommitKeyframe(track, keyframeIndex, frame)}
              />
            ))}
          </div>
        );
      })}
      {tracks.length === 0 && !staticCameraTrack && storyboardShotCount === 0 ? (
        <div className="animation-timeline-empty">选择角色、道具或机位，然后创建轨迹</div>
      ) : null}
    </>
  );
}

const MemoizedTimelineTrackRows = memo(TimelineTrackRows);

/** Drag gestures shared by storyboard clips and motion blocks. */
type StoryboardEditMode = "move" | "trim-start" | "trim-end";
type MotionBlockEditMode = StoryboardEditMode;

/**
 * One storyboard shot rendered as a draggable/trim-able clip on the storyboard
 * row. Drafts the range locally during the gesture and commits once on
 * pointer-up; the parent then clamps the range against neighbouring shots.
 */
function StoryboardTimelineClip({
  cameraLabel,
  index,
  onFrameChange,
  onFrameCommit,
  onRangeCommit,
  onSelect,
  selected,
  shot,
  timeline,
}: {
  cameraLabel: string;
  index: number;
  onFrameChange: (frame: number) => void;
  onFrameCommit: (frame: number) => void;
  onRangeCommit: (range: Pick<DirectorStoryboardShot, "frameStart" | "frameEnd">, mode: StoryboardEditMode) => void;
  onSelect: () => void;
  selected: boolean;
  shot: DirectorStoryboardShot;
  timeline: DirectorTimeline;
}) {
  const { t } = useLanguage();
  const [draftRange, setDraftRange] = useState<Pick<DirectorStoryboardShot, "frameStart" | "frameEnd"> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const displayedRange = draftRange ?? shot;
  const span = Math.max(1, timeline.frameEnd - timeline.frameStart);
  const shotNumber = String(index + 1).padStart(2, "0");
  const titleWithoutIndex = shot.title.replace(/^\d+\s*·\s*/, "").trim() || shot.title;
  const showCameraLabel =
    Boolean(cameraLabel) &&
    cameraLabel !== "未指定机位" &&
    cameraLabel !== titleWithoutIndex &&
    !titleWithoutIndex.includes(cameraLabel);

  useEffect(() => () => cleanupRef.current?.(), []);

  function beginEdit(mode: StoryboardEditMode, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const initialRange = { frameStart: shot.frameStart, frameEnd: shot.frameEnd };
    const pointerStart = frameAtClientX(event.clientX, rect, timeline);
    let nextRange = initialRange;
    onSelect();
    setDraftRange(initialRange);

    function update(pointerEvent: PointerEvent) {
      const frame = frameAtClientX(pointerEvent.clientX, rect, timeline);
      if (mode === "move") {
        const delta = frame - pointerStart;
        nextRange = {
          frameStart: initialRange.frameStart + delta,
          frameEnd: initialRange.frameEnd + delta,
        };
      } else if (mode === "trim-start") {
        nextRange = { ...initialRange, frameStart: Math.min(frame, initialRange.frameEnd) };
      } else {
        nextRange = { ...initialRange, frameEnd: Math.max(frame, initialRange.frameStart) };
      }
      setDraftRange(nextRange);
      onFrameChange(mode === "trim-end" ? nextRange.frameEnd : nextRange.frameStart);
    }

    function cleanup() {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
      cleanupRef.current = null;
    }

    function commit() {
      cleanup();
      setDraftRange(null);
      onRangeCommit(nextRange, mode);
      onFrameCommit(mode === "trim-end" ? nextRange.frameEnd : nextRange.frameStart);
    }

    function cancel() {
      cleanup();
      setDraftRange(null);
    }

    cleanupRef.current?.();
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", commit, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  }

  return (
    <div
      className={`animation-timeline-storyboard-clip${selected ? " is-selected" : ""}`}
      style={{
        left: `${((displayedRange.frameStart - timeline.frameStart) / span) * 100}%`,
        width: `${(Math.max(1, displayedRange.frameEnd - displayedRange.frameStart + 1) / span) * 100}%`,
      }}
    >
      <button
        aria-label={`分镜 ${index + 1}：${shot.title}，第 ${displayedRange.frameStart} 到 ${displayedRange.frameEnd} 帧`}
        className="animation-timeline-storyboard-clip-main"
        onClick={onSelect}
        onPointerDown={(event) => beginEdit("move", event)}
        type="button"
      >
        <span className="animation-timeline-storyboard-clip-index">{shotNumber}</span>
        <span className="animation-timeline-storyboard-clip-copy">
          <strong data-i18n-user-content>{t(titleWithoutIndex)}</strong>
          {showCameraLabel ? <small data-i18n-user-content>{t(cameraLabel)}</small> : null}
        </span>
      </button>
      <button
        aria-label={`调整分镜 ${shot.title} 入点`}
        className="animation-timeline-storyboard-trim is-start"
        onPointerDown={(event) => beginEdit("trim-start", event)}
        type="button"
      />
      <button
        aria-label={`调整分镜 ${shot.title} 出点`}
        className="animation-timeline-storyboard-trim is-end"
        onPointerDown={(event) => beginEdit("trim-end", event)}
        type="button"
      />
    </div>
  );
}

/**
 * One audio clip on an audio track. Only horizontal movement is a drag
 * gesture; duration/volume/fades are edited through the toolbar settings
 * popover. Commits only when the start frame actually changed.
 */
function StageAudioTimelineClip({
  clip,
  muted,
  onMove,
  onSelect,
  selected,
  timeline,
}: {
  clip: DirectorTimelineAudioClip;
  /** Track-level mute; the clip renders dimmed for either mute source. */
  muted: boolean;
  onMove: (startFrame: number) => void;
  onSelect: () => void;
  selected: boolean;
  timeline: DirectorTimeline;
}) {
  const { t } = useLanguage();
  const [draftStartFrame, setDraftStartFrame] = useState<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const span = Math.max(1, timeline.frameEnd - timeline.frameStart);
  const startFrame = draftStartFrame ?? clip.startFrame;

  useEffect(() => () => cleanupRef.current?.(), []);

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pointerStart = frameAtClientX(event.clientX, rect, timeline);
    let nextStart = clip.startFrame;
    onSelect();
    setDraftStartFrame(clip.startFrame);

    function update(pointerEvent: PointerEvent) {
      const delta = frameAtClientX(pointerEvent.clientX, rect, timeline) - pointerStart;
      nextStart = Math.max(0, clip.startFrame + delta);
      setDraftStartFrame(nextStart);
    }

    function cleanup() {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
      cleanupRef.current = null;
    }

    function commit() {
      cleanup();
      setDraftStartFrame(null);
      if (nextStart !== clip.startFrame) onMove(nextStart);
    }

    function cancel() {
      cleanup();
      setDraftStartFrame(null);
    }

    cleanupRef.current?.();
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", commit, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  }

  return (
    <button
      aria-label={`音频片段 ${clip.name}`}
      aria-pressed={selected}
      className={`animation-timeline-audio-clip${selected ? " is-selected" : ""}${muted || clip.muted ? " is-muted" : ""}`}
      onPointerDown={beginDrag}
      style={{
        left: `${((startFrame - timeline.frameStart) / span) * 100}%`,
        width: `${(Math.max(1, clip.durationFrames) / span) * 100}%`,
      }}
      title={`${clip.name} · F${startFrame} · ${Math.round(clip.volume * 100)}%`}
      type="button"
    >
      <Music aria-hidden size={11} />
      <span className="animation-timeline-audio-clip-copy">
        <strong data-i18n-user-content>{t(clip.name)}</strong>
        <small>
          F{startFrame} · {Math.round(clip.volume * 100)}%
        </small>
      </span>
    </button>
  );
}

/**
 * One character motion block (a clip of catalog motion such as walk/idle)
 * rendered above the transform clip. Move/trim drags draft locally and commit
 * once; `onRangeCommit` may return a corrected range (overlap clamping), which
 * is what the playhead is finally parked on.
 */
function CharacterMotionTimelineBlock({
  block,
  color,
  label,
  onFrameChange,
  onFrameCommit,
  onRangeCommit,
  onSelect,
  selected,
  timeline,
}: {
  block: DirectorCharacterMotionBlock;
  color: string;
  label: string;
  onFrameChange: (frame: number) => void;
  onFrameCommit: (frame: number) => void;
  onRangeCommit: (
    range: Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd">,
    mode: MotionBlockEditMode,
  ) => Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd"> | null;
  onSelect: () => void;
  selected: boolean;
  timeline: DirectorTimeline;
}) {
  const { locale } = useLanguage();
  const [draftRange, setDraftRange] = useState<Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd"> | null>(
    null,
  );
  const cleanupRef = useRef<(() => void) | null>(null);
  const displayedRange = draftRange ?? block;
  const span = Math.max(1, timeline.frameEnd - timeline.frameStart);

  useEffect(() => () => cleanupRef.current?.(), []);

  function beginEdit(mode: MotionBlockEditMode, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const initialRange = { frameStart: block.frameStart, frameEnd: block.frameEnd };
    const pointerStart = frameAtClientX(event.clientX, rect, timeline);
    let nextRange = initialRange;
    onSelect();
    setDraftRange(initialRange);

    function update(pointerEvent: PointerEvent) {
      const frame = frameAtClientX(pointerEvent.clientX, rect, timeline);
      if (mode === "move") {
        const delta = frame - pointerStart;
        nextRange = { frameStart: initialRange.frameStart + delta, frameEnd: initialRange.frameEnd + delta };
      } else if (mode === "trim-start") {
        nextRange = { ...initialRange, frameStart: Math.min(frame, initialRange.frameEnd) };
      } else {
        nextRange = { ...initialRange, frameEnd: Math.max(frame, initialRange.frameStart) };
      }
      setDraftRange(nextRange);
      onFrameChange(mode === "trim-end" ? nextRange.frameEnd : nextRange.frameStart);
    }

    function cleanup() {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", cancel);
      cleanupRef.current = null;
    }

    function commit() {
      cleanup();
      setDraftRange(null);
      const committedRange = onRangeCommit(nextRange, mode) ?? initialRange;
      onFrameCommit(mode === "trim-end" ? committedRange.frameEnd : committedRange.frameStart);
    }

    function cancel() {
      cleanup();
      setDraftRange(null);
    }

    cleanupRef.current?.();
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", commit, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  }

  return (
    <div
      className={`animation-timeline-motion-block${selected ? " is-selected" : ""}`}
      style={
        {
          "--motion-block-color": color,
          left: `${((displayedRange.frameStart - timeline.frameStart) / span) * 100}%`,
          width: `${(Math.max(1, displayedRange.frameEnd - displayedRange.frameStart + 1) / span) * 100}%`,
        } as CSSProperties
      }
    >
      <button
        aria-label={
          locale === "en-US"
            ? `Motion block ${label}, frames ${displayedRange.frameStart} to ${displayedRange.frameEnd}`
            : `动作区块 ${label}，第 ${displayedRange.frameStart} 到 ${displayedRange.frameEnd} 帧`
        }
        className="animation-timeline-motion-block-main"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerDown={(event) => beginEdit("move", event)}
        type="button"
      >
        <strong data-i18n-user-content>{label}</strong>
        <small>
          F{displayedRange.frameStart}–{displayedRange.frameEnd}
        </small>
      </button>
      <button
        aria-label={locale === "en-US" ? `Trim ${label} motion block start` : `调整动作区块 ${label} 入点`}
        className="animation-timeline-motion-trim is-start"
        onPointerDown={(event) => beginEdit("trim-start", event)}
        type="button"
      />
      <button
        aria-label={locale === "en-US" ? `Trim ${label} motion block end` : `调整动作区块 ${label} 出点`}
        className="animation-timeline-motion-trim is-end"
        onPointerDown={(event) => beginEdit("trim-end", event)}
        type="button"
      />
    </div>
  );
}

/**
 * The timeline dock itself. Sections below: store wiring, local UI state,
 * derived layout math (ticks/labels/lanes), track CRUD, storyboard editing,
 * motion-block editing, animation recipes, timebase editing, pointer drags,
 * exports, and finally the three tab views.
 */
export function DirectorTimelineDock({
  height,
  isPlaying,
  project,
  timeline,
  onCollapse,
  onCancelDeterministicExport,
  onDeterministicExport,
  onMultimodalExport,
  onExport,
  onRecordingControl,
  onRecordingSettingsChange,
  onFrameChange,
  onFrameCommit,
  onHeightChange,
  onReset,
  onTogglePlaying,
  recordingSettings,
  recordingStatus,
}: DirectorTimelineDockProps) {
  const { locale, t } = useLanguage();
  // -- Store wiring: project mutations go through directorStore actions (undoable);
  // transient selection/scrub state goes through timelineRuntimeStore (not undoable).
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const updateScene = useDirectorStore((state) => state.updateScene);
  const updateStoryboard = useDirectorStore((state) => state.updateStoryboard);
  const selectObject = useDirectorStore((state) => state.selectObject);
  const setObjectAnimation = useDirectorStore((state) => state.setObjectAnimation);
  const setCameraAnimation = useDirectorStore((state) => state.setCameraAnimation);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);
  const updateCamera = useDirectorStore((state) => state.updateCamera);
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);
  const addTimelineAudioClip = useDirectorStore((state) => state.addTimelineAudioClip);
  const updateTimelineAudioClip = useDirectorStore((state) => state.updateTimelineAudioClip);
  const moveTimelineAudioClip = useDirectorStore((state) => state.moveTimelineAudioClip);
  const removeTimelineAudioClip = useDirectorStore((state) => state.removeTimelineAudioClip);
  const setTimelineAudioTrackMuted = useDirectorStore((state) => state.setTimelineAudioTrackMuted);
  const selectedTrackKey = useTimelineRuntimeStore((state) => state.selectedTrackKey);
  const selectedKeyframeIndex = useTimelineRuntimeStore((state) => state.selectedKeyframeIndex);
  const drawingTrackKey = useTimelineRuntimeStore((state) => state.drawingTrackKey);
  const drawingPoints = useTimelineRuntimeStore((state) => state.drawingPoints);
  const selectTrack = useTimelineRuntimeStore((state) => state.selectTrack);
  const beginDrawing = useTimelineRuntimeStore((state) => state.beginDrawing);
  const cancelDrawing = useTimelineRuntimeStore((state) => state.cancelDrawing);
  // -- Local UI state: zoom, open popovers, and edit drafts. Drafts (fps,
  // timecode, frame end) buffer keystrokes and only write to the project on
  // blur/Enter so partial input never produces an invalid timeline.
  const [pixelsPerFrame, setPixelsPerFrame] = useState(4);
  const [trajectoryMenuOpen, setTrajectoryMenuOpen] = useState(false);
  const [recipePanelOpen, setRecipePanelOpen] = useState(false);
  const [recipeType, setRecipeType] = useState<DirectorAnimationRecipeInput["type"]>("wave");
  const [recipeAxis, setRecipeAxis] = useState<"x" | "y" | "z">("y");
  const [recipeAmount, setRecipeAmount] = useState(1.5);
  const [recipeCycles, setRecipeCycles] = useState(2);
  const [recipeOption, setRecipeOption] = useState(true);
  const [recipeClockwise, setRecipeClockwise] = useState(false);
  const [recipePhaseDegrees, setRecipePhaseDegrees] = useState(0);
  const [characterActionPresetId, setCharacterActionPresetId] = useState<PosePresetId>("wave");
  const [characterActionDuration, setCharacterActionDuration] = useState(24);
  const [characterMotionClipId, setCharacterMotionClipId] = useState(
    DIRECTOR_CHARACTER_MOTION_CATALOG[0]?.id ?? "idle",
  );
  const [characterMotionBlockDuration, setCharacterMotionBlockDuration] = useState(24);
  const [selectedMotionBlock, setSelectedMotionBlock] = useState<{ blockId: string; trackKey: string } | null>(null);
  const [motionSettingsOpen, setMotionSettingsOpen] = useState(false);
  const [motionBlockMessage, setMotionBlockMessage] = useState("");
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
  const [audioMediaSelection, setAudioMediaSelection] = useState("");
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const timelineTimebase = useMemo(
    () => normalizeDirectorTimebase(timeline.timebase, timeline.fps),
    [timeline.fps, timeline.timebase],
  );
  const timelineFps = frameRateToNumber(timelineTimebase.rate);
  const [fpsDraft, setFpsDraft] = useState(() => serializeDirectorFrameRate(timelineTimebase.rate));
  const [startTimecodeDraft, setStartTimecodeDraft] = useState(timelineTimebase.startTimecode);
  const [frameEndDraft, setFrameEndDraft] = useState(String(timeline.frameEnd));
  const [bottomView, setBottomView] = useState<"timeline" | "scenes" | "storyboard">("timeline");
  const [selectedStoryboardShotId, setSelectedStoryboardShotId] = useState<string | null>(null);
  const sourceShotNavigationHandledRef = useRef(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportFrame, setExportFrame] = useState<number | null>(null);
  const [activeExportMode, setActiveExportMode] = useState<"realtime" | "deterministic" | "dataset" | null>(null);
  const [deterministicTransparentBackground, setDeterministicTransparentBackground] = useState(false);
  const [datasetSelection, setDatasetSelection] = useState<DirectorMultimodalFrameExportSelection>({
    renderPasses: ["clean"],
    includeCamera: true,
    includeObjects: true,
  });
  const exporting = useTimelineRuntimeStore((state) => state.exporting);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // -- Derived data: track targets, storyboard, and audio all recompute from
  // the project snapshot so external (agent/gateway) edits appear immediately.
  const tracks = useMemo(() => getDirectorFrameTracks(project), [project]);
  const effectiveFrameEnd = useMemo(() => getEffectiveTimelineEndFrame(project), [project]);
  const recordableFrameEnd = Math.max(timeline.frameStart, effectiveFrameEnd);
  const recordRange = recordingSettings.exportRange;
  const activeCameraTarget = useMemo(() => {
    const activeCamera = project.cameras.find((camera) => camera.id === project.activeCameraId) ?? project.cameras[0];
    if (!activeCamera) return null;
    const cameraObject = project.objects.find(
      (object) => object.kind === "camera" && object.linkedCameraId === activeCamera.id,
    );
    return getDirectorTrackTargetForObject(project, cameraObject?.id);
  }, [project]);
  const selectedTarget = useMemo(
    () => getDirectorTrackTargetForObject(project, selectedObjectId) ?? activeCameraTarget,
    [activeCameraTarget, project, selectedObjectId],
  );
  const storyboard = useMemo(() => project.storyboard ?? createEmptyDirectorStoryboard(), [project.storyboard]);
  const storyboardShots = useMemo(() => sortStoryboardShots(storyboard.shots), [storyboard.shots]);
  // The active camera without an animation track still gets a read-only
  // "static camera" row, so the shot's camera is always visible in the dock.
  const staticCameraTrack =
    activeCameraTarget && !tracks.some((track) => track.key === activeCameraTarget.key) ? activeCameraTarget : null;
  const audioTracks = useMemo(() => timeline.audioTracks ?? [], [timeline.audioTracks]);
  const mediaAssets = usePersistentCreativeMediaAssets();
  const audioMediaAssets = useMemo(
    () => mediaAssets.filter((asset) => asset.kind === "audio" && !asset.proxyOf),
    [mediaAssets],
  );
  const selectedAudio = useMemo(() => {
    for (const track of audioTracks) {
      const clip = track.clips.find((entry) => entry.id === selectedAudioClipId);
      if (clip) return { track, clip };
    }
    return null;
  }, [audioTracks, selectedAudioClipId]);

  useEffect(() => {
    if (selectedAudioClipId && !selectedAudio) setSelectedAudioClipId(null);
  }, [selectedAudio, selectedAudioClipId]);

  function addAudioClipFromMedia() {
    const asset = audioMediaAssets.find((item) => item.id === audioMediaSelection) ?? audioMediaAssets[0];
    if (!asset) return;
    // Media without probed duration still gets an audible, adjustable clip.
    const durationFrames = Math.max(1, Math.round((asset.durationSec ?? 5) * timelineFps));
    const clipId = addTimelineAudioClip({
      mediaId: asset.id,
      name: asset.name,
      durationFrames,
      ...(asset.durationSec ? { sourceDurationSec: asset.durationSec } : {}),
    });
    if (clipId) {
      setSelectedAudioClipId(clipId);
      setAudioSettingsOpen(true);
    }
  }
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const [timelineScrollViewportHeight, setTimelineScrollViewportHeight] = useState(0);

  // Track the scroll viewport height so rowTemplate can stretch a small number
  // of tracks to fill the dock instead of leaving dead space below them.
  useLayoutEffect(() => {
    if (bottomView !== "timeline") return;
    const node = timelineScrollRef.current;
    if (!node) return;

    const updateViewportHeight = () => setTimelineScrollViewportHeight(node.clientHeight);
    updateViewportHeight();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateViewportHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [bottomView, height]);
  const selectedMotionTrack = selectedMotionBlock
    ? (tracks.find((track) => track.key === selectedMotionBlock.trackKey) ?? null)
    : null;
  const selectedMotionBlockValue = selectedMotionTrack?.animation?.motionBlocks?.find(
    (block) => block.id === selectedMotionBlock?.blockId,
  );
  // -- Layout math: canvas width follows zoom, and marker/tick/label placement
  // derives from it. Everything is plain arithmetic per render; only the tick
  // and label lists are memoized because they allocate arrays/maps.
  const frameSpan = Math.max(1, timeline.frameEnd - timeline.frameStart);
  const canvasWidth = Math.min(MAX_TIMELINE_CANVAS_WIDTH_PX, Math.max(760, (frameSpan + 1) * pixelsPerFrame));
  const recordMarkerLabelLanes = assignRecordMarkerLabelLanes(
    [recordRange.in, recordRange.out, recordingSettings.manualStart].map((frame) =>
      frameToCanvasPixels(frame, timeline, frameSpan, canvasWidth),
    ),
  );
  const recordInNearStart =
    frameToCanvasPixels(recordRange.in, timeline, frameSpan, canvasWidth) < RECORD_MARKER_EDGE_INSET_PX;
  const recordOutNearEnd =
    canvasWidth - frameToCanvasPixels(recordRange.out, timeline, frameSpan, canvasWidth) < RECORD_MARKER_EDGE_INSET_PX;
  const manualNearStart =
    frameToCanvasPixels(recordingSettings.manualStart, timeline, frameSpan, canvasWidth) < RECORD_MARKER_EDGE_INSET_PX;
  const manualNearEnd =
    canvasWidth - frameToCanvasPixels(recordingSettings.manualStart, timeline, frameSpan, canvasWidth) <
    RECORD_MARKER_EDGE_INSET_PX;
  const tickStep = Math.max(
    1,
    Math.ceil(frameSpan / MAX_TIMELINE_TICKS),
    Math.round(timelineFps / Math.max(1, pixelsPerFrame / 2)),
  );
  const ticks = useMemo(() => {
    const values: number[] = [];
    for (let frame = timeline.frameStart; frame <= timeline.frameEnd; frame += tickStep) values.push(frame);
    if (values[values.length - 1] !== timeline.frameEnd) values.push(timeline.frameEnd);
    return values;
  }, [tickStep, timeline.frameEnd, timeline.frameStart]);
  const tickPixelSpacing = (tickStep / frameSpan) * canvasWidth;
  const tickLabelStride = Math.max(1, Math.ceil(TIMELINE_TICK_LABEL_MIN_SPACING_PX / tickPixelSpacing));
  // Greedy left-to-right label placement: keep a label only when it fits after
  // the previous one; the terminal frame label is right-aligned and always wins.
  const timelineRulerLabels = useMemo(() => {
    const labels = new Map<number, string>();
    let previousLabelEnd = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < ticks.length; index += 1) {
      const frame = ticks[index]!;
      const isTerminal = frame === timeline.frameEnd && frame !== timeline.frameStart;
      if (index % tickLabelStride !== 0 && !isTerminal) continue;

      const label = formatTimelineRulerLabel(frame, timelineFps);
      if (!label) continue;

      const estimatedWidth = label.length * 7 + 10;
      const position = ((frame - timeline.frameStart) / frameSpan) * canvasWidth;
      const labelStart = isTerminal ? position - estimatedWidth : position;
      if (labelStart < previousLabelEnd + 8) continue;

      labels.set(frame, label);
      previousLabelEnd = isTerminal ? position : labelStart + estimatedWidth;
    }
    return labels;
  }, [canvasWidth, frameSpan, tickLabelStride, ticks, timeline.frameEnd, timeline.frameStart, timelineFps]);

  // Resync drafts and prune stale selections whenever the project changes
  // underneath the dock (undo, agent edit, collaboration).
  useEffect(() => setFpsDraft(serializeDirectorFrameRate(timelineTimebase.rate)), [timelineTimebase]);
  useEffect(() => setStartTimecodeDraft(timelineTimebase.startTimecode), [timelineTimebase.startTimecode]);
  useEffect(() => setFrameEndDraft(String(timeline.frameEnd)), [timeline.frameEnd]);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  useEffect(() => {
    if (!selectedMotionBlock) return;
    if (!selectedMotionBlockValue) setSelectedMotionBlock(null);
  }, [selectedMotionBlock, selectedMotionBlockValue]);
  useEffect(() => {
    if (selectedMotionBlockValue) setCharacterMotionClipId(selectedMotionBlockValue.clipId);
  }, [selectedMotionBlockValue]);
  useEffect(() => setMotionSettingsOpen(false), [selectedMotionBlock?.blockId, selectedMotionBlock?.trackKey]);
  useEffect(() => {
    if (selectedStoryboardShotId && storyboardShots.some((shot) => shot.id === selectedStoryboardShotId)) return;
    setSelectedStoryboardShotId(storyboardShots[0]?.id ?? null);
  }, [selectedStoryboardShotId, storyboardShots]);
  // Deep link: `?storyboardShot=<id>` (e.g. from the Canvas workspace) opens
  // the storyboard tab on that shot exactly once, then strips the parameter so
  // refreshes and later navigation are unaffected.
  useEffect(() => {
    if (sourceShotNavigationHandledRef.current || typeof window === "undefined") return;
    const shotId = new URLSearchParams(window.location.search).get("storyboardShot");
    if (!shotId) {
      sourceShotNavigationHandledRef.current = true;
      return;
    }
    if (!storyboardShots.some((shot) => shot.id === shotId)) return;
    sourceShotNavigationHandledRef.current = true;
    setBottomView("storyboard");
    setSelectedStoryboardShotId(shotId);
    const url = new URL(window.location.href);
    url.searchParams.delete("storyboardShot");
    window.history.replaceState(window.history.state, "", url);
  }, [storyboardShots]);

  // -- Track CRUD and selection. A "track" is derived from the entity's
  // animation plus timeline.trackKeys; committing an animation routes to the
  // camera or object store action depending on the track owner.

  function commitAnimation(target: DirectorFrameTrackTarget, animation: DirectorEntityAnimation | undefined) {
    if (target.ownerType === "camera") setCameraAnimation(target.ownerId, animation);
    else setObjectAnimation(target.ownerId, animation);
  }

  function selectTimelineTrack(target: DirectorFrameTrackTarget, keyframeIndex: number | null = null) {
    if (target.ownerType === "camera") setActiveCamera(target.ownerId);
    else selectObject(target.objectId);
    selectTrack(target.key, keyframeIndex);
    setSelectedMotionBlock(null);
    setMotionBlockMessage("");
  }

  function selectMotionTimelineBlock(target: DirectorFrameTrackTarget, blockId: string) {
    if (target.ownerType === "camera") setActiveCamera(target.ownerId);
    else selectObject(target.objectId);
    selectTrack(target.key);
    setSelectedMotionBlock({ trackKey: target.key, blockId });
    setMotionBlockMessage("");
  }

  // Registers the track key so an entity with no keyframes yet still shows an
  // (empty) row that the user can drop an action onto.
  function ensureTimelineTrack(target: DirectorFrameTrackTarget) {
    const trackKeys = timeline.trackKeys ?? [];
    if (!trackKeys.includes(target.key)) {
      updateScene({ timeline: { ...timeline, trackKeys: [...trackKeys, target.key] } });
    }
  }

  function addTimelineTrack(target: DirectorFrameTrackTarget) {
    ensureTimelineTrack(target);
    selectTimelineTrack(target);
  }

  function removeTimelineTrack(target: DirectorFrameTrackTarget) {
    commitAnimation(target, removeTransformTrack(target.animation));
    const trackKeys = timeline.trackKeys ?? [];
    if (trackKeys.includes(target.key)) {
      updateScene({ timeline: { ...timeline, trackKeys: trackKeys.filter((key) => key !== target.key) } });
    }
    if (target.key === selectedTrackKey) selectTrack(null);
    if (target.key === selectedMotionBlock?.trackKey) setSelectedMotionBlock(null);
  }

  // A camera that just received a trajectory must also be switched into
  // path-follow mode, otherwise the new keyframes would not drive the shot.
  function activateCameraPath(target: DirectorFrameTrackTarget) {
    if (target.ownerType !== "camera") return;
    const camera = project.cameras.find((item) => item.id === target.ownerId);
    updateCamera(target.ownerId, {
      action: {
        mode: "path",
        path: {
          speed: camera?.action?.path?.speed ?? 1,
          lockTarget: camera?.action?.path?.lockTarget ?? false,
          targetObjectId: camera?.action?.path?.targetObjectId ?? null,
        },
      },
    });
  }

  // -- Storyboard editing. Shots are kept sorted on every write so the clip
  // row and neighbour-clamping logic can assume chronological order.

  function writeStoryboard(next: DirectorStoryboard) {
    updateStoryboard({ ...next, shots: sortStoryboardShots(next.shots) });
  }

  function addStoryboardShot() {
    const currentFrame = useTimelineRuntimeStore.getState().playheadFrame;
    const result = insertStoryboardShotAtFrame({ project, currentFrame, timeline });
    writeStoryboard(result.storyboard);
    if (result.frameEnd > timeline.frameEnd) {
      updateScene({ timeline: { ...timeline, frameEnd: result.frameEnd } });
    }
    setSelectedStoryboardShotId(result.shot.id);
  }

  function getStoryboardCameraLabel(shot: DirectorStoryboardShot) {
    return project.cameras.find((camera) => camera.id === shot.cameraId)?.name ?? "未指定机位";
  }

  /**
   * Clamps a dragged shot range against its chronological neighbours (shots
   * may not overlap) and the timeline bounds, preserving duration for "move"
   * and the untouched edge for trims, then writes the storyboard.
   */
  function commitStoryboardClipRange(
    shotId: string,
    requested: Pick<DirectorStoryboardShot, "frameStart" | "frameEnd">,
    mode: StoryboardEditMode,
  ) {
    const target = storyboardShots.find((shot) => shot.id === shotId);
    if (!target) return;
    const targetIndex = storyboardShots.findIndex((shot) => shot.id === shotId);
    const previous = targetIndex > 0 ? storyboardShots[targetIndex - 1] : null;
    const next = targetIndex < storyboardShots.length - 1 ? storyboardShots[targetIndex + 1] : null;
    const minimumFrame = previous ? previous.frameEnd + 1 : timeline.frameStart;
    const maximumFrame = next ? next.frameStart - 1 : timeline.frameEnd;
    const duration = Math.max(1, target.frameEnd - target.frameStart);
    let frameStart = Math.max(minimumFrame, Math.min(maximumFrame, Math.round(requested.frameStart)));
    let frameEnd = Math.max(frameStart, Math.min(maximumFrame, Math.round(requested.frameEnd)));

    if (mode === "move") {
      frameStart = Math.max(minimumFrame, Math.min(maximumFrame - duration, frameStart));
      frameEnd = frameStart + duration;
    } else if (mode === "trim-start") {
      frameStart = Math.min(frameStart, target.frameEnd);
      frameEnd = target.frameEnd;
    } else {
      frameStart = target.frameStart;
      frameEnd = Math.max(frameStart, frameEnd);
    }

    writeStoryboard({
      ...storyboard,
      shots: storyboard.shots.map((shot) => (shot.id === shotId ? { ...shot, frameStart, frameEnd } : shot)),
    });
  }

  // -- Trajectory presets, pose actions, and motion blocks: each compiles a
  // parametric description into concrete keyframes/blocks via trajectoryMath
  // and characterMotionBlocks helpers, then commits through the store.

  function applyPreset(preset: DirectorTrajectoryPreset) {
    if (!selectedTarget) return;
    setTrajectoryMenuOpen(false);
    ensureTimelineTrack(selectedTarget);
    // "custom" switches the Stage viewport into ground-click drawing mode;
    // the trajectory is only compiled when the user finishes the drawing.
    if (preset === "custom") {
      beginDrawing(selectedTarget.key, selectedTarget.baseTransform.position);
      return;
    }
    const animation = createFrameTrajectoryAnimation({
      baseTransform: selectedTarget.baseTransform,
      frameStart: timeline.frameStart,
      frameEnd: timeline.frameEnd,
      preset,
      existingAnimation: selectedTarget.animation,
      cameraTarget: selectedTarget.cameraTarget,
      cameraFov: selectedTarget.cameraFov,
      orientToPath: selectedTarget.kind !== "camera",
      motion: selectedTarget.kind === "character" ? "walk" : "none",
      source: "preset",
      color: selectedTarget.color,
    });
    commitAnimation(selectedTarget, animation);
    activateCameraPath(selectedTarget);
    selectTrack(selectedTarget.key, 0);
  }

  function applyCharacterAction() {
    if (!selectedTarget || selectedTarget.kind !== "character") return;
    const actor = project.objects.find((item) => item.id === selectedTarget.objectId);
    if (!actor?.characterRig) return;
    const frameStart = clampTimelineFrame(
      useTimelineRuntimeStore.getState().playheadFrame,
      timeline.frameStart,
      timeline.frameEnd,
    );
    const frameEnd = clampTimelineFrame(
      frameStart + Math.max(1, Math.round(characterActionDuration) || 1),
      timeline.frameStart,
      timeline.frameEnd,
    );
    ensureTimelineTrack(selectedTarget);
    commitAnimation(
      selectedTarget,
      createFramePoseActionAnimation({
        basePoseValues: resolveCharacterPoseControls(actor.characterRig),
        color: selectedTarget.color,
        existingAnimation: selectedTarget.animation,
        frameEnd,
        frameStart,
        presetId: characterActionPresetId,
        timelineEnd: timeline.frameEnd,
      }),
    );
    selectTimelineTrack(selectedTarget, 0);
  }

  /**
   * Inserts a motion block at the playhead. Blocks on one track may not
   * overlap, so the new block is truncated at the next block's start; landing
   * inside an existing block selects it instead of inserting.
   */
  function addCharacterMotionBlock() {
    if (!selectedTarget || selectedTarget.kind !== "character") return;
    const frameStart = clampTimelineFrame(
      useTimelineRuntimeStore.getState().playheadFrame,
      timeline.frameStart,
      timeline.frameEnd,
    );
    const existingBlock = selectedTarget.animation?.motionBlocks?.find(
      (block) => frameStart >= block.frameStart && frameStart <= block.frameEnd,
    );
    if (existingBlock) {
      selectMotionTimelineBlock(selectedTarget, existingBlock.id);
      setMotionBlockMessage("播放头已有动作区块");
      return;
    }
    const nextBlockStart = selectedTarget.animation?.motionBlocks
      ?.filter((block) => block.frameStart > frameStart)
      .reduce((minimum, block) => Math.min(minimum, block.frameStart), timeline.frameEnd + 1);
    const frameEnd = Math.min(
      timeline.frameEnd,
      frameStart + Math.max(1, Math.round(characterMotionBlockDuration) || 1) - 1,
      (nextBlockStart ?? timeline.frameEnd + 1) - 1,
    );
    if (frameEnd < frameStart) {
      setMotionBlockMessage("当前位置没有可用区间");
      return;
    }
    const block = createDirectorCharacterMotionBlock({
      id: `motion-${crypto.randomUUID()}`,
      clipId: characterMotionClipId,
      frameStart,
      frameEnd,
    });
    const animation = insertDirectorCharacterMotionBlock(selectedTarget.animation, block);
    if (!animation) {
      setMotionBlockMessage("动作区块不能与相邻区块重叠");
      return;
    }

    // Track registration + block insertion must undo as a single step.
    beginUndoBatch();
    try {
      ensureTimelineTrack(selectedTarget);
      commitAnimation(selectedTarget, animation);
    } finally {
      endUndoBatch();
    }
    selectMotionTimelineBlock(selectedTarget, block.id);
  }

  function replaceSelectedCharacterMotionBlock() {
    if (!selectedMotionTrack?.animation || !selectedMotionBlockValue) return;
    const motion = getDirectorCharacterMotion(characterMotionClipId);
    if (!motion) return;
    const animation = updateDirectorCharacterMotionBlock(selectedMotionTrack.animation, selectedMotionBlockValue.id, {
      clipId: motion.id,
      loop: motion.defaultLoop,
    });
    if (!animation) return;
    commitAnimation(selectedMotionTrack, animation);
    setMotionBlockMessage("");
  }

  function patchSelectedCharacterMotionBlock(patch: Partial<Omit<DirectorCharacterMotionBlock, "id">>) {
    if (!selectedMotionTrack?.animation || !selectedMotionBlockValue) return;
    const animation = updateDirectorCharacterMotionBlock(
      selectedMotionTrack.animation,
      selectedMotionBlockValue.id,
      patch,
    );
    if (!animation) return;
    commitAnimation(selectedMotionTrack, animation);
    setMotionBlockMessage("");
  }

  function commitSelectedCharacterMotionNumber(
    field: "speed" | "weight" | "blendInS" | "blendOutS",
    value: string,
    minimum: number,
    maximum: number,
  ) {
    if (!selectedMotionBlockValue) return;
    const parsed = Number(value);
    const next = Number.isFinite(parsed)
      ? Math.min(maximum, Math.max(minimum, parsed))
      : selectedMotionBlockValue[field];
    if (next === selectedMotionBlockValue[field]) return;
    patchSelectedCharacterMotionBlock({ [field]: next });
  }

  function deleteSelectedCharacterMotionBlock() {
    if (!selectedMotionTrack?.animation || !selectedMotionBlockValue) return;
    commitAnimation(
      selectedMotionTrack,
      removeDirectorCharacterMotionBlock(selectedMotionTrack.animation, selectedMotionBlockValue.id),
    );
    setSelectedMotionBlock(null);
    setMotionBlockMessage("");
  }

  /**
   * Clamps a dragged motion-block range between its neighbours and commits it.
   * Returns the actually-applied range (the drag component parks the playhead
   * on it), or null when the edit was rejected.
   */
  function commitCharacterMotionBlockRange(
    target: DirectorFrameTrackTarget,
    blockId: string,
    requested: Pick<DirectorCharacterMotionBlock, "frameStart" | "frameEnd">,
    mode: MotionBlockEditMode,
  ) {
    const animation = target.animation;
    if (!animation?.motionBlocks) return null;
    const blocks = [...animation.motionBlocks].sort(
      (left, right) => left.frameStart - right.frameStart || left.id.localeCompare(right.id),
    );
    const blockIndex = blocks.findIndex((block) => block.id === blockId);
    if (blockIndex < 0) return null;
    const previous = blocks[blockIndex - 1];
    const next = blocks[blockIndex + 1];
    const range = clampDirectorCharacterMotionBlockRange(
      requested,
      {
        frameStart: previous ? previous.frameEnd + 1 : timeline.frameStart,
        frameEnd: next ? next.frameStart - 1 : timeline.frameEnd,
      },
      mode,
    );
    const edited = updateDirectorCharacterMotionBlock(animation, blockId, range);
    if (!edited) {
      setMotionBlockMessage("动作区块不能与相邻区块重叠");
      return null;
    }
    commitAnimation(target, edited);
    setMotionBlockMessage("");
    return range;
  }

  // Compiles the recipe form (orbit/wave/bounce) through the same shared
  // compiler that agent-authored recipes use, so both paths produce identical
  // keyframes for identical parameters.
  function applyAnimationRecipe() {
    if (!selectedTarget) return;
    const recipe: DirectorAnimationRecipeInput =
      recipeType === "orbit"
        ? {
            type: "orbit",
            axis: recipeAxis,
            radius: Math.max(0.01, recipeAmount),
            cycles: Math.max(1, Math.round(recipeCycles)),
            clockwise: recipeClockwise,
            face_center: recipeOption,
          }
        : recipeType === "wave"
          ? {
              type: "wave",
              axis: recipeAxis,
              amplitude: Math.max(0.01, recipeAmount),
              cycles: Math.max(1, Math.round(recipeCycles)),
              phase_degrees: recipePhaseDegrees,
            }
          : {
              type: "bounce",
              height: Math.max(0.01, recipeAmount),
              bounces: Math.max(1, Math.round(recipeCycles)),
              squash: recipeOption,
            };
    ensureTimelineTrack(selectedTarget);
    commitAnimation(
      selectedTarget,
      compileDirectorAnimationRecipe({
        baseTransform: selectedTarget.baseTransform,
        frameStart: timeline.frameStart,
        frameEnd: timeline.frameEnd,
        recipe,
        existingAnimation: selectedTarget.animation,
        cameraTarget: selectedTarget.cameraTarget,
        cameraFov: selectedTarget.cameraFov,
        motion: selectedTarget.kind === "character" && recipeType === "orbit" ? "walk" : "none",
        source: "manual",
        color: selectedTarget.color,
      }),
    );
    activateCameraPath(selectedTarget);
    selectTimelineTrack(selectedTarget, 0);
    setRecipePanelOpen(false);
  }

  // Converts the freehand ground-click points into a trajectory: resample to
  // one waypoint per frame, spread waypoints evenly over the timeline range,
  // then compile like any other trajectory.
  function finishCustomDrawing() {
    const target = getDirectorTrackTargetByKey(project, drawingTrackKey);
    if (!target || drawingPoints.length < 2) return;
    ensureTimelineTrack(target);
    const customPoints = resampleTrajectoryDrawingPoints(drawingPoints, frameSpan + 1);
    const divisor = Math.max(1, customPoints.length - 1);
    const animation = createFrameTrajectoryAnimation({
      baseTransform: target.baseTransform,
      frameStart: timeline.frameStart,
      frameEnd: timeline.frameEnd,
      preset: "custom",
      existingAnimation: target.animation,
      cameraTarget: target.cameraTarget,
      cameraFov: target.cameraFov,
      orientToPath: target.kind !== "camera",
      motion: target.kind === "character" ? "walk" : "none",
      source: "manual",
      color: target.color,
      waypoints: customPoints.map((position, index) => ({
        frame: timeline.frameStart + Math.round((frameSpan * index) / divisor),
        position,
      })),
    });
    commitAnimation(target, animation);
    activateCameraPath(target);
    cancelDrawing();
    selectTrack(target.key, 0);
  }

  // -- Timebase editing. Frame rate, drop-frame flag, and start timecode are
  // interdependent: changing the rate can invalidate drop-frame, and the
  // start timecode separator (":" vs ";") must match the drop-frame flag.

  function commitFpsDraft() {
    const rate = normalizeDirectorFrameRate(fpsDraft, timelineTimebase.rate);
    const fps = frameRateToNumber(rate);
    const dropFrame = timelineTimebase.dropFrame && supportsDirectorDropFrame(rate);
    const candidateStart = dropFrame
      ? timelineTimebase.startTimecode.replace(/:(\d{2})$/, ";$1")
      : timelineTimebase.startTimecode.replace(/;(\d{2})$/, ":$1");
    const startTimecode =
      parseSmpteTimecode(candidateStart, rate, { dropFrame })?.timecode ?? (dropFrame ? "00:00:00;00" : "00:00:00:00");
    updateScene({
      timeline: {
        ...timeline,
        fps,
        timebase: {
          rate,
          dropFrame,
          startTimecode,
        },
      },
    });
    setFpsDraft(serializeDirectorFrameRate(rate));
  }

  function toggleDropFrame() {
    if (!supportsDirectorDropFrame(timelineTimebase.rate)) return;
    const dropFrame = !timelineTimebase.dropFrame;
    updateScene({
      timeline: {
        ...timeline,
        fps: timelineFps,
        timebase: {
          ...timelineTimebase,
          dropFrame,
          startTimecode: dropFrame
            ? timelineTimebase.startTimecode.replace(/:(\d{2})$/, ";$1")
            : timelineTimebase.startTimecode.replace(/;(\d{2})$/, ":$1"),
        },
      },
    });
  }

  function commitStartTimecodeDraft() {
    const parsed = parseSmpteTimecode(startTimecodeDraft, timelineTimebase.rate, {
      dropFrame: timelineTimebase.dropFrame,
    });
    if (!parsed) {
      setStartTimecodeDraft(timelineTimebase.startTimecode);
      return;
    }
    updateScene({
      timeline: {
        ...timeline,
        fps: timelineFps,
        timebase: { ...timelineTimebase, startTimecode: parsed.timecode },
      },
    });
  }

  function commitFrameEndDraft() {
    const parsed = Number(frameEndDraft);
    if (!isDirectorTimelineFrame(parsed) || parsed < timeline.frameStart) {
      setFrameEndDraft(String(timeline.frameEnd));
      return;
    }
    const frameEnd = parsed;
    updateScene({
      timeline: {
        ...timeline,
        frameEnd,
        currentFrame: Math.min(timeline.currentFrame, frameEnd),
      },
    });
    if (useTimelineRuntimeStore.getState().playheadFrame > frameEnd) onFrameChange(frameEnd);
  }

  // -- Pointer drags. All drag gestures attach window-level listeners so the
  // gesture survives leaving the element, and unregister on up/cancel.

  // Scrubbing routes frame changes through a rAF scheduler: pointermove can
  // fire faster than the display refresh, and evaluating the 3D scene more
  // than once per frame is wasted work.
  function beginPlayheadDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    let nextFrame = frameAtClientX(event.clientX, rect, timeline);
    const frameScheduler = createAnimationFrameScheduler(onFrameChange);
    onFrameChange(nextFrame);
    function move(pointerEvent: PointerEvent) {
      nextFrame = frameAtClientX(pointerEvent.clientX, rect, timeline);
      frameScheduler.schedule(nextFrame);
    }
    function up(pointerEvent: PointerEvent) {
      nextFrame = frameAtClientX(pointerEvent.clientX, rect, timeline);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      frameScheduler.schedule(nextFrame);
      frameScheduler.flush();
      onFrameCommit(nextFrame);
    }
    function cancel() {
      frameScheduler.cancel();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  }

  function updateRecordBoundary(boundary: "in" | "out", frame: number) {
    const nextFrame = clampTimelineFrame(frame, timeline.frameStart, recordableFrameEnd);
    onRecordingSettingsChange({
      ...recordingSettings,
      exportRange:
        boundary === "in"
          ? { ...recordRange, in: Math.min(recordRange.out, nextFrame) }
          : { ...recordRange, out: Math.max(recordRange.in, nextFrame) },
    });
  }

  function beginRecordBoundaryDrag(boundary: "in" | "out", event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const move = (pointerEvent: PointerEvent) => {
      updateRecordBoundary(boundary, frameAtClientX(pointerEvent.clientX, rect, timeline));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    move(event.nativeEvent);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }

  function moveRecordBoundaryFromKeyboard(boundary: "in" | "out", event: ReactKeyboardEvent<HTMLButtonElement>) {
    const current = boundary === "in" ? recordRange.in : recordRange.out;
    let next = current;
    if (event.key === "ArrowLeft") next -= 1;
    else if (event.key === "ArrowRight") next += 1;
    else if (event.key === "Home") next = timeline.frameStart;
    else if (event.key === "End") next = recordableFrameEnd;
    else return;
    event.preventDefault();
    updateRecordBoundary(boundary, next);
  }

  function updateManualRecordStart(frame: number) {
    onRecordingSettingsChange({
      ...recordingSettings,
      manualStart: clampTimelineFrame(frame, timeline.frameStart, recordableFrameEnd),
    });
  }

  function beginManualRecordStartDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = event.currentTarget.closest("[data-timeline-canvas]") as HTMLElement | null;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const move = (pointerEvent: PointerEvent) => {
      updateManualRecordStart(frameAtClientX(pointerEvent.clientX, rect, timeline));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    move(event.nativeEvent);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
  }

  function moveManualRecordStartFromKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>) {
    let next = recordingSettings.manualStart;
    if (event.key === "ArrowLeft") next -= 1;
    else if (event.key === "ArrowRight") next += 1;
    else if (event.key === "Home") next = timeline.frameStart;
    else if (event.key === "End") next = recordableFrameEnd;
    else return;
    event.preventDefault();
    updateManualRecordStart(next);
  }

  // Sash drag with two special releases: a plain click (no meaningful drag)
  // toggles collapse, and over-dragging below the minimum height collapses the
  // dock instead of pinning it at MIN_TIMELINE_HEIGHT.
  function beginTimelineResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    let collapseOnRelease = false;
    let dragged = false;
    const heightScheduler = createAnimationFrameScheduler(onHeightChange);

    function detach() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      resizeCleanupRef.current = null;
    }

    function cleanup(flush = true) {
      if (flush) heightScheduler.flush();
      else heightScheduler.cancel();
      detach();
    }

    function move(pointerEvent: PointerEvent) {
      const maximum = getMaximumTimelineHeight(window.innerHeight);
      const rawHeight = startHeight + startY - pointerEvent.clientY;
      if (Math.abs(pointerEvent.clientY - startY) >= PANEL_SASH_CLICK_DRAG_THRESHOLD_PX) dragged = true;
      collapseOnRelease = rawHeight < MIN_TIMELINE_HEIGHT - TIMELINE_COLLAPSE_OVERDRAG_PX;
      heightScheduler.schedule(Math.min(maximum, Math.max(MIN_TIMELINE_HEIGHT, rawHeight)));
    }

    const handlePointerUp = () => {
      if (!dragged || collapseOnRelease) {
        heightScheduler.cancel();
        onHeightChange(startHeight);
        detach();
        onCollapse();
        return;
      }
      cleanup(true);
    };
    const handlePointerCancel = () => cleanup(false);

    resizeCleanupRef.current?.();
    resizeCleanupRef.current = () => cleanup(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerCancel, { once: true });
  }

  function resizeTimelineFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const maximum = getMaximumTimelineHeight(window.innerHeight);
    if (event.key === "ArrowDown" && height <= MIN_TIMELINE_HEIGHT) {
      event.preventDefault();
      onCollapse();
      return;
    }
    let nextHeight = height;
    if (event.key === "Home") nextHeight = MIN_TIMELINE_HEIGHT;
    else if (event.key === "End") nextHeight = maximum;
    else if (event.key === "ArrowUp") nextHeight += 16;
    else if (event.key === "ArrowDown") nextHeight -= 16;
    else return;
    event.preventDefault();
    onHeightChange(Math.min(maximum, Math.max(MIN_TIMELINE_HEIGHT, nextHeight)));
  }

  // -- Exports. All three modes share the IN/OUT record range and the same
  // progress plumbing; the heavy lifting happens in the workspace-provided
  // callbacks, this component only mirrors progress into the toolbar.

  async function exportVideo() {
    setActiveExportMode("realtime");
    setExportProgress(0);
    setExportFrame(null);
    try {
      await onExport(recordingSettings.format, recordRange.in, recordRange.out, (progress, frame) => {
        setExportProgress(progress);
        setExportFrame(frame);
      });
    } catch {
      /* Export outcome stays on the control; the overlay toast is gone. */
    } finally {
      setExportProgress(0);
      setExportFrame(null);
      setActiveExportMode(null);
    }
  }

  async function exportDeterministicFrames() {
    setActiveExportMode("deterministic");
    setExportProgress(0);
    setExportFrame(null);
    try {
      await onDeterministicExport(
        recordRange.in,
        recordRange.out,
        (progress, frame) => {
          setExportProgress(progress);
          setExportFrame(frame);
        },
        { background: deterministicTransparentBackground ? "transparent" : "composited" },
      );
    } catch {
      /* Cancel and failure both return the toolbar to idle. */
    } finally {
      setExportProgress(0);
      setExportFrame(null);
      setActiveExportMode(null);
    }
  }

  async function exportMultimodalFrames() {
    setActiveExportMode("dataset");
    setExportProgress(0);
    setExportFrame(null);
    try {
      await onMultimodalExport(recordRange.in, recordRange.out, datasetSelection, (progress, frame) => {
        setExportProgress(progress);
        setExportFrame(frame);
      });
    } catch {
      /* Cancel and failure both return the toolbar to idle. */
    } finally {
      setExportProgress(0);
      setExportFrame(null);
      setActiveExportMode(null);
    }
  }

  // Stable identities for everything passed into the memoized track tree; see
  // useTimelineEvent for why plain useCallback would not be enough here.
  const handleSelectTimelineTrack = useTimelineEvent(selectTimelineTrack);
  const handleSelectMotionBlock = useTimelineEvent(selectMotionTimelineBlock);
  const handleCommitAnimation = useTimelineEvent(commitAnimation);
  const handleCommitMotionBlockRange = useTimelineEvent(commitCharacterMotionBlockRange);
  const handleRemoveTimelineTrack = useTimelineEvent(removeTimelineTrack);
  const handleRequestTrackAction = useTimelineEvent((target: DirectorFrameTrackTarget) => {
    selectTimelineTrack(target);
    setTrajectoryMenuOpen(true);
  });
  const handleTimelineFrameChange = useTimelineEvent(onFrameChange);
  const handleTimelineFrameCommit = useTimelineEvent(onFrameCommit);
  const handleCommitTimelineKeyframe = useTimelineEvent(
    (target: DirectorFrameTrackTarget, keyframeIndex: number, frame: number) => {
      const animation = target.animation;
      if (!animation) return;
      commitAnimation(
        target,
        updateAnimationKeyframe(animation, keyframeIndex, { frame }, timeline.frameStart, timeline.frameEnd),
      );
      onFrameChange(frame);
      onFrameCommit(frame);
    },
  );

  // One shared grid template drives both the label column and the canvas so
  // rows stay pixel-aligned; rows stretch to fill the viewport when few.
  const rowTemplate = useMemo(() => {
    const trackRowCount =
      (storyboardShots.length ? 1 : 0) + (staticCameraTrack ? 1 : 0) + tracks.length + audioTracks.length;
    const availableTrackHeight = Math.max(0, timelineScrollViewportHeight - TIMELINE_RULER_ROW_HEIGHT_PX);
    const trackRowHeightPx =
      trackRowCount === 0 || availableTrackHeight === 0
        ? TIMELINE_TRACK_ROW_HEIGHT_PX
        : Math.max(TIMELINE_TRACK_ROW_HEIGHT_PX, Math.floor(availableTrackHeight / trackRowCount));

    return [
      `${TIMELINE_RULER_ROW_HEIGHT_PX}px`,
      ...(storyboardShots.length ? [`${trackRowHeightPx}px`] : []),
      ...(staticCameraTrack ? [`${trackRowHeightPx}px`] : []),
      ...Array.from({ length: tracks.length }, () => `${trackRowHeightPx}px`),
      ...Array.from({ length: audioTracks.length }, () => `${trackRowHeightPx}px`),
    ].join(" ");
  }, [audioTracks.length, staticCameraTrack, storyboardShots.length, timelineScrollViewportHeight, tracks.length]);

  return (
    <section
      aria-label="场景动画时间轴"
      className="animation-timeline-panel"
      data-bottom-view={bottomView}
      data-playing={isPlaying ? "true" : "false"}
      data-recording-status={recordingStatus}
      style={{ height: `${height}px` }}
    >
      <div
        aria-label="调整时间轴高度"
        aria-orientation="horizontal"
        aria-valuemax={getMaximumTimelineHeight(window.innerHeight)}
        aria-valuemin={MIN_TIMELINE_HEIGHT}
        aria-valuenow={height}
        className="workspace-timeline-resizer"
        onKeyDown={resizeTimelineFromKeyboard}
        onPointerDown={beginTimelineResize}
        role="separator"
        tabIndex={0}
        title={t("点击或下拉收起下方栏")}
      />
      <header className="animation-timeline-toolbar">
        <div className="animation-timeline-toolbar-primary">
          <div aria-label="下方栏视图" className="animation-timeline-view-tabs" role="tablist">
            <button
              aria-controls="director-bottom-timeline"
              aria-selected={bottomView === "timeline"}
              className={bottomView === "timeline" ? "is-active" : ""}
              id="director-bottom-timeline-tab"
              onClick={() => setBottomView("timeline")}
              role="tab"
              type="button"
            >
              <Rows3 aria-hidden {...TOOLBAR_ICON} />
              轨道 / 帧
            </button>
            <button
              aria-controls="director-bottom-scenes"
              aria-selected={bottomView === "scenes"}
              className={bottomView === "scenes" ? "is-active" : ""}
              id="director-bottom-scenes-tab"
              onClick={() => setBottomView("scenes")}
              role="tab"
              type="button"
            >
              <Images aria-hidden {...TOOLBAR_ICON} />
              场景缩略图
            </button>
            <button
              aria-controls="director-bottom-storyboard"
              aria-selected={bottomView === "storyboard"}
              className={bottomView === "storyboard" ? "is-active" : ""}
              id="director-bottom-storyboard-tab"
              onClick={() => setBottomView("storyboard")}
              role="tab"
              type="button"
            >
              <Clapperboard aria-hidden {...TOOLBAR_ICON} />
              分镜
            </button>
          </div>
          <div aria-label="播放与时间" className="animation-timeline-playback" role="group">
            <button
              aria-label={isPlaying ? "暂停动画" : "播放动画"}
              className={`animation-timeline-preview-control${isPlaying ? " is-playing" : ""}`}
              disabled={exporting}
              onClick={onTogglePlaying}
              type="button"
            >
              {isPlaying ? <Pause aria-hidden {...TOOLBAR_ICON} /> : <Play aria-hidden {...TOOLBAR_ICON} />}
            </button>
            <button aria-label="回到时间轴开头" disabled={exporting} onClick={onReset} type="button">
              <SkipBack aria-hidden {...TOOLBAR_ICON} />
            </button>
            <button
              aria-label="循环播放"
              aria-pressed={timeline.loop}
              className={timeline.loop ? "is-active" : ""}
              disabled={exporting}
              onClick={() => updateScene({ timeline: { ...timeline, loop: !timeline.loop } })}
              type="button"
            >
              <Repeat aria-hidden {...TOOLBAR_ICON} />
            </button>
            <label className="animation-timeline-time-field">
              <span className="sr-only">当前时间</span>
              <TimelineTimecodeField
                exporting={exporting}
                onFrameChange={onFrameChange}
                onFrameCommit={handleTimelineFrameCommit}
                timeline={timeline}
                timelineTimebase={timelineTimebase}
              />
              <span>/</span>
              <input
                aria-label="时间轴结束帧"
                disabled={exporting}
                max={MAX_DIRECTOR_TIMELINE_FRAME}
                min={timeline.frameStart}
                onBlur={commitFrameEndDraft}
                onChange={(event) => setFrameEndDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitFrameEndDraft();
                }}
                type="number"
                value={frameEndDraft}
              />
              <span>F</span>
            </label>
            <label className="animation-timeline-compact-field">
              <span>FPS</span>
              <input
                aria-label="时间轴 FPS"
                disabled={exporting}
                onBlur={commitFpsDraft}
                onChange={(event) => setFpsDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitFpsDraft();
                }}
                title={formatDirectorFrameRate(timelineTimebase.rate, timelineTimebase.dropFrame)}
                type="text"
                value={fpsDraft}
              />
              <button
                aria-label="Drop-frame timecode"
                aria-pressed={timelineTimebase.dropFrame}
                disabled={exporting || !supportsDirectorDropFrame(timelineTimebase.rate)}
                onClick={toggleDropFrame}
                title="SMPTE drop-frame"
                type="button"
              >
                DF
              </button>
            </label>
            <label className="animation-timeline-compact-field animation-timeline-start-timecode-field">
              <span>START TC</span>
              <input
                aria-label="起始 SMPTE 时间码"
                disabled={exporting}
                inputMode="text"
                onBlur={commitStartTimecodeDraft}
                onChange={(event) => setStartTimecodeDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitStartTimecodeDraft();
                }}
                value={startTimecodeDraft}
              />
            </label>
          </div>
        </div>

        <div className="animation-timeline-toolbar-actions">
          {drawingTrackKey ? (
            <div className="animation-timeline-drawing-status" role="status">
              <Route aria-hidden {...TOOLBAR_ICON} />
              <span>自由绘制：单击地面添加节点，双击或 Enter 完成</span>
              <strong>{drawingPoints.length} 个节点</strong>
              <button disabled={drawingPoints.length < 2} onClick={finishCustomDrawing} type="button">
                完成轨迹
              </button>
              <button onClick={cancelDrawing} type="button">
                取消
              </button>
            </div>
          ) : (
            <div aria-label="场景与轨迹" className="animation-timeline-create-actions" role="group">
              <button
                aria-label="添加分镜到播放头"
                className="animation-timeline-add-storyboard"
                onClick={addStoryboardShot}
                type="button"
              >
                <Film aria-hidden {...TOOLBAR_ICON} />
                添加分镜
              </button>
              <button
                disabled={
                  !selectedTarget ||
                  tracks.some((track) => track.key === selectedTarget.key) ||
                  staticCameraTrack?.key === selectedTarget.key
                }
                onClick={() => selectedTarget && addTimelineTrack(selectedTarget)}
                title={
                  selectedTarget
                    ? tracks.some((track) => track.key === selectedTarget.key) ||
                      staticCameraTrack?.key === selectedTarget.key
                      ? `${selectedTarget.label} 已有轨道`
                      : `为 ${selectedTarget.label} 添加空轨道`
                    : "请先选择角色、道具或机位"
                }
                type="button"
              >
                <ListPlus aria-hidden {...TOOLBAR_ICON} />
                添加轨道
              </button>
              <div className="animation-timeline-trajectory-menu-wrap">
                <button
                  aria-expanded={trajectoryMenuOpen}
                  disabled={!selectedTarget}
                  onClick={() => setTrajectoryMenuOpen((open) => !open)}
                  type="button"
                >
                  <Route aria-hidden {...TOOLBAR_ICON} />
                  添加动作
                  <ChevronDown aria-hidden size={12} strokeWidth={1.75} />
                </button>
                {trajectoryMenuOpen ? (
                  <div aria-label="轨迹预设" className="animation-timeline-trajectory-menu" role="menu">
                    {DIRECTOR_TRAJECTORY_PRESETS.map((preset) => {
                      const Icon = TRAJECTORY_PRESET_ICONS[preset.id];
                      return (
                        <button key={preset.id} onClick={() => applyPreset(preset.id)} role="menuitem" type="button">
                          <Icon aria-hidden {...TOOLBAR_ICON} />
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <div className="animation-timeline-recipe-wrap">
                <button
                  aria-expanded={recipePanelOpen}
                  aria-label="动画配方"
                  disabled={!selectedTarget}
                  onClick={() => setRecipePanelOpen((open) => !open)}
                  type="button"
                >
                  <WandSparkles aria-hidden {...TOOLBAR_ICON} />
                  动画配方
                  <ChevronDown aria-hidden size={12} strokeWidth={1.75} />
                </button>
                {recipePanelOpen ? (
                  <div aria-label="动画配方参数" className="animation-timeline-recipe-panel" role="dialog">
                    <header>
                      <strong>动画配方</strong>
                      <small>
                        覆盖 {timeline.frameStart}–{timeline.frameEnd} 帧，可继续编辑关键帧
                      </small>
                    </header>
                    <div className="animation-timeline-recipe-grid">
                      <label>
                        <span>类型</span>
                        <select
                          aria-label="动画配方类型"
                          onChange={(event) => {
                            const type = event.currentTarget.value as DirectorAnimationRecipeInput["type"];
                            setRecipeType(type);
                            setRecipeAmount(type === "wave" ? 1 : 1.5);
                            setRecipeCycles(type === "orbit" ? 1 : type === "bounce" ? 3 : 2);
                          }}
                          value={recipeType}
                        >
                          <option value="orbit">圆周运动</option>
                          <option value="wave">正弦波</option>
                          <option value="bounce">弹跳</option>
                        </select>
                      </label>
                      {recipeType !== "bounce" ? (
                        <label>
                          <span>轴</span>
                          <select
                            aria-label="动画配方轴"
                            onChange={(event) => setRecipeAxis(event.currentTarget.value as "x" | "y" | "z")}
                            value={recipeAxis}
                          >
                            <option value="x">X</option>
                            <option value="y">Y</option>
                            <option value="z">Z</option>
                          </select>
                        </label>
                      ) : null}
                      <label>
                        <span>{recipeType === "orbit" ? "半径" : recipeType === "wave" ? "振幅" : "高度"}</span>
                        <input
                          aria-label="动画配方幅度"
                          min="0.01"
                          onChange={(event) =>
                            setRecipeAmount(Math.max(0.01, Number(event.currentTarget.value) || 0.01))
                          }
                          step="0.1"
                          type="number"
                          value={recipeAmount}
                        />
                      </label>
                      <label>
                        <span>{recipeType === "bounce" ? "弹跳次数" : "循环数"}</span>
                        <input
                          aria-label="动画配方循环数"
                          max={recipeType === "bounce" ? 32 : 64}
                          min="1"
                          onChange={(event) =>
                            setRecipeCycles(Math.max(1, Math.round(Number(event.currentTarget.value) || 1)))
                          }
                          type="number"
                          value={recipeCycles}
                        />
                      </label>
                      {recipeType === "wave" ? (
                        <label>
                          <span>相位 °</span>
                          <input
                            aria-label="动画配方相位"
                            onChange={(event) => setRecipePhaseDegrees(Number(event.currentTarget.value) || 0)}
                            step="1"
                            type="number"
                            value={recipePhaseDegrees}
                          />
                        </label>
                      ) : null}
                    </div>
                    {recipeType === "orbit" ? (
                      <div className="animation-timeline-recipe-options">
                        <label>
                          <input
                            aria-label="环绕时朝向中心"
                            checked={recipeOption}
                            onChange={(event) => setRecipeOption(event.currentTarget.checked)}
                            type="checkbox"
                          />
                          朝向中心
                        </label>
                        <label>
                          <input
                            aria-label="顺时针环绕"
                            checked={recipeClockwise}
                            onChange={(event) => setRecipeClockwise(event.currentTarget.checked)}
                            type="checkbox"
                          />
                          顺时针
                        </label>
                      </div>
                    ) : recipeType === "bounce" ? (
                      <label className="animation-timeline-recipe-toggle">
                        <input
                          aria-label="弹跳挤压拉伸"
                          checked={recipeOption}
                          onChange={(event) => setRecipeOption(event.currentTarget.checked)}
                          type="checkbox"
                        />
                        挤压与拉伸
                      </label>
                    ) : null}
                    <button
                      aria-label="应用动画配方"
                      className="animation-timeline-recipe-apply"
                      onClick={applyAnimationRecipe}
                      type="button"
                    >
                      应用到时间线
                    </button>
                  </div>
                ) : null}
              </div>
              {selectedTarget?.kind === "character" ? (
                <>
                  <div aria-label="角色预设动作" className="animation-timeline-character-action" role="group">
                    <select
                      aria-label="角色动作预设"
                      onChange={(event) => setCharacterActionPresetId(event.currentTarget.value as PosePresetId)}
                      value={characterActionPresetId}
                    >
                      {MANNEQUIN_POSE_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                    <label>
                      <span>时长</span>
                      <input
                        aria-label="角色动作时长（帧）"
                        min="1"
                        onChange={(event) =>
                          setCharacterActionDuration(Math.max(1, Number(event.currentTarget.value) || 1))
                        }
                        type="number"
                        value={characterActionDuration}
                      />
                    </label>
                    <button aria-label="添加角色预设动作" onClick={applyCharacterAction} type="button">
                      <UserRound aria-hidden {...TOOLBAR_ICON} />
                      姿势关键帧
                    </button>
                  </div>
                  <div aria-label="角色动作区块" className="animation-timeline-character-motion" role="group">
                    <select
                      aria-label="角色动作区块素材"
                      onChange={(event) => setCharacterMotionClipId(event.currentTarget.value)}
                      value={characterMotionClipId}
                    >
                      {DIRECTOR_CHARACTER_MOTION_CATALOG.map((motion) => (
                        <option key={motion.id} value={motion.id}>
                          {locale === "en-US" ? motion.name : motion.nameZh}
                        </option>
                      ))}
                    </select>
                    <label>
                      <span>区块</span>
                      <input
                        aria-label="新动作区块时长（帧）"
                        min="1"
                        onChange={(event) =>
                          setCharacterMotionBlockDuration(Math.max(1, Number(event.currentTarget.value) || 1))
                        }
                        type="number"
                        value={characterMotionBlockDuration}
                      />
                    </label>
                    <button aria-label="添加动作区块" onClick={addCharacterMotionBlock} type="button">
                      <Plus aria-hidden {...TOOLBAR_ICON} />
                      添加区块
                    </button>
                    {selectedMotionBlockValue ? (
                      <>
                        <button
                          aria-label="替换所选动作区块"
                          onClick={replaceSelectedCharacterMotionBlock}
                          type="button"
                        >
                          <Replace aria-hidden {...TOOLBAR_ICON} />
                          替换
                        </button>
                        <div className="animation-timeline-motion-settings-wrap">
                          <button
                            aria-expanded={motionSettingsOpen}
                            aria-label="编辑所选动作区块参数"
                            onClick={() => setMotionSettingsOpen((open) => !open)}
                            type="button"
                          >
                            <SlidersHorizontal aria-hidden {...TOOLBAR_ICON} />
                            参数
                          </button>
                          {motionSettingsOpen ? (
                            <div
                              aria-label="动作区块参数"
                              className="animation-timeline-motion-settings-panel"
                              role="dialog"
                            >
                              <header>
                                <strong data-i18n-user-content>
                                  {locale === "en-US"
                                    ? getDirectorCharacterMotion(selectedMotionBlockValue.clipId)?.name
                                    : getDirectorCharacterMotion(selectedMotionBlockValue.clipId)?.nameZh}
                                </strong>
                                <small>
                                  F{selectedMotionBlockValue.frameStart}–{selectedMotionBlockValue.frameEnd} ·{" "}
                                  {locale === "en-US" ? "In-place root motion" : "原地根运动"}
                                </small>
                              </header>
                              <label className="animation-timeline-motion-enabled">
                                <input
                                  aria-label="启用动作区块"
                                  checked={selectedMotionBlockValue.enabled}
                                  onChange={(event) =>
                                    patchSelectedCharacterMotionBlock({ enabled: event.currentTarget.checked })
                                  }
                                  type="checkbox"
                                />
                                启用
                              </label>
                              <div className="animation-timeline-motion-settings-grid">
                                <label>
                                  <span>循环</span>
                                  <select
                                    aria-label="动作区块循环方式"
                                    onChange={(event) =>
                                      patchSelectedCharacterMotionBlock({
                                        loop: event.currentTarget.value as DirectorCharacterMotionBlock["loop"],
                                      })
                                    }
                                    value={selectedMotionBlockValue.loop}
                                  >
                                    <option value="once">单次</option>
                                    <option value="repeat">循环</option>
                                    <option value="ping-pong">{locale === "en-US" ? "Ping-pong" : "往返"}</option>
                                  </select>
                                </label>
                                {CHARACTER_MOTION_BLOCK_NUMBER_FIELDS.map(
                                  ({ field, label, ariaLabel, minimum, maximum, step }) => (
                                    <label key={field}>
                                      <span>{label}</span>
                                      <input
                                        aria-label={ariaLabel}
                                        defaultValue={selectedMotionBlockValue[field]}
                                        key={`${selectedMotionBlockValue.id}:${field}:${selectedMotionBlockValue[field]}`}
                                        max={maximum}
                                        min={minimum}
                                        onBlur={(event) =>
                                          commitSelectedCharacterMotionNumber(
                                            field,
                                            event.currentTarget.value,
                                            minimum,
                                            maximum,
                                          )
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter") event.currentTarget.blur();
                                        }}
                                        step={step}
                                        type="number"
                                      />
                                    </label>
                                  ),
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <button
                          aria-label="删除所选动作区块"
                          className="is-danger"
                          onClick={deleteSelectedCharacterMotionBlock}
                          type="button"
                        >
                          <Trash2 aria-hidden size={13} />
                        </button>
                      </>
                    ) : null}
                    {motionBlockMessage ? (
                      <span className="animation-timeline-motion-message" role="status">
                        {motionBlockMessage}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </div>

        <div className="animation-timeline-toolbar-utility">
          <div aria-label="舞台音频" className="animation-timeline-audio-controls" role="group">
            {audioMediaAssets.length > 0 ? (
              <select
                aria-label="选择音频素材"
                onChange={(event) => setAudioMediaSelection(event.currentTarget.value)}
                value={audioMediaSelection || audioMediaAssets[0]?.id || ""}
              >
                {audioMediaAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              aria-label="在播放头处添加音频片段"
              className="animation-timeline-audio-add"
              disabled={audioMediaAssets.length === 0}
              onClick={addAudioClipFromMedia}
              title={audioMediaAssets.length === 0 ? "没有可用的音频素材" : "在播放头处添加音频片段"}
              type="button"
            >
              <Music aria-hidden {...TOOLBAR_ICON} />
              添加音频
            </button>
            {selectedAudio ? (
              <>
                <button
                  aria-label={selectedAudio.clip.muted ? "取消静音音频片段" : "静音音频片段"}
                  aria-pressed={selectedAudio.clip.muted}
                  className="animation-timeline-audio-icon"
                  onClick={() => updateTimelineAudioClip(selectedAudio.clip.id, { muted: !selectedAudio.clip.muted })}
                  title={selectedAudio.clip.muted ? "取消静音音频片段" : "静音音频片段"}
                  type="button"
                >
                  {selectedAudio.clip.muted ? (
                    <VolumeX aria-hidden {...TOOLBAR_ICON} />
                  ) : (
                    <Volume2 aria-hidden {...TOOLBAR_ICON} />
                  )}
                </button>
                <div className="animation-timeline-motion-settings-wrap">
                  <button
                    aria-expanded={audioSettingsOpen}
                    aria-label="编辑所选音频片段参数"
                    className="animation-timeline-audio-icon"
                    onClick={() => setAudioSettingsOpen((open) => !open)}
                    title="音频参数"
                    type="button"
                  >
                    <SlidersHorizontal aria-hidden {...TOOLBAR_ICON} />
                  </button>
                  {audioSettingsOpen ? (
                    <div aria-label="音频片段参数" className="animation-timeline-motion-settings-panel" role="dialog">
                      <header>
                        <strong data-i18n-user-content>{t(selectedAudio.clip.name)}</strong>
                        <small>
                          F{selectedAudio.clip.startFrame} ·{" "}
                          {formatAudioClipDurationSec(selectedAudio.clip.durationFrames, timelineFps)}s
                        </small>
                      </header>
                      <label className="animation-timeline-audio-volume">
                        <span>音量 {Math.round(selectedAudio.clip.volume * 100)}%</span>
                        <input
                          aria-label="音频片段音量"
                          max={1}
                          min={0}
                          onChange={(event) =>
                            updateTimelineAudioClip(selectedAudio.clip.id, {
                              volume: Number(event.currentTarget.value),
                            })
                          }
                          onPointerDown={beginUndoBatch}
                          onPointerUp={endUndoBatch}
                          step={0.01}
                          type="range"
                          value={selectedAudio.clip.volume}
                        />
                      </label>
                      <div className="animation-timeline-motion-settings-grid">
                        <label>
                          <span>淡入 s</span>
                          <input
                            aria-label="音频片段淡入（秒）"
                            max={60}
                            min={0}
                            onChange={(event) =>
                              updateTimelineAudioClip(selectedAudio.clip.id, {
                                fadeInSec: Math.max(0, Number(event.currentTarget.value) || 0),
                              })
                            }
                            step={0.1}
                            type="number"
                            value={selectedAudio.clip.fadeInSec}
                          />
                        </label>
                        <label>
                          <span>淡出 s</span>
                          <input
                            aria-label="音频片段淡出（秒）"
                            max={60}
                            min={0}
                            onChange={(event) =>
                              updateTimelineAudioClip(selectedAudio.clip.id, {
                                fadeOutSec: Math.max(0, Number(event.currentTarget.value) || 0),
                              })
                            }
                            step={0.1}
                            type="number"
                            value={selectedAudio.clip.fadeOutSec}
                          />
                        </label>
                        <label>
                          <span>起始帧</span>
                          <input
                            aria-label="音频片段起始帧"
                            min={0}
                            onChange={(event) =>
                              moveTimelineAudioClip(
                                selectedAudio.clip.id,
                                Math.max(0, Math.round(Number(event.currentTarget.value) || 0)),
                              )
                            }
                            step={1}
                            type="number"
                            value={selectedAudio.clip.startFrame}
                          />
                        </label>
                        <label>
                          <span>时长（帧）</span>
                          <input
                            aria-label="音频片段时长（帧）"
                            min={1}
                            onChange={(event) =>
                              updateTimelineAudioClip(selectedAudio.clip.id, {
                                durationFrames: Math.max(1, Math.round(Number(event.currentTarget.value) || 1)),
                              })
                            }
                            step={1}
                            type="number"
                            value={selectedAudio.clip.durationFrames}
                          />
                        </label>
                      </div>
                    </div>
                  ) : null}
                </div>
                <button
                  aria-label="删除所选音频片段"
                  className="animation-timeline-audio-icon is-danger"
                  onClick={() => {
                    removeTimelineAudioClip(selectedAudio.clip.id);
                    setSelectedAudioClipId(null);
                  }}
                  title="删除所选音频片段"
                  type="button"
                >
                  <Trash2 aria-hidden size={13} />
                </button>
              </>
            ) : null}
          </div>
          <div aria-label="排练与记录" className="animation-timeline-flick-workflow" role="group">
            <button
              aria-label={isPlaying ? "暂停排练" : "排练"}
              aria-pressed={isPlaying}
              className="animation-timeline-rehearse"
              disabled={exporting}
              type="button"
              onClick={onTogglePlaying}
            >
              {isPlaying ? <Pause aria-hidden {...TOOLBAR_ICON} /> : <MonitorPlay aria-hidden {...TOOLBAR_ICON} />}
              <span>{isPlaying ? "暂停" : "排练"}</span>
            </button>
            <button
              aria-label={recordingStatus === "paused" ? "继续记录" : "记录"}
              className="animation-timeline-record-control is-manual is-primary animation-timeline-flick-record"
              disabled={exporting || (recordingStatus !== "idle" && recordingStatus !== "paused")}
              type="button"
              onClick={() => onRecordingControl(recordingStatus === "paused" ? "resume" : "start")}
            >
              <Circle aria-hidden className="animation-timeline-record-dot" {...TOOLBAR_ICON} />
              <span>{recordingStatus === "paused" ? "继续记录" : "记录"}</span>
            </button>
          </div>
          <div aria-label="记录与导出" className="animation-timeline-recording-actions" role="group">
            <select
              aria-label="视频格式"
              onChange={(event) =>
                onRecordingSettingsChange({
                  ...recordingSettings,
                  format: event.currentTarget.value as DirectorVideoFormat,
                })
              }
              value={recordingSettings.format}
            >
              <option value="auto">自动格式</option>
              <option value="webm">WebM</option>
              <option value="mp4">MP4</option>
            </select>
            {recordingStatus === "paused" ? (
              <button
                aria-label="继续记录渲染"
                className="animation-timeline-record-control is-manual is-primary"
                onClick={() => onRecordingControl("resume")}
                type="button"
              >
                <Circle aria-hidden className="animation-timeline-record-dot" {...TOOLBAR_ICON} />
                <span>继续记录</span>
              </button>
            ) : (
              <>
                <button
                  aria-label="从蓝色手动起点开始记录"
                  className="animation-timeline-record-control is-manual is-primary"
                  disabled={recordingStatus !== "idle" || exporting}
                  onClick={() => onRecordingControl("start")}
                  title="从蓝色手动起点开始记录"
                  type="button"
                >
                  <Circle aria-hidden className="animation-timeline-record-dot" {...TOOLBAR_ICON} />
                  <span>开始记录</span>
                </button>
              </>
            )}
            <button
              aria-label="暂停记录渲染"
              className="animation-timeline-record-control is-manual"
              disabled={recordingStatus !== "recording"}
              onClick={() => onRecordingControl("pause")}
              type="button"
            >
              <Pause aria-hidden {...TOOLBAR_ICON} />
              <span>暂停</span>
            </button>
            <button
              aria-label="停止记录渲染"
              className="animation-timeline-record-control is-manual"
              disabled={recordingStatus !== "recording" && recordingStatus !== "paused"}
              onClick={() => onRecordingControl("stop")}
              type="button"
            >
              <Square aria-hidden {...TOOLBAR_ICON} />
              <span>停止</span>
            </button>
            <button
              aria-busy={exporting && activeExportMode === "realtime"}
              aria-label="自动导出 IN/OUT 视频"
              className="animation-timeline-export is-automatic"
              disabled={exporting || recordingStatus !== "idle"}
              onClick={exportVideo}
              type="button"
            >
              {exporting && activeExportMode === "realtime" ? (
                <LoaderCircle aria-hidden className="is-spinning" {...TOOLBAR_ICON} />
              ) : (
                <Video aria-hidden {...TOOLBAR_ICON} />
              )}
              <span className="animation-timeline-export-label">
                {exporting && activeExportMode === "realtime"
                  ? `自动导出 F${exportFrame ?? "-"} · ${Math.round(exportProgress * 100)}%`
                  : "自动导出 IN/OUT"}
              </span>
            </button>
            <button
              aria-busy={exporting && activeExportMode === "deterministic"}
              aria-label="导出确定性 IN/OUT 帧包"
              className="animation-timeline-export is-deterministic"
              disabled={exporting || recordingStatus !== "idle"}
              onClick={exportDeterministicFrames}
              title="逐帧离屏渲染 PNG，并附带帧时间戳、逐帧哈希和包指纹"
              type="button"
            >
              {exporting && activeExportMode === "deterministic" ? (
                <LoaderCircle aria-hidden className="is-spinning" {...TOOLBAR_ICON} />
              ) : (
                <Layers aria-hidden {...TOOLBAR_ICON} />
              )}
              <span className="animation-timeline-export-label">
                {exporting && activeExportMode === "deterministic"
                  ? `确定性渲染 F${exportFrame ?? "-"} · ${Math.round(exportProgress * 100)}%`
                  : "确定性帧包"}
              </span>
            </button>
            <label
              className="animation-timeline-export-option"
              title="以 RGBA 透明背景逐帧渲染：清空场景背景与环境陈设，仅保留创作内容（绿幕/合成用）。输出仍为 PNG 帧包 ZIP。"
            >
              <input
                aria-label="确定性帧包使用透明背景"
                checked={deterministicTransparentBackground}
                disabled={exporting || recordingStatus !== "idle"}
                onChange={(event) => setDeterministicTransparentBackground(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>透明背景</span>
            </label>
            <DirectorDatasetOptions disabled={exporting} onChange={setDatasetSelection} selection={datasetSelection} />
            <button
              aria-busy={exporting && activeExportMode === "dataset"}
              aria-label="导出多模态 IN/OUT 数据包"
              className="animation-timeline-export is-dataset"
              disabled={exporting || recordingStatus !== "idle"}
              onClick={exportMultimodalFrames}
              title="按开关逐帧导出 RGB、技术通道、相机参数与对象状态"
              type="button"
            >
              {exporting && activeExportMode === "dataset" ? (
                <LoaderCircle aria-hidden className="is-spinning" {...TOOLBAR_ICON} />
              ) : (
                <Database aria-hidden {...TOOLBAR_ICON} />
              )}
              <span className="animation-timeline-export-label">
                {exporting && activeExportMode === "dataset"
                  ? `数据采集 F${exportFrame ?? "-"} · ${Math.round(exportProgress * 100)}%`
                  : "多模态数据包"}
              </span>
            </button>
            {exporting && (activeExportMode === "deterministic" || activeExportMode === "dataset") ? (
              <button
                aria-label={activeExportMode === "dataset" ? "取消多模态数据导出" : "取消确定性帧导出"}
                className="animation-timeline-export-cancel"
                onClick={onCancelDeterministicExport}
                type="button"
              >
                <CircleX aria-hidden {...TOOLBAR_ICON} />
                <span>取消</span>
              </button>
            ) : null}
          </div>
          <label className="animation-timeline-zoom">
            <span>缩放</span>
            <input
              aria-label="时间轴缩放"
              max={12}
              min={1}
              onChange={(event) => setPixelsPerFrame(Number(event.currentTarget.value))}
              type="range"
              value={pixelsPerFrame}
            />
          </label>
        </div>
      </header>

      {bottomView === "timeline" ? (
        <div
          aria-labelledby="director-bottom-timeline-tab"
          className="animation-timeline-body"
          id="director-bottom-timeline"
          role="tabpanel"
        >
          <div className="animation-timeline-scroll" ref={timelineScrollRef}>
            <div className="animation-timeline-sync">
              <div className="animation-timeline-labels" style={{ gridTemplateRows: rowTemplate }}>
                <div className="animation-timeline-label is-ruler">
                  <strong>时间轴</strong>
                  <small>刻度 · 录制标记</small>
                </div>
                {storyboardShots.length ? (
                  <div className="animation-timeline-label is-storyboard">
                    <span className="animation-timeline-track-color is-storyboard" />
                    <Clapperboard aria-hidden size={13} />
                    <span>
                      <strong>分镜剪辑轨</strong>
                      <small>
                        {storyboardShots.length ? `${storyboardShots.length} 镜 · 拖动剪辑` : "添加分镜后开始剪辑"}
                      </small>
                    </span>
                    <button
                      aria-label="切换到分镜轴"
                      aria-pressed={bottomView === "timeline"}
                      className="animation-timeline-storyboard-axis"
                      onClick={() => setBottomView("timeline")}
                      title="分镜轴：拖动、裁切和调整片段"
                      type="button"
                    >
                      轴
                    </button>
                    <button
                      aria-label="编辑分镜轨"
                      className="animation-timeline-edit-storyboard"
                      onClick={(event) => {
                        event.stopPropagation();
                        setBottomView("storyboard");
                      }}
                      type="button"
                    >
                      编辑
                    </button>
                  </div>
                ) : null}
                <MemoizedTimelineTrackLabels
                  onCommitAnimation={handleCommitAnimation}
                  onRemoveTrack={handleRemoveTimelineTrack}
                  onRequestAction={handleRequestTrackAction}
                  onSelectCamera={setActiveCamera}
                  onSelectTrack={handleSelectTimelineTrack}
                  selectedTrackKey={selectedTrackKey}
                  staticCameraTrack={staticCameraTrack}
                  tracks={tracks}
                />
                {audioTracks.map((audioTrack) => (
                  <div
                    aria-label={`音频轨 ${audioTrack.name}`}
                    className={`animation-timeline-label is-audio${audioTrack.muted ? " is-muted" : ""}`}
                    key={audioTrack.id}
                  >
                    <span className="animation-timeline-track-color is-audio" />
                    <Music aria-hidden size={13} />
                    <span>
                      <strong data-i18n-user-content>{t(audioTrack.name)}</strong>
                      <small>{audioTrack.clips.length ? `${audioTrack.clips.length} 段音频` : "空音频轨"}</small>
                    </span>
                    <button
                      aria-label={audioTrack.muted ? "取消静音音频轨" : "静音音频轨"}
                      aria-pressed={audioTrack.muted}
                      className="animation-timeline-audio-mute"
                      onClick={() => setTimelineAudioTrackMuted(audioTrack.id, !audioTrack.muted)}
                      title={audioTrack.muted ? "取消静音音频轨" : "静音音频轨"}
                      type="button"
                    >
                      {audioTrack.muted ? <VolumeX aria-hidden size={13} /> : <Volume2 aria-hidden size={13} />}
                    </button>
                  </div>
                ))}
              </div>
              <div
                className="animation-timeline-canvas"
                data-timeline-canvas
                style={
                  {
                    "--timeline-minor-grid": `${Math.max(8, tickStep * pixelsPerFrame)}px`,
                    gridTemplateRows: rowTemplate,
                    width: `${canvasWidth}px`,
                  } as CSSProperties
                }
              >
                <div className="animation-timeline-ruler">
                  {ticks.map((frame) => {
                    const label = timelineRulerLabels.get(frame);
                    const showLabel = label !== undefined;
                    const isTerminal = frame === timeline.frameEnd && frame !== timeline.frameStart;
                    return (
                      <span
                        aria-hidden={showLabel ? undefined : true}
                        className={`${showLabel ? "is-labeled" : "is-unlabeled"}${isTerminal ? " is-terminal" : ""}`}
                        key={frame}
                        style={{ left: `${((frame - timeline.frameStart) / frameSpan) * 100}%` }}
                      >
                        {label ?? null}
                      </span>
                    );
                  })}
                </div>
                <div
                  aria-hidden="true"
                  className="animation-timeline-record-range"
                  style={{
                    left: `${((recordRange.in - timeline.frameStart) / frameSpan) * 100}%`,
                    width: `${((recordRange.out - recordRange.in) / frameSpan) * 100}%`,
                  }}
                />
                {(["in", "out"] as const).map((boundary, markerIndex) => {
                  const frame = recordRange[boundary];
                  const boundaryLabel = boundary === "in" ? "入点" : "出点";
                  return (
                    <button
                      aria-label={`录制${boundaryLabel}`}
                      aria-valuemax={recordableFrameEnd}
                      aria-valuemin={timeline.frameStart}
                      aria-valuenow={frame}
                      aria-valuetext={`第 ${frame} 帧，时间码 ${formatDirectorTimelineTimecode(frame, timelineTimebase)}`}
                      className={`animation-timeline-record-handle is-${boundary} is-label-lane-${recordMarkerLabelLanes[markerIndex]}${boundary === "in" && recordInNearStart ? " is-near-start" : ""}${boundary === "out" && recordOutNearEnd ? " is-near-end" : ""}`}
                      disabled={exporting}
                      key={boundary}
                      onKeyDown={(event) => moveRecordBoundaryFromKeyboard(boundary, event)}
                      onPointerDown={(event) => beginRecordBoundaryDrag(boundary, event)}
                      role="slider"
                      style={{ left: `${((frame - timeline.frameStart) / frameSpan) * 100}%` }}
                      title={`${boundary === "in" ? "IN" : "OUT"} · F${frame} · ${formatDirectorTimelineTimecode(frame, timelineTimebase)}`}
                      type="button"
                    >
                      <span>
                        {boundary === "in" ? "IN" : "OUT"} · F{frame}
                      </span>
                    </button>
                  );
                })}
                <button
                  aria-label="手动记录起点"
                  aria-valuemax={recordableFrameEnd}
                  aria-valuemin={timeline.frameStart}
                  aria-valuenow={recordingSettings.manualStart}
                  aria-valuetext={`第 ${recordingSettings.manualStart} 帧，时间码 ${formatDirectorTimelineTimecode(recordingSettings.manualStart, timelineTimebase)}`}
                  className={`animation-timeline-record-handle is-manual is-label-lane-${recordMarkerLabelLanes[2]}${manualNearStart ? " is-near-start" : ""}${manualNearEnd ? " is-near-end" : ""}`}
                  disabled={exporting}
                  onKeyDown={moveManualRecordStartFromKeyboard}
                  onPointerDown={beginManualRecordStartDrag}
                  role="slider"
                  style={{ left: `${((recordingSettings.manualStart - timeline.frameStart) / frameSpan) * 100}%` }}
                  title={`手动 · F${recordingSettings.manualStart} · ${formatDirectorTimelineTimecode(recordingSettings.manualStart, timelineTimebase)}`}
                  type="button"
                >
                  <span>手动 · F{recordingSettings.manualStart}</span>
                </button>
                {storyboardShots.length ? (
                  <div aria-label="分镜剪辑轨" className="animation-timeline-storyboard-row" role="list">
                    {storyboardShots.map((shot, index) => (
                      <StoryboardTimelineClip
                        cameraLabel={getStoryboardCameraLabel(shot)}
                        index={index}
                        key={shot.id}
                        onFrameChange={onFrameChange}
                        onFrameCommit={onFrameCommit}
                        onRangeCommit={(range, mode) => commitStoryboardClipRange(shot.id, range, mode)}
                        onSelect={() => {
                          setSelectedStoryboardShotId(shot.id);
                          onFrameChange(shot.frameStart);
                          onFrameCommit(shot.frameStart);
                        }}
                        selected={shot.id === selectedStoryboardShotId}
                        shot={shot}
                        timeline={timeline}
                      />
                    ))}
                  </div>
                ) : null}
                <MemoizedTimelineTrackRows
                  canvasWidth={canvasWidth}
                  frameSpan={frameSpan}
                  onCommitKeyframe={handleCommitTimelineKeyframe}
                  onCommitMotionBlockRange={handleCommitMotionBlockRange}
                  onFrameChange={handleTimelineFrameChange}
                  onFrameCommit={onFrameCommit}
                  onRequestAction={handleRequestTrackAction}
                  onSelectMotionBlock={handleSelectMotionBlock}
                  onSelectTrack={handleSelectTimelineTrack}
                  selectedKeyframeIndex={selectedKeyframeIndex}
                  selectedMotionBlock={selectedMotionBlock}
                  selectedTrackKey={selectedTrackKey}
                  staticCameraTrack={staticCameraTrack}
                  storyboardShotCount={storyboardShots.length}
                  timeline={timeline}
                  tracks={tracks}
                />
                {audioTracks.map((audioTrack) => (
                  <div
                    aria-label={`音频轨 ${audioTrack.name} 片段`}
                    className={`animation-timeline-track-row is-audio${audioTrack.muted ? " is-muted" : ""}`}
                    key={audioTrack.id}
                    role="list"
                  >
                    {audioTrack.clips.map((clip) => (
                      <StageAudioTimelineClip
                        clip={clip}
                        key={clip.id}
                        muted={audioTrack.muted}
                        onMove={(startFrame) => moveTimelineAudioClip(clip.id, startFrame)}
                        onSelect={() => setSelectedAudioClipId(clip.id)}
                        selected={clip.id === selectedAudioClipId}
                        timeline={timeline}
                      />
                    ))}
                  </div>
                ))}
                <TimelinePlayhead frameSpan={frameSpan} onPointerDown={beginPlayheadDrag} timeline={timeline} />
              </div>
            </div>
          </div>
        </div>
      ) : bottomView === "scenes" ? (
        <div
          aria-labelledby="director-bottom-scenes-tab"
          className="animation-timeline-scene-browser"
          id="director-bottom-scenes"
          role="tabpanel"
        >
          <ProductionPanel variant="scene-browser" />
        </div>
      ) : (
        <PlayheadStoryboardPanel
          onFrameChange={onFrameChange}
          onFrameCommit={onFrameCommit}
          onOpenTimeline={() => setBottomView("timeline")}
          onSelectedShotChange={setSelectedStoryboardShotId}
          project={project}
          selectedShotId={selectedStoryboardShotId}
        />
      )}
    </section>
  );
}
