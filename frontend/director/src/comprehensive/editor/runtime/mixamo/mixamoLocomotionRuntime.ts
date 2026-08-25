import type { Object3D } from "three";
import { clamp, isRecord } from "../../../../../../../packages/protocol/src/primitives";
import { getDirectorCharacterMotion } from "@director/agent-engine/character-motions";
import type { DirectorCharacterIkState } from "../../schema/directorProject";

export const DIRECTOR_CHARACTER_LOCOMOTION_RUNTIME_KEY = "directorCharacterLocomotion";
export const DIRECTOR_CHARACTER_LOCOMOTION_RUNTIME_VERSION = 1;
export const DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S = 0.16;

export const DIRECTOR_CHARACTER_LOCOMOTION_MODES = ["idle", "walk", "run", "jump", "fly", "emote"] as const;

export type DirectorCharacterLocomotionMode = (typeof DIRECTOR_CHARACTER_LOCOMOTION_MODES)[number];

/**
 * Packaged catalog clips playable as roam emotes. The runtime renderer
 * preloads exactly this set for the controlled actor, so the controller can
 * start any of them without an async clip fetch mid-performance.
 */
export const DIRECTOR_CHARACTER_EMOTE_CLIP_IDS = ["wave", "clap", "talk", "sit-idle"] as const;

export type DirectorCharacterEmoteClipId = (typeof DIRECTOR_CHARACTER_EMOTE_CLIP_IDS)[number];

/**
 * Ephemeral play-mode input owned by the outer Director object. It deliberately
 * stays out of the persisted project: the character renderer consumes it on
 * every frame and layers the selected Mixamo clip below pose controls and IK.
 */
export interface DirectorCharacterLocomotionRuntimeState {
  version: typeof DIRECTOR_CHARACTER_LOCOMOTION_RUNTIME_VERSION;
  mode: DirectorCharacterLocomotionMode;
  /** Clip-space seconds. Walk/run switches preserve their normalized gait phase. */
  timeS: number;
  /** Actual resolved horizontal speed, used for cadence and diagnostics. */
  speedMps: number;
  /** Normalized 0..1 gait phase shared by walk and run. */
  normalizedPhase: number;
  /** Speed-aware clip sampling rate used to advance `timeS`. */
  playbackRate: number;
  /** Runtime contribution multiplied into the locomotion crossfade. */
  weight: number;
  /** Actor-local velocity. +X is right and +Z is forward. */
  localVelocityX: number;
  localVelocityZ: number;
  /** Signed visual-yaw velocity used by the directional Blend Space. */
  angularVelocityRadS: number;
  verticalVelocityMps: number;
  grounded: boolean;
  jumpPhase: "none" | "takeoff" | "airborne" | "landing";
  /**
   * Hold-to-crouch gait modifier. There is no packaged crouch clip, so the
   * renderer layers a procedural skeletal crouch (hip drop + leg IK + spine
   * lean) over the active gait while this is true, the actor is grounded, and
   * the mode is not jump/fly/emote. Optional and defaults to false so writers
   * unaware of crouching keep their exact previous behavior.
   */
  crouching?: boolean;
  /**
   * Optional gaze yaw for the procedural head-look layer: the wrapped signed
   * difference `wrap(cameraViewYaw - characterVisualYaw)` where both yaws use
   * the three.js `rotation.y` convention (`atan2(direction.x, direction.z)`).
   * Positive rotates the gaze counterclockwise seen from above, toward the
   * character's LEFT-hand side; negative toward the right-hand side (the
   * character faces +Z and its physical right is -X in director space).
   * Values are wrapped into [-PI, PI]. Omitted or non-finite disables the
   * head-look layer, so writers unaware of gaze keep their previous behavior.
   */
  lookYawRad?: number;
  /**
   * Optional gaze pitch for the head-look layer, positive looking up:
   * `asin(cameraViewDirection.y)`. Clamped into [-PI/2, PI/2]. A missing
   * pitch with a present `lookYawRad` is treated as level (0); when both
   * fields are omitted the head-look layer is disabled.
   */
  lookPitchRad?: number;
  /** State-machine-authored transition duration for this mode entry. */
  transitionDurationS: number;
  /** Changes whenever a one-shot jump is intentionally restarted. */
  clipStartedFrame: number;
  /** Catalog clip played while `mode` is `emote`; ignored otherwise. */
  emoteClipId?: string;
}

