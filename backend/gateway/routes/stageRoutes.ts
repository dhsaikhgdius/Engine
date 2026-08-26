import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { executeStageTool } from "@director/agent-engine";
import {
  creativeWorkspaceAgentRequestSchema,
  describeCreativeWorkspaceTarget,
  type CreativeWorkspaceAgentRequest,
} from "../../../packages/protocol/src/creativeWorkspaceProtocol";
import { parseDirectorWorkbenchInput, type DirectorWorkbenchOperation } from "@director/agent-engine";
import { describeDirectorWorkbenchTarget } from "@director/agent-engine";
import {
  collectPossessedObjectIds,
  describeDirectorPossessionTargetAmbiguity,
  evaluateDirectorPossessionScope,
  fillDirectorAuthorCharacterTargets,
  findDirectorAuthorCharacterTargetGaps,
} from "@director/agent-engine";
import {
  createStageFeedback,
  type AgentBoundaryReceipt,
  type DirectorAgentTarget,
  type StageCapturePayload,
  type StageGatewayExecution,
} from "@director/agent-engine";
import { safeParseDirectorProject, type DirectorProject } from "@director/project-schema";
import { parseStageScene } from "@director/stage-protocol";
import type { StageScene, ToolExecution } from "@director/stage-protocol";
import { AGENT_TOOL_NAMES } from "../../../packages/protocol/src/agentTools";
import { parseCaptureDataUrl } from "../capturePayload";
import { isBrowserCommandTimeoutError } from "../browserCommandTimeout";
import { directorAgentToolExecutionMode } from "../agents/agentToolRegistry";
import {
  DIRECTOR_TARGET_QUEUE_WAIT_HEADER,
  DirectorAgentTargetScheduler,
  type DirectorAgentTargetLease,
} from "../agents/agentToolScheduler";
import {
  applyObservedAgentGuard,
  forgetAgentSessionTarget,
  isCreativeGuardedRead,
  isCreativeMutation,
  isWorkbenchDurableJobMutation,
  isWorkbenchMutation,
  isWorkbenchRevisionGuardedMutation,
  isWorkbenchSessionMutation,
  prepareAgentDurableJobMutation,
  prepareAgentMutation,
  recallAgentSessionTarget,
  rememberAgentSessionTarget,
} from "../agentNaiveBoundary";
import {
  executeDisconnectedWorkbenchRead,
  canServeDisconnectedWorkbenchRead,
  type DisconnectedWorkbenchSources,
} from "../workbenchDisconnectedReads";
import {
  evaluateHttpToolConfirmation,
  evaluateHttpToolGovernance,
  recordRejectedHttpToolCall,
  withHttpToolAudit,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";
import {
  AGENT_TRACE_SOURCE_HEADER,
  parseAgentTraceSource,
} from "../../../packages/protocol/src/agentObservabilityProtocol";
import { buildAgentToolTraceEvent, describeAgentToolOperation } from "../agents/agentToolTrace";
import type { AgentTraceEventInput } from "../agents/agentTraceStore";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const toolNameSchema = z.enum(AGENT_TOOL_NAMES.filter((name) => name !== "blender_native"));

const toolEnvelopeSchema = z.looseObject({
  session_id: z.string().trim().min(1).max(160).optional(),
  /** Agent profile id of the caller; matches character bindings that name only a profile_id. */
  profile_id: z.string().trim().min(1).max(160).optional(),
  target_token: z.string().trim().min(1).max(240).optional(),
  omit_scene: z.boolean().optional(),
  /** Single-use gateway-issued token confirming one destructive/publish operation. */
  confirm_token: z.string().trim().min(1).max(240).optional(),
  input: z.unknown().optional(),
});

// Untargeted HTTP/MCP queues on this scheduler, keyed separately from browser
// target tokens. Bound calls skip it and use the process-wide target scheduler.
let sessionScheduler = new DirectorAgentTargetScheduler();

function usesExactTargetLock(
  targetToken: string | undefined,
  scheduler: DirectorAgentTargetScheduler | undefined,
): boolean {
  return Boolean(targetToken && scheduler);
}

function sessionCallKey(tool: string, sessionId: string) {
  return `session:${tool}:${sessionId}`;
}

/** Clears all in-flight session locks. Only for use in test teardown. */
export function resetStageSessionLocksForTests() {
  sessionScheduler = new DirectorAgentTargetScheduler();
}

const WORKBENCH_UNAVAILABLE_ERROR =
  "No responsive Director workbench is connected. Keep one visible Stage tab open and retry, or use blender_native scene/inspect for the live Blender kernel.";

async function respondDisconnectedWorkbenchRead(input: {
  operation: DirectorWorkbenchOperation;
  scene: StageScene;
  respond: (response: ServerResponse, status: number, body: unknown) => void;
  response: ServerResponse;
  loadSources?: () => Promise<DisconnectedWorkbenchSources>;
}): Promise<boolean> {
  if (!canServeDisconnectedWorkbenchRead(input.operation)) return false;
  const sources = (await input.loadSources?.()) ?? { project: null, blenderScene: null };
  const disconnected = executeDisconnectedWorkbenchRead(input.operation, sources);
  if (!disconnected.handled) return false;
  const execution: StageGatewayExecution = {
    scene: input.scene,
    success: disconnected.success,
    ...(disconnected.success ? { result: disconnected.result } : { error: disconnected.error }),
  };
  execution.feedback = createStageFeedback({
    before: input.scene,
    execution,
    toolInput: input.operation,
    refs: new Map(),
    tool: "director_workbench",
  });
  input.respond(input.response, disconnected.success ? 200 : 400, execution);
  return true;
}

type WorkbenchResponse = {
  success: boolean;
  stageScene?: unknown;
  project?: unknown;
  result?: unknown;
  error?: string;
  captureDataUrl?: string;
};

type WorkbenchRemote = { client: unknown; response: WorkbenchResponse; target: DirectorAgentTarget };

type CreativeWorkspaceRemote = {
  client: unknown;
  target: DirectorAgentTarget;
  response: {
    success: boolean;
    result?: unknown;
    error?: string;
  };
};

function embeddedCreativePreviewDataUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (
    result.op !== "preview" ||
    !result.preview ||
    typeof result.preview !== "object" ||
    Array.isArray(result.preview)
  ) {
    return undefined;
  }
  const dataUrl = (result.preview as Record<string, unknown>).data_url;
  return typeof dataUrl === "string" ? dataUrl : undefined;
}

