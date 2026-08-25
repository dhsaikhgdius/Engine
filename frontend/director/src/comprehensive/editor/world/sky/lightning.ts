import type { DirectorWorldWeather } from "../../schema/directorProject";
import { worldRandom01, worldStreamId } from "../worldRandom";

/**
 * Deterministic storm lightning.
 *
 * Time is split into fixed strike windows; each window rolls
 * `worldRandom01(seed, stream, windowIndex)` against a probability that
 * scales with the storm intensity. An active window flashes for 0.1–0.25 s
 * (also hash-derived) with a sharp attack and quadratic decay. Identical
 * `(seed, worldSeconds, weather)` always produce the identical flash, so
 * timeline scrubbing and deterministic export replay the same storm.
 *
 * The visible bolt is a separate pure function of `(seed, strikeWindowIndex)`
 * — adding or restyling the bolt can never move a strike moment.
 */

export const LIGHTNING_WINDOW_SECONDS = 0.25;
export const LIGHTNING_MIN_FLASH_SECONDS = 0.1;
export const LIGHTNING_MAX_FLASH_SECONDS = 0.25;

const LIGHTNING_STREAM = worldStreamId("sky-lightning");
const ROLL_STREAM = 0;
const DURATION_STREAM = 1;
const STRENGTH_STREAM = 2;

/**
 * Strike probability per 0.25 s window at storm intensity 0 → 1. The window
 * roll keeps its original stream layout and the full-intensity rate matches
 * the historical 0.16, so violent storms replay their established strikes;
 * fainter storms now flash markedly less often.
 */
export const LIGHTNING_STRIKE_PROBABILITY_MIN = 0.008;
export const LIGHTNING_STRIKE_PROBABILITY_MAX = 0.16;

export interface WorldLightningState {
  active: boolean;
  /** 0 when inactive; approaches 1 for an intense storm's brightest strikes. */
  intensity: number;
  /** Strike window index of the active flash; absent while inactive. */
  strikeWindowIndex?: number;
}

const INACTIVE_LIGHTNING: WorldLightningState = { active: false, intensity: 0 };

export function evaluateLightningState(
  seed: number,
  worldSeconds: number,
  weather: DirectorWorldWeather,
): WorldLightningState {
  if (weather.preset !== "storm" || weather.intensity <= 0 || !Number.isFinite(worldSeconds)) {
    return INACTIVE_LIGHTNING;
  }

  const stormIntensity = Math.min(weather.intensity, 1);
  const windowIndex = Math.floor(worldSeconds / LIGHTNING_WINDOW_SECONDS);
  const strikeProbability =
    LIGHTNING_STRIKE_PROBABILITY_MIN +
    (LIGHTNING_STRIKE_PROBABILITY_MAX - LIGHTNING_STRIKE_PROBABILITY_MIN) * stormIntensity;
  if (worldRandom01(seed, LIGHTNING_STREAM, windowIndex, ROLL_STREAM) >= strikeProbability) {
    return INACTIVE_LIGHTNING;
  }

  const flashSeconds =
    LIGHTNING_MIN_FLASH_SECONDS +
    (LIGHTNING_MAX_FLASH_SECONDS - LIGHTNING_MIN_FLASH_SECONDS) *
      worldRandom01(seed, LIGHTNING_STREAM, windowIndex, DURATION_STREAM);
  const secondsIntoWindow = worldSeconds - windowIndex * LIGHTNING_WINDOW_SECONDS;
  if (secondsIntoWindow >= flashSeconds) return INACTIVE_LIGHTNING;

  const decay = 1 - secondsIntoWindow / flashSeconds;
  const strikeStrength = 0.55 + 0.45 * worldRandom01(seed, LIGHTNING_STREAM, windowIndex, STRENGTH_STREAM);
  return {
    active: true,
    // Brightness follows the storm: a faint storm's strikes stay dim.
    intensity: decay * decay * strikeStrength * (0.25 + 0.75 * stormIntensity),
    strikeWindowIndex: windowIndex,
  };
}

