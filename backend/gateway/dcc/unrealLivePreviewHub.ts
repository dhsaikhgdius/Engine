import { randomUUID } from "node:crypto";
import {
  DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT,
  directorUnrealLivePreviewOpenRequestSchema,
  directorUnrealLivePreviewSessionStatusSchema,
  type DirectorEngineSessionAuthority,
  type DirectorEngineSessionCommandName,
  type DirectorEngineSessionSceneSnapshot,
  type DirectorUnrealLivePreviewErrorCode,
  type DirectorUnrealLivePreviewSessionStatus,
} from "@director/dcc-protocol";
import {
  DirectorUnrealLivePreviewSession,
  type DirectorUnrealLivePreviewOptions,
  type DirectorUnrealLivePreviewSendResult,
} from "./unrealLivePreview";

/** Environment variable holding the shared loopback preview token. */
export const DIRECTOR_UNREAL_PREVIEW_TOKEN_ENV = "DIRECTOR_UNREAL_PREVIEW_TOKEN";

/** Concurrent Gateway → connector preview sessions the hub accepts. */
const DEFAULT_MAX_SESSIONS = 2;

/**
 * An error thrown by the live preview hub, carrying an HTTP status and a
 * machine-readable code so routes can answer with structured diagnostics.
 */
export class DirectorUnrealLivePreviewHubError extends Error {
  constructor(
    readonly code: DirectorUnrealLivePreviewErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DirectorUnrealLivePreviewHubError";
  }
}

interface HubSessionState {
  sessionId: string;
  port: number;
  openedAtMs: number;
  allowCode: boolean;
  authority: DirectorEngineSessionAuthority;
  commands: Map<
    string,
    { command: "execute_code" | "sync_scene"; requestedAtMs: number; completedAtMs: number | null }
  >;
  session: DirectorUnrealLivePreviewSession;
}

/** Director-side state for one Unreal hot-editor command. */
export interface UnrealEngineSessionCommandStatus {
  provider: "unreal";
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
 * The Gateway's outbound end of the `director-unreal-live-preview-v1`
 * loopback transport, held as addressable sessions for the HTTP routes.
 *
 * Camera frames are preview-only. Opt-in workshop commands return validated
 * receipts, but this hub still has no reference to the Director project or
 * any authoring path. The shared token
 * comes exclusively from the gateway's own environment
 * (DIRECTOR_UNREAL_PREVIEW_TOKEN) and is never accepted from, or echoed to,
 * a caller.
 */
export interface UnrealLivePreviewHub {
  /** Connect to the connector's loopback listener and register the session. */
  open(input: unknown): Promise<DirectorUnrealLivePreviewSessionStatus>;
  /** Forward one preview camera frame through an open session. */
  frame(
    sessionId: string,
    input: unknown,
  ): { send: DirectorUnrealLivePreviewSendResult; session: DirectorUnrealLivePreviewSessionStatus };
  /** Queue Editor Python or an engine-owned scene snapshot. */
  requestCommand(
    sessionId: string,
    command:
      | { command: "capture_frame"; camera?: string; width?: number; height?: number }
      | { command: "execute_code"; code: string }
      | { command: "sync_scene" },
  ): UnrealEngineSessionCommandStatus;
  /** Read one hot-editor command result. */
  commandStatus(sessionId: string, commandId: string): UnrealEngineSessionCommandStatus;
  /** Current session records (never the token, never scene data). */
  status(): DirectorUnrealLivePreviewSessionStatus[];
  /** Read one session record. */
  read(sessionId: string): DirectorUnrealLivePreviewSessionStatus;
  /** Send the orderly bye, close the socket, and drop the session. */
  close(sessionId: string): Promise<DirectorUnrealLivePreviewSessionStatus>;
}

/** Options for creating the live preview hub. */
export interface CreateUnrealLivePreviewHubOptions {
  /** Environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Maximum concurrent sessions (default 2). */
  maxSessions?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Session connector override for tests. */
  connect?: (options: DirectorUnrealLivePreviewOptions) => Promise<DirectorUnrealLivePreviewSession>;
}

/**
 * Creates the in-memory Unreal live preview hub used by the
 * `/api/dcc/unreal/live-preview` routes.
 *
 * @param options - Environment, session cap, clock, and connector overrides.
 * @returns The hub with open, frame, status, read, and close methods.
 */
export function createUnrealLivePreviewHub(options: CreateUnrealLivePreviewHubOptions = {}): UnrealLivePreviewHub {
  const environment = options.environment ?? process.env;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const now = options.now ?? Date.now;
  const connect = options.connect ?? ((sessionOptions) => DirectorUnrealLivePreviewSession.connect(sessionOptions));
  const sessions = new Map<string, HubSessionState>();

  function sweepClosedSessions() {
    for (const [sessionId, state] of sessions) {
      if (state.session.summary().closed) sessions.delete(sessionId);
    }
  }

  function statusOf(state: HubSessionState): DirectorUnrealLivePreviewSessionStatus {
    return directorUnrealLivePreviewSessionStatusSchema.parse({
      contract: DIRECTOR_UNREAL_LIVE_PREVIEW_STATUS_CONTRACT,
      sessionId: state.sessionId,
      port: state.port,
      allowCode: state.allowCode,
      authority: state.authority,
      openedAtMs: state.openedAtMs,
      summary: state.session.summary(),
    });
  }

  function requireSession(sessionId: string): HubSessionState {
    const state = sessions.get(sessionId);
    if (!state) {
      throw new DirectorUnrealLivePreviewHubError(
        "live_preview_session_unknown",
        `Live preview session ${sessionId} is unknown; open a session first.`,
        404,
      );
    }
    return state;
  }

  async function open(input: unknown): Promise<DirectorUnrealLivePreviewSessionStatus> {
    const parsed = directorUnrealLivePreviewOpenRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DirectorUnrealLivePreviewHubError(
        "live_preview_invalid",
        `Invalid live preview open request: ${parsed.error.issues[0]?.message ?? "malformed body"}`,
        400,
      );
    }
    const token = environment[DIRECTOR_UNREAL_PREVIEW_TOKEN_ENV]?.trim() ?? "";
    if (!token) {
      throw new DirectorUnrealLivePreviewHubError(
        "live_preview_token_missing",
        `Set ${DIRECTOR_UNREAL_PREVIEW_TOKEN_ENV} on the gateway (the same value the Unreal connector reads), then start director_headless.py --mode live-preview and retry.`,
        503,
      );
    }
    sweepClosedSessions();
    if (sessions.size >= maxSessions) {
      throw new DirectorUnrealLivePreviewHubError(
        "live_preview_session_limit",
        `The live preview hub already holds ${sessions.size} active sessions; close one first.`,
        429,
      );
    }
    let session: DirectorUnrealLivePreviewSession;
    try {
      session = await connect({
        port: parsed.data.port,
        token,
        allowCode: parsed.data.allowCode,
        authority: parsed.data.authority,
        ...(parsed.data.staleTimeoutMs !== undefined ? { staleTimeoutMs: parsed.data.staleTimeoutMs } : {}),
      });
    } catch (error) {
      throw new DirectorUnrealLivePreviewHubError(
        "live_preview_connect_failed",
        `Connecting to the Unreal live preview listener on 127.0.0.1:${parsed.data.port} failed: ${
          error instanceof Error ? error.message : String(error)
        }. Start director_headless.py --mode live-preview and use the port it printed.`,
        502,
      );
    }
    const state: HubSessionState = {
      sessionId: randomUUID(),
      port: parsed.data.port,
      openedAtMs: now(),
      allowCode: parsed.data.allowCode,
      authority: parsed.data.authority,
      commands: new Map(),
      session,
    };
    sessions.set(state.sessionId, state);
    return statusOf(state);
  }