function withoutEmbeddedCreativePreviewDataUrl(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (
    result.op !== "preview" ||
    !result.preview ||
    typeof result.preview !== "object" ||
    Array.isArray(result.preview)
  ) {
    return value;
  }
  const preview = result.preview as Record<string, unknown>;
  if (typeof preview.data_url !== "string") return value;
  const { data_url: _dataUrl, ...durablePreview } = preview;
  return {
    ...result,
    preview: {
      ...durablePreview,
      image_attached: true,
    },
  };
}

function directResultCode(value: unknown) {
  const root = record(value);
  if (!root) return undefined;
  if (typeof root.code === "string") return root.code;
  for (const key of ["execution", "preview", "result"]) {
    const nested = record(root[key]);
    if (typeof nested?.code === "string") return nested.code;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function observedWorkbenchRevision(value: unknown) {
  const revision = record(value)?.project_revision;
  return typeof revision === "string" && revision.trim() ? revision : null;
}

function observedWorkbenchCharacters(value: unknown) {
  const characters = record(value)?.characters;
  return Array.isArray(characters) ? characters : undefined;
}

function observedLivePlayer(value: unknown): { playerMode: boolean; playerActorId: string | null } | null {
  const ui = record(record(value)?.ui) ?? record(value);
  if (!ui || !("player_mode" in ui || "player_actor_id" in ui)) return null;
  const actor = ui.player_actor_id;
  return {
    playerMode: ui.player_mode === true,
    playerActorId: typeof actor === "string" && actor.trim() ? actor : null,
  };
}

function observedProductionRevision(value: unknown) {
  const revision = record(value)?.production_revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? String(revision) : null;
}

function observedCreativeFingerprint(value: unknown) {
  const snapshot = record(record(value)?.snapshot);
  const fingerprint = snapshot?.snapshot_fingerprint;
  return typeof fingerprint === "string" && fingerprint.trim() ? fingerprint : null;
}

function observedCollaborationFingerprint(value: unknown) {
  const state = record(record(record(value)?.result)?.state);
  const fingerprint = state?.collaboration_fingerprint;
  return typeof fingerprint === "string" && fingerprint.trim() ? fingerprint : null;
}

function observedCreativeGuard(operation: CreativeWorkspaceAgentRequest, value: unknown) {
  return operation.op === "collaboration"
    ? observedCollaborationFingerprint(value)
    : observedCreativeFingerprint(value);
}

/** Dependencies injected into the Stage route handler. */
export type StageRouteDependencies = {
  /** Reads the JSON request body from the incoming HTTP message. */
  readBody: (request: IncomingMessage) => Promise<unknown>;
  /** Writes response headers. */
  headers: (response: ServerResponse, status?: number, contentType?: string) => void;
  /** Writes a JSON response with the given status code. */
  json: JsonWriter;
  /** Returns the current Stage scene. */
  getScene: () => StageScene;
  /** Replaces the current Stage scene in memory. */
  replaceScene: (scene: StageScene) => void;
  /** Persists the Stage scene to disk. */
  persistScene: () => Promise<void>;
  /** Broadcasts a message to all connected WebSocket clients. */
  broadcast: (message: unknown) => void;
  /** Broadcasts a message to all connected WebSocket clients except the given one. */
  broadcastExcept: (message: unknown, client: unknown) => void;
  /** Reads the latest preview buffer from disk, or null. */
  readPreview: () => Promise<Buffer | null>;
  /** Returns the MIME type of the latest preview. */
  previewMimeType: () => StageCapturePayload["mimeType"];
  /** Requests a browser-side capture from the given camera, returns a data URL or null. */
  requestCapture: (cameraId?: string) => Promise<string | null>;
  /** Whether at least one browser client is connected. */
  hasConnectedClient: () => boolean;
  /** Persists a capture payload to disk. */
  savePreview: (capture: StageCapturePayload) => Promise<void>;
  /** Returns the public URL of the latest preview. */
  previewUrl: () => string;
  /** Returns the session-scoped reference map. */
  refsForSession: (sessionId: string) => Map<string, string>;
  /** Sends a workbench command to a connected browser target. */
  requestWorkbenchCommand: (
    input: DirectorWorkbenchOperation,
    timeoutMs?: number,
    targetToken?: string,
  ) => Promise<WorkbenchRemote | null>;
  /** Sends a capture or shot_package command to a connected browser target. */
  requestWorkbenchCapture: (
    input: Extract<DirectorWorkbenchOperation, { op: "capture" | "shot_package" }>,
    timeoutMs?: number,
    targetToken?: string,
  ) => Promise<WorkbenchRemote | null>;
  /** True when the target tab's bundled contract mismatches this gateway. */
  isTargetContractStale?: (targetToken: string) => boolean;
  /** Sends a creative workspace command to a connected browser target. */
  requestCreativeWorkspaceCommand: (
    input: CreativeWorkspaceAgentRequest,
    timeoutMs?: number,
    targetToken?: string,
  ) => Promise<CreativeWorkspaceRemote | null>;
  /** Persists a workbench project to disk. */
  persistWorkbenchProject: (project: DirectorProject, client: unknown) => Promise<void>;
  /** Last persisted Director project and live Blender snapshot for disconnected reads. */
  loadDisconnectedWorkbenchSources?: () => Promise<DisconnectedWorkbenchSources>;
  /** Executes a video model tool against the current scene. */
  executeVideoModel: (scene: StageScene, input: unknown) => Promise<ToolExecution>;
  /** Coordinates calls that address the same exact Director browser target. */
  targetScheduler?: DirectorAgentTargetScheduler;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
  /** Records one trace event per completed tool call (fire-and-forget). */
  recordTrace?: (event: AgentTraceEventInput) => void;
};

const TOOL_ENVELOPE_KEYS = new Set(["session_id", "profile_id", "target_token", "omit_scene", "confirm_token"]);

function directToolInput(payload: z.infer<typeof toolEnvelopeSchema>) {
  if (Object.prototype.hasOwnProperty.call(payload, "input")) return payload.input ?? {};
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !TOOL_ENVELOPE_KEYS.has(key)));
}

