import { Socket, connect } from "node:net";
import {
  DIRECTOR_UNREAL_LIVE_PREVIEW_DEFAULT_STALE_TIMEOUT_MS,
  DIRECTOR_UNREAL_LIVE_PREVIEW_MAX_LINE_BYTES,
  DIRECTOR_UNREAL_LIVE_PREVIEW_PROTOCOL,
  DIRECTOR_UNREAL_LIVE_PREVIEW_SESSION_CONTRACT,
  directorUnrealLivePreviewCommandResultMessageSchema,
  directorUnrealLivePreviewEditorCommandSchema,
  directorUnrealLivePreviewFrameInputSchema,
  directorUnrealLivePreviewSessionSummarySchema,
  type DirectorEngineSessionAuthority,
  type DirectorEngineSessionCommandResult,
  type DirectorUnrealLivePreviewClientMessage,
  type DirectorUnrealLivePreviewDisconnectReason,
  type DirectorUnrealLivePreviewEditorCommand,
  type DirectorUnrealLivePreviewSessionSummary,
} from "@director/dcc-protocol";

/**
 * Gateway side of the `director-unreal-live-preview-v1` loopback protocol.
 *
 * Camera frames remain preview-only. An explicitly opted-in workshop session
 * may also carry Editor Python or an engine-owned review snapshot:
 *
 * - The session only *sends* preview camera frames to the Unreal connector's
 *   loopback listener (`director_headless.py --mode live-preview`); the
 *   connector applies them to the editor viewport and never to scene assets.
 * - Inbound bytes are ignored unless they validate as a result for a command
 *   this session actually sent. This transport still has no project mutator;
 *   applying a review snapshot is a separate revision-guarded route.
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
  /** Explicit local grant for Editor Python commands. */
  allowCode?: boolean;
  /** Engine authority enables scene snapshots for Director's review view. */
  authority?: DirectorEngineSessionAuthority;
  /** Silence window after which the session is considered disconnected. */
  staleTimeoutMs?: number;
  /** Connect timeout in milliseconds. */
  connectTimeoutMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Result of submitting one preview frame to the session. */
export type DirectorUnrealLivePreviewSendResult = { sent: true; seq: number } | { sent: false; reason: string };

/** Result of submitting one workshop command to Unreal. */
export type DirectorUnrealLivePreviewCommandSendResult =
  { sent: true; commandId: string } | { sent: false; reason: string };

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
  private readonly allowCode: boolean;
  private readonly authority: DirectorEngineSessionAuthority;
  private lastSequence: number | null = null;
  private lastActivityMs: number;
  private forwardedFrameCount = 0;
  private droppedFrameCount = 0;
  private ignoredInboundByteCount = 0;
  private inboundBuffer = "";
  private readonly commandResults = new Map<
    string,
    { command: "execute_code" | "sync_scene"; result: DirectorEngineSessionCommandResult | null }
  >();
  private closedByClient = false;
  private disconnect: { reason: DirectorUnrealLivePreviewDisconnectReason; detail: string | null } | null = null;

  private constructor(socket: Socket, options: DirectorUnrealLivePreviewOptions) {
    this.socket = socket;
    this.staleTimeoutMs = Math.max(
      100,
      options.staleTimeoutMs ?? DIRECTOR_UNREAL_LIVE_PREVIEW_DEFAULT_STALE_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.allowCode = options.allowCode ?? false;
    this.authority = options.authority ?? "director";
    this.lastActivityMs = this.now();
    socket.on("data", (chunk: Buffer) => {
      this.ignoredInboundByteCount += chunk.length;
      this.inboundBuffer += chunk.toString("utf8");
      let newlineIndex = this.inboundBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.inboundBuffer.slice(0, newlineIndex);
        this.inboundBuffer = this.inboundBuffer.slice(newlineIndex + 1);
        newlineIndex = this.inboundBuffer.indexOf("\n");
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = directorUnrealLivePreviewCommandResultMessageSchema.safeParse(message);
        if (!parsed.success) continue;
        const pending = this.commandResults.get(parsed.data.result.commandId);
        if (!pending || pending.command !== parsed.data.result.command) continue;
        pending.result = parsed.data.result;
        this.lastActivityMs = this.now();
      }
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
    return { sent: true, seq: frame.seq };
  }

  /** Send one opt-in Unreal workshop command over the existing hot editor connection. */
  sendCommand(input: unknown): DirectorUnrealLivePreviewCommandSendResult {
    if (this.disconnect) {
      return { sent: false, reason: `session is ${this.disconnect.reason.replaceAll("_", " ")}` };
    }
    const parsed = directorUnrealLivePreviewEditorCommandSchema.safeParse(input);
    if (!parsed.success) {
      return { sent: false, reason: `malformed editor command: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    }
    if (parsed.data.command === "execute_code" && !this.allowCode) {
      return { sent: false, reason: "Editor Python is disabled for this session" };
    }
    if (parsed.data.command === "sync_scene" && this.authority !== "engine") {
      return { sent: false, reason: "engine authority is required for scene sync" };
    }
    const written = this.writeMessage(parsed.data);
    if (!written.sent) return written;
    this.commandResults.set(parsed.data.commandId, { command: parsed.data.command, result: null });
    this.lastActivityMs = this.now();
    return { sent: true, commandId: parsed.data.commandId };
  }

  /** Read a validated result for a command this session sent. */
  commandResult(commandId: string): DirectorEngineSessionCommandResult | null | undefined {
    return this.commandResults.get(commandId)?.result;
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

  private writeMessage(
    message: DirectorUnrealLivePreviewClientMessage,
  ): { sent: true } | { sent: false; reason: string } {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > DIRECTOR_UNREAL_LIVE_PREVIEW_MAX_LINE_BYTES) {
      return { sent: false, reason: "message exceeds the line budget" };
    }
    if (!this.socket.writable) {
      return { sent: false, reason: "socket is not writable" };
    }
    this.socket.write(line);
    return { sent: true };
  }
}
