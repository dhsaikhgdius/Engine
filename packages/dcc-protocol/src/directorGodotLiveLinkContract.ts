import { z } from "zod";
import { directorDccTransformSchema } from "./directorDccSharedContract";

/**
 * Contract identifier for the Godot live-link preview transport.
 *
 * The transport is strictly outbound from the Godot editor to the Director
 * Gateway: the connector opens authenticated HTTP requests against the
 * Gateway's token-guarded live-link routes and Godot never listens on a port.
 * Preview frames are ephemeral, ordered by per-session sequence numbers, and
 * never authoritative — the Gateway keeps them in memory only and a dropped
 * connection (missed `bye`, idle timeout) always leaves the last committed
 * Director revision intact. Durable changes still travel exclusively through
 * the reviewed `director-dcc-return-v1` package path.
 */
export const DIRECTOR_GODOT_LIVE_LINK_CONTRACT = "director-godot-live-link-v1" as const;

/** Contract identifier for the Gateway's in-memory live-link preview snapshot. */
export const DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT = "director-godot-live-link-preview-v1" as const;

const nonEmpty = z.string().trim().min(1);

/**
 * Session negotiation sent by the connector before any preview frame. The
 * Gateway answers with the session id plus its ordering/idle limits so the
 * connector never has to guess transport parameters.
 */
export const directorGodotLiveLinkHelloSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_CONTRACT),
  provider: z.literal("godot"),
  connectorVersion: nonEmpty.max(60),
  hostVersion: nonEmpty.max(200),
  /** `res://` path of the scene being previewed, when known. */
  scenePath: z.string().trim().min(1).max(1_024).optional(),
});

/** A validated live-link hello message. */
export type DirectorGodotLiveLinkHello = z.infer<typeof directorGodotLiveLinkHelloSchema>;

/** The Gateway's answer to a live-link hello. */
export const directorGodotLiveLinkSessionSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_CONTRACT),
  provider: z.literal("godot"),
  sessionId: z.string().uuid(),
  /** Milliseconds of silence after which the Gateway treats the session as disconnected. */
  idleTimeoutMs: z.number().int().positive().max(3_600_000),
  /** Maximum entities the Gateway accepts in one preview frame. */
  maxEntitiesPerFrame: z.number().int().positive().max(2_048),
});

/** A validated live-link session grant. */
export type DirectorGodotLiveLinkSession = z.infer<typeof directorGodotLiveLinkSessionSchema>;

const liveLinkEntityShape = {
  directorId: nonEmpty.max(200),
  entityType: z.enum(["object", "camera"]),
  /** Canonical Director-space world transform (Godot's basis is the identity map). */
  transform: directorDccTransformSchema,
  /** Camera-only: vertical field of view in degrees. */
  fovDeg: z.number().finite().gt(0).lt(180).optional(),
} as const;

function cameraOnlyFov(entity: { entityType: "object" | "camera"; fovDeg?: number }, context: z.RefinementCtx) {
  if (entity.entityType !== "camera" && entity.fovDeg !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["fovDeg"],
      message: "fovDeg is a camera-only channel",
    });
  }
}

/** One previewed entity: a canonical-space world transform plus camera fov. */
export const directorGodotLiveLinkEntitySchema = z.strictObject(liveLinkEntityShape).superRefine(cameraOnlyFov);

/** A validated live-link preview entity. */
export type DirectorGodotLiveLinkEntity = z.infer<typeof directorGodotLiveLinkEntitySchema>;

/**
 * One ephemeral preview frame. `sequence` must be strictly greater than the
 * last accepted sequence of the session; stale or replayed frames are
 * rejected with a structured error and never overwrite newer preview state.
 */
export const directorGodotLiveLinkFrameSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_CONTRACT),
  sessionId: z.string().uuid(),
  /** Strictly increasing per-session sequence number (gaps are allowed, replays are not). */
  sequence: z.number().int().positive().max(1_000_000_000_000),
  /** Connector-side monotonic timestamp in milliseconds; informational only. */
  atMs: z.number().int().nonnegative().max(100_000_000_000_000).optional(),
  entities: z.array(directorGodotLiveLinkEntitySchema).min(1).max(512),
});

/** A validated live-link preview frame. */
export type DirectorGodotLiveLinkFrame = z.infer<typeof directorGodotLiveLinkFrameSchema>;

/** The Gateway's acknowledgement of an accepted preview frame. */
export const directorGodotLiveLinkFrameAckSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_CONTRACT),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive().max(1_000_000_000_000),
  accepted: z.literal(true),
});

/** A validated frame acknowledgement. */
export type DirectorGodotLiveLinkFrameAck = z.infer<typeof directorGodotLiveLinkFrameAckSchema>;

/** Explicit end-of-session message; a missed bye is equivalent via the idle timeout. */
export const directorGodotLiveLinkByeSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_CONTRACT),
  sessionId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

/** A validated live-link bye message. */
export type DirectorGodotLiveLinkBye = z.infer<typeof directorGodotLiveLinkByeSchema>;

/** The Gateway's answer to a bye; `ended: false` means the session had already expired. */
export const directorGodotLiveLinkByeResultSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_CONTRACT),
  sessionId: z.string().uuid(),
  ended: z.boolean(),
});

/** A validated bye result. */
export type DirectorGodotLiveLinkByeResult = z.infer<typeof directorGodotLiveLinkByeResultSchema>;

/**
 * The in-memory preview snapshot the Gateway serves to observers (UI, agents).
 * `authoritative` is pinned to `false` on the wire: preview state is never a
 * scene mutation and vanishes with its session.
 */
export const directorGodotLiveLinkPreviewSchema = z.strictObject({
  contract: z.literal(DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT),
  provider: z.literal("godot"),
  authoritative: z.literal(false),
  sessions: z
    .array(
      z.strictObject({
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
        entities: z
          .array(
            z
              .strictObject({
                ...liveLinkEntityShape,
                /** Sequence number of the frame that last updated this entity. */
                atSequence: z.number().int().positive().max(1_000_000_000_000),
              })
              .superRefine(cameraOnlyFov),
          )
          .max(2_048),
      }),
    )
    .max(8),
});

/** A validated live-link preview snapshot. */
export type DirectorGodotLiveLinkPreview = z.infer<typeof directorGodotLiveLinkPreviewSchema>;

/** Machine-readable live-link error codes surfaced by the Gateway routes. */
export const directorGodotLiveLinkErrorCodeSchema = z.enum([
  "live_link_invalid",
  "live_link_session_unknown",
  "live_link_session_expired",
  "live_link_sequence_stale",
  "live_link_session_limit",
]);

/** A machine-readable live-link error code. */
export type DirectorGodotLiveLinkErrorCode = z.infer<typeof directorGodotLiveLinkErrorCodeSchema>;
