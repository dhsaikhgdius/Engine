/** A rational frame rate expressed as a reduced numerator/denominator pair. */
export interface DirectorRationalFrameRate {
  numerator: number;
  denominator: number;
}

/** Timeline-level time representation including rate, drop-frame flag, and start timecode. */
export interface DirectorTimelineTimebase {
  rate: DirectorRationalFrameRate;
  dropFrame: boolean;
  /** SMPTE timecode assigned to timeline frame zero. */
  startTimecode: string;
}

/** Frame rate may be authored as a rational pair, a decimal number, or a fraction string. */
export type DirectorFrameRateInput = DirectorRationalFrameRate | number | string;

/** Industry-standard frame rates available for authoring and UI selection. */
export const DIRECTOR_COMMON_FRAME_RATES = Object.freeze({
  film23976: Object.freeze({ numerator: 24_000, denominator: 1_001 }),
  film24: Object.freeze({ numerator: 24, denominator: 1 }),
  pal25: Object.freeze({ numerator: 25, denominator: 1 }),
  ntsc2997: Object.freeze({ numerator: 30_000, denominator: 1_001 }),
  video30: Object.freeze({ numerator: 30, denominator: 1 }),
  ntsc5994: Object.freeze({ numerator: 60_000, denominator: 1_001 }),
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
 * Normalizes any frame rate input to a canonical rational pair.
 *
 * Accepts a decimal number, a fraction string like "30000/1001", or a
 * rational object. Returns the closest standard rate when the input is
 * within tolerance, otherwise reduces the precise value. Falls back to
 * 24 fps when the input is null, undefined, or unparseable.
 *
 * @param input - A frame rate in any supported representation.
 * @param fallback - The rate to use when input is null or unparseable.
 * @returns A canonical reduced rational frame rate.
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

/**
 * Serializes a frame rate to the canonical "numerator/denominator" string form.
 *
 * @param input - A frame rate in any supported representation.
 * @returns The canonical fraction string, e.g. "24000/1001".
 */
export function serializeDirectorFrameRate(input: DirectorFrameRateInput) {
  const rate = normalizeDirectorFrameRate(input);
  return `${rate.numerator}/${rate.denominator}`;
}

/**
 * Converts a frame rate to its floating-point frames-per-second value.
 *
 * @param input - A frame rate in any supported representation.
 * @returns The numeric fps value, e.g. 23.976 for film NTSC.
 */
export function frameRateToNumber(input: DirectorFrameRateInput) {
  const rate = normalizeDirectorFrameRate(input);
  return rate.numerator / rate.denominator;
}

/**
 * Compares two frame rate inputs for exact equality after canonicalization.
 *
 * @param left - A frame rate in any supported representation.
 * @param right - A frame rate in any supported representation.
 * @returns True when both rates resolve to the same canonical fraction.
 */
export function frameRatesEqual(left: DirectorFrameRateInput, right: DirectorFrameRateInput) {
  return serializeDirectorFrameRate(left) === serializeDirectorFrameRate(right);
}

/**
 * Determines whether a frame rate supports SMPTE drop-frame timecode.
 *
 * Only NTSC 29.97 and 59.94 rates carry the drop-frame convention.
 *
 * @param input - A frame rate in any supported representation.
 * @returns True for 29.97 and 59.94 rates.
 */
export function supportsDirectorDropFrame(input: DirectorFrameRateInput) {
  const serialized = serializeDirectorFrameRate(input);
  return serialized === "30000/1001" || serialized === "60000/1001";
}

/**
 * Returns the nominal (rounded) integer fps for display and quick comparisons.
 *
 * @param input - A frame rate in any supported representation.
 * @returns The nearest integer fps, e.g. 24 for 23.976.
 */
export function getDirectorNominalFps(input: DirectorFrameRateInput) {
  return Math.round(frameRateToNumber(input));
}

/**
 * Formats a frame rate for human-readable display with appropriate precision.
 *
 * Integer rates display without decimals; 23.976 uses three decimal places;
 * all other fractional rates use two. Appends " DF" suffix when drop-frame
 * is requested and the rate supports it.
 *
 * @param input - A frame rate in any supported representation.
 * @param dropFrame - Whether to append the drop-frame indicator.
 * @returns A formatted fps string such as "23.976" or "29.97 DF".
 */
export function formatDirectorFrameRate(input: DirectorFrameRateInput, dropFrame = false) {
  const rate = normalizeDirectorFrameRate(input);
  const value = frameRateToNumber(rate);
  const serialized = serializeDirectorFrameRate(rate);
  const precision = rate.denominator === 1 ? 0 : serialized === "24000/1001" ? 3 : 2;
  return `${value.toFixed(precision)}${dropFrame && supportsDirectorDropFrame(rate) ? " DF" : ""}`;
}

/**
 * Creates a default timebase with 24 fps, no drop frame, and "00:00:00:00" start.
 *
 * @returns A fresh default timeline timebase.
 */
export function createDefaultDirectorTimebase(): DirectorTimelineTimebase {
  return {
    rate: { ...DIRECTOR_COMMON_FRAME_RATES.film24 },
    dropFrame: false,
    startTimecode: "00:00:00:00",
  };
}

/**
 * Normalizes a partial timebase, filling missing fields with sensible defaults.
 *
 * Drop-frame is only enabled when the rate actually supports it. The start
 * timecode separator is validated against a strict SMPTE pattern.
 *
 * @param input - A partial timebase to complete, or null/undefined for defaults.
 * @param legacyFps - Fallback fps when no rate is provided.
 * @returns A complete, validated timeline timebase.
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
 * Extracts the numeric fps from a timeline object, with legacy `fps` fallback.
 *
 * @param timeline - A timeline object potentially containing a timebase or legacy fps.
 * @param fallback - Fps to use when no timeline data is present.
 * @returns The resolved numeric frames-per-second value.
 */
export function getDirectorTimelineFps(
  timeline: { fps?: number; timebase?: Partial<DirectorTimelineTimebase> } | null | undefined,
  fallback: DirectorFrameRateInput = 24,
) {
  return frameRateToNumber(normalizeDirectorTimebase(timeline?.timebase, timeline?.fps ?? fallback).rate);
}
