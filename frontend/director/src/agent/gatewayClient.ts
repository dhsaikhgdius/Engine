/**
 * Director Gateway client: the browser side of the Agent control plane.
 *
 * One module-level singleton per tab owns the authenticated WebSocket to the
 * gateway (`/ws`), announces this tab as a browser target (presence), applies
 * remote scene state, debounce-pushes local edits back, and executes targeted
 * `director_workbench` / `director_creative` commands by routing them to the
 * workbench executor modules in this directory.
 *
 * Correctness invariants enforced here rather than by callers:
 * - Every targeted command is gated on an exact target binding (client id,
 *   scene id, creative scope, contract version) both before it starts and
 *   before its response is sent; a mismatch produces a typed failure and the
 *   stale response is discarded, never delivered.
 * - Capture-bearing operations (author with evidence, deliver, capture,
 *   shot_package) run under a revision-bound capture so evidence can never
 *   mix project revisions; post-capture drift is reported as
 *   `stale_after_capture` instead of silently accepted.
 * - Scene persistence is serialized per scene with optimistic revisions, and
 *   scene switches are sequence-numbered so a superseded switch can never
 *   apply its continuation.
 */
import { applyDirectorPageEvent } from "../comprehensive/editor/assistant/pageStateBridge";
import {
  bootstrapDirectorAgent,
  clearDirectorAgentClient,
  directorAgentFetch,
} from "../comprehensive/editor/assistant/agentGatewayClient";
import {
  isViewportCaptureUnavailableError,
  isViewportCaptureReady,
  requestViewportCapture,
  subscribeViewportCaptureReadiness,
} from "../comprehensive/editor/io/captureBridge";
import { getDirectorProjectRevision } from "@director/project-schema";
import type { DirectorProject } from "@director/project-schema";
import { safeParseDirectorProject } from "@director/project-schema";
import {
  createDirectorProductionScene,
  DirectorProductionClientError,
  getDirectorProduction,
  getDirectorProductionSceneProject,
  saveDirectorProductionSceneProject,
  updateDirectorProduction,
} from "../comprehensive/editor/production/productionClient";
import { captureDirectorShotPackage } from "../comprehensive/editor/shot/shotPackageCapture";
import {
  getDirectorSessionRuntime,
  updateDirectorSessionRuntime,
} from "../comprehensive/editor/session/directorSessionRuntime";
import { createDefaultDirectorProject, useDirectorStore } from "../comprehensive/editor/store/directorStore";
import {
  getDirectorCreativeWorkspaceScope,
  setDirectorCreativeWorkspaceScope,
  subscribeDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
  type DirectorWorkspaceMode,
} from "../comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  directorCreativeWorkspaceCommandResponseWireSchema,
  directorGatewayInboundMessageSchema,
  directorWorkbenchCommandResponseWireSchema,
  sameDirectorAgentTarget,
  type DirectorAgentTargetWire,
} from "@director/protocol/agentGatewayProtocol";
import { createDefaultScene } from "@director/stage-protocol";
import type { AgentToolName, StageAgentEvent, StageScene, ToolExecution } from "@director/stage-protocol";
import { announceDirectorPossessionFeedback } from "./possessionWriteReceiptUi";
import {
  directorProjectToStageScene,
  stageManagedDirectorObjectIds,
  stageSceneToDirectorProject,
  stageAspectToDirectorAspect,
} from "@director/agent-engine/stage-adapter";
import {
  executeDirectorSessionWorkbenchOperation,
  executeDirectorWorkbenchOperation,
  type DirectorWorkbenchExecution,
} from "./directorWorkbenchExecutor";
import {
  DIRECTOR_WORKBENCH_CONTRACT_FINGERPRINT,
  parseDirectorWorkbenchExecutableInput,
} from "@director/agent-engine/contract";
import { DirectorProjectRevisionConflictError, runWithDirectorProjectRevision } from "./directorRevisionBoundCapture";
import {
  executeDirectorCaptureCompareWorkbenchCommand,
  type CaptureViewportRequest,
} from "./directorCaptureCompareWorkbench";
import { executeDirectorCaptureReconstructionWorkbenchCommand } from "./directorCaptureReconstructionWorkbench";
import { executeDirectorGenerated3DWorkbenchCommand } from "./directorGenerated3DWorkbench";
import { executeDirectorGenerationWorkbenchCommand } from "./directorGenerationWorkbench";
import { executeDirectorTranscriptionWorkbenchCommand } from "./directorTranscriptionWorkbench";
import { executeDirectorStoryboardWorkbenchCommand } from "./directorStoryboardWorkbench";
import {
  executeDirectorProductionWorkbenchOperation,
  type DirectorProductionSceneSwitch,
} from "./directorProductionWorkbench";
import {
  executeCreativeWorkspaceAgentOperationAsync,
  executeCreativeWorkspaceAgentRequest,
} from "./creativeWorkspaceAgentContract";
import { executeCreativeWorkspaceAgentPreviewRequest } from "./creativeWorkspaceAgentPreview";
import { executeCreativeWorkspaceSemanticRequest } from "./creativeWorkspaceSemanticOperations";
import {
  getBoundDirectorBrowserTarget,
  setBoundDirectorBrowserTarget,
} from "../comprehensive/editor/gateway/browserTargetRegistry";

// The Director Gateway is the backend coordinator for all agent communication,
// scene persistence, and tool routing. Falls back to the local dev server.
const GATEWAY_URL = import.meta.env.VITE_STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Derived from the HTTP URL; WebSocket is used for real-time bidirectional
// command delivery, state sync, and presence announcements.
const WS_URL = GATEWAY_URL.replace(/^http/, "ws") + "/ws";
// Default scene identifier used when the user hasn't opened a specific
// production scene — the "local sandbox" stage that lives in the browser tab.
const LOCAL_SCENE_ID = "local-stage";
// sessionStorage key so the client id survives page refreshes within the same
// tab but stays independent across tabs — each tab is a distinct browser target.
const BROWSER_CLIENT_ID_STORAGE_KEY = "director.gateway.browser-client-id.v1";

// sessionStorage is used so the client ID is stable within a tab session
// (page refreshes keep the same identity) but independent across tabs —
// each tab registers as a separate browser target to the gateway.
function getBrowserClientId() {
  try {
    const stored = window.sessionStorage.getItem(BROWSER_CLIENT_ID_STORAGE_KEY);
    if (stored) return stored;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(BROWSER_CLIENT_ID_STORAGE_KEY, created);
    return created;
  } catch {
    // sessionStorage may be unavailable in some embed contexts (e.g. sandboxed iframes);
    // fall back to an ephemeral UUID that lasts only for this page load.
    return crypto.randomUUID();
  }
}

const browserClientId = getBrowserClientId();

// The single active WebSocket connection to the Director Gateway.
// Only one connection is maintained per tab; all state sync and command
// delivery flows through this socket.
let socket: WebSocket | null = null;
// The currently active scene being edited. Starts as the local sandbox
// scene and switches when the user navigates to a production scene.
let activeSceneId = LOCAL_SCENE_ID;
// Guard flag that prevents the local store subscription from re-pushing
// changes that originated from the gateway (remote state application).
// Without this, every remote scene update would trigger a redundant push loop.
let applyingRemote = false;
// Lifecycle flag; when true, all reconnect timers, socket operations,
// and scene-switch continuations are suppressed.
let disposed = false;
// Debounce timer for pushing local scene changes to the gateway.
// Batches rapid edits (e.g. drag operations) into a single push.
let saveTimer: number | undefined;
// Reconnect timer for the WebSocket; fires after a fixed delay on close/error.
let reconnectTimer: number | undefined;
// Monotonically increasing local revision counter used for session runtime
// tracking and to detect stale scene-switch continuations.
let revision = 0;
// Cached copy of the most recent stage scene, used as the base for
// project-to-stage conversion and for diffing against incoming remote scenes.
let latestStageScene = createDefaultScene();
// Set of stage-managed object IDs from the previous scene application.
// Used during stageSceneToDirectorProject to detect objects that were
// removed on the stage side and should be cleaned up in the project.
let previousStageObjectIds = new Set<string>();
// Serialized fingerprint of the last applied scene; compared against
// incoming scenes to skip redundant project application and save cycles.
let lastAppliedStageSignature = "";
// Monotonically increasing counter that invalidates stale scene-switch
// continuations. Incremented on every switch; if a continuation sees a
// mismatched counter, it was superseded by a newer switch.
let sceneSwitchSequence = 0;
// Serialized promise chain that ensures scene project saves are ordered
// and non-overlapping. Each save waits for the previous one to settle.
let sceneProjectSaveQueue: Promise<void> = Promise.resolve();
// Per-scene server revision tracking for optimistic concurrency control.
// Prevents conflicting writes when multiple tabs target the same scene.
const sceneProjectRevisions = new Map<string, number>();
// Per-scene content fingerprints to avoid redundant network saves.
// If the local snapshot matches the last-known server signature, the save is skipped.
const sceneProjectSignatures = new Map<string, string>();
// Maps request IDs to AbortControllers for cancellable workbench commands.
// Commands are aborted when the target binding changes or the scene switches.
const workbenchCommandControllers = new Map<string, AbortController>();
const creativeCommandControllers = new Map<string, AbortController>();

