import { describe, expect, it } from "vitest";
import {
  PRODUCTION_JOB_CONTRACT_VERSION,
  PRODUCTION_JOB_KINDS,
  canTransitionProductionJob,
  canvasJobInputSchema,
  enqueueCanvasJobRequestSchema,
  enqueueProductionJobRequestSchema,
  hashInputFingerprint,
  isTerminalProductionJobStatus,
  productionJobRecordSchema,
  productionJobSpecSchema,
  transitionProductionJob,
  type ProductionJobRecord,
} from "../src/productionJobProtocol";

function sampleJob(status: ProductionJobRecord["status"] = "queued"): ProductionJobRecord {
  const now = new Date().toISOString();
  const attemptId = "job-1-attempt-1";
  return productionJobRecordSchema.parse({
    contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
    id: "job-1",
    kind: "canvas.image",
    status,
    progress: 0,
    inputFingerprint: "fp-abc",
    idempotencyKey: "canvas-image:node-1",
    input: {
      nodeId: "board-node-1",
      prompt: "Test",
      width: 1024,
      height: 576,
    },
    attempts: [
      {
        id: attemptId,
        number: 1,
        status,
        provider: "director.test",
        inputFingerprint: "fp-abc",
        idempotencyKey: "canvas-image:node-1",
        sourceRevisions: { canvas: 3 },
        timestamps: {
          createdAt: now,
          startedAt: status === "queued" ? undefined : now,
          outcomeUnknownAt: status === "outcome_unknown" ? now : undefined,
          reconciliationStartedAt: status === "reconciling" ? now : undefined,
          finishedAt: isTerminalProductionJobStatus(status) ? now : undefined,
        },
        artifacts: [],
      },
    ],
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  });
}

