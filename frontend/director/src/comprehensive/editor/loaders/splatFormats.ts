import { z } from "zod";

/**
 * Gaussian splatting capture formats accepted by Director. These assets render
 * through the Spark splat renderer in the viewport and never carry a triangle
 * mesh, so mesh-only pipelines (DCC handoff, OBJ/STL materialization) must
 * check {@link isDirectorSplatAssetFileName} before attempting to load them.
 */
/** The file extensions accepted for Gaussian splatting captures. */
export const DIRECTOR_SPLAT_EXTENSIONS = [".ply", ".splat", ".ksplat", ".spz", ".sog"] as const;

/** Regex matching any Gaussian splatting file extension. */
export const DIRECTOR_SPLAT_EXTENSION_RE = /\.(ply|splat|ksplat|spz|sog)$/i;

/**
 * A 4D gaussian splatting sequence is uploaded as a ZIP of per-frame splat
 * files; the gateway unpacks it and answers with a `.4dgs.json` frame manifest
 * that becomes the asset URL.
 */
export const DIRECTOR_SPLAT_SEQUENCE_ARCHIVE_EXTENSION = ".zip";

/** The suffix appended to 4DGS frame manifest URLs. */
export const DIRECTOR_SPLAT_SEQUENCE_MANIFEST_SUFFIX = ".4dgs.json";

/** The HTML file input accept string for splat formats. */
export const DIRECTOR_SPLAT_FILE_INPUT_ACCEPT = [
  ...DIRECTOR_SPLAT_EXTENSIONS,
  DIRECTOR_SPLAT_SEQUENCE_ARCHIVE_EXTENSION,
].join(",");

/**
 * Checks whether a file name is a 4DGS sequence manifest.
 *
 * @param fileName - The file name to check.
 * @returns True if the file name ends with `.4dgs.json`.
 */
export function isDirectorSplatSequenceManifestFileName(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(DIRECTOR_SPLAT_SEQUENCE_MANIFEST_SUFFIX);
}

/** True for single splat captures and unpacked 4DGS sequence manifests alike. */
export function isDirectorSplatAssetFileName(fileName: string): boolean {
  return DIRECTOR_SPLAT_EXTENSION_RE.test(fileName.trim()) || isDirectorSplatSequenceManifestFileName(fileName);
}

/** Mirrors the gateway's per-sequence frame budget. */
export const DIRECTOR_SPLAT_SEQUENCE_MAX_FRAMES = 900;

/** The gateway-generated frame manifest a 4DGS sequence asset URL points at. */
export const directorSplatSequenceManifestSchema = z.object({
  format: z.literal("director-splat-sequence@1"),
  fps: z.number().min(1).max(240),
  frameCount: z.number().int().min(1),
  frames: z.array(z.string().min(1)).min(1).max(DIRECTOR_SPLAT_SEQUENCE_MAX_FRAMES),
});

export type DirectorSplatSequenceManifest = z.infer<typeof directorSplatSequenceManifestSchema>;

/** Resolves manifest-relative frame paths against the manifest's own URL. */
export function resolveDirectorSplatSequenceFrameUrls(manifestUrl: string, frames: readonly string[]): string[] {
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  return frames.map((frame) => `${base}${frame}`);
}
