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
 */

export const LIGHTNING_WINDOW_SECONDS = 0.25;
export const LIGHTNING_MIN_FLASH_SECONDS = 0.1;
export const LIGHTNING_MAX_FLASH_SECONDS = 0.25;

const LIGHTNING_STREAM = worldStreamId("sky-lightning");
const ROLL_STREAM = 0;
const DURATION_STREAM = 1;
const STRENGTH_STREAM = 2;

export interface WorldLightningState {
  active: boolean;
  /** 0 when inactive; approaches 1 for an intense storm's brightest strikes. */
  intensity: number;
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
  const strikeProbability = 0.02 + 0.14 * stormIntensity;
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
    intensity: decay * decay * strikeStrength * (0.4 + 0.6 * stormIntensity),
  };
}
