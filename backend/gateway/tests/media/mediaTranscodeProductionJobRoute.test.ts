import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { handleProductionJobRoute, type ProductionJobRouteDependencies } from "../../routes/productionJobRoutes";
import type { MediaProcessRunner } from "../../media/mediaProcessRunner";
import { MediaTranscodeExecutor } from "../../media/mediaTranscodeExecutor";
import { MediaTranscodeInputStore } from "../../media/mediaTranscodeInputStore";

// Integration coverage for the productionJobRoutes wiring: staging raw bytes
// through /api/production-jobs/media-inputs and dispatching media.* kinds to
// the injected ffmpeg executor. Lives next to the executor because the route
// test file itself belongs to another workstream.
describe("media transcode production job route wiring", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const SOURCE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const SOURCE_SHA256 = createHash("sha256").update(SOURCE_BYTES).digest("hex");

  const fakeRunner: MediaProcessRunner = async (command, args) => {
    if (command.endsWith("ffprobe")) {
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify({
          format: { duration: "6.0" },
          streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360 }],
        }),
        stderr: "",
        timedOut: false,
      };
    }
    await writeFile(args.at(-1)!, Buffer.from("fake-output"));
    return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
  };

  async function harness() {
    const directory = await mkdtemp(join(tmpdir(), "director-media-route-"));
    directories.push(directory);
    const store = new ProductionJobStore(directory);
    const inputs = new MediaTranscodeInputStore(directory, 64);
    const executor = new MediaTranscodeExecutor({
      store,
      inputs,
      config: { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", timeoutMs: 60_000 },
      runProcess: fakeRunner,
    });
    const writes: Array<{ status: number; body: unknown }> = [];
    let payload: unknown;
    const dependencies: ProductionJobRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      createJobId: () => "media-route-job",
      mediaTranscode: executor,
      mediaInputs: inputs,
    };
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    return {
      store,
      writes,
      dependencies,
      response,
      setPayload: (value: unknown) => {
        payload = value;
      },
    };
  }

  function jsonRequest(method: string) {
    return { method } as IncomingMessage;
  }

  function rawRequest(bytes: Uint8Array, contentType: string) {
    return Object.assign(Readable.from([Buffer.from(bytes)]), {
      method: "POST",
      headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
    }) as unknown as IncomingMessage;
  }

  async function waitForStatus(store: ProductionJobStore, jobId: string, status: string) {
    for (let index = 0; index < 100; index += 1) {
      const job = await store.get(jobId);
      if (job?.status === status) return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${jobId} to become ${status}`);
  }

  it("stages raw media bytes and runs an enqueued media.proxy job to completion", async () => {
    const context = await harness();

    expect(
      await handleProductionJobRoute(
        rawRequest(SOURCE_BYTES, "video/mp4"),
        context.response,
        new URL(`http://director.test/api/production-jobs/media-inputs?sha256=${SOURCE_SHA256}`),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[0]).toMatchObject({
      status: 200,
      body: {
        input: {
          sourceMediaId: `media-input:sha256:${SOURCE_SHA256}`,
          sha256: SOURCE_SHA256,
          bytes: SOURCE_BYTES.byteLength,
        },
      },
    });

    context.setPayload({
      kind: "media.proxy",
      idempotencyKey: "media-proxy-route-key",
      input: { sourceMediaId: `media-input:sha256:${SOURCE_SHA256}` },
    });
    await handleProductionJobRoute(
      jsonRequest("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 202, body: { job: { kind: "media.proxy" } } });

    const completed = await waitForStatus(context.store, "media-route-job", "succeeded");
    expect(completed.artifacts.map((artifact) => artifact.fileName)).toEqual(["proxy.mp4", "poster.jpg", "probe.json"]);
    expect(completed.artifact?.fileName).toBe("proxy.mp4");
  });

  it("rejects staging uploads with wrong content type, bad query, or oversize bodies", async () => {
    const context = await harness();

    await handleProductionJobRoute(
      rawRequest(SOURCE_BYTES, "text/plain"),
      context.response,
      new URL(`http://director.test/api/production-jobs/media-inputs?sha256=${SOURCE_SHA256}`),
      context.dependencies,
    );
    expect(context.writes.at(-1)?.status).toBe(415);

    await handleProductionJobRoute(
      rawRequest(SOURCE_BYTES, "video/mp4"),
      context.response,
      new URL("http://director.test/api/production-jobs/media-inputs?sha256=not-a-hash"),
      context.dependencies,
    );
    expect(context.writes.at(-1)?.status).toBe(400);

    const oversize = new Uint8Array(65);
    await handleProductionJobRoute(
      rawRequest(oversize, "video/mp4"),
      context.response,
      new URL(`http://director.test/api/production-jobs/media-inputs?sha256=${SOURCE_SHA256}`),
      context.dependencies,
    );
    expect(context.writes.at(-1)?.status).toBe(413);
  });

  it("rejects media jobs without an executor and fails queued legacy jobs during listing", async () => {
    const context = await harness();
    delete context.dependencies.mediaTranscode;
    delete context.dependencies.mediaInputs;

    await handleProductionJobRoute(
      rawRequest(SOURCE_BYTES, "video/mp4"),
      context.response,
      new URL(`http://director.test/api/production-jobs/media-inputs?sha256=${SOURCE_SHA256}`),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 503, body: { code: "media_inputs_not_configured" } });

    context.setPayload({
      kind: "media.transcode",
      idempotencyKey: "media-transcode-route-key",
      input: { sourceMediaId: `media-input:sha256:${SOURCE_SHA256}`, targetMimeType: "video/mp4" },
    });
    await handleProductionJobRoute(
      jsonRequest("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 503,
      body: {
        code: "media_transcode_executor_unavailable",
        retryable: false,
      },
    });
    expect(await context.store.get("media-route-job")).toBeNull();

    await context.store.enqueue({
      kind: "media.proxy",
      idempotencyKey: "legacy-queued-media-job",
      input: { sourceMediaId: `media-input:sha256:${SOURCE_SHA256}` },
      createId: () => "legacy-queued-media-job",
    });
    context.writes.length = 0;
    await handleProductionJobRoute(
      jsonRequest("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(await context.store.get("legacy-queued-media-job")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("DIRECTOR_FFMPEG_PATH"),
      attempts: [
        expect.objectContaining({
          error: expect.objectContaining({
            code: "media_transcode_executor_unavailable",
            retryable: false,
          }),
        }),
      ],
    });
  });
});
