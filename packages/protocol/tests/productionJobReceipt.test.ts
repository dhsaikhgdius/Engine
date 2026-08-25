import { describe, expect, it } from "vitest";
import {
  PRODUCTION_JOB_CONTRACT_VERSION,
  hashInputFingerprint,
  productionJobRecordSchema,
  transitionProductionJob,
  type ProductionJobInput,
  type ProductionJobKind,
  type ProductionJobRecord,
} from "../src/productionJobProtocol";
import {
  PRODUCTION_JOB_RECEIPT_CONTRACT,
  productionJobReceiptSchema,
  projectProductionJobReceipt,
} from "../src/productionJobReceipt";

const NOW = "2026-08-25T12:00:00.000Z";

function queuedJob(kind: ProductionJobKind, input: ProductionJobInput, id = `job-${kind}`): ProductionJobRecord {
  const fingerprint = hashInputFingerprint(kind, input);
  return productionJobRecordSchema.parse({
    contractVersion: PRODUCTION_JOB_CONTRACT_VERSION,
    id,
    kind,
    status: "queued",
    progress: 0,
    inputFingerprint: fingerprint,
    idempotencyKey: `${kind}:receipt-test`,
    input,
    attempts: [
      {
        id: `${id}-attempt-1`,
        number: 1,
        status: "queued",
        provider: "director.test",
        inputFingerprint: fingerprint,
        idempotencyKey: `${kind}:receipt-test`,
        sourceRevisions: {},
        timestamps: { createdAt: NOW },
        artifacts: [],
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    artifacts: [],
  });
}

const NORMALIZED_KINDS: readonly { kind: ProductionJobKind; input: ProductionJobInput }[] = [
  { kind: "image.generate", input: { prompt: "A rainy street" } as ProductionJobInput },
  { kind: "video.generate", input: { prompt: "A slow dolly-in" } as ProductionJobInput },
  { kind: "media.proxy", input: { sourceMediaId: "media-1" } as ProductionJobInput },
  {
    kind: "media.transcode",
    input: { sourceMediaId: "media-1", targetMimeType: "video/mp4" } as ProductionJobInput,
  },
  {
    kind: "dcc.export",
    input: { projectId: "project-1", format: "glb" } as ProductionJobInput,
  },
];

describe("projectProductionJobReceipt", () => {
  it("normalizes generation, DCC, transcode, and proxy jobs into one receipt shape", () => {
    for (const { kind, input } of NORMALIZED_KINDS) {
      const receipt = projectProductionJobReceipt(queuedJob(kind, input));
      expect(receipt).toMatchObject({
        contract: PRODUCTION_JOB_RECEIPT_CONTRACT,
        kind,
        status: "queued",
        terminal: false,
        attemptCount: 1,
        attempt: { number: 1, provider: "director.test" },
        timestamps: { createdAt: NOW, updatedAt: NOW },
        artifacts: [],
      });
      expect(Object.keys(receipt).sort()).toEqual(
        Object.keys(projectProductionJobReceipt(queuedJob("image.generate", { prompt: "x" } as ProductionJobInput)))
          .sort(),
      );
      expect(() => productionJobReceiptSchema.parse(receipt)).not.toThrow();
    }
  });

  it("projects lifecycle timestamps, structured errors, and artifacts deterministically", () => {
    const queued = queuedJob("media.proxy", { sourceMediaId: "media-2" } as ProductionJobInput, "job-lifecycle");
    const running = transitionProductionJob(queued, "running", { progress: 0.4, updatedAt: NOW });
    const artifact = {
      id: "job-lifecycle-attempt-1-artifact-1",
      attemptId: "job-lifecycle-attempt-1",
      role: "primary",
      mimeType: "video/mp4",
      fileName: "proxy.mp4",
      sha256: "a".repeat(64),
      bytes: 1024,
      createdAt: NOW,
    };
    const succeeded = transitionProductionJob(running, "succeeded", {
      progress: 1,
      message: "Succeeded",
      artifact,
      updatedAt: NOW,
    });

    const receipt = projectProductionJobReceipt(succeeded);
    expect(receipt).toMatchObject({
      status: "succeeded",
      terminal: true,
      progress: 1,
      message: "Succeeded",
      timestamps: { startedAt: NOW, finishedAt: NOW },
      artifacts: [artifact],
      primaryArtifactId: artifact.id,
    });
    expect(projectProductionJobReceipt(succeeded)).toEqual(receipt);
  });

  it("surfaces outcome-unknown and reconciliation evidence with retry attempts", () => {
    const queued = queuedJob("video.generate", { prompt: "Paid remote request" } as ProductionJobInput, "job-paid");
    const running = transitionProductionJob(queued, "running", { updatedAt: NOW });
    const unknown = transitionProductionJob(running, "outcome_unknown", {
      updatedAt: NOW,
      structuredError: { code: "provider_timeout", message: "Acknowledgement timed out", retryable: false },
      error: "Acknowledgement timed out",
    });
    expect(projectProductionJobReceipt(unknown)).toMatchObject({
      status: "outcome_unknown",
      terminal: false,
      timestamps: { outcomeUnknownAt: NOW },
      error: { code: "provider_timeout", retryable: false },
    });

    const reconciling = transitionProductionJob(unknown, "reconciling", { updatedAt: NOW });
    expect(projectProductionJobReceipt(reconciling).timestamps.reconciliationStartedAt).toBe(NOW);

    const retried = transitionProductionJob(reconciling, "queued", { updatedAt: NOW });
    const retriedReceipt = projectProductionJobReceipt(retried);
    expect(retriedReceipt).toMatchObject({
      status: "queued",
      attemptCount: 2,
      attempt: { id: "job-paid-attempt-2", number: 2 },
    });
  });

  it("rejects receipts whose invariants are violated", () => {
    const receipt = projectProductionJobReceipt(
      queuedJob("image.generate", { prompt: "Guarded" } as ProductionJobInput, "job-guarded"),
    );
    expect(() => productionJobReceiptSchema.parse({ ...receipt, terminal: true })).toThrow(/terminal/);
    expect(() =>
      productionJobReceiptSchema.parse({ ...receipt, attempt: { ...receipt.attempt, number: 5 } }),
    ).toThrow(/latest attempt/);
    expect(() => productionJobReceiptSchema.parse({ ...receipt, primaryArtifactId: "missing" })).toThrow(
      /primaryArtifactId/,
    );
  });
});
