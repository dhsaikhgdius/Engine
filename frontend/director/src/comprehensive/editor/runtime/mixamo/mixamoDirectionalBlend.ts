/**
 * Directional locomotion blending: maps a character's movement direction
 * relative to its facing into normalized forward/backward/left/right clip
 * weights (a 1D blend on the strafe circle), degrading gracefully when a
 * directional clip is missing by folding its weight into available
 * neighbors. Pure math shared by the play-mode runtime and timeline
 * playback so both pick identical clip mixes.
 */
import type {
  DirectorCharacterLocomotionMode,
  DirectorCharacterLocomotionRuntimeState,
} from "./mixamoLocomotionRuntime";

export const DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS = ["forward", "backward", "left", "right"] as const;

export type DirectorDirectionalBlendDirection = (typeof DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS)[number];

export type DirectorDirectionalBlendWeights = Record<DirectorDirectionalBlendDirection, number>;

export type DirectorDirectionalClipAvailability = Partial<Record<DirectorDirectionalBlendDirection, boolean>>;

export const DIRECTOR_DIRECTIONAL_LOCOMOTION_CLIP_IDS = {
  walk: {
    forward: "walk",
    backward: "walk-back",
    left: "walk-left",
    right: "walk-right",
  },
  run: {
    forward: "run",
    backward: "run-back",
    left: "run-left",
    right: "run-right",
  },
} as const;

export type DirectorDirectionalLocomotionGait = keyof typeof DIRECTOR_DIRECTIONAL_LOCOMOTION_CLIP_IDS;

export function getDirectorDirectionalLocomotionClipId(
  gait: DirectorDirectionalLocomotionGait,
  direction: DirectorDirectionalBlendDirection,
) {
  return DIRECTOR_DIRECTIONAL_LOCOMOTION_CLIP_IDS[gait][direction];
}

export function getDirectorDirectionalClipAvailability(
  gait: DirectorDirectionalLocomotionGait,
  hasClip: (clipId: string) => boolean,
): DirectorDirectionalClipAvailability {
  return Object.fromEntries(
    DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) => [
      direction,
      hasClip(getDirectorDirectionalLocomotionClipId(gait, direction)),
    ]),
  );
}

export interface DirectorDirectionalBlendState {
  /** Normalized semantic movement direction, independent of available clips. */
  intentWeights: DirectorDirectionalBlendWeights;
  /** Normalized weights remapped onto the clips that are actually available. */
  weights: DirectorDirectionalBlendWeights;
  /** Separate locomotion contribution; direction weights stay normalized while this fades. */
  activity: number;
  playbackRate: number;
  /** Additive body lean in degrees. Positive values lean into a positive yaw turn. */
  turnLeanDeg: number;
}

export interface DirectorDirectionalBlendFallback {
  mode: "native" | "remapped" | "unavailable";
  availableDirections: DirectorDirectionalBlendDirection[];
  missingIntentDirections: DirectorDirectionalBlendDirection[];
  resolvedDirectionByIntent: Record<DirectorDirectionalBlendDirection, DirectorDirectionalBlendDirection | null>;
}

export interface DirectorDirectionalBlendResult extends DirectorDirectionalBlendState {
  speedMps: number;
  target: DirectorDirectionalBlendState;
  fallback: DirectorDirectionalBlendFallback;
}

export interface SampleDirectorDirectionalBlendInput {
  /** Actor-local +X is right and +Z is forward. */
  localVelocityX: number;
  localVelocityZ: number;
  /** Signed actor yaw velocity in radians per second. */
  angularVelocityRadS: number;
  locomotion: Pick<DirectorCharacterLocomotionRuntimeState, "mode" | "playbackRate" | "weight">;
  previous?: DirectorDirectionalBlendState;
  deltaS?: number;
  clipAvailability?: DirectorDirectionalClipAvailability;
  deadzoneMps?: number;
  smoothingRate?: number;
  maxTurnRateRadS?: number;
  maxTurnLeanDeg?: number;
}

const ZERO_WEIGHTS: DirectorDirectionalBlendWeights = {
  forward: 0,
  backward: 0,
  left: 0,
  right: 0,
};

const DIRECTION_VECTORS: Record<DirectorDirectionalBlendDirection, readonly [number, number]> = {
  forward: [0, 1],
  backward: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};

