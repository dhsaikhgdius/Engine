import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DIRECTOR_DISPLAY_COLOR_BT709, ffmpegColorArgs } from "../../../packages/protocol/src/directorColorMetadata";

/** Local media assembly for the film pipeline: frame extraction, cut detection and concatenation. */

/**
 * Spawns ffmpeg with the given arguments and returns the captured stderr
 * on success. The process receives -hide_banner and -nostdin automatically.
 *
 * @param ffmpegPath - Path to the ffmpeg binary.
 * @param args - Arguments to pass after the automatic flags.
 * @param signal - Optional abort signal to kill the child process.
 * @returns The last 64 KB of stderr from the ffmpeg process.
 * @throws When ffmpeg exits with a non-zero code — the error message includes the tail of stderr.
 */
export function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal) {
  return new Promise<string>((resolveRun, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-nostdin", ...args], {
      signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-64_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveRun(stderr);
      else reject(new Error(stderr.trim().slice(-2_000) || `FFmpeg exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * Grabs a still slightly before the end of the clip (robust against truncated final packets).
 *
 * @param ffmpegPath - Path to the ffmpeg binary.
 * @param videoPath - Path to the source video.
 * @param outputPath - Destination path for the extracted frame PNG.
 * @param signal - Optional abort signal.
 * @returns The outputPath, confirming the frame was written.
 */
export async function extractLastFrame(
  ffmpegPath: string,
  videoPath: string,
  outputPath: string,
  signal?: AbortSignal,
) {
  await mkdir(dirname(outputPath), { recursive: true });
  await runFfmpeg(
    ffmpegPath,
    ["-loglevel", "error", "-sseof", "-0.3", "-i", videoPath, "-frames:v", "1", "-update", "1", "-y", outputPath],
    signal,
  );
  return outputPath;
}

/**
 * Finds the first hard cut in a transition video and extracts the frame just
 * after it — the new camera angle synthesized by the video model. Falls back
 * to the last frame when no cut is detected.
 *
 * @param ffmpegPath - Path to the ffmpeg binary.
 * @param videoPath - Path to the transition video.
 * @param outputPath - Destination path for the extracted frame PNG.
 * @param options.sceneThreshold - Scene-change detection threshold (default 0.3).
 * @param options.signal - Optional abort signal.
 * @returns The outputPath, confirming the frame was written.
 */
export async function extractFrameAfterFirstCut(
  ffmpegPath: string,
  videoPath: string,
  outputPath: string,
  options: { sceneThreshold?: number; signal?: AbortSignal } = {},
) {
  const threshold = options.sceneThreshold ?? 0.3;
  const stderr = await runFfmpeg(
    ffmpegPath,
    [
      "-loglevel",
      "info",
      "-i",
      videoPath,
      "-vf",
      `select='gt(scene,${threshold})',metadata=print`,
      "-an",
      "-f",
      "null",
      "-",
    ],
    options.signal,
  );
  const cutTimes = [...stderr.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!cutTimes.length) return extractLastFrame(ffmpegPath, videoPath, outputPath, options.signal);
  const cutAt = Math.min(...cutTimes);
  await mkdir(dirname(outputPath), { recursive: true });
  await runFfmpeg(
    ffmpegPath,
    [
      "-loglevel",
      "error",
      "-ss",
      // A small offset past the detected cut avoids blended transition frames.
      (cutAt + 0.05).toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-y",
      outputPath,
    ],
    options.signal,
  );
  return outputPath;
}

/**
 * Re-encodes and concatenates clips into a single output. Clip codecs and
 * dimensions may differ across providers, so this always re-encodes rather
 * than stream-copying. The output is tagged as Rec.709.
 *
 * @param ffmpegPath - Path to the ffmpeg binary.
 * @param inputPaths - Ordered list of input clip paths (at least one).
 * @param outputPath - Destination path for the concatenated video.
 * @param signal - Optional abort signal.
 * @returns The outputPath, confirming the concat was written.
 * @throws When inputPaths is empty.
 */
export async function concatVideos(
  ffmpegPath: string,
  inputPaths: readonly string[],
  outputPath: string,
  signal?: AbortSignal,
) {
  if (!inputPaths.length) throw new Error("concatVideos requires at least one input clip");
  await mkdir(dirname(outputPath), { recursive: true });
  const listPath = `${outputPath}.concat.txt`;
  const escaped = inputPaths.map((path) => `file '${resolve(path).replaceAll("'", "'\\''")}'`).join("\n");
  await writeFile(listPath, `${escaped}\n`, "utf8");
  await runFfmpeg(
    ffmpegPath,
    [
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      // Provider clips are usually untagged; tag the assembled film explicitly
      // as Rec.709 so players and NLEs stop guessing at its color.
      ...ffmpegColorArgs(DIRECTOR_DISPLAY_COLOR_BT709),
      "-c:a",
      "aac",
      "-y",
      outputPath,
    ],
    signal,
  );
  return outputPath;
}