export type DirectorCharacterLocomotionClock = Pick<
  DirectorCharacterLocomotionRuntimeState,
  "mode" | "timeS" | "speedMps" | "normalizedPhase" | "playbackRate"
>;

const GAIT_MODES = new Set<DirectorCharacterLocomotionMode>(["walk", "run"]);
/**
 * Calibrated from the packaged Mixamo root curves at Director's 1.78 m hero
 * height. The controller travels at 1.73/3.35 m/s while the source cycles
 * cover 1.30/3.48 m/s, so cadence must follow distance instead of assuming
 * that both clips were authored for the same nominal velocity.
 */
export const DIRECTOR_CHARACTER_GAIT_BASE_PLAYBACK_RATE = {
  walk: 1.33,
  run: 0.96,
} as const;
/** The packaged standing jump is 2.43 s; the physical arc is about 0.9 s. */
export const DIRECTOR_CHARACTER_JUMP_BASE_PLAYBACK_RATE = 2.65;
const LOCOMOTION_OWNED_CONTROL_PREFIXES = [
  "body.",
  "leftHip.",
  "rightHip.",
  "leftKnee.",
  "rightKnee.",
  "leftFoot.",
  "rightFoot.",
] as const;

export type DirectorCharacterLocomotionTransitionPhase = "steady" | "enter" | "switch" | "exit";

export interface DirectorLocomotionRigBlendRuntime {
  controls: Record<string, number>;
  ik: DirectorCharacterIkState;
}

function isLocomotionOwnedControl(control: string) {
  return LOCOMOTION_OWNED_CONTROL_PREFIXES.some((prefix) => control.startsWith(prefix));
}

/**
 * Resolve the fraction of pelvis/leg ownership held by runtime locomotion.
 * The same smooth clip transition must drive pose and IK ownership; otherwise
 * a non-neutral authored stance visibly pops at the first/last roam frame.
 */
export function sampleDirectorCharacterLocomotionRigOwnership({
  phase,
  alpha,
  runtimeWeight,
  fromWeight,
  runtimeActive,
}: {
  phase: DirectorCharacterLocomotionTransitionPhase;
  alpha: number;
  runtimeWeight: number;
  fromWeight: number;
  runtimeActive: boolean;
}) {
  const t = clamp(Number.isFinite(alpha) ? alpha : 0, 0, 1);
  const to = runtimeActive ? clamp(Number.isFinite(runtimeWeight) ? runtimeWeight : 0, 0, 1) : 0;
  const from = clamp(Number.isFinite(fromWeight) ? fromWeight : 0, 0, 1);
  if (phase === "enter") return from + (to - from) * t;
  if (phase === "switch") return from + (to - from) * t;
  if (phase === "exit") return from * (1 - t);
  return to;
}

export function createDirectorLocomotionRigBlendRuntime(): DirectorLocomotionRigBlendRuntime {
  return { controls: {}, ik: {} };
}

/**
 * Write a stable, frame-local rig view without mutating persisted controls or
 * IK. Upper-body controls and hand IK remain authored. Pelvis/leg controls
 * fade toward their zero-valued neutral offsets as runtime ownership rises;
 * foot IK is blended later with world foot locks in `mixamoFootLockRig`.
 */