// Aborts a single pending command identified by its requestId.
// Uses DOMException("AbortError") so downstream fetch/async handlers
// can distinguish intentional cancellation from network failures.
function abortCommand(
  controllers: Map<string, AbortController>,
  requestId: string,
  reason: "timeout" | "target_unavailable" | "superseded",
) {
  const controller = controllers.get(requestId);
  if (!controller || controller.signal.aborted) return;
  controller.abort(new DOMException(`Director gateway command cancelled: ${reason}`, "AbortError"));
}

// Aborts every in-flight command across both workbench and creative channels.
// Called when the target binding is lost (target_unavailable) or when a new
// target binding supersedes the old one (superseded).
function abortAllGatewayCommands(reason: "target_unavailable" | "superseded") {
  for (const requestId of workbenchCommandControllers.keys())
    abortCommand(workbenchCommandControllers, requestId, reason);
  for (const requestId of creativeCommandControllers.keys())
    abortCommand(creativeCommandControllers, requestId, reason);
}

/**
 * Determines whether a gateway agent target matches this browser context.
 *
 * A match requires the target to be on contract version 2 and share the same
 * client ID, scene ID, instance ID, and creative scope ID as this tab.
 *
 * @param target - The agent target received from the gateway.
 * @param context - The current browser context (client, scene, creative scope).
 * @returns `true` if the target is bound to this exact browser tab.
 */
export function directorAgentTargetMatchesBrowserContext(
  target: DirectorAgentTargetWire,
  context: { clientId: string; sceneId: string; creativeScopeId: string },
): boolean {
  return (
    target.contract_version === 2 &&
    target.client_id === context.clientId &&
    target.instance_id === context.sceneId &&
    target.scene_id === context.sceneId &&
    target.creative_scope_id === context.creativeScopeId
  );
}