const GAIT_MODES = new Set<DirectorCharacterLocomotionMode>(["walk", "run"]);
const DEFAULT_DEADZONE_MPS = 0.08;
const DEFAULT_SMOOTHING_RATE = 14;
const DEFAULT_MAX_TURN_RATE_RAD_S = Math.PI;
const DEFAULT_MAX_TURN_LEAN_DEG = 10;
const WEIGHT_EPSILON = 1e-7;
// Below this contribution the pose difference is visually irrelevant, while
// retaining the value would keep an otherwise inactive AnimationAction in the
// per-frame mixer forever after a direction change.
const ACTION_WEIGHT_PRUNE_EPSILON = 1e-5;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function copyWeights(weights: Readonly<DirectorDirectionalBlendWeights>): DirectorDirectionalBlendWeights {
  return {
    forward: weights.forward,
    backward: weights.backward,
    left: weights.left,
    right: weights.right,
  };
}

function normalizeWeights(weights: Readonly<DirectorDirectionalBlendWeights>) {
  const sanitized = DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) => {
    const weight = Math.max(0, finite(weights[direction]));
    return weight < ACTION_WEIGHT_PRUNE_EPSILON ? 0 : weight;
  });
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= WEIGHT_EPSILON) return copyWeights(ZERO_WEIGHTS);
  return Object.fromEntries(
    DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction, index) => [direction, sanitized[index] / total]),
  ) as DirectorDirectionalBlendWeights;
}

function getIntentWeights(localVelocityX: number, localVelocityZ: number, active: boolean) {
  if (!active) return copyWeights(ZERO_WEIGHTS);
  const speed = Math.hypot(localVelocityX, localVelocityZ);
  if (speed <= WEIGHT_EPSILON) return copyWeights(ZERO_WEIGHTS);
  const x = localVelocityX / speed;
  const z = localVelocityZ / speed;
  return normalizeWeights({
    forward: Math.max(0, z),
    backward: Math.max(0, -z),
    left: Math.max(0, -x),
    right: Math.max(0, x),
  });
}

function getAvailableDirections(availability: DirectorDirectionalClipAvailability | undefined) {
  // Legacy or third-party catalogs may still expose only the original forward
  // clip. Runtime bindings pass their measured availability explicitly; this
  // conservative default keeps older Agent/runtime callers deterministic.
  const resolved = availability ?? { forward: true };
  return DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.filter((direction) => resolved[direction] === true);
}

function getNearestAvailableDirection(
  direction: DirectorDirectionalBlendDirection,
  availableDirections: readonly DirectorDirectionalBlendDirection[],
) {
  const source = DIRECTION_VECTORS[direction];
  let best: DirectorDirectionalBlendDirection | null = null;
  let bestDot = Number.NEGATIVE_INFINITY;
  availableDirections.forEach((candidate) => {
    const target = DIRECTION_VECTORS[candidate];
    const dot = source[0] * target[0] + source[1] * target[1];
    if (dot > bestDot) {
      best = candidate;
      bestDot = dot;
    }
  });
  return best;
}

function resolveClipWeights(
  intentWeights: Readonly<DirectorDirectionalBlendWeights>,
  availability: DirectorDirectionalClipAvailability | undefined,
) {
  const availableDirections = getAvailableDirections(availability);
  const resolvedDirectionByIntent = Object.fromEntries(
    DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) => [
      direction,
      availableDirections.includes(direction)
        ? direction
        : getNearestAvailableDirection(direction, availableDirections),
    ]),
  ) as DirectorDirectionalBlendFallback["resolvedDirectionByIntent"];
  const weights = copyWeights(ZERO_WEIGHTS);
  const missingIntentDirections: DirectorDirectionalBlendDirection[] = [];

  DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.forEach((direction) => {
    const weight = intentWeights[direction];
    if (weight <= WEIGHT_EPSILON) return;
    const resolvedDirection = resolvedDirectionByIntent[direction];
    if (!availableDirections.includes(direction)) missingIntentDirections.push(direction);
    if (resolvedDirection) weights[resolvedDirection] += weight;
  });

  const normalized = normalizeWeights(weights);
  const hasIntent = DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.some(
    (direction) => intentWeights[direction] > WEIGHT_EPSILON,
  );
  const fallbackMode: DirectorDirectionalBlendFallback["mode"] =
    availableDirections.length === 0 && hasIntent
      ? "unavailable"
      : missingIntentDirections.length > 0
        ? "remapped"
        : "native";

  return {
    weights: normalized,
    fallback: {
      mode: fallbackMode,
      availableDirections,
      missingIntentDirections,
      resolvedDirectionByIntent,
    } satisfies DirectorDirectionalBlendFallback,
  };
}

