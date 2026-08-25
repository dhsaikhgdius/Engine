import { randomUUID } from "node:crypto";
import {
  DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
  DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
  directorGodotLiveLinkByeResultSchema,
  directorGodotLiveLinkByeSchema,
  directorGodotLiveLinkFrameAckSchema,
  directorGodotLiveLinkFrameSchema,
  directorGodotLiveLinkHelloSchema,
  directorGodotLiveLinkPreviewSchema,
  directorGodotLiveLinkSessionSchema,
  type DirectorGodotLiveLinkByeResult,
  type DirectorGodotLiveLinkEntity,
  type DirectorGodotLiveLinkErrorCode,
  type DirectorGodotLiveLinkFrameAck,
  type DirectorGodotLiveLinkPreview,
  type DirectorGodotLiveLinkSession,
} from "@director/dcc-protocol";

/** Idle milliseconds after which a session counts as disconnected. */
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

/** Concurrent live-link sessions the hub accepts. */
const DEFAULT_MAX_SESSIONS = 4;

/** Entities one preview frame may carry (mirrors the wire contract cap). */
const MAX_ENTITIES_PER_FRAME = 512;

/** Distinct entities one session may accumulate across frames. */
const MAX_ENTITIES_PER_SESSION = 2_048;

/**
 * An error thrown by the live-link hub, carrying an HTTP status and a
 * machine-readable code so routes can answer with structured diagnostics.
 */
export class DirectorGodotLiveLinkError extends Error {
  constructor(
    readonly code: DirectorGodotLiveLinkErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DirectorGodotLiveLinkError";
  }
}

interface LiveLinkSessionState {
  sessionId: string;
  connectorVersion: string;
  hostVersion: string;
  scenePath: string | null;
  startedAtMs: number;
  lastSeenAtMs: number;
  lastSequence: number;
  frameCount: number;
  entities: Map<string, DirectorGodotLiveLinkEntity & { atSequence: number }>;
}

/**
 * The Gateway's inbound end of the Godot live-link preview transport.
 *
 * The hub is preview-only by construction: it holds ephemeral frames in
 * memory, has no reference to the Director project or any authoring path,
 * and drops all state for a session on `bye` or after the idle timeout, so a
 * disconnect always leaves the last committed Director revision intact.
 */
export interface GodotLiveLinkHub {
  /** Negotiate a new preview session (`hello`). */
  hello(input: unknown): DirectorGodotLiveLinkSession;
  /** Accept one ordered preview frame; stale or replayed sequences are rejected. */
  frame(input: unknown): DirectorGodotLiveLinkFrameAck;
  /** Explicitly end a session; ending an unknown/expired session reports `ended: false`. */
  bye(input: unknown): DirectorGodotLiveLinkByeResult;
  /** Current in-memory preview snapshot; sweeps idle sessions first. */
  preview(): DirectorGodotLiveLinkPreview;
}

