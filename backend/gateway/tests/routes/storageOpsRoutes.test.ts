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
import { FilesystemArtifactStorage } from "../../media/artifactStorage";
import { StorageOpsService } from "../../media/storageOpsService";
import { handleStorageOpsRoute, type StorageOpsRouteDependencies } from "../../routes/storageOpsRoutes";

const NOW = "2026-08-25T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60_000;

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

  async function harness(options: { retentionJson?: string; nowMs?: () => number; planTtlMs?: number } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "director-storage-ops-"));
    tempDirs.push(dir);
    const storage = new FilesystemArtifactStorage(dir);
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
    return { dir, storage, jobs, service, call, putJob };
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
          policy: { source: "default", minimumAgeHours: 24, rules: [], legalHold: { keys: 0, keyPrefixes: 0, jobIds: 0 } },
          usage: {
            jobArtifacts: { objects: 1, bytes: 10 },
            jobMetadata: { objects: 1 },
            stagedMediaInputs: { objects: 1, bytes: 10 },
          },
          jobs: { total: 1, nonTerminal: 0, byStatus: { succeeded: 1 } },
          // Everything is younger than the 24 h minimum age: nothing sweepable yet.
          sweepCandidates: { count: 0, bytes: 0, byReason: { unreachable: 0, retentionExpired: 0 } },
          recentSweeps: [],
        },
      },
    });
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
});