// Formats the first few Zod validation issues into a single-line summary
// for console warnings and error messages. Capped at 3 issues and 300 chars
// per issue to keep log output readable.
function contractIssueSummary(error: { issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }> }) {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`.slice(0, 300))
    .join("; ");
}

// Returns true only when the target's identity, connection, and browser context
// all match the current tab's live state. This is the gate check used before
// processing any targeted command — if any piece is stale, the command is rejected.
function targetMatchesCurrentBrowser(target: DirectorAgentTargetWire, connection: WebSocket | null = socket): boolean {
  return Boolean(
    connection &&
    connection === socket &&
    connection.readyState === WebSocket.OPEN &&
    sameDirectorAgentTarget(getBoundDirectorBrowserTarget(), target) &&
    directorAgentTargetMatchesBrowserContext(target, {
      clientId: browserClientId,
      sceneId: activeSceneId,
      creativeScopeId: getDirectorCreativeWorkspaceScope(),
    }),
  );
}

// Throws if this tab is not currently bound to an agent target.
// Used as a precondition guard for targeted tool calls (workbench, creative)
// that must route through an exact browser binding.
function requireBoundAgentTarget(): DirectorAgentTargetWire {
  const target = getBoundDirectorBrowserTarget();
  if (!target || !targetMatchesCurrentBrowser(target)) {
    throw new Error("Director Agent target is not bound to this browser scene yet. Wait for target-bound and retry.");
  }
  return target;
}

/** Exact live browser target used to pin durable Agent turns to this tab. */
export function getBoundDirectorAgentTarget(): DirectorAgentTargetWire | null {
  const target = getBoundDirectorBrowserTarget();
  return target && targetMatchesCurrentBrowser(target) ? target : null;
}

/**
 * Wraps a tool invocation into the standard gateway request envelope.
 *
 * For targeted tools ({@link director_workbench}, {@link director_creative}),
 * the envelope includes a target token that pins the request to an exact
 * browser tab. Non-targeted tools omit the token.
 *
 * @param tool - The agent tool being invoked.
 * @param input - The tool-specific input payload.
 * @param sessionId - The agent session identifier.
 * @param target - The bound browser target, required for targeted tools.
 * @returns A gateway-compatible request envelope.
 * @throws If a targeted tool is called without a bound target.
 */
export function createGatewayToolRequestEnvelope(
  tool: AgentToolName,
  input: unknown,
  sessionId: string,
  target?: DirectorAgentTargetWire | null,
) {
  const targeted = tool === "director_workbench" || tool === "director_creative";
  if (targeted && !target) throw new Error(`${tool} requires an exact browser target binding.`);
  return {
    input,
    session_id: sessionId,
    ...(targeted && target ? { target_token: target.token } : {}),
  };
}

// Sends a structured failure response for a creative workspace command
// that could not be executed because the target binding was stale or missing.
// Validated through the shared wire schema so the gateway can parse it reliably.
function sendCreativeTargetFailure(
  connection: WebSocket,
  requestId: string,
  target: DirectorAgentTargetWire,
  error: string,
) {
  const response = directorCreativeWorkspaceCommandResponseWireSchema.parse({
    type: "creative-workspace-command-response",
    requestId,
    target,
    success: false,
    error,
  });
  connection.send(JSON.stringify(response));
}

// Sends a structured failure response for a workbench command
// that could not be executed because the target binding was stale or missing.
// Validated through the shared wire schema so the gateway can parse it reliably.
function sendWorkbenchTargetFailure(
  connection: WebSocket,
  requestId: string,
  target: DirectorAgentTargetWire,
  error: string,
) {
  const response = directorWorkbenchCommandResponseWireSchema.parse({
    type: "workbench-command-response",
    requestId,
    target,
    success: false,
    error,
  });
  connection.send(JSON.stringify(response));
}

/**
 * Builds a "hello" presence message announcing this browser tab to the gateway.
 *
 * The presence includes the tab's identity, visibility, workspace mode, and
 * whether the viewport capture pipeline is ready. The gateway uses this to
 * discover and route to available browser targets.
 *
 * @param input - The presence parameters (client, scene, visibility, workspace, capture readiness).
 * @returns A gateway-compatible presence message.
 */
export function createDirectorGatewayPresence(input: {
  clientId: string;
  sceneId: string;
  visible: boolean;
  workspace: DirectorWorkspaceMode;
  captureReady: boolean;
}) {
  return {
    type: "hello" as const,
    role: "director-ui" as const,
    visible: input.visible,
    client_id: input.clientId,
    instance_id: input.sceneId,
    scene_id: input.sceneId,
    creative_scope_id: getDirectorCreativeWorkspaceScope(),
    contract_version: 2 as const,
    workspace: input.workspace,
    capture_ready: input.captureReady,
    contract_fingerprint: DIRECTOR_WORKBENCH_CONTRACT_FINGERPRINT,
  };
}

// Sends a "hello" presence message to the gateway over the active WebSocket.
// The gateway uses this to discover browser targets, track visibility,
// workspace mode, and capture readiness. Called on connection open, visibility
// changes, workspace switches, and capture readiness transitions.
function announceWorkbenchPresence() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const workspace: DirectorWorkspaceMode =
    new URLSearchParams(window.location.search).get("embed") === "comfyui"
      ? "stage"
      : useDirectorCreativeWorkspaceStore.getState().mode;
  socket.send(
    JSON.stringify(
      createDirectorGatewayPresence({
        clientId: browserClientId,
        sceneId: activeSceneId,
        visible: !document.hidden,
        workspace,
        captureReady: isViewportCaptureReady(),
      }),
    ),
  );
}

/**
 * Converts a viewport-capture-unavailable error into a structured result.
 *
 * When the capture pipeline isn't ready (e.g., the 3D viewport hasn't mounted
 * or the user is on a non-Stage workspace), this returns a diagnostic result
 * that the gateway can surface to the agent with a suggested next action.
 *
 * @param error - The error to inspect.
 * @returns A structured capture-unavailable result, or `null` if the error is unrelated.
 */
export function viewportCaptureUnavailableResult(error: unknown) {
  if (!isViewportCaptureUnavailableError(error)) return null;
  return {
    code: "capture_unavailable",
    suggested_next:
      "Open or switch this browser target to 3D Stage, wait for the viewport to finish mounting, then observe again before retrying capture.",
  };
}

// Maps a DirectorProjectRevisionConflictError to a structured result
// that the gateway can surface to the agent as actionable metadata.
function revisionConflictResult(error: unknown) {
  if (!(error instanceof DirectorProjectRevisionConflictError)) return null;
  return {
    code: error.code,
    expected_revision: error.expectedRevision,
    actual_revision: error.actualRevision,
  };
}

/**
 * Wraps a delivery failure into a structured {@link DirectorWorkbenchExecution}.
 *
 * Inspects the error for revision conflicts and capture unavailability, merging
 * those diagnostics into the execution result so the gateway can relay
 * actionable metadata to the agent.
 *
 * @param error - The error that caused the delivery to fail.
 * @param receipt - The partial delivery receipt from the workbench operation.
 * @param currentProjectRevision - The project revision at the time of failure.
 * @returns A failed execution with enriched diagnostic metadata.
 */
export function directorWorkbenchDeliveryFailure(
  error: unknown,
  receipt: Record<string, unknown>,
  currentProjectRevision: string,
): DirectorWorkbenchExecution {
  const conflict = revisionConflictResult(error);
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    result: {
      ...receipt,
      ...(conflict ?? {}),
      project_revision: currentProjectRevision,
      ...(viewportCaptureUnavailableResult(error) ?? {}),
      ready: false,
      status: conflict ? "capture-stale" : "capture-failed",
      capture_verified: false,
    },
  };
}

/**
 * Wraps a capture failure into a structured {@link DirectorWorkbenchExecution}.
 *
 * Inspects the error for revision conflicts and capture unavailability, attaching
 * those diagnostics to the result when present. Unlike delivery failures, capture
 * failures may omit the result object when no diagnostic metadata is available.
 *
 * @param error - The error that caused the capture to fail.
 * @returns A failed execution, optionally enriched with conflict or unavailability metadata.
 */
export function directorWorkbenchCaptureFailure(error: unknown): DirectorWorkbenchExecution {
  const conflict = revisionConflictResult(error);
  const unavailable = viewportCaptureUnavailableResult(error);
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    ...(conflict || unavailable ? { result: { ...(conflict ?? {}), ...(unavailable ?? {}) } } : {}),
  };
}

/** Live scene moved after evidence was taken. Keep the frame; report stale as a sibling outcome. */
export function withStaleAfterCapture(
  execution: DirectorWorkbenchExecution,
  expectedRevision: string,
  actualRevision: string,
): DirectorWorkbenchExecution {
  if (!execution.success || expectedRevision === actualRevision) return execution;
  const result =
    execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
      ? (execution.result as Record<string, unknown>)
      : { value: execution.result ?? null };
  return {
    ...execution,
    result: {
      ...result,
      stale_after_capture: true,
      code: "stale_project_revision",
      expected_revision: expectedRevision,
      actual_revision: actualRevision,
    },
  };
}

// Updates the session runtime status bar with the current connection state.
// The codex field is treated specially: "ready" on connect, "unavailable" on
// disconnect, "unknown" while connecting — reflecting that codex depends on
// a live gateway connection to function.
function updateConnection(status: "connected" | "connecting" | "disconnected") {
  updateDirectorSessionRuntime({
    sceneId: activeSceneId,
    gateway: status,
    mcp: status,
    comfyui: status,
    codex: status === "connected" ? "ready" : status === "disconnected" ? "unavailable" : "unknown",
    revision,
  });
}

// Processes stage agent events (focus, capture, play) and applies them to
// the page state bridge so the UI reflects agent-driven selections and playback.
// Events are reversed to pick the *last* focus/capture in the batch — the most
// recent intent wins when multiple events target different objects.
function applyStageEvents(events: StageAgentEvent[] | undefined) {
  if (!events?.length) return;
  const state: Parameters<typeof applyDirectorPageEvent>[0]["state"] = {};
  const focus = [...events].reverse().find((event) => event.type === "focus" && event.objectId);
  const capture = [...events].reverse().find((event) => event.type === "capture" && event.objectId);
  if (focus?.objectId) state.selectedObjectIds = [focus.objectId];
  if (capture?.objectId) {
    state.selectedObjectIds = [capture.objectId];
  }
  if (events.some((event) => event.type === "play")) {
    state.activePanel = "timeline";
    state.playing = true;
  }
  if (!Object.keys(state).length) return;
  applyDirectorPageEvent({
    sequence: revision,
    sceneId: activeSceneId,
    revision,
    tabId: "local-gateway",
    createdAt: new Date().toISOString(),
    state,
  });
  if (capture?.objectId) useDirectorStore.getState().setActiveCamera(capture.objectId);
}

// Applies a stage scene received from the gateway (remote state sync).
// Uses JSON signature comparison to skip redundant applications — if the
// serialized scene hasn't changed, no store update or save is needed.
// Sets applyingRemote = true before the store update so the local subscription
// won't re-push the change back to the gateway; resets it in a microtask
// after the synchronous subscription handlers have fired.
function applyStageScene(scene: StageScene, events?: StageAgentEvent[]) {
  const signature = JSON.stringify(scene);
  latestStageScene = structuredClone(scene);
  if (signature !== lastAppliedStageSignature) {
    const director = useDirectorStore.getState();
    const nextProject = stageSceneToDirectorProject(scene, director.project, previousStageObjectIds);
    previousStageObjectIds = stageManagedDirectorObjectIds(scene);
    lastAppliedStageSignature = signature;
    applyingRemote = true;
    director.replaceProject(nextProject);
    director.setViewportAspectRatio(stageAspectToDirectorAspect(scene.recordAspect));
    const projectSnapshot = structuredClone(useDirectorStore.getState().project);
    queueMicrotask(() => {
      applyingRemote = false;
      void saveSceneProject(activeSceneId, projectSnapshot);
    });
    revision += 1;
    updateDirectorSessionRuntime({
      sceneId: activeSceneId,
      revision,
      dirty: false,
      conflict: null,
    });
  }
  applyStageEvents(events);
}

// Persists the project snapshot to the production backend with optimistic
// concurrency control. Each scene's saves are serialized through a promise
// chain to avoid races between concurrent autosave triggers.
//
// On the first save for a scene, a 404 from the server is expected and
// handled silently — it means no project exists yet and a create will follow.
// On a 409 conflict, the latest remote revision is fetched and used as the
// new base for the next save attempt, surfacing the conflict to the UI.
async function saveSceneProject(sceneId: string, project: DirectorProject) {
  const snapshot = structuredClone(project);
  const snapshotSignature = JSON.stringify(snapshot);
  const operation = sceneProjectSaveQueue.then(async () => {
    if (sceneProjectSignatures.get(sceneId) === snapshotSignature) return true;
    try {
      if (!sceneProjectRevisions.has(sceneId)) {
        try {
          const remote = await getDirectorProductionSceneProject(sceneId);
          const remoteSignature = JSON.stringify(remote.project);
          sceneProjectRevisions.set(sceneId, remote.revision);
          sceneProjectSignatures.set(sceneId, remoteSignature);
          if (remoteSignature === snapshotSignature) return true;
          if (sceneId === activeSceneId) {
            updateDirectorSessionRuntime({
              dirty: true,
              conflict: `远端修订 ${remote.revision}，正在核对`,
            });
          }
          return false;
        } catch (error) {
          if (!(error instanceof DirectorProductionClientError) || error.status !== 404) throw error;
        }
      }
      const expectedRevision = sceneProjectRevisions.get(sceneId) ?? 0;
      const saved = await saveDirectorProductionSceneProject({
        sceneId,
        expectedRevision,
        project: snapshot,
        actor: "director-browser:autosave",
      });
      sceneProjectRevisions.set(sceneId, saved.revision);
      sceneProjectSignatures.set(sceneId, snapshotSignature);
      return true;
    } catch (error) {
      if (error instanceof DirectorProductionClientError && error.status === 409) {
        try {
          const remote = await getDirectorProductionSceneProject(sceneId);
          sceneProjectRevisions.set(sceneId, remote.revision);
          const remoteSignature = JSON.stringify(remote.project);
          sceneProjectSignatures.set(sceneId, remoteSignature);
          if (remoteSignature === snapshotSignature) return true;
        } catch {
          // Keep the original revision conflict as the actionable error.
        }
      }
      if (sceneId === activeSceneId) {
        updateDirectorSessionRuntime({
          dirty: true,
          conflict: error instanceof Error ? error.message : "Scene project save failed",
        });
      }
      return false;
    }
  });
  sceneProjectSaveQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

// Pushes the current stage scene to the gateway API and concurrently
// persists the project snapshot. Both operations run in parallel because
// they are independent; if either fails, the session runtime is marked
// disconnected and dirty so the user knows the state is unsynchronized.
async function pushScene(scene: StageScene, sceneId: string, project: DirectorProject) {
  try {
    const [response, projectSaved] = await Promise.all([
      directorAgentFetch(`${GATEWAY_URL}/api/stage`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scene),
      }),
      saveSceneProject(sceneId, project),
    ]);
    if (!response.ok) throw new Error(`Gateway returned ${response.status}`);
    if (sceneId === activeSceneId && projectSaved) {
      updateDirectorSessionRuntime({ dirty: false, conflict: null });
    }
  } catch (error) {
    updateDirectorSessionRuntime({
      gateway: "disconnected",
      mcp: "disconnected",
      comfyui: "disconnected",
      codex: "unavailable",
      dirty: true,
      conflict: error instanceof Error ? error.message : "Agent Gateway unavailable",
    });
  }
}

// Debounces local project changes into a single push to the gateway.
// The 450ms delay balances responsiveness (the agent sees changes quickly)
// against batching (rapid drag/transform operations produce only one push).
// Each call resets the timer, so only the final state after a burst is sent.
function scheduleScenePush() {
  window.clearTimeout(saveTimer);
  revision += 1;
  updateDirectorSessionRuntime({
    sceneId: activeSceneId,
    revision,
    dirty: true,
  });
  saveTimer = window.setTimeout(() => {
    const director = useDirectorStore.getState();
    latestStageScene = directorProjectToStageScene(director.project, latestStageScene, director.viewportAspectRatio);
    lastAppliedStageSignature = JSON.stringify(latestStageScene);
    previousStageObjectIds = stageManagedDirectorObjectIds(latestStageScene);
    void pushScene(latestStageScene, activeSceneId, structuredClone(director.project));
  }, 450);
}

// Fallback preview capture: reads the raw stage canvas directly.
// Used when the comprehensive capture bridge is not mounted (e.g. during
// startup or in a lightweight host without the full capture pipeline).
function captureStagePreview() {
  const canvas = document.querySelector<HTMLCanvasElement>(
    ".director-canvas canvas, [data-testid='director-canvas'] canvas",
  );
  if (!canvas) return null;
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

// Resolves after two animation frames have completed.
// Two rAFs ensure the browser has painted at least once after a state change;
// a single rAF may fire before the compositor has flushed the new frame.
function afterTwoPaints() {
  return new Promise<void>((resolvePaint) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint()));
  });
}

// Captures a preview image after waiting for the viewport to finish painting.
// Uses the comprehensive capture bridge when available; falls back to the raw
// canvas when the bridge is not mounted (startup, lightweight host).
async function captureStagePreviewAfterPaint(cameraId?: string) {
  await afterTwoPaints();
  try {
    const [capture] = await requestViewportCapture({
      preset: "current",
      source: "camera-panel",
      ...(cameraId ? { cameraId } : {}),
    });
    return capture?.dataUrl ?? null;
  } catch {
    // The comprehensive capture bridge may not be mounted during startup or
    // in a lightweight host. Fall back to the raw stage canvas in that case.
    return captureStagePreview();
  }
}

// Offscreen camera-view render shared by the reconstruction and compare
// workbench modules: both score stage renders through this one capture bridge.
async function requestWorkbenchViewportCapture(
  captureRequest: CaptureViewportRequest,
  signal?: AbortSignal,
): Promise<string | null> {
  const [capture] = await requestViewportCapture({
    preset: "current",
    source: "camera-panel",
    cameraId: captureRequest.cameraId,
    frame: captureRequest.frame,
    width: captureRequest.width,
    height: captureRequest.height,
    signal,
    waitForHandlerMs: 2_000,
  });
  return capture?.dataUrl ?? null;
}

// Establishes (and re-establishes) the WebSocket connection to the Director Gateway.
// Flow: bootstrap → authenticate → open WebSocket → handle messages → reconnect on close.
//
// The message handler is the central dispatch for all gateway-to-browser communication:
// target binding, state sync, capture requests, and workbench/creative command execution.
// Each command handler validates the target binding before and after execution to ensure
// the response is not delivered to a stale target.
async function connectSocket() {
  if (disposed) return;
  updateConnection("connecting");
  setBoundDirectorBrowserTarget(null);
  let browserToken: string;
  try {
    browserToken = (await bootstrapDirectorAgent()).browserToken;
  } catch (error) {
    updateDirectorSessionRuntime({
      gateway: "disconnected",
      mcp: "disconnected",
      conflict: error instanceof Error ? error.message : "Agent Gateway bootstrap failed",
    });
    if (!disposed) reconnectTimer = window.setTimeout(() => void connectSocket(), 1500);
    return;
  }
  if (disposed) return;
  const authenticatedUrl = new URL(WS_URL);
  authenticatedUrl.searchParams.set("browser_token", browserToken);
  const connection = new WebSocket(authenticatedUrl);
  let opened = false;
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    opened = true;
    updateConnection("connected");
    announceWorkbenchPresence();
  });
  connection.addEventListener("message", (event) => {
    try {
      const rawMessage: unknown = JSON.parse(String(event.data));
      const parsedMessage = directorGatewayInboundMessageSchema.safeParse(rawMessage);
      if (!parsedMessage.success) {
        const envelope =
          rawMessage && typeof rawMessage === "object" && !Array.isArray(rawMessage)
            ? (rawMessage as Record<string, unknown>)
            : null;
        const messageType = typeof envelope?.type === "string" ? envelope.type : "unknown";
        const requestId = typeof envelope?.requestId === "string" ? `, requestId=${envelope.requestId}` : "";
        console.warn(
          `[director-gateway] Dropped a gateway message that failed strict validation (type=${messageType}${requestId}): ${contractIssueSummary(parsedMessage.error)}`,
        );
        return;
      }
      const message = parsedMessage.data;
      if (message.type === "target-bound") {
        const previousTarget = getBoundDirectorBrowserTarget();
        if (previousTarget && !sameDirectorAgentTarget(previousTarget, message.target)) {
          abortAllGatewayCommands("superseded");
        }
        if (
          socket === connection &&
          directorAgentTargetMatchesBrowserContext(message.target, {
            clientId: browserClientId,
            sceneId: activeSceneId,
            creativeScopeId: getDirectorCreativeWorkspaceScope(),
          })
        ) {
          setBoundDirectorBrowserTarget(message.target);
          updateDirectorSessionRuntime({ conflict: null });
        } else {
          setBoundDirectorBrowserTarget(null);
          updateDirectorSessionRuntime({
            conflict: "Gateway target binding did not match this browser scene; Agent commands are disabled.",
          });
        }
      }
      if (message.type === "state") {
        latestStageScene = structuredClone(message.scene);
        if (message.source !== "ui") applyStageScene(message.scene, message.events);
      }
      if (message.type === "capture-request") {
        void captureStagePreviewAfterPaint(message.cameraId).then((dataUrl) => {
          socket?.send(
            JSON.stringify({
              type: "capture-response",
              requestId: message.requestId,
              dataUrl,
            }),
          );
        });
      }
      if (message.type === "workbench-state") {
        applyingRemote = true;
        useDirectorStore.getState().replaceProject(message.project);
        latestStageScene = directorProjectToStageScene(
          message.project,
          latestStageScene,
          useDirectorStore.getState().viewportAspectRatio,
        );
        previousStageObjectIds = stageManagedDirectorObjectIds(latestStageScene);
        lastAppliedStageSignature = JSON.stringify(latestStageScene);
        queueMicrotask(() => {
          applyingRemote = false;
        });
      }
      if (message.type === "workbench-command-cancel") {
        abortCommand(workbenchCommandControllers, message.requestId, message.reason);
        return;
      }
      if (message.type === "possession-write-feedback") {
        announceDirectorPossessionFeedback({
          code: message.code === "possession_write_filled" ? undefined : message.code,
          possession: message.possession,
        });
        return;
      }
      if (message.type === "creative-workspace-command-cancel") {
        abortCommand(creativeCommandControllers, message.requestId, message.reason);
        return;
      }
      if (message.type === "creative-workspace-command-request") {
        if (!targetMatchesCurrentBrowser(message.target, connection)) {
          sendCreativeTargetFailure(
            connection,
            message.requestId,
            message.target,
            "Target binding changed before the Creative command started. Observe this browser scene again.",
          );
          return;
        }
        const commandController = new AbortController();
        creativeCommandControllers.set(message.requestId, commandController);
        void (async () => {
          try {
            if (commandController.signal.aborted) return;
            const result =
              message.input.op === "preview"
                ? await executeCreativeWorkspaceAgentPreviewRequest(message.input, undefined, commandController.signal)
                : message.input.op === "interchange" ||
                    message.input.op === "collaboration" ||
                    message.input.op === "pipeline"
                  ? await executeCreativeWorkspaceSemanticRequest(message.input, undefined, commandController.signal)
                  : message.input.op === "execute" &&
                      (message.input.operation.op === "media.relink" || message.input.operation.op === "media.verify")
                    ? {
                        op: "execute" as const,
                        execution: await executeCreativeWorkspaceAgentOperationAsync(
                          message.input.operation,
                          undefined,
                        ),
                      }
                    : executeCreativeWorkspaceAgentRequest(message.input);
            if (commandController.signal.aborted) return;
            const hasExecution = result.op === "execute" || result.op === "execute_batch";
            const hasPreview = result.op === "preview";
            const hasSemantic =
              result.op === "interchange" || result.op === "collaboration" || result.op === "pipeline";
            const success = hasExecution
              ? result.execution.success
              : hasPreview
                ? result.preview.success
                : hasSemantic
                  ? result.result.success
                  : true;
            const error =
              hasExecution && !result.execution.success
                ? result.execution.error
                : hasPreview && !result.preview.success
                  ? result.preview.error
                  : hasSemantic && !result.result.success
                    ? result.result.error
                    : undefined;
            const responseMessage = directorCreativeWorkspaceCommandResponseWireSchema.safeParse({
              type: "creative-workspace-command-response",
              requestId: message.requestId,
              target: message.target,
              success,
              result,
              ...(error ? { error } : {}),
            });
            if (commandController.signal.aborted) return;
            if (!targetMatchesCurrentBrowser(message.target, connection)) {
              sendCreativeTargetFailure(
                connection,
                message.requestId,
                message.target,
                "Target binding changed while the Creative command was running; its response was discarded.",
              );
            } else if (responseMessage.success) {
              connection.send(JSON.stringify(responseMessage.data));
            } else {
              console.error(
                "[director-gateway] Creative workspace response violated the shared gateway contract.",
                responseMessage.error.issues,
              );
              sendCreativeTargetFailure(
                connection,
                message.requestId,
                message.target,
                `Creative workspace produced a response that violated the shared gateway contract (${contractIssueSummary(responseMessage.error)}).`,
              );
            }
          } finally {
            creativeCommandControllers.delete(message.requestId);
          }
        })();
      }
      if (message.type === "workbench-command-request") {
        if (!targetMatchesCurrentBrowser(message.target, connection)) {
          sendWorkbenchTargetFailure(
            connection,
            message.requestId,
            message.target,
            "Target binding changed before the Workbench command started. Observe this browser scene again.",
          );
          return;
        }
        const commandController = new AbortController();
        workbenchCommandControllers.set(message.requestId, commandController);
        void (async () => {
          try {
            let execution: DirectorWorkbenchExecution;
            let captureDataUrl: string | undefined;
            let pendingSceneSwitch: DirectorProductionSceneSwitch | undefined;
            const executable = parseDirectorWorkbenchExecutableInput(message.input);
            if (!executable.success) {
              execution = { success: false, error: executable.error, result: { code: "invalid_request" } };
            } else if (message.input.op === "production") {
              const productionExecution = await executeDirectorProductionWorkbenchOperation(
                message.input,
                commandController.signal,
                {
                  getProduction: (signal) => getDirectorProduction("main", signal),
                  updateProduction: (expectedRevision, operations, requestKey, sceneSeeds, signal) =>
                    updateDirectorProduction(
                      "main",
                      expectedRevision,
                      operations,
                      "director-agent:production",
                      requestKey,
                      sceneSeeds,
                      signal,
                    ),
                  createScene: (input) =>
                    createDirectorProductionScene({
                      productionId: "main",
                      expectedRevision: input.expectedRevision,
                      sceneId: input.sceneId,
                      title: input.title,
                      sourceSceneId: input.sourceSceneId,
                      project: input.project,
                      activate: input.activate,
                      idempotencyKey: input.requestKey,
                      signal: input.signal,
                    }),
                  currentBrowserSceneId: () => activeSceneId,
                  currentSceneDocumentRevision: () => sceneProjectRevisions.get(activeSceneId) ?? null,
                  currentProject: () => useDirectorStore.getState().project,
                  createEmptyProject: () => createDefaultDirectorProject(),
                },
              );
              execution = productionExecution.execution;
              pendingSceneSwitch = productionExecution.switchScene;
            } else if (message.input.op === "generation") {
              execution = await executeDirectorGenerationWorkbenchCommand(
                message.input.command,
                commandController.signal,
              );
            } else if (message.input.op === "transcription") {
              execution = await executeDirectorTranscriptionWorkbenchCommand(
                message.input.command,
                commandController.signal,
              );
            } else if (message.input.op === "generated_3d") {
              execution = await executeDirectorGenerated3DWorkbenchCommand(
                message.input.command,
                commandController.signal,
                { scope: activeSceneId },
              );
            } else if (message.input.op === "reconstruction") {
              execution = await executeDirectorCaptureReconstructionWorkbenchCommand(
                message.input.command,
                commandController.signal,
                {
                  scope: activeSceneId,
                  dependencies: { requestCapture: requestWorkbenchViewportCapture },
                },
              );
            } else if (message.input.op === "compare") {
              execution = await executeDirectorCaptureCompareWorkbenchCommand(message.input, commandController.signal, {
                dependencies: { requestCapture: requestWorkbenchViewportCapture },
              });
            } else if (message.input.op === "storyboard_artifact") {
              execution = await executeDirectorStoryboardWorkbenchCommand(
                message.input.command,
                commandController.signal,
                { scope: activeSceneId },
              );
            } else if (executable.operation.op === "author" && executable.operation.evidence) {
              // Evidence-gated author: apply the authoring actions first, then
              // capture a clean camera frame at the authored revision so the
              // agent receives visual proof of what the edit produced. A failed
              // capture downgrades the evidence block, never the authoring result.
              const authorInput = executable.operation;
              execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), authorInput, {
                scope: activeSceneId,
              });
              const receipt =
                execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
                  ? (execution.result as Record<string, unknown>)
                  : null;
              if (execution.success && receipt) {
                const evidence = authorInput.evidence;
                if (!evidence) {
                  throw new Error("author evidence missing after evidence-gated author operation");
                }
                const revision =
                  typeof receipt.project_revision === "string"
                    ? receipt.project_revision
                    : getDirectorProjectRevision(useDirectorStore.getState().project);
                const captureCameraId =
                  evidence.camera_id ??
                  authorInput.camera_id ??
                  useDirectorStore.getState().project.activeCameraId ??
                  undefined;
                const frame = Math.max(
                  0,
                  Math.round(evidence.frame ?? useDirectorStore.getState().project.scene.timeline?.currentFrame ?? 0),
                );
                try {
                  const [capture] = await runWithDirectorProjectRevision(
                    revision,
                    ({ signal }) =>
                      requestViewportCapture({
                        preset: "current",
                        source: "camera-panel",
                        ...(captureCameraId ? { cameraId: captureCameraId } : {}),
                        frame,
                        renderPass: "clean",
                        cleanPlate: true,
                        width: evidence.width,
                        height: evidence.height,
                        ...(evidence.depth_of_field === undefined ? {} : { depthOfField: evidence.depth_of_field }),
                        signal,
                        waitForHandlerMs: 2_000,
                      }),
                    commandController.signal,
                  );
                  if (!capture) throw new Error("Viewport capture returned no image.");
                  captureDataUrl = capture.dataUrl;
                  execution = withStaleAfterCapture(
                    {
                      ...execution,
                      result: {
                        ...receipt,
                        evidence: {
                          kind: "camera_frame",
                          status: "captured",
                          camera_id: captureCameraId ?? null,
                          frame,
                          width: evidence.width,
                          height: evidence.height,
                          label: capture.label,
                          project_revision: revision,
                        },
                      },
                    },
                    revision,
                    getDirectorProjectRevision(useDirectorStore.getState().project),
                  );
                } catch (error) {
                  execution = {
                    ...execution,
                    result: {
                      ...receipt,
                      evidence: {
                        kind: "camera_frame",
                        status: "unavailable",
                        camera_id: captureCameraId ?? null,
                        frame,
                        width: evidence.width,
                        height: evidence.height,
                        project_revision: revision,
                        error: error instanceof Error ? error.message : String(error),
                      },
                    },
                  };
                }
              }
            } else if (message.input.op === "deliver") {
              // Deliver: run the readiness audit, and only when it reports
              // ready capture the full shot package as delivery proof. A
              // blocked audit returns `status: "blocked"` without capturing.
              const deliveryInput = message.input;
              execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), deliveryInput, {
                scope: activeSceneId,
              });
              const receipt =
                execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
                  ? (execution.result as Record<string, unknown>)
                  : null;
              if (execution.success && receipt?.ready === true) {
                try {
                  const revision =
                    deliveryInput.expected_revision ?? getDirectorProjectRevision(useDirectorStore.getState().project);
                  const captured = await runWithDirectorProjectRevision(
                    revision,
                    ({ project, signal }) =>
                      captureDirectorShotPackage(
                        project,
                        {
                          cameraId: deliveryInput.camera_id,
                          takeId: deliveryInput.take_id,
                          coverageShotId: deliveryInput.coverage_shot_id,
                          frame: deliveryInput.frame,
                          width: deliveryInput.width,
                          height: deliveryInput.height,
                          renderPasses: deliveryInput.render_passes,
                          includeDepthExr: deliveryInput.include_depth_exr,
                        },
                        (request) => requestViewportCapture({ ...request, signal, waitForHandlerMs: 2_000 }),
                      ),
                    commandController.signal,
                  );
                  captureDataUrl = captured.files.find((file) => file.renderPass === "clean")?.dataUrl;
                  execution = withStaleAfterCapture(
                    {
                      ...execution,
                      result: {
                        ...receipt,
                        ready: true,
                        status: "delivered",
                        capture_verified: true,
                        delivery: {
                          package_fingerprint: captured.manifest.packageFingerprint,
                          shot_revision_fingerprint: captured.manifest.shotRevisionFingerprint,
                          manifest: captured.manifest,
                          files: captured.files.map(({ dataUrl: _dataUrl, ...file }) => file),
                        },
                      },
                    },
                    revision,
                    getDirectorProjectRevision(useDirectorStore.getState().project),
                  );
                } catch (error) {
                  execution = directorWorkbenchDeliveryFailure(
                    error,
                    receipt,
                    getDirectorProjectRevision(useDirectorStore.getState().project),
                  );
                }
              } else if (execution.success && receipt) {
                execution = {
                  ...execution,
                  result: { ...receipt, ready: false, status: "blocked", capture_verified: false },
                };
              }
            } else if (message.input.op === "capture" || message.input.op === "shot_package") {
              // Pure evidence captures: single frame or multi-pass shot
              // package, both revision-bound, both echoing before/after
              // project revisions so the agent can detect concurrent edits.
              const captureInput = message.input;
              const projectRevisionBefore = getDirectorProjectRevision(useDirectorStore.getState().project);
              try {
                if (captureInput.op === "capture") {
                  const revision =
                    captureInput.expected_revision ?? getDirectorProjectRevision(useDirectorStore.getState().project);
                  // A naive caller may omit camera_id; the active project camera
                  // is the deterministic default for agent evidence captures.
                  const captureCameraId =
                    captureInput.camera_id ?? useDirectorStore.getState().project.activeCameraId ?? undefined;
                  const [capture] = await runWithDirectorProjectRevision(
                    revision,
                    ({ signal }) =>
                      requestViewportCapture({
                        preset: "current",
                        source: "camera-panel",
                        ...(captureCameraId ? { cameraId: captureCameraId } : {}),
                        ...(captureInput.frame === undefined ? {} : { frame: captureInput.frame }),
                        ...(captureInput.render_pass ? { renderPass: captureInput.render_pass } : {}),
                        ...(captureInput.depth_of_field === undefined
                          ? {}
                          : { depthOfField: captureInput.depth_of_field }),
                        ...(captureInput.clean_plate === undefined
                          ? captureInput.render_pass
                            ? { cleanPlate: true }
                            : {}
                          : { cleanPlate: captureInput.clean_plate }),
                        ...(captureInput.width === undefined
                          ? {}
                          : { width: captureInput.width, height: captureInput.height! }),
                        signal,
                        waitForHandlerMs: 2_000,
                      }),
                    commandController.signal,
                  );
                  captureDataUrl = capture?.dataUrl;
                  execution = capture
                    ? withStaleAfterCapture(
                        { success: true, result: { label: capture.label, meta: capture.meta } },
                        revision,
                        getDirectorProjectRevision(useDirectorStore.getState().project),
                      )
                    : { success: false, error: "Viewport capture returned no image." };
                } else {
                  const revision =
                    captureInput.expected_revision ?? getDirectorProjectRevision(useDirectorStore.getState().project);
                  const captured = await runWithDirectorProjectRevision(
                    revision,
                    ({ project, signal }) =>
                      captureDirectorShotPackage(
                        project,
                        {
                          cameraId: captureInput.camera_id,
                          takeId: captureInput.take_id,
                          coverageShotId: captureInput.coverage_shot_id,
                          frame: captureInput.frame,
                          width: captureInput.width,
                          height: captureInput.height,
                          renderPasses: captureInput.render_passes,
                          includeDepthExr: captureInput.include_depth_exr,
                        },
                        (request) => requestViewportCapture({ ...request, signal, waitForHandlerMs: 2_000 }),
                      ),
                    commandController.signal,
                  );
                  // Only a clean plate may replace the gateway's latest visual preview.
                  // Technical passes stay in their package paths and never become UI thumbnails.
                  captureDataUrl = captured.files.find((file) => file.renderPass === "clean")?.dataUrl;
                  execution = withStaleAfterCapture(
                    {
                      success: true,
                      result: {
                        manifest: captured.manifest,
                        files: captured.files.map(({ dataUrl: _dataUrl, ...file }) => file),
                      },
                    },
                    revision,
                    getDirectorProjectRevision(useDirectorStore.getState().project),
                  );
                }
              } catch (error) {
                execution = directorWorkbenchCaptureFailure(error);
              }
              const projectRevision = getDirectorProjectRevision(useDirectorStore.getState().project);
              const captureResult =
                execution.result && typeof execution.result === "object" && !Array.isArray(execution.result)
                  ? (execution.result as Record<string, unknown>)
                  : { value: execution.result ?? null };
              execution = {
                ...execution,
                result: {
                  ...captureResult,
                  project_revision_before: projectRevisionBefore,
                  project_revision: projectRevision,
                },
              };
            } else if (
              executable.operation.op === "player" ||
              executable.operation.op === "pilot" ||
              executable.operation.op === "game_playtest"
            ) {
              execution = await executeDirectorSessionWorkbenchOperation(executable.operation);
            } else {
              execution = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), executable.operation, {
                scope: activeSceneId,
              });
            }
            if (commandController.signal.aborted) return;
            const state = useDirectorStore.getState();
            latestStageScene = directorProjectToStageScene(state.project, latestStageScene, state.viewportAspectRatio);
            previousStageObjectIds = stageManagedDirectorObjectIds(latestStageScene);
            lastAppliedStageSignature = JSON.stringify(latestStageScene);
            const projectChanged =
              message.input.op === "patch" ||
              message.input.op === "author" ||
              message.input.op === "run_macro" ||
              message.input.op === "correct" ||
              message.input.op === "replace_project" ||
              message.input.op === "undo" ||
              (message.input.op === "generated_3d" && message.input.command.action === "promote") ||
              (message.input.op === "reconstruction" && message.input.command.action === "apply");
            const storyboardArtifactChanged =
              message.input.op === "storyboard_artifact" &&
              (message.input.command.action === "capture_thumbnail" ||
                message.input.command.action === "capture_missing");
            const responseMessage = directorWorkbenchCommandResponseWireSchema.safeParse({
              type: "workbench-command-response",
              requestId: message.requestId,
              target: message.target,
              success: execution.success,
              ...(execution.result !== undefined ? { result: execution.result } : {}),
              ...(execution.error ? { error: execution.error } : {}),
              stageScene: latestStageScene,
              ...((projectChanged || storyboardArtifactChanged) && execution.success ? { project: state.project } : {}),
              ...(captureDataUrl ? { captureDataUrl } : {}),
            });
            if (commandController.signal.aborted) return;
            if (!targetMatchesCurrentBrowser(message.target, connection)) {
              sendWorkbenchTargetFailure(
                connection,
                message.requestId,
                message.target,
                "Target binding changed while the Workbench command was running; its response was discarded.",
              );
            } else if (responseMessage.success) {
              connection.send(JSON.stringify(responseMessage.data));
              if (pendingSceneSwitch) {
                const sceneSwitch = pendingSceneSwitch;
                window.setTimeout(() => {
                  window.postMessage(
                    {
                      type: "storyai:director-desk-switch-scene",
                      payload: {
                        sceneId: sceneSwitch.sceneId,
                        activationId: sceneSwitch.activationId,
                        ...(sceneSwitch.seedProject ? { project: sceneSwitch.seedProject } : {}),
                      },
                    },
                    window.location.origin,
                  );
                }, 0);
              }
            } else {
              console.error(
                "[director-gateway] Workbench response violated the shared gateway contract.",
                responseMessage.error.issues,
              );
              sendWorkbenchTargetFailure(
                connection,
                message.requestId,
                message.target,
                `Workbench produced a response that violated the shared gateway contract (${contractIssueSummary(responseMessage.error)}).`,
              );
            }
          } finally {
            workbenchCommandControllers.delete(message.requestId);
          }
        })();
      }
    } catch {
      // Silently ignore messages that can't be parsed as JSON or that don't
      // match the expected envelope shape. This handles noise from unrelated
      // WebSocket clients that may share the same endpoint.
    }
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) return;
    if (!opened) clearDirectorAgentClient();
    abortAllGatewayCommands("target_unavailable");
    setBoundDirectorBrowserTarget(null);
    if (disposed) return;
    updateConnection("disconnected");
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => void connectSocket(), 1500);
  });
  connection.addEventListener("error", () => connection.close());
}

/**
 * Invokes an agent tool through the Director Gateway HTTP API.
 *
 * For targeted tools ({@link director_workbench}, {@link director_creative}), the
 * call requires an active browser target binding and validates the response target
 * matches before returning. For non-targeted stage tools, the returned scene is
 * applied to the local store automatically.
 *
 * @param tool - The agent tool to invoke.
 * @param input - The tool-specific input payload.
 * @param sessionId - The agent session identifier (defaults to `"browser-ui"`).
 * @returns The tool execution result, including any scene updates.
 * @throws If the gateway returns an error or the response target does not match.
 */
export async function runRemoteTool(
  tool: AgentToolName,
  input: unknown,
  sessionId = "browser-ui",
): Promise<ToolExecution> {
  const isTargetedTool = tool === "director_workbench" || tool === "director_creative";
  const requestTarget = isTargetedTool ? requireBoundAgentTarget() : null;
  const response = await directorAgentFetch(`${GATEWAY_URL}/api/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createGatewayToolRequestEnvelope(tool, input, sessionId, requestTarget)),
  });
  const execution = (await response.json()) as ToolExecution & {
    code?: string;
    target?: DirectorAgentTargetWire;
    possession?: unknown;
  };
  if (execution.possession !== undefined) {
    announceDirectorPossessionFeedback({
      code: execution.code,
      possession: execution.possession,
    });
  }
  if (!response.ok) {
    if (
      requestTarget &&
      execution.code === "target_unavailable" &&
      sameDirectorAgentTarget(getBoundDirectorBrowserTarget(), requestTarget)
    ) {
      setBoundDirectorBrowserTarget(null);
    }
    throw new Error(execution.error ?? `Gateway returned ${response.status}`);
  }
  if (
    requestTarget &&
    (!targetMatchesCurrentBrowser(requestTarget) || !sameDirectorAgentTarget(execution.target, requestTarget))
  ) {
    throw new Error("Gateway response target did not match this browser scene; the response was discarded.");
  }
  if (execution.success && tool !== "director_workbench" && tool !== "director_creative" && tool !== "stage_video")
    applyStageScene(execution.scene, execution.events);
  return execution;
}

