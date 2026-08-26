import { spawn } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FILM_TIMELINE_OMITTED_SHOT_LIMIT,
  filmTimelineExportReceiptSchema,
  type FilmRun,
  type FilmTimelineExportReceipt,
  type FilmTimelineOmittedShot,
} from "../../../packages/protocol/src/filmPipelineProtocol";
import {
  buildFilmTimelineOtio,
  FILM_TIMELINE_OTIO_CONTRACT_V2,
  type ClipAudioInfo,
  type ClipMediaInfo,
} from "../../../packages/protocol/src/filmTimelineOtio";
import { isRecord } from "../../../packages/protocol/src/primitives";

/**
 * Film timeline export.
 *
 * Turns a completed film run into an OpenTimelineIO timeline — one video
 * track with one clip per rendered shot, plus, when the probe reports audio
 * details, an "A1" audio track and per-shot markers — so the assembled film
 * can be re-edited in Director's Video Editor or any OTIO-aware NLE.
 *
 * The OTIO JSON itself is produced by the pure builder in
 * packages/protocol/src/filmTimelineOtio.ts (shared with the frontend
 * interchange tests, which validate it against the real Video Editor
 * importer). This module adds the node-side parts: ffprobe media probing and
 * writing `<runDirectory>/timeline.otio`.
 *
 * Audio sources are resolved per shot: the dubbed sibling written by the
 * audio pipeline (`video_with_audio.mp4`) wins when it exists and probes
 * cleanly; otherwise the clip's own embedded audio stream is referenced.
 * Audio problems degrade to a video-only clip with a warning — they never
 * fail the export, matching the run's failure-tolerant contract. Probes that
 * only return `{ durationSec, fps }` (the pre-v2 shape) keep producing the
 * byte-identical v1 timeline.
 */

export { buildFilmTimelineOtio, FILM_TIMELINE_OTIO_CONTRACT_V2, type ClipAudioInfo, type ClipMediaInfo };

/** All streams are requested (not just v:0) so one probe reports video and audio together. */
const FFPROBE_ARGS = [
  "-v",
  "error",
  "-show_entries",
  "stream=codec_type,r_frame_rate,duration,start_time",
  "-show_entries",
  "format=duration,start_time",
  "-of",
  "json",
] as const;

/** Probe result; startSec and audio only appear when ffprobe output carries them (v2 inputs). */
export type ProbedMediaInfo = {
  /** Clip duration in seconds. */
  durationSec: number;
  /** Video frame rate. */
  fps: number;
  /** Media start time in seconds (negative container starts clamp to 0). */
  startSec?: number;
  /** First audio stream; null when the file has none; omitted by legacy probes. */
  audio?: { startSec?: number; durationSec?: number } | null;
};

/** Rendered shot clip location used by the render coordinator, relative to the run directory. */
function shotVideoRelativePath(sceneIdx: number, shotIdx: number) {
  return `scene_${sceneIdx}/shots/${shotIdx}/video.mp4`;
}

