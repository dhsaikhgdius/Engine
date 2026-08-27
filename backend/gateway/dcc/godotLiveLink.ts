/**
 * In-memory hub for the Godot live-link preview transport. Godot never opens
 * a listening port: the connector calls Director's token-guarded HTTP routes
 * outbound (hello → frame* → bye), and Director piggybacks pending workshop
 * commands onto frame acknowledgements — the frame stream doubles as the
 * command delivery channel.
 *
 * Invariants:
 * - Preview-only by construction: the hub holds ephemeral frames in memory,
 *   has no reference to the Director project or any authoring path, and
 *   drops all session state on `bye` or idle timeout.
 * - Frames are strictly ordered per session; a stale or replayed sequence
 *   number can never overwrite newer preview state.
 * - Workshop commands (capture_frame, execute_code, sync_scene) are opt-in
 *   per session: execute_code requires allow_code, and sync_scene requires
 *   engine authority. sync_scene is answered locally from accumulated frames
 *   rather than round-tripping to the editor.
 */
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
  directorEngineSessionCommandPayloadSchema,
  directorEngineSessionCommandResultSchema,
  type DirectorEngineSessionAuthority,
  type DirectorEngineSessionCommandName,
  type DirectorEngineSessionCommandPayload,
  type DirectorEngineSessionCommandResult,
  type DirectorEngineSessionSceneSnapshot,
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

/** All in-memory state of one connector session; discarded on bye/expiry. */
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
  workshop: {
    label: string | null;
    authority: DirectorEngineSessionAuthority;
    allowCode: boolean;
  } | null;
  commands: Map<string, GodotCommandRecord>;
}

/** One queued workshop command: delivered via a frame ack, completed by the connector. */
interface GodotCommandRecord {
  commandId: string;
  command: DirectorEngineSessionCommandName;
  requestedAtMs: number;
  completedAtMs: number | null;
  delivered: boolean;
  payload: DirectorEngineSessionCommandPayload | null;
  result: DirectorEngineSessionCommandResult | null;
}

/** Director-side status for a persistent Godot editor command. */
export interface GodotEngineSessionCommandStatus {
  provider: "godot";
  sessionId: string;
  commandId: string;
  command: DirectorEngineSessionCommandName;
  status: "pending" | "completed" | "failed";
  requestedAt: string;
  completedAt: string | null;
  capture?: { mimeType: "image/png"; dataBase64: string; width: number; height: number };
  output?: string;
  snapshot?: DirectorEngineSessionSceneSnapshot;
  error?: string;
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
  /** Adopts the most recently active editor preview as an opt-in workshop session. */
  startEngineSession(options?: { label?: string; allowCode?: boolean; authority?: DirectorEngineSessionAuthority }): {
    provider: "godot";
    sessionId: string;
    authority: DirectorEngineSessionAuthority;
    allowCode: boolean;
    scenePath: string | null;
  };
  /** Stops workshop commands while leaving the human's preview toggle alone. */
  stopEngineSession(sessionId: string): boolean;
  /** Queues a hot editor command, or snapshots the current engine-owned preview. */
  requestCommand(
    sessionId: string,
    command:
      | { command: "capture_frame"; camera?: string; width?: number; height?: number }
      | { command: "execute_code"; code: string }
      | { command: "sync_scene" },
  ): GodotEngineSessionCommandStatus;
  /** Accepts one connector command result through the authenticated outbound route. */
  completeCommand(sessionId: string, input: unknown): GodotEngineSessionCommandStatus;
  /** Reads a command status for Director and agents. */
  commandStatus(sessionId: string, commandId: string): GodotEngineSessionCommandStatus;
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
      workshop: null,
      commands: new Map(),
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
    // Deliver at most one pending command per frame ack; the connector
    // executes it and posts the result through the command-result route.
    const commands = [...session.commands.values()]
      .filter((command) => command.result === null && !command.delivered && command.payload)
      .slice(0, 1);
    commands.forEach((command) => {
      command.delivered = true;
    });
    return directorGodotLiveLinkFrameAckSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: session.sessionId,
      sequence: message.sequence,
      accepted: true,
      ...(commands.length ? { commands: commands.map((command) => command.payload) } : {}),
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

  /** Resolves a session that has workshop mode enabled, else a typed 404. */
  function requireWorkshop(sessionId: string): LiveLinkSessionState {
    sweepIdleSessions();
    const session = sessions.get(sessionId);
    if (!session || !session.workshop) {
      throw new DirectorGodotLiveLinkError(
        "engine_session_unavailable",
        `Godot engine session ${sessionId} is not active; enable Director live preview and start_engine_session again.`,
        404,
      );
    }
    return session;
  }

