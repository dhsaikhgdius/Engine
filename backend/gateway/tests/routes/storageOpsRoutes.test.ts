import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_JOB_CONTRACT_VERSION,
  hashInputFingerprint,
  productionJobRecordSchema,
  type ProductionJobInput,
  type ProductionJobKind,
  type ProductionJobRecord,
  type ProductionJobStatus,
} from "../../../../packages/protocol/src/productionJobProtocol";
import { writeJsonAtomic } from "../../atomicJsonFile";
import { registerProductionJobArtifactVersions } from "../../artifacts/productionJobArtifactBridge";
import { ProductionArtifactStore } from "../../artifacts/productionArtifactStore";
import { ProductionJobStore } from "../../jobs/productionJobStore";
import { resolveArtifactRetentionPolicy } from "../../media/artifactRetentionPolicy";
import {
  FilesystemArtifactStorage,
  ObjectStorageArtifactStorage,
  type ArtifactStorageBackend,
  type ObjectStorageClient,
} from "../../media/artifactStorage";
import { STORAGE_WRITE_PROBE_PREFIX, StorageOpsService, type StorageHealthReport } from "../../media/storageOpsService";
import { handleStorageOpsRoute, type StorageOpsRouteDependencies } from "../../routes/storageOpsRoutes";

const NOW = "2026-08-25T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60_000;

/** In-memory S3-compatible client for object-storage GC path tests. */
function fakeObjectStorageClient(clock: () => string = () => new Date().toISOString()) {
  const objects = new Map<string, { bytes: Uint8Array; modifiedAt: string }>();
  const client: ObjectStorageClient = {
    async putObject(key, bytes) {
      objects.set(key, { bytes, modifiedAt: clock() });
    },
    async getObject(key) {
      return objects.get(key)?.bytes ?? null;
    },
    async headObject(key) {
      const object = objects.get(key);
      return object ? { bytes: object.bytes.byteLength, modifiedAt: object.modifiedAt } : null;
    },
    async deleteObject(key) {
      return objects.delete(key);
    },
    async listObjects(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, bytes: object.bytes.byteLength, modifiedAt: object.modifiedAt }));
    },
  };
  return { client, objects };
}

