import type {
  DirectorProject,
  DirectorStoryboard,
  DirectorStoryboardMovement,
  DirectorStoryboardShotSize,
} from "../schema/directorProject";
import { frameRateToNumber, normalizeDirectorFrameRate, type DirectorFrameRateInput } from "../timeline/frameRate";
import {
  createEmptyDirectorInterchangeProject,
  getDirectorProjectTimeline,
  type DirectorInterchangeImportResult,
} from "./contract";
import { decodeUtf8Base64, encodeUtf8Base64 } from "./encoding";

export const DIRECTOR_FOUNTAIN_CONTRACT = "director-fountain-v1" as const;

/** Metadata embedded in Fountain boneyard comments for Director round-trip fidelity. */
interface DirectorFountainShotMetadata {
  contract: typeof DIRECTOR_FOUNTAIN_CONTRACT;
  id: string;
  scriptBeatId: string;
  cameraId: string | null;
  frameStart: number;
  frameEnd: number;
  shotSize: DirectorStoryboardShotSize;
  movement: DirectorStoryboardMovement;
}

/** Options for importing a Fountain screenplay as a storyboard. */
export interface ImportDirectorFountainOptions {
  /** Frame rate override; defaults to 24 fps. */
  rate?: DirectorFrameRateInput;
  /** Default duration per shot in seconds when no explicit duration is stored. */
  defaultShotDurationSeconds?: number;
}

/** The result of importing a Fountain screenplay as a storyboard. */
export interface DirectorFountainImportResult {
  /** The reconstructed storyboard. */
  storyboard: DirectorStoryboard;
  /** Non-fatal diagnostic messages. */
  warnings: string[];
}

/** Extended import options that also accept a base project to merge into. */
export interface ImportDirectorFountainProjectOptions extends ImportDirectorFountainOptions {
  /** Optional existing project whose scene and assets are preserved. */
  baseProject?: DirectorProject;
}