function smoothingAlpha(rate: number, deltaS: number) {
  const safeRate = clampFinite(rate, 0, 120, DEFAULT_SMOOTHING_RATE);
  const safeDelta = clampFinite(deltaS, 0, 0.1, 0);
  return 1 - Math.exp(-safeRate * safeDelta);
}

function interpolate(left: number, right: number, alpha: number) {
  return left + (right - left) * alpha;
}

function sanitizePrevious(previous: DirectorDirectionalBlendState): DirectorDirectionalBlendState {
  return {
    intentWeights: normalizeWeights(previous.intentWeights),
    weights: normalizeWeights(previous.weights),
    activity: clampFinite(previous.activity, 0, 1, 0),
    playbackRate: clampFinite(previous.playbackRate, 0.1, 4, 1),
    turnLeanDeg: clampFinite(previous.turnLeanDeg, -90, 90, 0),
  };
}

/**
 * Pure four-way locomotion Blend Space sampler. It never reads scene state or
 * assets and can therefore be shared by browser playback, deterministic
 * capture, tests, and future Agent planning.
 */
export function sampleDirectorDirectionalBlend(
  input: SampleDirectorDirectionalBlendInput,
): DirectorDirectionalBlendResult {
  const localVelocityX = finite(input.localVelocityX);
  const localVelocityZ = finite(input.localVelocityZ);
  const speedMps = Math.hypot(localVelocityX, localVelocityZ);
  const deadzoneMps = clampFinite(input.deadzoneMps ?? DEFAULT_DEADZONE_MPS, 0, 10, DEFAULT_DEADZONE_MPS);
  const gaitActive = GAIT_MODES.has(input.locomotion.mode) && speedMps > deadzoneMps;
  const intentWeights = getIntentWeights(localVelocityX, localVelocityZ, gaitActive);
  const resolved = resolveClipWeights(intentWeights, input.clipAvailability);
  const locomotionWeight = clampFinite(input.locomotion.weight, 0, 1, 1);
  const targetActivity = gaitActive && resolved.fallback.mode !== "unavailable" ? locomotionWeight : 0;
  const targetPlaybackRate = gaitActive ? clampFinite(input.locomotion.playbackRate, 0.1, 4, 1) : 1;
  const maxTurnRate = clampFinite(
    input.maxTurnRateRadS ?? DEFAULT_MAX_TURN_RATE_RAD_S,
    0.0001,
    Math.PI * 8,
    DEFAULT_MAX_TURN_RATE_RAD_S,
  );
  const maxTurnLeanDeg = clampFinite(
    input.maxTurnLeanDeg ?? DEFAULT_MAX_TURN_LEAN_DEG,
    0,
    45,
    DEFAULT_MAX_TURN_LEAN_DEG,
  );
  const targetTurnLeanDeg = gaitActive
    ? clampFinite(input.angularVelocityRadS / maxTurnRate, -1, 1, 0) * maxTurnLeanDeg
    : 0;
  const target: DirectorDirectionalBlendState = {
    intentWeights,
    weights: resolved.weights,
    activity: targetActivity,
    playbackRate: targetPlaybackRate,
    turnLeanDeg: targetTurnLeanDeg,
  };

  if (!input.previous) {
    return { ...target, speedMps, target, fallback: resolved.fallback };
  }

  const previous = sanitizePrevious(input.previous);
  const alpha = smoothingAlpha(input.smoothingRate ?? DEFAULT_SMOOTHING_RATE, input.deltaS ?? 0);
  const smoothedIntentWeights = normalizeWeights(
    Object.fromEntries(
      DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) => [
        direction,
        interpolate(previous.intentWeights[direction], target.intentWeights[direction], alpha),
      ]),
    ) as DirectorDirectionalBlendWeights,
  );
  const smoothedWeights = normalizeWeights(
    Object.fromEntries(
      DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) => [
        direction,
        interpolate(previous.weights[direction], target.weights[direction], alpha),
      ]),
    ) as DirectorDirectionalBlendWeights,
  );

  return {
    intentWeights: smoothedIntentWeights,
    weights: smoothedWeights,
    activity: clampFinite(interpolate(previous.activity, target.activity, alpha), 0, 1, target.activity),
    playbackRate: clampFinite(
      interpolate(previous.playbackRate, target.playbackRate, alpha),
      0.1,
      4,
      target.playbackRate,
    ),
    turnLeanDeg: clampFinite(
      interpolate(previous.turnLeanDeg, target.turnLeanDeg, alpha),
      -maxTurnLeanDeg,
      maxTurnLeanDeg,
      target.turnLeanDeg,
    ),
    speedMps,
    target,
    fallback: resolved.fallback,
  };
}