async function acquireScheduledLease(
  request: IncomingMessage,
  response: ServerResponse,
  scheduler: DirectorAgentTargetScheduler | undefined,
  lockKey: string | undefined,
  tool: string,
  input: unknown,
): Promise<DirectorAgentTargetLease | null | undefined> {
  if (!scheduler || !lockKey) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Director tool request cancelled", "AbortError"));
  const canListen = typeof request.once === "function" && typeof response.once === "function";
  const close = () => {
    if (!response.writableEnded) abort();
  };
  if (canListen) {
    request.once("aborted", abort);
    response.once("close", close);
  }
  if (request.aborted) abort();
  try {
    const lease = await scheduler.acquire(lockKey, directorAgentToolExecutionMode(tool, input), controller.signal);
    if (!controller.signal.aborted) {
      response.setHeader?.(DIRECTOR_TARGET_QUEUE_WAIT_HEADER, String(lease.queueWaitMs));
      return lease;
    }
    lease.release();
    return null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    if (canListen) {
      request.off("aborted", abort);
      response.off("close", close);
    }
  }
}

function writeBrowserCommandTimeout(
  response: ServerResponse,
  json: JsonWriter,
  error: unknown,
  scene: StageScene,
  agentBoundary?: AgentBoundaryReceipt,
) {
  if (!isBrowserCommandTimeoutError(error)) return false;
  const outcomeUnknown = error.code === "outcome_unknown";
  json(response, outcomeUnknown ? 409 : 504, {
    scene,
    success: false,
    code: error.code,
    error: outcomeUnknown
      ? agentBoundary
        ? `${error.message} Reconnect the target and retry the same intent with request key ${agentBoundary.idempotency.key}.`
        : `${error.message} Reconnect the target and inspect the current scene before retrying missing work.`
      : error.message,
    result: {
      operation: error.operation,
      command_family: error.family,
      outcome: outcomeUnknown ? "unknown" : "cancelled",
      retry_requires_observe: outcomeUnknown ? !agentBoundary : true,
    },
    ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
  });
  return true;
}

/**
 * Routes Stage HTTP requests including the workbench, creative workspace,
 * stage tools, and video model endpoints.
 *
 * Owns Stage transport endpoints; tool semantics stay in the shared command
 * engine. Untargeted calls queue on a per-(tool, session) reader/writer
 * scheduler. Bound calls with a target token skip that queue and wait on the
 * exact-target scheduler instead.
 *
 * Mutation operations are wrapped with agent boundary guards: the gateway
 * observes the target before every mutation, stamps the observed revision
 * into the request, and rejects mutations when the target has changed.
 *
 * @param request - The incoming HTTP request.
 * @param response - The outgoing HTTP response.
 * @param url - The parsed request URL.
 * @param dependencies - The Stage subsystem dependencies.
 * @returns `true` when the request was handled, `false` otherwise.
 */