function jobRecord(
  id: string,
  status: ProductionJobStatus,
  kind: ProductionJobKind,
  input: ProductionJobInput,
  artifactFileName?: string,
): ProductionJobRecord {
  const fingerprint = hashInputFingerprint(kind, input);
  const attemptId = `${id}-attempt-1`;
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  const artifacts = artifactFileName
    ? [
        {
          id: `${attemptId}-artifact-1`,
          attemptId,
          role: "primary",
          mimeType: "video/mp4",
          fileName: artifactFileName,
          sha256: "c".repeat(64),
          bytes: 10,
          createdAt: NOW,
        },
      ]
    : [];
  return productionJobRecordSchema.parse({
    contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
    id,
    kind,
    status,
    progress: status === "succeeded" ? 1 : 0,
    inputFingerprint: fingerprint,
    idempotencyKey: `${kind}:${id}`,
    input,
    attempts: [
      {
        id: attemptId,
        number: 1,
        status,
        provider: "director.test",
        inputFingerprint: fingerprint,
        idempotencyKey: `${kind}:${id}`,
        sourceRevisions: {},
        timestamps: {
          createdAt: NOW,
          startedAt: status === "queued" ? undefined : NOW,
          outcomeUnknownAt: status === "outcome_unknown" || status === "reconciling" ? NOW : undefined,
          reconciliationStartedAt: status === "reconciling" ? NOW : undefined,
          finishedAt: terminal ? NOW : undefined,
        },
        artifacts,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    artifacts,
  });
}

const proxyInput = { sourceMediaId: "media-1" } as ProductionJobInput;

describe("storage ops routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function harness(
    options: {
      retentionJson?: string;
      nowMs?: () => number;
      planTtlMs?: number;
      backend?: "filesystem" | "object-storage";
    } = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), "director-storage-ops-"));
    tempDirs.push(dir);
    const objectFake =
      options.backend === "object-storage"
        ? // Stamp objects at the fixture epoch so plan clocks can advance age deterministically.
          fakeObjectStorageClient(() => NOW)
        : null;
    const storage =
      options.backend === "object-storage"
        ? new ObjectStorageArtifactStorage(objectFake!.client)
        : new FilesystemArtifactStorage(dir);
    const jobs = new ProductionJobStore(dir);
    const retention = resolveArtifactRetentionPolicy(
      options.retentionJson ? { DIRECTOR_ARTIFACT_RETENTION_JSON: options.retentionJson } : {},
    );
    const service = new StorageOpsService({
      storage,
      jobs,
      retention,
      dataDirectory: dir,
      now: options.nowMs,
      planTtlMs: options.planTtlMs,
    });
    const writes: Array<{ status: number; body: unknown }> = [];
    let payload: unknown = {};
    const dependencies: StorageOpsRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      service,
    };
    const response = { writeHead: () => undefined, end: () => undefined } as unknown as ServerResponse;
    const call = async (method: string, pathname: string, requestBody?: unknown) => {
      payload = requestBody ?? {};
      writes.length = 0;
      const handled = await handleStorageOpsRoute(
        { method } as IncomingMessage,
        response,
        new URL(`http://director.test${pathname}`),
        dependencies,
      );
      return { handled, write: writes[0] };
    };
    const putJob = async (record: ProductionJobRecord) => {
      await writeJsonAtomic(join(dir, "production-jobs", record.id, "job.json"), record);
    };
    return { dir, storage, jobs, service, call, putJob, objectFake };
  }

  it("ignores unrelated routes", async () => {
    const context = await harness();
    expect((await context.call("GET", "/api/storage/unknown")).handled).toBe(false);
    expect((await context.call("DELETE", "/api/storage/health")).handled).toBe(false);
  });

  it("reports health: policy, usage buckets, jobs, sweep candidates, and no history initially", async () => {
    const context = await harness();
    const bytes = new TextEncoder().encode("0123456789");
    await context.putJob(jobRecord("job-done", "succeeded", "media.proxy", proxyInput, "proxy.mp4"));
    await context.storage.put("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4", bytes);
    await context.storage.put(`media-transcode-inputs/${"d".repeat(64)}.bin`, bytes);

    const { handled, write } = await context.call("GET", "/api/storage/health");
    expect(handled).toBe(true);
    expect(write).toMatchObject({
      status: 200,
      body: {
        health: {
          contract: "director-storage-health-v1",
          backend: "filesystem",
          policy: {
            source: "default",
            minimumAgeHours: 24,
            rules: [],
            legalHold: { keys: 0, keyPrefixes: 0, jobIds: 0 },
          },
          usage: {
            jobArtifacts: { objects: 1, bytes: 10 },
            jobMetadata: { objects: 1 },
            stagedMediaInputs: { objects: 1, bytes: 10 },
          },
          jobs: { total: 1, nonTerminal: 0, byStatus: { succeeded: 1 } },
          // Everything is younger than the 24 h minimum age: nothing sweepable yet.
          sweepCandidates: { count: 0, bytes: 0, byReason: { unreachable: 0, retentionExpired: 0 } },
          recentSweeps: [],
          // The filesystem backend was actually exercised, not assumed healthy.
          capacity: { status: "measured" },
          writeProbe: { status: "ok" },
        },
      },
    });

    const health = (write!.body as { health: StorageHealthReport }).health;
    if (health.capacity.status !== "measured") throw new Error("expected a measured capacity");
    expect(health.capacity.totalBytes).toBeGreaterThan(0);
    expect(health.capacity.freeBytes).toBeLessThanOrEqual(health.capacity.totalBytes);
    expect(health.capacity.availableBytes).toBeLessThanOrEqual(health.capacity.freeBytes);
    expect(health.capacity.usedRatio).toBeGreaterThanOrEqual(0);
    expect(health.capacity.usedRatio).toBeLessThanOrEqual(1);
    // The write probe cleaned up after itself: no probe objects survive and
    // none leak into the usage the same report enumerates.
    expect(await context.storage.list(STORAGE_WRITE_PROBE_PREFIX)).toEqual([]);
    expect(health.usage.total.objects).toBe(3);
  });

  it("plans a dry run, requires the echoed plan id to sweep, and records an audit entry", async () => {
    const nowMs = Date.parse(NOW) + 7 * DAY_MS;
    const context = await harness({
      retentionJson: JSON.stringify({ rules: [{ jobKinds: ["media.proxy"], retainDays: 3 }] }),
      nowMs: () => nowMs,
    });
    const bytes = new TextEncoder().encode("0123456789");
    // Terminal proxy job whose 3-day window passed 7 days ago → retention-expired.
    await context.putJob(jobRecord("job-done", "succeeded", "media.proxy", proxyInput, "proxy.mp4"));
    await context.storage.put("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4", bytes);
    // Orphaned staged input with no job record → unreachable.
    await context.storage.put(`media-transcode-inputs/${"d".repeat(64)}.bin`, bytes);

    const planWrite = (await context.call("POST", "/api/storage/gc/plan")).write!;
    expect(planWrite.status).toBe(200);
    const plan = (planWrite.body as { plan: { planId: string; sweep: unknown; sweepEntries: unknown[] } }).plan;
    expect(plan.sweep).toMatchObject({ count: 2, bytes: 20, byReason: { unreachable: 1, retentionExpired: 1 } });
    expect(plan.sweepEntries).toHaveLength(2);
    // Planning deletes nothing.
    expect(await context.storage.get("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4")).not.toBeNull();

    // Sweeping without the echoed plan id is refused with the corrective call.
    const mismatch = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: "yes" }))
      .write!;
    expect(mismatch).toMatchObject({ status: 400, body: { code: "gc_confirm_mismatch" } });
    // An unknown plan id is refused.
    const unknown = (
      await context.call("POST", "/api/storage/gc/sweep", { planId: "missing-plan", confirm: "missing-plan" })
    ).write!;
    expect(unknown).toMatchObject({ status: 409, body: { code: "gc_plan_not_found" } });

    const sweep = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(sweep).toMatchObject({
      status: 200,
      body: {
        result: {
          planId: plan.planId,
          replayed: false,
          deletedCount: 2,
          reclaimedBytes: 20,
          skippedCount: 0,
          byReason: { unreachable: 1, retentionExpired: 1 },
        },
      },
    });
    expect(await context.storage.get("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4")).toBeNull();
    // Job metadata survives; only artifact bytes aged out.
    expect(await context.jobs.get("job-done")).not.toBeNull();

    // Replaying the same confirmed plan is idempotent: recorded outcome, no second delete.
    const replay = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(replay).toMatchObject({
      status: 200,
      body: { result: { replayed: true, deletedCount: 2, reclaimedBytes: 20 } },
    });

    // The executed sweep shows up as recent GC history, also for a fresh service over the same directory.
    const health = (await context.call("GET", "/api/storage/health")).write!;
    expect(health.body).toMatchObject({
      health: {
        sweepCandidates: { count: 0 },
        recentSweeps: [
          {
            planId: plan.planId,
            deletedCount: 2,
            reclaimedBytes: 20,
            byReason: { unreachable: 1, retentionExpired: 1 },
          },
        ],
      },
    });
    const rebooted = new StorageOpsService({
      storage: context.storage,
      jobs: context.jobs,
      retention: resolveArtifactRetentionPolicy({}),
      dataDirectory: context.dir,
    });
    expect((await rebooted.health()).recentSweeps).toHaveLength(1);
  });

  it("refuses an expired plan with the corrective call", async () => {
    let nowMs = Date.parse(NOW) + 7 * DAY_MS;
    const context = await harness({ nowMs: () => nowMs, planTtlMs: 60_000 });
    await context.storage.put(
      "production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4",
      new TextEncoder().encode("orphan"),
    );

    const plan = ((await context.call("POST", "/api/storage/gc/plan")).write!.body as { plan: { planId: string } })
      .plan;
    nowMs += 61_000;
    const expired = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(expired).toMatchObject({ status: 409, body: { code: "gc_plan_expired" } });
    expect(await context.storage.get("production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4")).not.toBeNull();
  });

  it("rejects malformed sweep requests", async () => {
    const context = await harness();
    const invalid = (await context.call("POST", "/api/storage/gc/sweep", { planId: "" })).write!;
    expect(invalid.status).toBe(400);
  });

  it("revalidates the reviewed plan at sweep time: a staged input a new job references is skipped, not deleted", async () => {
    const nowMs = Date.parse(NOW) + 7 * DAY_MS;
    const context = await harness({ nowMs: () => nowMs });
    const bytes = new TextEncoder().encode("0123456789");
    const restagedSha = "f".repeat(64);
    const restagedKey = `media-transcode-inputs/${restagedSha}.bin`;
    const orphanKey = `media-transcode-inputs/${"a".repeat(64)}.bin`;
    await context.storage.put(restagedKey, bytes);
    await context.storage.put(orphanKey, bytes);

    // At plan time nothing references either staged input: both are sweepable.
    const plan = (
      (await context.call("POST", "/api/storage/gc/plan")).write!.body as {
        plan: { planId: string; sweep: { count: number } };
      }
    ).plan;
    expect(plan.sweep.count).toBe(2);

    // During the review window a queued transcode job re-references one input.
    await context.jobs.enqueue({
      kind: "media.transcode",
      input: { sourceMediaId: `media-input:sha256:${restagedSha}`, targetMimeType: "video/mp4" },
      idempotencyKey: "media.transcode:job-late",
      createId: () => "job-late",
    });

    const sweep = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(sweep).toMatchObject({
      status: 200,
      body: {
        result: {
          replayed: false,
          deletedCount: 1,
          reclaimedBytes: 10,
          skippedCount: 1,
          deletedKeys: [orphanKey],
          skippedKeys: [restagedKey],
          skipped: [{ key: restagedKey, code: "became-reachable" }],
          skippedByReason: { becameReachable: 1, modifiedSincePlan: 0, alreadyAbsent: 0, deleteFailed: 0 },
          byReason: { unreachable: 1, retentionExpired: 0 },
        },
      },
    });
    // The re-referenced bytes survive for the retry; only the true orphan is gone.
    expect(await context.storage.get(restagedKey)).not.toBeNull();
    expect(await context.storage.get(orphanKey)).toBeNull();

    // Replay returns the recorded skips without re-deleting.
    const replay = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(replay).toMatchObject({
      status: 200,
      body: { result: { replayed: true, skippedByReason: { becameReachable: 1 } } },
    });

    // The audit and health surface carry the typed skip counts durably.
    const health = (await context.call("GET", "/api/storage/health")).write!;
    expect(health.body).toMatchObject({
      health: {
        recentSweeps: [
          {
            planId: plan.planId,
            deletedCount: 1,
            skippedCount: 1,
            skippedByReason: { becameReachable: 1, modifiedSincePlan: 0, alreadyAbsent: 0, deleteFailed: 0 },
          },
        ],
      },
    });
  });

  it("skips objects rewritten after planning with a typed modified-since-plan code", async () => {
    const nowMs = Date.parse(NOW) + 7 * DAY_MS;
    const context = await harness({ backend: "object-storage", nowMs: () => nowMs });
    const key = "production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4";
    await context.storage.put(key, new TextEncoder().encode("0123456789"));

    const plan = ((await context.call("POST", "/api/storage/gc/plan")).write!.body as { plan: { planId: string } })
      .plan;
    // The object is rewritten under the same key after the plan was reviewed.
    context.objectFake!.objects.get(key)!.modifiedAt = new Date(nowMs + 1000).toISOString();

    const sweep = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(sweep).toMatchObject({
      status: 200,
      body: {
        result: {
          deletedCount: 0,
          skippedCount: 1,
          skipped: [{ key, code: "modified-since-plan" }],
          skippedByReason: { becameReachable: 0, modifiedSincePlan: 1, alreadyAbsent: 0, deleteFailed: 0 },
        },
      },
    });
    expect(await context.storage.get(key)).not.toBeNull();
  });

  it("keeps audit entries recorded before skip reasons were tracked readable", async () => {
    const context = await harness();
    await writeJsonAtomic(join(context.dir, "storage-gc-audit.json"), {
      version: 1,
      entries: [
        {
          planId: "legacy-plan",
          plannedAt: NOW,
          sweptAt: NOW,
          examined: 1,
          plannedSweepCount: 1,
          plannedSweepBytes: 10,
          deletedCount: 1,
          reclaimedBytes: 10,
          skippedCount: 0,
          byReason: { unreachable: 1, retentionExpired: 0 },
        },
      ],
    });
    const health = await context.service.health();
    expect(health.recentSweeps).toHaveLength(1);
    expect(health.recentSweeps[0]!.planId).toBe("legacy-plan");
    expect(health.recentSweeps[0]!.skippedByReason).toBeUndefined();
  });

  it("keeps job → ArtifactVersion registration idempotent after retention sweeps the bytes", async () => {
    const nowMs = Date.parse(NOW) + 7 * DAY_MS;
    const context = await harness({
      retentionJson: JSON.stringify({ rules: [{ retainDays: 1 }] }),
      nowMs: () => nowMs,
    });
    const record = jobRecord("job-evidence", "succeeded", "media.proxy", proxyInput, "proxy.mp4");
    await context.putJob(record);
    await context.storage.put(
      "production-jobs/job-evidence/attempts/job-evidence-attempt-1/proxy.mp4",
      new TextEncoder().encode("0123456789"),
    );

    const artifactStore = new ProductionArtifactStore(context.dir);
    const first = await registerProductionJobArtifactVersions(artifactStore, record);
    expect(first.map((registration) => registration.replayed)).toEqual([false]);

    const plan = ((await context.call("POST", "/api/storage/gc/plan")).write!.body as { plan: { planId: string } })
      .plan;
    const sweep = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(sweep).toMatchObject({ status: 200, body: { result: { deletedCount: 1 } } });

    // Immutable evidence survives the byte sweep and replays idempotently.
    const replayed = await registerProductionJobArtifactVersions(artifactStore, record);
    expect(replayed.map((registration) => registration.replayed)).toEqual([true]);
    expect(replayed[0]!.version.content.sha256).toBe("c".repeat(64));
  });

  async function serviceOver(storage: ArtifactStorageBackend) {
    const dir = await mkdtemp(join(tmpdir(), "director-storage-ops-probe-"));
    tempDirs.push(dir);
    return new StorageOpsService({
      storage,
      jobs: new ProductionJobStore(dir),
      retention: resolveArtifactRetentionPolicy({}),
      dataDirectory: dir,
    });
  }

  it("reports the exact write-probe step that failed instead of implying a writable backend", async () => {
    const cases: Array<{
      code: "put_failed" | "verify_failed" | "delete_failed";
      reason: RegExp;
      decorate: (client: ObjectStorageClient) => ObjectStorageClient;
    }> = [
      {
        code: "put_failed",
        reason: /read-only/,
        decorate: (client) => ({
          ...client,
          putObject: async () => {
            throw new Error("bucket is read-only");
          },
        }),
      },
      {
        code: "verify_failed",
        reason: /not readable/,
        decorate: (client) => ({ ...client, headObject: async () => null }),
      },
      {
        code: "delete_failed",
        reason: /could not be deleted/,
        decorate: (client) => ({ ...client, deleteObject: async () => false }),
      },
    ];
    for (const { code, reason, decorate } of cases) {
      const service = await serviceOver(new ObjectStorageArtifactStorage(decorate(fakeObjectStorageClient().client)));
      const health = await service.health();
      expect(health.writeProbe, code).toMatchObject({ status: "failed", code });
      if (health.writeProbe.status !== "failed") throw new Error("expected a failed write probe");
      expect(health.writeProbe.reason, code).toMatch(reason);
      // A failed probe never breaks the rest of the report.
      expect(health.contract).toBe("director-storage-health-v1");
    }
  });

  it("reports a typed capacity omission when the live measurement itself fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-storage-ops-capacity-"));
    tempDirs.push(dir);
    const filesystem = new FilesystemArtifactStorage(dir);
    const failing: ArtifactStorageBackend = {
      kind: "filesystem",
      put: (key, bytes) => filesystem.put(key, bytes),
      get: (key) => filesystem.get(key),
      head: (key) => filesystem.head(key),
      delete: (key) => filesystem.delete(key),
      list: (prefix) => filesystem.list(prefix),
      capacity: async () => {
        throw new Error("statfs unavailable in this sandbox");
      },
    };
    const service = await serviceOver(failing);
    const health = await service.health();
    expect(health.capacity).toEqual({
      status: "unavailable",
      code: "capacity_probe_failed",
      reason: "statfs unavailable in this sandbox",
    });
    expect(health.writeProbe).toMatchObject({ status: "ok" });
  });

  it("runs health/plan/sweep against an injected object-storage backend", async () => {
    const nowMs = Date.parse(NOW) + 7 * DAY_MS;
    const context = await harness({
      backend: "object-storage",
      retentionJson: JSON.stringify({ rules: [{ jobKinds: ["media.proxy"], retainDays: 3 }] }),
      nowMs: () => nowMs,
    });
    const bytes = new TextEncoder().encode("0123456789");
    await context.putJob(jobRecord("job-remote", "succeeded", "media.proxy", proxyInput, "proxy.mp4"));
    await context.storage.put("production-jobs/job-remote/attempts/job-remote-attempt-1/proxy.mp4", bytes);
    await context.storage.put(`media-transcode-inputs/${"e".repeat(64)}.bin`, bytes);

    const health = (await context.call("GET", "/api/storage/health")).write!;
    expect(health).toMatchObject({
      status: 200,
      body: {
        health: {
          backend: "object-storage",
          usage: {
            jobArtifacts: { objects: 1, bytes: 10 },
            stagedMediaInputs: { objects: 1, bytes: 10 },
          },
          sweepCandidates: { count: 2, byReason: { unreachable: 1, retentionExpired: 1 } },
          // Object storage has no enumerable capacity: a typed omission, not
          // an invented number. The write probe still exercised the client.
          capacity: { status: "unavailable", code: "capacity_unsupported" },
          writeProbe: { status: "ok" },
        },
      },
    });
    // The probe round trip left no objects behind in the injected client.
    expect([...context.objectFake!.objects.keys()].filter((key) => key.startsWith(STORAGE_WRITE_PROBE_PREFIX))).toEqual(
      [],
    );

    const plan = ((await context.call("POST", "/api/storage/gc/plan")).write!.body as { plan: { planId: string } })
      .plan;
    const sweep = (await context.call("POST", "/api/storage/gc/sweep", { planId: plan.planId, confirm: plan.planId }))
      .write!;
    expect(sweep).toMatchObject({
      status: 200,
      body: { result: { deletedCount: 2, reclaimedBytes: 20, replayed: false } },
    });
    expect(await context.storage.get("production-jobs/job-remote/attempts/job-remote-attempt-1/proxy.mp4")).toBeNull();
    expect(await context.storage.get(`media-transcode-inputs/${"e".repeat(64)}.bin`)).toBeNull();
    expect(await context.jobs.get("job-remote")).not.toBeNull();
  });
});
