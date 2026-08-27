/**
 * OTIO interchange for the Stage storyboard: exports storyboard shots as an
 * OpenTimelineIO timeline (plain .otio JSON or zipped OTIOZ under the
 * versioned director-otio adapter) and imports OTIO timelines back into
 * storyboard shots. Distinct from creativeOtio.ts, which handles the video
 * editor's edit tracks — this adapter maps shot ranges, not media clips.
 */
import JSZip from "jszip";
import { isRecord } from "../../../../../../packages/protocol/src/primitives";
import type { DirectorProject, DirectorStoryboard, DirectorStoryboardShot } from "../schema/directorProject";
import {
  frameRateToNumber,
  normalizeDirectorFrameRate,
  normalizeDirectorTimebase,
  type DirectorFrameRateInput,
} from "../timeline/frameRate";
import { formatSmpteTimecode, parseSmpteTimecode } from "../timeline/timecode";
import {
  DIRECTOR_INTERCHANGE_CONTRACT,
  createDirectorInterchangeManifest,
  createEmptyDirectorInterchangeProject,
  getDirectorProjectTimeline,
  parseDirectorInterchangeManifest,
  readInterchangeBytes,
  stableDirectorInterchangeId,
  type DirectorInterchangeImportResult,
  type DirectorInterchangeManifest,
} from "./contract";

export const DIRECTOR_OTIO_ADAPTER = "director-otio-v1" as const;
/** MIME type for OTIOZ (zipped OTIO) archives. */
export const DIRECTOR_OTIOZ_MIME_TYPE = "application/vnd.pixar.opentimelineio+zip";
/** The expected content file path inside an OTIOZ archive. */
export const DIRECTOR_OTIOZ_CONTENT_PATH = "content.otio";
/** The version file path inside an OTIOZ archive. */
export const DIRECTOR_OTIOZ_VERSION_PATH = "version.txt";

// Real-world OTIOZ exports (for example from DaVinci Resolve) commonly reach
// hundreds of megabytes and hundreds of entries because they bundle media.
// Director only reads content.otio into memory, so the limits stay generous
// and there is no entry-count cap.
/** Size limits for OTIO interchange payloads. */
export const DIRECTOR_OTIO_LIMITS = Object.freeze({
  /** Maximum bytes for raw OTIO JSON. */
  maxJsonBytes: 32 * 1024 * 1024,
  /** Maximum bytes for an OTIOZ archive. */
  maxArchiveBytes: 512 * 1024 * 1024,
});

/** An OTIO rational time value (frame number + rate). */
export interface OtioRationalTime {
  OTIO_SCHEMA: "RationalTime.1";
  value: number;
  rate: number;
}

/** An OTIO time range (start + duration). */
export interface OtioTimeRange {
  OTIO_SCHEMA: "TimeRange.1";
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

/** Director-specific metadata embedded in the OTIO timeline root. */
export interface DirectorOtioMetadata {
  adapter: typeof DIRECTOR_OTIO_ADAPTER;
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  stableId: string;
  frameRate: { numerator: number; denominator: number };
  dropFrame: boolean;
  startTimecode: string;
  frameStart: number;
  frameEnd: number;
  manifest?: DirectorInterchangeManifest;
}

/** The typed OTIO Timeline structure Director produces. */
export interface DirectorOtioTimeline {
  OTIO_SCHEMA: "Timeline.1";
  name: string;
  global_start_time: OtioRationalTime;
  metadata: { director: DirectorOtioMetadata };
  tracks: {
    OTIO_SCHEMA: "Stack.1";
    name: string;
    metadata: Record<string, unknown>;
    children: Array<{
      OTIO_SCHEMA: "Track.1";
      name: string;
      kind: "Video";
      metadata: { director: { stableId: string } };
      children: Array<Record<string, unknown>>;
    }>;
  };
}

/** Options for exporting a Director project to OTIO. */
export interface ExportDirectorOtioOptions {
  /** Embed a validated project manifest so non-editorial project state survives a round-trip. */
  embedProject?: boolean;
  pretty?: boolean;
}

/** Options for importing an OTIO timeline into Director. */
export interface ImportDirectorOtioOptions {
  /** Optional base project to merge into. */
  baseProject?: DirectorProject;
  /** Fallback frame rate when the OTIO document doesn't declare one. */
  fallbackRate?: DirectorFrameRateInput;
}

interface DirectorClipMetadata {
  adapter: typeof DIRECTOR_OTIO_ADAPTER;
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  stableId: string;
  scriptBeatId: string;
  cameraId: string | null;
  shotSize: DirectorStoryboardShot["shotSize"];
  movement: DirectorStoryboardShot["movement"];
  action: string;
}

interface ParsedTrackItem {
  schema: string;
  value: Record<string, unknown>;
}

/**
 * Creates an OTIO RationalTime value.
 *
 * @param value - The frame number.
 * @param rate - The frame rate.
 * @returns A RationalTime OTIO object.
 */
export function rationalTime(value: number, rate: number): OtioRationalTime {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate };
}

