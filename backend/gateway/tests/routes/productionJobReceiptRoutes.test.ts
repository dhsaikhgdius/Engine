import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  transitionProductionJob,
  type ProductionJobRecord,
} from "../../../../packages/protocol/src/productionJobProtocol";
import { PRODUCTION_JOB_RECEIPT_CONTRACT } from "../../../../packages/protocol/src/productionJobReceipt";
import { ProductionArtifactStore } from "../../artifacts/productionArtifactStore";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { handleProductionJobRoute, type ProductionJobRouteDependencies } from "../../routes/productionJobRoutes";

describe("production job receipts, artifact-version registration, and dispatch guards", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function harness(payload: unknown) {
    const dir = await mkdtemp(join(tmpdir(), "director-production-job-receipts-"));
    tempDirs.push(dir);
    const store = new ProductionJobStore(dir);
    const artifactStore = new ProductionArtifactStore(dir);
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies: ProductionJobRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      createJobId: () => "receipt-route-job",
      mediaTranscode: { execute: async () => undefined },
      artifactVersions: artifactStore,
    };
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    return { store, artifactStore, writes, dependencies, response };
  }

  function request(method: string) {
    return { method } as IncomingMessage;
  }

  async function succeedWithArtifact(store: ProductionJobStore, job: ProductionJobRecord) {
    const running = await store.update(transitionProductionJob(job, "running"));
    const attempt = running.attempts.at(-1)!;
    return store.update(
      transitionProductionJob(running, "succeeded", {
        progress: 1,
        message: "Succeeded",
        artifact: {
          id: `${attempt.id}-artifact-1`,
          attemptId: attempt.id,
          role: "primary",
          mimeType: "video/mp4",
          fileName: "proxy.mp4",
          sha256: "e".repeat(64),
          bytes: 2048,
          createdAt: new Date().toISOString(),
        },
      }),
    );
  }

  it("returns one normalized receipt from enqueue, status, and the receipt endpoint", async () => {
    const context = await harness({
      kind: "media.proxy",
      idempotencyKey: "receipt-proxy-key",
      input: { sourceMediaId: "media-receipt" },
    });

    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(context.writes[0]!.status).toBe(202);
    const enqueueBody = context.writes[0]!.body as { receipt: { contract: string; jobId: string; kind: string } };
    expect(enqueueBody.receipt).toMatchObject({
      contract: PRODUCTION_JOB_RECEIPT_CONTRACT,
      jobId: "receipt-route-job",
      kind: "media.proxy",
    });

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job"),
      context.dependencies,
    );
    const statusBody = context.writes[0]!.body as { receipt: unknown };
    expect(statusBody.receipt).toBeDefined();

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/receipt"),
      context.dependencies,
    );
    expect(context.writes[0]!.status).toBe(200);
    const receiptBody = context.writes[0]!.body as {
      receipt: { attempt: { provider: string }; attemptCount: number };
    };
    expect(receiptBody.receipt).toMatchObject({
      contract: PRODUCTION_JOB_RECEIPT_CONTRACT,
      idempotencyKey: "receipt-proxy-key",
      attemptCount: 1,
    });

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs/missing-job/receipt"),
      context.dependencies,
    );
    expect(context.writes[0]!.status).toBe(404);
  });

  it("registers a succeeded job's artifacts as immutable versions idempotently", async () => {
    const context = await harness({
      kind: "media.proxy",
      idempotencyKey: "artifact-version-key",
      input: { sourceMediaId: "media-versions" },
    });
    const queued = await context.store.enqueue({
      kind: "media.proxy",
      input: { sourceMediaId: "media-versions" },
      idempotencyKey: "artifact-version-key",
      createId: () => "receipt-route-job",
    });

    // Before success the registration is rejected.
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/artifact-versions"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 409, body: { code: "job_not_succeeded" } });

    await succeedWithArtifact(context.store, queued);
    context.writes.length = 0;
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/artifact-versions"),
      context.dependencies,
    );
    expect(context.writes[0]!.status).toBe(200);
    const first = context.writes[0]!.body as {
      registrations: { version: { versionId: string; artifactId: string }; replayed: boolean }[];
    };
    expect(first.registrations).toHaveLength(1);
    expect(first.registrations[0]).toMatchObject({
      replayed: false,
      version: { artifactId: "production-job:receipt-route-job:primary", ordinal: 1 },
    });

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/artifact-versions"),
      context.dependencies,
    );
    const replay = context.writes[0]!.body as { registrations: { replayed: boolean }[] };
    expect(replay.registrations[0]!.replayed).toBe(true);
    expect(await context.artifactStore.listVersions("production-job:receipt-route-job:primary")).toHaveLength(1);

    context.writes.length = 0;
    delete context.dependencies.artifactVersions;
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/artifact-versions"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 503, body: { code: "artifact_version_store_unavailable" } });
  });

  it("projects storagePresence on receipts and returns 410 when artifact bytes were swept", async () => {
    const context = await harness({
      kind: "media.proxy",
      idempotencyKey: "presence-key",
      input: { sourceMediaId: "media-presence" },
    });
    const queued = await context.store.enqueue({
      kind: "media.proxy",
      input: { sourceMediaId: "media-presence" },
      idempotencyKey: "presence-key",
      createId: () => "receipt-route-job",
    });
    const succeeded = await succeedWithArtifact(context.store, queued);
    const artifact = succeeded.artifact!;
    const path = context.store.artifactFilePath(succeeded.id, artifact.attemptId, artifact.fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from("proxy-bytes"));

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/receipt"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({
      status: 200,
      body: {
        receipt: {
          artifacts: [{ id: artifact.id, storagePresence: "present", sha256: artifact.sha256 }],
        },
      },
    });

    await rm(path);

    context.writes.length = 0;
    await handleProductionJobRoute(
      request("GET"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/receipt"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({
      status: 200,
      body: {
        receipt: {
          artifacts: [{ id: artifact.id, storagePresence: "absent", sha256: artifact.sha256 }],
        },
      },
    });

    context.writes.length = 0;
    const end = vi.fn();
    const writeHead = vi.fn();
    const downloadResponse = { writeHead, end } as unknown as ServerResponse;
    await handleProductionJobRoute(
      request("GET"),
      downloadResponse,
      new URL(`http://director.test/api/production-jobs/receipt-route-job/artifacts/${artifact.id}`),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({
      status: 410,
      body: {
        code: "artifact_bytes_unavailable",
        jobId: "receipt-route-job",
        artifactId: artifact.id,
        sha256: artifact.sha256,
      },
    });
    expect(writeHead).not.toHaveBeenCalled();
  });

  it("never dispatches a second executor run for an idempotent replay while the job is in flight", async () => {
    const context = await harness({
      kind: "media.transcode",
      idempotencyKey: "paid-once-key",
      input: { sourceMediaId: "media-paid", targetMimeType: "video/mp4" },
    });
    let releaseExecutor!: () => void;
    const executorGate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const executions: string[] = [];
    context.dependencies.mediaTranscode = {
      execute: async (job) => {
        executions.push(job.id);
        const running = await context.store.update(transitionProductionJob(job, "running"));
        await executorGate;
        await context.store.update(transitionProductionJob(running, "succeeded", { progress: 1 }));
      },
    };

    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(context.writes[0]!.status).toBe(202);

    // The same idempotency key replays the same durable job: no new job id,
    // no second executor dispatch, therefore no duplicate paid provider call.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handleProductionJobRoute(
        request("POST"),
        context.response,
        new URL("http://director.test/api/production-jobs"),
        context.dependencies,
      );
    }
    expect(context.writes.every((write) => write.status === 202)).toBe(true);
    expect(new Set(context.writes.map((write) => (write.body as { job: { id: string } }).job.id))).toEqual(
      new Set(["receipt-route-job"]),
    );
    expect(executions).toEqual(["receipt-route-job"]);

    releaseExecutor();
    for (
      let index = 0;
      index < 50 && (await context.store.get("receipt-route-job"))?.status !== "succeeded";
      index += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await context.store.get("receipt-route-job"))?.status).toBe("succeeded");
    expect(executions).toEqual(["receipt-route-job"]);
  });

  it("keeps a timed-out attempt in outcome_unknown until reconciliation instead of re-running it", async () => {
    const context = await harness({
      kind: "video.generate",
      idempotencyKey: "timeout-key",
      provider: "remote.video",
      input: { prompt: "Paid remote render" },
    });
    const queued = await context.store.enqueue({
      kind: "video.generate",
      input: { prompt: "Paid remote render" },
      idempotencyKey: "timeout-key",
      provider: "remote.video",
      createId: () => "receipt-route-job",
    });
    const running = await context.store.update(transitionProductionJob(queued, "running"));
    await context.store.update(
      transitionProductionJob(running, "outcome_unknown", {
        error: "Provider acknowledgement timed out",
        structuredError: {
          code: "provider_timeout",
          message: "Provider acknowledgement timed out",
          retryable: false,
        },
      }),
    );

    // Replaying the enqueue returns the uncertain job unchanged: the paid
    // request is not repeated while the provider outcome is unknown.
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({
      status: 202,
      body: { job: { id: "receipt-route-job", status: "outcome_unknown" }, receipt: { status: "outcome_unknown" } },
    });
    expect((await context.store.get("receipt-route-job"))?.attempts).toHaveLength(1);

    // Only the explicit reconcile path may queue a new attempt.
    context.dependencies.readBody = async () => ({ action: "begin" });
    context.writes.length = 0;
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/reconcile"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 200, body: { receipt: { status: "reconciling" } } });

    context.dependencies.readBody = async () => ({ action: "resolve", status: "queued" });
    context.writes.length = 0;
    await handleProductionJobRoute(
      request("POST"),
      context.response,
      new URL("http://director.test/api/production-jobs/receipt-route-job/reconcile"),
      context.dependencies,
    );
    const resolved = context.writes[0]!.body as {
      receipt: { status: string; attemptCount: number; attempt: { number: number } };
    };
    expect(resolved.receipt).toMatchObject({ status: "queued", attemptCount: 2, attempt: { number: 2 } });
  });
});
