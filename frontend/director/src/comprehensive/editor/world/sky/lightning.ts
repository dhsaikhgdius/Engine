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
/** Maximum lateral jag of a joint from the straight channel, metres. */
export const LIGHTNING_BOLT_MAX_JITTER = 60;

const BOLT_AZIMUTH_STREAM = 3;
const BOLT_DISTANCE_STREAM = 4;
const BOLT_TOP_STREAM = 5;
const BOLT_JITTER_X_STREAM = 6;
const BOLT_JITTER_Z_STREAM = 7;

/**
 * Deterministic jagged polyline for one strike, top-to-ground, as flat XYZ
 * triplets. A pure function of `(seed, strikeWindowIndex)` only: geometry is
 * derived from separate hash streams, so restyling the bolt can never change
 * which windows strike or how bright a flash is.
 *
 * @param seed - The world seed.
 * @param strikeWindowIndex - The strike window the bolt belongs to.
 * @returns Float32Array of `LIGHTNING_BOLT_POINT_COUNT * 3` world-space coordinates.
 */
export function createLightningBoltPolyline(seed: number, strikeWindowIndex: number): Float32Array {
  const azimuth = worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_AZIMUTH_STREAM) * Math.PI * 2;
  const distance =
    LIGHTNING_BOLT_MIN_DISTANCE +
    (LIGHTNING_BOLT_MAX_DISTANCE - LIGHTNING_BOLT_MIN_DISTANCE) *
      worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_DISTANCE_STREAM);
  const topHeight =
    LIGHTNING_BOLT_MIN_TOP_HEIGHT +
    (LIGHTNING_BOLT_MAX_TOP_HEIGHT - LIGHTNING_BOLT_MIN_TOP_HEIGHT) *
      worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_TOP_STREAM);

  const anchorX = Math.sin(azimuth) * distance;
  const anchorZ = Math.cos(azimuth) * distance;
  const points = new Float32Array(LIGHTNING_BOLT_POINT_COUNT * 3);
  for (let joint = 0; joint < LIGHTNING_BOLT_POINT_COUNT; joint += 1) {
    const t = joint / LIGHTNING_BOLT_SEGMENTS;
    // Endpoints stay pinned so the channel visibly leaves the cloud base and
    // meets the ground; the jag amplitude peaks mid-channel.
    const jitterEnvelope = Math.sin(t * Math.PI);
    const jitterX =
      (worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_JITTER_X_STREAM, joint) - 0.5) *
      2 *
      LIGHTNING_BOLT_MAX_JITTER *
      jitterEnvelope;
    const jitterZ =
      (worldRandom01(seed, LIGHTNING_STREAM, strikeWindowIndex, BOLT_JITTER_Z_STREAM, joint) - 0.5) *
      2 *
      LIGHTNING_BOLT_MAX_JITTER *
      jitterEnvelope;
    points[joint * 3] = anchorX + jitterX;
    points[joint * 3 + 1] = topHeight * (1 - t);
    points[joint * 3 + 2] = anchorZ + jitterZ;
  }
  return points;
}
