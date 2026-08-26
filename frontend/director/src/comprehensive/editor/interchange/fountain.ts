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

/**
 * Structured warn-and-omit codes for Fountain → storyboard import. Agents read
 * these instead of scraping free-text `warnings[]`. Invalid frame ranges stay
 * warnings only (the shot is still created after normalization).
 */
export const DIRECTOR_FOUNTAIN_OMITTED_CODES = [
  "character_dialogue",
  "boneyard_note",
  "section_heading",
  "title_page_field",
  "invalid_marker",
  "transition",
] as const;

/** One Fountain omit code. */
export type DirectorFountainOmittedCode = (typeof DIRECTOR_FOUNTAIN_OMITTED_CODES)[number];

/** One typed Fountain import omission. */
export interface DirectorFountainOmitted {
  code: DirectorFountainOmittedCode;
  /** Character name, note text, title-page key, or other subject. */
  subject: string;
  reason: string;
}

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
  /** Non-fatal diagnostic messages (kept for older UIs / free-text scrapers). */
  warnings: string[];
  /**
   * Typed omit records for Agent/UI honesty. Dialogue, notes, sections, and
   * unsupported title-page fields are not carried as storyboard structure.
   */
  omitted: DirectorFountainOmitted[];
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

function looksLikeDirectorMarker(line: string) {
  return /^\/\*\s*DIRECTOR_SHOT_V1\b/.test(line.trim());
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

function isTransition(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(">")) return true;
  return /\bTO:\s*$/i.test(trimmed) || /^(?:FADE|CUT|DISSOLVE|SMASH|WIPE)\b/i.test(trimmed);
}

function isCharacterCue(line: string) {
  const trimmed = line.trim();
  if (!trimmed || isSceneHeading(trimmed) || isTransition(trimmed) || trimmed.startsWith("@")) return false;
  if (/^\[\[.*\]\]$/.test(trimmed) || /^#{1,6}\s/.test(trimmed)) return false;
  const withoutExtension = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!withoutExtension || withoutExtension.length > 48) return false;
  // Fountain character cues are uppercase names (optionally with parenthetical extensions).
  return withoutExtension === withoutExtension.toUpperCase() && /[A-Z]/.test(withoutExtension);
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
  const omitted: DirectorFountainOmitted[] = [];
  const pushOmit = (code: DirectorFountainOmittedCode, subject: string, reason: string) => {
    omitted.push({ code, subject, reason });
    warnings.push(reason);
  };

  // Title-page keys other than Title/Logline are not storyboard structure.
  for (const line of lines) {
    if (isSceneHeading(line) || looksLikeDirectorMarker(line)) break;
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.trim();
    if (/^(Title|Logline)$/i.test(key)) continue;
    pushOmit(
      "title_page_field",
      key,
      `Fountain title-page field ${key} is not carried into the Director storyboard (warn-and-omit code: title_page_field).`,
    );
  }

  const shots: DirectorStoryboard["shots"] = [];
  let pendingMetadata: DirectorFountainShotMetadata | null = null;
  let cursor = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (looksLikeDirectorMarker(lines[index]) && !decodeMarker(lines[index])) {
      pushOmit(
        "invalid_marker",
        lines[index].trim().slice(0, 80) || "DIRECTOR_SHOT_V1",
        `Fountain Director shot marker was malformed and ignored (warn-and-omit code: invalid_marker).`,
      );
      continue;
    }
    const marker = decodeMarker(lines[index]);
    if (marker) {
      pendingMetadata = marker;
      continue;
    }
    const trimmedLine = lines[index].trim();
    if (!isSceneHeading(lines[index])) {
      if (/^#{1,6}\s/.test(trimmedLine)) {
        pushOmit(
          "section_heading",
          trimmedLine.slice(0, 120),
          `Fountain section ${trimmedLine.slice(0, 48)} was skipped; storyboard shots do not carry section headings (warn-and-omit code: section_heading).`,
        );
      } else if (isTransition(trimmedLine)) {
        pushOmit(
          "transition",
          trimmedLine.slice(0, 120),
          `Fountain transition ${trimmedLine.slice(0, 48)} was skipped; storyboard shots do not carry transitions (warn-and-omit code: transition).`,
        );
      }
      continue;
    }
    const heading = cleanHeading(lines[index]);
    const action: string[] = [];
    let next = index + 1;
    for (; next < lines.length; next += 1) {
      if (looksLikeDirectorMarker(lines[next]) || isSceneHeading(lines[next])) break;
      const trimmed = lines[next].trim();
      if (!trimmed) continue;
      if (/^\[\[.*\]\]$/.test(trimmed)) {
        pushOmit(
          "boneyard_note",
          trimmed.slice(0, 120),
          `Fountain note ${trimmed.slice(0, 48)} was skipped; storyboard shots do not carry boneyard notes (warn-and-omit code: boneyard_note).`,
        );
        continue;
      }
      if (/^#{1,6}\s/.test(trimmed)) {
        pushOmit(
          "section_heading",
          trimmed.slice(0, 120),
          `Fountain section ${trimmed.slice(0, 48)} was skipped; storyboard shots do not carry section headings (warn-and-omit code: section_heading).`,
        );
        continue;
      }
      if (isTransition(trimmed)) {
        pushOmit(
          "transition",
          trimmed.slice(0, 120),
          `Fountain transition ${trimmed.slice(0, 48)} was skipped; storyboard shots do not carry transitions (warn-and-omit code: transition).`,
        );
        continue;
      }
      if (isCharacterCue(trimmed)) {
        const character = trimmed.replace(/\s*\([^)]*\)\s*$/, "").trim();
        const dialogue: string[] = [];
        let probe = next + 1;
        for (; probe < lines.length; probe += 1) {
          const dialogueLine = lines[probe]!.trim();
          if (!dialogueLine) break;
          if (
            looksLikeDirectorMarker(lines[probe]!) ||
            isSceneHeading(lines[probe]!) ||
            isCharacterCue(dialogueLine) ||
            /^\[\[.*\]\]$/.test(dialogueLine) ||
            /^#{1,6}\s/.test(dialogueLine)
          ) {
            break;
          }
          dialogue.push(dialogueLine);
        }
        pushOmit(
          "character_dialogue",
          character,
          `Fountain dialogue for ${character} was omitted; Director storyboard shots carry action text only (warn-and-omit code: character_dialogue).`,
        );
        next = Math.max(next, probe - 1);
        continue;
      }
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
  return { storyboard: { version: 1, title, logline, shots }, warnings, omitted };
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
  return { project, warnings: imported.warnings, omitted: imported.omitted };
}
