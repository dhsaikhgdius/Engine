import type { DirectorMediaTranscript } from "../../../../../../packages/protocol/src/mediaTranscriptionProtocol";
import {
  dispatchCreativeWorkspaceOperations,
  type CreativeWorkspaceOperationInput,
} from "../../../agent/dispatchCreativeWorkspaceOperations";
import { useDirectorCreativeWorkspaceStore } from "./directorWorkspaceStore";

/** A single timed caption cue with start time, end time, and display text. */
export interface DirectorCaptionCue {
  /** Start time of the caption in seconds. */
  startSec: number;
  /** End time of the caption in seconds. */
  endSec: number;
  /** The caption text to display during this time window. */
  text: string;
}

/** Virtual Video title/caption media ids (`text:` / `text:caption:…`) need no Gallery asset. */
export function isCreativeVirtualTextMediaId(mediaId: string): boolean {
  return mediaId.startsWith("text:");
}

/** Shared contract clip names are capped at 200 chars (protocol `nameSchema`). */
const CREATIVE_CLIP_NAME_MAX = 200;
const DEFAULT_VIRTUAL_TEXT_SOURCE_DURATION_SEC = 60 * 60;
const CAPTION_DEFAULT_POSITION_Y = 360;

const TIMECODE = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{3})/;