/**
 * Creates an OTIO TimeRange value.
 *
 * @param start - Start frame.
 * @param duration - Duration in frames.
 * @param rate - The frame rate.
 * @returns A TimeRange OTIO object.
 */
export function timeRange(start: number, duration: number, rate: number): OtioTimeRange {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: rationalTime(start, rate),
    duration: rationalTime(duration, rate),
  };
}

function distributeShotsAcrossTracks(shots: readonly DirectorStoryboardShot[]) {
  const tracks: Array<{ lastFrame: number; shots: DirectorStoryboardShot[] }> = [];
  [...shots]
    .sort(
      (left, right) =>
        left.frameStart - right.frameStart || left.frameEnd - right.frameEnd || left.id.localeCompare(right.id),
    )
    .forEach((shot) => {
      const target = tracks.find((track) => track.lastFrame < shot.frameStart);
      if (target) {
        target.shots.push(shot);
        target.lastFrame = Math.max(target.lastFrame, shot.frameEnd);
      } else {
        tracks.push({ lastFrame: shot.frameEnd, shots: [shot] });
      }
    });
  return tracks;
}

/**
 * Exports a Director project as an OTIO timeline object.
 *
 * Shots are distributed across overlapping tracks to avoid time conflicts.
 * Each shot is represented as a Clip with a MissingReference to the Director
 * camera that captured it.
 *
 * @param project - The Director project to export.
 * @param options - Export options including manifest embedding.
 * @returns A typed OTIO Timeline object.
 */
