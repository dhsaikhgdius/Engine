/**
 * @module Production graph Zod schemas, types, and parsing utilities for the production DAG.
 */

import { z } from "zod";
import { protocolKeys } from "@director/protocol/primitives";
import { productionJobStatusSchema } from "@director/protocol/production-job";
import { productionArtifactKindSchema } from "@director/protocol/production-artifact";
import { strictKind } from "@director/protocol/strict-variant";
import { directorCameraAspectRatioSchema } from "@director/protocol/camera";
import productionGraphProtocol from "./productionGraphProtocol.json";
import {
  directorAssetKindSchema,
  directorAssetSourceTypeSchema,
  directorObjectKindSchema,
} from "../directorProjectSchema";

/** All node kind identifiers. */
export type ProductionGraphNodeKind = keyof typeof productionGraphProtocol.nodeKinds;
/** All edge kind identifiers. */
export type ProductionGraphEdgeKind = keyof typeof productionGraphProtocol.edgeKinds;
/** Ordered list of node kinds. */
export const PRODUCTION_GRAPH_NODE_KINDS = protocolKeys(productionGraphProtocol.nodeKinds);
/** Ordered list of edge kinds. */
export const PRODUCTION_GRAPH_EDGE_KINDS = protocolKeys(productionGraphProtocol.edgeKinds);

/** Graph schema identifier. */
export const PRODUCTION_GRAPH_SCHEMA = "director.production-graph" as const;
/** Graph schema version. */
export const PRODUCTION_GRAPH_SCHEMA_VERSION = 1 as const;

const namespacedIdPattern = /^[a-z][a-z0-9-]*:[A-Za-z0-9._~%-]+$/;
const edgeIdPattern = /^edge:[a-z][a-z0-9_-]*:sha256:[a-f0-9]{64}$/;
const graphIdSchema = z.string().min(3).max(1_024).regex(namespacedIdPattern);
const edgeIdSchema = z.string().max(1_024).regex(edgeIdPattern);
const displayNameSchema = z.string().min(1).max(1_024);
const finiteFrameSchema = z.number().int().finite();
const optionalSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();

function nodeIdSchema(namespace: ProductionGraphNodeKind) {
  return graphIdSchema.refine((value) => value.startsWith(`${namespace}:`), {
    message: `Expected a ${namespace}: namespaced node id.`,
  });
}

const productionNodeSchema = strictKind("production", {
  id: nodeIdSchema("production"),
  name: displayNameSchema,
  source: strictKind("director-project", {
    version: z.literal(1),
    sourceProductionId: z.string().min(1),
    revision: z.string().regex(/^director-project-revision:v1:sha256:[a-f0-9]{64}$/),
  }).readonly(),
});

const sceneNodeSchema = strictKind("scene", {
  id: nodeIdSchema("scene"),
  name: displayNameSchema,
  sourceSceneId: z.string().min(1),
  sourceRevision: z.string().regex(/^director-project-revision:v1:sha256:[a-f0-9]{64}$/),
});

const assetNodeSchema = strictKind("asset", {
  id: nodeIdSchema("asset"),
  name: displayNameSchema,
  sourceAssetId: z.string().min(1),
  assetKind: directorAssetKindSchema,
  sourceType: directorAssetSourceTypeSchema,
  assetSource: z.enum(["local", "library", "remote", "generated"]).optional(),
  fileName: z.string().min(1),
});

const objectNodeSchema = strictKind("object", {
  id: nodeIdSchema("object"),
  name: displayNameSchema,
  sourceObjectId: z.string().min(1),
  objectKind: directorObjectKindSchema,
  visible: z.boolean(),
  assetRefId: z.string().min(1).optional(),
});

const cameraNodeSchema = strictKind("camera", {
  id: nodeIdSchema("camera"),
  name: displayNameSchema,
  sourceCameraId: z.string().min(1),
  focalLengthMm: z.number().finite().positive().optional(),
  aspectRatio: directorCameraAspectRatioSchema.optional(),
  targetObjectId: z.string().min(1).nullable().optional(),
});

const shotNodeSchema = strictKind("shot", {
  id: nodeIdSchema("shot"),
  name: displayNameSchema,
  sourceShotId: z.string().min(1),
  source: z.literal("storyboard"),
  scriptBeatId: z.string().optional(),
  cameraId: z.string().nullable(),
  frameStart: finiteFrameSchema,
  frameEnd: finiteFrameSchema,
});

const takeNodeSchema = strictKind("take", {
  id: nodeIdSchema("take"),
  name: displayNameSchema,
  sourceTakeId: z.string().min(1),
  frameStart: finiteFrameSchema,
  frameEnd: finiteFrameSchema,
});

const coverageNodeSchema = strictKind("coverage", {
  id: nodeIdSchema("coverage"),
  name: displayNameSchema,
  sourceCoverageId: z.string().min(1),
  sourceSequenceId: z.string().min(1),
  cameraId: z.string().min(1),
  takeId: z.string().min(1),
  storyboardShotId: z.string().min(1).optional(),
  frameStart: finiteFrameSchema,
  frameEnd: finiteFrameSchema,
});

