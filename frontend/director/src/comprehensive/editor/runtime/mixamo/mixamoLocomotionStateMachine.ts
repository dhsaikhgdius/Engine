export const DIRECTOR_CHARACTER_GROUND_LOCOMOTION_MODES = ["idle", "walk", "run"] as const;
export const DIRECTOR_CHARACTER_ANIMATED_LOCOMOTION_MODES = ["idle", "walk", "run", "jump"] as const;
export const DIRECTOR_CHARACTER_JUMP_PHASES = ["none", "takeoff", "airborne", "landing"] as const;

export type DirectorCharacterGroundLocomotionMode = (typeof DIRECTOR_CHARACTER_GROUND_LOCOMOTION_MODES)[number];
export type DirectorCharacterAnimatedLocomotionMode = (typeof DIRECTOR_CHARACTER_ANIMATED_LOCOMOTION_MODES)[number];
export type DirectorCharacterJumpPhase = (typeof DIRECTOR_CHARACTER_JUMP_PHASES)[number];
export type DirectorCharacterLocomotionLoop = "repeat" | "once";

export interface DirectorCharacterLocomotionMachineConfig {
  /** Fraction of nominal walk speed required to leave idle. */
  walkEnterRatio: number;
  /** Lower fraction used to return to idle, creating a stable dead band. */
  walkExitRatio: number;
  /** Fraction across walk..run nominal speeds required to enter run. */
  runEnterRatio: number;
  /** Lower fraction used to leave run, creating a stable dead band. */
  runExitRatio: number;
  minGroundedStateHoldS: number;
  takeoffLockS: number;
  takeoffTimeoutS: number;
  minAirborneS: number;
  landingLockS: number;
  landingVerticalSpeedMaxMps: number;
  gaitTransitionS: number;
  runTransitionS: number;
  jumpTransitionS: number;
  /**
   * Continuous off-ground time required before an unrequested contact loss
   * becomes airborne. Player motors drop `grounded` for a frame or two on
   * step-downs, slope edges, and physics substep seams; reacting instantly
   * flashed the jump clip and reset the gait phase. Optional for backwards
   * compatibility; omitted configs use the default below.
   */
  ungroundedGraceS?: number;
  /**
   * Continuous ground contact that force-resolves takeoff/airborne into
   * landing even while vertical speed stays above the landing threshold
   * (risers, lifts, moving platforms). Without it the jump phases dead-lock
   * on any surface that keeps a positive vertical velocity while grounded.
   */
  landingContactLatchS?: number;
}

const FALLBACK_UNGROUNDED_GRACE_S = 0.1;
const FALLBACK_LANDING_CONTACT_LATCH_S = 0.15;

export const DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG = Object.freeze({
  walkEnterRatio: 0.12,
  walkExitRatio: 0.07,
  runEnterRatio: 0.62,
  runExitRatio: 0.42,
  minGroundedStateHoldS: 0.12,
  takeoffLockS: 0.08,
  takeoffTimeoutS: 0.24,
  minAirborneS: 0.08,
  landingLockS: 0.12,
  landingVerticalSpeedMaxMps: 0.35,
  gaitTransitionS: 0.16,
  runTransitionS: 0.14,
  jumpTransitionS: 0.1,
  ungroundedGraceS: FALLBACK_UNGROUNDED_GRACE_S,
  landingContactLatchS: FALLBACK_LANDING_CONTACT_LATCH_S,
}) satisfies Readonly<DirectorCharacterLocomotionMachineConfig>;

export interface DirectorCharacterLocomotionMachineInput {
  /** Monotonic simulation/capture frame. Used for receipts and clip restarts. */
  frame: number;
  /** Monotonic simulation time. State timing never depends on wall-clock time. */
  timestampS: number;
  speedMps: number;
  walkSpeedMps: number;
  runSpeedMps: number;
  grounded: boolean;
  verticalSpeedMps: number;
  /** Edge-triggered. A request received in the air is buffered through landing. */
  jumpRequested: boolean;
}

/**
 * Caller-owned, serializable state and output. `clipId`, `loop`, transition,
 * and normalized speed can be consumed directly by a renderer or Agent audit.
 */
