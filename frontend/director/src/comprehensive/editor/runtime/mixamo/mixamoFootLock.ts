/**
 * Foot-lock state machine for Mixamo locomotion: watches each foot's height
 * and velocity against hysteresis thresholds to decide contact vs swing, and
 * while planted pins the foot in world space by emitting an IK target (fed
 * into the two-bone IK layer) with a clamped, smoothed correction. Pure
 * per-frame math over plain vectors — no three.js types — so it is fully
 * unit-testable against the recorded X Bot gait matrix.
 */
import type { DirectorCharacterIkTarget } from "../../schema/directorProject";

export type MixamoFootLockVector = [number, number, number];

export interface MixamoFootLockConfig {
  contactHeightM: number;
  releaseHeightM: number;
  contactVerticalSpeedMps: number;
  releaseVerticalSpeedMps: number;
  contactHorizontalSpeedMps: number;
  releaseHorizontalSpeedMps: number;
  contactDelayS: number;
  releaseDelayS: number;
  maxCorrectionM: number;
  correctionSmoothingHz: number;
  weightSmoothingHz: number;
  maxFrameDeltaS: number;
}

export const DEFAULT_MIXAMO_FOOT_LOCK_CONFIG: Readonly<MixamoFootLockConfig> = Object.freeze({
  // Prepared 1.78 m X Bot foot bones sit around 0.086 m above the mesh ground
  // plane. Leave room for gait/toe variation without treating the 0.22 m
  // swing phase as planted.
  contactHeightM: 0.14,
  releaseHeightM: 0.22,
  // Packaged Mixamo clips are authored at 30 fps. At 60 fps resampling their
  // contact window is often only one reliable low-velocity sample, especially
  // for runs and strafes. These values are calibrated against the real X Bot
  // gait matrix; release hysteresis and the correction clamp remain stricter.
  contactVerticalSpeedMps: 0.35,
  releaseVerticalSpeedMps: 0.55,
  contactHorizontalSpeedMps: 0.7,
  releaseHorizontalSpeedMps: 0.85,
  contactDelayS: 0.016,
  releaseDelayS: 0.04,
  maxCorrectionM: 0.18,
  correctionSmoothingHz: 22,
  weightSmoothingHz: 18,
  maxFrameDeltaS: 0.1,
});

export interface MixamoFootLockSample {
  /** Missing/unresolved foot chains release independently. */
  enabled?: boolean;
  /** Foot-bone position after animation and before procedural foot IK. */
  positionWorld: readonly [number, number, number];
  /** Raycast or prepared stage-ground height under this foot. */
  groundHeightWorld: number;
}

export interface MixamoFootLockFrameInput {
  deltaS: number;
  /** Physical motor contact, independent from the animation clip. */
  grounded: boolean;
  /** `jump` and `fly` release both feet even on the launch/contact frame. */
  locomotionMode?: string | null;
  /** Clip/graph-state identity used to reject one-frame velocity spikes on transitions. */
  actionKey?: string | null;
  leftFoot: MixamoFootLockSample;
  rightFoot: MixamoFootLockSample;
}

export interface MixamoFootLockEffectorOutput {
  /** World-space goal. Convert it to Director character-local space before applying IK. */
  targetWorld: MixamoFootLockVector;
  weight: number;
  locked: boolean;
  horizontalVelocityMps: number;
  verticalVelocityMps: number;
}

export interface MixamoFootLockFootState {
  locked: boolean;
  hasPreviousSample: boolean;
  contactTimeS: number;
  releaseTimeS: number;
  lockPositionWorld: MixamoFootLockVector;
  previousPositionWorld: MixamoFootLockVector;
  correctionWorld: MixamoFootLockVector;
  output: MixamoFootLockEffectorOutput;
}

export interface MixamoFootLockOutput {
  leftFoot: MixamoFootLockEffectorOutput;
  rightFoot: MixamoFootLockEffectorOutput;
}

