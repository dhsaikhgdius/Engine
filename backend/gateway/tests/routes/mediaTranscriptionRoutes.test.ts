import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionProductionJob } from "../../../../packages/protocol/src/productionJobProtocol";
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

async function dependencies(options: { baseUrl?: string | undefined } = {}) {
  const baseUrl = "baseUrl" in options ? options.baseUrl : "http://127.0.0.1:9000/v1";
  const directory = await mkdtemp(join(tmpdir(), "director-transcription-route-"));
  directories.push(directory);
  const store = new ProductionJobStore(directory);
  const inputs = new MediaTranscriptionInputStore(directory, 1024 * 1024);
  const executor = new MediaTranscriptionExecutor({
    store,
    inputs,
    config: {
      provider: "openai-compatible",
      baseUrl,
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
    directory,
    store,
    inputs,
    executor,
    readBody: async () => ({}),
    config: {
      provider: "openai-compatible" as const,
      baseUrl,
      model: "whisper-test",
      maxInputBytes: 1024 * 1024,
      chunkThresholdSec: 15 * 60,
      chunkDurationSec: 10 * 60,
      chunkConcurrency: 2,
    },
    createJobId: () => "transcription-route-job",
  };
}

/** Enqueues a transcription job and drives it to failed so retry routes apply. */
async function enqueueFailedJob(
  store: ProductionJobStore,
  input: { id: string; idempotencyKey: string; sourceSha256: string },
) {
  const job = await store.enqueue({
    kind: "media.transcribe",
    input: {
      sourceMediaId: "creative-media:audio:retry",
      sourceSha256: input.sourceSha256,
      sourceMimeType: "audio/wav",
      sourceFileName: "retry.wav",
      durationSec: 1,
      model: "whisper-test",
    },
    idempotencyKey: input.idempotencyKey,
    provider: "openai-compatible",
    sourceRevisions: { source: input.sourceSha256 },
    createId: () => input.id,
  });
  const running = await store.update(transitionProductionJob(job, "running", { progress: 0.1, message: "running" }));
  return store.update(
    transitionProductionJob(running, "failed", {
      message: "Transcription failed",
      error: "provider unreachable",
      structuredError: { code: "provider_http_500", message: "provider unreachable", retryable: true },
    }),
  );
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
      {
        status: 415,
        body: { code: "unsupported_source_type", message: "Transcription source must be audio or video" },
      },
    ]);
    expect(await deps.store.list(["media.transcribe"])).toEqual([]);
  });

  it("reports an unknown job id with a stable not-found code", async () => {
    const recorder = responseRecorder();
    const deps = await dependencies();

    await handleMediaTranscriptionRoute(
      request("GET"),
      recorder.response,
      new URL("http://director.test/api/transcription/jobs/missing-job"),
      { ...deps, json: recorder.json },
    );

    expect(recorder.writes).toEqual([
      { status: 404, body: { code: "transcription_job_not_found", message: "Transcription job does not exist" } },
    ]);
  });

  it("refuses submit and retry with an explicit code when no provider is configured", async () => {
    const recorder = responseRecorder();
    const deps = await dependencies({ baseUrl: undefined });
    const failed = await enqueueFailedJob(deps.store, {
      id: "unconfigured-retry-job",
      idempotencyKey: "unconfigured-original",
      sourceSha256: "a".repeat(64),
    });

    await handleMediaTranscriptionRoute(
      request("POST", new Uint8Array([1])),
      recorder.response,
      new URL("http://director.test/api/transcription/jobs?source_media_id=m&source_sha256=x&file_name=f&idempotency_key=k-12345678"),
      { ...deps, json: recorder.json },
    );
    await handleMediaTranscriptionRoute(
      request("POST"),
      recorder.response,
      new URL(`http://director.test/api/transcription/jobs/${failed.id}/retry`),
      { ...deps, json: recorder.json },
    );

    expect(recorder.writes).toEqual([
      {
        status: 503,
        body: { code: "transcription_not_configured", message: "No transcription provider is configured" },
      },
      {
        status: 503,
        body: { code: "transcription_not_configured", message: "No transcription provider is configured" },
      },
    ]);
    // The retry never enqueued a job that would sit queued forever.
    expect((await deps.store.list(["media.transcribe"])).map((job) => job.status)).toEqual(["failed"]);
  });

  it("refuses a retry whose cached source bytes are gone without leaking the filesystem path", async () => {
    const recorder = responseRecorder();
    const deps = await dependencies();
    const failed = await enqueueFailedJob(deps.store, {
      id: "missing-source-retry-job",
      idempotencyKey: "missing-source-original",
      sourceSha256: "b".repeat(64),
    });

    await handleMediaTranscriptionRoute(
      request("POST"),
      recorder.response,
      new URL(`http://director.test/api/transcription/jobs/${failed.id}/retry`),
      { ...deps, json: recorder.json },
    );

    expect(recorder.writes).toEqual([
      {
        status: 409,
        body: {
          code: "transcription_source_missing",
          message: "Transcription source bytes are no longer cached on the gateway; upload the source media again",
        },
      },
    ]);
    const body = recorder.writes[0]!.body as { message: string };
    expect(body.message).not.toContain(deps.directory);
    expect((await deps.store.list(["media.transcribe"])).map((job) => job.status)).toEqual(["failed"]);
  });

  it("surfaces a retry idempotency conflict with the existing job id, matching submit", async () => {
    const recorder = responseRecorder();
    const deps = await dependencies();
    const source = new Uint8Array([9, 9, 9]);
    const sha256 = createHash("sha256").update(source).digest("hex");
    await deps.inputs.put(source, sha256);
    const failed = await enqueueFailedJob(deps.store, {
      id: "conflict-retry-job",
      idempotencyKey: "conflict-original",
      sourceSha256: sha256,
    });
    // A different job already owns the key the retry will try to reuse.
    await deps.store.enqueue({
      kind: "media.transcribe",
      input: { ...failed.input, sourceMediaId: "creative-media:audio:other" },
      idempotencyKey: "conflict-reused-key",
      provider: "openai-compatible",
      sourceRevisions: { source: sha256 },
      createId: () => "conflict-owner-job",
    });

    await handleMediaTranscriptionRoute(
      request("POST"),
      recorder.response,
      new URL(`http://director.test/api/transcription/jobs/${failed.id}/retry`),
      { ...deps, readBody: async () => ({ idempotencyKey: "conflict-reused-key" }), json: recorder.json },
    );

    expect(recorder.writes).toEqual([
      {
        status: 409,
        body: expect.objectContaining({
          code: "production_job_idempotency_conflict",
          existingJobId: "conflict-owner-job",
        }),
      },
    ]);
  });
});