export function updateDirectorLocomotionRigBlendRuntime(
  runtime: DirectorLocomotionRigBlendRuntime,
  controls: Readonly<Record<string, number>>,
  ik: DirectorCharacterIkState | undefined,
  runtimeOwnershipWeight: number,
) {
  const ownership = clamp(Number.isFinite(runtimeOwnershipWeight) ? runtimeOwnershipWeight : 0, 0, 1);
  const authoredWeight = 1 - ownership;

  for (const control in runtime.controls) delete runtime.controls[control];
  for (const control in controls) {
    const value = controls[control];
    runtime.controls[control] = isLocomotionOwnedControl(control) ? value * authoredWeight : value;
  }

  runtime.ik.leftHand = ik?.leftHand;
  runtime.ik.rightHand = ik?.rightHand;
  runtime.ik.leftFoot = undefined;
  runtime.ik.rightFoot = undefined;
  return runtime;
}

/**
 * Runtime locomotion owns the pelvis and legs, but it must not erase an
 * authored upper-body performance. Keep torso/head/arm controls and hand IK;
 * foot IK remains disabled until it can be solved in world space by the
 * procedural foot-lock layer.
 */
export function resolveDirectorLocomotionRigLayers(
  controls: Readonly<Record<string, number>>,
  ik: DirectorCharacterIkState | undefined,
) {
  const runtime = updateDirectorLocomotionRigBlendRuntime(createDirectorLocomotionRigBlendRuntime(), controls, ik, 1);
  for (const control in runtime.controls) {
    if (isLocomotionOwnedControl(control)) delete runtime.controls[control];
  }
  return {
    controls: runtime.controls,
    ik: runtime.ik.leftHand || runtime.ik.rightHand ? runtime.ik : undefined,
  };
}

function getModeDuration(mode: DirectorCharacterLocomotionMode) {
  return getDirectorCharacterMotion(getDirectorCharacterLocomotionClipId(mode))?.durationS ?? 1;
}

/**
 * Advance the frame-local gait clock without restarting the planted foot when
 * walk and run crossfade. The rate follows resolved speed within a conservative
 * band; this removes low-speed moonwalking without making the Mixamo clip race.
 */
export function advanceDirectorCharacterLocomotionClock({
  previous,
  mode,
  deltaS,
  speedMps,
  walkSpeedMps,
  runSpeedMps,
  restartClip = false,
}: {
  previous: DirectorCharacterLocomotionClock;
  mode: DirectorCharacterLocomotionMode;
  deltaS: number;
  speedMps: number;
  walkSpeedMps: number;
  runSpeedMps: number;
  restartClip?: boolean;
}): DirectorCharacterLocomotionClock {
  const safeDelta = Number.isFinite(deltaS) ? Math.max(0, Math.min(deltaS, 0.1)) : 0;
  const safeSpeed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const nominalSpeed = mode === "run" ? runSpeedMps : mode === "walk" ? walkSpeedMps : 0;
  const speedRatio = nominalSpeed > 0 ? safeSpeed / nominalSpeed : 1;
  const baseRate =
    mode === "run"
      ? DIRECTOR_CHARACTER_GAIT_BASE_PLAYBACK_RATE.run
      : mode === "walk"
        ? DIRECTOR_CHARACTER_GAIT_BASE_PLAYBACK_RATE.walk
        : mode === "jump"
          ? DIRECTOR_CHARACTER_JUMP_BASE_PLAYBACK_RATE
          : 1;
  const playbackRate = GAIT_MODES.has(mode) ? baseRate * clamp(speedRatio, 0.72, 1.28) : baseRate;
  const durationS = Math.max(0.000001, getModeDuration(mode));
  const keepsGaitPhase = GAIT_MODES.has(previous.mode) && GAIT_MODES.has(mode);
  let timeS: number;

  if (restartClip) {
    timeS = 0;
  } else if (previous.mode === mode) {
    timeS = previous.timeS + safeDelta * playbackRate;
  } else if (keepsGaitPhase) {
    timeS = clamp(previous.normalizedPhase, 0, 1) * durationS;
  } else {
    timeS = 0;
  }

  return {
    mode,
    timeS,
    speedMps: safeSpeed,
    normalizedPhase: mode === "jump" ? clamp(timeS / durationS, 0, 1) : (timeS % durationS) / durationS,
    playbackRate,
  };
}

