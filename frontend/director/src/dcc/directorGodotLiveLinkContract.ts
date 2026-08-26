import { z } from "zod";
import { directorDccTransformSchema } from "./directorDccSharedContract";

/**
 * Editor-side copy of the Godot live-link preview observation vocabulary.
 * The full transport contract (hello/frame/bye) lives in
 * `packages/dcc-protocol/src/directorGodotLiveLinkContract.ts`; the editor only
 * ever reads the Gateway's in-memory preview snapshot
 * (`GET /api/dcc/live-link/godot/preview`).
 *
 * The transport is strictly outbound from the Godot editor to the Gateway:
 * Godot never listens on a port, frames are ephemeral, and `authoritative` is
 * pinned to `false` on the wire — a disconnect always leaves the last
 * committed Director revision intact.
 */
export const DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT = "director-godot-live-link-preview-v1" as const;

const nonEmpty = z.string().trim().min(1);

/** One previewed entity: a canonical-space world transform plus camera fov. */
export const directorGodotLiveLinkPreviewEntitySchema = z
  .strictObject({
    directorId: nonEmpty.max(200),
    entityType: z.enum(["object", "camera"]),
    /** Canonical Director-space world transform (Godot's basis is the identity map). */
    transform: directorDccTransformSchema,
    /** Camera-only: vertical field of view in degrees. */
    fovDeg: z.number().finite().gt(0).lt(180).optional(),
    /** Sequence number of the frame that last updated this entity. */
    atSequence: z.number().int().positive().max(1_000_000_000_000),
  })
  .superRefine((entity, context) => {
    if (entity.entityType !== "camera" && entity.fovDeg !== undefined) {
      context.addIssue({ code: "custom", path: ["fovDeg"], message: "fovDeg is a camera-only channel" });
    }
  });

/** A validated previewed live-link entity. */
export type DirectorGodotLiveLinkPreviewEntity = z.infer<typeof directorGodotLiveLinkPreviewEntitySchema>;

/** One in-memory preview session as observed by the editor. */
export const directorGodotLiveLinkPreviewSessionSchema = z.strictObject({
  sessionId: z.string().uuid(),
  connectorVersion: nonEmpty.max(60),
  hostVersion: nonEmpty.max(200),
  scenePath: z.string().max(1_024).nullable(),
  startedAtMs: z.number().int().nonnegative(),
  lastSeenAtMs: z.number().int().nonnegative(),
  /** Last accepted sequence number; 0 before the first frame. */
  lastSequence: z.number().int().nonnegative().max(1_000_000_000_000),
  /** Accepted preview frames since hello. */
  frameCount: z.number().int().nonnegative(),
  entities: z.array(directorGodotLiveLinkPreviewEntitySchema).max(2_048),
});

/** A validated live-link preview session summary. */
export type DirectorGodotLiveLinkPreviewSession = z.infer<typeof directorGodotLiveLinkPreviewSessionSchema>;

/**
 * The in-memory preview snapshot the Gateway serves to observers (UI, agents).
 * `authoritative` is pinned to `false` on the wire: preview state is never a
 * scene mutation and vanishes with its session.
 */
export const directorGodotLiveLinkPreviewSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT),
  provider: z.literal("godot"),
  authoritative: z.literal(false),
  sessions: z.array(directorGodotLiveLinkPreviewSessionSchema).max(8),
});

/** A validated live-link preview snapshot. */
export type DirectorGodotLiveLinkPreview = z.infer<typeof directorGodotLiveLinkPreviewSchema>;
