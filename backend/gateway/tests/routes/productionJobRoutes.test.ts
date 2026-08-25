import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionProductionJob } from "../../../../packages/protocol/src/productionJobProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { handleProductionJobRoute, type ProductionJobRouteDependencies } from "../../routes/productionJobRoutes";

describe("production job routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function harness(payload: unknown, id: string) {
    const dir = await mkdtemp(join(tmpdir(), "director-production-job-routes-"));
    tempDirs.push(dir);
    const store = new ProductionJobStore(dir);
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies: ProductionJobRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      createJobId: () => id,
      mediaTranscode: { execute: async () => undefined },
    };
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    return { store, writes, dependencies, response };
  }

  function request(method: string) {
    return { method } as IncomingMessage;
  }

  async function waitForStatus(store: ProductionJobStore, jobId: string, status: string) {
    for (let index = 0; index < 50; index += 1) {
      const job = await store.get(jobId);
      if (job?.status === status) return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${jobId} to become ${status}`);
  }

  it("keeps the existing Canvas enqueue, poll, and primary artifact endpoints working", async () => {
    const context = await harness(
      {
        kind: "canvas.image",
        idempotencyKey: "canvas-route-key",
        input: { nodeId: "node-1", prompt: "A test frame", width: 320, height: 180 },
      },
      "canvas-route-job",
    );
    expect(
      await handleProductionJobRoute(
        request("POST"),
        context.response,
        new URL("http://director.test/api/canvas-jobs"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[0]).toMatchObject({ status: 202, body: { job: { contractVersion: 1 } } });

    const finished = await waitForStatus(context.store, "canvas-route-job", "succeeded");
    expect(finished.artifact?.attemptId).toBe("canvas-route-job-attempt-1");

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/canvas-jobs/canvas-route-job"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 200, body: { job: { status: "succeeded" } } });

    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/canvas-jobs/canvas-route-job/artifact"),
      context.dependencies,
    );
    expect(context.response.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/png" }),
    );
    expect(context.response.end).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it("accepts unified non-Canvas kinds and exposes explicit reconciliation", async () => {
    const context = await harness(
      {
        kind: "video.generate",
        idempotencyKey: "video-route-key",
        provider: "ltx-2.3",
        sourceRevisions: { stage: 12 },
        input: { prompt: "Slow dolly through a white-model set" },
      },
      "video-route-job",
    );
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    const queued = await context.store.get("video-route-job");
    expect(queued).toMatchObject({ kind: "video.generate", status: "queued" });
    const running = await context.store.update(transitionProductionJob(queued!, "running"));
    await context.store.update(transitionProductionJob(running, "outcome_unknown", { error: "timeout" }));

    context.dependencies.readBody = async () => ({ action: "begin" });
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/video-route-job/reconcile"),
      context.dependencies,
    );
    expect((await context.store.get("video-route-job"))?.status).toBe("reconciling");

    context.dependencies.readBody = async () => ({ action: "resolve", status: "queued" });
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/video-route-job/reconcile"),
      context.dependencies,
    );
    const retried = await context.store.get("video-route-job");
    expect(retried?.status).toBe("queued");
    expect(retried?.attempts).toHaveLength(2);
    expect(retried?.attempts[0]?.status).toBe("failed");
  });

  it("turns detached Canvas executor exceptions into durable failed jobs", async () => {
    const context = await harness(
      {
        kind: "canvas.image",
        idempotencyKey: "canvas-executor-failure",
        input: { nodeId: "node-failure", prompt: "Failure path", width: 320, height: 180 },
      },
      "canvas-failed-job",
    );
    const backgroundError = vi.fn();
    context.dependencies.executeCanvasImage = async () => {
      throw new Error("renderer unavailable");
    };
    context.dependencies.onBackgroundError = backgroundError;

    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/canvas-jobs"),
      context.dependencies,
    );

    const failed = await waitForStatus(context.store, "canvas-failed-job", "failed");
    expect(failed).toMatchObject({
      status: "failed",
      error: "renderer unavailable",
      attempts: [{ error: { code: "local_executor_failed", retryable: true } }],
    });
    expect(backgroundError).toHaveBeenCalledWith(expect.objectContaining({ message: "renderer unavailable" }));
  });

  it("lists jobs of every kind through the read-only endpoint, newest first with a limit", async () => {
    const context = await harness(
      {
        kind: "media.proxy",
        idempotencyKey: "list-proxy-key",
        input: { sourceMediaId: "media-list-1" },
      },
      "list-proxy-job",
    );
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    context.dependencies.readBody = async () => ({
      kind: "video.generate",
      idempotencyKey: "list-video-key",
      input: { prompt: "Later job for ordering" },
    });
    context.dependencies.createJobId = () => "list-video-job";
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );

    context.writes.length = 0;
    expect(
      await handleProductionJobRoute(
        request("GET"),
        context.response,
        new URL("http://director.test/api/production-jobs"),
        context.dependencies,
      ),
    ).toBe(true);
    const listed = context.writes[0] as { status: number; body: { jobs: Array<{ id: string; kind: string }> } };
    expect(listed.status).toBe(200);
    expect(listed.body.jobs.map((job) => job.id)).toEqual(expect.arrayContaining(["list-proxy-job", "list-video-job"]));
    expect(listed.body.jobs).toHaveLength(2);

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs?limit=1"),
      context.dependencies,
    );
    expect((context.writes[0]!.body as { jobs: unknown[] }).jobs).toHaveLength(1);

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs?limit=0"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 400 });
  });

  it("returns a conflict when an idempotency key is reused with changed input", async () => {
    const context = await harness(
      {
        kind: "media.proxy",
        idempotencyKey: "proxy-route-key",
        input: { sourceMediaId: "media-1" },
      },
      "proxy-route-job",
    );
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    context.dependencies.readBody = async () => ({
      kind: "media.proxy",
      idempotencyKey: "proxy-route-key",
      input: { sourceMediaId: "media-2" },
    });
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({
      status: 409,
      body: { code: "production_job_idempotency_conflict", existingJobId: "proxy-route-job" },
    });
  });
});