/** Dubbed sibling written by FilmAudioMixer when the shot has dialogue. */
function shotDubbedVideoRelativePath(sceneIdx: number, shotIdx: number) {
  return `scene_${sceneIdx}/shots/${shotIdx}/video_with_audio.mp4`;
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses an ffprobe rational like "24000/1001", "24/1" or "24".
 *
 * @param value - The r_frame_rate string or number from ffprobe.
 * @returns Frames per second, or null when the value is unparseable.
 */
export function parseFrameRateFraction(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/.exec(text);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function parsePositiveSeconds(value: unknown): number | null {
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** ffprobe start_time: "0.083333" parses, "N/A" is null, tiny negative container starts clamp to 0. */
function parseStartSeconds(value: unknown): number | null {
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

/**
 * Parses `ffprobe -of json` output. Stream duration wins, format duration is
 * the fallback. Output with codec_type-tagged streams (the current
 * FFPROBE_ARGS) additionally yields startSec plus the first audio stream
 * (`audio: null` when the file has none); legacy single-video-stream output
 * keeps returning just `{ durationSec, fps }`.
 *
 * @param stdout - Raw ffprobe JSON output.
 * @param sourcePath - The probed file path (for error messages).
 * @returns Parsed media info.
 * @throws When ffprobe output is invalid JSON or missing required fields.
 */
export function parseFfprobeMediaInfo(stdout: string, sourcePath = "media"): ProbedMediaInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe emitted invalid JSON for ${sourcePath}`);
  }
  const root = isRecord(parsed) ? parsed : {};
  const streams = (Array.isArray(root.streams) ? root.streams : []).filter(isRecord);
  const typed = streams.some((candidate) => typeof candidate.codec_type === "string");
  const stream = (typed ? streams.find((candidate) => candidate.codec_type === "video") : streams[0]) ?? {};
  const format: Record<string, unknown> = isRecord(root.format) ? root.format : {};
  const fps = parseFrameRateFraction(stream.r_frame_rate);
  if (fps === null) throw new Error(`ffprobe reported no usable video frame rate for ${sourcePath}`);
  const durationSec = parsePositiveSeconds(stream.duration) ?? parsePositiveSeconds(format.duration);
  if (durationSec === null) throw new Error(`ffprobe reported no usable duration for ${sourcePath}`);
  const info: ProbedMediaInfo = { durationSec, fps };
  const startSec = parseStartSeconds(stream.start_time) ?? parseStartSeconds(format.start_time);
  if (startSec !== null) info.startSec = startSec;
  if (typed) {
    const audioStream = streams.find((candidate) => candidate.codec_type === "audio");
    if (!audioStream) {
      info.audio = null;
    } else {
      const audio: NonNullable<ProbedMediaInfo["audio"]> = {};
      const audioStartSec = parseStartSeconds(audioStream.start_time);
      if (audioStartSec !== null) audio.startSec = audioStartSec;
      const audioDurationSec = parsePositiveSeconds(audioStream.duration) ?? parsePositiveSeconds(format.duration);
      if (audioDurationSec !== null) audio.durationSec = audioDurationSec;
      info.audio = audio;
    }
  }
  return info;
}

/**
 * Creates a media probe function backed by an ffprobe binary.
 *
 * @param ffprobePath - Path to the ffprobe binary (usually "ffprobe").
 * @returns A function that probes a video path and returns ProbedMediaInfo.
 */
export function createFfprobeClipProbe(ffprobePath: string): (videoPath: string) => Promise<ProbedMediaInfo> {
  return async (videoPath) => {
    const stdout = await new Promise<string>((resolveProbe, reject) => {
      const child = spawn(ffprobePath, [...FFPROBE_ARGS, videoPath], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolveProbe(output);
        else {
          reject(
            new Error(stderr.trim().slice(-2_000) || `ffprobe exited with code ${code ?? "unknown"} for ${videoPath}`),
          );
        }
      });
    });
    return parseFfprobeMediaInfo(stdout, videoPath);
  };
}

function clipAudioInfo(path: string, stream: NonNullable<ProbedMediaInfo["audio"]>, file: ProbedMediaInfo) {
  const audio: ClipAudioInfo = { path };
  const startSec = stream.startSec ?? file.startSec;
  if (startSec !== undefined) audio.startSec = startSec;
  const durationSec = stream.durationSec ?? file.durationSec;
  if (durationSec !== undefined) audio.durationSec = durationSec;
  return audio;
}

/**
 * Picks the shot's editorial audio source: the dubbed sibling when it exists
 * and probes with an audio stream, else the clip's own embedded audio, else
 * null (silent shot). Dubbed-file problems warn and fall through instead of
 * failing the export.
 */
async function resolveShotAudio(input: {
  runDirectory: string;
  sceneIdx: number;
  shotIdx: number;
  videoRelativePath: string;
  videoInfo: ProbedMediaInfo;
  probe: (mediaPath: string) => Promise<ProbedMediaInfo>;
  warn: (message: string) => void;
  signal?: AbortSignal;
}): Promise<ClipAudioInfo | null> {
  const dubbedRelativePath = shotDubbedVideoRelativePath(input.sceneIdx, input.shotIdx);
  if (await pathExists(join(input.runDirectory, dubbedRelativePath))) {
    try {
      const dubbed = await input.probe(join(input.runDirectory, dubbedRelativePath));
      if (dubbed.audio) return clipAudioInfo(dubbedRelativePath, dubbed.audio, dubbed);
      input.warn(`Dubbed clip ${dubbedRelativePath} has no decodable audio stream; using the shot's own soundtrack`);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      input.warn(`Probing dubbed clip ${dubbedRelativePath} failed; using the shot's own soundtrack: ${detail}`);
    }
  }
  if (input.videoInfo.audio) return clipAudioInfo(input.videoRelativePath, input.videoInfo.audio, input.videoInfo);
  return null;
}

/** Result of one timeline export: the written path plus the typed export receipt. */
export type FilmTimelineExportResult = {
  /** Absolute path of the written `timeline.otio`. */
  outputPath: string;
  /** Typed export receipt: planned/exported counts plus per-shot omissions. */
  receipt: FilmTimelineExportReceipt;
};

/**
 * Probes every shot video and writes the timeline to
 * <runDirectory>/timeline.otio. Serialization is plain JSON.stringify over
 * the builder's fixed key order, so identical inputs stay byte-identical.
 * Audio warnings go to onWarning (console.warn by default) — audio issues
 * degrade the affected shots to video-only instead of failing the export.
 * Planned shots whose rendered clip is missing are dropped from the timeline
 * and recorded as typed `omittedShots` on the returned receipt, so a partial
 * editorial handoff never masquerades as a complete one.
 */
export async function exportFilmTimeline(input: {
  run: FilmRun;
  runDirectory: string;
  probe: (videoPath: string) => Promise<ProbedMediaInfo>;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<FilmTimelineExportResult> {
  const { run, runDirectory, probe, signal } = input;
  const warn = input.onWarning ?? ((message: string) => console.warn(`[film-timeline-export] ${message}`));
  const clips: ClipMediaInfo[] = [];
  const omittedShots: FilmTimelineOmittedShot[] = [];
  let shotCount = 0;
  for (const scene of [...run.scenes].sort((left, right) => left.idx - right.idx)) {
    if (!scene.shotSpecs) {
      throw new Error(`Scene ${scene.idx} of run ${run.id} has no shot specs; plan the run before exporting`);
    }
    for (const spec of [...scene.shotSpecs].sort((left, right) => left.idx - right.idx)) {
      signal?.throwIfAborted();
      shotCount += 1;
      const relativePath = shotVideoRelativePath(scene.idx, spec.idx);
      const absolutePath = join(runDirectory, relativePath);
      // A missing clip only drops that shot; the omission becomes a typed
      // receipt record instead of a silent skip.
      if (!(await pathExists(absolutePath))) {
        omittedShots.push({
          sceneIdx: scene.idx,
          shotIdx: spec.idx,
          code: "clip_missing",
          reason: `Rendered clip ${relativePath} was missing from the run directory at export time`,
        });
        continue;
      }
      const info = await probe(absolutePath);
      const clip: ClipMediaInfo = {
        sceneIdx: scene.idx,
        shotIdx: spec.idx,
        videoPath: relativePath,
        durationSec: info.durationSec,
        fps: info.fps,
      };
      if (info.startSec !== undefined) clip.startSec = info.startSec;
      // Legacy probes without audio awareness keep the v1 export contract.
      if (info.audio !== undefined) {
        clip.audio = await resolveShotAudio({
          runDirectory,
          sceneIdx: scene.idx,
          shotIdx: spec.idx,
          videoRelativePath: relativePath,
          videoInfo: info,
          probe,
          warn,
          signal,
        });
      }
      clips.push(clip);
    }
  }
  if (shotCount === 0) throw new Error(`Run ${run.id} has no shots to export`);
  if (clips.length === 0) {
    throw new Error(`Run ${run.id} has no rendered shot videos under ${runDirectory}; nothing to export`);
  }
  const timeline = buildFilmTimelineOtio({ run, clips });
  const outputPath = join(runDirectory, "timeline.otio");
  await writeFile(outputPath, `${JSON.stringify(timeline, null, 2)}\n`, { encoding: "utf8", signal });
  const receipt = filmTimelineExportReceiptSchema.parse({
    shotCount,
    clipCount: clips.length,
    omittedShotCount: omittedShots.length,
    omittedShots: omittedShots.slice(0, FILM_TIMELINE_OMITTED_SHOT_LIMIT),
  });
  return { outputPath, receipt };
}