export interface MixamoFootLockState {
  leftFoot: MixamoFootLockFootState;
  rightFoot: MixamoFootLockFootState;
  actionKey: string | null;
  hasActionKey: boolean;
  output: MixamoFootLockOutput;
}

function createFootState(): MixamoFootLockFootState {
  const output: MixamoFootLockEffectorOutput = {
    targetWorld: [0, 0, 0],
    weight: 0,
    locked: false,
    horizontalVelocityMps: 0,
    verticalVelocityMps: 0,
  };
  return {
    locked: false,
    hasPreviousSample: false,
    contactTimeS: 0,
    releaseTimeS: 0,
    lockPositionWorld: [0, 0, 0],
    previousPositionWorld: [0, 0, 0],
    correctionWorld: [0, 0, 0],
    output,
  };
}

/** Allocate the small, reusable state once per character; stepping is allocation-free. */
export function createMixamoFootLockState(): MixamoFootLockState {
  const leftFoot = createFootState();
  const rightFoot = createFootState();
  return {
    leftFoot,
    rightFoot,
    actionKey: null,
    hasActionKey: false,
    output: { leftFoot: leftFoot.output, rightFoot: rightFoot.output },
  };
}

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function positive(value: number, fallback: number) {
  const resolved = finite(value, fallback);
  return resolved > 0 ? resolved : fallback;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function smoothingAlpha(rateHz: number, deltaS: number) {
  return deltaS <= 0 ? 0 : 1 - Math.exp(-positive(rateHz, 1) * deltaS);
}

function setVector(target: MixamoFootLockVector, x: number, y: number, z: number) {
  target[0] = x;
  target[1] = y;
  target[2] = z;
}

function forceRelease(foot: MixamoFootLockFootState, sampleX: number, sampleY: number, sampleZ: number) {
  foot.locked = false;
  foot.contactTimeS = 0;
  foot.releaseTimeS = 0;
  setVector(foot.correctionWorld, 0, 0, 0);
  setVector(foot.output.targetWorld, sampleX, sampleY, sampleZ);
  foot.output.weight = 0;
  foot.output.locked = false;
}

function stepFoot(
  foot: MixamoFootLockFootState,
  sample: MixamoFootLockSample,
  deltaS: number,
  actionChanged: boolean,
  releaseImmediately: boolean,
  config: Readonly<MixamoFootLockConfig>,
) {
  const fallbackX = foot.hasPreviousSample ? foot.previousPositionWorld[0] : 0;
  const fallbackY = foot.hasPreviousSample ? foot.previousPositionWorld[1] : 0;
  const fallbackZ = foot.hasPreviousSample ? foot.previousPositionWorld[2] : 0;
  const sampleX = finite(sample.positionWorld[0], fallbackX);
  const sampleY = finite(sample.positionWorld[1], fallbackY);
  const sampleZ = finite(sample.positionWorld[2], fallbackZ);
  const groundHeight = finite(sample.groundHeightWorld, sampleY);

  let horizontalVelocityMps = 0;
  let verticalVelocityMps = 0;
  if (foot.hasPreviousSample && !actionChanged && deltaS > 0) {
    const deltaX = sampleX - foot.previousPositionWorld[0];
    const deltaY = sampleY - foot.previousPositionWorld[1];
    const deltaZ = sampleZ - foot.previousPositionWorld[2];
    horizontalVelocityMps = Math.hypot(deltaX, deltaZ) / deltaS;
    verticalVelocityMps = deltaY / deltaS;
  }
  setVector(foot.previousPositionWorld, sampleX, sampleY, sampleZ);
  foot.hasPreviousSample = true;
  foot.output.horizontalVelocityMps = horizontalVelocityMps;
  foot.output.verticalVelocityMps = verticalVelocityMps;

  if (actionChanged) {
    foot.contactTimeS = 0;
    foot.releaseTimeS = 0;
  }
  if (releaseImmediately) {
    forceRelease(foot, sampleX, sampleY, sampleZ);
    return;
  }

  const contactHeight = Math.max(0, finite(config.contactHeightM, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHeightM));
  const releaseHeight = Math.max(
    contactHeight,
    finite(config.releaseHeightM, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseHeightM),
  );
  const contactVerticalSpeed = positive(
    config.contactVerticalSpeedMps,
    DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactVerticalSpeedMps,
  );
  const releaseVerticalSpeed = Math.max(
    contactVerticalSpeed,
    positive(config.releaseVerticalSpeedMps, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseVerticalSpeedMps),
  );
  const contactHorizontalSpeed = positive(
    config.contactHorizontalSpeedMps,
    DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHorizontalSpeedMps,
  );
  const releaseHorizontalSpeed = Math.max(
    contactHorizontalSpeed,
    positive(config.releaseHorizontalSpeedMps, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseHorizontalSpeedMps),
  );
  const heightAboveGround = sampleY - groundHeight;
  const absoluteVerticalSpeed = Math.abs(verticalVelocityMps);
  const canAcquire =
    heightAboveGround <= contactHeight &&
    absoluteVerticalSpeed <= contactVerticalSpeed &&
    horizontalVelocityMps <= contactHorizontalSpeed;

  const maxCorrection = positive(config.maxCorrectionM, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.maxCorrectionM);
  const lockDeltaX = foot.lockPositionWorld[0] - sampleX;
  const lockDeltaY = foot.lockPositionWorld[1] - sampleY;
  const lockDeltaZ = foot.lockPositionWorld[2] - sampleZ;
  const lockDistance = Math.hypot(lockDeltaX, lockDeltaY, lockDeltaZ);
  const shouldRelease =
    !actionChanged &&
    (heightAboveGround > releaseHeight ||
      absoluteVerticalSpeed > releaseVerticalSpeed ||
      horizontalVelocityMps > releaseHorizontalSpeed ||
      (foot.locked && lockDistance > maxCorrection));

  if (foot.locked) {
    foot.contactTimeS = 0;
    foot.releaseTimeS = shouldRelease ? foot.releaseTimeS + deltaS : 0;
    const releaseDelay = Math.max(0, finite(config.releaseDelayS, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseDelayS));
    if (shouldRelease && foot.releaseTimeS >= releaseDelay) {
      foot.locked = false;
      foot.releaseTimeS = 0;
    }
  } else {
    foot.releaseTimeS = 0;
    foot.contactTimeS = canAcquire ? foot.contactTimeS + deltaS : 0;
    const contactDelay = Math.max(0, finite(config.contactDelayS, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactDelayS));
    if (canAcquire && foot.contactTimeS >= contactDelay) {
      foot.locked = true;
      foot.contactTimeS = 0;
      setVector(foot.lockPositionWorld, sampleX, Math.max(sampleY, groundHeight), sampleZ);
    }
  }

  let desiredCorrectionX = 0;
  let desiredCorrectionY = 0;
  let desiredCorrectionZ = 0;
  if (foot.locked) {
    desiredCorrectionX = foot.lockPositionWorld[0] - sampleX;
    desiredCorrectionY = foot.lockPositionWorld[1] - sampleY;
    desiredCorrectionZ = foot.lockPositionWorld[2] - sampleZ;
    const correctionLength = Math.hypot(desiredCorrectionX, desiredCorrectionY, desiredCorrectionZ);
    if (correctionLength > maxCorrection) {
      const scale = maxCorrection / correctionLength;
      desiredCorrectionX *= scale;
      desiredCorrectionY *= scale;
      desiredCorrectionZ *= scale;
    }
  }

  const correctionAlpha = smoothingAlpha(config.correctionSmoothingHz, deltaS);
  foot.correctionWorld[0] += (desiredCorrectionX - foot.correctionWorld[0]) * correctionAlpha;
  foot.correctionWorld[1] += (desiredCorrectionY - foot.correctionWorld[1]) * correctionAlpha;
  foot.correctionWorld[2] += (desiredCorrectionZ - foot.correctionWorld[2]) * correctionAlpha;
  setVector(
    foot.output.targetWorld,
    sampleX + foot.correctionWorld[0],
    sampleY + foot.correctionWorld[1],
    sampleZ + foot.correctionWorld[2],
  );

  const weightAlpha = smoothingAlpha(config.weightSmoothingHz, deltaS);
  foot.output.weight = clamp01(foot.output.weight + ((foot.locked ? 1 : 0) - foot.output.weight) * weightAlpha);
  foot.output.locked = foot.locked;
}

/**
 * Advance both independent foot locks in place. The returned object and target
 * tuples are stable references suitable for a render loop or physics tick.
 */
export function stepMixamoFootLock(
  state: MixamoFootLockState,
  input: MixamoFootLockFrameInput,
  config: Readonly<MixamoFootLockConfig> = DEFAULT_MIXAMO_FOOT_LOCK_CONFIG,
): MixamoFootLockOutput {
  const maxDelta = positive(config.maxFrameDeltaS, DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.maxFrameDeltaS);
  const deltaS = Math.min(maxDelta, Math.max(0, finite(input.deltaS, 0)));
  const actionKey = input.actionKey ?? null;
  const actionChanged = state.hasActionKey && actionKey !== state.actionKey;
  state.actionKey = actionKey;
  state.hasActionKey = true;

  // Emote clips (waves, claps, sitting) author their own foot placement;
  // projecting those feet onto gait ground contacts fights the performance.
  const releaseImmediately =
    !input.grounded ||
    input.locomotionMode === "jump" ||
    input.locomotionMode === "fly" ||
    input.locomotionMode === "emote";
  stepFoot(
    state.leftFoot,
    input.leftFoot,
    deltaS,
    actionChanged,
    releaseImmediately || input.leftFoot.enabled === false,
    config,
  );
  stepFoot(
    state.rightFoot,
    input.rightFoot,
    deltaS,
    actionChanged,
    releaseImmediately || input.rightFoot.enabled === false,
    config,
  );
  return state.output;
}

/**
 * Write one world-space foot-lock result into a reusable Director IK target.
 * `worldToDirectorLocal` uses Three.js' column-major Matrix4 element order.
 * Pole and reach settings are intentionally preserved.
 */
export function writeMixamoFootLockOutputToIkTarget(
  output: MixamoFootLockEffectorOutput,
  worldToDirectorLocal: ArrayLike<number>,
  target: DirectorCharacterIkTarget,
) {
  const x = output.targetWorld[0];
  const y = output.targetWorld[1];
  const z = output.targetWorld[2];
  const w =
    finite(worldToDirectorLocal[3] ?? 0, 0) * x +
    finite(worldToDirectorLocal[7] ?? 0, 0) * y +
    finite(worldToDirectorLocal[11] ?? 0, 0) * z +
    finite(worldToDirectorLocal[15] ?? 1, 1);
  const inverseW = Math.abs(w) > 1e-9 ? 1 / w : 1;
  target.target[0] =
    (finite(worldToDirectorLocal[0] ?? 1, 1) * x +
      finite(worldToDirectorLocal[4] ?? 0, 0) * y +
      finite(worldToDirectorLocal[8] ?? 0, 0) * z +
      finite(worldToDirectorLocal[12] ?? 0, 0)) *
    inverseW;
  target.target[1] =
    (finite(worldToDirectorLocal[1] ?? 0, 0) * x +
      finite(worldToDirectorLocal[5] ?? 1, 1) * y +
      finite(worldToDirectorLocal[9] ?? 0, 0) * z +
      finite(worldToDirectorLocal[13] ?? 0, 0)) *
    inverseW;
  target.target[2] =
    (finite(worldToDirectorLocal[2] ?? 0, 0) * x +
      finite(worldToDirectorLocal[6] ?? 0, 0) * y +
      finite(worldToDirectorLocal[10] ?? 1, 1) * z +
      finite(worldToDirectorLocal[14] ?? 0, 0)) *
    inverseW;
  target.weight = clamp01(output.weight);
  return target;
}
