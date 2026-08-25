import { z } from "zod";
import { protocolKeys } from "@director/protocol/primitives";
import productionGraphProtocol from "./productionGraphProtocol.json";

const productionGraphIdentityNodeKinds = protocolKeys(productionGraphProtocol.nodeKinds);

/** Node kinds that can appear in a persisted identity map entry. */
export const productionGraphIdentityNodeKindSchema = z.enum(productionGraphIdentityNodeKinds);

/** Contract identifier for the identity map format. */
export const PRODUCTION_GRAPH_IDENTITY_MAP_CONTRACT = "director-production-graph-identities-v1" as const;

export const productionGraphIdentityEntrySchema = z
  .strictObject({
    kind: productionGraphIdentityNodeKindSchema,
    sourceId: z.string().min(1).max(1_024),
    graphNodeId: z.string().min(3).max(1_024),
  })
  .readonly();

/**
 * Additive graph identity envelope stored on DirectorProject.
 *
 * The map is portable production evidence, but it is omitted from the
 * director-project-revision hash so background backfill cannot churn
 * expected_revision guards or undo receipts.
 */
export const productionGraphIdentityMapSchema = z
  .strictObject({
    contract: z.literal(PRODUCTION_GRAPH_IDENTITY_MAP_CONTRACT),
    entries: z.array(productionGraphIdentityEntrySchema).max(100_000),
    fingerprint: z.string().regex(/^production-graph-identities:v1:sha256:[a-f0-9]{64}$/),
  })
  .superRefine((value, context) => {
    const bySource = new Set<string>();
    const byNode = new Set<string>();
    value.entries.forEach((entry, index) => {
      const sourceKey = `${entry.kind}:${entry.sourceId}`;
      if (bySource.has(sourceKey)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index],
          message: `Duplicate source identity ${sourceKey}.`,
        });
      }
      if (byNode.has(entry.graphNodeId)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "graphNodeId"],
          message: `Duplicate graph node identity ${entry.graphNodeId}.`,
        });
      }
      bySource.add(sourceKey);
      byNode.add(entry.graphNodeId);
    });
  })
  .readonly();

/** A single identity entry mapping a source id to its graph node id. */
export type ProductionGraphIdentityEntry = z.output<typeof productionGraphIdentityEntrySchema>;
/** A complete identity map with fingerprint. */
export type ProductionGraphIdentityMap = z.output<typeof productionGraphIdentityMapSchema>;
