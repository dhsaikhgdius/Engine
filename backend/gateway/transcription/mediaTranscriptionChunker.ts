import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

/**
 * FFmpeg-backed chunking for media transcription: long audio/video sources
 * are re-encoded into compact mono 16 kHz MP3 segments so each provider
 * request stays within upload and duration limits. All work happens inside a
 * per-invocation temp directory that is removed in a finally block, so
 * neither success nor failure leaks intermediate files.
 */

/** One transcription-ready audio segment with its position in the source. */
export interface MediaTranscriptionChunk {
  bytes: Uint8Array;
  fileName: string;
  mimeType: "audio/mpeg";
  /** Start of this chunk relative to the source, in seconds. */
  offsetSec: number;
  durationSec: number;
}

/** Source bytes plus the chunking parameters and the ffmpeg binary to use. */
export interface MediaTranscriptionChunkerInput {
  source: Uint8Array;
  sourceFileName: string;
  durationSec: number;
  chunkDurationSec: number;
  ffmpegPath: string;
  signal: AbortSignal;
}

/** Splits one media source into transcription chunks, ordered by offset. */
export type MediaTranscriptionChunker = (input: MediaTranscriptionChunkerInput) => Promise<MediaTranscriptionChunk[]>;

// Keep the source's extension when it looks sane (ffmpeg uses it for format
// detection); otherwise fall back to a neutral one.
function sourceExtension(fileName: string) {
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".media";
}

// Runs ffmpeg with a bounded stderr tail retained for the failure message.
function runFfmpeg(path: string, args: string[], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(path, args, {
      signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `FFmpeg exited with code ${code ?? "unknown"}`));
    });
  });
}

/** Converts long audio/video into compact, speech-oriented chunks for bounded provider requests. */
export const splitMediaForTranscription: MediaTranscriptionChunker = async (input) => {
  const directory = await mkdtemp(join(tmpdir(), "director-transcription-chunks-"));
  try {
    const sourcePath = join(directory, `source${sourceExtension(input.sourceFileName)}`);
    await writeFile(sourcePath, input.source);
    // One ffmpeg pass: take the first audio stream, downmix to mono 16 kHz
    // (speech-recognition friendly), and segment on chunk boundaries with
    // timestamps reset so every chunk decodes independently.
    await runFfmpeg(
      input.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        sourcePath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        "-f",
        "segment",
        "-segment_time",
        String(input.chunkDurationSec),
        "-reset_timestamps",
        "1",
        join(directory, "chunk-%05d.mp3"),
      ],
      input.signal,
    );
    const fileNames = (await readdir(directory)).filter((fileName) => /^chunk-\d{5}\.mp3$/.test(fileName)).sort();
    if (!fileNames.length) throw new Error("FFmpeg did not produce any transcription chunks");
    return Promise.all(
      fileNames.map(async (fileName, index) => ({
        bytes: new Uint8Array(await readFile(join(directory, fileName))),
        fileName,
        mimeType: "audio/mpeg" as const,
        offsetSec: index * input.chunkDurationSec,
        durationSec: Math.min(input.chunkDurationSec, input.durationSec - index * input.chunkDurationSec),
      })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
