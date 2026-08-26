import { Socket, connect } from "node:net";
import {
  DIRECTOR_UNREAL_LIVE_PREVIEW_DEFAULT_STALE_TIMEOUT_MS,
  DIRECTOR_UNREAL_LIVE_PREVIEW_MAX_LINE_BYTES,
  DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL,
  DIRECTOR_UNREAL_LIVE_PREVIEW_SESSION_CONTRACT,
  DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT,
  directorUnrealLivePreviewFrameInputSchema,
  directorUnrealLivePreviewSessionSummarySchema,
  directorUnrealLivePreviewStatusSchema,
  type DirectorUnrealLivePreviewClientMessage,
  type DirectorUnrealLivePreviewDisconnectReason,
  type DirectorUnrealLivePreviewSessionState,
  type DirectorUnrealLivePreviewSessionStatus,
  type DirectorUnrealLivePreviewSessionSummary,
  type DirectorUnrealLivePreviewStatus,
} from "@director/dcc-protocol";

/**
 * Gateway side of the `director-unreal-live-preview-v1` loopback protocol.
 *
 * This transport is strictly non-authoritative and one-way:
 *
 * - The session only *sends* preview camera frames to the Unreal connector's
 *   loopback listener (`director_headless.py --mode live-preview`); the
 *   connector applies them to the editor viewport and never to scene assets.
 * - Inbound socket bytes are counted and discarded, never parsed, so nothing
 *   received on this channel can reach the Director project or the authoring
 *   dispatch path. This module must never import project mutators, the
 *   authoring transport, or the return importers; a source-level test
 *   (`unrealLivePreview.test.ts`) enforces that invariant.
 * - Duplicate or reordered caller frames are dropped before the socket, and a
 *   silent session is reported stale, mirroring the connector-side session
 *   semantics tested in `unrealConnectorModules.test.ts`.
 *
 * The durable scene channel remains the hash-verified exchange/return package.
 */

/** Options for opening one Gateway preview session. */
export interface DirectorUnrealLivePreviewOptions {
  /** Loopback port the connector's live-preview mode is listening on. */
  port: number;
  /** Shared token (the connector reads DIRECTOR_UNREAL_PREVIEW_TOKEN). */
  token: string;
  /** Silence window after which the session is considered disconnected. */
  staleTimeoutMs?: number;
  /** Connect timeout in milliseconds. */
  connectTimeoutMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Result of submitting one preview frame to the session. */
export type DirectorUnrealLivePreviewSendResult = { sent: true; seq: number } | { sent: false; reason: string };

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

/**
 * One Gateway-side preview session: loopback-only socket, hello-first
 * handshake, monotonically increasing sequence numbers, and preview-only
 * (never authoritative) semantics.
 */
export class DirectorUnrealLivePreviewSession {
  private readonly socket: Socket;
  private readonly staleTimeoutMs: number;
  private readonly now: () => number;
  /** Loopback port of the connector listener this session dialled. */
  readonly port: number;
  /** Wall-clock time the session connected and sent its hello. */
  readonly openedAtMs: number;
  private lastSequence: number | null = null;
  private lastActivityMs: number;
  private lastFrameAtMs: number | null = null;
  private forwardedFrameCount = 0;
  private droppedFrameCount = 0;
  private ignoredInboundByteCount = 0;
  private closedByClient = false;
  private disconnect: { reason: DirectorUnrealLivePreviewDisconnectReason; detail: string | null } | null = null;

  private constructor(socket: Socket, options: DirectorUnrealLivePreviewOptions) {
    this.socket = socket;
    this.staleTimeoutMs = Math.max(
      100,
      options.staleTimeoutMs ?? DIRECTOR_UNREAL_LIVE_PREVIEW_DEFAULT_STALE_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.port = options.port;
    this.openedAtMs = this.now();
    this.lastActivityMs = this.openedAtMs;
    // The preview channel is one-way: inbound bytes are counted and dropped,
    // never parsed, so they can never become project mutations.
    socket.on("data", (chunk: Buffer) => {
      this.ignoredInboundByteCount += chunk.length;
    });
    socket.on("error", (error: Error) => {
      this.disconnect ??= { reason: "socket_error", detail: error.message };
    });
    socket.on("close", () => {
      this.disconnect ??= { reason: this.closedByClient ? "client_close" : "peer_close", detail: null };
    });
  }

  /**
   * Connect to the connector's loopback listener and send the hello line.
   *
   * @param options - Port, shared token, and timeout overrides.
   * @returns A connected session ready to forward preview frames.
   * @throws If the token is empty or the loopback connection fails.
   */
  static connect(options: DirectorUnrealLivePreviewOptions): Promise<DirectorUnrealLivePreviewSession> {
    const token = options.token.trim();
    if (!token) return Promise.reject(new Error("A non-empty preview token is required."));
    return new Promise((resolvePromise, rejectPromise) => {
      // Loopback only, by construction: the host is never configurable.
      const socket = connect({ host: "127.0.0.1", port: options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new Error(`Preview connect to 127.0.0.1:${options.port} timed out.`));
      }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        const session = new DirectorUnrealLivePreviewSession(socket, { ...options, token });
        session.writeMessage({ type: "hello", protocol: DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL, token });
        resolvePromise(session);
      });
    });
  }

