import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_JOB_CONTRACT_VERSION,
  hashInputFingerprint,
  productionJobRecordSchema,
  transitionProductionJob,
  type ProductionJobArtifact,
  type ProductionJobInput,
  type ProductionJobRecord,
} from "../../../../packages/protocol/src/productionJobProtocol";
import {
  PRODUCTION_JOB_BRIDGE_CREATED_BY,
  productionArtifactKindFromMimeType,
  productionJobArtifactVersionInputs,
  registerProductionJobArtifactVersions,
} from "../../artifacts/productionJobArtifactBridge";
import { ProductionArtifactStore } from "../../artifacts/productionArtifactStore";

const NOW = "2026-08-25T12:00:00.000Z";

function artifact(attemptId: string, ordinal: number, role = "primary"): ProductionJobArtifact {
  return {
    id: `${attemptId}-artifact-${ordinal}`,
    attemptId,
    role,
    mimeType: role === "report" ? "application/json" : "video/mp4",
    fileName: role === "report" ? "report.json" : "output.mp4",
    sha256: `${ordinal}`.repeat(64).slice(0, 64),
    bytes: 100 + ordinal,
    createdAt: NOW,
  };
}

function succeededJob(): ProductionJobRecord {
  const input = { prompt: "Bridge test shot" } as ProductionJobInput;
  const fingerprint = hashInputFingerprint("video.generate", input);
  const key = "video.generate:bridge-test";
  const queued = productionJobRecordSchema.parse({
    contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
    id: "job-bridge",
    kind: "video.generate",
    status: "queued",
    progress: 0,
    inputFingerprint: fingerprint,
    idempotencyKey: key,
    input,
    attempts: [
      {
        id: "job-bridge-attempt-1",
        number: 1,
        status: "queued",
        provider: "remote.video",
        inputFingerprint: fingerprint,
        idempotencyKey: key,
        sourceRevisions: {},
        timestamps: { createdAt: NOW },
        artifacts: [],
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    artifacts: [],
  });
  const running = transitionProductionJob(queued, "running", { updatedAt: NOW });
  return transitionProductionJob(running, "succeeded", {
    progress: 1,
    updatedAt: NOW,
    artifacts: [artifact("job-bridge-attempt-1", 1), artifact("job-bridge-attempt-1", 2, "report")],
  });
}

describe("productionJobArtifactBridge", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createStore() {
    const dir = await mkdtemp(join(tmpdir(), "director-artifact-bridge-"));
    tempDirs.push(dir);
    return new ProductionArtifactStore(dir);
  }

  it("maps MIME types onto broad artifact kinds", () => {
    expect(productionArtifactKindFromMimeType("image/png")).toBe("image");
    expect(productionArtifactKindFromMimeType("video/mp4; codecs=avc1")).toBe("video");
    expect(productionArtifactKindFromMimeType("audio/wav")).toBe("audio");
    expect(productionArtifactKindFromMimeType("model/gltf-binary")).toBe("model");
    expect(productionArtifactKindFromMimeType("application/zip")).toBe("archive");
    expect(productionArtifactKindFromMimeType("application/json")).toBe("document");
    expect(productionArtifactKindFromMimeType("application/x-director")).toBe("other");
  });

  it("projects deterministic version inputs with job provenance", () => {
    const job = succeededJob();
    const inputs = productionJobArtifactVersionInputs(job);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      versionId: "production-job:job-bridge:job-bridge-attempt-1-artifact-1",
      artifactId: "production-job:job-bridge:primary",
      ordinal: 1,
      kind: "video",
      content: { fileName: "output.mp4", mimeType: "video/mp4" },
      provenance: {
        kind: "job",
        jobId: "job-bridge",
        attemptId: "job-bridge-attempt-1",
        inputFingerprint: `production-job:${job.inputFingerprint}`,
        provider: { provider: "remote.video" },
      },
      createdBy: PRODUCTION_JOB_BRIDGE_CREATED_BY,
    });
    expect(inputs[1]).toMatchObject({
      artifactId: "production-job:job-bridge:report",
      ordinal: 1,
      kind: "document",
    });
    expect(productionJobArtifactVersionInputs(job)).toEqual(inputs);
  });

  it("rejects jobs that are not succeeded", () => {
    const input = { prompt: "Not done" } as ProductionJobInput;
    const fingerprint = hashInputFingerprint("video.generate", input);
    const queued = productionJobRecordSchema.parse({
      contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
      id: "job-queued",
      kind: "video.generate",
      status: "queued",
      progress: 0,
      inputFingerprint: fingerprint,
      idempotencyKey: "video.generate:queued",
      input,
      attempts: [
        {
          id: "job-queued-attempt-1",
          number: 1,
          status: "queued",
          provider: "remote.video",
          inputFingerprint: fingerprint,
          idempotencyKey: "video.generate:queued",
          sourceRevisions: {},
          timestamps: { createdAt: NOW },
          artifacts: [],
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
      artifacts: [],
    });
    expect(() => productionJobArtifactVersionInputs(queued)).toThrow(/succeeded/);
  });

  it("registers versions idempotently and appends ordinals for retry attempts", async () => {
    const store = await createStore();
    const job = succeededJob();

    const first = await registerProductionJobArtifactVersions(store, job);
    expect(first.map((registration) => registration.replayed)).toEqual([false, false]);

    const replay = await registerProductionJobArtifactVersions(store, job);
    expect(replay.map((registration) => registration.replayed)).toEqual([true, true]);
    expect(replay[0]!.version.recordFingerprint).toBe(first[0]!.version.recordFingerprint);

    // A retried logical job: attempt 1 failed after producing its artifact,
    // attempt 2 succeeded. Both artifacts stay comparable under one artifactId.
    const input = { prompt: "Retry shot" } as ProductionJobInput;
    const fingerprint = hashInputFingerprint("video.generate", input);
    const key = "video.generate:retry";
    const attempt1Artifact = artifact("job-retry-attempt-1", 1);
    const attempt2Artifact = artifact("job-retry-attempt-2", 2);
    const retried = productionJobRecordSchema.parse({
      contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
      id: "job-retry",
      kind: "video.generate",
      status: "succeeded",
      progress: 1,
      inputFingerprint: fingerprint,
      idempotencyKey: key,
      input,
      attempts: [
        {
          id: "job-retry-attempt-1",
          number: 1,
          status: "failed",
          provider: "remote.video",
          inputFingerprint: fingerprint,
          idempotencyKey: key,
          sourceRevisions: {},
          timestamps: { createdAt: NOW, startedAt: NOW, finishedAt: NOW },
          error: { code: "provider_failed", message: "First attempt failed", retryable: true },
          artifacts: [{ ...attempt1Artifact, attemptId: "job-retry-attempt-1" }],
        },
        {
          id: "job-retry-attempt-2",
          number: 2,
          status: "succeeded",
          provider: "remote.video",
          inputFingerprint: fingerprint,
          idempotencyKey: key,
          sourceRevisions: {},
          timestamps: { createdAt: NOW, startedAt: NOW, finishedAt: NOW },
          artifacts: [{ ...attempt2Artifact, attemptId: "job-retry-attempt-2" }],
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
      artifacts: [
        { ...attempt1Artifact, attemptId: "job-retry-attempt-1" },
        { ...attempt2Artifact, attemptId: "job-retry-attempt-2" },
      ],
    });

    const registrations = await registerProductionJobArtifactVersions(store, retried);
    expect(registrations.map((registration) => registration.version.ordinal)).toEqual([1, 2]);
    expect(new Set(registrations.map((registration) => registration.version.artifactId))).toEqual(
      new Set(["production-job:job-retry:primary"]),
    );

    const versions = await store.listVersions("production-job:job-retry:primary");
    expect(versions).toHaveLength(2);
  });
});
