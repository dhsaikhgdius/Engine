import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  productionJobSpecSchema,
  transitionProductionJob,
} from "../../../../packages/protocol/src/productionJobProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import type { MediaProcessResult, MediaProcessRunner } from "../../media/mediaProcessRunner";
import {
  MediaTranscodeExecutor,
  MediaTranscodeJobError,
  mediaTranscodeScaleFilter,
  posterSeekSeconds,
  resolveMediaTranscodeParams,
  type MediaTranscodeJobSpec,
} from "../../media/mediaTranscodeExecutor";
import { MediaInputIntegrityError, MediaTranscodeInputStore } from "../../media/mediaTranscodeInputStore";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const SOURCE_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const SOURCE_SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const PROXY_BYTES = Buffer.from("fake-proxy-mp4-bytes");
const POSTER_BYTES = Buffer.from("fake-poster-jpg-bytes");

function probePayload() {
  return {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.000000", size: "1024", bit_rate: "800000" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "24/1" },
      { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
  };
}

type FakeCall = { command: string; args: string[] };

function fakeRunner(
  overrides: Partial<Record<"ffprobe" | "ffmpeg", (args: string[]) => Promise<MediaProcessResult>>> = {},
) {
  const calls: FakeCall[] = [];
  const runner: MediaProcessRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "/fake/ffprobe") {
      if (overrides.ffprobe) return overrides.ffprobe([...args]);
      return ok(JSON.stringify(probePayload()));
    }
    if (overrides.ffmpeg) return overrides.ffmpeg([...args]);
    const outputPath = args.at(-1)!;
    await writeFile(outputPath, args.includes("-frames:v") ? POSTER_BYTES : PROXY_BYTES);
    return ok("");
  };
  return { runner, calls };
}

function ok(stdout: string): MediaProcessResult {
  return { code: 0, signal: null, stdout, stderr: "", timedOut: false };
}

