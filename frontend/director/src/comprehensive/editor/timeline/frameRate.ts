/** A rational frame rate expressed as numerator/denominator. */
export interface DirectorRationalFrameRate {
  /** Numerator (e.g. 24000 for 23.976). */
  numerator: number;
  /** Denominator (e.g. 1001 for 23.976). */
  denominator: number;
}

/** A timeline timebase with rational rate, drop-frame flag, and start timecode. */
export interface DirectorTimelineTimebase {
  /** The rational frame rate. */
  rate: DirectorRationalFrameRate;
  /** Whether drop-frame timecode is used. */
  dropFrame: boolean;
  /** SMPTE timecode assigned to timeline frame zero. */
  startTimecode: string;
}

/** A frame rate can be expressed as a rational pair, a float, or a serialized string. */
export type DirectorFrameRateInput = DirectorRationalFrameRate | number | string;

/** Common frame rate presets. */
export const DIRECTOR_COMMON_FRAME_RATES = Object.freeze({
  /** 23.976 fps (24000/1001). */
  film23976: Object.freeze({ numerator: 24_000, denominator: 1_001 }),
  /** 24 fps. */
  film24: Object.freeze({ numerator: 24, denominator: 1 }),
  /** 25 fps (PAL). */
  pal25: Object.freeze({ numerator: 25, denominator: 1 }),
  /** 29.97 fps (30000/1001). */
  ntsc2997: Object.freeze({ numerator: 30_000, denominator: 1_001 }),
  /** 30 fps. */
  video30: Object.freeze({ numerator: 30, denominator: 1 }),
  /** 59.94 fps (60000/1001). */
  ntsc5994: Object.freeze({ numerator: 60_000, denominator: 1_001 }),
  /** 60 fps. */
  video60: Object.freeze({ numerator: 60, denominator: 1 }),
});

const COMMON_RATE_LIST = Object.values(DIRECTOR_COMMON_FRAME_RATES);
const MAX_RATE_COMPONENT = 1_000_000;

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function reducedRate(numerator: number, denominator: number): DirectorRationalFrameRate | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null;
  if (numerator <= 0 || denominator <= 0 || numerator > MAX_RATE_COMPONENT || denominator > MAX_RATE_COMPONENT) {
    return null;
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  const rate = { numerator: numerator / divisor, denominator: denominator / divisor };
  const value = rate.numerator / rate.denominator;
  return value >= 1 && value <= 240 ? rate : null;
}

function decimalRate(value: number): DirectorRationalFrameRate | null {
  if (!Number.isFinite(value) || value < 1 || value > 240) return null;
  const common = COMMON_RATE_LIST.find((rate) => Math.abs(rate.numerator / rate.denominator - value) < 0.000_1);
  if (common) return { ...common };
  const source = value.toString().toLowerCase();
  if (source.includes("e")) {
    const denominator = 1_000_000;
    return reducedRate(Math.round(value * denominator), denominator);
  }
  const decimals = source.split(".")[1]?.length ?? 0;
  const denominator = 10 ** Math.min(6, decimals);
  return reducedRate(Math.round(value * denominator), denominator);
}

function parsedRate(input: DirectorFrameRateInput): DirectorRationalFrameRate | null {
  if (typeof input === "number") return decimalRate(input);
  if (typeof input === "string") {
    const normalized = input.trim().replace(/\s*(?:NDF|DF)\s*$/i, "");
    const fraction = normalized.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (fraction) return reducedRate(Number(fraction[1]), Number(fraction[2]));
    return decimalRate(Number(normalized));
  }
  return reducedRate(input.numerator, input.denominator);
}

/**
 * Normalizes any frame rate input to a rational rate.
 *
 * @param input - A rational rate, float, or fraction string.
 * @param fallback - Default rate when input is null/undefined/unparseable.
 * @returns A valid rational frame rate.
 */
