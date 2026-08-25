import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionProductionJob } from "../../../../packages/protocol/src/productionJobProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import {
  handleCaptureReconstructionRoute,
  type CaptureReconstructionRouteDependencies,
} from "../../routes/captureReconstructionRoutes";

const SOURCE_SHA = "a".repeat(64);
const SUBMIT_BODY = {
  input: {
    sourceKind: "rgb-video",
    sourceMediaId: `media-input:sha256:${SOURCE_SHA}`,
    fileName: "capture.mp4",
  },
  idempotencyKey: "scenerecon-route-key",
};

describe("capture reconstruction routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function harness(payload: unknown = SUBMIT_BODY) {
    const dir = await mkdtemp(join(tmpdir(), "director-scenerecon-routes-"));
    tempDirs.push(dir);
    const store = new ProductionJobStore(dir);
    const writes: Array<{ status: number; body: unknown }> = [];
    const executed: string[] = [];
    const dependencies: CaptureReconstructionRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      executor: {
        execute: async (job) => {
          executed.push(job.id);
          return job;
        },
        readPlan: async () => null,
      } as unknown as CaptureReconstructionRouteDependencies["executor"],
      createJobId: () => "scenerecon-route-job",
    };
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    return { store, writes, executed, dependencies, response };
  }

  function request(method: string) {
    return { method } as IncomingMessage;
  }

  it("submits, lists, and reads reconstruction jobs over the public routes", async () => {
    const context = await harness();

    expect(
      await handleCaptureReconstructionRoute(
        request("POST"),
        context.response,
        new URL("http://director.test/api/reconstruction/capture/jobs"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[0]).toMatchObject({
      status: 202,
      body: { job: { id: "scenerecon-route-job", kind: "scene.reconstruct", status: "queued" } },
    });
    expect(context.executed).toEqual(["scenerecon-route-job"]);

    context.writes.length = 0;
    expect(
      await handleCaptureReconstructionRoute(
        request("GET"),
        context.response,
        new URL("http://director.test/api/reconstruction/capture/jobs"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[0]!.status).toBe(200);
    expect((context.writes[0]!.body as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual([
      "scenerecon-route-job",
    ]);

    context.writes.length = 0;
    await handleCaptureReconstructionRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs/scenerecon-route-job"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 200, body: { job: { id: "scenerecon-route-job" } } });

    context.writes.length = 0;
    await handleCaptureReconstructionRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs/scenerecon-route-job/plan"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 409, body: { code: "job_not_succeeded" } });
  });

  it("replays idempotent submissions and rejects conflicting reuse", async () => {
    const context = await harness();
    await handleCaptureReconstructionRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs"),
      context.dependencies,
    );
    await handleCaptureReconstructionRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs"),
      context.dependencies,
    );
    expect(context.writes[1]).toMatchObject({ status: 202, body: { job: { id: "scenerecon-route-job" } } });
    expect(await context.store.list(["scene.reconstruct"])).toHaveLength(1);

    context.dependencies.readBody = async () => ({
      ...SUBMIT_BODY,
      input: { ...SUBMIT_BODY.input, sourceMediaId: `media-input:sha256:${"b".repeat(64)}` },
    });
    await handleCaptureReconstructionRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs"),
      context.dependencies,
    );
    expect(context.writes[2]).toMatchObject({
      status: 409,
      body: { code: "production_job_idempotency_conflict", existingJobId: "scenerecon-route-job" },
    });
  });

  it("reports the executor as unavailable with 503 instead of 404", async () => {
    const context = await harness();
    context.dependencies.executor = null;
    await handleCaptureReconstructionRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 503, body: { code: "scene_reconstruct_executor_unavailable" } });
  });

  it("hides non-reconstruction jobs from the reconstruction status route", async () => {
    const context = await harness();
    const queued = await context.store.enqueue({
      kind: "media.proxy",
      input: { sourceMediaId: "media-1" },
      idempotencyKey: "proxy-not-visible",
      createId: () => "proxy-job",
    });
    await context.store.update(transitionProductionJob(queued, "cancelled"));

    await handleCaptureReconstructionRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/reconstruction/capture/jobs/proxy-job"),
      context.dependencies,
    );
    expect(context.writes[0]!.status).toBe(404);
  });

  it("is mounted in the agent gateway with the reconstruction executor wired through", async () => {
    // Regression guard for the WS-F gap: the handler existed but was never
    // mounted, so every /api/reconstruction/capture/* request returned 404.
    const gatewaySource = await readFile(resolve(__dirname, "../../agent-gateway.ts"), "utf8");
    expect(gatewaySource).toContain("await handleCaptureReconstructionRoute(request, response, url, {");
    expect(gatewaySource).toContain("executor: captureReconstructionRuntime.executor");
    expect(gatewaySource).toContain("captureReconstruction: captureReconstructionRuntime.executor");
  });
});