/** Number of jointed segments in the main lightning channel. */
export const LIGHTNING_BOLT_SEGMENTS = 12;
/** Points in the polyline: segments + 1. */
export const LIGHTNING_BOLT_POINT_COUNT = LIGHTNING_BOLT_SEGMENTS + 1;

/** Bolt anchor distance band, inside the cloud shell (800–1500 m). */
export const LIGHTNING_BOLT_MIN_DISTANCE = 900;
export const LIGHTNING_BOLT_MAX_DISTANCE = 1300;
/** Channel top height band, just below the cloud deck. */
export const LIGHTNING_BOLT_MIN_TOP_HEIGHT = 480;
export const LIGHTNING_BOLT_MAX_TOP_HEIGHT = 740;
/** Maximum lateral jag of a joint from the leaning channel axis, metres. */
export const LIGHTNING_BOLT_MAX_JITTER = 60;
/** Ground strike point offset from the cloud anchor, as a fraction of top height. */
export const LIGHTNING_BOLT_MIN_LEAN_RATIO = 0.12;
export const LIGHTNING_BOLT_MAX_LEAN_RATIO = 0.3;

const BOLT_AZIMUTH_STREAM = 3;
const BOLT_DISTANCE_STREAM = 4;
const BOLT_TOP_STREAM = 5;
const BOLT_JITTER_X_STREAM = 6;
const BOLT_JITTER_Z_STREAM = 7;
const BOLT_LEAN_AZIMUTH_STREAM = 8;
const BOLT_LEAN_RATIO_STREAM = 9;
const BOLT_JAG_AMPLITUDE_STREAM = 10;
const FORK_COUNT_STREAM = 11;
const FORK_JOINT_STREAM = 12;
const FORK_AZIMUTH_STREAM = 13;
const FORK_DROP_STREAM = 14;
const FORK_RUN_STREAM = 15;
const FORK_JITTER_X_STREAM = 16;
const FORK_JITTER_Z_STREAM = 17;

/**
 * Cloud-base anchor of a strike's channel: `[x, topHeight, z]` in world
 * space. A pure function of `(seed, strikeWindowIndex)` shared by the bolt
 * polyline, the fork builder, and the lightning key light, so the flash
 * always appears to come from where the visible channel hangs.
 *
 * @param seed - The world seed.
 * @param strikeWindowIndex - The strike window the bolt belongs to.
 * @returns World-space top point of the lightning channel.
 */
export function getLightningBoltAnchor(seed: number, strikeWindowIndex: number): [number, number, number] {
  const azimuth = worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_AZIMUTH_STREAM) * Math.PI * 2;
  const distance =
    LIGHTNING_BOLT_MIN_DISTANCE +
    (LIGHTNING_BOLT_MAX_DISTANCE - LIGHTNING_BOLT_MIN_DISTANCE) *
      worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_DISTANCE_STREAM);
  const topHeight =
    LIGHTNING_BOLT_MIN_TOP_HEIGHT +
    (LIGHTNING_BOLT_MAX_TOP_HEIGHT - LIGHTNING_BOLT_MIN_TOP_HEIGHT) *
      worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_TOP_STREAM);
  return [Math.sin(azimuth) * distance, topHeight, Math.cos(azimuth) * distance];
}

/**
 * Deterministic jagged polyline for one strike, top-to-ground, as flat XYZ
 * triplets. A pure function of `(seed, strikeWindowIndex)` only: geometry is
 * derived from separate hash streams, so restyling the bolt can never change
 * which windows strike or how bright a flash is.
 *
 * The channel is not a toy zigzag: it leans toward a ground strike point
 * offset from the cloud anchor, and the per-joint jag is a Brownian bridge —
 * each joint's random step is added to the previous joint's offset, then the
 * accumulated drift is pinned back to zero at both endpoints. Correlated
 * steps read as one wandering channel with sharp kinks rather than
 * independent noise.
 *
 * @param seed - The world seed.
 * @param strikeWindowIndex - The strike window the bolt belongs to.
 * @returns Float32Array of `LIGHTNING_BOLT_POINT_COUNT * 3` world-space coordinates.
 */
