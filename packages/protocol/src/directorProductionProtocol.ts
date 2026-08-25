import { z } from "zod";
import type { DirectorProject } from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";
import { directorProjectSchema } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectSchema";
import { strictOperation } from "./strictProtocolVariant";

/**
 * Director production protocol: scene references, editorial timeline, and
 * production-level mutation operations.
 *
 * A production binds a title, a list of scene references, and an editorial
 * timeline of shots. Operations are applied against an expected revision so
 * the gateway can detect conflicts and reject stale writes.
 */

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nonNegativeInteger = z.number().int().nonnegative();

/** A lightweight reference to a scene within a production, carrying its id, title, and revision. */
export const productionSceneReferenceSchema = z.strictObject({
  sceneId: nonEmptyText(160),
  title: nonEmptyText(240),
  sourceRevision: nonNegativeInteger,
  createdAt: z.string(),
});

/** A shot in the editorial timeline, linked or pinned to a scene and optional camera. */
export const editorialShotSchema = z.strictObject({
  id: nonEmptyText(160),
  label: nonEmptyText(240),
  sceneId: nonEmptyText(160),
  cameraId: z.string().nullable(),
  frameStart: z.number().finite(),
  frameEnd: z.number().finite(),
  mode: z.enum(["linked", "pinned"]),
  sourceRevision: nonNegativeInteger.nullable(),
  actionStage: z.string().optional(),
});

/**
 * The persisted production record: an id, revision, timestamp, and the
 * production payload containing scenes and the editorial timeline.
 */
export const productionRecordSchema = z.strictObject({
  productionId: nonEmptyText(160),
  revision: nonNegativeInteger,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  production: z.strictObject({
    version: z.literal(1),
    title: nonEmptyText(240),
    activeSceneId: z.string().nullable(),
    scenes: z.array(productionSceneReferenceSchema),
    editorialTimeline: z.array(editorialShotSchema),
  }),
});

/**
 * The production record as returned by the API, with an optional mutation
 * envelope indicating whether the request was idempotently replayed.
 */
export const productionRecordResponseSchema = productionRecordSchema.extend({
  mutation: z.strictObject({ idempotencyReplayed: z.boolean() }).optional(),
});

/** A single mutation operation on a production: rename, add/remove scene, or edit the editorial timeline. */
export const productionOperationSchema = z.discriminatedUnion("op", [
  strictOperation("rename_production", { title: nonEmptyText(240) }),
  strictOperation("add_scene_reference", { sceneId: nonEmptyText(160), title: nonEmptyText(240) }),
  strictOperation("rename_scene", { sceneId: nonEmptyText(160), title: nonEmptyText(240) }),
  strictOperation("set_active_scene", { sceneId: nonEmptyText(160) }),
  strictOperation("remove_scene_reference", { sceneId: nonEmptyText(160) }),
  strictOperation("add_editorial_shot", {
    shot: editorialShotSchema.extend({ sourceRevision: nonNegativeInteger.optional() }),
  }),
  strictOperation("remove_editorial_shot", { id: nonEmptyText(160) }),
  strictOperation("refresh_editorial_shot", { id: nonEmptyText(160) }),
]);

/** A scene seed carried alongside a production update: the scene id and its full project document. */
export const productionSceneSeedSchema = z.strictObject({ sceneId: nonEmptyText(160), project: directorProjectSchema });

/** Request to update a production with a batch of operations, optionally seeding new scenes. */
export const productionUpdateRequestSchema = z.strictObject({
  expectedRevision: nonNegativeInteger,
  operations: z.array(productionOperationSchema).max(80),
  actor: z.string().trim().min(1).max(160).optional(),
  idempotencyKey: nonEmptyText(160).optional(),
  sceneSeeds: z.array(productionSceneSeedSchema).max(8).optional(),
});

/** Request to create a new scene within a production, optionally cloning an existing scene's project. */
export const productionSceneCreateRequestSchema = z.strictObject({
  expectedRevision: nonNegativeInteger,
  sceneId: nonEmptyText(160),
  title: nonEmptyText(240),
  sourceSceneId: z.string().optional(),
  project: directorProjectSchema.optional(),
  activate: z.boolean().optional(),
  actor: z.string().trim().min(1).max(160).optional(),
  idempotencyKey: nonEmptyText(160).optional(),
});

/** Request to update the full project document of an existing scene. */
export const productionSceneProjectUpdateRequestSchema = z.strictObject({
  expectedRevision: nonNegativeInteger,
  project: directorProjectSchema,
  actor: z.string().trim().min(1).max(160).optional(),
});

/** The persisted project record for a single scene, with revision and actor metadata. */
export const productionSceneProjectRecordSchema = z.strictObject({
  sceneId: nonEmptyText(240),
  revision: nonNegativeInteger,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  project: directorProjectSchema,
});

/** A lightweight reference to a scene within a production. */
export type ProductionSceneReference = z.infer<typeof productionSceneReferenceSchema>;
/** A shot in the editorial timeline. */
export type EditorialShot = z.infer<typeof editorialShotSchema>;
/** The persisted production record. */
export type ProductionRecord = z.infer<typeof productionRecordSchema>;
/** The production record as returned by the API, with optional mutation metadata. */
export type DirectorProductionRecord = z.infer<typeof productionRecordResponseSchema>;
/** A single mutation operation on a production. */
export type ProductionOperation = z.infer<typeof productionOperationSchema>;
/** A scene seed: the scene id paired with the full DirectorProject document. */
export type DirectorProductionSceneSeed = { sceneId: string; project: DirectorProject };
/** The persisted project record for a scene, with the full DirectorProject document. */
export type DirectorProductionSceneProjectRecord = Omit<
  z.infer<typeof productionSceneProjectRecordSchema>,
  "project"
> & { project: DirectorProject };