const artifactNodeSchema = strictKind("artifact", {
  id: nodeIdSchema("artifact"),
  name: displayNameSchema,
  artifactKind: productionArtifactKindSchema,
  version: z.number().int().positive(),
  immutable: z.literal(true),
  mimeType: z.string().min(1).optional(),
  uri: z.string().min(1).optional(),
  sha256: optionalSha256Schema,
  bytes: z.number().int().nonnegative().optional(),
});

const jobNodeSchema = strictKind("job", {
  id: nodeIdSchema("job"),
  name: displayNameSchema,
  jobType: z.string().min(1),
  status: productionJobStatusSchema,
  inputFingerprint: z.string().min(1).optional(),
  attempt: z.number().int().positive().default(1),
});

const reviewNodeSchema = strictKind("review", {
  id: nodeIdSchema("review"),
  name: displayNameSchema,
  status: z.enum(["open", "changes_requested", "approved", "rejected", "resolved"]),
  reviewerId: z.string().min(1).optional(),
  comment: z.string().optional(),
  createdAt: z.string().min(1).optional(),
});

const approvalNodeSchema = strictKind("approval", {
  id: nodeIdSchema("approval"),
  name: displayNameSchema,
  status: z.enum(["pending", "approved", "rejected", "revoked"]),
  approverId: z.string().min(1).optional(),
  decidedAt: z.string().min(1).optional(),
});

/** Discriminated union schema for all production graph node kinds. */
export const productionGraphNodeSchema = z
  .discriminatedUnion("kind", [
    productionNodeSchema,
    sceneNodeSchema,
    assetNodeSchema,
    objectNodeSchema,
    cameraNodeSchema,
    shotNodeSchema,
    takeNodeSchema,
    coverageNodeSchema,
    artifactNodeSchema,
    jobNodeSchema,
    reviewNodeSchema,
    approvalNodeSchema,
  ])
  .readonly();

function edgeSchema<Kind extends ProductionGraphEdgeKind>(kind: Kind) {
  return strictKind(kind, {
    id: edgeIdSchema,
    from: graphIdSchema,
    to: graphIdSchema,
    role: z.string().min(1).max(128).optional(),
  });
}

/** Discriminated union schema for all production graph edge kinds. */
export const productionGraphEdgeSchema = z
  .discriminatedUnion("kind", [
    edgeSchema("contains"),
    edgeSchema("uses"),
    edgeSchema("derived_from"),
    edgeSchema("renders"),
    edgeSchema("references"),
    edgeSchema("promoted_to"),
    edgeSchema("reviewed_by"),
  ])
  .readonly();

/** Top-level production graph schema with nodes and edges arrays. */
export const productionGraphSchema = z
  .strictObject({
    schema: z.literal(PRODUCTION_GRAPH_SCHEMA),
    version: z.literal(PRODUCTION_GRAPH_SCHEMA_VERSION),
    productionId: nodeIdSchema("production"),
    nodes: z.array(productionGraphNodeSchema).readonly(),
    edges: z.array(productionGraphEdgeSchema).readonly(),
  })
  .readonly();

/** Schema for production graph content-addressable fingerprint strings. */
export const productionGraphFingerprintSchema = z.string().regex(/^production-graph:v1:sha256:[a-f0-9]{64}$/);

/** A validated production graph node. */
export type ProductionGraphNode = z.output<typeof productionGraphNodeSchema>;
/** A validated production graph edge. */
export type ProductionGraphEdge = z.output<typeof productionGraphEdgeSchema>;
/** A validated production graph. */
export type ProductionGraphV1 = z.output<typeof productionGraphSchema>;
/** A production graph fingerprint string. */
export type ProductionGraphFingerprint = z.output<typeof productionGraphFingerprintSchema>;

/** Extracts node types of a specific kind from the discriminated union. */
export type ProductionGraphNodeOfKind<Kind extends ProductionGraphNodeKind> = Extract<
  ProductionGraphNode,
  { kind: Kind }
>;

/**
 * Parses and validates an unknown value as a production graph.
 *
 * @param value - The value to parse.
 * @returns A validated production graph.
 * @throws ZodError if validation fails.
 */
export function parseProductionGraph(value: unknown): ProductionGraphV1 {
  return productionGraphSchema.parse(value);
}

/**
 * Safely parses an unknown value as a production graph.
 *
 * @param value - The value to parse.
 * @returns A success result with the graph, or a failure with the ZodError.
 */
export function safeParseProductionGraph(
  value: unknown,
):
  | { readonly success: true; readonly graph: ProductionGraphV1 }
  | { readonly success: false; readonly error: z.ZodError<ProductionGraphV1> } {
  const result = productionGraphSchema.safeParse(value);
  return result.success ? { success: true, graph: result.data } : { success: false, error: result.error };
}