export function createLightningBoltPolyline(seed: number, strikeWindowIndex: number): Float32Array {
  const [anchorX, topHeight, anchorZ] = getLightningBoltAnchor(seed, strikeWindowIndex);

  // Cloud-to-ground channels rarely hang plumb; the ground point slides off
  // the anchor so the whole bolt reads as a slanted stroke, not a pillar.
  const leanAzimuth = worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_LEAN_AZIMUTH_STREAM) * Math.PI * 2;
  const leanDistance =
    topHeight *
    (LIGHTNING_BOLT_MIN_LEAN_RATIO +
      (LIGHTNING_BOLT_MAX_LEAN_RATIO - LIGHTNING_BOLT_MIN_LEAN_RATIO) *
        worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_LEAN_RATIO_STREAM));
  const leanX = Math.sin(leanAzimuth) * leanDistance;
  const leanZ = Math.cos(leanAzimuth) * leanDistance;

  // Brownian-bridge jag: accumulate random steps, then subtract the linear
  // trend so both endpoints stay pinned to the channel axis, and normalize
  // the widest excursion to the hash-chosen amplitude (never above the cap).
  const walkX = new Float64Array(LIGHTNING_BOLT_POINT_COUNT);
  const walkZ = new Float64Array(LIGHTNING_BOLT_POINT_COUNT);
  for (let joint = 1; joint < LIGHTNING_BOLT_POINT_COUNT; joint += 1) {
    walkX[joint] =
      walkX[joint - 1]! + (worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_JITTER_X_STREAM, joint) - 0.5);
    walkZ[joint] =
      walkZ[joint - 1]! + (worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_JITTER_Z_STREAM, joint) - 0.5);
  }
  let widestExcursion = 0;
  const endX = walkX[LIGHTNING_BOLT_SEGMENTS]!;
  const endZ = walkZ[LIGHTNING_BOLT_SEGMENTS]!;
  for (let joint = 0; joint < LIGHTNING_BOLT_POINT_COUNT; joint += 1) {
    const t = joint / LIGHTNING_BOLT_SEGMENTS;
    walkX[joint]! -= endX * t;
    walkZ[joint]! -= endZ * t;
    widestExcursion = Math.max(widestExcursion, Math.hypot(walkX[joint]!, walkZ[joint]!));
  }
  const jagAmplitude =
    LIGHTNING_BOLT_MAX_JITTER *
    (0.55 + 0.45 * worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_JAG_AMPLITUDE_STREAM));
  const jagScale = widestExcursion > 1e-9 ? jagAmplitude / widestExcursion : 0;

  const points = new Float32Array(LIGHTNING_BOLT_POINT_COUNT * 3);
  for (let joint = 0; joint < LIGHTNING_BOLT_POINT_COUNT; joint += 1) {
    const t = joint / LIGHTNING_BOLT_SEGMENTS;
    points[joint * 3] = anchorX + leanX * t + walkX[joint]! * jagScale;
    points[joint * 3 + 1] = topHeight * (1 - t);
    points[joint * 3 + 2] = anchorZ + leanZ * t + walkZ[joint]! * jagScale;
  }
  return points;
}

/** Fork branch count band per strike. */
export const LIGHTNING_FORK_MIN_COUNT = 2;
export const LIGHTNING_FORK_MAX_COUNT = 3;
/** Jointed segments per fork branch. */
export const LIGHTNING_FORK_SEGMENTS = 3;
/** Forks may leave the main channel between these joints (upper half of the drop). */
export const LIGHTNING_FORK_MIN_JOINT = 3;
export const LIGHTNING_FORK_MAX_JOINT = 7;
/** Fork tip height as a fraction of the branch point height: forks die mid-air. */
const FORK_MIN_TIP_RATIO = 0.4;
const FORK_MAX_TIP_RATIO = 0.65;
/** Lateral fork run as a fraction of the fork's vertical drop. */
const FORK_MIN_RUN_RATIO = 0.5;
const FORK_MAX_RUN_RATIO = 0.95;
/** Per-joint fork jag cap, metres — finer than the main channel's. */
const FORK_MAX_JITTER = LIGHTNING_BOLT_MAX_JITTER * 0.45;

