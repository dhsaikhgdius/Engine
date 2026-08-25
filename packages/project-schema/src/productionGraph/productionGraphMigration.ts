import { z } from "zod";
import { stableLexicalJson } from "@director/protocol/stable-json";

import type { DirectorProject } from "../directorProjectSchema";
import { sha256HexSync } from "../directorProjectRevision";
import {
  createProductionGraphFromDirectorProject,
  type DirectorProjectProductionGraphOptions,
} from "./directorProjectProductionGraph";
import { canonicalizeProductionGraph, getProductionGraphFingerprint } from "./productionGraph";
import {
  PRODUCTION_GRAPH_IDENTITY_MAP_CONTRACT,
  productionGraphIdentityEntrySchema,
  productionGraphIdentityMapSchema,
  productionGraphIdentityNodeKindSchema,
  type ProductionGraphIdentityEntry,
  type ProductionGraphIdentityMap,
} from "./productionGraphIdentityMap";
import { type ProductionGraphNode, type ProductionGraphNodeKind } from "./productionGraphSchema";

export {
  PRODUCTION_GRAPH_IDENTITY_MAP_CONTRACT,
  productionGraphIdentityEntrySchema,
  productionGraphIdentityMapSchema,
  productionGraphIdentityNodeKindSchema,
  type ProductionGraphIdentityEntry,
  type ProductionGraphIdentityMap,
} from "./productionGraphIdentityMap";

/** Contract identifier for the migration receipt format. */
export const PRODUCTION_GRAPH_IDENTITY_MIGRATION_RECEIPT_CONTRACT =
  "director-production-graph-identity-migration-v1" as const;

/** Fixed timestamp so load/export backfill is deterministic across peers. */
export const PRODUCTION_GRAPH_IDENTITY_PERSIST_MIGRATED_AT = "1970-01-01T00:00:00.000Z";

const migrationConflictSchema = z
  .strictObject({
    kind: productionGraphIdentityNodeKindSchema,
    sourceId: z.string().min(1),
    expectedGraphNodeId: z.string().min(1),
    existingGraphNodeId: z.string().min(1),
  })
  .readonly();

export const productionGraphIdentityMigrationReceiptSchema = z
  .strictObject({
    contract: z.literal(PRODUCTION_GRAPH_IDENTITY_MIGRATION_RECEIPT_CONTRACT),
    receiptId: z.string().regex(/^production-graph-migration:v1:sha256:[a-f0-9]{64}$/),
    status: z.enum(["noop", "applied", "conflict"]),
    sourceProjectRevision: z.string().regex(/^director-project-revision:v1:sha256:[a-f0-9]{64}$/),
    graphFingerprint: z.string().regex(/^production-graph:v1:sha256:[a-f0-9]{64}$/),
    beforeFingerprint: z
      .string()
      .regex(/^production-graph-identities:v1:sha256:[a-f0-9]{64}$/)
      .nullable(),
    afterFingerprint: z
      .string()
      .regex(/^production-graph-identities:v1:sha256:[a-f0-9]{64}$/)
      .nullable(),
    added: z.array(productionGraphIdentityEntrySchema),
    preservedCount: z.number().int().nonnegative(),
    stalePreservedCount: z.number().int().nonnegative(),
    conflicts: z.array(migrationConflictSchema),
    migratedAt: z.string().datetime({ offset: true }),
  })
  .readonly();

/** A migration receipt recording what was added, preserved, or conflicted. */
export type ProductionGraphIdentityMigrationReceipt = z.output<typeof productionGraphIdentityMigrationReceiptSchema>;

function compareEntry(left: ProductionGraphIdentityEntry, right: ProductionGraphIdentityEntry): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.graphNodeId.localeCompare(right.graphNodeId)
  );
}

function identityMapFingerprint(entries: readonly ProductionGraphIdentityEntry[]): string {
  return `production-graph-identities:v1:sha256:${sha256HexSync(stableLexicalJson([...entries].sort(compareEntry)))}`;
}

/**
 * Creates a validated identity map from entries.
 *
 * @param entriesInput - The identity entries, sorted and fingerprinted.
 * @returns A validated identity map.
 */
export function createProductionGraphIdentityMap(
  entriesInput: readonly ProductionGraphIdentityEntry[],
): ProductionGraphIdentityMap {
  const entries = [...entriesInput].sort(compareEntry);
  return productionGraphIdentityMapSchema.parse({
    contract: PRODUCTION_GRAPH_IDENTITY_MAP_CONTRACT,
    entries,
    fingerprint: identityMapFingerprint(entries),
  });
}

function sourceIdForNode(node: ProductionGraphNode): string | null {
  switch (node.kind) {
    case "production":
      return node.source.sourceProductionId;
    case "scene":
      return node.sourceSceneId;
    case "asset":
      return node.sourceAssetId;
    case "object":
      return node.sourceObjectId;
    case "camera":
      return node.sourceCameraId;
    case "shot":
      return node.sourceShotId;
    case "take":
      return node.sourceTakeId;
    case "coverage":
      return `${node.sourceSequenceId}/${node.sourceCoverageId}`;
    case "artifact":
    case "job":
    case "review":
    case "approval":
      return null;
  }
}

