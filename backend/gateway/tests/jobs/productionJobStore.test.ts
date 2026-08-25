import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashInputFingerprint, transitionProductionJob } from "../../../../packages/protocol/src/productionJobProtocol";
import { executeCanvasImageJob, ProductionJobIdempotencyConflictError, ProductionJobStore } from "../../jobs/productionJobStore";

describe("ProductionJobStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createStore() {
    const dir = await mkdtemp(join(tmpdir(), "director-production-jobs-"));
    tempDirs.push(dir);
    return { dir, store: new ProductionJobStore(dir) };
  }

  const imageInput = {
    nodeId: "board-node-1",
    prompt: "Rainy street",
    width: 1024,
    height: 576,
  };

  it("deduplicates exact enqueue and rejects changed idempotency reuse", async () => {
    const { store } = await createStore();
    const first = await store.enqueue({
      kind: "canvas.image",
      input: imageInput,
      idempotencyKey: "canvas-image:node-1",
      createId: () => "job-first",
    });
    const second = await store.enqueue({
      kind: "canvas.image",
      input: imageInput,
      idempotencyKey: "canvas-image:node-1",
      createId: () => "job-second",
    });
    expect(second.id).toBe(first.id);

    await expect(
      store.enqueue({
        kind: "canvas.image",
        input: { ...imageInput, prompt: "Changed request" },
        idempotencyKey: "canvas-image:node-1",
        createId: () => "job-conflict",
      }),
    ).rejects.toBeInstanceOf(ProductionJobIdempotencyConflictError);

    await expect(
      store.enqueue({
        kind: "canvas.image",
        input: imageInput,
        idempotencyKey: "canvas-image:node-1",
        sourceRevisions: { canvas: 2 },
        createId: () => "job-stale-source",
      }),
    ).rejects.toBeInstanceOf(ProductionJobIdempotencyConflictError);
  });

  it("executes Canvas image jobs with attempt-specific immutable artifact paths", async () => {
    const { dir, store } = await createStore();
    const job = await store.enqueue({
      kind: "canvas.image",
      input: { ...imageInput, nodeId: "board-node-2", prompt: "Placeholder portrait", width: 512, height: 288 },
      idempotencyKey: "canvas-image:node-2",
      provider: "director.placeholder",
      sourceRevisions: { canvas: 7 },
      createId: () => "job-image",
    });
    const finished = await executeCanvasImageJob(store, job);
    expect(finished.status).toBe("succeeded");
    expect(finished.artifact).toMatchObject({
      fileName: "output.png",
      attemptId: "job-image-attempt-1",
      id: "job-image-attempt-1-artifact-1",
    });
    expect(finished.attempts[0]).toMatchObject({
      provider: "director.placeholder",
      sourceRevisions: { canvas: 7 },
      status: "succeeded",
    });
    const bytes = await readFile(
      join(dir, "production-jobs", "job-image", "attempts", "job-image-attempt-1", "output.png"),
    );
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    await expect(readFile(join(dir, "canvas-jobs", "job-image", "output.png"))).rejects.toThrow();
  });

  it("dual-reads and migrates legacy canvas-jobs into production-jobs", async () => {
    const { dir, store } = await createStore();
    const legacyDir = join(dir, "canvas-jobs", "legacy-job");
    await mkdir(legacyDir, { recursive: true });
    const artifactBytes = Buffer.from("legacy artifact");
    await writeFile(join(legacyDir, "output.png"), artifactBytes);
    const now = new Date().toISOString();
    await writeFile(
      join(legacyDir, "job.json"),
      JSON.stringify({
        id: "legacy-job",
        kind: "canvas.image",
        status: "succeeded",
        progress: 1,
        inputFingerprint: hashInputFingerprint("canvas.image", imageInput),
        idempotencyKey: "legacy-key",
        input: imageInput,
        createdAt: now,
        updatedAt: now,
        artifact: {
          mimeType: "image/png",
          fileName: "output.png",
          sha256: createHash("sha256").update(artifactBytes).digest("hex"),
          bytes: artifactBytes.byteLength,
        },
      }),
    );

    const migrated = await store.get("legacy-job");
    expect(migrated).toMatchObject({
      contractVersion: 1,
      status: "succeeded",
      artifact: { attemptId: "legacy-job-attempt-1" },
    });
    expect(migrated?.attempts).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(dir, "production-jobs", "legacy-job", "job.json"), "utf8")) as {
      contractVersion: number;
    };
    expect(persisted.contractVersion).toBe(1);
    expect(
      await readFile(
        join(dir, "production-jobs", "legacy-job", "attempts", "legacy-job-attempt-1", "output.png"),
        "utf8",
      ),
    ).toBe("legacy artifact");
  });

  it("preserves legacy Canvas video timing fields during dual-read migration", async () => {
    const { dir, store } = await createStore();
    const legacyDir = join(dir, "canvas-jobs", "legacy-video");
    await mkdir(legacyDir, { recursive: true });
    const now = new Date().toISOString();
    const input = { ...imageInput, durationSeconds: 8, fps: 30 };
    await writeFile(
      join(legacyDir, "job.json"),
      JSON.stringify({
        id: "legacy-video",
        kind: "canvas.video",
        status: "queued",
        progress: 0,
        inputFingerprint: hashInputFingerprint("canvas.video", input),
        idempotencyKey: "legacy-video-key",
        input,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const migrated = await store.get("legacy-video");
    expect(migrated).toMatchObject({
      contractVersion: 1,
      kind: "canvas.video",
      input: { durationSeconds: 8, fps: 30 },
    });
  });

  it("recovers running jobs as outcome_unknown after restart", async () => {
    const { dir, store } = await createStore();
    const queued = await store.enqueue({
      kind: "video.generate",
      input: { prompt: "A long shot" },
      idempotencyKey: "video-restart",
      provider: "ltx-2.3",
      createId: () => "job-restart",
    });
    await store.update(transitionProductionJob(queued, "running", { progress: 0.35 }));

    const recovered = await new ProductionJobStore(dir).get("job-restart");
    expect(recovered).toMatchObject({
      status: "outcome_unknown",
      message: "Executor interrupted; provider outcome must be reconciled",
    });
    expect(recovered?.attempts[0]).toMatchObject({
      provider: "ltx-2.3",
      status: "outcome_unknown",
      error: { code: "executor_restart_outcome_unknown", retryable: false },
    });
  });

  it("records a provider external ID once and then freezes it", async () => {
    const { store } = await createStore();
    const job = await store.enqueue({
      kind: "audio.generate",
      input: { prompt: "Room tone" },
      idempotencyKey: "audio-external-id",
      provider: "audio-provider",
      createId: () => "job-external-id",
    });
    const assigned = await store.setCurrentAttemptExternalId(job.id, "provider-job-42");
    expect(assigned?.attempts[0]?.externalId).toBe("provider-job-42");
    await expect(store.setCurrentAttemptExternalId(job.id, "provider-job-43")).rejects.toThrow(/immutable/);
  });

  it("keeps the newest provider phases instead of failing when externalIds exceed the cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { store } = await createStore();
      const job = await store.enqueue({
        kind: "video.generate",
        input: { prompt: "Phased workflow" },
        idempotencyKey: "video-phases",
        createId: () => "job-phases",
      });
      for (let phase = 1; phase <= 20; phase += 1) {
        await store.appendCurrentAttemptExternalId(job.id, `phase-${phase}`);
      }
      const attempt = (await store.get(job.id))?.attempts.at(-1);
      expect(attempt?.externalId).toBe("phase-1");
      expect(attempt?.externalIds).toHaveLength(16);
      expect(attempt?.externalIds?.[0]).toBe("phase-1");
      expect(attempt?.externalIds?.at(-1)).toBe("phase-20");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("serializes concurrent writes to one job so the last update wins durably", async () => {
    const { dir, store } = await createStore();
    const queued = await store.enqueue({
      kind: "media.proxy",
      input: { sourceMediaId: "media-concurrent" },
      idempotencyKey: "concurrent-update",
      createId: () => "job-concurrent-update",
    });
    const running = transitionProductionJob(queued, "running");
    const cancelled = transitionProductionJob(queued, "cancelled");

    const results = await Promise.allSettled([store.update(running), store.update(cancelled)]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect((await store.get(queued.id))?.status).toBe("cancelled");
    const persisted = JSON.parse(
      await readFile(join(dir, "production-jobs", queued.id, "job.json"), "utf8"),
    ) as { status: string };
    expect(persisted.status).toBe("cancelled");
  });

  it("reconciles unknown outcomes before retry and preserves earlier attempts", async () => {
    const { store } = await createStore();
    const queued = await store.enqueue({
      kind: "canvas.image",
      input: imageInput,
      idempotencyKey: "unknown-retry",
      provider: "remote.image",
      externalId: "provider-job-1",
      createId: () => "job-unknown",
    });
    const running = await store.update(transitionProductionJob(queued, "running"));
    const unknown = await store.update(
      transitionProductionJob(running, "outcome_unknown", {
        error: "Provider acknowledgement timed out",
        structuredError: { code: "provider_timeout", message: "Provider acknowledgement timed out", retryable: false },
      }),
    );
    expect(() => transitionProductionJob(unknown, "queued")).toThrow(/Invalid production job transition/);

    const reconciling = await store.beginReconciliation(unknown.id);
    expect(reconciling?.status).toBe("reconciling");
    const retried = await store.resolveReconciliation(unknown.id, { status: "queued" });
    expect(retried?.attempts).toHaveLength(2);
    expect(retried?.attempts[0]).toMatchObject({
      id: "job-unknown-attempt-1",
      externalId: "provider-job-1",
      status: "failed",
    });
    expect(retried?.attempts[1]).toMatchObject({ id: "job-unknown-attempt-2", status: "queued" });

    const firstAttemptSnapshot = JSON.stringify(retried?.attempts[0]);
    const finished = await executeCanvasImageJob(store, retried!);
    expect(JSON.stringify(finished.attempts[0])).toBe(firstAttemptSnapshot);
    expect(finished.attempts[1]?.artifacts[0]?.attemptId).toBe("job-unknown-attempt-2");
  });
});
