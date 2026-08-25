import { describe, expect, it } from "vitest";

import {
  createProductionArtifactPromotion,
  createProductionArtifactVersion,
  createProductionApproval,
  evaluateProductionApproval,
  getProductionApprovalFingerprint,
  getProductionArtifactVersionFingerprint,
  productionArtifactVersionSchema,
  productionEvidenceRequestSchema,
  type ProductionApproval,
  type ProductionApprovalFingerprint,
  type ProductionArtifactVersionInput,
} from "../src/productionArtifactProtocol";

const now = "2026-08-03T00:00:00.000Z";
const contentHash = "a".repeat(64);

function versionInput(overrides: Partial<ProductionArtifactVersionInput> = {}): ProductionArtifactVersionInput {
  return {
    contract: "director-artifact-version-v1",
    versionId: "artifact-version:shot-1:1",
    artifactId: "artifact:shot-1",
    ordinal: 1,
    immutable: true,
    kind: "video",
    name: "Shot 1 render",
    content: {
      sha256: contentHash,
      bytes: 42,
      mimeType: "video/mp4",
      fileName: "shot-1.mp4",
    },
    provenance: {
      kind: "job",
      jobId: "job-1",
      attemptId: "attempt-1",
      inputFingerprint: `sha256:${"b".repeat(64)}`,
    },
    sourceVersionIds: [],
    createdAt: now,
    createdBy: "agent:director",
    ...overrides,
  };
}

function approval(fingerprints: readonly ProductionApprovalFingerprint[]): ProductionApproval {
  return createProductionApproval({
    contract: "director-production-approval-v1",
    approvalId: "approval-1",
    scope: { kind: "artifact-version", versionId: "artifact-version:shot-1:1" },
    decision: "approved",
    fingerprints: [...fingerprints],
    reviewerId: "reviewer-1",
    checklist: [{ id: "clean-frame", passed: true }],
    decidedAt: now,
  });
}