export function exportDirectorProjectToOtio(
  project: DirectorProject,
  options: ExportDirectorOtioOptions = {},
): DirectorOtioTimeline {
  const timeline = getDirectorProjectTimeline(project);
  const timebase = normalizeDirectorTimebase(timeline.timebase, timeline.fps);
  const rate = frameRateToNumber(timebase.rate);
  const storyboard = project.storyboard ?? { version: 1 as const, title: "Director timeline", logline: "", shots: [] };
  const trackGroups = distributeShotsAcrossTracks(storyboard.shots);
  if (!trackGroups.length) trackGroups.push({ lastFrame: timeline.frameStart - 1, shots: [] });
  const globalStart =
    parseSmpteTimecode(timebase.startTimecode, timebase.rate, {
      dropFrame: timebase.dropFrame,
    })?.frame ?? 0;

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: storyboard.title || "Director timeline",
    global_start_time: rationalTime(globalStart, rate),
    metadata: {
      director: {
        adapter: DIRECTOR_OTIO_ADAPTER,
        contract: DIRECTOR_INTERCHANGE_CONTRACT,
        stableId: stableDirectorInterchangeId("timeline", storyboard.title || "director"),
        frameRate: { ...timebase.rate },
        dropFrame: timebase.dropFrame,
        startTimecode: timebase.startTimecode,
        frameStart: Math.round(timeline.frameStart),
        frameEnd: Math.round(timeline.frameEnd),
        ...(options.embedProject === false ? {} : { manifest: createDirectorInterchangeManifest(project) }),
      },
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Director picture stack",
      metadata: {},
      children: trackGroups.map((group, trackIndex) => {
        const children: Array<Record<string, unknown>> = [];
        let cursor = Math.round(timeline.frameStart);
        group.shots.forEach((shot, shotIndex) => {
          const frameStart = Math.round(shot.frameStart);
          const frameEnd = Math.max(frameStart, Math.round(shot.frameEnd));
          if (frameStart > cursor) {
            children.push({
              OTIO_SCHEMA: "Gap.1",
              name: "Gap",
              source_range: timeRange(0, frameStart - cursor, rate),
              metadata: {},
            });
          }
          const stableId = shot.id || stableDirectorInterchangeId("shot", `${trackIndex}:${shotIndex}:${shot.title}`);
          const scriptBeatId = shot.scriptBeatId ?? stableDirectorInterchangeId("beat", stableId);
          const metadata: DirectorClipMetadata = {
            adapter: DIRECTOR_OTIO_ADAPTER,
            contract: DIRECTOR_INTERCHANGE_CONTRACT,
            stableId,
            scriptBeatId,
            cameraId: shot.cameraId,
            shotSize: shot.shotSize,
            movement: shot.movement,
            action: shot.action,
          };
          children.push({
            OTIO_SCHEMA: "Clip.2",
            name: shot.title || `Shot ${shotIndex + 1}`,
            source_range: timeRange(0, frameEnd - frameStart + 1, rate),
            media_reference: {
              OTIO_SCHEMA: "MissingReference.1",
              name: shot.cameraId ? `Director camera ${shot.cameraId}` : "Director offline shot",
              metadata: { director: { cameraId: shot.cameraId } },
            },
            metadata: { director: metadata },
          });
          cursor = frameEnd + 1;
        });
        if (cursor <= timeline.frameEnd) {
          children.push({
            OTIO_SCHEMA: "Gap.1",
            name: "Gap",
            source_range: timeRange(0, Math.round(timeline.frameEnd) - cursor + 1, rate),
            metadata: {},
          });
        }
        return {
          OTIO_SCHEMA: "Track.1" as const,
          name: `Director Video ${trackIndex + 1}`,
          kind: "Video" as const,
          metadata: { director: { stableId: `director-video-${trackIndex + 1}` } },
          children,
        };
      }),
    },
  };
}

/**
 * Serializes a Director project to an OTIO JSON string.
 *
 * @param project - The Director project to export.
 * @param options - Export options.
 * @returns A formatted OTIO JSON string.
 */
export function serializeDirectorProjectToOtio(project: DirectorProject, options: ExportDirectorOtioOptions = {}) {
  return `${JSON.stringify(exportDirectorProjectToOtio(project, options), null, options.pretty === false ? undefined : 2)}\n`;
}

/**
 * Extracts the OTIO schema name (the part before the first dot in OTIO_SCHEMA).
 *
 * Used to identify the type of an OTIO object without parsing the version suffix.
 *
 * @param value - An OTIO object with an OTIO_SCHEMA property.
 * @returns The schema name (e.g. "Timeline", "Clip", "Gap") or empty string.
 */
export function schemaName(value: Record<string, unknown>) {
  return typeof value.OTIO_SCHEMA === "string" ? value.OTIO_SCHEMA.split(".", 1)[0] : "";
}

function durationInFrames(value: unknown, targetRate: number) {
  if (!isRecord(value)) return null;
  const duration = isRecord(value.duration) ? value.duration : null;
  if (!duration || typeof duration.value !== "number" || !Number.isFinite(duration.value)) return null;
  const sourceRate =
    typeof duration.rate === "number" && Number.isFinite(duration.rate) && duration.rate > 0
      ? duration.rate
      : targetRate;
  return Math.max(0, Math.round((duration.value / sourceRate) * targetRate));
}