export async function handleStageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: StageRouteDependencies,
): Promise<boolean> {
  const {
    readBody,
    headers,
    getScene,
    replaceScene,
    persistScene,
    broadcast,
    readPreview,
    previewMimeType,
    requestCapture,
    hasConnectedClient,
    savePreview,
    previewUrl,
    refsForSession,
    requestWorkbenchCommand,
    requestWorkbenchCapture,
    requestCreativeWorkspaceCommand,
    isTargetContractStale,
    persistWorkbenchProject,
    loadDisconnectedWorkbenchSources,
    executeVideoModel,
    targetScheduler,
  } = dependencies;
  // Reassigned with an audit-recording wrapper once a governed tool call is admitted.
  let json = dependencies.json;

  if (request.method === "GET" && url.pathname === "/api/stage") {
    json(response, 200, getScene());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/preview") {
    const preview = await readPreview();
    if (!preview) {
      json(response, 404, { error: "No preview captured yet. Open the stage UI and run stage_read look_at_scene." });
    } else {
      headers(response, 200, previewMimeType());
      response.end(preview);
    }
    return true;
  }
  if (request.method === "PUT" && url.pathname === "/api/stage") {
    const parsed = parseStageScene(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: parsed.error });
    } else {
      replaceScene(parsed.scene);
      await persistScene();
      broadcast({ type: "state", scene: parsed.scene, source: "ui" });
      json(response, 200, { ok: true });
    }
    return true;
  }
  if (request.method !== "POST" || !url.pathname.startsWith("/api/tools/")) return false;

  const toolResult = toolNameSchema.safeParse(url.pathname.split("/").pop());
  if (!toolResult.success) {
    json(response, 404, { success: false, error: `Unknown tool ${url.pathname.split("/").pop() ?? ""}` });
    return true;
  }
  const tool = toolResult.data;
  const payloadResult = toolEnvelopeSchema.safeParse(await readBody(request));
  if (!payloadResult.success) {
    json(response, 400, { scene: getScene(), success: false, error: "Tool request body must be a JSON object." });
    return true;
  }
  const payload = payloadResult.data;
  const sessionId = payload.session_id ?? "http-default";
  const possessionIdentity = { sessionId, profileId: payload.profile_id ?? null };
  let targetToken = payload.target_token;
  const toolInput = directToolInput(payload);
  // Same film-role and plan-mode policy as MCP, applied to the effective tool
  // input before any lease or browser dispatch so denials stay cheap.
  const governance = evaluateHttpToolGovernance({
    request,
    tool,
    toolInput,
    sessionId: payload.session_id,
    dependencies: dependencies.governance,
  });
  const auditContext = {
    store: dependencies.governance?.auditStore,
    tool,
    toolInput,
    roleId: governance.roleId,
    source: governance.source,
    sessionId: payload.session_id,
  };
  if (!governance.allowed) {
    recordRejectedHttpToolCall(governance, auditContext);
    json(response, governance.status, governance.body);
    return true;
  }
  // Confirmation boundary after the role/plan policy: destructive/publish
  // operations execute only with the protocol confirm literal or a valid
  // single-use gateway-issued confirm_token.
  const confirmation = await evaluateHttpToolConfirmation({
    request,
    tool,
    toolInput,
    roleId: governance.roleId,
    source: governance.source,
    sessionId: payload.session_id,
    confirmToken: payload.confirm_token,
    dependencies: dependencies.governance,
  });
  if (confirmation) {
    recordRejectedHttpToolCall(confirmation, auditContext);
    json(response, confirmation.status, confirmation.body);
    return true;
  }
  json = withHttpToolAudit(json, auditContext);
  let scene = getScene();
  // Token-conscious direct HTTP callers can opt out of the embedded scene; the
  // MCP server never sends the flag because it requires scene in every response.
  const omitScene = payload.omit_scene === true && (tool === "director_workbench" || tool === "director_creative");
  const stripScene = (body: unknown) => {
    if (!omitScene || !record(body)) return body;
    const { scene: _scene, ...rest } = body as Record<string, unknown>;
    return rest;
  };
  // Every tool response funnels through one writer so exactly one trace event
  // is recorded per call, tagged with the caller's declared entry surface.
  const traceSource = parseAgentTraceSource(request.headers?.[AGENT_TRACE_SOURCE_HEADER]);
  const traceOperation = describeAgentToolOperation(toolInput);
  const traceStartedAtMs = Date.now();
  let traceRecorded = false;
  const traceJson: JsonWriter = (res, status, body) => {
    if (dependencies.recordTrace && !traceRecorded) {
      traceRecorded = true;
      try {
        dependencies.recordTrace(
          buildAgentToolTraceEvent({
            tool,
            sessionId,
            source: traceSource,
            operation: traceOperation,
            startedAtMs: traceStartedAtMs,
            status,
            body,
            captureRef: previewUrl(),
          }),
        );
      } catch (error) {
        console.warn("Director tool trace recording failed", error);
      }
    }
    json(res, status, body);
  };
  const respond: JsonWriter = (res, status, body) => traceJson(res, status, stripScene(body));

  if (tool === "director_creative") {
    const parsedInput = creativeWorkspaceAgentRequestSchema.safeParse(toolInput);
    if (!parsedInput.success) {
      respond(response, 400, {
        scene,
        success: false,
        error: `director_creative input is invalid: ${parsedInput.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
          .join("; ")}`,
      });
      return true;
    }
    if (parsedInput.data.op === "describe") {
      const described = describeCreativeWorkspaceTarget(parsedInput.data.target);
      if (described.success) respond(response, 200, { scene, success: true, result: described.result });
      else respond(response, 400, { scene, success: false, error: described.error });
      return true;
    }
    const sessionLocked = !usesExactTargetLock(targetToken, targetScheduler);
    let sessionLease: DirectorAgentTargetLease | undefined;
    if (sessionLocked) {
      const acquired = await acquireScheduledLease(
        request,
        response,
        sessionScheduler,
        sessionCallKey(tool, sessionId),
        tool,
        parsedInput.data,
      );
      if (acquired === null) return true;
      sessionLease = acquired;
    }
    let targetLease: DirectorAgentTargetLease | undefined;
    try {
      const targetRequired = parsedInput.data.op !== "capabilities" && parsedInput.data.op !== "observe";
      let discovery: CreativeWorkspaceRemote | null = null;
      if (targetRequired && !targetToken) {
        try {
          discovery = await requestCreativeWorkspaceCommand({ op: "observe" });
        } catch (error) {
          if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
          throw error;
        }
        if (!discovery) {
          respond(response, 503, {
            scene,
            success: false,
            error: "No responsive Canvas/Video workspace is connected. Keep one visible browser tab open and retry.",
            code: "creative_workspace_unavailable",
          });
          return true;
        }
        targetToken = discovery.target.token;
      }
      const scheduledLease = await acquireScheduledLease(
        request,
        response,
        targetScheduler,
        targetToken,
        tool,
        parsedInput.data,
      );
      if (scheduledLease === null) return true;
      targetLease = scheduledLease;
      let creativeOperation = parsedInput.data;
      let agentBoundary: AgentBoundaryReceipt | undefined;
      if (isCreativeMutation(creativeOperation)) {
        const prepared = prepareAgentMutation({ tool: "director_creative", operation: creativeOperation }, sessionId);
        let secured = prepared;
        if (prepared.needsObservation) {
          let observation: Awaited<ReturnType<typeof requestCreativeWorkspaceCommand>>;
          try {
            observation =
              creativeOperation.op === "collaboration"
                ? await requestCreativeWorkspaceCommand(
                    { op: "collaboration", request: { action: "observe" } },
                    undefined,
                    targetToken,
                  )
                : (discovery ?? (await requestCreativeWorkspaceCommand({ op: "observe" }, undefined, targetToken)));
          } catch (error) {
            if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
            throw error;
          }
          if (!observation || observation.target.token !== targetToken) {
            respond(response, 409, {
              scene,
              success: false,
              code: observation ? "target_mismatch" : "target_unavailable",
              error: "The exact Creative target changed during mutation preflight. No mutation was sent.",
            });
            return true;
          }
          const fingerprint = observedCreativeGuard(creativeOperation, observation.response.result);
          if (!observation.response.success || !fingerprint) {
            respond(response, 502, {
              scene,
              success: false,
              code: "invalid_preflight_revision",
              error: "Creative preflight returned no usable snapshot fingerprint. No mutation was sent.",
              target: observation.target,
            });
            return true;
          }
          secured = applyObservedAgentGuard(prepared, sessionId, fingerprint);
        }
        creativeOperation = secured.mutation.operation as typeof creativeOperation;
        agentBoundary = secured.receipt;
      }
      if (isCreativeGuardedRead(creativeOperation) && !creativeOperation.expected_snapshot_fingerprint) {
        let observation = discovery;
        try {
          observation ??= await requestCreativeWorkspaceCommand({ op: "observe" }, undefined, targetToken);
        } catch (error) {
          if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
          throw error;
        }
        if (!observation || observation.target.token !== targetToken) {
          respond(response, 409, {
            scene,
            success: false,
            code: observation ? "target_mismatch" : "target_unavailable",
            error: "The exact Creative target changed during preview preflight. No preview was requested.",
          });
          return true;
        }
        const fingerprint = observedCreativeFingerprint(observation.response.result);
        if (!observation.response.success || !fingerprint) {
          respond(response, 502, {
            scene,
            success: false,
            code: "invalid_preflight_revision",
            error: "Creative preflight returned no usable snapshot fingerprint. No preview was requested.",
            target: observation.target,
          });
          return true;
        }
        creativeOperation = { ...creativeOperation, expected_snapshot_fingerprint: fingerprint };
      }
      let remote: Awaited<ReturnType<typeof requestCreativeWorkspaceCommand>>;
      try {
        remote = await requestCreativeWorkspaceCommand(creativeOperation, undefined, targetToken);
      } catch (error) {
        if (writeBrowserCommandTimeout(response, respond, error, scene, agentBoundary)) return true;
        throw error;
      }
      if (!remote) {
        const mutationOutcomeUnknown = isCreativeMutation(creativeOperation);
        respond(response, mutationOutcomeUnknown ? 409 : targetToken ? 409 : 503, {
          scene,
          success: false,
          error: mutationOutcomeUnknown
            ? "The exact Creative target disconnected during the operation. Reconnect it and retry the same intent with the returned request key; Director will replay or reject it without duplicating the mutation."
            : targetToken
              ? "The bound Canvas/Video target is no longer available. Observe again to acquire a new target_token."
              : "No responsive Canvas/Video workspace is connected. Keep one visible browser tab open and retry.",
          code: mutationOutcomeUnknown
            ? "outcome_unknown"
            : targetToken
              ? "target_unavailable"
              : "creative_workspace_unavailable",
          ...(mutationOutcomeUnknown
            ? {
                result: {
                  operation: creativeOperation.op,
                  command_family: "creative",
                  outcome: "unknown",
                  retry_requires_observe: false,
                },
              }
            : {}),
          ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
        });
        return true;
      }
      if (targetToken && remote.target.token !== targetToken) {
        respond(response, 409, {
          scene,
          success: false,
          code: "target_mismatch",
          error: "The Creative workspace response came from a different target.",
        });
        return true;
      }
      const previewDataUrl = embeddedCreativePreviewDataUrl(remote.response.result);
      const capture = previewDataUrl ? (parseCaptureDataUrl(previewDataUrl) ?? undefined) : undefined;
      if (capture) await savePreview(capture);
      const execution: StageGatewayExecution = {
        scene,
        success: remote.response.success,
        ...(remote.response.result !== undefined
          ? { result: withoutEmbeddedCreativePreviewDataUrl(remote.response.result) }
          : {}),
        ...(remote.response.error ? { error: remote.response.error } : {}),
        ...(capture ? { capture } : {}),
        target: remote.target,
        ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
      };
      execution.feedback = createStageFeedback({
        before: scene,
        execution,
        toolInput: creativeOperation,
        refs: new Map(),
        tool: "director_creative",
      });
      const resultCode = directResultCode(remote.response.result);
      const conflict = [
        "stale_snapshot",
        "stale_guard",
        "conflict",
        "idempotency_key_conflict",
        "idempotency_replay_stale",
      ].includes(resultCode ?? "");
      respond(response, execution.success ? 200 : conflict ? 409 : 400, execution);
      return true;
    } finally {
      targetLease?.release();
      sessionLease?.release();
    }
  }

  if (tool === "director_workbench") {
    const initialParse = parseDirectorWorkbenchInput(toolInput);
    // Character-scoped author actions may omit their object target when the
    // caller possesses exactly one character; those gaps are repaired from the
    // possession preflight below, before the input is validated again.
    const characterTargetGaps = initialParse.success ? [] : findDirectorAuthorCharacterTargetGaps(toolInput);
    const initialParseError = initialParse.success ? null : initialParse.error;
    if (!initialParse.success && !characterTargetGaps.length) {
      respond(response, 400, { scene, success: false, error: initialParse.error });
      return true;
    }
    if (initialParse.success && initialParse.operation.op === "describe") {
      // Pure contract reflection answered gateway-locally: no browser tab, no
      // session lock — serializing a stateless instant read only adds contention.
      const described = describeDirectorWorkbenchTarget(initialParse.operation.target);
      if (described.success) respond(response, 200, { scene, success: true, result: described.result });
      else respond(response, 400, { scene, success: false, error: described.error });
      return true;
    }
    if (initialParse.success && initialParse.operation.op === "game_playtest") {
      respond(response, 400, {
        scene,
        success: false,
        code: "game_playtest_via_director_game",
        error:
          'game_playtest is an internal Gateway→Stage transport. Call director_game {"op":"playtest"} so the slice bind/evaluate loop owns the receipt.',
        corrective_call: {
          tool: "director_game",
          input: {
            op: "playtest",
            slice_id: initialParse.operation.slice_id ?? "<bound slice id>",
            script: initialParse.operation.script,
          },
        },
      });
      return true;
    }
    const sessionLocked = !usesExactTargetLock(targetToken, targetScheduler);
    let sessionLease: DirectorAgentTargetLease | undefined;
    if (sessionLocked) {
      const acquired = await acquireScheduledLease(
        request,
        response,
        sessionScheduler,
        sessionCallKey(tool, sessionId),
        tool,
        initialParse.success ? initialParse.operation : toolInput,
      );
      if (acquired === null) return true;
      sessionLease = acquired;
    }
    let targetLease: DirectorAgentTargetLease | undefined;
    try {
      // A pending fill-in is always an author mutation, so it needs a target
      // and its discovery observe must carry character summaries.
      let operation = initialParse.success ? initialParse.operation : null;
      const targetRequired =
        !operation ||
        (!["capabilities", "catalog", "observe", "describe"].includes(operation.op) &&
          !(operation.op === "inspect" && operation.entity === "catalog_asset"));
      // Mutation discovery also reads character summaries so the possession
      // scope check below reuses the same preflight round trip.
      const discoveryObserve: DirectorWorkbenchOperation = {
        op: "observe",
        fields: !operation || isWorkbenchMutation(operation) ? ["counts", "characters"] : ["counts"],
      };
      let discovery: WorkbenchRemote | null = null;
      if (targetRequired && !targetToken) {
        // Session stickiness: an untargeted caller keeps addressing the tab that
        // served its previous call, so author→capture sequences cannot fork
        // across tabs with divergent project state.
        const rememberedTarget = recallAgentSessionTarget("director_workbench", sessionId);
        if (rememberedTarget) {
          try {
            discovery = await requestWorkbenchCommand(discoveryObserve, undefined, rememberedTarget);
          } catch (error) {
            if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
            throw error;
          }
          if (discovery) targetToken = rememberedTarget;
          else forgetAgentSessionTarget("director_workbench", sessionId);
        }
        if (!targetToken) {
          try {
            discovery = await requestWorkbenchCommand(discoveryObserve);
          } catch (error) {
            if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
            throw error;
          }
          if (!discovery) {
            if (
              operation &&
              (await respondDisconnectedWorkbenchRead({
                operation,
                scene,
                respond,
                response,
                loadSources: loadDisconnectedWorkbenchSources,
              }))
            ) {
              return true;
            }
            respond(response, 503, {
              scene,
              success: false,
              error: WORKBENCH_UNAVAILABLE_ERROR,
              code: "workbench_unavailable",
            });
            return true;
          }
          targetToken = discovery.target.token;
        }
      }
      const scheduledLease = await acquireScheduledLease(
        request,
        response,
        targetScheduler,
        targetToken,
        tool,
        operation ?? toolInput,
      );
      if (scheduledLease === null) return true;
      targetLease = scheduledLease;
      if (
        targetToken &&
        (!operation || isWorkbenchMutation(operation) || isWorkbenchDurableJobMutation(operation)) &&
        isTargetContractStale?.(targetToken)
      ) {
        respond(response, 409, {
          scene,
          success: false,
          code: "workbench_contract_stale",
          error:
            "The bound Director tab runs an older build whose contract would silently drop newer fields. Reload that Director tab, then retry this exact request.",
        });
        return true;
      }
      let possessionCharacters = observedWorkbenchCharacters(discovery?.response.result);
      let possessionLivePlayer = observedLivePlayer(discovery?.response.result);
      if (!operation) {
        // Possession fill-in: character-scoped author actions omitted their
        // object target. When the caller possesses exactly one character, fill
        // that character id and validate the repaired input; otherwise reject
        // ambiguity readably or fall back to the original validation error.
        if (!possessionCharacters) {
          let possessionProbe: WorkbenchRemote | null;
          try {
            possessionProbe = await requestWorkbenchCommand(
              { op: "observe", fields: ["counts", "characters"] },
              undefined,
              targetToken,
            );
          } catch (error) {
            if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
            throw error;
          }
          if (!possessionProbe || possessionProbe.target.token !== targetToken) {
            respond(response, 409, {
              scene,
              success: false,
              code: possessionProbe ? "target_mismatch" : "target_unavailable",
              error: "The exact Workbench target changed during the possession preflight. No mutation was sent.",
            });
            return true;
          }
          // The probe carries counts + characters, so the revision guard below
          // reuses it instead of observing the same target again.
          discovery = possessionProbe;
          possessionCharacters = observedWorkbenchCharacters(possessionProbe.response.result) ?? [];
        }
        const possessedObjectIds = collectPossessedObjectIds(possessionCharacters, possessionIdentity);
        if (possessedObjectIds.length !== 1) {
          respond(
            response,
            400,
            possessedObjectIds.length
              ? {
                  scene,
                  success: false,
                  code: "possession_target_ambiguous",
                  error: describeDirectorPossessionTargetAmbiguity({
                    sessionId,
                    possessedObjectIds,
                    gaps: characterTargetGaps,
                  }),
                }
              : { scene, success: false, error: initialParseError ?? "director_workbench input invalid." },
          );
          return true;
        }
        const filled = fillDirectorAuthorCharacterTargets(toolInput, characterTargetGaps, possessedObjectIds[0]);
        const reparsed = parseDirectorWorkbenchInput(filled);
        if (!reparsed.success) {
          respond(response, 400, { scene, success: false, error: reparsed.error });
          return true;
        }
        operation = reparsed.operation;
      }
      let workbenchOperation = operation;
      let agentBoundary: AgentBoundaryReceipt | undefined;
      // Possession scope: a session bound to characters (mode=possess) may
      // only mutate those characters. Resolves the binding set (probing the
      // exact target when no preflight already observed characters) and writes
      // the 403 rejection; returns true when a response was written.
      const rejectsPossessionScope = async (candidate: DirectorWorkbenchOperation): Promise<boolean> => {
        const needsLivePlayer =
          candidate.op === "player" &&
          ["exit", "interact", "enter_vehicle", "exit_vehicle", "record_start", "record_stop"].includes(
            candidate.action,
          );
        if (!possessionCharacters || (needsLivePlayer && possessionLivePlayer === null)) {
          let bindingProbe: WorkbenchRemote | null;
          try {
            bindingProbe = await requestWorkbenchCommand(
              {
                op: "observe",
                fields: needsLivePlayer ? ["characters", "ui"] : ["characters"],
              },
              undefined,
              targetToken,
            );
          } catch (error) {
            if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
            throw error;
          }
          if (!bindingProbe || bindingProbe.target.token !== targetToken) {
            respond(response, 409, {
              scene,
              success: false,
              code: bindingProbe ? "target_mismatch" : "target_unavailable",
              error: "The exact Workbench target changed during the possession preflight. No mutation was sent.",
            });
            return true;
          }
          possessionCharacters = observedWorkbenchCharacters(bindingProbe.response.result) ?? [];
          if (needsLivePlayer) {
            possessionLivePlayer = observedLivePlayer(bindingProbe.response.result) ?? {
              playerMode: false,
              playerActorId: null,
            };
          }
        }
        const possessedObjectIds = collectPossessedObjectIds(possessionCharacters, possessionIdentity);
        if (!possessedObjectIds.length) return false;
        const verdict = evaluateDirectorPossessionScope({
          operation: candidate,
          sessionId,
          possessedObjectIds,
          ...(needsLivePlayer ? { livePlayer: possessionLivePlayer } : {}),
        });
        if (verdict.allowed) return false;
        respond(response, 403, {
          scene,
          success: false,
          code: "possession_scope_violation",
          error: verdict.error,
        });
        return true;
      };
      if (isWorkbenchDurableJobMutation(workbenchOperation)) {
        const prepared = prepareAgentDurableJobMutation({
          tool: "director_workbench",
          operation: workbenchOperation,
        });
        workbenchOperation = prepared.mutation.operation;
        agentBoundary = prepared.receipt;
      } else if (isWorkbenchSessionMutation(workbenchOperation)) {
        // Player Mode and pilot.record_waypoint mutate live project state but
        // carry no revision-guard fields, so they skip prepareAgentMutation;
        // the possession scope still applies before dispatch.
        if (await rejectsPossessionScope(workbenchOperation)) return true;
      } else if (isWorkbenchRevisionGuardedMutation(workbenchOperation)) {
        const prepared = prepareAgentMutation({ tool: "director_workbench", operation: workbenchOperation }, sessionId);
        let secured = prepared;
        if (prepared.needsObservation) {
          let observation: WorkbenchRemote | null;
          try {
            observation =
              prepared.mutation.operation.op === "production"
                ? await requestWorkbenchCommand(
                    { op: "production", command: { action: "observe" } },
                    undefined,
                    targetToken,
                  )
                : (discovery ??
                  (await requestWorkbenchCommand(
                    { op: "observe", fields: ["counts", "characters"] },
                    undefined,
                    targetToken,
                  )));
          } catch (error) {
            if (writeBrowserCommandTimeout(response, respond, error, scene)) return true;
            throw error;
          }
          if (!observation || observation.target.token !== targetToken) {
            respond(response, 409, {
              scene,
              success: false,
              code: observation ? "target_mismatch" : "target_unavailable",
              error: "The exact Workbench target changed during mutation preflight. No mutation was sent.",
            });
            return true;
          }
          const revision =
            prepared.mutation.operation.op === "production"
              ? observedProductionRevision(observation.response.result)
              : observedWorkbenchRevision(observation.response.result);
          if (!observation.response.success || !revision) {
            respond(response, 502, {
              scene,
              success: false,
              code: "invalid_preflight_revision",
              error:
                prepared.mutation.operation.op === "production"
                  ? "Workbench preflight returned no usable production revision. No mutation was sent."
                  : "Workbench preflight returned no usable project revision. No mutation was sent.",
              target: observation.target,
            });
            return true;
          }
          possessionCharacters ??= observedWorkbenchCharacters(observation.response.result);
          secured = applyObservedAgentGuard(prepared, sessionId, revision);
        }
        // Guard-carrying mutations that skipped the revision preflight still
        // resolve the binding set before dispatch.
        if (await rejectsPossessionScope(secured.mutation.operation as DirectorWorkbenchOperation)) return true;
        workbenchOperation = secured.mutation.operation as typeof workbenchOperation;
        agentBoundary = secured.receipt;
      }
      const beforeScene = scene;
      let remote: WorkbenchRemote | null;
      try {
        remote =
          workbenchOperation.op === "capture" || workbenchOperation.op === "shot_package"
            ? await requestWorkbenchCapture(workbenchOperation, undefined, targetToken)
            : await requestWorkbenchCommand(workbenchOperation, undefined, targetToken);
      } catch (error) {
        if (writeBrowserCommandTimeout(response, respond, error, scene, agentBoundary)) return true;
        throw error;
      }
      if (!remote) {
        forgetAgentSessionTarget("director_workbench", sessionId);
        const mutationOutcomeUnknown =
          isWorkbenchMutation(workbenchOperation) || isWorkbenchDurableJobMutation(workbenchOperation);
        if (
          !mutationOutcomeUnknown &&
          (await respondDisconnectedWorkbenchRead({
            operation: workbenchOperation,
            scene,
            respond,
            response,
            loadSources: loadDisconnectedWorkbenchSources,
          }))
        ) {
          return true;
        }
        respond(response, targetToken ? 409 : 503, {
          scene,
          success: false,
          error: mutationOutcomeUnknown
            ? agentBoundary
              ? `The bound Director workbench target disconnected during the edit. Reconnect it and retry the same intent with request key ${agentBoundary.idempotency.key}.`
              : "The bound Director workbench target disconnected during the edit. Reconnect it and inspect the current scene before retrying any missing work."
            : targetToken
              ? "The bound Director workbench target is no longer available. Observe again to acquire a new target_token."
              : WORKBENCH_UNAVAILABLE_ERROR,
          code: mutationOutcomeUnknown
            ? "outcome_unknown"
            : targetToken
              ? "target_unavailable"
              : "workbench_unavailable",
          ...(mutationOutcomeUnknown
            ? {
                result: {
                  operation:
                    workbenchOperation.op === "production"
                      ? `production.${workbenchOperation.command.action}`
                      : workbenchOperation.op === "generation" ||
                          workbenchOperation.op === "transcription" ||
                          workbenchOperation.op === "generated_3d"
                        ? `${workbenchOperation.op}.${workbenchOperation.command.action}`
                        : workbenchOperation.op,
                  command_family: "workbench",
                  outcome: "unknown",
                  retry_requires_observe: !agentBoundary,
                },
              }
            : {}),
          ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
        });
        return true;
      }
      if (targetToken && remote.target.token !== targetToken) {
        respond(response, 409, {
          scene,
          success: false,
          code: "target_mismatch",
          error: "The Director workbench response came from a different target.",
        });
        return true;
      }
      rememberAgentSessionTarget("director_workbench", sessionId, remote.target.token);
      const remoteResponse = remote.response;
      let nextScene = scene;
      if (remoteResponse.stageScene !== undefined) {
        const parsedScene = parseStageScene(remoteResponse.stageScene);
        if (!parsedScene.success) {
          respond(response, 502, {
            scene,
            success: false,
            error: `Workbench returned an invalid Stage projection: ${parsedScene.error}`,
          });
          return true;
        }
        nextScene = parsedScene.scene;
      }
      if (remoteResponse.project !== undefined) {
        const parsedProject = safeParseDirectorProject(remoteResponse.project);
        if (!parsedProject.success) {
          respond(response, 502, {
            scene,
            success: false,
            error: `Workbench returned an invalid Director project: ${parsedProject.error}`,
          });
          return true;
        }
        await persistWorkbenchProject(parsedProject.project, remote.client);
      }
      if (remoteResponse.success && nextScene !== scene) {
        replaceScene(nextScene);
        await persistScene();
        scene = nextScene;
      }
      const capture = remoteResponse.captureDataUrl
        ? (parseCaptureDataUrl(remoteResponse.captureDataUrl) ?? undefined)
        : undefined;
      if (capture) await savePreview(capture);
      const resultCode = directResultCode(remoteResponse.result);
      const execution: StageGatewayExecution = {
        scene: nextScene,
        success: remoteResponse.success,
        ...(resultCode ? { code: resultCode } : {}),
        ...(remoteResponse.result !== undefined ? { result: remoteResponse.result } : {}),
        ...(remoteResponse.error ? { error: remoteResponse.error } : {}),
        ...(capture ? { capture } : {}),
        target: remote.target,
        ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
      };
      execution.feedback = createStageFeedback({
        before: beforeScene,
        execution,
        toolInput: workbenchOperation,
        refs: new Map(),
        tool: "director_workbench",
      });
      const responseStatus = execution.success
        ? 200
        : resultCode === "stale_production_revision" ||
            resultCode === "stale_project_revision" ||
            resultCode === "idempotency_key_conflict" ||
            resultCode === "production_job_idempotency_conflict" ||
            resultCode === "idempotency_replay_stale"
          ? 409
          : 400;
      respond(response, responseStatus, execution);
      return true;
    } finally {
      targetLease?.release();
      sessionLease?.release();
    }
  }
  if (tool === "stage_video") {
    const execution = await executeVideoModel(scene, toolInput);
    traceJson(response, execution.success ? 200 : 400, execution);
    return true;
  }

  const refs = refsForSession(sessionId);
  const beforeScene = scene;
  const execution = executeStageTool(scene, tool, toolInput, refs);
  if (execution.success) {
    scene = execution.scene;
    replaceScene(scene);
    await persistScene();
    broadcast({ type: "state", scene, source: "agent", events: execution.events ?? [] });
  }
  let capture: StageCapturePayload | undefined;
  if (execution.events?.some((event) => event.type === "capture")) {
    const captureCameraId = execution.events.find((event) => event.type === "capture")?.objectId;
    const dataUrl = hasConnectedClient() ? await requestCapture(captureCameraId) : null;
    capture = dataUrl ? (parseCaptureDataUrl(dataUrl) ?? undefined) : undefined;
    if (capture) {
      await savePreview(capture);
      execution.result = {
        ...(typeof execution.result === "object" && execution.result ? execution.result : {}),
        preview_url: previewUrl(),
      };
    } else {
      execution.result = {
        ...(typeof execution.result === "object" && execution.result ? execution.result : {}),
        preview_error: "No valid rendered frame was returned. Keep a Director canvas open and retry.",
      };
    }
  }
  const gatewayExecution: StageGatewayExecution = {
    ...execution,
    feedback: createStageFeedback({ before: beforeScene, execution, toolInput, refs, tool }),
    ...(capture ? { capture } : {}),
  };
  traceJson(response, execution.success ? 200 : 400, gatewayExecution);
  return true;
}
