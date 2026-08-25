import type {
  DirectorEntityAnimation,
  DirectorTrajectoryMotion,
  DirectorTransform,
} from "../schema/directorProject";
import { normalizeDirectorFps } from "../timeline/frameTime";
import { createFrameTrajectoryAnimation, type DirectorTrajectoryWaypoint } from "../trajectory/trajectoryMath";

/**
 * Pure gameplay-performance recorder for the live player mode.
 *
 * A recorder ingests render-rate pose samples (elapsed seconds, world
 * position, heading yaw) from one actor — the walking character or the driven
 * vehicle — and bakes them into the project's deterministic keyframe format
 * (`DirectorEntityAnimation`). Everything here is deterministic for identical
 * input sequences: no clocks, no randomness, no store access. The recording
 * session below adds the walk↔drive clip-switch state machine; DirectorCanvas
 * owns the wall clock, the store lookups, and the undoable write.
 *
 * Frame semantics (matching the pre-existing walking recorder):
 * - Recording starts writing at the current playhead frame so performances
 *   can be layered into a sequence ("act from here").
 * - Sample times map to integer frames at the project timeline fps and clamp
 *   at the timeline's `frameEnd`; the timeline is never extended, the take
 *   simply stops advancing at the end — exactly like the previous
 *   `setObjectAnimation`-based recorder.
 */

/** Keep a keyframe once the path strays this far (metres) from the corridor. */
export const PLAYER_MOTION_POSITION_TOLERANCE_M = 0.03;
/** Keep a keyframe once the heading strays this far from the corridor. */
export const PLAYER_MOTION_YAW_TOLERANCE_RAD = (1.5 * Math.PI) / 180;
/** Hard cap on kept keyframes per recorded second (first/last are exempt). */
export const PLAYER_MOTION_MAX_KEYFRAMES_PER_SECOND = 20;
/** Corridor deviation probes per candidate; bounds finalize cost on long takes. */
const CORRIDOR_PROBE_LIMIT = 64;

/** One pose sample from the live render loop, keyed by elapsed clip time. */
export interface PlayerMotionSample {
  /** Seconds since this clip started; expected non-decreasing. */
  timeSeconds: number;
  /** World-space position [x, y, z] at this sample. */
  position: readonly [number, number, number];
  /** Heading around +Y. May be wrapped ([-π, π]); the recorder unwraps it. */
  yawRadians: number;
}

/** One deduped per-frame sample; shape-compatible with PlayerRecordingSample. */
export interface PlayerMotionFrameSample {
  /** Timeline frame number for this sample. */
  frame: number;
  /** Full world-space transform at this frame. */
  transform: DirectorTransform;
}

export interface PlayerMotionRecorderOptions {
  /** Project timeline fps used for the time→frame mapping. */
  fps: number;
  /** Playhead frame where the clip starts writing. */
  startFrame: number;
  /** Inclusive timeline end; recorded frames clamp here. */
  frameEnd: number;
  /**
   * Actor transform when the clip starts. Keyframes preserve its scale and
   * X/Z tilt; only position and Y heading come from the performance.
   */
  baseTransform: DirectorTransform;
  /** Existing animation whose pose-only keyframes survive the re-record. */
  existingAnimation?: DirectorEntityAnimation;
  /** Corridor position tolerance in metres; below this deviation no keyframe is kept. */
  positionToleranceM?: number;
  /** Corridor yaw tolerance in radians; below this deviation no keyframe is kept. */
  yawToleranceRad?: number;
  /** Hard cap on keyframes per recorded second. */
  maxKeyframesPerSecond?: number;
}

/** Completed recording ready for timeline insertion. */
export interface PlayerMotionRecording {
  /** Baked keyframe animation spanning the recorded frames. */
  animation: DirectorEntityAnimation;
  /** First frame of the recorded clip. */
  frameStart: number;
  /** Last frame of the recorded clip. */
  frameEnd: number;
  /** Number of keyframes kept after corridor decimation. */
  keyframeCount: number;
}

interface RecordedFrame {
  frame: number;
  position: [number, number, number];
  /** Unwrapped (continuous) yaw so consecutive keys never lerp the long way. */
  yaw: number;
}