async function fixture(options: {
  kind: "media.transcode" | "media.proxy";
  input: Record<string, unknown>;
  runner: MediaProcessRunner;
}) {
  const directory = await mkdtemp(join(tmpdir(), "director-media-transcode-test-"));
  directories.push(directory);
  const store = new ProductionJobStore(directory);
  const inputs = new MediaTranscodeInputStore(directory, 1024 * 1024);
  await inputs.put(SOURCE_BYTES, SOURCE_SHA256);
  const job = await store.enqueue({
    kind: options.kind,
    input: options.input,
    idempotencyKey: `media-test-${options.kind}`,
    createId: () => `media-job-${options.kind.replace(".", "-")}`,
  } as Parameters<ProductionJobStore["enqueue"]>[0]);
  const executor = new MediaTranscodeExecutor({
    store,
    inputs,
    config: { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", timeoutMs: 60_000 },
    runProcess: options.runner,
    now: () => new Date("2026-08-13T00:00:00.000Z"),
  });
  return { directory, store, inputs, job, executor };
}

function spec(kind: "media.transcode" | "media.proxy", input: Record<string, unknown>) {
  return productionJobSpecSchema.parse({ kind, input }) as MediaTranscodeJobSpec;
}

function stagedInput(extra: Record<string, unknown> = {}) {
  return { sourceMediaId: `media-input:sha256:${SOURCE_SHA256}`, ...extra };
}

function resolveFailure(kind: "media.transcode" | "media.proxy", input: Record<string, unknown>) {
  try {
    resolveMediaTranscodeParams(spec(kind, input), 60_000);
  } catch (error) {
    return error as MediaTranscodeJobError;
  }
  throw new Error("Expected resolveMediaTranscodeParams to throw");
}

describe("resolveMediaTranscodeParams", () => {
  it("clamps media.proxy heights into the supported envelope and keeps the editorial preset", () => {
    expect(resolveMediaTranscodeParams(spec("media.proxy", stagedInput()), 60_000)).toMatchObject({
      maxHeight: 720,
      maxWidth: 1280,
      videoCrf: 23,
      audioBitrateKbps: 128,
      sourceSha256: SOURCE_SHA256,
    });
    expect(resolveMediaTranscodeParams(spec("media.proxy", stagedInput({ maxHeight: 8192 })), 60_000).maxHeight).toBe(
      2160,
    );
    expect(resolveMediaTranscodeParams(spec("media.proxy", stagedInput({ maxHeight: 64 })), 60_000).maxHeight).toBe(
      360,
    );
  });

  it("reads media.transcode overrides from targetMimeType parameters and clamps them", () => {
    const plain = resolveMediaTranscodeParams(
      spec("media.transcode", stagedInput({ targetMimeType: "video/mp4" })),
      60_000,
    );
    expect(plain).toMatchObject({ maxHeight: 720, maxWidth: null, timeoutMs: 60_000 });
    expect(
      resolveMediaTranscodeParams(
        spec("media.transcode", stagedInput({ targetMimeType: "video/mp4; maxHeight=4000" })),
        60_000,
      ).maxHeight,
    ).toBe(2160);
    expect(
      resolveMediaTranscodeParams(
        spec("media.transcode", stagedInput({ targetMimeType: "video/mp4; maxHeight=100" })),
        60_000,
      ).maxHeight,
    ).toBe(360);
    expect(
      resolveMediaTranscodeParams(
        spec("media.transcode", stagedInput({ targetMimeType: "video/mp4; timeoutSec=1" })),
        60_000,
      ).timeoutMs,
    ).toBe(30_000);
    expect(
      resolveMediaTranscodeParams(
        spec("media.transcode", stagedInput({ targetMimeType: "video/mp4; timeoutSec=999999" })),
        60_000,
      ).timeoutMs,
    ).toBe(4 * 60 * 60_000);
  });

  it("rejects unsupported targets and unstaged source ids as non-retryable", () => {
    expect(resolveFailure("media.transcode", stagedInput({ targetMimeType: "video/webm" }))).toMatchObject({
      code: "unsupported_target",
      retryable: false,
    });
    expect(
      resolveFailure("media.transcode", stagedInput({ targetMimeType: "video/mp4", codec: "hevc" })),
    ).toMatchObject({ code: "unsupported_target" });
    expect(
      resolveFailure("media.transcode", stagedInput({ targetMimeType: "video/mp4", container: "mkv" })),
    ).toMatchObject({ code: "unsupported_target" });
    expect(resolveFailure("media.transcode", stagedInput({ targetMimeType: "video/mp4; frames=all" }))).toMatchObject({
      code: "unsupported_job_input",
    });
    expect(
      resolveFailure("media.transcode", { sourceMediaId: "gallery-item-1", targetMimeType: "video/mp4" }),
    ).toMatchObject({ code: "unsupported_job_input", retryable: false });
    expect(resolveFailure("media.proxy", stagedInput({ codec: "prores" }))).toMatchObject({
      code: "unsupported_target",
    });
  });

  it("builds an even-dimension, never-upscaling scale filter", () => {
    expect(mediaTranscodeScaleFilter({ maxHeight: 720, maxWidth: null })).toBe(
      "scale=trunc(iw*min(1\\,720/ih)/2)*2:trunc(ih*min(1\\,720/ih)/2)*2",
    );
    expect(mediaTranscodeScaleFilter({ maxHeight: 720, maxWidth: 1280 })).toBe(
      "scale=trunc(iw*min(1\\,min(720/ih\\,1280/iw))/2)*2:trunc(ih*min(1\\,min(720/ih\\,1280/iw))/2)*2",
    );
  });

  it("picks a representative poster frame near 1s or 10% of duration", () => {
    expect(posterSeekSeconds(10)).toBe(1);
    expect(posterSeekSeconds(4)).toBe(0.4);
    expect(posterSeekSeconds(null)).toBe(0);
  });
});

describe("MediaTranscodeExecutor", () => {
  it("transcodes a staged source into verified proxy, poster, and probe artifacts", async () => {
    const { runner, calls } = fakeRunner();
    const { executor, job, store } = await fixture({
      kind: "media.transcode",
      input: stagedInput({ targetMimeType: "video/mp4" }),
      runner,
    });

    const completed = await executor.execute(job);

    expect(completed).toMatchObject({ status: "succeeded", progress: 1 });
    expect(completed?.artifacts.map((artifact) => [artifact.role, artifact.fileName, artifact.mimeType])).toEqual([
      ["proxy", "proxy.mp4", "video/mp4"],
      ["poster", "poster.jpg", "image/jpeg"],
      ["probe", "probe.json", "application/json"],
    ]);
    expect(completed?.artifact?.fileName).toBe("proxy.mp4");
    for (const artifact of completed!.artifacts) {
      const bytes = await store.readArtifact(completed!, artifact);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      expect(bytes.byteLength).toBe(artifact.bytes);
    }
    const probeArtifact = completed!.artifacts.at(-1)!;
    const probe = JSON.parse((await store.readArtifact(completed!, probeArtifact)).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(probe).toMatchObject({ version: 1, durationSec: 10, width: 1920, height: 1080 });
    expect(probe.streams).toHaveLength(2);

    expect(calls[0]).toMatchObject({ command: "/fake/ffprobe" });
    const transcodeCall = calls.find((call) => call.args.includes("-movflags"))!;
    expect(transcodeCall.command).toBe("/fake/ffmpeg");
    expect(transcodeCall.args[transcodeCall.args.indexOf("-vf") + 1]).toBe(
      mediaTranscodeScaleFilter({ maxHeight: 720, maxWidth: null }),
    );
    expect(transcodeCall.args).toEqual(
      expect.arrayContaining(["-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", "-b:a", "128k", "+faststart"]),
    );
    const posterCall = calls.find((call) => call.args.includes("-frames:v"))!;
    expect(posterCall.args[posterCall.args.indexOf("-ss") + 1]).toBe("1");
  });

  it("runs media.proxy as the fixed editorial preset of the same pipeline", async () => {
    const { runner, calls } = fakeRunner();
    const { executor, job } = await fixture({
      kind: "media.proxy",
      input: stagedInput({ maxHeight: 8192 }),
      runner,
    });

    const completed = await executor.execute(job);

    expect(completed).toMatchObject({ status: "succeeded" });
    const transcodeCall = calls.find((call) => call.args.includes("-movflags"))!;
    expect(transcodeCall.args[transcodeCall.args.indexOf("-vf") + 1]).toBe(
      mediaTranscodeScaleFilter({ maxHeight: 2160, maxWidth: 1280 }),
    );
    expect(transcodeCall.args).toEqual(expect.arrayContaining(["-crf", "23", "-b:a", "128k"]));
  });

  it("fails without retry when the ffmpeg binary is missing, naming DIRECTOR_FFMPEG_PATH", async () => {
    const { runner } = fakeRunner({
      ffmpeg: () => {
        throw Object.assign(new Error("spawn /fake/ffmpeg ENOENT"), { code: "ENOENT" });
      },
    });
    const { executor, job } = await fixture({
      kind: "media.transcode",
      input: stagedInput({ targetMimeType: "video/mp4" }),
      runner,
    });

    const failed = await executor.execute(job);

    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.attempts.at(-1)?.error).toMatchObject({ code: "ffmpeg_not_configured", retryable: false });
    expect(failed?.attempts.at(-1)?.error?.message).toContain("DIRECTOR_FFMPEG_PATH");
  });

  it("fails without retry when ffprobe is missing, naming DIRECTOR_FFPROBE_PATH", async () => {
    const { runner } = fakeRunner({
      ffprobe: () => {
        throw Object.assign(new Error("spawn /fake/ffprobe ENOENT"), { code: "ENOENT" });
      },
    });
    const { executor, job } = await fixture({
      kind: "media.proxy",
      input: stagedInput(),
      runner,
    });

    const failed = await executor.execute(job);

    expect(failed?.attempts.at(-1)?.error).toMatchObject({ code: "ffprobe_not_configured", retryable: false });
    expect(failed?.attempts.at(-1)?.error?.message).toContain("DIRECTOR_FFPROBE_PATH");
  });

  it("surfaces a bounded stderr tail when ffmpeg exits non-zero", async () => {
    const { runner } = fakeRunner({
      ffmpeg: async () => ({
        code: 1,
        signal: null,
        stdout: "",
        stderr: `${"x".repeat(9_000)}\nTAIL-MARKER`,
        timedOut: false,
      }),
    });
    const { executor, job } = await fixture({
      kind: "media.transcode",
      input: stagedInput({ targetMimeType: "video/mp4" }),
      runner,
    });

    const failed = await executor.execute(job);

    const error = failed?.attempts.at(-1)?.error;
    expect(error).toMatchObject({ code: "ffmpeg_failed", retryable: false });
    expect(error?.message).toContain("TAIL-MARKER");
    expect(error?.message).toContain("exited with code 1");
    expect(error?.message.length).toBeLessThan(1_700);
  });

  it("marks timed-out ffmpeg runs as retryable", async () => {
    const { runner } = fakeRunner({
      ffmpeg: async () => ({ code: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }),
    });
    const { executor, job } = await fixture({
      kind: "media.transcode",
      input: stagedInput({ targetMimeType: "video/mp4" }),
      runner,
    });

    const failed = await executor.execute(job);

    expect(failed?.attempts.at(-1)?.error).toMatchObject({ code: "media_transcode_timeout", retryable: true });
  });

  it("rejects staged sources whose bytes no longer match the recorded hash", async () => {
    const { runner, calls } = fakeRunner();
    const { executor, job, directory } = await fixture({
      kind: "media.transcode",
      input: stagedInput({ targetMimeType: "video/mp4" }),
      runner,
    });
    await writeFile(join(directory, "media-transcode-inputs", `${SOURCE_SHA256}.bin`), Buffer.from("tampered"));

    const failed = await executor.execute(job);

    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.attempts.at(-1)?.error).toMatchObject({ code: "staged_input_invalid", retryable: false });
    expect(calls).toHaveLength(0);
  });

  it("fails with a staging hint when no input was uploaded for the hash", async () => {
    const { runner } = fakeRunner();
    const missingSha = createHash("sha256").update("never-staged").digest("hex");
    const { executor, store } = await fixture({
      kind: "media.transcode",
      input: stagedInput({ targetMimeType: "video/mp4" }),
      runner,
    });
    const job = await store.enqueue({
      kind: "media.transcode",
      input: { sourceMediaId: `media-input:sha256:${missingSha}`, targetMimeType: "video/mp4" },
      idempotencyKey: "media-test-missing",
      createId: () => "media-job-missing",
    });

    const failed = await executor.execute(job);

    expect(failed?.attempts.at(-1)?.error).toMatchObject({ code: "staged_input_missing", retryable: false });
    expect(failed?.attempts.at(-1)?.error?.message).toContain("/api/production-jobs/media-inputs");
  });

  it("executes a fresh attempt after reconciliation re-queues an interrupted job", async () => {
    const { runner } = fakeRunner();
    const { executor, job, store } = await fixture({
      kind: "media.proxy",
      input: stagedInput(),
      runner,
    });
    const running = await store.update(transitionProductionJob(job, "running", { message: "Executor started" }));
    await store.update(transitionProductionJob(running, "outcome_unknown", { error: "gateway restarted" }));
    await store.beginReconciliation(job.id);
    const requeued = await store.resolveReconciliation(job.id, { status: "queued" });
    expect(requeued?.attempts).toHaveLength(2);

    const completed = await executor.execute(requeued!);

    expect(completed).toMatchObject({ status: "succeeded", progress: 1 });
    expect(completed?.artifacts.map((artifact) => artifact.attemptId)).toEqual([
      `${job.id}-attempt-2`,
      `${job.id}-attempt-2`,
      `${job.id}-attempt-2`,
    ]);
  });
});

describe("MediaTranscodeInputStore", () => {
  it("verifies hashes on put and stays idempotent for identical bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-media-input-store-"));
    directories.push(directory);
    const inputs = new MediaTranscodeInputStore(directory, 1024);
    const wrongSha = createHash("sha256").update("other-bytes").digest("hex");

    await expect(inputs.put(SOURCE_BYTES, wrongSha)).rejects.toBeInstanceOf(MediaInputIntegrityError);
    await expect(inputs.put(SOURCE_BYTES, SOURCE_SHA256)).resolves.toEqual({
      sha256: SOURCE_SHA256,
      bytes: SOURCE_BYTES.byteLength,
    });
    // Re-staging the same content after a restart must not throw.
    await expect(inputs.put(SOURCE_BYTES, SOURCE_SHA256)).resolves.toEqual({
      sha256: SOURCE_SHA256,
      bytes: SOURCE_BYTES.byteLength,
    });
    await expect(inputs.verifiedSourcePath(SOURCE_SHA256)).resolves.toContain(`${SOURCE_SHA256}.bin`);
  });
});