/**
 * Extracts Director-specific metadata from an OTIO object's metadata block.
 *
 * @param value - An OTIO object with a metadata property.
 * @returns The `director` sub-object or null.
 */
export function metadataFor(value: Record<string, unknown>) {
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  return metadata && isRecord(metadata.director) ? metadata.director : null;
}

function collectTracks(stack: unknown): Array<Record<string, unknown>> {
  if (!isRecord(stack)) return [];
  if (schemaName(stack) === "Track") return [stack];
  const children = Array.isArray(stack.children) ? stack.children : [];
  return children.flatMap((child) => collectTracks(child));
}

function normalizeShotEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Parses an OTIO source (string or pre-parsed value) into a plain object.
 *
 * Validates the JSON string against the size limit before parsing.
 *
 * @param source - An OTIO JSON string or a pre-parsed value.
 * @returns The parsed OTIO object.
 * @throws If the source exceeds the size limit or is invalid JSON.
 */
export function parseOtioSource(source: string | unknown) {
  if (typeof source !== "string") return source;
  if (new TextEncoder().encode(source).byteLength > DIRECTOR_OTIO_LIMITS.maxJsonBytes) {
    throw new Error("OTIO JSON exceeds the Director interchange size limit");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("OTIO JSON could not be parsed");
  }
}

/**
 * Imports a Director project from an OTIO timeline.
 *
 * Converts OTIO tracks, clips, and gaps into Director storyboard shots.
 * Audio tracks are filtered out. Director-specific metadata is preserved
 * for round-trip fidelity.
 *
 * @param source - An OTIO JSON string or pre-parsed value.
 * @param options - Import options including base project and fallback rate.
 * @returns The imported project and any warnings.
 */