  /** Whether the socket is still open. */
  get connected(): boolean {
    return this.disconnect === null && !this.socket.destroyed;
  }

  /** True when the session has been silent past the disconnect timeout. */
  isStale(nowMs = this.now()): boolean {
    return nowMs - this.lastActivityMs > this.staleTimeoutMs;
  }

  /**
   * Validate and forward one preview camera frame.
   *
   * Malformed frames, duplicate sequence numbers, and reordered sequence
   * numbers are dropped locally and never reach the socket. Frames are
   * preview-only data: this method has no path into the Director project.
   *
   * @param input - Caller frame `{ seq, transform, focalLengthMm? }`.
   * @returns Whether the frame was written, with a drop reason otherwise.
   */
  sendFrame(input: unknown): DirectorUnrealLivePreviewSendResult {
    if (this.disconnect) {
      return { sent: false, reason: `session is ${this.disconnect.reason.replaceAll("_", " ")}` };
    }
    if (this.isStale()) {
      this.disconnect = { reason: "stale_timeout", detail: null };
      this.socket.destroy();
      return { sent: false, reason: "session went stale before the frame" };
    }
    const parsed = directorUnrealLivePreviewFrameInputSchema.safeParse(input);
    if (!parsed.success) {
      this.droppedFrameCount += 1;
      return { sent: false, reason: `malformed preview frame: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    }
    const frame = parsed.data;
    if (this.lastSequence !== null && frame.seq <= this.lastSequence) {
      this.droppedFrameCount += 1;
      return { sent: false, reason: `stale sequence ${frame.seq} (last forwarded ${this.lastSequence})` };
    }
    const written = this.writeMessage({ type: "camera_frame", ...frame });
    if (!written.sent) {
      this.droppedFrameCount += 1;
      return written;
    }
    this.lastSequence = frame.seq;
    this.forwardedFrameCount += 1;
    this.lastActivityMs = this.now();
    this.lastFrameAtMs = this.lastActivityMs;
    return { sent: true, seq: frame.seq };
  }

  /** Send the orderly `bye` and close the socket. */
  async close(): Promise<void> {
    if (this.disconnect) return;
    this.closedByClient = true;
    this.writeMessage({ type: "bye" });
    this.disconnect = { reason: "client_close", detail: null };
    await new Promise<void>((resolvePromise) => {
      this.socket.end(() => resolvePromise());
    });
  }

  /** The validated preview-only session summary (counters, never scene data). */
  summary(): DirectorUnrealLivePreviewSessionSummary {
    return directorUnrealLivePreviewSessionSummarySchema.parse({
      contract: DIRECTOR_UNREAL_LIVE_PREVIEW_SESSION_CONTRACT,
      provider: "unreal",
      protocol: DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL,
      forwardedFrameCount: this.forwardedFrameCount,
      droppedFrameCount: this.droppedFrameCount,
      ignoredInboundByteCount: this.ignoredInboundByteCount,
      closed: this.disconnect !== null,
      disconnectReason: this.disconnect?.reason ?? null,
      disconnectDetail: this.disconnect?.detail ?? null,
    });
  }

  /**
   * A read-only status entry for this session. Reading it never mutates
   * preview state: a silent session is *reported* stale here without being
   * torn down (teardown still happens on the next frame attempt).
   *
   * @param sessionId - The hub-assigned identifier for this session.
   * @returns Lifecycle state plus the preview-only counters.
   */
  statusEntry(sessionId: string): DirectorUnrealLivePreviewSessionStatus {
    const state: DirectorUnrealLivePreviewSessionState = this.disconnect
      ? "closed"
      : this.isStale()
        ? "stale"
        : this.forwardedFrameCount === 0
          ? "idle"
          : "connected";
    return {
      sessionId,
      port: this.port,
      state,
      openedAtMs: this.openedAtMs,
      lastFrameAtMs: this.lastFrameAtMs,
      lastForwardedSeq: this.lastSequence,
      summary: this.summary(),
    };
  }

  private writeMessage(message: DirectorUnrealLivePreviewClientMessage): DirectorUnrealLivePreviewSendResult {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > DIRECTOR_UNREAL_LIVE_PREVIEW_MAX_LINE_BYTES) {
      return { sent: false, reason: "message exceeds the line budget" };
    }
    if (!this.socket.writable) {
      return { sent: false, reason: "socket is not writable" };
    }
    this.socket.write(line);
    return { sent: true, seq: message.type === "camera_frame" ? message.seq : -1 };
  }
}

/** How many closed sessions the hub retains so disconnect reasons stay visible. */
const DEFAULT_CLOSED_SESSION_RETENTION = 8;

/** Hard cap on concurrently open preview sessions (the status schema caps at 64 entries). */
const MAX_OPEN_PREVIEW_SESSIONS = 16;

/** Options for creating the Gateway live preview hub. */
export interface CreateDirectorUnrealLivePreviewHubOptions {
  /** Closed sessions kept in the status snapshot (oldest evicted first). */
  closedSessionRetention?: number;
}

/**
 * The Gateway-side registry of preview sessions behind the read-only
 * `GET /api/dcc/unreal/live-preview/status` route. Like the sessions it
 * tracks, the hub is preview-only: `status()` returns lifecycle states and
 * counters, never scene data, and reading it never mutates a session. It has
 * no path into the Director project or the authoring transport.
 */
export interface DirectorUnrealLivePreviewHub {
  /** Open a session against the connector's loopback listener and register it. */
  open(
    options: DirectorUnrealLivePreviewOptions,
  ): Promise<{ sessionId: string; session: DirectorUnrealLivePreviewSession }>;
  /** Look up one registered session. */
  get(sessionId: string): DirectorUnrealLivePreviewSession | null;
  /** Send the orderly bye on one session; returns false for unknown ids. */
  close(sessionId: string): Promise<boolean>;
  /** The validated read-only status snapshot the UI polls. */
  status(): DirectorUnrealLivePreviewStatus;
}

/**
 * Creates the in-memory Unreal live preview hub.
 *
 * @param options - Retention overrides.
 * @returns The hub.
 */
export function createDirectorUnrealLivePreviewHub(
  options: CreateDirectorUnrealLivePreviewHubOptions = {},
): DirectorUnrealLivePreviewHub {
  const closedSessionRetention = Math.max(0, options.closedSessionRetention ?? DEFAULT_CLOSED_SESSION_RETENTION);
  const sessions = new Map<string, DirectorUnrealLivePreviewSession>();
  let nextSessionNumber = 1;

  function evictClosedBeyondRetention() {
    const closedIds = [...sessions.entries()]
      .filter(([, session]) => !session.connected)
      .map(([sessionId]) => sessionId);
    // Map iteration order is insertion order, so the oldest closed go first.
    for (const sessionId of closedIds.slice(0, Math.max(0, closedIds.length - closedSessionRetention))) {
      sessions.delete(sessionId);
    }
  }

  return {
    async open(sessionOptions) {
      const openCount = [...sessions.values()].filter((session) => session.connected).length;
      if (openCount >= MAX_OPEN_PREVIEW_SESSIONS) {
        throw new Error(`The preview hub already tracks ${openCount} open sessions.`);
      }
      const session = await DirectorUnrealLivePreviewSession.connect(sessionOptions);
      const sessionId = `unreal-preview-${nextSessionNumber}`;
      nextSessionNumber += 1;
      sessions.set(sessionId, session);
      evictClosedBeyondRetention();
      return { sessionId, session };
    },
    get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async close(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      await session.close();
      evictClosedBeyondRetention();
      return true;
    },
    status() {
      return directorUnrealLivePreviewStatusSchema.parse({
        contract: DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT,
        provider: "unreal",
        protocol: DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL,
        sessions: [...sessions.entries()].map(([sessionId, session]) => session.statusEntry(sessionId)),
      });
    },
  };
}
