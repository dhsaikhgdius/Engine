import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

export interface MediaTranscriptionChunk {
  bytes: Uint8Array;
  fileName: string;
  mimeType: "audio/mpeg";
  offsetSec: number;
  durationSec: number;
}

export interface MediaTranscriptionChunkerInput {
  source: Uint8Array;
  sourceFileName: string;
  durationSec: number;
  chunkDurationSec: number;
  ffmpegPath: string;
  signal: AbortSignal;
}

export type MediaTranscriptionChunker = (input: MediaTranscriptionChunkerInput) => Promise<MediaTranscriptionChunk[]>;

function sourceExtension(fileName: string) {
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".media";
}

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