export function importDirectorProjectFromOtio(
  source: string | unknown,
  options: ImportDirectorOtioOptions = {},
): DirectorInterchangeImportResult {
  const root = parseOtioSource(source);
  if (!isRecord(root) || schemaName(root) !== "Timeline" || !isRecord(root.tracks)) {
    throw new Error("OTIO root must be an OpenTimelineIO Timeline with a tracks Stack");
  }
  const warnings: string[] = [];
  const rootDirector = metadataFor(root);
  let embeddedProject: DirectorProject | null = null;
  if (rootDirector?.manifest !== undefined) {
    try {
      embeddedProject = parseDirectorInterchangeManifest(rootDirector.manifest).project;
    } catch (error) {
      warnings.push(`Embedded Director project was ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const rationalRate = isRecord(rootDirector?.frameRate)
    ? normalizeDirectorFrameRate(
        {
          numerator: Number(rootDirector.frameRate.numerator),
          denominator: Number(rootDirector.frameRate.denominator),
        },
        options.fallbackRate ?? 24,
      )
    : normalizeDirectorFrameRate(
        isRecord(root.global_start_time) && typeof root.global_start_time.rate === "number"
          ? root.global_start_time.rate
          : (options.fallbackRate ?? 24),
      );
  const rate = frameRateToNumber(rationalRate);
  const dropFrame = Boolean(rootDirector?.dropFrame);
  const globalStartFrame =
    isRecord(root.global_start_time) && typeof root.global_start_time.value === "number"
      ? Math.round((root.global_start_time.value / (Number(root.global_start_time.rate) || rate)) * rate)
      : 0;
  const startTimecode =
    typeof rootDirector?.startTimecode === "string"
      ? rootDirector.startTimecode
      : formatSmpteTimecode(globalStartFrame, rationalRate, { dropFrame });
  const timebase = normalizeDirectorTimebase({ rate: rationalRate, dropFrame, startTimecode }, rationalRate);
  const directorFrameStart = rootDirector?.frameStart;
  const timelineFrameStart = Number.isSafeInteger(directorFrameStart) ? Number(directorFrameStart) : 0;
  const tracks = collectTracks(root.tracks).filter((track) => track.kind !== "Audio");
  const shots: DirectorStoryboardShot[] = [];
  const usedIds = new Set<string>();
  let maximumDuration = 0;

  tracks.forEach((track, trackIndex) => {
    const children = Array.isArray(track.children) ? track.children : [];
    let cursor = 0;
    children.forEach((rawItem, itemIndex) => {
      if (!isRecord(rawItem)) return;
      const item: ParsedTrackItem = { schema: schemaName(rawItem), value: rawItem };
      if (item.schema === "Transition") {
        warnings.push(`Track ${trackIndex + 1} transition ${itemIndex + 1} was ignored; Director imports cuts only.`);
        return;
      }
      const duration = durationInFrames(rawItem.source_range, rate);
      if (duration === null) {
        warnings.push(`Track ${trackIndex + 1} item ${itemIndex + 1} has no valid source range and was skipped.`);
        return;
      }
      if (item.schema === "Gap") {
        cursor += duration;
        return;
      }
      if (item.schema !== "Clip") {
        cursor += duration;
        warnings.push(`Unsupported OTIO ${item.schema || "item"} was treated as a gap.`);
        return;
      }
      if (duration < 1) {
        warnings.push(`Zero-duration clip ${String(rawItem.name ?? itemIndex + 1)} was skipped.`);
        return;
      }
      const metadata = metadataFor(rawItem);
      const fallbackId = stableDirectorInterchangeId(
        "shot",
        `${String(rawItem.name ?? "clip")}:${trackIndex}:${itemIndex}:${cursor}`,
      );
      let id = typeof metadata?.stableId === "string" && metadata.stableId ? metadata.stableId : fallbackId;
      if (usedIds.has(id)) {
        const duplicate = id;
        id = stableDirectorInterchangeId("shot", `${duplicate}:${trackIndex}:${itemIndex}`);
        warnings.push(`Duplicate OTIO stable ID ${duplicate} was remapped to ${id}.`);
      }
      usedIds.add(id);
      const frameStart = timelineFrameStart + cursor;
      const frameEnd = frameStart + duration - 1;
      shots.push({
        id,
        scriptBeatId:
          typeof metadata?.scriptBeatId === "string" && metadata.scriptBeatId
            ? metadata.scriptBeatId
            : stableDirectorInterchangeId("beat", id),
        title:
          typeof rawItem.name === "string" && rawItem.name.trim() ? rawItem.name.trim() : `Shot ${shots.length + 1}`,
        cameraId: typeof metadata?.cameraId === "string" ? metadata.cameraId : null,
        frameStart,
        frameEnd,
        shotSize: normalizeShotEnum(metadata?.shotSize, ["wide", "full", "medium", "close-up", "insert"], "medium"),
        movement: normalizeShotEnum(
          metadata?.movement,
          ["static", "pan", "tilt", "push-in", "pull-out", "dolly", "arc"],
          "static",
        ),
        action: typeof metadata?.action === "string" ? metadata.action : "Action imported from OpenTimelineIO.",
      });
      cursor += duration;
    });
    maximumDuration = Math.max(maximumDuration, cursor);
  });

  const project = structuredClone(
    embeddedProject ?? options.baseProject ?? createEmptyDirectorInterchangeProject(timebase),
  );
  const storyboard: DirectorStoryboard = {
    version: 1,
    title:
      typeof root.name === "string" && root.name.trim()
        ? root.name.trim()
        : (project.storyboard?.title ?? "Imported timeline"),
    logline: project.storyboard?.logline ?? "",
    shots: shots.sort((left, right) => left.frameStart - right.frameStart || left.id.localeCompare(right.id)),
  };
  const directorFrameEnd = rootDirector?.frameEnd;
  const explicitEnd = Number.isSafeInteger(directorFrameEnd) ? Number(directorFrameEnd) : null;
  const frameEnd = maximumDuration > 0 ? timelineFrameStart + maximumDuration - 1 : (explicitEnd ?? timelineFrameStart);
  const previousTimeline = getDirectorProjectTimeline(project);
  project.storyboard = storyboard;
  project.scene.timeline = {
    ...previousTimeline,
    fps: rate,
    timebase,
    frameStart: timelineFrameStart,
    frameEnd: Math.max(timelineFrameStart, frameEnd),
    currentFrame: Math.max(timelineFrameStart, Math.min(frameEnd, previousTimeline.currentFrame)),
  };
  return { project, warnings };
}

/**
 * Validates that a ZIP entry path is safe (no absolute paths, backslashes, or traversal).
 *
 * @param path - The ZIP entry path to validate.
 * @throws If the path is unsafe.
 */
export function assertSafeZipEntry(path: string) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`Unsafe OTIOZ entry path: ${path}`);
  }
}

/**
 * Creates an OTIOZ (zipped OTIO) archive from OTIO JSON content.
 *
 * The archive contains a version file and the content.otio entry,
 * matching the Pixar OTIOZ specification.
 *
 * @param content - The OTIO JSON string to package.
 * @returns The OTIOZ archive bytes.
 */
export function createDirectorOtiozArchive(content: string) {
  const zip = new JSZip();
  const date = new Date("1980-01-01T00:00:00.000Z");
  zip.file(DIRECTOR_OTIOZ_VERSION_PATH, "OTIOZ_VERSION: 1.0.0\n", { date, compression: "STORE" });
  zip.file(DIRECTOR_OTIOZ_CONTENT_PATH, content, {
    date,
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return zip.generateAsync({ type: "uint8array", platform: "UNIX", compression: "DEFLATE" });
}

/**
 * Exports a Director project to an OTIOZ archive.
 *
 * @param project - The Director project to export.
 * @param options - Export options.
 * @returns The OTIOZ archive bytes.
 */
export async function exportDirectorProjectToOtioz(project: DirectorProject, options: ExportDirectorOtioOptions = {}) {
  return createDirectorOtiozArchive(serializeDirectorProjectToOtio(project, options));
}

/**
 * Reads the content.otio string from an OTIOZ archive.
 *
 * Validates the archive size, CRC, and entry path safety before extracting.
 *
 * @param source - The OTIOZ archive bytes.
 * @returns The content.otio string.
 * @throws If the archive is too large, corrupted, or missing the content entry.
 */
export async function readDirectorOtiozContent(source: Uint8Array | ArrayBuffer | Blob) {
  const bytes = await readInterchangeBytes(source);
  if (bytes.byteLength > DIRECTOR_OTIO_LIMITS.maxArchiveBytes) {
    throw new Error("OTIOZ archive exceeds the Director interchange size limit");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    throw new Error("OTIOZ archive could not be opened or failed its CRC check");
  }
  const content = zip.file(DIRECTOR_OTIOZ_CONTENT_PATH);
  if (!content) throw new Error(`OTIOZ archive is missing ${DIRECTOR_OTIOZ_CONTENT_PATH}`);
  // Only the entry that is actually read gets the path check; sibling media
  // entries with Windows-style or exotic paths never leave the archive.
  const originalName = (content as typeof content & { unsafeOriginalName?: string }).unsafeOriginalName;
  assertSafeZipEntry(originalName ?? content.name);
  return content.async("string");
}

/**
 * Imports a Director project from an OTIOZ archive.
 *
 * Extracts the content.otio entry and delegates to {@link importDirectorProjectFromOtio}.
 *
 * @param source - The OTIOZ archive bytes.
 * @param options - Import options.
 * @returns The imported project and any warnings.
 */
export async function importDirectorProjectFromOtioz(
  source: Uint8Array | ArrayBuffer | Blob,
  options: ImportDirectorOtioOptions = {},
) {
  return importDirectorProjectFromOtio(await readDirectorOtiozContent(source), options);
}
