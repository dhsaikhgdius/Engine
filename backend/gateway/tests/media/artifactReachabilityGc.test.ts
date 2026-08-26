import { mkdtemp, rm, utimes } from "node:fs/promises";
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
import { FilesystemArtifactStorage, type ArtifactStorageBackend } from "../../media/artifactStorage";
import {
  collectReachableArtifactKeys,
  planArtifactStorageGc,
  revalidateArtifactGcSweep,
  sweepArtifactStorageGc,
} from "../../media/artifactReachabilityGc";

const NOW = "2026-08-25T12:00:00.000Z";
const STAGED_SHA = "b".repeat(64);

function job(
  id: string,
  status: ProductionJobStatus,
  kind: ProductionJobKind,
  input: ProductionJobInput,
  artifactFileName?: string,
): ProductionJobRecord {
  const fingerprint = hashInputFingerprint(kind, input);
  const attemptId = `${id}-attempt-1`;
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
          finishedAt: status === "succeeded" || status === "failed" || status === "cancelled" ? NOW : undefined,
        },
        artifacts,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    artifacts,
  });
}

describe("artifactReachabilityGc", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createStorage() {
    const dir = await mkdtemp(join(tmpdir(), "director-artifact-gc-"));
    tempDirs.push(dir);
    return new FilesystemArtifactStorage(dir);
  }

  it("keeps job artifacts reachable and staged inputs of non-terminal jobs", () => {
    const jobs = [
      job(
        "job-done",
        "succeeded",
        "media.proxy",
        { sourceMediaId: `media-input:sha256:${"a".repeat(64)}` } as ProductionJobInput,
        "proxy.mp4",
      ),
      job("job-active", "outcome_unknown", "media.transcode", {
        sourceMediaId: `media-input:sha256:${STAGED_SHA}`,
        targetMimeType: "video/mp4",
      } as ProductionJobInput),
    ];
    const reachable = collectReachableArtifactKeys(jobs);
    expect(reachable.has("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4")).toBe(true);
    expect(reachable.has(`media-transcode-inputs/${STAGED_SHA}.bin`)).toBe(true);
    // Inputs of terminal jobs age out through retention instead of reachability.
    expect(reachable.has(`media-transcode-inputs/${"a".repeat(64)}.bin`)).toBe(false);
  });

  it("plans keep/sweep with retention, legal hold, and outside-scope protection", async () => {
    const storage = await createStorage();
    const bytes = new TextEncoder().encode("bytes");
    await storage.put("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4", bytes);
    await storage.put("production-jobs/job-done/job.json", bytes);
    await storage.put("production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4", bytes);
    await storage.put("production-jobs/job-held/attempts/job-held-attempt-1/held.mp4", bytes);
    await storage.put(`media-transcode-inputs/${STAGED_SHA}.bin`, bytes);
    await storage.put(`media-transcode-inputs/${"d".repeat(64)}.bin`, bytes);

    const jobs = [
      job("job-done", "succeeded", "media.proxy", { sourceMediaId: "media-1" } as ProductionJobInput, "proxy.mp4"),
      job("job-active", "queued", "media.transcode", {
        sourceMediaId: `media-input:sha256:${STAGED_SHA}`,
        targetMimeType: "video/mp4",
      } as ProductionJobInput),
    ];

    // A clock far in the future makes every object older than the retention window.
    const future = Date.now() + 7 * 24 * 60 * 60_000;
    const plan = await planArtifactStorageGc({
      storage,
      jobs,
      now: () => future,
      minimumAgeMs: 60_000,
      isLegalHold: (key) => key.includes("job-held"),
    });

    const byKey = new Map(plan.entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4")).toMatchObject({
      action: "keep",
      keepReason: "reachable",
    });
    expect(byKey.get("production-jobs/job-done/job.json")).toMatchObject({
      action: "keep",
      keepReason: "outside-scope",
    });
    expect(byKey.get("production-jobs/job-held/attempts/job-held-attempt-1/held.mp4")).toMatchObject({
      action: "keep",
      keepReason: "legal-hold",
    });
    expect(byKey.get(`media-transcode-inputs/${STAGED_SHA}.bin`)).toMatchObject({
      action: "keep",
      keepReason: "reachable",
    });
    expect(byKey.get("production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4")).toMatchObject({
      action: "sweep",
      sweepReason: "unreachable",
    });
    expect(byKey.get(`media-transcode-inputs/${"d".repeat(64)}.bin`)).toMatchObject({
      action: "sweep",
      sweepReason: "unreachable",
    });

    // With the real clock every object is younger than the window: nothing sweeps.
    const retainedPlan = await planArtifactStorageGc({ storage, jobs, minimumAgeMs: 60 * 60_000 });
    expect(retainedPlan.entries.every((entry) => entry.action === "keep")).toBe(true);
    expect(
      retainedPlan.entries.find(
        (entry) => entry.key === "production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4",
      ),
    ).toMatchObject({ keepReason: "retained" });
  });

  it("sweeps retention-expired reachable artifacts while legal hold and min age still protect", async () => {
    const storage = await createStorage();
    const bytes = new TextEncoder().encode("bytes");
    await storage.put("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4", bytes);
    await storage.put("production-jobs/job-held/attempts/job-held-attempt-1/held.mp4", bytes);
    await storage.put("production-jobs/job-fresh/attempts/job-fresh-attempt-1/fresh.mp4", bytes);

    const jobs = [
      job("job-done", "succeeded", "media.proxy", { sourceMediaId: "media-1" } as ProductionJobInput, "proxy.mp4"),
      job("job-held", "succeeded", "media.proxy", { sourceMediaId: "media-2" } as ProductionJobInput, "held.mp4"),
      job("job-fresh", "succeeded", "media.proxy", { sourceMediaId: "media-3" } as ProductionJobInput, "fresh.mp4"),
    ];
    const retentionExpiredKeys = new Set([
      "production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4",
      "production-jobs/job-held/attempts/job-held-attempt-1/held.mp4",
    ]);

    const future = Date.now() + 7 * 24 * 60 * 60_000;
    const plan = await planArtifactStorageGc({
      storage,
      jobs,
      now: () => future,
      minimumAgeMs: 60_000,
      isLegalHold: (key) => key.includes("job-held"),
      retentionExpiredKeys,
    });

    const byKey = new Map(plan.entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4")).toMatchObject({
      action: "sweep",
      sweepReason: "retention-expired",
    });
    expect(byKey.get("production-jobs/job-held/attempts/job-held-attempt-1/held.mp4")).toMatchObject({
      action: "keep",
      keepReason: "legal-hold",
    });
    expect(byKey.get("production-jobs/job-fresh/attempts/job-fresh-attempt-1/fresh.mp4")).toMatchObject({
      action: "keep",
      keepReason: "reachable",
    });

    // With the real clock the expired key is still younger than the minimum age: kept as retained.
    const retainedPlan = await planArtifactStorageGc({
      storage,
      jobs,
      minimumAgeMs: 60 * 60_000,
      retentionExpiredKeys,
    });
    expect(
      retainedPlan.entries.find(
        (entry) => entry.key === "production-jobs/job-done/attempts/job-done-attempt-1/proxy.mp4",
      ),
    ).toMatchObject({ action: "keep", keepReason: "retained" });
  });

  it("dry-runs by default and only deletes when explicitly executed", async () => {
    const storage = await createStorage();
    const bytes = new TextEncoder().encode("orphan");
    await storage.put("production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4", bytes);

    const plan = await planArtifactStorageGc({
      storage,
      jobs: [],
      now: () => Date.now() + 60 * 60_000,
      minimumAgeMs: 1,
    });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]!.action).toBe("sweep");

    const dryRun = await sweepArtifactStorageGc(storage, plan);
    expect(dryRun).toMatchObject({ dryRun: true, deletedKeys: [], reclaimedBytes: bytes.byteLength });
    expect(await storage.get("production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4")).not.toBeNull();

    const executed = await sweepArtifactStorageGc(storage, plan, { dryRun: false });
    expect(executed).toMatchObject({
      dryRun: false,
      deletedKeys: ["production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4"],
      reclaimedBytes: bytes.byteLength,
      skippedKeys: [],
    });
    expect(await storage.get("production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4")).toBeNull();

    // Replaying the same plan skips the already-deleted object instead of failing.
    const replay = await sweepArtifactStorageGc(storage, plan, { dryRun: false });
    expect(replay).toMatchObject({
      deletedKeys: [],
      skippedKeys: [plan.entries[0]!.key],
      skipped: [{ key: plan.entries[0]!.key, code: "already-absent", reason: expect.stringContaining("no longer") }],
    });
  });

  it("revalidates a stale plan: keys that became reachable or were rewritten are blocked with typed skips", async () => {
    const storage = await createStorage();
    const bytes = new TextEncoder().encode("bytes");
    const stagedKey = `media-transcode-inputs/${STAGED_SHA}.bin`;
    const rewrittenKey = "production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4";
    const sweepableKey = `media-transcode-inputs/${"d".repeat(64)}.bin`;
    await storage.put(stagedKey, bytes);
    await storage.put(rewrittenKey, bytes);
    await storage.put(sweepableKey, bytes);

    // With no job records every object is unreachable: all three plan as sweep.
    const plan = await planArtifactStorageGc({
      storage,
      jobs: [],
      now: () => Date.now() + 60 * 60_000,
      minimumAgeMs: 1,
    });
    expect(plan.entries.filter((entry) => entry.action === "sweep")).toHaveLength(3);

    // During the review window a queued job re-references the staged input…
    const jobsNow = [
      job("job-late", "queued", "media.transcode", {
        sourceMediaId: `media-input:sha256:${STAGED_SHA}`,
        targetMimeType: "video/mp4",
      } as ProductionJobInput),
    ];
    // …and the orphan artifact is rewritten under the same key after planning.
    await storage.put(rewrittenKey, new TextEncoder().encode("rewritten"));
    const afterPlan = new Date(Date.parse(plan.plannedAt) + 60_000);
    await utimes(storage.absolutePath(rewrittenKey), afterPlan, afterPlan);

    const { executable, blocked } = await revalidateArtifactGcSweep({ storage, jobs: jobsNow, plan });
    expect(blocked).toHaveLength(2);
    expect(blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: stagedKey, code: "became-reachable" }),
        expect.objectContaining({ key: rewrittenKey, code: "modified-since-plan" }),
      ]),
    );

    const result = await sweepArtifactStorageGc(storage, executable, { dryRun: false });
    expect(result.deletedKeys).toEqual([sweepableKey]);
    expect(await storage.get(stagedKey)).not.toBeNull();
    expect(await storage.get(rewrittenKey)).not.toBeNull();

    // A key that is reachable but retention-expired at sweep time stays sweepable.
    const expiredStill = await revalidateArtifactGcSweep({
      storage,
      jobs: jobsNow,
      plan,
      retentionExpiredKeys: new Set([stagedKey]),
    });
    expect(expiredStill.blocked.map((skip) => skip.key)).not.toContain(stagedKey);
  });

  it("records delete failures as typed skips with the backend's reason", async () => {
    const storage = await createStorage();
    const key = "production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4";
    await storage.put(key, new TextEncoder().encode("orphan"));
    const plan = await planArtifactStorageGc({
      storage,
      jobs: [],
      now: () => Date.now() + 60 * 60_000,
      minimumAgeMs: 1,
    });

    const failing: ArtifactStorageBackend = {
      kind: storage.kind,
      put: (putKey, bytes) => storage.put(putKey, bytes),
      get: (getKey) => storage.get(getKey),
      head: (headKey) => storage.head(headKey),
      list: (prefix) => storage.list(prefix),
      delete: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const result = await sweepArtifactStorageGc(failing, plan, { dryRun: false });
    expect(result).toMatchObject({
      deletedKeys: [],
      skippedKeys: [key],
      skipped: [{ key, code: "delete-failed", reason: "EACCES: permission denied" }],
    });
    expect(await storage.get(key)).not.toBeNull();
  });
});