function stableId(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function metadataMarker(metadata: DirectorFountainShotMetadata) {
  return `/* DIRECTOR_SHOT_V1 ${encodeUtf8Base64(JSON.stringify(metadata))} */`;
}

function decodeMarker(line: string): DirectorFountainShotMetadata | null {
  const match = line.trim().match(/^\/\*\s*DIRECTOR_SHOT_V1\s+([A-Za-z0-9+/=]+)\s*\*\/$/);
  if (!match) return null;
  try {
    const value = JSON.parse(decodeUtf8Base64(match[1])) as Partial<DirectorFountainShotMetadata>;
    if (
      value.contract !== DIRECTOR_FOUNTAIN_CONTRACT ||
      typeof value.id !== "string" ||
      typeof value.scriptBeatId !== "string" ||
      (typeof value.cameraId !== "string" && value.cameraId !== null) ||
      !Number.isSafeInteger(value.frameStart) ||
      !Number.isSafeInteger(value.frameEnd) ||
      !["wide", "full", "medium", "close-up", "insert"].includes(value.shotSize ?? "") ||
      !["static", "pan", "tilt", "push-in", "pull-out", "dolly", "arc"].includes(value.movement ?? "")
    ) {
      return null;
    }
    return value as DirectorFountainShotMetadata;
  } catch {
    return null;
  }
}

function cleanHeading(line: string) {
  return line
    .replace(/^\./, "")
    .replace(/\s+#\d+#\s*$/, "")
    .trim();
}

function isSceneHeading(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith(".") || /^(?:INT\.?|EXT\.?|INT\.?\/EXT\.?|I\/E\.?)\s/i.test(trimmed);
}

function escapeAction(value: string) {
  return value.replace(/\/\*/g, "/ *").replace(/\*\//g, "* /").trim();
}

/**
 * Exports valid Fountain text. Director identity is carried in standard
 * boneyard comments so other screenplay tools ignore it without data loss.
 */
export function exportDirectorStoryboardToFountain(storyboard: DirectorStoryboard) {
  const lines = [`Title: ${storyboard.title || "Untitled"}`, `Logline: ${storyboard.logline || ""}`, ""];
  storyboard.shots.forEach((shot, index) => {
    const scriptBeatId = shot.scriptBeatId ?? `beat-${stableId(`${shot.id}:${index}`)}`;
    lines.push(
      metadataMarker({
        contract: DIRECTOR_FOUNTAIN_CONTRACT,
        id: shot.id,
        scriptBeatId,
        cameraId: shot.cameraId,
        frameStart: Math.round(shot.frameStart),
        frameEnd: Math.round(shot.frameEnd),
        shotSize: shot.shotSize,
        movement: shot.movement,
      }),
      `.${shot.title || `SHOT ${index + 1}`}`,
      "",
      escapeAction(shot.action || "Action to be defined."),
      "",
    );
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Imports both Director-authored Fountain and ordinary scene-based Fountain. */
export function importDirectorStoryboardFromFountain(
  source: string,
  options: ImportDirectorFountainOptions = {},
): DirectorFountainImportResult {
  const lines = source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const rate = normalizeDirectorFrameRate(options.rate ?? 24);
  const defaultDuration = Math.max(1, Math.round(frameRateToNumber(rate) * (options.defaultShotDurationSeconds ?? 3)));
  const title =
    lines
      .find((line) => /^Title\s*:/i.test(line))
      ?.replace(/^Title\s*:/i, "")
      .trim() || "Imported screenplay";
  const logline =
    lines
      .find((line) => /^Logline\s*:/i.test(line))
      ?.replace(/^Logline\s*:/i, "")
      .trim() || "";
  const warnings: string[] = [];
  const shots: DirectorStoryboard["shots"] = [];
  let pendingMetadata: DirectorFountainShotMetadata | null = null;
  let cursor = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const marker = decodeMarker(lines[index]);
    if (marker) {
      pendingMetadata = marker;
      continue;
    }
    if (!isSceneHeading(lines[index])) continue;
    const heading = cleanHeading(lines[index]);
    const action: string[] = [];
    let next = index + 1;
    for (; next < lines.length; next += 1) {
      if (decodeMarker(lines[next]) || isSceneHeading(lines[next])) break;
      const trimmed = lines[next].trim();
      if (!trimmed || /^\[\[.*\]\]$/.test(trimmed) || /^#{1,6}\s/.test(trimmed)) continue;
      action.push(trimmed);
    }
    const metadata = pendingMetadata;
    pendingMetadata = null;
    const frameStart = metadata?.frameStart ?? cursor;
    const frameEnd = metadata?.frameEnd ?? frameStart + defaultDuration - 1;
    if (frameEnd < frameStart)
      warnings.push(`Shot ${metadata?.id ?? heading} had an invalid frame range and was normalized.`);
    const normalizedEnd = Math.max(frameStart, frameEnd);
    const fallbackHash = stableId(`${heading}:${index}`);
    shots.push({
      id: metadata?.id ?? `shot-${fallbackHash}`,
      scriptBeatId: metadata?.scriptBeatId ?? `beat-${fallbackHash}`,
      title: heading || `Shot ${shots.length + 1}`,
      cameraId: metadata?.cameraId ?? null,
      frameStart,
      frameEnd: normalizedEnd,
      shotSize: metadata?.shotSize ?? "medium",
      movement: metadata?.movement ?? "static",
      action: action.join("\n") || "Action to be defined.",
    });
    cursor = normalizedEnd + 1;
    index = next - 1;
  }

  if (!shots.length) warnings.push("No Fountain scene headings were found; the storyboard is empty.");
  return { storyboard: { version: 1, title, logline, shots }, warnings };
}

/** Project-facing Fountain facade; the storyboard-only functions remain available for focused use. */
export function exportDirectorProjectToFountain(project: DirectorProject) {
  return exportDirectorStoryboardToFountain(
    project.storyboard ?? { version: 1, title: "Untitled", logline: "", shots: [] },
  );
}

/**
 * Imports a Fountain screenplay into a Director project.
 *
 * If a base project is provided, its scene and assets are preserved; the
 * storyboard and timeline are replaced. Without a base project, a new empty
 * project is created with the imported storyboard.
 *
 * @param source - The Fountain screenplay text.
 * @param options - Import options including optional base project.
 * @returns The project with imported storyboard and any warnings.
 */
export function importDirectorProjectFromFountain(
  source: string,
  options: ImportDirectorFountainProjectOptions = {},
): DirectorInterchangeImportResult {
  const imported = importDirectorStoryboardFromFountain(source, options);
  const project = structuredClone(
    options.baseProject ??
      createEmptyDirectorInterchangeProject({
        rate: normalizeDirectorFrameRate(options.rate ?? 24),
      }),
  );
  project.storyboard = imported.storyboard;
  const timeline = getDirectorProjectTimeline(project);
  const lastFrame = Math.max(timeline.frameStart, ...imported.storyboard.shots.map((shot) => shot.frameEnd));
  project.scene.timeline = {
    ...timeline,
    frameEnd: lastFrame,
    currentFrame: Math.max(timeline.frameStart, Math.min(lastFrame, timeline.currentFrame)),
  };
  return { project, warnings: imported.warnings };
}
