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
import { FilesystemArtifactStorage } from "../../media/artifactStorage";
import {
  collectReachableArtifactKeys,
  planArtifactStorageGc,
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
      job("job-done", "succeeded", "media.proxy", { sourceMediaId: `media-input:sha256:${"a".repeat(64)}` } as ProductionJobInput, "proxy.mp4"),
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
    });
    expect(byKey.get(`media-transcode-inputs/${"d".repeat(64)}.bin`)).toMatchObject({ action: "sweep" });

    // With the real clock every object is younger than the window: nothing sweeps.
    const retainedPlan = await planArtifactStorageGc({ storage, jobs, minimumAgeMs: 60 * 60_000 });
    expect(retainedPlan.entries.every((entry) => entry.action === "keep")).toBe(true);
    expect(
      retainedPlan.entries.find(
        (entry) => entry.key === "production-jobs/job-gone/attempts/job-gone-attempt-1/orphan.mp4",
      ),
    ).toMatchObject({ keepReason: "retained" });
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
    expect(replay).toMatchObject({ deletedKeys: [], skippedKeys: [plan.entries[0]!.key] });
  });
});
