import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createProductionArtifactPromotion,
  type ProductionApprovalFingerprint,
  type ProductionArtifactVersionInput,
  type ProductionApprovalInput,
} from "../../../../packages/protocol/src/productionArtifactProtocol";
import {
  ProductionArtifactConflictError,
  ProductionArtifactStore,
  ProductionArtifactValidationError,
} from "../../artifacts/productionArtifactStore";

const now = "2026-08-03T00:00:00.000Z";
const LIVE_PROJECT: ProductionApprovalFingerprint = {
  kind: "project",
  value: `director-project-revision:v1:sha256:${"c".repeat(64)}`,
};

function bindLiveProject(fingerprints: readonly ProductionApprovalFingerprint[]): ProductionApprovalFingerprint[] {
  return [...fingerprints, LIVE_PROJECT].sort((left, right) => left.kind.localeCompare(right.kind));
}

function versionInput(id = "artifact-version:shot/unsafe:1", ordinal = 1): ProductionArtifactVersionInput {
  return {
    contract: "director-artifact-version-v1",
    versionId: id,
    artifactId: "artifact:shot-1",
    ordinal,
    immutable: true,
    kind: "image",
    name: "Clean frame",
    content: {
      sha256: "a".repeat(64),
      bytes: 10,
      mimeType: "image/png",
      fileName: "clean.png",
    },
    provenance: {
      kind: "capture",
      projectRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}`,
      sceneId: "scene-1",
      cameraId: "camera-1",
      frame: 24,
    },
    sourceVersionIds: [],
    createdAt: now,
    createdBy: "agent:camera",
  };
}

async function createStore(): Promise<{ directory: string; store: ProductionArtifactStore }> {
  const directory = await mkdtemp(join(tmpdir(), "director-artifacts-"));
  return { directory, store: new ProductionArtifactStore(directory) };
}

describe("ProductionArtifactStore", () => {
  it("persists immutable versions under readable collision-safe names and reloads them", async () => {
    const { directory, store } = await createStore();
    const first = await store.putVersion(versionInput());
    expect(first.replayed).toBe(false);
    expect((await store.putVersion(versionInput())).replayed).toBe(true);
    const files = await readdir(join(directory, "production-artifacts", "versions"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^artifact-version-shot-unsafe-1-[0-9a-f]{12}\.json$/);

    const restored = new ProductionArtifactStore(directory);
    expect(await restored.getVersion(first.version.versionId)).toEqual(first.version);
  });

  it("still reads records persisted under the legacy sha256 filenames", async () => {
    const { directory, store } = await createStore();
    const { version } = await store.putVersion(versionInput());
    const versionsDirectory = join(directory, "production-artifacts", "versions");
    const [readableName] = await readdir(versionsDirectory);
    const legacyName = `${createHash("sha256").update(version.versionId).digest("hex")}.json`;
    await rename(join(versionsDirectory, readableName!), join(versionsDirectory, legacyName));

    const restored = new ProductionArtifactStore(directory);
    expect(await restored.getVersion(version.versionId)).toEqual(version);
  });

  it("rejects immutable id and artifact ordinal conflicts", async () => {
    const { store } = await createStore();
    await store.putVersion(versionInput());
    await expect(
      store.putVersion({
        ...versionInput(),
        content: { ...versionInput().content, sha256: "c".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ProductionArtifactConflictError);
    await expect(store.putVersion(versionInput("artifact-version:other:1"))).rejects.toBeInstanceOf(
      ProductionArtifactConflictError,
    );
  });

  it("serializes concurrent immutable writes and promotion compare-and-swap operations", async () => {
    const { store } = await createStore();
    const concurrentVersions = await Promise.allSettled([
      store.putVersion(versionInput("artifact-version:concurrent-a:1")),
      store.putVersion(versionInput("artifact-version:concurrent-b:1")),
    ]);
    expect(concurrentVersions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentVersions.filter((result) => result.status === "rejected")).toHaveLength(1);

    const first = (
      concurrentVersions.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<
        Awaited<ReturnType<ProductionArtifactStore["putVersion"]>>
      >
    ).value.version;
    const second = await store.putVersion(versionInput("artifact-version:concurrent:2", 2));
    const target = { workspace: "stage", ownerId: "object-concurrent", slot: "asset" } as const;
    const promotions = await Promise.allSettled([
      store.promote({
        promotionId: "promotion-concurrent-a",
        target,
        versionId: first.versionId,
        expectedPreviousVersionId: null,
        promotedAt: now,
        promotedBy: "agent:director",
      }),
      store.promote({
        promotionId: "promotion-concurrent-b",
        target,
        versionId: second.version.versionId,
        expectedPreviousVersionId: null,
        promotedAt: now,
        promotedBy: "agent:director",
      }),
    ]);
    expect(promotions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(promotions.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("uses optimistic promotion pointers and restores them after restart", async () => {
    const { directory, store } = await createStore();
    const { version } = await store.putVersion(versionInput());
    const target = { workspace: "stage", ownerId: "object-1", slot: "asset" } as const;
    const promoted = await store.promote({
      promotionId: "promotion-1",
      target,
      versionId: version.versionId,
      expectedPreviousVersionId: null,
      promotedAt: now,
      promotedBy: "agent:director",
    });
    expect(promoted.replayed).toBe(false);
    await expect(
      store.promote({
        promotionId: "promotion-2",
        target,
        versionId: version.versionId,
        expectedPreviousVersionId: null,
        promotedAt: "2026-08-03T00:01:00.000Z",
        promotedBy: "agent:director",
      }),
    ).rejects.toBeInstanceOf(ProductionArtifactConflictError);
    expect(await new ProductionArtifactStore(directory).getCurrentPromotion(target)).toEqual(promoted.promotion);
  });

  it("only replays an identical promotion request and repairs an interrupted pointer commit", async () => {
    const { directory, store } = await createStore();
    const first = await store.putVersion(versionInput("artifact-version:replay:1"));
    const second = await store.putVersion(versionInput("artifact-version:replay:2", 2));
    const target = { workspace: "video", ownerId: "sequence-1", slot: "master" } as const;
    const initial = await store.promote({
      promotionId: "promotion-replay-1",
      target,
      versionId: first.version.versionId,
      expectedPreviousVersionId: null,
      promotedAt: now,
      promotedBy: "agent:editor",
    });
    await expect(
      store.promote({
        promotionId: "promotion-replay-1",
        target,
        versionId: second.version.versionId,
        expectedPreviousVersionId: null,
        promotedAt: "2026-08-03T00:01:00.000Z",
        promotedBy: "agent:editor",
      }),
    ).rejects.toBeInstanceOf(ProductionArtifactConflictError);
    expect(
      await store.promote({
        promotionId: "promotion-replay-1",
        target,
        versionId: first.version.versionId,
        expectedPreviousVersionId: null,
        promotedAt: "2026-08-03T00:01:00.000Z",
        promotedBy: "agent:editor",
      }),
    ).toMatchObject({ replayed: true, promotion: initial.promotion });

    const interrupted = createProductionArtifactPromotion({
      promotionId: "promotion-interrupted",
      target,
      version: second.version,
      previousVersionId: first.version.versionId,
      promotedAt: "2026-08-03T00:02:00.000Z",
      promotedBy: "agent:editor",
    });
    const interruptedName = `${createHash("sha256").update(interrupted.promotionId).digest("hex")}.json`;
    await writeFile(
      join(directory, "production-artifacts", "promotions", interruptedName),
      `${JSON.stringify(interrupted, null, 2)}\n`,
      "utf8",
    );

    const restored = new ProductionArtifactStore(directory);
    expect(await restored.getCurrentPromotion(target)).toEqual(initial.promotion);
    expect(
      await restored.promote({
        promotionId: interrupted.promotionId,
        target,
        versionId: second.version.versionId,
        expectedPreviousVersionId: first.version.versionId,
        promotedAt: interrupted.promotedAt,
        promotedBy: interrupted.promotedBy,
      }),
    ).toMatchObject({ replayed: true, promotion: interrupted });
    expect(await new ProductionArtifactStore(directory).getCurrentPromotion(target)).toEqual(interrupted);
  });

  it("does not roll a newer pointer back while replaying an interrupted promotion event", async () => {
    const { directory, store } = await createStore();
    const first = await store.putVersion(versionInput("artifact-version:no-rollback:1"));
    const second = await store.putVersion(versionInput("artifact-version:no-rollback:2", 2));
    const target = { workspace: "video", ownerId: "sequence-no-rollback", slot: "master" } as const;
    await store.promote({
      promotionId: "promotion-no-rollback-initial",
      target,
      versionId: first.version.versionId,
      expectedPreviousVersionId: null,
      promotedAt: now,
      promotedBy: "agent:editor",
    });

    const interrupted = createProductionArtifactPromotion({
      promotionId: "promotion-no-rollback-interrupted",
      target,
      version: second.version,
      previousVersionId: first.version.versionId,
      promotedAt: "2026-08-03T00:01:00.000Z",
      promotedBy: "agent:editor",
    });
    const interruptedName = `${createHash("sha256").update(interrupted.promotionId).digest("hex")}.json`;
    await writeFile(
      join(directory, "production-artifacts", "promotions", interruptedName),
      `${JSON.stringify(interrupted, null, 2)}\n`,
      "utf8",
    );

    const later = await store.promote({
      promotionId: "promotion-no-rollback-later",
      target,
      versionId: first.version.versionId,
      expectedPreviousVersionId: first.version.versionId,
      promotedAt: "2026-08-03T00:02:00.000Z",
      promotedBy: "agent:editor",
    });
    const restored = new ProductionArtifactStore(directory);
    expect(await restored.getCurrentPromotion(target)).toEqual(later.promotion);
    await expect(
      restored.promote({
        promotionId: interrupted.promotionId,
        target,
        versionId: second.version.versionId,
        expectedPreviousVersionId: first.version.versionId,
        promotedAt: interrupted.promotedAt,
        promotedBy: interrupted.promotedBy,
      }),
    ).resolves.toMatchObject({ replayed: true, promotion: interrupted });
    expect(await restored.getCurrentPromotion(target)).toEqual(later.promotion);
  });

  it("requires fingerprint-current approval when policy demands it", async () => {
    const { store } = await createStore();
    const { version } = await store.putVersion(versionInput());
    const bindings: ProductionApprovalFingerprint[] = bindLiveProject([
      { kind: "artifact", value: version.recordFingerprint },
    ]);
    const { approval } = await store.putApproval({
      contract: "director-production-approval-v1",
      approvalId: "approval-1",
      scope: { kind: "artifact-version", versionId: version.versionId },
      decision: "approved",
      fingerprints: bindings,
      reviewerId: "reviewer-1",
      checklist: [],
      decidedAt: now,
    });
    await expect(
      store.promote({
        promotionId: "promotion-stale",
        target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
        versionId: version.versionId,
        expectedPreviousVersionId: null,
        approvalIds: [approval.approvalId],
        observedFingerprints: bindLiveProject([
          { kind: "artifact", value: `artifact-version:v1:sha256:${"9".repeat(64)}` },
        ]),
        promotedAt: now,
        promotedBy: "agent:producer",
        requireCurrentApproval: true,
      }),
    ).rejects.toThrow(/No approval matches/);
    await expect(
      store.promote({
        promotionId: "promotion-current",
        target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
        versionId: version.versionId,
        expectedPreviousVersionId: null,
        approvalIds: [approval.approvalId],
        observedFingerprints: bindings,
        promotedAt: now,
        promotedBy: "agent:producer",
        requireCurrentApproval: true,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("rejects superseded approvals and preserves a single immutable review lineage", async () => {
    const { store } = await createStore();
    const { version } = await store.putVersion(versionInput());
    const { approval: original } = await store.putApproval({
      contract: "director-production-approval-v1",
      approvalId: "approval-original",
      scope: { kind: "artifact-version", versionId: version.versionId },
      decision: "approved",
      fingerprints: bindLiveProject([{ kind: "artifact", value: version.recordFingerprint }]),
      reviewerId: "reviewer-1",
      checklist: [],
      decidedAt: now,
    });
    const priorPromotion = await store.promote({
      promotionId: "promotion-before-supersession",
      target: { workspace: "delivery", ownerId: "delivery-before-supersession", slot: "master" },
      versionId: version.versionId,
      expectedPreviousVersionId: null,
      approvalIds: [original.approvalId],
      observedFingerprints: original.fingerprints,
      promotedAt: "2026-08-03T00:00:30.000Z",
      promotedBy: "agent:producer",
      requireCurrentApproval: true,
    });
    const replacementInput = {
      contract: "director-production-approval-v1" as const,
      approvalId: "approval-replacement",
      scope: original.scope,
      decision: "rejected",
      fingerprints: original.fingerprints.map((fingerprint) => ({ ...fingerprint })),
      reviewerId: original.reviewerId,
      checklist: original.checklist.map((item) => ({ ...item })),
      decidedAt: "2026-08-03T00:01:00.000Z",
      supersedesApprovalId: original.approvalId,
    } satisfies ProductionApprovalInput;
    await expect(
      store.putApproval({
        ...replacementInput,
        approvalId: "approval-chronologically-earlier",
        decidedAt: "2026-08-03T01:00:00.000+02:00",
      }),
    ).rejects.toBeInstanceOf(ProductionArtifactValidationError);
    const { approval: replacement } = await store.putApproval(replacementInput);
    await expect(
      store.promote({
        promotionId: priorPromotion.promotion.promotionId,
        target: priorPromotion.promotion.target,
        versionId: priorPromotion.promotion.versionId,
        expectedPreviousVersionId: priorPromotion.promotion.previousVersionId,
        approvalIds: priorPromotion.promotion.approvalIds,
        observedFingerprints: original.fingerprints,
        promotedAt: "2026-08-03T00:03:00.000Z",
        promotedBy: priorPromotion.promotion.promotedBy,
        requireCurrentApproval: true,
      }),
    ).resolves.toMatchObject({ replayed: true, promotion: priorPromotion.promotion });
    await expect(
      store.promote({
        promotionId: "promotion-superseded",
        target: { workspace: "delivery", ownerId: "delivery-1", slot: "master" },
        versionId: version.versionId,
        expectedPreviousVersionId: null,
        approvalIds: [original.approvalId],
        observedFingerprints: original.fingerprints,
        promotedAt: "2026-08-03T00:02:00.000Z",
        promotedBy: "agent:producer",
        requireCurrentApproval: true,
      }),
    ).rejects.toThrow(/superseded/);
    await expect(
      store.putApproval({
        ...replacementInput,
        approvalId: "approval-branch",
        decidedAt: "2026-08-03T00:02:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ProductionArtifactConflictError);
  });

  it("skips tampered evidence files with a warning instead of failing the whole store", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { directory, store } = await createStore();
      const { version } = await store.putVersion(versionInput());
      const intact = await store.putVersion(versionInput("artifact-version:intact:2", 2));
      const files = await readdir(join(directory, "production-artifacts", "versions"));
      const tamperedName = files.find((name) => name.startsWith("artifact-version-shot-unsafe-1-"));
      const path = join(directory, "production-artifacts", "versions", tamperedName!);
      const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, `${JSON.stringify({ ...persisted, name: "tampered" }, null, 2)}\n`, "utf8");

      const restored = new ProductionArtifactStore(directory);
      expect(await restored.getVersion(version.versionId)).toBeNull();
      expect(await restored.getVersion(intact.version.versionId)).toEqual(intact.version);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(tamperedName!));
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects new approvals that omit a live project revision fingerprint", async () => {
    const { store } = await createStore();
    const { version } = await store.putVersion(versionInput());
    await expect(
      store.putApproval({
        contract: "director-production-approval-v1",
        approvalId: "approval-unbound",
        scope: { kind: "artifact-version", versionId: version.versionId },
        decision: "approved",
        fingerprints: [{ kind: "artifact", value: version.recordFingerprint }],
        reviewerId: "reviewer-1",
        checklist: [],
        decidedAt: now,
      }),
    ).rejects.toBeInstanceOf(ProductionArtifactValidationError);
  });

  it("treats a changed live project revision as a stale approval", async () => {
    const { store } = await createStore();
    const { version } = await store.putVersion(versionInput());
    const bindings = bindLiveProject([{ kind: "artifact", value: version.recordFingerprint }]);
    const { approval } = await store.putApproval({
      contract: "director-production-approval-v1",
      approvalId: "approval-live-project",
      scope: { kind: "artifact-version", versionId: version.versionId },
      decision: "approved",
      fingerprints: bindings,
      reviewerId: "reviewer-1",
      checklist: [],
      decidedAt: now,
    });
    await expect(
      store.promote({
        promotionId: "promotion-stale-project",
        target: { workspace: "delivery", ownerId: "delivery-stale-project", slot: "master" },
        versionId: version.versionId,
        expectedPreviousVersionId: null,
        approvalIds: [approval.approvalId],
        observedFingerprints: bindLiveProject([{ kind: "artifact", value: version.recordFingerprint }]).map(
          (fingerprint) =>
            fingerprint.kind === "project"
              ? { kind: "project" as const, value: `director-project-revision:v1:sha256:${"d".repeat(64)}` }
              : fingerprint,
        ),
        promotedAt: now,
        promotedBy: "agent:producer",
      }),
    ).rejects.toThrow(/No approval matches|stale|project/);
    await expect(
      store.promote({
        promotionId: "promotion-current-project",
        target: { workspace: "delivery", ownerId: "delivery-current-project", slot: "master" },
        versionId: version.versionId,
        expectedPreviousVersionId: null,
        approvalIds: [approval.approvalId],
        observedFingerprints: bindings,
        promotedAt: now,
        promotedBy: "agent:producer",
      }),
    ).resolves.toMatchObject({ replayed: false });
  });
});