  /** Projects a command record into the public status shape, per result kind. */
  function readCommandStatus(session: LiveLinkSessionState, commandId: string): GodotEngineSessionCommandStatus {
    const command = session.commands.get(commandId);
    if (!command) {
      throw new DirectorGodotLiveLinkError(
        "engine_session_command_unknown",
        `Unknown Godot engine session command: ${commandId}.`,
        404,
      );
    }
    const result = command.result;
    return {
      provider: "godot",
      sessionId: session.sessionId,
      commandId: command.commandId,
      command: command.command,
      status: result?.status ?? "pending",
      requestedAt: new Date(command.requestedAtMs).toISOString(),
      completedAt: command.completedAtMs === null ? null : new Date(command.completedAtMs).toISOString(),
      ...(result?.status === "completed" && result.command === "capture_frame"
        ? {
            capture: {
              mimeType: result.mimeType,
              dataBase64: result.imageBase64,
              width: result.width,
              height: result.height,
            },
          }
        : {}),
      ...(result?.status === "completed" && result.command === "execute_code" ? { output: result.output } : {}),
      ...(result?.status === "completed" && result.command === "sync_scene" ? { snapshot: result.snapshot } : {}),
      ...(result?.status === "failed" ? { error: result.error } : {}),
    };
  }

  // Adopts the most recently active preview session as the workshop session;
  // there is no way to start one without a human-enabled preview stream.
  function startEngineSession(
    options: { label?: string; allowCode?: boolean; authority?: DirectorEngineSessionAuthority } = {},
  ) {
    sweepIdleSessions();
    const session = [...sessions.values()].sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)[0];
    if (!session) {
      throw new DirectorGodotLiveLinkError(
        "engine_session_unavailable",
        "No Godot editor is streaming Director live preview. Enable the Director Bridge live preview toggle first.",
        409,
      );
    }
    session.workshop = {
      label: options.label?.trim() || null,
      authority: options.authority ?? "director",
      allowCode: options.allowCode ?? false,
    };
    return {
      provider: "godot" as const,
      sessionId: session.sessionId,
      authority: session.workshop.authority,
      allowCode: session.workshop.allowCode,
      scenePath: session.scenePath,
    };
  }

  function stopEngineSession(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session?.workshop) return false;
    session.workshop = null;
    session.commands.clear();
    return true;
  }

  function requestCommand(
    sessionId: string,
    commandInput:
      | { command: "capture_frame"; camera?: string; width?: number; height?: number }
      | { command: "execute_code"; code: string }
      | { command: "sync_scene" },
  ): GodotEngineSessionCommandStatus {
    const session = requireWorkshop(sessionId);
    const commandId = randomUUID();
    const requestedAtMs = now();
    let payload: DirectorEngineSessionCommandPayload | null = null;
    let result: DirectorEngineSessionCommandResult | null = null;
    if (commandInput.command === "capture_frame") {
      payload = directorEngineSessionCommandPayloadSchema.parse({
        kind: "editor_command",
        commandId,
        command: "capture_frame",
        ...(commandInput.camera ? { camera: commandInput.camera } : {}),
        width: commandInput.width ?? 960,
        height: commandInput.height ?? 540,
      });
    } else if (commandInput.command === "execute_code") {
      if (!session.workshop?.allowCode) {
        throw new DirectorGodotLiveLinkError(
          "engine_session_code_not_allowed",
          "This Godot session was not started with allow_code: true.",
          403,
        );
      }
      payload = directorEngineSessionCommandPayloadSchema.parse({
        kind: "editor_command",
        commandId,
        command: "execute_code",
        language: "gdscript",
        code: commandInput.code,
      });
    } else {
      if (session.workshop?.authority !== "engine") {
        throw new DirectorGodotLiveLinkError(
          "engine_session_not_authoritative",
          "sync_scene requires a session started with authority: engine.",
          409,
        );
      }
      result = directorEngineSessionCommandResultSchema.parse({
        commandId,
        command: "sync_scene",
        status: "completed",
        snapshot: {
          provider: "godot",
          scenePath: session.scenePath,
          capturedAt: new Date(requestedAtMs).toISOString(),
          entities: [...session.entities.values()].map((entity) => ({
            directorId: entity.directorId,
            name: entity.directorId,
            entityType: entity.entityType,
            transform: entity.transform,
            ...(entity.fovDeg !== undefined ? { fovDegrees: entity.fovDeg } : {}),
          })),
        },
      });
    }
    session.commands.set(commandId, {
      commandId,
      command: commandInput.command,
      requestedAtMs,
      completedAtMs: result ? requestedAtMs : null,
      delivered: false,
      payload,
      result,
    });
    return readCommandStatus(session, commandId);
  }

  function completeCommand(sessionId: string, input: unknown): GodotEngineSessionCommandStatus {
    const session = requireWorkshop(sessionId);
    const result = directorEngineSessionCommandResultSchema.parse(input);
    const command = session.commands.get(result.commandId);
    if (!command) {
      throw new DirectorGodotLiveLinkError(
        "engine_session_command_unknown",
        `Unknown Godot engine session command: ${result.commandId}.`,
        404,
      );
    }
    if (command.command !== result.command) {
      throw new DirectorGodotLiveLinkError(
        "engine_session_command_mismatch",
        `Godot command ${result.commandId} expected ${command.command}, not ${result.command}.`,
        409,
      );
    }
    // First result wins; a duplicate submission replays the recorded status.
    if (!command.result) {
      command.result = result;
      command.completedAtMs = now();
    }
    return readCommandStatus(session, command.commandId);
  }

  function commandStatus(sessionId: string, commandId: string): GodotEngineSessionCommandStatus {
    return readCommandStatus(requireWorkshop(sessionId), commandId);
  }

  return {
    hello,
    frame,
    bye,
    preview,
    startEngineSession,
    stopEngineSession,
    requestCommand,
    completeCommand,
    commandStatus,
  };
}