function wrapAngleToPi(angle: number): number {
  // atan2 keeps the result in (-π, π] without accumulating fmod error.
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function cloneTransform(transform: DirectorTransform): DirectorTransform {
  return {
    position: [...transform.position] as [number, number, number],
    rotation: [...transform.rotation] as [number, number, number],
    scale: [...transform.scale] as [number, number, number],
  };
}

/**
 * Streaming gameplay-performance recorder that ingests render-rate pose samples
 * and bakes them into deterministic keyframe data. Samples are deduplicated per
 * frame (last sample wins), yaw is unwrapped across ±π boundaries, and the
 * final keyframe set is decimated with a corridor-based corner detector.
 */
export class PlayerMotionRecorder {
  private readonly fps: number;
  private readonly startFrame: number;
  private readonly frameEnd: number;
  private readonly baseTransform: DirectorTransform;
  private readonly existingAnimation?: DirectorEntityAnimation;
  private readonly positionTolerance: number;
  private readonly yawTolerance: number;
  /** Minimum frame distance between kept keyframes derived from the cap. */
  private readonly minKeyframeFrameSpacing: number;
  private readonly frames: RecordedFrame[] = [];
  private lastInputYaw: number | null = null;
  private lastUnwrappedYaw = 0;
  private finalized = false;

  constructor(options: PlayerMotionRecorderOptions) {
    this.fps = normalizeDirectorFps(options.fps);
    this.startFrame = Math.round(options.startFrame);
    this.frameEnd = Math.max(this.startFrame, Math.round(options.frameEnd));
    this.baseTransform = cloneTransform(options.baseTransform);
    this.existingAnimation = options.existingAnimation;
    this.positionTolerance = options.positionToleranceM ?? PLAYER_MOTION_POSITION_TOLERANCE_M;
    this.yawTolerance = options.yawToleranceRad ?? PLAYER_MOTION_YAW_TOLERANCE_RAD;
    const cap = Math.max(1, options.maxKeyframesPerSecond ?? PLAYER_MOTION_MAX_KEYFRAMES_PER_SECOND);
    this.minKeyframeFrameSpacing = this.fps / cap;
  }

  /**
   * Ingests one render-rate pose sample. Time is expected monotonic; stale
   * timestamps fold into the last frame. Same-frame samples overwrite the
   * previous entry so the final pose of a frame is preserved.
   *
   * @param sample - Pose sample with elapsed clip time and world transform.
   */
  ingest(sample: PlayerMotionSample): void {
    if (this.finalized || !Number.isFinite(sample.timeSeconds)) return;
    const elapsedFrames = Math.round(Math.max(0, sample.timeSeconds) * this.fps);
    const mappedFrame = Math.min(this.frameEnd, this.startFrame + elapsedFrames);
    const previous = this.frames[this.frames.length - 1];
    // Time is expected monotonic; a stale timestamp folds into the last frame.
    const frame = previous ? Math.max(previous.frame, mappedFrame) : mappedFrame;

    // Unwrap the incoming (possibly wrapped) yaw against the previous input so
    // a -π/π crossing becomes a small continuous delta instead of a ~2π jump.
    const unwrappedYaw =
      this.lastInputYaw === null
        ? sample.yawRadians
        : this.lastUnwrappedYaw + wrapAngleToPi(sample.yawRadians - this.lastInputYaw);
    this.lastInputYaw = sample.yawRadians;
    this.lastUnwrappedYaw = unwrappedYaw;

    const recorded: RecordedFrame = {
      frame,
      position: [sample.position[0], sample.position[1], sample.position[2]],
      yaw: unwrappedYaw,
    };
    // Same-frame dedupe: the last sample for a frame wins (the pose the frame
    // actually ends on), unlike the previous recorder which kept the first.
    if (previous && previous.frame === frame) this.frames[this.frames.length - 1] = recorded;
    else this.frames.push(recorded);
  }

  /** Per-frame deduped raw samples, e.g. for the walking gait inference. */
  getFrameSamples(): PlayerMotionFrameSample[] {
    return this.frames.map((entry) => ({
      frame: entry.frame,
      transform: this.frameTransform(entry),
    }));
  }

  /** Number of per-frame deduped samples ingested so far. */
  get sampleCount(): number {
    return this.frames.length;
  }

  /**
   * Bakes the ingested samples into keyframe data. Single-shot: later calls
   * (and clips with fewer than two distinct frames) return null.
   */
  finalize(options?: { motion?: DirectorTrajectoryMotion }): PlayerMotionRecording | null {
    if (this.finalized) return null;
    this.finalized = true;
    const kept = this.selectKeyframes();
    if (kept.length < 2) return null;
    const frameStart = kept[0]!.frame;
    const frameEnd = kept[kept.length - 1]!.frame;
    if (frameEnd <= frameStart) return null;

    const waypoints: DirectorTrajectoryWaypoint[] = kept.map((entry) => {
      const transform = this.frameTransform(entry);
      return {
        frame: entry.frame,
        position: transform.position,
        rotation: transform.rotation,
        scale: transform.scale,
        // Linear keeps the performed velocity constant between decimated
        // corners; the default "smooth" would ease every segment in and out
        // and make long spans pulse.
        interpolation: "linear",
      };
    });

    const animation = createFrameTrajectoryAnimation({
      baseTransform: this.baseTransform,
      existingAnimation: this.existingAnimation,
      frameStart,
      frameEnd,
      motion: options?.motion ?? "none",
      // Recorded yaw is authoritative: path-tangent orientation would snap at
      // decimated corners and face backwards while a vehicle reverses.
      orientToPath: false,
      preset: "custom",
      source: "manual",
      waypoints,
    });
    return { animation, frameStart, frameEnd, keyframeCount: waypoints.length };
  }

  private frameTransform(entry: RecordedFrame): DirectorTransform {
    const base = this.baseTransform;
    return {
      position: [...entry.position] as [number, number, number],
      rotation: [base.rotation[0], entry.yaw, base.rotation[2]],
      scale: [...base.scale] as [number, number, number],
    };
  }

  /**
   * Streaming Ramer-Douglas-Peucker-style corner detector. Walks the deduped
   * frames once, keeping the sample before the first one whose corridor (the
   * linear interpolation between the last kept sample and the candidate)
   * deviates beyond tolerance. First and last samples are always kept; the
   * per-second cap enforces a minimum frame spacing between interior keys.
   */
  private selectKeyframes(): RecordedFrame[] {
    const frames = this.frames;
    if (frames.length <= 2) return frames.slice();

    const kept: RecordedFrame[] = [frames[0]!];
    let anchor = 0;
    for (let candidate = 2; candidate < frames.length; candidate += 1) {
      if (!this.corridorBroken(anchor, candidate)) continue;
      const keepIndex = candidate - 1;
      // Cap: interior keys must respect the minimum spacing; the corridor
      // stays broken, so the next admissible break keeps a point instead.
      if (frames[keepIndex]!.frame - kept[kept.length - 1]!.frame < this.minKeyframeFrameSpacing) continue;
      kept.push(frames[keepIndex]!);
      anchor = keepIndex;
    }
    kept.push(frames[frames.length - 1]!);
    return kept;
  }

  /** True when any interior sample strays from the anchor→candidate chord. */
  private corridorBroken(anchor: number, candidate: number): boolean {
    const frames = this.frames;
    const start = frames[anchor]!;
    const end = frames[candidate]!;
    const frameSpan = end.frame - start.frame;
    if (frameSpan <= 0) return false;
    const interiorCount = candidate - anchor - 1;
    const stride = Math.max(1, Math.ceil(interiorCount / CORRIDOR_PROBE_LIMIT));
    for (let index = anchor + 1; index < candidate; index += stride) {
      const probe = frames[index]!;
      const t = (probe.frame - start.frame) / frameSpan;
      const expectedX = start.position[0] + (end.position[0] - start.position[0]) * t;
      const expectedY = start.position[1] + (end.position[1] - start.position[1]) * t;
      const expectedZ = start.position[2] + (end.position[2] - start.position[2]) * t;
      const deviation = Math.hypot(
        probe.position[0] - expectedX,
        probe.position[1] - expectedY,
        probe.position[2] - expectedZ,
      );
      if (deviation > this.positionTolerance) return true;
      const expectedYaw = start.yaw + (end.yaw - start.yaw) * t;
      if (Math.abs(probe.yaw - expectedYaw) > this.yawTolerance) return true;
    }
    return false;
  }
}

/**
 * Creates a new motion recorder for a single clip.
 *
 * @param options - Clip configuration: fps, frame range, base transform, and existing animation.
 * @returns A fresh recorder ready to ingest samples.
 */
export function createPlayerMotionRecorder(options: PlayerMotionRecorderOptions): PlayerMotionRecorder {
  return new PlayerMotionRecorder(options);
}

/**
 * Toggle-driven recording session covering both play modes. One session spans
 * one press of 记录移动 to the next press of 停止记录. Samples are attributed to
 * whichever actor the live session currently animates — the walking character
 * on foot, the driven vehicle behind the wheel. Switching actors mid-recording
 * (entering or exiting a car) finalizes the current clip and starts the next
 * clip on the new actor at the frame the switch happened, so a walk-then-drive
 * performance lays out sequentially on the timeline.
 */

/** Snapshot of an actor at clip start used to seed the recorder's base transform. */
export interface PlayerMotionRecordingActor {
  baseTransform: DirectorTransform;
  existingAnimation?: DirectorEntityAnimation;
}

/** One clip produced by the recording session, keyed by actor identity. */
export interface PlayerMotionRecordingClip {
  actorId: string;
  recorder: PlayerMotionRecorder;
}

/** Configuration for a recording session spanning one press of 记录移动. */
export interface PlayerMotionRecordingSessionOptions {
  fps: number;
  /** Playhead frame at session start; every clip offsets from it. */
  startFrame: number;
  /** Inclusive timeline end shared by every clip in the session. */
  frameEnd: number;
  /** Actor snapshot at clip start; null drops the clip (object vanished). */
  resolveActor: (actorId: string) => PlayerMotionRecordingActor | null;
  /** Receives every finalizable clip; the caller owns gait choice and store writes. */
  commitClip: (clip: PlayerMotionRecordingClip) => void;
}

/**
 * Toggle-driven recording session that routes render-rate samples to the
 * correct actor. Switching actors mid-recording (entering or exiting a vehicle)
 * finalizes the current clip and starts a new one on the new actor so a
 * walk-then-drive performance lays out sequentially on the timeline.
 */
export class PlayerMotionRecordingSession {
  private readonly options: PlayerMotionRecordingSessionOptions;
  private readonly fps: number;
  private active: { actorId: string; recorder: PlayerMotionRecorder; clipStartSeconds: number } | null = null;
  private stopped = false;

  constructor(options: PlayerMotionRecordingSessionOptions) {
    this.options = options;
    this.fps = normalizeDirectorFps(options.fps);
  }

  /** The actor currently being recorded, or null when no clip is active. */
  get activeActorId(): string | null {
    return this.active?.actorId ?? null;
  }

  /** Render-rate sample feed; timeSeconds counts from the session start. */
  ingest(actorId: string, timeSeconds: number, sample: Omit<PlayerMotionSample, "timeSeconds">): void {
    if (this.stopped || !Number.isFinite(timeSeconds)) return;
    if (this.active && this.active.actorId !== actorId) this.finalizeActiveClip();
    if (!this.active) {
      const actor = this.options.resolveActor(actorId);
      if (!actor) return;
      const clipStartSeconds = Math.max(0, timeSeconds);
      this.active = {
        actorId,
        clipStartSeconds,
        recorder: createPlayerMotionRecorder({
          baseTransform: actor.baseTransform,
          existingAnimation: actor.existingAnimation,
          fps: this.fps,
          frameEnd: this.options.frameEnd,
          // Later clips (after a walk↔drive switch) keep the session's wall
          // clock: they start at the frame where the switch happened.
          startFrame: Math.min(
            this.options.frameEnd,
            this.options.startFrame + Math.round(clipStartSeconds * this.fps),
          ),
        }),
      };
    }
    this.active.recorder.ingest({ ...sample, timeSeconds: timeSeconds - this.active.clipStartSeconds });
  }

  /** Finalizes the in-flight clip and refuses further samples. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.finalizeActiveClip();
  }

  private finalizeActiveClip(): void {
    const active = this.active;
    this.active = null;
    if (!active || active.recorder.sampleCount < 2) return;
    this.options.commitClip({ actorId: active.actorId, recorder: active.recorder });
  }
}

/**
 * Creates a new recording session.
 *
 * @param options - Session configuration: fps, frame range, actor resolver, and clip commit callback.
 * @returns A fresh session ready to ingest samples.
 */
export function createPlayerMotionRecordingSession(
  options: PlayerMotionRecordingSessionOptions,
): PlayerMotionRecordingSession {
  return new PlayerMotionRecordingSession(options);
}