  function frame(sessionId: string, input: unknown) {
    const state = requireSession(sessionId);
    const send = state.session.sendFrame(input);
    const session = statusOf(state);
    if (session.summary.closed) sessions.delete(sessionId);
    return { send, session };
  }

  function status(): DirectorUnrealLivePreviewSessionStatus[] {
    sweepClosedSessions();
    return [...sessions.values()].map(statusOf);
  }

  function commandStatus(sessionId: string, commandId: string): UnrealEngineSessionCommandStatus {
    const state = requireSession(sessionId);
    const command = state.commands.get(commandId);
    if (!command) {
      throw new DirectorUnrealLivePreviewHubError(
        "engine_session_command_unknown",
        `Unknown Unreal engine session command: ${commandId}.`,
        404,
      );
    }
    const result = state.session.commandResult(commandId);
    if (result && command.completedAtMs === null) command.completedAtMs = now();
    return {
      provider: "unreal",
      sessionId,
      commandId,
      command: command.command,
      status: result?.status ?? "pending",
      requestedAt: new Date(command.requestedAtMs).toISOString(),
      completedAt: command.completedAtMs === null ? null : new Date(command.completedAtMs).toISOString(),
      ...(result?.command === "execute_code" && result.status === "completed" ? { output: result.output } : {}),
      ...(result?.command === "sync_scene" && result.status === "completed" ? { snapshot: result.snapshot } : {}),
      ...(result?.status === "failed" ? { error: result.error } : {}),
    };
  }

  function requestCommand(
    sessionId: string,
    command:
      | { command: "capture_frame"; camera?: string; width?: number; height?: number }
      | { command: "execute_code"; code: string }
      | { command: "sync_scene" },
  ): UnrealEngineSessionCommandStatus {
    const state = requireSession(sessionId);
    if (command.command === "capture_frame") {
      throw new DirectorUnrealLivePreviewHubError(
        "engine_session_command_unsupported",
        "Unreal hot sessions use render_engine_frame for clean captures.",
        400,
      );
    }
    if (command.command === "execute_code" && !state.allowCode) {
      throw new DirectorUnrealLivePreviewHubError(
        "engine_session_code_disabled",
        "Editor Python is disabled. Start the Unreal session with allow_code: true and the listener with --preview-allow-code.",
        403,
      );
    }
    if (command.command === "sync_scene" && state.authority !== "engine") {
      throw new DirectorUnrealLivePreviewHubError(
        "engine_session_authority_required",
        "Scene sync requires an Unreal session started with authority: engine.",
        409,
      );
    }
    const commandId = randomUUID();
    const payload =
      command.command === "execute_code"
        ? ({
            type: "editor_command",
            commandId,
            command: "execute_code",
            language: "python",
            code: command.code,
          } as const)
        : ({ type: "editor_command", commandId, command: "sync_scene" } as const);
    const sent = state.session.sendCommand(payload);
    if (!sent.sent) {
      throw new DirectorUnrealLivePreviewHubError(
        "engine_session_command_unsupported",
        `Unreal editor command was not sent: ${sent.reason}.`,
        409,
      );
    }
    state.commands.set(commandId, { command: command.command, requestedAtMs: now(), completedAtMs: null });
    return commandStatus(sessionId, commandId);
  }

  function read(sessionId: string): DirectorUnrealLivePreviewSessionStatus {
    return statusOf(requireSession(sessionId));
  }

  async function close(sessionId: string): Promise<DirectorUnrealLivePreviewSessionStatus> {
    const state = requireSession(sessionId);
    await state.session.close();
    const finalStatus = statusOf(state);
    sessions.delete(sessionId);
    return finalStatus;
  }

  return { open, frame, requestCommand, commandStatus, status, read, close };
}