describe("production artifact protocol", () => {
  it("creates stable immutable version fingerprints independent of lineage input order", () => {
    const left = createProductionArtifactVersion(
      versionInput({ sourceVersionIds: ["artifact-version:source-b:1", "artifact-version:source-a:1"] }),
    );
    const right = createProductionArtifactVersion(
      versionInput({ sourceVersionIds: ["artifact-version:source-a:1", "artifact-version:source-b:1"] }),
    );
    expect(left.recordFingerprint).toBe(right.recordFingerprint);
    expect(left.sourceVersionIds).toEqual(["artifact-version:source-a:1", "artifact-version:source-b:1"]);
    expect(productionArtifactVersionSchema.parse(left)).toEqual(left);
  });

  it("normalizes schema defaults before exposing record fingerprints", () => {
    const { sourceVersionIds: _sourceVersionIds, ...versionWithoutDefaults } = versionInput();
    const createdVersion = createProductionArtifactVersion(versionWithoutDefaults);
    expect(getProductionArtifactVersionFingerprint(versionWithoutDefaults)).toBe(createdVersion.recordFingerprint);

    const approvalWithoutDefaults = {
      contract: "director-production-approval-v1" as const,
      approvalId: "approval-defaults",
      scope: { kind: "artifact-version" as const, versionId: createdVersion.versionId },
      decision: "approved" as const,
      fingerprints: [{ kind: "artifact" as const, value: createdVersion.recordFingerprint }],
      reviewerId: "reviewer-1",
      decidedAt: now,
    };
    const createdApproval = createProductionApproval(approvalWithoutDefaults);
    expect(getProductionApprovalFingerprint(approvalWithoutDefaults)).toBe(createdApproval.recordFingerprint);
  });

  it("rejects duplicate lineage and self-derived versions", () => {
    expect(() =>
      createProductionArtifactVersion(
        versionInput({ sourceVersionIds: ["artifact-version:source-a:1", "artifact-version:source-a:1"] }),
      ),
    ).toThrow(/unique/);
    expect(() =>
      createProductionArtifactVersion(versionInput({ sourceVersionIds: ["artifact-version:shot-1:1"] })),
    ).toThrow(/cannot derive from itself/);
  });

  it("rejects tampered record fingerprints and unsafe content filenames", () => {
    const version = createProductionArtifactVersion(versionInput());
    expect(() => productionArtifactVersionSchema.parse({ ...version, name: "Tampered render" })).toThrow(
      /recordFingerprint/,
    );
    expect(() =>
      createProductionArtifactVersion(
        versionInput({ content: { ...versionInput().content, fileName: "../delivery.mp4" } }),
      ),
    ).toThrow(/safe base name/);
  });

  it("deep-freezes immutable evidence, including nested arrays and objects", () => {
    const version = createProductionArtifactVersion(
      versionInput({ sourceVersionIds: ["artifact-version:source-a:1"] }),
    );
    const decision = approval([{ kind: "artifact", value: version.recordFingerprint }]);
    const promotion = createProductionArtifactPromotion({
      promotionId: "promotion-frozen",
      target: { workspace: "stage", ownerId: "shot-1", slot: "source" },
      version,
      previousVersionId: null,
      approvals: [decision],
      promotedAt: now,
      promotedBy: "agent:director",
    });

    expect(Object.isFrozen(version.sourceVersionIds)).toBe(true);
    expect(Object.isFrozen(version.provenance)).toBe(true);
    expect(Object.isFrozen(decision.scope)).toBe(true);
    expect(Object.isFrozen(decision.fingerprints)).toBe(true);
    expect(Object.isFrozen(promotion.approvalIds)).toBe(true);
    expect(() => (version.sourceVersionIds as string[]).push("artifact-version:source-b:1")).toThrow();
  });

  it("projects approved decisions as stale when any bound fingerprint changes", () => {
    const bindings: ProductionApprovalFingerprint[] = [
      { kind: "project", value: `director-project-revision:v1:sha256:${"1".repeat(64)}` },
      { kind: "artifact", value: `artifact-version:v1:sha256:${"2".repeat(64)}` },
    ];
    const decision = approval(bindings);
    expect(evaluateProductionApproval(decision, bindings)).toMatchObject({ current: true });
    expect(
      evaluateProductionApproval(decision, [
        bindings[0]!,
        { kind: "artifact", value: `artifact-version:v1:sha256:${"3".repeat(64)}` },
      ]),
    ).toMatchObject({ current: false, staleKinds: ["artifact"] });
  });

  it("creates append-only promotion events and enforces current approvals", () => {
    const version = createProductionArtifactVersion(versionInput());
    const fingerprints: ProductionApprovalFingerprint[] = [{ kind: "artifact", value: version.recordFingerprint }];
    const decision = approval(fingerprints);
    const promotion = createProductionArtifactPromotion({
      promotionId: "promotion-2",
      target: { workspace: "video", ownerId: "clip-1", slot: "source" },
      version,
      previousVersionId: "artifact-version:shot-1:0",
      approvals: [decision],
      observedFingerprints: fingerprints,
      promotedAt: now,
      promotedBy: "agent:editor",
      requireCurrentApproval: true,
    });
    expect(promotion).toMatchObject({
      versionId: version.versionId,
      previousVersionId: "artifact-version:shot-1:0",
      approvalIds: ["approval-1"],
    });
    expect(() =>
      createProductionArtifactPromotion({
        promotionId: "promotion-stale",
        target: { workspace: "video", ownerId: "clip-1", slot: "source" },
        version,
        previousVersionId: null,
        approvals: [decision],
        observedFingerprints: [{ kind: "artifact", value: `artifact-version:v1:sha256:${"9".repeat(64)}` }],
        promotedAt: now,
        promotedBy: "agent:editor",
        requireCurrentApproval: true,
      }),
    ).toThrow(/No approval matches/);
  });

  it("requires approval scope and artifact binding to match the exact promotion", () => {
    const version = createProductionArtifactVersion(versionInput());
    const { recordFingerprint: _wrongScopeFingerprint, ...wrongScopeInput } = approval([
      { kind: "artifact", value: version.recordFingerprint },
    ]);
    const wrongScope = createProductionApproval({
      ...wrongScopeInput,
      scope: { kind: "artifact-version", versionId: "artifact-version:other:1" },
    });
    expect(() =>
      createProductionArtifactPromotion({
        promotionId: "promotion-wrong-scope",
        target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
        version,
        previousVersionId: null,
        approvals: [wrongScope],
        promotedAt: now,
        promotedBy: "agent:producer",
      }),
    ).toThrow(/does not apply/);

    const noArtifactBinding = approval([
      { kind: "project", value: `director-project-revision:v1:sha256:${"7".repeat(64)}` },
    ]);
    expect(() =>
      createProductionArtifactPromotion({
        promotionId: "promotion-unbound",
        target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
        version,
        previousVersionId: null,
        approvals: [noArtifactBinding],
        promotedAt: now,
        promotedBy: "agent:producer",
      }),
    ).toThrow(/not bound/);
  });

  it("rejects ambiguous observed fingerprints and self-superseding approvals at the contract boundary", () => {
    expect(() =>
      productionEvidenceRequestSchema.parse({
        op: "promote",
        promotion_id: "promotion-retry-safe",
        target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
        version_id: "artifact-version:shot-1:1",
        expected_previous_version_id: null,
        observed_fingerprints: [
          { kind: "artifact", value: `artifact-version:v1:sha256:${"1".repeat(64)}` },
          { kind: "artifact", value: `artifact-version:v1:sha256:${"2".repeat(64)}` },
        ],
        promoted_by: "agent:producer",
      }),
    ).toThrow(/unique/);
    const { recordFingerprint: _approvalFingerprint, ...approvalInput } = approval([
      { kind: "artifact", value: `artifact-version:v1:sha256:${"2".repeat(64)}` },
    ]);
    expect(() =>
      createProductionApproval({
        ...approvalInput,
        supersedesApprovalId: "approval-1",
      }),
    ).toThrow(/cannot supersede itself/);
  });
});
