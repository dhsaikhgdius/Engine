import { z } from "zod";
import { directorDccTransformSchema } from "./directorDccSharedContract";

/**
 * Wire protocol identifier for the Unreal preview-only loopback camera feed.
 * Newline-delimited JSON over 127.0.0.1 with a shared token and monotonically
 * increasing sequence numbers. This channel is never authoritative: the
 * durable scene channel remains the hash-verified exchange/return package,
 * and neither peer may turn a live frame into a project mutation.
 */
export const DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL = "director-unreal-live-preview-v1" as const;

/** Contract identifier for the Gateway-side live preview session summary. */
export const DIRECTOR_UNREAL_LIVE_PREVIEW_SESSION_CONTRACT = "director-unreal-live-preview-session-v1" as const;

/** Byte budget for one newline-delimited protocol line (mirrors the connector). */
export const DIRECTOR_UNREAL_LIVE_PREVIEW_MAX_LINE_BYTES = 64 * 1024;

/** Default silent-peer disconnect timeout in milliseconds (mirrors the connector). */
export const DIRECTOR_UNREAL_LIVE_PREVIEW_DEFAULT_STALE_TIMEOUT_MS = 5_000;

const nonEmpty = z.string().trim().min(1);

/** The mandatory first message: protocol handshake with the shared loopback token. */
export const directorUnrealLivePreviewHelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocol: z.literal(DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL),
  token: nonEmpty.max(512),
});

/** A validated live preview hello message. */
export type DirectorUnrealLivePreviewHello = z.infer<typeof directorUnrealLivePreviewHelloSchema>;

/**
 * One preview camera frame. The transform is a canonical Director-space world
 * transform; the connector owns the Unreal basis change at apply time.
 */
export const directorUnrealLivePreviewFrameSchema = z.strictObject({
  type: z.literal("camera_frame"),
  /** Monotonically increasing per-session sequence number; stale values are dropped. */
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  transform: directorDccTransformSchema,
  /** Optional preview optics; must be a positive focal length in millimetres. */
  focalLengthMm: z.number().finite().positive().max(10_000).optional(),
});

/** A validated live preview camera frame message. */
export type DirectorUnrealLivePreviewFrame = z.infer<typeof directorUnrealLivePreviewFrameSchema>;

/** Orderly session close. */
export const directorUnrealLivePreviewByeSchema = z.strictObject({ type: z.literal("bye") });

/** A validated live preview bye message. */
export type DirectorUnrealLivePreviewBye = z.infer<typeof directorUnrealLivePreviewByeSchema>;

/** Every message the Gateway may write onto the preview socket. */
export const directorUnrealLivePreviewClientMessageSchema = z.discriminatedUnion("type", [
  directorUnrealLivePreviewHelloSchema,
  directorUnrealLivePreviewFrameSchema,
  directorUnrealLivePreviewByeSchema,
]);

/** A validated live preview client message. */
export type DirectorUnrealLivePreviewClientMessage = z.infer<typeof directorUnrealLivePreviewClientMessageSchema>;

/** Caller-facing frame input accepted by the Gateway session (seq + canonical transform). */
export const directorUnrealLivePreviewFrameInputSchema = directorUnrealLivePreviewFrameSchema.omit({ type: true });

/** A validated caller-facing preview frame input. */
export type DirectorUnrealLivePreviewFrameInput = z.infer<typeof directorUnrealLivePreviewFrameInputSchema>;

/** Why a Gateway preview session ended. */
export const directorUnrealLivePreviewDisconnectReasonSchema = z.enum([
  "client_close",
  "peer_close",
  "socket_error",
  "stale_timeout",
]);

/** A validated disconnect reason. */
export type DirectorUnrealLivePreviewDisconnectReason = z.infer<typeof directorUnrealLivePreviewDisconnectReasonSchema>;

/**
 * The Gateway-side session summary. Deliberately preview-shaped: it carries
 * counters and the disconnect reason, never scene data, so nothing in this
 * contract can be replayed into the authoring path.
 */
export const directorUnrealLivePreviewSessionSummarySchema = z.strictObject({
  contract: z.literal(DIRECTOR_UNREAL_LIVE_PREVIEW_SESSION_CONTRACT),
  provider: z.literal("unreal"),
  protocol: z.literal(DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL),
  /** Frames accepted and written to the loopback socket. */
  forwardedFrameCount: z.number().int().nonnegative(),
  /** Frames dropped before the socket (stale seq, duplicate seq, malformed body). */
  droppedFrameCount: z.number().int().nonnegative(),
  /** Inbound bytes ignored: the preview channel is strictly one-way. */
  ignoredInboundByteCount: z.number().int().nonnegative(),
  closed: z.boolean(),
  disconnectReason: directorUnrealLivePreviewDisconnectReasonSchema.nullable(),
  /** Optional human-readable detail for socket errors. */
  disconnectDetail: z.string().max(2_000).nullable(),
});

/** A validated Gateway live preview session summary. */
export type DirectorUnrealLivePreviewSessionSummary = z.infer<typeof directorUnrealLivePreviewSessionSummarySchema>;

/** Contract identifier for the read-only Gateway live preview status snapshot. */
export const DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT = "director-unreal-live-preview-status-v1" as const;

/**
 * Lifecycle state of one Gateway preview session:
 * - `idle` — connected, hello sent, no camera frame forwarded yet.
 * - `connected` — forwarding frames inside the staleness window.
 * - `stale` — silent past the disconnect timeout (treated as disconnected).
 * - `closed` — the socket is gone; `summary.disconnectReason` says why.
 */
export const directorUnrealLivePreviewSessionStateSchema = z.enum(["idle", "connected", "stale", "closed"]);

/** A validated live preview session state. */
export type DirectorUnrealLivePreviewSessionState = z.infer<typeof directorUnrealLivePreviewSessionStateSchema>;

/**
 * One session entry in the read-only status snapshot. Deliberately
 * preview-shaped like the summary: counters, sequence numbers, and lifecycle
 * only — never scene data — so nothing here can reach the authoring path.
 */
export const directorUnrealLivePreviewSessionStatusSchema = z.strictObject({
  sessionId: nonEmpty.max(64),
  /** Loopback port of the connector listener the session dialled. */
  port: z.number().int().min(1).max(65_535),
  state: directorUnrealLivePreviewSessionStateSchema,
  openedAtMs: z.number().int().nonnegative(),
  /** Wall-clock time of the last forwarded frame; null while idle. */
  lastFrameAtMs: z.number().int().nonnegative().nullable(),
  /** Sequence number of the last forwarded frame; null while idle. */
  lastForwardedSeq: z.number().int().nonnegative().nullable(),
  summary: directorUnrealLivePreviewSessionSummarySchema,
});

/** A validated per-session status entry. */
export type DirectorUnrealLivePreviewSessionStatus = z.infer<typeof directorUnrealLivePreviewSessionStatusSchema>;

/**
 * The read-only status snapshot the UI polls (`GET
 * /api/dcc/unreal/live-preview/status`). Reading it never mutates preview
 * state and it carries no scene data; the durable scene channel remains the
 * hash-verified exchange/return package.
 */
export const directorUnrealLivePreviewStatusSchema = z.strictObject({
  contract: z.literal(DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT),
  provider: z.literal("unreal"),
  protocol: z.literal(DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL),
  sessions: z.array(directorUnrealLivePreviewSessionStatusSchema).max(64),
});

/** A validated read-only live preview status snapshot. */
export type DirectorUnrealLivePreviewStatus = z.infer<typeof directorUnrealLivePreviewStatusSchema>;