export interface DirectorCharacterLocomotionMachineState {
  mode: DirectorCharacterAnimatedLocomotionMode;
  groundMode: DirectorCharacterGroundLocomotionMode;
  jumpPhase: DirectorCharacterJumpPhase;
  jumpQueued: boolean;
  clipId: DirectorCharacterAnimatedLocomotionMode;
  loop: DirectorCharacterLocomotionLoop;
  transitionDurationS: number;
  normalizedSpeed: number;
  modeEnteredFrame: number;
  modeEnteredAtS: number;
  phaseEnteredFrame: number;
  phaseEnteredAtS: number;
  clipStartedFrame: number;
  clipStartedAtS: number;
  /** Timestamp of the most recent grounded sample; drives the airborne grace. */
  lastGroundedAtS: number;
  /** Start of the current continuous grounded streak, or -1 while off ground. */
  groundedContactAtS: number;
  lastFrame: number;
  lastTimestampS: number;
}

function finiteNonNegative(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function normalizedFrame(frame: number, fallback: number) {
  return Number.isFinite(frame) ? Math.max(fallback, Math.floor(frame)) : fallback;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function chooseGroundMode(
  current: DirectorCharacterGroundLocomotionMode,
  speedMps: number,
  walkSpeedMps: number,
  runSpeedMps: number,
  config: Readonly<DirectorCharacterLocomotionMachineConfig>,
): DirectorCharacterGroundLocomotionMode {
  const walkEnter = Math.max(0.01, walkSpeedMps * config.walkEnterRatio);
  const walkExit = Math.min(walkEnter, Math.max(0, walkSpeedMps * config.walkExitRatio));
  const speedRange = Math.max(0.01, runSpeedMps - walkSpeedMps);
  const runEnter = walkSpeedMps + speedRange * config.runEnterRatio;
  const runExit = Math.min(runEnter, walkSpeedMps + speedRange * config.runExitRatio);

  if (current === "idle") {
    if (speedMps >= runEnter) return "run";
    return speedMps >= walkEnter ? "walk" : "idle";
  }
  if (current === "walk") {
    if (speedMps >= runEnter) return "run";
    return speedMps <= walkExit ? "idle" : "walk";
  }
  if (speedMps <= walkExit) return "idle";
  return speedMps < runExit ? "walk" : "run";
}

function transitionDuration(
  from: DirectorCharacterAnimatedLocomotionMode,
  to: DirectorCharacterAnimatedLocomotionMode,
  config: Readonly<DirectorCharacterLocomotionMachineConfig>,
) {
  if (to === "jump") return config.jumpTransitionS;
  if (from === "jump") {
    // Takeoff wants a snappy cut into the one-shot, but landing recovery
    // reads mechanical at the same duration: settle back into the gait over
    // the regular gait/run blend window instead.
    return Math.max(config.jumpTransitionS, to === "run" ? config.runTransitionS : config.gaitTransitionS);
  }
  if (from === "run" || to === "run") return config.runTransitionS;
  return config.gaitTransitionS;
}

function writeModeOutput(
  output: DirectorCharacterLocomotionMachineState,
  mode: DirectorCharacterAnimatedLocomotionMode,
) {
  output.clipId = mode;
  output.loop = mode === "jump" ? "once" : "repeat";
}

export function createDirectorCharacterLocomotionMachineState(
  frame = 0,
  timestampS = 0,
  target?: DirectorCharacterLocomotionMachineState,
) {
  const safeFrame = normalizedFrame(frame, 0);
  const safeTimestamp = finiteNonNegative(timestampS, 0);
  const output = target ?? ({} as DirectorCharacterLocomotionMachineState);
  output.mode = "idle";
  output.groundMode = "idle";
  output.jumpPhase = "none";
  output.jumpQueued = false;
  output.clipId = "idle";
  output.loop = "repeat";
  output.transitionDurationS = 0;
  output.normalizedSpeed = 0;
  output.modeEnteredFrame = safeFrame;
  output.modeEnteredAtS = safeTimestamp;
  output.phaseEnteredFrame = safeFrame;
  output.phaseEnteredAtS = safeTimestamp;
  output.clipStartedFrame = safeFrame;
  output.clipStartedAtS = safeTimestamp;
  output.lastGroundedAtS = safeTimestamp;
  output.groundedContactAtS = -1;
  output.lastFrame = safeFrame;
  output.lastTimestampS = safeTimestamp;
  return output;
}

/**
 * Deterministic, allocation-free transition function. It has no module-local
 * runtime state and reads only `previous`, `input`, and `config`. Pass a pair
 * of caller-owned state buffers (or the same object for in-place stepping).
 */
export function stepDirectorCharacterLocomotionMachine(
  previous: Readonly<DirectorCharacterLocomotionMachineState>,
  input: Readonly<DirectorCharacterLocomotionMachineInput>,
  output: DirectorCharacterLocomotionMachineState,
  config: Readonly<DirectorCharacterLocomotionMachineConfig> = DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG,
) {
  const previousMode = previous.mode;
  let mode = previousMode;
  let groundMode = previous.groundMode;
  let jumpPhase = previous.jumpPhase;
  let jumpQueued = previous.jumpQueued;
  let transitionDurationS = previous.transitionDurationS;
  let modeEnteredFrame = previous.modeEnteredFrame;
  let modeEnteredAtS = previous.modeEnteredAtS;
  let phaseEnteredFrame = previous.phaseEnteredFrame;
  let phaseEnteredAtS = previous.phaseEnteredAtS;
  let clipStartedFrame = previous.clipStartedFrame;
  let clipStartedAtS = previous.clipStartedAtS;

  const frame = normalizedFrame(input.frame, previous.lastFrame);
  const timestampS = Math.max(previous.lastTimestampS, finiteNonNegative(input.timestampS, previous.lastTimestampS));
  const speedMps = finiteNonNegative(input.speedMps, 0);
  const walkSpeedMps = Math.max(0.01, finiteNonNegative(input.walkSpeedMps, 1));
  const runSpeedMps = Math.max(walkSpeedMps + 0.01, finiteNonNegative(input.runSpeedMps, walkSpeedMps + 1));
  const verticalSpeedMps = Number.isFinite(input.verticalSpeedMps) ? input.verticalSpeedMps : 0;
  const ungroundedGraceS = Math.max(0, finiteNonNegative(config.ungroundedGraceS ?? NaN, FALLBACK_UNGROUNDED_GRACE_S));
  const landingContactLatchS = Math.max(
    0,
    finiteNonNegative(config.landingContactLatchS ?? NaN, FALLBACK_LANDING_CONTACT_LATCH_S),
  );
  // Continuous contact bookkeeping. Older serialized states may omit these
  // fields; treat them as "grounded right now" so the grace restarts cleanly.
  const previousLastGroundedAtS = Number.isFinite(previous.lastGroundedAtS) ? previous.lastGroundedAtS : timestampS;
  const previousContactAtS = Number.isFinite(previous.groundedContactAtS) ? previous.groundedContactAtS : -1;
  const lastGroundedAtS = input.grounded ? timestampS : previousLastGroundedAtS;
  const groundedContactAtS = input.grounded ? (previousContactAtS >= 0 ? previousContactAtS : timestampS) : -1;
  // A short single-frame contact loss on step-downs and slope seams must not
  // flash the airborne clip. Motor-confirmed jumps always bypass the grace.
  const ungroundedBeyondGrace = !input.grounded && timestampS - previousLastGroundedAtS >= ungroundedGraceS;
  const sustainedGroundContact = groundedContactAtS >= 0 && timestampS - groundedContactAtS >= landingContactLatchS;

  // PlayerController publishes only a motor-confirmed jump edge. When that
  // impulse arrives during the landing latch, the physical actor has already
  // left the floor: restart the one-shot immediately instead of carrying a
  // stale buffered request into the *next* landing.
  const acceptedJump = input.jumpRequested && verticalSpeedMps > config.landingVerticalSpeedMaxMps;
  if (acceptedJump) {
    mode = "jump";
    jumpPhase = "takeoff";
    jumpQueued = false;
    transitionDurationS = transitionDuration(previousMode, mode, config);
    modeEnteredFrame = frame;
    modeEnteredAtS = timestampS;
    phaseEnteredFrame = frame;
    phaseEnteredAtS = timestampS;
    clipStartedFrame = frame;
    clipStartedAtS = timestampS;
  } else if (mode !== "jump") {
    if (input.jumpRequested || ungroundedBeyondGrace) {
      mode = "jump";
      jumpPhase = input.jumpRequested && (input.grounded || verticalSpeedMps > 0) ? "takeoff" : "airborne";
      jumpQueued = false;
      transitionDurationS = transitionDuration(previousMode, mode, config);
      modeEnteredFrame = frame;
      modeEnteredAtS = timestampS;
      phaseEnteredFrame = frame;
      phaseEnteredAtS = timestampS;
      clipStartedFrame = frame;
      clipStartedAtS = timestampS;
    } else if (timestampS - modeEnteredAtS >= Math.max(0, config.minGroundedStateHoldS)) {
      const desiredMode = chooseGroundMode(groundMode, speedMps, walkSpeedMps, runSpeedMps, config);
      if (desiredMode !== mode) {
        transitionDurationS = transitionDuration(mode, desiredMode, config);
        mode = desiredMode;
        groundMode = desiredMode;
        modeEnteredFrame = frame;
        modeEnteredAtS = timestampS;
        phaseEnteredFrame = frame;
        phaseEnteredAtS = timestampS;
        clipStartedFrame = frame;
        clipStartedAtS = timestampS;
      }
    }
  } else if (jumpPhase === "takeoff") {
    const phaseElapsedS = timestampS - phaseEnteredAtS;
    if (!input.grounded && phaseElapsedS >= Math.max(0, config.takeoffLockS)) {
      jumpPhase = "airborne";
      phaseEnteredFrame = frame;
      phaseEnteredAtS = timestampS;
    } else if (
      input.grounded &&
      (verticalSpeedMps <= config.landingVerticalSpeedMaxMps || sustainedGroundContact) &&
      phaseElapsedS >= Math.max(config.takeoffLockS, config.takeoffTimeoutS)
    ) {
      jumpPhase = "landing";
      phaseEnteredFrame = frame;
      phaseEnteredAtS = timestampS;
    }
  } else if (jumpPhase === "airborne") {
    if (input.jumpRequested) jumpQueued = true;
    if (
      input.grounded &&
      (verticalSpeedMps <= config.landingVerticalSpeedMaxMps || sustainedGroundContact) &&
      timestampS - phaseEnteredAtS >= Math.max(0, config.minAirborneS)
    ) {
      jumpPhase = "landing";
      phaseEnteredFrame = frame;
      phaseEnteredAtS = timestampS;
    }
  } else {
    if (input.jumpRequested) jumpQueued = true;
    if (timestampS - phaseEnteredAtS >= Math.max(0, config.landingLockS)) {
      if (ungroundedBeyondGrace) {
        jumpPhase = "airborne";
        phaseEnteredFrame = frame;
        phaseEnteredAtS = timestampS;
      } else if (jumpQueued) {
        jumpPhase = "takeoff";
        jumpQueued = false;
        phaseEnteredFrame = frame;
        phaseEnteredAtS = timestampS;
        clipStartedFrame = frame;
        clipStartedAtS = timestampS;
      } else {
        const desiredMode = chooseGroundMode(groundMode, speedMps, walkSpeedMps, runSpeedMps, config);
        transitionDurationS = transitionDuration(mode, desiredMode, config);
        mode = desiredMode;
        groundMode = desiredMode;
        jumpPhase = "none";
        modeEnteredFrame = frame;
        modeEnteredAtS = timestampS;
        phaseEnteredFrame = frame;
        phaseEnteredAtS = timestampS;
        clipStartedFrame = frame;
        clipStartedAtS = timestampS;
      }
    }
  }

  output.mode = mode;
  output.groundMode = groundMode;
  output.jumpPhase = jumpPhase;
  output.jumpQueued = jumpQueued;
  writeModeOutput(output, mode);
  output.transitionDurationS = Math.max(0, transitionDurationS);
  output.normalizedSpeed = clamp01(speedMps / runSpeedMps);
  output.modeEnteredFrame = modeEnteredFrame;
  output.modeEnteredAtS = modeEnteredAtS;
  output.phaseEnteredFrame = phaseEnteredFrame;
  output.phaseEnteredAtS = phaseEnteredAtS;
  output.clipStartedFrame = clipStartedFrame;
  output.clipStartedAtS = clipStartedAtS;
  output.lastGroundedAtS = lastGroundedAtS;
  output.groundedContactAtS = groundedContactAtS;
  output.lastFrame = frame;
  output.lastTimestampS = timestampS;
  return output;
}