/**
 * Initializes the Director Gateway client for this browser tab.
 *
 * Sets up the WebSocket connection, subscribes to local store changes for
 * automatic scene push, listens for scene-switch messages from the host frame,
 * and exposes the {@link window.stageAgent} convenience API. Returns a dispose
 * function that tears down all subscriptions, timers, and the socket connection.
 *
 * @returns A cleanup function that disposes the gateway client.
 */
export function initializeGateway() {
  disposed = false;
  activeSceneId = LOCAL_SCENE_ID;
  sceneSwitchSequence += 1;
  sceneProjectRevisions.clear();
  sceneProjectSignatures.clear();
  setDirectorCreativeWorkspaceScope(activeSceneId);
  setBoundDirectorBrowserTarget(null);
  updateDirectorSessionRuntime({
    sceneId: activeSceneId,
    revision,
    dirty: false,
    conflict: null,
  });
  const reportSceneSwitch = (
    type: "storyai:director-desk-scene-switch-ready" | "storyai:director-desk-scene-switch-failed",
    payload: Record<string, unknown>,
  ) => {
    window.parent?.postMessage({ type, payload }, window.location.origin);
  };
  // Scene switches arrive as window messages (from the host desk frame or the
  // production workbench's post-response hop). The handler saves dirty state,
  // loads or seeds the target scene project, rebinds the creative scope, and
  // reports ready/failed back to the host — all guarded by sceneSwitchSequence
  // so a slower, superseded switch can never clobber a newer one.
  const handleSceneSwitch = (event: MessageEvent) => {
    if (
      event.origin !== window.location.origin ||
      event.source !== window ||
      event.data?.type !== "storyai:director-desk-switch-scene"
    )
      return;
    const nextSceneId = typeof event.data.payload?.sceneId === "string" ? event.data.payload.sceneId.trim() : "";
    if (!nextSceneId) return;
    const activationId =
      typeof event.data.payload?.activationId === "string" && event.data.payload.activationId.trim()
        ? event.data.payload.activationId.trim()
        : `director-activation-ui:${crypto.randomUUID()}`;
    const seededProject = safeParseDirectorProject(event.data.payload?.project);
    const switchRequest = ++sceneSwitchSequence;

    void (async () => {
      try {
        if (nextSceneId === activeSceneId) {
          reportSceneSwitch("storyai:director-desk-scene-switch-ready", {
            activationId,
            sceneId: nextSceneId,
            sceneProjectRevision: sceneProjectRevisions.get(nextSceneId) ?? null,
          });
          return;
        }

        window.clearTimeout(saveTimer);
        if (getDirectorSessionRuntime().dirty) {
          await saveSceneProject(activeSceneId, useDirectorStore.getState().project);
        }

        let remoteProject: DirectorProject | null = null;
        let remoteRevision: number | null = null;
        try {
          const remote = await getDirectorProductionSceneProject(nextSceneId);
          remoteProject = remote.project;
          remoteRevision = remote.revision;
        } catch (error) {
          if (!(error instanceof DirectorProductionClientError) || error.status !== 404) throw error;
        }
        if (switchRequest !== sceneSwitchSequence || disposed) return;

        abortAllGatewayCommands("superseded");
        setBoundDirectorBrowserTarget(null);
        activeSceneId = nextSceneId;
        setDirectorCreativeWorkspaceScope(nextSceneId);
        applyingRemote = true;
        useDirectorStore.getState().openScopedScene(nextSceneId);
        if (remoteProject) useDirectorStore.getState().replaceProject(remoteProject);
        else if (seededProject.success) useDirectorStore.getState().replaceProject(seededProject.project);
        const loadedProject = useDirectorStore.getState().project;
        if (remoteProject && remoteRevision !== null) {
          sceneProjectRevisions.set(nextSceneId, remoteRevision);
          sceneProjectSignatures.set(nextSceneId, JSON.stringify(remoteProject));
        } else {
          const bootstrapped = await saveSceneProject(nextSceneId, loadedProject);
          if (!bootstrapped) throw new Error(`Unable to initialize persisted project for scene "${nextSceneId}".`);
        }
        if (switchRequest !== sceneSwitchSequence || disposed) return;

        latestStageScene = directorProjectToStageScene(
          loadedProject,
          latestStageScene,
          useDirectorStore.getState().viewportAspectRatio,
        );
        previousStageObjectIds = stageManagedDirectorObjectIds(latestStageScene);
        lastAppliedStageSignature = JSON.stringify(latestStageScene);
        revision += 1;
        updateDirectorSessionRuntime({
          instanceId: nextSceneId,
          sceneId: nextSceneId,
          revision,
          dirty: false,
          conflict: null,
        });
        applyingRemote = false;
        await pushScene(latestStageScene, nextSceneId, structuredClone(loadedProject));
        if (switchRequest !== sceneSwitchSequence || disposed) return;
        announceWorkbenchPresence();
        await afterTwoPaints();
        reportSceneSwitch("storyai:director-desk-scene-switch-ready", {
          activationId,
          sceneId: nextSceneId,
          sceneProjectRevision: sceneProjectRevisions.get(nextSceneId) ?? null,
          browserTargetPending: true,
        });
      } catch (error) {
        applyingRemote = false;
        if (switchRequest !== sceneSwitchSequence || disposed) return;
        const message = error instanceof Error ? error.message : "Scene switch failed";
        updateDirectorSessionRuntime({ dirty: true, conflict: message });
        reportSceneSwitch("storyai:director-desk-scene-switch-failed", {
          activationId,
          sceneId: nextSceneId,
          message,
        });
      }
    })();
  };
  const announceVisibility = () => {
    announceWorkbenchPresence();
  };
  let observedCreativeScope = getDirectorCreativeWorkspaceScope();
  window.addEventListener("message", handleSceneSwitch);
  document.addEventListener("visibilitychange", announceVisibility);
  const unsubscribeDirectorStore = useDirectorStore.subscribe((state, previous) => {
    if (
      !applyingRemote &&
      (state.project !== previous.project || state.viewportAspectRatio !== previous.viewportAspectRatio)
    ) {
      scheduleScenePush();
    }
  });
  const unsubscribeWorkspace = useDirectorCreativeWorkspaceStore.subscribe((state, previous) => {
    if (state.mode !== previous.mode && getDirectorCreativeWorkspaceScope() === observedCreativeScope) {
      announceWorkbenchPresence();
    }
  });
  const unsubscribeWorkspaceScope = subscribeDirectorCreativeWorkspaceScope((scopeId) => {
    observedCreativeScope = scopeId;
    if (getBoundDirectorBrowserTarget()) abortAllGatewayCommands("superseded");
    setBoundDirectorBrowserTarget(null);
    announceWorkbenchPresence();
  });
  const unsubscribeCaptureReadiness = subscribeViewportCaptureReadiness(announceWorkbenchPresence);
  void connectSocket();

  window.stageAgent = {
    run: runRemoteTool,
    read: (input) => runRemoteTool("stage_read", input),
    scene: (input) => runRemoteTool("stage_scene", input),
    object: (input) => runRemoteTool("stage_object", input),
    camera: (input) => runRemoteTool("stage_camera", input),
    show: (input) => runRemoteTool("stage_show", input),
    video: (input) => runRemoteTool("stage_video", input),
    workbench: (input) => runRemoteTool("director_workbench", input),
    creative: (input) => runRemoteTool("director_creative", input),
    getState: () =>
      directorProjectToStageScene(
        useDirectorStore.getState().project,
        latestStageScene,
        useDirectorStore.getState().viewportAspectRatio,
      ),
  };

  return () => {
    disposed = true;
    sceneSwitchSequence += 1;
    window.removeEventListener("message", handleSceneSwitch);
    document.removeEventListener("visibilitychange", announceVisibility);
    unsubscribeDirectorStore();
    unsubscribeWorkspace();
    unsubscribeWorkspaceScope();
    unsubscribeCaptureReadiness();
    window.clearTimeout(saveTimer);
    window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
    setBoundDirectorBrowserTarget(null);
    delete window.stageAgent;
    updateConnection("disconnected");
  };
}

