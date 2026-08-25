import { describe, expect, it } from "vitest";
import {
  DIRECTOR_COLOR_METADATA_CONTRACT,
  DIRECTOR_DATA_COLOR_LINEAR,
  DIRECTOR_DISPLAY_COLOR_BT709,
  DIRECTOR_DISPLAY_COLOR_SRGB,
  directorColorMetadataSchema,
  ffmpegColorArgs,
} from "../src/directorColorMetadata";

describe("directorColorMetadataSchema", () => {
  it("accepts every named preset unchanged", () => {
    for (const preset of [DIRECTOR_DISPLAY_COLOR_BT709, DIRECTOR_DISPLAY_COLOR_SRGB, DIRECTOR_DATA_COLOR_LINEAR]) {
      expect(directorColorMetadataSchema.parse(preset)).toEqual(preset);
    }
  });

  it("rejects unknown keys", () => {
    const result = directorColorMetadataSchema.safeParse({ ...DIRECTOR_DISPLAY_COLOR_BT709, gamma: 2.4 });
    expect(result.success).toBe(false);
  });

  it("rejects a wrong contract string", () => {
    const result = directorColorMetadataSchema.safeParse({
      ...DIRECTOR_DISPLAY_COLOR_BT709,
      contract: "director-color-metadata-v2",
    });
    expect(result.success).toBe(false);
  });

  it("rejects values outside the Rec.709-era vocabulary", () => {
    expect(
      directorColorMetadataSchema.safeParse({ ...DIRECTOR_DISPLAY_COLOR_BT709, primaries: "bt2020" }).success,
    ).toBe(false);
    expect(directorColorMetadataSchema.safeParse({ ...DIRECTOR_DISPLAY_COLOR_BT709, transfer: "pq" }).success).toBe(
      false,
    );
    expect(directorColorMetadataSchema.safeParse({ ...DIRECTOR_DISPLAY_COLOR_BT709, range: "limited" }).success).toBe(
      false,
    );
    expect(directorColorMetadataSchema.safeParse({ ...DIRECTOR_DISPLAY_COLOR_BT709, role: "archive" }).success).toBe(
      false,
    );
  });

  it("requires every field (no defaults)", () => {
    const { range: _range, ...missingRange } = DIRECTOR_DISPLAY_COLOR_BT709;
    expect(directorColorMetadataSchema.safeParse(missingRange).success).toBe(false);
  });
});

describe("ffmpegColorArgs", () => {
  it("maps the Rec.709 display preset to tv-range bt709 flags", () => {
    expect(ffmpegColorArgs(DIRECTOR_DISPLAY_COLOR_BT709)).toEqual([
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-color_range",
      "tv",
    ]);
  });

  it("maps sRGB display to iec61966-2-1 and coerces the identity matrix to bt709 for YUV delivery", () => {
    expect(ffmpegColorArgs(DIRECTOR_DISPLAY_COLOR_SRGB)).toEqual([
      "-color_primaries",
      "bt709",
      "-color_trc",
      "iec61966-2-1",
      "-colorspace",
      "bt709",
      "-color_range",
      "pc",
    ]);
  });

  it("keeps the literal rgb colorspace for data-role linear buffers", () => {
    expect(ffmpegColorArgs(DIRECTOR_DATA_COLOR_LINEAR)).toEqual([
      "-color_primaries",
      "bt709",
      "-color_trc",
      "linear",
      "-colorspace",
      "rgb",
      "-color_range",
      "pc",
    ]);
  });

  it("exposes the contract literal used by stored metadata", () => {
    expect(DIRECTOR_COLOR_METADATA_CONTRACT).toBe("director-color-metadata-v1");
  });
});
