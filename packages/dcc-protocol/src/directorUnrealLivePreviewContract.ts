import { z } from "zod";
import { directorEngineSessionCommandResultSchema } from "./directorEngineSessionContract";
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
export const DIRECTOR_UNREAL_LIVE_PREVIEW_DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1_000;

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

/** Opt-in commands carried by the already-open Unreal editor connection. */
export const directorUnrealLivePreviewEditorCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({
    type: z.literal("editor_command"),
    commandId: z.string().uuid(),
    command: z.literal("execute_code"),
    language: z.literal("python"),
    code: z.string().min(1).max(100_000),
  }),
  z.strictObject({
    type: z.literal("editor_command"),
    commandId: z.string().uuid(),
    command: z.literal("sync_scene"),
  }),
]);

/** A validated Unreal editor command. */
export type DirectorUnrealLivePreviewEditorCommand = z.infer<typeof directorUnrealLivePreviewEditorCommandSchema>;

/** Validated connector receipt for one Unreal editor command. */
export const directorUnrealLivePreviewCommandResultMessageSchema = z.strictObject({
  type: z.literal("command_result"),
  result: directorEngineSessionCommandResultSchema,
});

/** A validated Unreal connector command-result message. */
export type DirectorUnrealLivePreviewCommandResultMessage = z.infer<
  typeof directorUnrealLivePreviewCommandResultMessageSchema
>;

/** Every message the Gateway may write onto the preview socket. */
export const directorUnrealLivePreviewClientMessageSchema = z.union([
  directorUnrealLivePreviewHelloSchema,
  directorUnrealLivePreviewFrameSchema,
  directorUnrealLivePreviewEditorCommandSchema,
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
  /** Inbound bytes observed; only matching command receipts are parsed. */
  ignoredInboundByteCount: z.number().int().nonnegative(),
  closed: z.boolean(),
  disconnectReason: directorUnrealLivePreviewDisconnectReasonSchema.nullable(),
  /** Optional human-readable detail for socket errors. */
  disconnectDetail: z.string().max(2_000).nullable(),
});

/** A validated Gateway live preview session summary. */
export type DirectorUnrealLivePreviewSessionSummary = z.infer<typeof directorUnrealLivePreviewSessionSummarySchema>;

/** Contract identifier for one Gateway-held live preview session record. */
export const DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT = "director-unreal-live-preview-status-v1" as const;

/**
 * Caller request to open one Gateway → connector preview session. The
 * loopback port is the one `director_headless.py --mode live-preview` printed
 * on start; the shared token is never part of the request — the gateway reads
 * DIRECTOR_UNREAL_PREVIEW_TOKEN from its own environment.
 */
export const directorUnrealLivePreviewOpenRequestSchema = z.strictObject({
  port: z.number().int().min(1).max(65_535),
  staleTimeoutMs: z.number().int().min(100).max(300_000).optional(),
  allowCode: z.boolean().optional().default(false),
  authority: z.enum(["director", "engine"]).optional().default("director"),
});

/** A validated live preview session open request. */
export type DirectorUnrealLivePreviewOpenRequest = z.infer<typeof directorUnrealLivePreviewOpenRequestSchema>;

/**
 * One Gateway-held preview session record: the loopback port it targets and
 * the preview-only counters. Like the summary itself, this record carries no
 * scene data and never the shared token.
 */
export const directorUnrealLivePreviewSessionStatusSchema = z.strictObject({
  contract: z.literal(DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT),
  sessionId: nonEmpty.max(120),
  port: z.number().int().min(1).max(65_535),
  allowCode: z.boolean(),
  authority: z.enum(["director", "engine"]),
  openedAtMs: z.number().int().nonnegative(),
  summary: directorUnrealLivePreviewSessionSummarySchema,
});

/** A validated Gateway-held live preview session record. */
export type DirectorUnrealLivePreviewSessionStatus = z.infer<typeof directorUnrealLivePreviewSessionStatusSchema>;

/** Machine-readable error codes for the Gateway live preview HTTP surface. */
export const directorUnrealLivePreviewErrorCodeSchema = z.enum([
  "live_preview_unavailable",
  "live_preview_token_missing",
  "live_preview_invalid",
  "live_preview_session_limit",
  "live_preview_session_unknown",
  "live_preview_connect_failed",
  "engine_session_code_disabled",
  "engine_session_authority_required",
  "engine_session_command_unknown",
  "engine_session_command_unsupported",
]);

/** A validated live preview error code. */
export type DirectorUnrealLivePreviewErrorCode = z.infer<typeof directorUnrealLivePreviewErrorCodeSchema>;