/**
 * Deterministic fork count for one strike, in
 * [LIGHTNING_FORK_MIN_COUNT, LIGHTNING_FORK_MAX_COUNT].
 *
 * @param seed - The world seed.
 * @param strikeWindowIndex - The strike window the bolt belongs to.
 * @returns Number of fork branches on this strike's channel.
 */
export function getLightningForkCount(seed: number, strikeWindowIndex: number): number {
  return (
    LIGHTNING_FORK_MIN_COUNT +
    Math.floor(
      worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_COUNT_STREAM) *
        (LIGHTNING_FORK_MAX_COUNT - LIGHTNING_FORK_MIN_COUNT + 1),
    )
  );
}

/**
 * Deterministic fork branches for one strike, as flat XYZ pairs for a
 * `LineSegments` draw (every consecutive pair of points is one segment).
 * Forks leave the main channel at a mid-drop joint, run outward and down,
 * and die mid-air the way real branches do — they never reach the ground.
 *
 * A pure function of `(seed, strikeWindowIndex)` on its own hash streams:
 * building forks can never move a strike moment or the main channel.
 *
 * @param seed - The world seed.
 * @param strikeWindowIndex - The strike window the bolt belongs to.
 * @returns Float32Array of `forkCount * LIGHTNING_FORK_SEGMENTS * 2 * 3` coordinates.
 */
export function createLightningBoltForkSegments(seed: number, strikeWindowIndex: number): Float32Array {
  const channel = createLightningBoltPolyline(seed, strikeWindowIndex);
  const forkCount = getLightningForkCount(seed, strikeWindowIndex);
  const segments = new Float32Array(forkCount * LIGHTNING_FORK_SEGMENTS * 2 * 3);
  let write = 0;

  for (let fork = 0; fork < forkCount; fork += 1) {
    const branchJoint =
      LIGHTNING_FORK_MIN_JOINT +
      Math.floor(
        worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_JOINT_STREAM, fork) *
          (LIGHTNING_FORK_MAX_JOINT - LIGHTNING_FORK_MIN_JOINT + 1),
      );
    const branchX = channel[branchJoint * 3]!;
    const branchY = channel[branchJoint * 3 + 1]!;
    const branchZ = channel[branchJoint * 3 + 2]!;

    const forkAzimuth =
      worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_AZIMUTH_STREAM, fork) * Math.PI * 2;
    const drop =
      branchY *
      (1 -
        (FORK_MIN_TIP_RATIO +
          (FORK_MAX_TIP_RATIO - FORK_MIN_TIP_RATIO) *
            worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_DROP_STREAM, fork)));
    const run =
      drop *
      (FORK_MIN_RUN_RATIO +
        (FORK_MAX_RUN_RATIO - FORK_MIN_RUN_RATIO) *
          worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_RUN_STREAM, fork));
    const tipX = branchX + Math.sin(forkAzimuth) * run;
    const tipZ = branchZ + Math.cos(forkAzimuth) * run;

    let previousX = branchX;
    let previousY = branchY;
    let previousZ = branchZ;
    for (let step = 1; step <= LIGHTNING_FORK_SEGMENTS; step += 1) {
      const t = step / LIGHTNING_FORK_SEGMENTS;
      // The fork tip keeps its jag: unlike the main channel, a dying branch
      // has no ground contact to pin its end to.
      const jitterX =
        (worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_JITTER_X_STREAM, fork, step) - 0.5) *
        2 *
        FORK_MAX_JITTER;
      const jitterZ =
        (worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, FORK_JITTER_Z_STREAM, fork, step) - 0.5) *
        2 *
        FORK_MAX_JITTER;
      const jointX = branchX + (tipX - branchX) * t + jitterX;
      const jointY = branchY - drop * t;
      const jointZ = branchZ + (tipZ - branchZ) * t + jitterZ;
      segments[write] = previousX;
      segments[write + 1] = previousY;
      segments[write + 2] = previousZ;
      segments[write + 3] = jointX;
      segments[write + 4] = jointY;
      segments[write + 5] = jointZ;
      write += 6;
      previousX = jointX;
      previousY = jointY;
      previousZ = jointZ;
    }
  }
  return segments;
}