/**
 * Returns the current scene revision number for this browser tab.
 *
 * Prefers the session runtime's stored revision; falls back to the local
 * module-level counter when the runtime hasn't been initialized yet.
 *
 * @returns The current scene revision.
 */
export function getGatewaySceneRevision() {
  return getDirectorSessionRuntime().revision ?? revision;
}

declare global {
  interface Window {
    /**
     * Convenience API for invoking Director Agent tools directly from the
     * browser console. Exposed by {@link initializeGateway} and removed on dispose.
     *
     * Each shorthand method delegates to {@link runRemoteTool} with the
     * corresponding tool name.
     */
    stageAgent?: {
      /** Invoke any agent tool by name. */
      run: (tool: AgentToolName, input: unknown, sessionId?: string) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"stage_read"`. */
      read: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"stage_scene"`. */
      scene: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"stage_object"`. */
      object: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"stage_camera"`. */
      camera: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"stage_show"`. */
      show: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"stage_video"`. */
      video: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"director_workbench"`. */
      workbench: (input: unknown) => Promise<ToolExecution>;
      /** Shorthand for {@link runRemoteTool} with `"director_creative"`. */
      creative: (input: unknown) => Promise<ToolExecution>;
      /** Returns the current stage scene snapshot without invoking a tool. */
      getState: () => StageScene;
    };
  }
}