function parseTimecode(value: string) {
  const match = value.trim().match(TIMECODE);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (![hours, minutes, seconds, milliseconds].every(Number.isFinite) || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/**
 * Parses a WebVTT or SRT caption file into an array of timed caption cues.
 *
 * Accepts WebVTT (with optional `WEBVTT` header) and SRT-style blocks.
 * Strips HTML tags from cue text and enforces a configurable maximum cue
 * count. Returns an empty array for empty or unparseable input.
 *
 * @param contents - The raw caption file text.
 * @param maximumCues - Maximum number of cues to return (default 2000).
 * @returns Parsed caption cues, ordered as they appear in the file.
 */
export function parseDirectorCaptionFile(contents: string, maximumCues = 2_000): DirectorCaptionCue[] {
  const normalized = contents
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!normalized) return [];
  const blocks = normalized.replace(/^WEBVTT[^\n]*\n+/, "").split(/\n{2,}/);
  const cues: DirectorCaptionCue[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [rawStart, rawEndWithSettings] = lines[timingIndex]!.split("-->");
    const rawEnd = rawEndWithSettings?.trim().split(/\s+/)[0] ?? "";
    const startSec = parseTimecode(rawStart ?? "");
    const endSec = parseTimecode(rawEnd);
    const text = lines
      .slice(timingIndex + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (startSec === null || endSec === null || endSec <= startSec || !text) continue;
    cues.push({ startSec, endSec, text: text.slice(0, 4_000) });
    if (cues.length >= maximumCues) break;
  }
  return cues;
}

/**
 * Converts a media transcript's segments into caption cues.
 *
 * Each transcript segment becomes a cue with the same timing and text.
 * Segments beyond `maximumCues` are silently dropped.
 *
 * @param transcript - The media transcript to convert.
 * @param maximumCues - Maximum number of cues to return (default 2000).
 * @returns Caption cues derived from the transcript segments.
 */
export function directorMediaTranscriptToCaptionCues(
  transcript: DirectorMediaTranscript,
  maximumCues = 2_000,
): DirectorCaptionCue[] {
  return transcript.segments.slice(0, maximumCues).map((segment) => ({
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
  }));
}

function snapCaptionSeconds(seconds: number, fps: number) {
  const safeFps = Math.max(1, Number.isFinite(fps) ? fps : 24);
  return Math.round(Math.max(0, seconds) * safeFps) / safeFps;
}

/**
 * Compile caption cues into shared `edit.clip.add` ops (optional preceding
 * `edit.track.add`). Callers that need Agent parity should prefer
 * `insertDirectorCaptionCuesIntoTimeline`, which dispatches this batch.
 */
export function compileDirectorCaptionCueInsertOperations(
  cues: readonly DirectorCaptionCue[],
  options: {
    fps?: number;
    offsetSec?: number;
    sourceMediaId?: string;
    transcriptionJobId?: string;
    trackId?: string;
  } = {},
): {
  operations: CreativeWorkspaceOperationInput[];
  trackId: string | null;
  virtualMediaPrefix: string;
  alreadyPresent: boolean;
  needsTrackCreate: boolean;
} {
  const normalized = cues.filter((cue) => cue.text.trim() && cue.endSec > cue.startSec).slice(0, 2_000);
  if (!normalized.length) {
    return { operations: [], trackId: null, virtualMediaPrefix: "", alreadyPresent: false, needsTrackCreate: false };
  }
  const store = useDirectorCreativeWorkspaceStore.getState();
  const fps = options.fps ?? store.editSettings.fps;
  const offset = Math.max(0, options.offsetSec ?? 0);
  const sourceToken = encodeURIComponent(options.sourceMediaId ?? "manual").slice(0, 180);
  const jobToken = encodeURIComponent(options.transcriptionJobId ?? Date.now().toString(36)).slice(0, 180);
  const virtualMediaPrefix = `text:caption:${sourceToken}:${jobToken}:`;
  const existing = store.editTracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.mediaId.startsWith(virtualMediaPrefix));
  if (options.transcriptionJobId && existing.length) {
    return {
      operations: [],
      trackId: store.editTracks.find((track) => track.clips.some((clip) => existing.includes(clip)))?.id ?? null,
      virtualMediaPrefix,
      alreadyPresent: true,
      needsTrackCreate: false,
    };
  }
  let track = options.trackId
    ? store.editTracks.find(
        (candidate) => candidate.id === options.trackId && candidate.kind === "video" && !candidate.locked,
      )
    : store.editTracks.find((candidate) => candidate.id === "video-2" && !candidate.locked);
  track ??= [...store.editTracks].reverse().find((candidate) => candidate.kind === "video" && !candidate.locked);
  const needsTrackCreate = !track;
  const trackIdForOps = track?.id ?? "@caption_track";
  const operations: CreativeWorkspaceOperationInput[] = [];
  if (needsTrackCreate) {
    operations.push({ op: "edit.track.add", kind: "video", name: "字幕" });
  }
  normalized.forEach((cue, index) => {
    const startSec = snapCaptionSeconds(offset + cue.startSec, fps);
    const durationSec = Math.max(0.1, snapCaptionSeconds(cue.endSec - cue.startSec, fps));
    operations.push({
      op: "edit.clip.add",
      track_id: trackIdForOps,
      media_id: `${virtualMediaPrefix}${index}`,
      name: cue.text.trim().slice(0, CREATIVE_CLIP_NAME_MAX),
      start_sec: startSec,
      duration_sec: durationSec,
      source_duration_sec: DEFAULT_VIRTUAL_TEXT_SOURCE_DURATION_SEC,
      position_y: CAPTION_DEFAULT_POSITION_Y,
    });
  });
  return {
    operations,
    trackId: track?.id ?? null,
    virtualMediaPrefix,
    alreadyPresent: false,
    needsTrackCreate,
  };
}

/** Adds timed text clips via shared creative ops and preserves source identity in virtual media IDs. */
export function insertDirectorCaptionCuesIntoTimeline(
  cues: readonly DirectorCaptionCue[],
  options: {
    fps?: number;
    offsetSec?: number;
    sourceMediaId?: string;
    transcriptionJobId?: string;
    trackId?: string;
  } = {},
) {
  const compiled = compileDirectorCaptionCueInsertOperations(cues, options);
  if (compiled.alreadyPresent) {
    return { inserted: 0, trackId: compiled.trackId, alreadyPresent: true as const };
  }
  if (!compiled.operations.length) return { inserted: 0, trackId: null as string | null };

  // When a caption track must be created, Agents resolve `@caption_track` via
  // execute_batch save_as. The UI dispatch helper does not expose save_as, so
  // create the track first, then batch the clip adds (two undo units only when
  // every unlocked video track is missing — default timelines keep video-2).
  let trackId = compiled.trackId;
  let clipOperations = compiled.operations;
  if (compiled.needsTrackCreate) {
    const trackReceipt = dispatchCreativeWorkspaceOperations({
      op: "edit.track.add",
      kind: "video",
      name: "字幕",
    });
    if (!trackReceipt.ok) return { inserted: 0, trackId: null };
    const createdTrack = trackReceipt.execution.result.track as { id?: string } | undefined;
    trackId = typeof createdTrack?.id === "string" ? createdTrack.id : null;
    if (!trackId) return { inserted: 0, trackId: null };
    clipOperations = compiled.operations
      .filter((operation) => operation.op === "edit.clip.add")
      .map((operation) => (operation.op === "edit.clip.add" ? { ...operation, track_id: trackId! } : operation));
  }

  const receipt = dispatchCreativeWorkspaceOperations(clipOperations);
  if (!receipt.ok) return { inserted: 0, trackId: trackId ?? null };
  const inserted = useDirectorCreativeWorkspaceStore
    .getState()
    .editTracks.flatMap((track) => track.clips)
    .filter((clip) => clip.mediaId.startsWith(compiled.virtualMediaPrefix)).length;
  const resolvedTrackId =
    trackId ??
    useDirectorCreativeWorkspaceStore
      .getState()
      .editTracks.find((track) => track.clips.some((clip) => clip.mediaId.startsWith(compiled.virtualMediaPrefix)))
      ?.id ??
    null;
  return { inserted, trackId: resolvedTrackId, alreadyPresent: false as const };
}