/** Options for creating the live-link hub. */
export interface CreateGodotLiveLinkHubOptions {
  /** Idle milliseconds before a silent session is swept (default 10 000). */
  idleTimeoutMs?: number;
  /** Maximum concurrent sessions (default 4). */
  maxSessions?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Creates the in-memory Godot live-link hub.
 *
 * @param options - Idle timeout, session cap, and clock overrides.
 * @returns The hub used by the token-guarded live-link HTTP routes.
 */
export function createGodotLiveLinkHub(options: CreateGodotLiveLinkHubOptions = {}): GodotLiveLinkHub {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, LiveLinkSessionState>();

  function sweepIdleSessions() {
    const cutoff = now() - idleTimeoutMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAtMs < cutoff) sessions.delete(sessionId);
    }
  }

  function invalid(scope: string, issue: string): DirectorGodotLiveLinkError {
    return new DirectorGodotLiveLinkError("live_link_invalid", `Invalid live-link ${scope}: ${issue}`, 400);
  }

  function hello(input: unknown): DirectorGodotLiveLinkSession {
    const parsed = directorGodotLiveLinkHelloSchema.safeParse(input);
    if (!parsed.success) throw invalid("hello", parsed.error.issues[0]?.message ?? "malformed message");
    sweepIdleSessions();
    if (sessions.size >= maxSessions) {
      throw new DirectorGodotLiveLinkError(
        "live_link_session_limit",
        `The live-link hub already holds ${sessions.size} active sessions; end one with bye or wait for the ${idleTimeoutMs} ms idle timeout.`,
        429,
      );
    }
    const startedAtMs = now();
    const session: LiveLinkSessionState = {
      sessionId: randomUUID(),
      connectorVersion: parsed.data.connectorVersion,
      hostVersion: parsed.data.hostVersion,
      scenePath: parsed.data.scenePath ?? null,
      startedAtMs,
      lastSeenAtMs: startedAtMs,
      lastSequence: 0,
      frameCount: 0,
      entities: new Map(),
    };
    sessions.set(session.sessionId, session);
    return directorGodotLiveLinkSessionSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      provider: "godot",
      sessionId: session.sessionId,
      idleTimeoutMs,
      maxEntitiesPerFrame: MAX_ENTITIES_PER_FRAME,
    });
  }

  function frame(input: unknown): DirectorGodotLiveLinkFrameAck {
    const parsed = directorGodotLiveLinkFrameSchema.safeParse(input);
    if (!parsed.success) throw invalid("frame", parsed.error.issues[0]?.message ?? "malformed message");
    const message = parsed.data;
    const session = sessions.get(message.sessionId);
    if (!session) {
      throw new DirectorGodotLiveLinkError(
        "live_link_session_unknown",
        `Live-link session ${message.sessionId} is unknown; send hello first.`,
        404,
      );
    }
    const atMs = now();
    if (atMs - session.lastSeenAtMs > idleTimeoutMs) {
      sessions.delete(session.sessionId);
      throw new DirectorGodotLiveLinkError(
        "live_link_session_expired",
        `Live-link session ${message.sessionId} expired after ${idleTimeoutMs} ms of silence; its preview state was discarded. Send hello to start a new session.`,
        410,
      );
    }
    if (message.sequence <= session.lastSequence) {
      throw new DirectorGodotLiveLinkError(
        "live_link_sequence_stale",
        `Frame sequence ${message.sequence} is not after the last accepted sequence ${session.lastSequence}; stale or replayed frames never overwrite newer preview state.`,
        409,
      );
    }
    if (session.entities.size + message.entities.length > MAX_ENTITIES_PER_SESSION) {
      // Bound memory without failing the stream: unseen entities beyond the
      // cap are dropped, previously seen ones keep updating.
      for (const entity of message.entities) {
        if (session.entities.has(entity.directorId)) {
          session.entities.set(entity.directorId, { ...entity, atSequence: message.sequence });
        }
      }
    } else {
      for (const entity of message.entities) {
        session.entities.set(entity.directorId, { ...entity, atSequence: message.sequence });
      }
    }
    session.lastSequence = message.sequence;
    session.lastSeenAtMs = atMs;
    session.frameCount += 1;
    return directorGodotLiveLinkFrameAckSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: session.sessionId,
      sequence: message.sequence,
      accepted: true,
    });
  }

  function bye(input: unknown): DirectorGodotLiveLinkByeResult {
    const parsed = directorGodotLiveLinkByeSchema.safeParse(input);
    if (!parsed.success) throw invalid("bye", parsed.error.issues[0]?.message ?? "malformed message");
    sweepIdleSessions();
    const ended = sessions.delete(parsed.data.sessionId);
    return directorGodotLiveLinkByeResultSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: parsed.data.sessionId,
      ended,
    });
  }

  function preview(): DirectorGodotLiveLinkPreview {
    sweepIdleSessions();
    return directorGodotLiveLinkPreviewSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
      provider: "godot",
      authoritative: false,
      sessions: [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        connectorVersion: session.connectorVersion,
        hostVersion: session.hostVersion,
        scenePath: session.scenePath,
        startedAtMs: session.startedAtMs,
        lastSeenAtMs: session.lastSeenAtMs,
        lastSequence: session.lastSequence,
        frameCount: session.frameCount,
        entities: [...session.entities.values()],
      })),
    });
  }

  return { hello, frame, bye, preview };
}
