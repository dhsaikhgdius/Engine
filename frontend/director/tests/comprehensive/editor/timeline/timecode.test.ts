import { describe, expect, it } from "vitest";
import {
  DIRECTOR_COMMON_FRAME_RATES,
  formatDirectorFrameRate,
  frameRateToNumber,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  serializeDirectorFrameRate,
  supportsDirectorDropFrame,
} from "../../../../src/comprehensive/editor/timeline/frameRate";
import {
  directorTimelineTimecodeToFrame,
  formatDirectorTimelineTimecode,
  formatSmpteTimecode,
  parseSmpteTimecode,
} from "../../../../src/comprehensive/editor/timeline/timecode";

describe("rational editorial frame rates", () => {
  it("canonicalizes common decimal shorthand without losing NTSC precision", () => {
    expect(normalizeDirectorFrameRate(23.976)).toEqual({ numerator: 24_000, denominator: 1_001 });
    expect(serializeDirectorFrameRate("30000/1001")).toBe("30000/1001");
    expect(frameRateToNumber(DIRECTOR_COMMON_FRAME_RATES.ntsc2997)).toBeCloseTo(29.97002997, 8);
    expect(formatDirectorFrameRate(DIRECTOR_COMMON_FRAME_RATES.ntsc2997, true)).toBe("29.97 DF");
  });

  it("only permits drop-frame on the SMPTE 29.97 and 59.94 rates", () => {
    expect(supportsDirectorDropFrame("30000/1001")).toBe(true);
    expect(supportsDirectorDropFrame("60000/1001")).toBe(true);
    expect(supportsDirectorDropFrame(30)).toBe(false);
    expect(normalizeDirectorTimebase({ rate: { numerator: 24, denominator: 1 }, dropFrame: true }).dropFrame).toBe(
      false,
    );
  });
});

describe("SMPTE timecode", () => {
  const ntsc = DIRECTOR_COMMON_FRAME_RATES.ntsc2997;

  it("skips frame labels 00 and 01 at non-tenth minutes for 29.97 DF", () => {
    expect(formatSmpteTimecode(1_799, ntsc, { dropFrame: true })).toBe("00:00:59;29");
    expect(formatSmpteTimecode(1_800, ntsc, { dropFrame: true })).toBe("00:01:00;02");
    expect(formatSmpteTimecode(17_982, ntsc, { dropFrame: true })).toBe("00:10:00;00");
    expect(parseSmpteTimecode("00:01:00;00", ntsc)).toBeNull();
  });

  it("round-trips every frame around minute, ten-minute, and hour boundaries", () => {
    for (const frame of [0, 1, 1_798, 1_799, 1_800, 17_981, 17_982, 107_891, 107_892]) {
      const timecode = formatSmpteTimecode(frame, ntsc, { dropFrame: true });
      expect(parseSmpteTimecode(timecode, ntsc)?.frame).toBe(frame);
    }
  });

  it("supports 59.94 DF and non-zero timeline starting timecode", () => {
    const rate = DIRECTOR_COMMON_FRAME_RATES.ntsc5994;
    expect(formatSmpteTimecode(3_600, rate, { dropFrame: true })).toBe("00:01:00;04");
    const timebase = { rate, dropFrame: true, startTimecode: "01:00:00;00" };
    expect(formatDirectorTimelineTimecode(3_600, timebase)).toBe("01:01:00;04");
    expect(directorTimelineTimecodeToFrame("01:01:00;04", timebase)).toBe(3_600);
  });
});
