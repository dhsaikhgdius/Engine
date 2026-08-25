import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { handleMediaTranscriptionRoute } from "../../routes/mediaTranscriptionRoutes";
import { MediaTranscriptionExecutor } from "../../transcription/mediaTranscriptionExecutor";
import { MediaTranscriptionInputStore } from "../../transcription/mediaTranscriptionInputStore";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function request(method: string, bytes = new Uint8Array(), contentType = "audio/wav") {
  const stream = Readable.from([Buffer.from(bytes)]) as IncomingMessage;
  stream.method = method;
  stream.headers = { "content-type": contentType, "content-length": String(bytes.byteLength) };
  return stream;
}

function responseRecorder() {
  const writes: Array<{ status: number; body: unknown }> = [];
  return {
    response: {} as ServerResponse,
    json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
    writes,
  };
}

async function dependencies() {
  const directory = await mkdtemp(join(tmpdir(), "director-transcription-route-"));
  directories.push(directory);
  const store = new ProductionJobStore(directory);
  const inputs = new MediaTranscriptionInputStore(directory, 1024 * 1024);
  const executor = new MediaTranscriptionExecutor({
    store,
    inputs,
    config: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9000/v1",
      apiKey: undefined,
      model: "whisper-test",
      timeoutMs: 5_000,
      chunkThresholdSec: 15 * 60,
      chunkDurationSec: 10 * 60,
      chunkConcurrency: 2,
      ffmpegPath: "ffmpeg",
    },
    fetcher: vi.fn(
      async () =>
        new Response(
          JSON.stringify({ text: "Line one", duration: 1, segments: [{ start: 0, end: 1, text: "Line one" }] }),
        ),
    ) as typeof fetch,
  });
  return {
    store,
    inputs,
    executor,
    readBody: async () => ({}),
    config: {
      provider: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:9000/v1",
      model: "whisper-test",
      maxInputBytes: 1024 * 1024,
      chunkThresholdSec: 15 * 60,
      chunkDurationSec: 10 * 60,
      chunkConcurrency: 2,
    },
    createJobId: () => "transcription-route-job",
  };
}

describe("media transcription routes", () => {
  it("reports the adaptive long-media execution policy", async () => {
    const recorder = responseRecorder();
    const deps = await dependencies();

    await handleMediaTranscriptionRoute(
      request("GET"),
      recorder.response,
      new URL("http://director.test/api/transcription/capabilities"),
      { ...deps, json: recorder.json },
    );

    expect(recorder.writes).toEqual([
      {
        status: 200,
        body: expect.objectContaining({
          supportsLongMedia: true,
          longMediaStrategy: "adaptive-chunking",
          chunkThresholdSec: 900,
          chunkDurationSec: 600,
          chunkConcurrency: 2,
        }),
      },
    ]);
  });

  it("accepts raw media, verifies its digest, and launches a durable job", async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5]);
    const sha256 = createHash("sha256").update(source).digest("hex");
    const recorder = responseRecorder();
    const deps = await dependencies();
    const query = new URLSearchParams({
      source_media_id: "creative-media:audio:sha256:test",
      source_sha256: sha256,
      file_name: "take.wav",
      duration_seconds: "1",
      idempotency_key: "route-submit-key",
    });

    expect(
      await handleMediaTranscriptionRoute(
        request("POST", source),
        recorder.response,
        new URL(`http://director.test/api/transcription/jobs?${query}`),
        { ...deps, json: recorder.json },
      ),
    ).toBe(true);
    expect(recorder.writes[0]).toMatchObject({ status: 202, body: { job: { kind: "media.transcribe" } } });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const job = await deps.store.get("transcription-route-job");
      if (job?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await deps.store.get("transcription-route-job")).toMatchObject({
      status: "succeeded",
      artifacts: [{ role: "transcript" }, { role: "captions" }],
    });
  });

  it("rejects non-media uploads before reading or enqueuing them", async () => {
    const source = new Uint8Array([1]);
    const recorder = responseRecorder();
    const deps = await dependencies();
    const query = new URLSearchParams({
      source_media_id: "media-1",
      source_sha256: createHash("sha256").update(source).digest("hex"),
      file_name: "payload.txt",
      idempotency_key: "route-invalid-key",
    });

    await handleMediaTranscriptionRoute(
      request("POST", source, "text/plain"),
      recorder.response,
      new URL(`http://director.test/api/transcription/jobs?${query}`),
      { ...deps, json: recorder.json },
    );

    expect(recorder.writes).toEqual([
      { status: 415, body: { message: "Transcription source must be audio or video" } },
    ]);
    expect(await deps.store.list(["media.transcribe"])).toEqual([]);
  });
});
