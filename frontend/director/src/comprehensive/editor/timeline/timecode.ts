import {
  frameRateToNumber,
  getDirectorNominalFps,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  supportsDirectorDropFrame,
  type DirectorFrameRateInput,
  type DirectorTimelineTimebase,
} from "./frameRate";

/** Parsed SMPTE timecode with frame number and drop-frame flag. */
export interface ParsedDirectorTimecode {
  /** The resolved frame number. */
  frame: number;
  /** Whether the timecode uses drop-frame mode. */
  dropFrame: boolean;
  /** The canonical formatted timecode string. */
  timecode: string;
}

/** Options for formatting SMPTE timecode. */
export interface FormatDirectorTimecodeOptions {
  /** Whether to use drop-frame timecode. */
  dropFrame?: boolean;
  /** Whether to wrap frame numbers past 24 hours. */
  wrap24Hours?: boolean;
}

function dropFrameCount(rate: DirectorFrameRateInput) {
  return Math.round(getDirectorNominalFps(rate) * (2 / 30));
}

function framesPer24Hours(rate: DirectorFrameRateInput, dropFrame: boolean) {
  const nominal = getDirectorNominalFps(rate);
  if (!dropFrame) return nominal * 60 * 60 * 24;
  const dropped = dropFrameCount(rate);
  return nominal * 60 * 60 * 24 - dropped * (24 * 60 - 24 * 6);
}

function toTimecodeFrameNumber(frame: number, rate: DirectorFrameRateInput, dropFrame: boolean) {
  if (!dropFrame) return frame;
  const nominal = getDirectorNominalFps(rate);
  const dropped = dropFrameCount(rate);
  const framesPerMinute = nominal * 60 - dropped;
  const framesPerTenMinutes = nominal * 60 * 10 - dropped * 9;
  const tenMinuteBlocks = Math.floor(frame / framesPerTenMinutes);
  const blockRemainder = frame % framesPerTenMinutes;
  return (
    frame +
    dropped * 9 * tenMinuteBlocks +
    (blockRemainder >= dropped ? dropped * Math.floor((blockRemainder - dropped) / framesPerMinute) : 0)
  );
}

/**
 * Formats a frame number as a SMPTE timecode string.
 *
 * @param frame - The frame number.
 * @param rateInput - The frame rate.
 * @param options - Optional drop-frame and wrap-24h flags.
 * @returns A timecode string like "01:23:45:12" or "01:23:45;12" (drop-frame).
 */
export function formatSmpteTimecode(
  frame: number,
  rateInput: DirectorFrameRateInput,
  options: FormatDirectorTimecodeOptions = {},
) {
  const rate = normalizeDirectorFrameRate(rateInput);
  const dropFrame = Boolean(options.dropFrame && supportsDirectorDropFrame(rate));
  const negative = frame < 0;
  let normalizedFrame = Math.abs(Math.trunc(frame));
  if (options.wrap24Hours !== false) normalizedFrame %= framesPer24Hours(rate, dropFrame);
  const timecodeFrame = toTimecodeFrameNumber(normalizedFrame, rate, dropFrame);
  const nominal = getDirectorNominalFps(rate);
  const frames = timecodeFrame % nominal;
  const totalSeconds = Math.floor(timecodeFrame / nominal);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const separator = dropFrame ? ";" : ":";
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(frames)}`;
}

/**
 * Parses a SMPTE timecode string into a frame number.
 *
 * @param source - The timecode string like "01:23:45:12".
 * @param rateInput - The frame rate.
 * @param options - Optional drop-frame flag.
 * @returns The parsed timecode, or null if the string is invalid.
 */
export function parseSmpteTimecode(
  source: string,
  rateInput: DirectorFrameRateInput,
  options: Pick<FormatDirectorTimecodeOptions, "dropFrame"> = {},
): ParsedDirectorTimecode | null {
  const match = source.trim().match(/^(-)?(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/);
  if (!match) return null;
  const rate = normalizeDirectorFrameRate(rateInput);
  const requestedDrop = options.dropFrame ?? match[5] === ";";
  const dropFrame = Boolean(requestedDrop && supportsDirectorDropFrame(rate));
  if (requestedDrop && !dropFrame) return null;
  if ((match[5] === ";") !== dropFrame) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const frames = Number(match[6]);
  const nominal = getDirectorNominalFps(rate);
  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= nominal) return null;
  const dropped = dropFrame ? dropFrameCount(rate) : 0;
  if (dropFrame && minutes % 10 !== 0 && seconds === 0 && frames < dropped) return null;
  const totalMinutes = hours * 60 + minutes;
  const frame =
    (hours * 3_600 + minutes * 60 + seconds) * nominal +
    frames -
    dropped * (totalMinutes - Math.floor(totalMinutes / 10));
  const signedFrame = match[1] ? -frame : frame;
  return {
    frame: signedFrame,
    dropFrame,
    timecode: formatSmpteTimecode(signedFrame, rate, { dropFrame }),
  };
}

/**
 * Formats a timeline frame as a SMPTE timecode, offset by the timeline's start timecode.
 *
 * @param frame - The frame number relative to the timeline start.
 * @param input - The timeline timebase.
 * @returns A timecode string.
 */
export function formatDirectorTimelineTimecode(frame: number, input: Partial<DirectorTimelineTimebase>) {
  const timebase = normalizeDirectorTimebase(input);
  const startFrame =
    parseSmpteTimecode(timebase.startTimecode, timebase.rate, {
      dropFrame: timebase.dropFrame,
    })?.frame ?? 0;
  return formatSmpteTimecode(startFrame + Math.trunc(frame), timebase.rate, { dropFrame: timebase.dropFrame });
}

/**
 * Converts a timeline timecode string back to a timeline-relative frame number.
 *
 * @param source - The timecode string.
 * @param input - The timeline timebase.
 * @returns The frame number, or null if the string is invalid.
 */
export function directorTimelineTimecodeToFrame(source: string, input: Partial<DirectorTimelineTimebase>) {
  const timebase = normalizeDirectorTimebase(input);
  const parsed = parseSmpteTimecode(source, timebase.rate, { dropFrame: timebase.dropFrame });
  if (!parsed) return null;
  const startFrame =
    parseSmpteTimecode(timebase.startTimecode, timebase.rate, {
      dropFrame: timebase.dropFrame,
    })?.frame ?? 0;
  return parsed.frame - startFrame;
}

/**
 * Returns the duration of one frame in seconds.
 *
 * @param rateInput - The frame rate.
 * @returns The frame duration in seconds.
 */
export function frameDurationSeconds(rateInput: DirectorFrameRateInput) {
  return 1 / frameRateToNumber(rateInput);
}