/** Options for migrating production graph identities. */
export interface MigrateProductionGraphIdentitiesOptions extends DirectorProjectProductionGraphOptions {
  /** Existing identity map to preserve. */
  readonly existing?: ProductionGraphIdentityMap | null;
  /** ISO 8601 timestamp of the migration. */
  readonly migratedAt: string;
}

/** Result of an identity migration: either success with a new map, or conflict with a receipt. */
export type ProductionGraphIdentityMigrationResult =
  | {
      readonly success: true;
      readonly identityMap: ProductionGraphIdentityMap;
      readonly receipt: ProductionGraphIdentityMigrationReceipt;
    }
  | {
      readonly success: false;
      readonly identityMap: null;
      readonly receipt: ProductionGraphIdentityMigrationReceipt;
    };

/**
 * Additive dual-read migration: existing identities are never rewritten or
 * removed. Missing deterministic identities are appended, while a changed
 * mapping is reported as a blocking receipt instead of mutating source truth.
 *
 * @param project - The Director project.
 * @param options - Migration options including existing identity map and timestamp.
 * @returns A success result with the merged identity map, or a conflict result.
 */
export function migrateProductionGraphIdentities(
  project: DirectorProject,
  options: MigrateProductionGraphIdentitiesOptions,
): ProductionGraphIdentityMigrationResult {
  const graph = createProductionGraphFromDirectorProject(project, options);
  // Canonicalization validates the complete graph before emitting migration evidence.
  canonicalizeProductionGraph(graph);
  const expected = graph.nodes.flatMap((node) => {
    const sourceId = sourceIdForNode(node);
    return sourceId ? [{ kind: node.kind, sourceId, graphNodeId: node.id } satisfies ProductionGraphIdentityEntry] : [];
  });
  const existingInput = options.existing === undefined ? (project.productionGraphIdentities ?? null) : options.existing;
  const existing = existingInput ? productionGraphIdentityMapSchema.parse(existingInput) : null;
  const existingBySource = new Map(existing?.entries.map((entry) => [`${entry.kind}:${entry.sourceId}`, entry]));
  const expectedSourceKeys = new Set(expected.map((entry) => `${entry.kind}:${entry.sourceId}`));
  const added: ProductionGraphIdentityEntry[] = [];
  const conflicts: Array<{
    kind: ProductionGraphNodeKind;
    sourceId: string;
    expectedGraphNodeId: string;
    existingGraphNodeId: string;
  }> = [];
  let preservedCount = 0;

  expected.forEach((entry) => {
    const current = existingBySource.get(`${entry.kind}:${entry.sourceId}`);
    if (!current) added.push(entry);
    else if (current.graphNodeId === entry.graphNodeId) preservedCount += 1;
    else {
      conflicts.push({
        kind: entry.kind,
        sourceId: entry.sourceId,
        expectedGraphNodeId: entry.graphNodeId,
        existingGraphNodeId: current.graphNodeId,
      });
    }
  });

  const stalePreservedCount =
    existing?.entries.filter((entry) => !expectedSourceKeys.has(`${entry.kind}:${entry.sourceId}`)).length ?? 0;
  const merged = conflicts.length ? null : createProductionGraphIdentityMap([...(existing?.entries ?? []), ...added]);
  const receiptPayload = {
    contract: PRODUCTION_GRAPH_IDENTITY_MIGRATION_RECEIPT_CONTRACT,
    status: conflicts.length ? ("conflict" as const) : added.length ? ("applied" as const) : ("noop" as const),
    sourceProjectRevision: graph.nodes.find((node) => node.kind === "production")!.source.revision,
    graphFingerprint: getProductionGraphFingerprint(graph),
    beforeFingerprint: existing?.fingerprint ?? null,
    afterFingerprint: merged?.fingerprint ?? null,
    added: [...added].sort(compareEntry),
    preservedCount,
    stalePreservedCount,
    conflicts: conflicts.sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId),
    ),
    migratedAt: options.migratedAt,
  };
  const receipt = productionGraphIdentityMigrationReceiptSchema.parse({
    ...receiptPayload,
    receiptId: `production-graph-migration:v1:sha256:${sha256HexSync(stableLexicalJson(receiptPayload))}`,
  });
  return merged ? { success: true, identityMap: merged, receipt } : { success: false, identityMap: null, receipt };
}

/**
 * Write missing ProductionGraph identities onto the project document.
 *
 * Existing mappings are never rewritten. A conflict receipt leaves the source
 * project unchanged. The attached map is omitted from the project revision.
 *
 * @param project - Director project to backfill.
 * @returns The same project, or a copy with `productionGraphIdentities` attached.
 */
export function persistProductionGraphIdentities(project: DirectorProject): DirectorProject {
  const existing = project.productionGraphIdentities ?? null;
  const result = migrateProductionGraphIdentities(project, {
    existing,
    migratedAt: PRODUCTION_GRAPH_IDENTITY_PERSIST_MIGRATED_AT,
  });
  if (!result.success) return project;
  if (existing?.fingerprint === result.identityMap.fingerprint && project.productionGraphIdentities) {
    return project;
  }
  return { ...project, productionGraphIdentities: result.identityMap };
}
