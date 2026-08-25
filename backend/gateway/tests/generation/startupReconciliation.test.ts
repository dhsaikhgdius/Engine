import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionProductionJob } from "../../../../packages/protocol/src/productionJobProtocol";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { reconcileOutcomeUnknownJobs, type ReconcilingExecutor } from "../../generation/startupReconciliation";

describe("reconcileOutcomeUnknownJobs", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
    vi.restoreAllMocks();
  });

  async function createStore() {
    const dir = await mkdtemp(join(tmpdir(), "director-startup-reconcile-"));
    tempDirs.push(dir);
    return { dir, store: new ProductionJobStore(dir) };
  }

  async function enqueueRunning(store: ProductionJobStore, id: string, kind: "video.generate" | "model.generate") {
    const queued =
      kind === "model.generate"
        ? await store.enqueue({
            kind,
            input: { mode: "text-to-3d", providerId: "meshy", name: "Prop", prompt: "A prop" },
            idempotencyKey: `startup-${id}`,
            createId: () => id,
          })
        : await store.enqueue({
            kind,
            input: { prompt: "A shot" },
            idempotencyKey: `startup-${id}`,
            createId: () => id,
          });
    await store.update(transitionProductionJob(queued, "running"));
  }

  it("routes every outcome_unknown job to its supporting executor after restart", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { dir, store } = await createStore();
    await enqueueRunning(store, "job-video", "video.generate");
    await enqueueRunning(store, "job-model", "model.generate");

    const restarted = new ProductionJobStore(dir);
    const videoReconciled: string[] = [];
    const modelReconciled: string[] = [];
    const videoExecutor: ReconcilingExecutor = {
      supports: (job) => job.kind === "video.generate",
      reconcile: async (jobId) => {
        videoReconciled.push(jobId);
        return restarted.get(jobId);
      },
    };
    const modelExecutor: ReconcilingExecutor = {
      supports: (job) => job.kind === "model.generate",
      reconcile: async (jobId) => {
        modelReconciled.push(jobId);
        return restarted.get(jobId);
      },
    };

    await reconcileOutcomeUnknownJobs(restarted, [videoExecutor, modelExecutor]);
    expect(videoReconciled).toEqual(["job-video"]);
    expect(modelReconciled).toEqual(["job-model"]);
  });

  it("skips settled jobs and jobs without a supporting executor", async () => {
    const { dir, store } = await createStore();
    await enqueueRunning(store, "job-unsupported", "model.generate");
    await store.enqueue({
      kind: "video.generate",
      input: { prompt: "Still queued" },
      idempotencyKey: "startup-queued",
      createId: () => "job-queued",
    });

    const restarted = new ProductionJobStore(dir);
    const reconciled: string[] = [];
    const videoExecutor: ReconcilingExecutor = {
      supports: (job) => job.kind === "video.generate",
      reconcile: async (jobId) => {
        reconciled.push(jobId);
        return restarted.get(jobId);
      },
    };

    await reconcileOutcomeUnknownJobs(restarted, [videoExecutor]);
    expect(reconciled).toEqual([]);
  });

  it("logs a reconcile failure and keeps going instead of blocking startup", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, store } = await createStore();
    await enqueueRunning(store, "job-a", "video.generate");
    await enqueueRunning(store, "job-b", "video.generate");

    const restarted = new ProductionJobStore(dir);
    const reconciled: string[] = [];
    const flakyExecutor: ReconcilingExecutor = {
      supports: (job) => job.kind === "video.generate",
      reconcile: async (jobId) => {
        if (jobId === "job-a") throw new Error("provider unreachable");
        reconciled.push(jobId);
        return restarted.get(jobId);
      },
    };

    await expect(reconcileOutcomeUnknownJobs(restarted, [flakyExecutor])).resolves.toBeUndefined();
    expect(reconciled).toEqual(["job-b"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("job-a"), expect.any(Error));
  });
});
