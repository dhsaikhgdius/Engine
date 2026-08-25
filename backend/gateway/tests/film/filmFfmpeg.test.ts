import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { concatVideos, runFfmpeg } from "../../film/filmFfmpeg";

const spawnMock = vi.hoisted(() => vi.fn());

// Both named and default exports so Node builtin CJS interop keeps working.
vi.mock("node:child_process", () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

/** Minimal stand-in for ffmpeg: emits scripted stderr, then exits. */
function fakeChild(plan: { exitCode?: number; stderrText?: string } = {}) {
  const stderr = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void };
  stderr.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & { stderr: typeof stderr };
  child.stderr = stderr;
  queueMicrotask(() => {
    if (plan.stderrText) stderr.emit("data", plan.stderrText);
    child.emit("close", plan.exitCode ?? 0);
  });
  return child as unknown as ChildProcess;
}

function spawnedCall(index = 0) {
  const call = spawnMock.mock.calls[index];
  expect(call).toBeDefined();
  return { command: call[0] as string, args: call[1] as string[] };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
});

describe("runFfmpeg", () => {
  it("prepends -hide_banner/-nostdin and resolves with the captured stderr on exit 0", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stderrText: "frame=42" }));

    const stderr = await runFfmpeg("ffmpeg-bin", ["-loglevel", "error", "-i", "in.mp4", "out.mp4"]);

    expect(stderr).toBe("frame=42");
    const { command, args } = spawnedCall();
    expect(command).toBe("ffmpeg-bin");
    expect(args).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error", "-i", "in.mp4", "out.mp4"]);
  });

  it("rejects with the stderr tail when ffmpeg exits non-zero", async () => {
    spawnMock.mockImplementation(() => fakeChild({ exitCode: 1, stderrText: "Unknown encoder 'libx265'\n" }));

    await expect(runFfmpeg("ffmpeg-bin", ["-i", "in.mp4", "out.mp4"])).rejects.toThrow("Unknown encoder 'libx265'");
  });
});

describe("concatVideos", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function newWorkDirectory() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-ffmpeg-"));
    tempDirs.push(dir);
    return dir;
  }

  it("re-encodes with explicit Rec.709 color tagging on the H.264/yuv420p output", async () => {
    const dir = await newWorkDirectory();
    const output = join(dir, "nested", "film.mp4");

    const result = await concatVideos("ffmpeg-bin", [join(dir, "a.mp4"), join(dir, "b.mp4")], output);

    expect(result).toBe(output);
    const { command, args } = spawnedCall();
    expect(command).toBe("ffmpeg-bin");
    expect(args).toEqual([
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      `${output}.concat.txt`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-color_range",
      "tv",
      "-c:a",
      "aac",
      "-y",
      output,
    ]);
    // The color flags must tag the encode, i.e. come after the encoder/pixel format selection.
    expect(args.indexOf("-color_primaries")).toBeGreaterThan(args.indexOf("-pix_fmt"));
  });

  it("writes the concat list with shell-safe single-quote escaping", async () => {
    const dir = await newWorkDirectory();
    const output = join(dir, "film.mp4");
    const quoted = join(dir, "it's a clip.mp4");

    await concatVideos("ffmpeg-bin", [join(dir, "a.mp4"), quoted], output);

    const list = await readFile(`${output}.concat.txt`, "utf8");
    expect(list).toBe(`file '${join(dir, "a.mp4")}'\nfile '${quoted.replaceAll("'", "'\\''")}'\n`);
  });

  it("requires at least one input clip", async () => {
    const dir = await newWorkDirectory();

    await expect(concatVideos("ffmpeg-bin", [], join(dir, "film.mp4"))).rejects.toThrow(
      "concatVideos requires at least one input clip",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
