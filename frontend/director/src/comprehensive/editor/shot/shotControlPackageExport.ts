import JSZip from "jszip";
import type { DirectorProject } from "../schema/directorProject";
import type { DirectorShotPackageCapture } from "./shotPackageCapture";
import {
  captureDirectorShotPackage,
  type CaptureDirectorShotPackageOptions,
  type CapturedDirectorShotPackage,
} from "./shotPackageCapture";
import { stableArtifactStringify } from "./shotPackage";

function decodeRenderPassDataUrl(dataUrl: string) {
  const match = /^data:image\/(?:png|x-exr);base64,([a-z\d+/=\s]+)$/i.exec(dataUrl);
  if (!match) throw new Error("AI control package expected a base64 PNG or EXR render pass.");
  return match[1]!.replace(/\s+/g, "");
}

/**
 * Builds a ZIP archive from a captured shot package for AI control export.
 *
 * @param captured - The captured shot package with files and sidecars.
 * @returns A ZIP blob with DEFLATE compression.
 */
export async function buildDirectorAiControlPackageArchive(captured: CapturedDirectorShotPackage): Promise<Blob> {
  const zip = new JSZip();
  zip.file("manifest.json", `${stableArtifactStringify(captured.manifest)}\n`);
  captured.files.forEach((file) => {
    zip.file(file.path, decodeRenderPassDataUrl(file.dataUrl), { base64: true, binary: true });
  });
  captured.sidecars.forEach((file) => {
    zip.file(file.path, file.content);
  });
  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "application/vnd.director.ai-control+zip",
    platform: "UNIX",
  });
}

/**
 * Captures a shot package and builds the AI control ZIP archive in one step.
 *
 * @param project - The Director project.
 * @param options - Capture options (camera, frame, dimensions, passes).
 * @param capture - Optional capture function; defaults to the viewport capture bridge.
 * @returns The ZIP archive and the captured package.
 */
export async function createDirectorAiControlPackage(
  project: DirectorProject,
  options: CaptureDirectorShotPackageOptions,
  capture?: DirectorShotPackageCapture,
) {
  const captured = await captureDirectorShotPackage(project, { ...options, includeControlPackage: true }, capture);
  const archive = await buildDirectorAiControlPackageArchive(captured);
  return { archive, captured };
}

/**
 * Triggers a browser download of an AI control package ZIP.
 *
 * @param blob - The ZIP blob.
 * @param packageId - The package id used for the download filename.
 */
export function downloadDirectorAiControlPackage(blob: Blob, packageId: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${packageId.replace(/[^a-z0-9._-]+/gi, "-")}.director-control.zip`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