/** Wrap any finite angle into [-PI, PI]; everything else disables the field. */
function normalizeLookYawRad(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.atan2(Math.sin(value), Math.cos(value));
}

/** Gaze pitch is physically bounded by straight up/down; clamp after wrapping. */
function normalizeLookPitchRad(value: unknown): number | undefined {
  const wrapped = normalizeLookYawRad(value);
  if (wrapped === undefined) return undefined;
  return clamp(wrapped, -Math.PI / 2, Math.PI / 2);
}

const locomotionModeSet = new Set<string>(DIRECTOR_CHARACTER_LOCOMOTION_MODES);
// R3F owns Object3D.userData when a JSX `userData` prop is present and may
// replace the whole object on any React render. Player locomotion is frame-local
// runtime state, so keeping it in userData caused the active clip to disappear
// whenever unrelated UI state (for example the 5 Hz HUD status) re-rendered the
// scene. A WeakMap gives the outer Director object stable, garbage-collected
// ownership without leaking transient state into serialized scene metadata.
const locomotionRuntimeByObject = new WeakMap<Object3D, DirectorCharacterLocomotionRuntimeState>();

export function parseDirectorCharacterLocomotionRuntimeState(
  value: unknown,
): DirectorCharacterLocomotionRuntimeState | null {
  if (!isRecord(value) || value.version !== DIRECTOR_CHARACTER_LOCOMOTION_RUNTIME_VERSION) return null;
  if (typeof value.mode !== "string" || !locomotionModeSet.has(value.mode)) return null;
  if (typeof value.timeS !== "number" || !Number.isFinite(value.timeS) || value.timeS < 0) return null;
  if (typeof value.weight !== "number" || !Number.isFinite(value.weight)) return null;
  const speedMps =
    typeof value.speedMps === "number" && Number.isFinite(value.speedMps) ? Math.max(0, value.speedMps) : 0;
  const normalizedPhase =
    typeof value.normalizedPhase === "number" && Number.isFinite(value.normalizedPhase)
      ? clamp(value.normalizedPhase, 0, 1)
      : 0;
  const playbackRate =
    typeof value.playbackRate === "number" && Number.isFinite(value.playbackRate) ? Math.max(0, value.playbackRate) : 1;
  const localVelocityX =
    typeof value.localVelocityX === "number" && Number.isFinite(value.localVelocityX) ? value.localVelocityX : 0;
  const localVelocityZ =
    typeof value.localVelocityZ === "number" && Number.isFinite(value.localVelocityZ) ? value.localVelocityZ : 0;
  const angularVelocityRadS =
    typeof value.angularVelocityRadS === "number" && Number.isFinite(value.angularVelocityRadS)
      ? value.angularVelocityRadS
      : 0;
  const verticalVelocityMps =
    typeof value.verticalVelocityMps === "number" && Number.isFinite(value.verticalVelocityMps)
      ? value.verticalVelocityMps
      : 0;
  const jumpPhase =
    value.jumpPhase === "takeoff" || value.jumpPhase === "airborne" || value.jumpPhase === "landing"
      ? value.jumpPhase
      : "none";
  const crouching = value.crouching === true;
  const transitionDurationS =
    typeof value.transitionDurationS === "number" && Number.isFinite(value.transitionDurationS)
      ? Math.max(0, value.transitionDurationS)
      : DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S;
  const clipStartedFrame =
    typeof value.clipStartedFrame === "number" && Number.isFinite(value.clipStartedFrame)
      ? Math.max(0, Math.floor(value.clipStartedFrame))
      : 0;
  const emoteClipId = typeof value.emoteClipId === "string" && value.emoteClipId ? value.emoteClipId : undefined;
  const lookYawRad = normalizeLookYawRad(value.lookYawRad);
  const lookPitchRad = normalizeLookPitchRad(value.lookPitchRad);

  return {
    version: DIRECTOR_CHARACTER_LOCOMOTION_RUNTIME_VERSION,
    mode: value.mode as DirectorCharacterLocomotionMode,
    timeS: value.timeS,
    speedMps,
    normalizedPhase,
    playbackRate,
    weight: Math.min(1, Math.max(0, value.weight)),
    localVelocityX,
    localVelocityZ,
    angularVelocityRadS,
    verticalVelocityMps,
    grounded: value.grounded === true,
    jumpPhase,
    crouching,
    lookYawRad,
    lookPitchRad,
    transitionDurationS,
    clipStartedFrame,
    emoteClipId,
  };
}