export function normalizeDirectorFrameRate(
  input: DirectorFrameRateInput | null | undefined,
  fallback: DirectorFrameRateInput = DIRECTOR_COMMON_FRAME_RATES.film24,
): DirectorRationalFrameRate {
  if (input !== null && input !== undefined) {
    const parsed = parsedRate(input);
    if (parsed) return parsed;
  }
  return parsedRate(fallback) ?? { ...DIRECTOR_COMMON_FRAME_RATES.film24 };
}

export function serializeDirectorFrameRate(input: DirectorFrameRateInput) {
  const rate = normalizeDirectorFrameRate(input);
  return `${rate.numerator}/${rate.denominator}`;
}

/**
 * Converts a frame rate to a floating-point number.
 *
 * @param input - The frame rate.
 * @returns The rate as a number (e.g. 23.976...).
 */
export function frameRateToNumber(input: DirectorFrameRateInput) {
  const rate = normalizeDirectorFrameRate(input);
  return rate.numerator / rate.denominator;
}

export function frameRatesEqual(left: DirectorFrameRateInput, right: DirectorFrameRateInput) {
  return serializeDirectorFrameRate(left) === serializeDirectorFrameRate(right);
}

/**
 * Checks whether a frame rate supports drop-frame timecode.
 *
 * @param input - The frame rate.
 * @returns True for 29.97 and 59.94 rates.
 */
export function supportsDirectorDropFrame(input: DirectorFrameRateInput) {
  const serialized = serializeDirectorFrameRate(input);
  return serialized === "30000/1001" || serialized === "60000/1001";
}

export function getDirectorNominalFps(input: DirectorFrameRateInput) {
  return Math.round(frameRateToNumber(input));
}

/**
 * Formats a frame rate for display.
 *
 * @param input - The frame rate.
 * @param dropFrame - Whether to append " DF" for drop-frame rates.
 * @returns A human-readable string like "23.976" or "29.97 DF".
 */
export function formatDirectorFrameRate(input: DirectorFrameRateInput, dropFrame = false) {
  const rate = normalizeDirectorFrameRate(input);
  const value = frameRateToNumber(rate);
  const serialized = serializeDirectorFrameRate(rate);
  const precision = rate.denominator === 1 ? 0 : serialized === "24000/1001" ? 3 : 2;
  return `${value.toFixed(precision)}${dropFrame && supportsDirectorDropFrame(rate) ? " DF" : ""}`;
}

/** Creates a default timebase (24 fps, no drop-frame, 00:00:00:00). */
export function createDefaultDirectorTimebase(): DirectorTimelineTimebase {
  return {
    rate: { ...DIRECTOR_COMMON_FRAME_RATES.film24 },
    dropFrame: false,
    startTimecode: "00:00:00:00",
  };
}

/**
 * Normalizes a partial timebase and legacy fps into a complete timebase.
 *
 * @param input - Partial timebase or null/undefined.
 * @param legacyFps - Fallback fps when no rational rate is provided.
 * @returns A complete timebase.
 */
export function normalizeDirectorTimebase(
  input: Partial<DirectorTimelineTimebase> | null | undefined,
  legacyFps: DirectorFrameRateInput = 24,
): DirectorTimelineTimebase {
  const rate = normalizeDirectorFrameRate(input?.rate, legacyFps);
  const dropFrame = Boolean(input?.dropFrame && supportsDirectorDropFrame(rate));
  const defaultStart = dropFrame ? "00:00:00;00" : "00:00:00:00";
  const candidate = input?.startTimecode?.trim();
  return {
    rate,
    dropFrame,
    startTimecode: candidate && /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(candidate) ? candidate : defaultStart,
  };
}

/**
 * Extracts the floating-point fps from a timeline object.
 *
 * @param timeline - A timeline-like object with optional fps and timebase.
 * @param fallback - Default fps.
 * @returns The resolved fps as a number.
 */
export function getDirectorTimelineFps(
  timeline: { fps?: number; timebase?: Partial<DirectorTimelineTimebase> } | null | undefined,
  fallback: DirectorFrameRateInput = 24,
) {
  return frameRateToNumber(normalizeDirectorTimebase(timeline?.timebase, timeline?.fps ?? fallback).rate);
}