describe("productionJobProtocol", () => {
  it("hashes input fingerprints deterministically", () => {
    const input = {
      nodeId: "board-node-1",
      prompt: "A rainy alley",
      width: 1024,
      height: 576,
    };
    const first = hashInputFingerprint("canvas.image", canvasJobInputSchema.parse(input));
    const second = hashInputFingerprint("canvas.image", canvasJobInputSchema.parse(input));
    expect(first).toBe(second);
    expect(first.startsWith("fp-")).toBe(true);
  });

  it("uses a versioned discriminated union for every supported kind", () => {
    const requests = [
      { kind: "canvas.image", input: { nodeId: "n1", prompt: "still" } },
      { kind: "canvas.video", input: { nodeId: "n2", prompt: "motion" } },
      { kind: "image.generate", input: { prompt: "portrait" } },
      { kind: "video.generate", input: { prompt: "shot" } },
      {
        kind: "model.generate",
        input: { mode: "text-to-3d", providerId: "meshy", name: "Chair", prompt: "wooden chair" },
      },
      { kind: "audio.generate", input: { prompt: "rain" } },
      { kind: "media.proxy", input: { sourceMediaId: "media-1" } },
      {
        kind: "media.transcribe",
        input: {
          sourceMediaId: "media-1",
          sourceSha256: "a".repeat(64),
          sourceMimeType: "audio/wav",
          sourceFileName: "dialogue.wav",
          model: "whisper-1",
        },
      },
      { kind: "media.transcode", input: { sourceMediaId: "media-1", targetMimeType: "video/mp4" } },
      {
        kind: "scene.reconstruct",
        input: {
          sourceMediaId: `media-input:sha256:${"a".repeat(64)}`,
          sourceKind: "rgbd-bundle",
          fileName: "living-room.zip",
        },
      },
      { kind: "dcc.export", input: { projectId: "project-1", format: "usd" } },
      { kind: "dcc.import", input: { sourceArtifactId: "artifact-1" } },
    ];
    const parsedKinds = requests.map(
      (request, index) => enqueueProductionJobRequestSchema.parse({ ...request, idempotencyKey: `key-${index}` }).kind,
    );
    expect(parsedKinds).toEqual(requests.map((request) => request.kind));
    expect(productionJobSpecSchema.options.map((option) => option.shape.kind.value)).toEqual(PRODUCTION_JOB_KINDS);
    expect(enqueueProductionJobRequestSchema.options.map((option) => option.shape.kind.value)).toEqual(
      PRODUCTION_JOB_KINDS,
    );
    expect(
      productionJobSpecSchema.safeParse({
        kind: "media.proxy",
        input: { nodeId: "wrong-shape", prompt: "not proxy input" },
      }).success,
    ).toBe(false);
    expect(
      productionJobSpecSchema.parse({ kind: "audio.generate", input: { prompt: "distant thunder" } }),
    ).toMatchObject({
      kind: "audio.generate",
      input: {
        mode: "sound-effect",
        durationSeconds: 10,
        sampleRate: 48_000,
        workflowId: "comfy-workflow-configured-audio",
        nodeId: "comfy-default",
      },
    });
  });

  it("keeps the legacy Canvas request shape while defaulting contract metadata", () => {
    const request = enqueueCanvasJobRequestSchema.parse({
      kind: "canvas.image",
      idempotencyKey: "canvas-image:node-1",
      input: { nodeId: "board-node-1", prompt: "Neon portrait", width: 1024, height: 576 },
    });
    expect(request.kind).toBe("canvas.image");
    expect(request.contractVersion).toBe(PRODUCTION_JOB_CONTRACT_VERSION);
    expect(request.provider).toBe("director.local");
  });

  it("validates records with an attempt-bound contract", () => {
    const record = sampleJob();
    expect(record.contractVersion).toBe(PRODUCTION_JOB_CONTRACT_VERSION);
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.sourceRevisions).toEqual({ canvas: 3 });
  });

  it("rejects inconsistent attempt timestamps and divergent artifact projections", () => {
    const runningWithoutStart = structuredClone(sampleJob("running"));
    delete runningWithoutStart.attempts[0]!.timestamps.startedAt;
    expect(productionJobRecordSchema.safeParse(runningWithoutStart).success).toBe(false);

    const record = sampleJob();
    record.artifacts.push({
      id: "orphaned-projection",
      attemptId: record.attempts[0]!.id,
      role: "primary",
      mimeType: "image/png",
      fileName: "orphan.png",
      sha256: "a".repeat(64),
      bytes: 1,
      createdAt: record.createdAt,
    });
    expect(productionJobRecordSchema.safeParse(record).success).toBe(false);
  });

  it("marks succeeded, failed, and cancelled as terminal", () => {
    expect(isTerminalProductionJobStatus("succeeded")).toBe(true);
    expect(isTerminalProductionJobStatus("failed")).toBe(true);
    expect(isTerminalProductionJobStatus("running")).toBe(false);
    expect(isTerminalProductionJobStatus("reconciling")).toBe(false);
  });

  it("requires outcome_unknown to pass through reconciling", () => {
    expect(canTransitionProductionJob("queued", "running")).toBe(true);
    expect(canTransitionProductionJob("running", "outcome_unknown")).toBe(true);
    expect(canTransitionProductionJob("outcome_unknown", "succeeded")).toBe(false);
    expect(canTransitionProductionJob("outcome_unknown", "reconciling")).toBe(true);
    expect(canTransitionProductionJob("reconciling", "queued")).toBe(true);

    const running = transitionProductionJob(sampleJob(), "running");
    const unknown = transitionProductionJob(running, "outcome_unknown", { error: "provider timed out" });
    expect(() => transitionProductionJob(unknown, "succeeded")).toThrow(/Invalid production job transition/);
    const reconciling = transitionProductionJob(unknown, "reconciling");
    const retried = transitionProductionJob(reconciling, "queued");
    expect(retried.attempts).toHaveLength(2);
    expect(retried.attempts[0]).toMatchObject({
      id: "job-1-attempt-1",
      number: 1,
      status: "failed",
      error: { code: "reconciled_not_accepted", retryable: true },
    });
    expect(retried.attempts[1]).toMatchObject({ id: "job-1-attempt-2", number: 2, status: "queued" });
  });

  it("throws on invalid transitions", () => {
    expect(() => transitionProductionJob(sampleJob(), "succeeded")).toThrow(/Invalid production job transition/);
  });
});