/** Read the nearest owning object's runtime state without touching persisted scene metadata. */
export function readDirectorCharacterLocomotionRuntimeState(
  object: Object3D | null,
): DirectorCharacterLocomotionRuntimeState | null {
  let current = object;
  while (current) {
    const state = locomotionRuntimeByObject.get(current);
    if (state) return state;
    current = current.parent;
  }
  return null;
}

export function writeDirectorCharacterLocomotionRuntimeState(
  object: Object3D,
  state: Pick<DirectorCharacterLocomotionRuntimeState, "mode" | "timeS" | "weight"> &
    Partial<
      Pick<
        DirectorCharacterLocomotionRuntimeState,
        | "angularVelocityRadS"
        | "clipStartedFrame"
        | "crouching"
        | "emoteClipId"
        | "grounded"
        | "jumpPhase"
        | "localVelocityX"
        | "localVelocityZ"
        | "lookPitchRad"
        | "lookYawRad"
        | "normalizedPhase"
        | "playbackRate"
        | "speedMps"
        | "transitionDurationS"
        | "verticalVelocityMps"
      >
    >,
) {
  const timeS = Math.max(0, Number.isFinite(state.timeS) ? state.timeS : 0);
  const speedMps = Math.max(
    0,
    typeof state.speedMps === "number" && Number.isFinite(state.speedMps) ? state.speedMps : 0,
  );
  const normalizedPhase = clamp(
    typeof state.normalizedPhase === "number" && Number.isFinite(state.normalizedPhase) ? state.normalizedPhase : 0,
    0,
    1,
  );
  const playbackRate = Math.max(
    0,
    typeof state.playbackRate === "number" && Number.isFinite(state.playbackRate) ? state.playbackRate : 1,
  );
  const weight = Math.min(1, Math.max(0, Number.isFinite(state.weight) ? state.weight : 1));
  const localVelocityX =
    typeof state.localVelocityX === "number" && Number.isFinite(state.localVelocityX) ? state.localVelocityX : 0;
  const localVelocityZ =
    typeof state.localVelocityZ === "number" && Number.isFinite(state.localVelocityZ) ? state.localVelocityZ : 0;
  const angularVelocityRadS =
    typeof state.angularVelocityRadS === "number" && Number.isFinite(state.angularVelocityRadS)
      ? state.angularVelocityRadS
      : 0;
  const verticalVelocityMps =
    typeof state.verticalVelocityMps === "number" && Number.isFinite(state.verticalVelocityMps)
      ? state.verticalVelocityMps
      : 0;
  const jumpPhase =
    state.jumpPhase === "takeoff" || state.jumpPhase === "airborne" || state.jumpPhase === "landing"
      ? state.jumpPhase
      : "none";
  const crouching = state.crouching === true;
  const lookYawRad = normalizeLookYawRad(state.lookYawRad);
  const lookPitchRad = normalizeLookPitchRad(state.lookPitchRad);
  const transitionDurationS =
    typeof state.transitionDurationS === "number" && Number.isFinite(state.transitionDurationS)
      ? Math.max(0, state.transitionDurationS)
      : DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S;
  const clipStartedFrame =
    typeof state.clipStartedFrame === "number" && Number.isFinite(state.clipStartedFrame)
      ? Math.max(0, Math.floor(state.clipStartedFrame))
      : 0;
  const emoteClipId = state.mode === "emote" && state.emoteClipId ? state.emoteClipId : undefined;
  const current = locomotionRuntimeByObject.get(object);
  if (current) {
    current.mode = state.mode;
    current.timeS = timeS;
    current.speedMps = speedMps;
    current.normalizedPhase = normalizedPhase;
    current.playbackRate = playbackRate;
    current.weight = weight;
    current.localVelocityX = localVelocityX;
    current.localVelocityZ = localVelocityZ;
    current.angularVelocityRadS = angularVelocityRadS;
    current.verticalVelocityMps = verticalVelocityMps;
    current.grounded = state.grounded === true;
    current.jumpPhase = jumpPhase;
    current.crouching = crouching;
    current.lookYawRad = lookYawRad;
    current.lookPitchRad = lookPitchRad;
    current.transitionDurationS = transitionDurationS;
    current.clipStartedFrame = clipStartedFrame;
    current.emoteClipId = emoteClipId;
    return;
  }
  locomotionRuntimeByObject.set(object, {
    version: DIRECTOR_CHARACTER_LOCOMOTION_RUNTIME_VERSION,
    mode: state.mode,
    timeS,
    speedMps,
    normalizedPhase,
    playbackRate,
    weight,
    localVelocityX,
    localVelocityZ,
    angularVelocityRadS,
    verticalVelocityMps,
    grounded: state.grounded === true,
    jumpPhase,
    crouching,
    lookYawRad,
    lookPitchRad,
    transitionDurationS,
    clipStartedFrame,
    emoteClipId,
  });
}

