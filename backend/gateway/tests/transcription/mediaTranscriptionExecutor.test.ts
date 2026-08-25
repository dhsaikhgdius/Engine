import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { directorMediaTranscriptSchema } from "../../../../packages/protocol/src/mediaTranscriptionProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { MediaTranscriptionExecutor, type MediaTranscriptionExecutorOptions } from "../../transcription/mediaTranscriptionExecutor";
import { MediaTranscriptionInputStore } from "../../transcription/mediaTranscriptionInputStore";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(
  fetcher: typeof fetch,
  options: {
    durationSec?: number;
    chunker?: MediaTranscriptionExecutorOptions["chunker"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "director-transcription-"));
  directories.push(directory);
  const source = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const store = new ProductionJobStore(directory);
  const inputs = new MediaTranscriptionInputStore(directory, 1024 * 1024);
  await inputs.put(source, sourceSha256);
  const job = await store.enqueue({
    kind: "media.transcribe",
    input: {
      sourceMediaId: "creative-media:audio:sha256:test",
      sourceSha256,
      sourceMimeType: "audio/wav",
      sourceFileName: "dialogue.wav",
      durationSec: options.durationSec ?? 2,
      model: "whisper-test",
      language: "en",
    },
    idempotencyKey: "transcription-test-key",
    provider: "openai-compatible",
    sourceRevisions: { source: sourceSha256 },
    createId: () => "transcription-job-test",
  });
  const executor = new MediaTranscriptionExecutor({
    store,
    inputs,
    config: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9000/v1",
      apiKey: "test-secret",
      model: "whisper-test",
      timeoutMs: 5_000,
      chunkThresholdSec: 15 * 60,
      chunkDurationSec: 10 * 60,
      chunkConcurrency: 2,
      ffmpegPath: "ffmpeg",
    },
    fetcher,
    chunker: options.chunker,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  return { directory, executor, job, store };
}

describe("MediaTranscriptionExecutor", () => {
  it("returns the same terminal job when cancellation is retried", async () => {
    const { executor, job } = await fixture(vi.fn() as typeof fetch);
    const cancelled = await executor.cancel(job.id);
    const replay = await executor.cancel(job.id);

    expect(cancelled).toMatchObject({ id: job.id, status: "cancelled" });
    expect(replay).toEqual(cancelled);
  });

  it("persists verified transcript JSON and WebVTT artifacts", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer test-secret" });
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(
        JSON.stringify({
          text: "Hello world.",
          language: "en",
          duration: 2,
          segments: [
            { start: 0, end: 0.9, text: "Hello" },
            { start: 1, end: 2, text: "world." },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const { executor, job, store } = await fixture(fetcher);

    const completed = await executor.execute(job);

    expect(completed).toMatchObject({ status: "succeeded", progress: 1 });
    expect(completed?.artifacts.map((artifact) => artifact.role)).toEqual(["transcript", "captions"]);
    const transcriptArtifact = completed!.artifacts[0]!;
    const transcriptBytes = await store.readArtifact(completed!, transcriptArtifact);
    expect(createHash("sha256").update(transcriptBytes).digest("hex")).toBe(transcriptArtifact.sha256);
    const parsedTranscript = directorMediaTranscriptSchema.parse(JSON.parse(transcriptBytes.toString("utf8")));
    expect(parsedTranscript).toMatchObject({
      jobId: job.id,
      sourceMediaId: "creative-media:audio:sha256:test",
      text: "Hello world.",
    });
    expect(parsedTranscript.segments).toEqual(
      expect.arrayContaining([expect.objectContaining({ startSec: 0, endSec: 0.9, text: "Hello" })]),
    );
    const vtt = await readFile(store.artifactFilePath(job.id, job.attempts[0]!.id, "captions.vtt"), "utf8");
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("records provider failures without reflecting response bodies or credentials", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ error: "provider-body-secret" }), { status: 429 }),
    ) as typeof fetch;
    const { executor, job } = await fixture(fetcher);

    const failed = await executor.execute(job);

    expect(failed).toMatchObject({ status: "failed", error: "Transcription provider returned HTTP 429" });
    expect(JSON.stringify(failed)).not.toContain("provider-body-secret");
    expect(JSON.stringify(failed)).not.toContain("test-secret");
    expect(failed?.attempts.at(-1)?.error).toMatchObject({ code: "provider_http_429", retryable: true });
  });

  it("chunks long media with bounded concurrency and merges provider timestamps onto the source timeline", async () => {
    let active = 0;
    let maximumActive = 0;
    let requestIndex = 0;
    const fetcher = vi.fn(async () => {
      const index = requestIndex;
      requestIndex += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(
        JSON.stringify({
          text: `Chunk ${index + 1}`,
          language: "en",
          duration: index === 2 ? 50 : 600,
          segments: [{ start: 1, end: index === 2 ? 49 : 10, text: `Line ${index + 1}`, speaker: "Host" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const chunker = vi.fn(async () =>
      [0, 1, 2].map((index) => ({
        bytes: new Uint8Array([index + 1]),
        fileName: `chunk-${String(index).padStart(5, "0")}.mp3`,
        mimeType: "audio/mpeg" as const,
        offsetSec: index * 600,
        durationSec: index === 2 ? 50 : 600,
      })),
    );
    const { executor, job, store } = await fixture(fetcher, { durationSec: 1_250, chunker });

    const completed = await executor.execute(job);
    const transcriptBytes = await store.readArtifact(completed!, completed!.artifacts[0]!);
    const parsedTranscript = directorMediaTranscriptSchema.parse(JSON.parse(transcriptBytes.toString("utf8")));

    expect(completed).toMatchObject({ status: "succeeded", progress: 1 });
    expect(chunker).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
    expect(parsedTranscript.text).toBe("Chunk 1\nChunk 2\nChunk 3");
    expect(parsedTranscript.segments).toEqual([
      expect.objectContaining({ startSec: 1, endSec: 10, speaker: "Host" }),
      expect.objectContaining({ startSec: 601, endSec: 610, speaker: "Host" }),
      expect.objectContaining({ startSec: 1_201, endSec: 1_249, speaker: "Host" }),
    ]);
  });
});
