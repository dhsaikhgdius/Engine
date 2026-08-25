import { describe, expect, it } from "vitest";

import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  createProductionGraphIdentityMap,
  migrateProductionGraphIdentities,
} from "../../../../src/comprehensive/editor/productionGraph/productionGraphMigration";

const migratedAt = "2026-08-03T00:00:00.000Z";

describe("ProductionGraph identity migration", () => {
  it("backfills deterministic identities and emits an immutable receipt", () => {
    const project = createDefaultDirectorProject();
    const result = migrateProductionGraphIdentities(project, { migratedAt });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.receipt.status).toBe("applied");
    expect(result.receipt.added.length).toBe(result.identityMap.entries.length);
    expect(result.receipt.afterFingerprint).toBe(result.identityMap.fingerprint);
    expect(result.receipt.receiptId).toMatch(/^production-graph-migration:v1:sha256:[0-9a-f]{64}$/);
  });

  it("dual-reads an existing map and returns a deterministic noop", () => {
    const project = createDefaultDirectorProject();
    const first = migrateProductionGraphIdentities(project, { migratedAt });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const second = migrateProductionGraphIdentities(project, { existing: first.identityMap, migratedAt });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.receipt).toMatchObject({
      status: "noop",
      added: [],
      preservedCount: first.identityMap.entries.length,
      beforeFingerprint: first.identityMap.fingerprint,
      afterFingerprint: first.identityMap.fingerprint,
    });
  });

  it("blocks a conflicting legacy mapping and preserves the source project", () => {
    const project = createDefaultDirectorProject();
    const first = migrateProductionGraphIdentities(project, { migratedAt });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const [entry, ...rest] = first.identityMap.entries;
    const corrupted = createProductionGraphIdentityMap([
      { ...entry!, graphNodeId: `${entry!.kind}:different` },
      ...rest,
    ]);
    const conflicting = migrateProductionGraphIdentities(project, { existing: corrupted, migratedAt });
    expect(conflicting.success).toBe(false);
    expect(conflicting.identityMap).toBeNull();
    expect(conflicting.receipt).toMatchObject({
      status: "conflict",
      afterFingerprint: null,
      conflicts: [
        {
          kind: entry!.kind,
          sourceId: entry!.sourceId,
          existingGraphNodeId: `${entry!.kind}:different`,
          expectedGraphNodeId: entry!.graphNodeId,
        },
      ],
    });
  });

  it("keeps removed legacy identities as stale additive evidence", () => {
    const project = createDefaultDirectorProject();
    const first = migrateProductionGraphIdentities(project, { migratedAt });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const existing = createProductionGraphIdentityMap([
      ...first.identityMap.entries,
      { kind: "object", sourceId: "removed-object", graphNodeId: "object:removed-object" },
    ]);
    const migrated = migrateProductionGraphIdentities(project, { existing, migratedAt });
    expect(migrated.success).toBe(true);
    if (!migrated.success) return;
    expect(migrated.receipt.stalePreservedCount).toBe(1);
    expect(migrated.identityMap.entries).toContainEqual({
      kind: "object",
      sourceId: "removed-object",
      graphNodeId: "object:removed-object",
    });
  });
});
