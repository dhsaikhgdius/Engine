import { z } from "zod";

/**
 * Explicit color management metadata for Director media.
 *
 * Every rendered or transcoded asset should carry one of these records so
 * downstream tools (ffmpeg encodes, the Video Editor, external NLEs) never
 * have to guess primaries/transfer/matrix/range. The vocabulary is a
 * deliberately minimal Rec.709-era set; new members (e.g. bt2020, pq) can be
 * added to the enums later without breaking existing payloads.
 */

export const DIRECTOR_COLOR_METADATA_CONTRACT = "director-color-metadata-v1" as const;

export const directorColorPrimariesSchema = z.enum(["bt709"]);
export const directorColorTransferSchema = z.enum(["bt709", "srgb", "linear"]);
export const directorColorMatrixSchema = z.enum(["bt709", "identity"]);
export const directorColorRangeSchema = z.enum(["video", "full"]);
/** "display" = display-referred imagery for viewing; "data" = scene-referred/utility buffers (depth, normals, linear renders). */
export const directorColorRoleSchema = z.enum(["display", "data"]);

export const directorColorMetadataSchema = z.strictObject({
  contract: z.literal(DIRECTOR_COLOR_METADATA_CONTRACT),
  primaries: directorColorPrimariesSchema,
  transfer: directorColorTransferSchema,
  matrix: directorColorMatrixSchema,
  range: directorColorRangeSchema,
  role: directorColorRoleSchema,
});

export type DirectorColorPrimaries = z.infer<typeof directorColorPrimariesSchema>;
export type DirectorColorTransfer = z.infer<typeof directorColorTransferSchema>;
export type DirectorColorMatrix = z.infer<typeof directorColorMatrixSchema>;
export type DirectorColorRange = z.infer<typeof directorColorRangeSchema>;
export type DirectorColorRole = z.infer<typeof directorColorRoleSchema>;
export type DirectorColorMetadata = z.infer<typeof directorColorMetadataSchema>;

/** Standard Rec.709 video: what H.264/yuv420p deliverables should be tagged as. */
export const DIRECTOR_DISPLAY_COLOR_BT709 = {
  contract: DIRECTOR_COLOR_METADATA_CONTRACT,
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  range: "video",
  role: "display",
} as const satisfies DirectorColorMetadata;

/** sRGB stills and UI-facing RGB imagery (full-range, no YUV matrix). */
export const DIRECTOR_DISPLAY_COLOR_SRGB = {
  contract: DIRECTOR_COLOR_METADATA_CONTRACT,
  primaries: "bt709",
  transfer: "srgb",
  matrix: "identity",
  range: "full",
  role: "display",
} as const satisfies DirectorColorMetadata;

/** Scene-referred/utility RGB buffers (linear renders, depth, normals). */
export const DIRECTOR_DATA_COLOR_LINEAR = {
  contract: DIRECTOR_COLOR_METADATA_CONTRACT,
  primaries: "bt709",
  transfer: "linear",
  matrix: "identity",
  range: "full",
  role: "data",
} as const satisfies DirectorColorMetadata;

const FFMPEG_TRANSFER_NAMES: Record<DirectorColorTransfer, string> = {
  bt709: "bt709",
  srgb: "iec61966-2-1",
  linear: "linear",
};

function ffmpegColorspaceName(metadata: DirectorColorMetadata): string {
  if (metadata.matrix === "bt709") return "bt709";
  // ffmpeg's name for the identity matrix is "rgb", but encoders refuse it for
  // YUV pixel formats. Display outputs are always delivered as YUV (H.264
  // yuv420p), where the RGB→YUV conversion uses the BT.709 matrix, so tag that.
  // Data-role outputs stay RGB and keep the literal identity/"rgb" tag.
  return metadata.role === "display" ? "bt709" : "rgb";
}

/** Maps color metadata to explicit ffmpeg encoder flags, in a fixed deterministic order. */
export function ffmpegColorArgs(metadata: DirectorColorMetadata): string[] {
  return [
    "-color_primaries",
    metadata.primaries,
    "-color_trc",
    FFMPEG_TRANSFER_NAMES[metadata.transfer],
    "-colorspace",
    ffmpegColorspaceName(metadata),
    "-color_range",
    metadata.range === "video" ? "tv" : "pc",
  ];
}