export function clearDirectorCharacterLocomotionRuntimeState(object: Object3D) {
  locomotionRuntimeByObject.delete(object);
}

export function getDirectorCharacterLocomotionClipId(mode: DirectorCharacterLocomotionMode) {
  // Emote resolution happens through the runtime state's `emoteClipId`; the
  // mode itself only supplies the idle fallback when that clip is unavailable.
  if (mode === "fly" || mode === "emote") return "idle";
  return mode;
}

export function sampleDirectorCharacterLocomotionTime(
  state: Pick<DirectorCharacterLocomotionRuntimeState, "mode" | "timeS">,
  durationS: number,
) {
  const safeDuration = Math.max(0.000001, durationS);
  // One-shot playback clamps at the final pose. Looping emotes stay below the
  // clip duration because the controller wraps their clock before writing.
  if (state.mode === "jump" || state.mode === "emote") return Math.min(state.timeS, safeDuration);
  return state.timeS % safeDuration;
}

/**
 * Resolve a state-authored transition duration into a renderable crossfade.
 * A freshly created locomotion machine state (roam entry, emote end, fly
 * landing) publishes `transitionDurationS: 0` as bookkeeping, not as an
 * authored hard cut. Flooring it here keeps every clip enter/switch smooth
 * without changing the serialized state schema or its writers.
 */
export function resolveDirectorCharacterLocomotionTransitionDurationS(transitionDurationS: number) {
  if (!Number.isFinite(transitionDurationS) || transitionDurationS <= 0) {
    return DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S;
  }
  return Math.min(1, transitionDurationS);
}

/** Smooth, bounded blend used when entering, leaving, or switching locomotion clips. */
export function sampleDirectorCharacterLocomotionBlend(
  elapsedS: number,
  durationS = DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
) {
  if (durationS <= 0) return 1;
  const linear = Math.min(1, Math.max(0, elapsedS / durationS));
  return linear * linear * (3 - 2 * linear);
}
