import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import agentPlanSchema from "./agentPlanSchema.json";
import { writeJsonAtomic } from "./atomicJsonFile";
import { validateDirectorAgentPlan, type DirectorAgentId, type DirectorAgentPlan } from "@director/agent-engine";
import { executeStageTool } from "@director/agent-engine";
import {
  creativeWorkspaceAgentRequestSchema,
  type CreativeWorkspaceAgentRequest,
} from "../../packages/protocol/src/creativeWorkspaceProtocol";
import { buildPlannerPrompt } from "./plannerPrompt";
import {
  parseDirectorWorkbenchInput,
  type DirectorWorkbenchObserveField,
  type DirectorWorkbenchOperation,
} from "@director/agent-engine";
import type { AgentBoundaryReceipt, DirectorAgentTarget, StageCapturePayload } from "@director/agent-engine";
import { parseStageScene } from "@director/stage-protocol";
import { loadStageSceneWithRecovery } from "./stageSceneFile";
import {
  directorAgentBootstrapWireSchema,
  directorAgentHealthWireSchema,
  sameDirectorAgentTarget,
} from "../../packages/protocol/src/agentGatewayProtocol";
import { asRecord } from "../../packages/protocol/src/primitives";
import { safeParseDirectorProject, type DirectorProject } from "@director/project-schema";
import { DIRECTOR_WORKBENCH_CONTRACT_FINGERPRINT } from "@director/agent-engine";
import { blenderNativeToolRequestInputSchema } from "../../packages/protocol/src/blenderLiveProtocol";
import type { StageScene } from "@director/stage-protocol";
import {
  terminalMessageSchema,
  type AssistantApplyRequest,
  type AssistantPlanRequest,
  type ProductionRecord,
  type TerminalMessage,
} from "./gatewaySchemas";
import { parseCaptureDataUrl } from "./capturePayload";
import { AgentPlanStore } from "./agentPlanStore";
import {
  applyObservedAgentGuard,
  isCreativeMutation,
  isWorkbenchDurableJobMutation,
  isWorkbenchMutation,
  listAgentSessionTargets,
  prepareAgentDurableJobMutation,
  prepareAgentMutation,
  recallAgentSessionTarget,
  rememberAgentSessionTarget,
  type PreparedMutation,
} from "./agentNaiveBoundary";
import { buildAutomaticDeliveryOperation } from "./agentPlanDelivery";
import { BrowserCommandTimeoutError, isBrowserCommandTimeoutError } from "./browserCommandTimeout";
import { requestFromBrowserClients } from "./browserClientDiscovery";
import {
  authenticatedDirectorPreviewUrl,
  createDirectorGatewaySecret,
  createDirectorPreviewSecret,
  directorAllowedOrigins,
  directorGatewayRequestAuthorized,
  directorGatewayTokenMatches,
  requestDirectorGatewayToken,
  requiresDirectorGatewayAuth,
  trustedDirectorOrigin,
} from "./gatewayAuth";
import { BoundedTextBuffer } from "./boundedTextBuffer";
import { reportPlannerFailure, reportPlannerInvalidOutput, reportPlannerOutputLimit } from "./plannerFailure";
import { reportGatewayInternalFailure } from "./gatewayHttpError";
import { SPAWN_IN_OWN_PROCESS_GROUP, terminateChildProcess } from "./processTermination";
import { RefSessionRegistry } from "./refSessions";
import {
  createPlannerRetryMessage,
  decodeClaudePlannerOutput,
  decodePlannerDraft,
  DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION,
} from "./plannerDraft";
import { handleAssistantRoute } from "./routes/assistantRoutes";
import { createBlenderBridge } from "./dcc/blenderBridge";
import { createBlenderReturnImporter, createDccReturnImporter } from "./dcc/blenderReturnImport";
import { createBlenderSceneImporter } from "./dcc/blenderSceneImport";
import { createDirectorDccEngineBridge } from "./dcc/engineBridge";
import { createEngineSceneImporter } from "./dcc/engineSceneImport";
import { createGodotLiveLinkHub } from "./dcc/godotLiveLink";
import { handleDccRoute } from "./routes/dccRoutes";
import { createDirectorDccProviderRegistry, registerConfiguredDirectorDccProviders } from "./dcc/dccProviderRegistry";
import { createUnityLiveLinkHub } from "./dcc/unityLiveLink";
import { createDirectorDccExchangePackager } from "./dcc/dccExchangePackage";
import { createBlenderNativeSession, BlenderNativeSessionError } from "./dcc/blenderNativeSession";
import { bindBlenderNativeSessionProject, executeBlenderNativeTool } from "./dcc/blenderNativeTool";
import { handleBlenderLiveRoute } from "./routes/blenderLiveRoutes";
import { handleProductionRoute } from "./routes/productionRoutes";
import { handleStageRoute, type StageRouteDependencies } from "./routes/stageRoutes";
import { TerminalSessionManager } from "./terminalSessionManager";
import {
  rankUntargetedWorkbenchClients,
  type DirectorBrowserWorkspace,
  type WorkbenchRoutingOperation,
} from "./workbenchClientRouting";
import { createCollaborationRuntime } from "./collaboration/collaborationRuntime";
import { handleCollaborationInviteRoute } from "./routes/collaborationInviteRoutes";
import { handleCollaborationRoomRoute } from "./routes/collaborationRoomRoutes";
import { loadDirectorControlPlaneConfig, type HostedAgentProfileConfig } from "./controlPlane/controlPlaneConfig";
import { AgentProfileRegistry } from "./agents/agentProfileRegistry";
import { probeLocalAgentCliAvailability } from "./agents/localAgentCliAvailability";
import {
  AgentApiProviderStore,
  expandAgentApiProvidersToHostedProfiles,
  mergeHostedAgentProfiles,
} from "./agents/agentApiProviderStore";
import { handleAgentApiProviderRoute } from "./routes/agentApiProviderRoutes";
import { AgentWorkspaceStore } from "./agents/agentWorkspaceStore";
import { handleAgentWorkspaceRoute } from "./routes/agentWorkspaceRoutes";
import { MultiAgentRunStore } from "./multiAgent/multiAgentRunStore";
import { ProductionRunOrchestrator } from "./multiAgent/productionRunOrchestrator";
import { HostedProductionAgentRunner } from "./multiAgent/hostedProductionAgentRunner";
import { handleMultiAgentRunRoute } from "./routes/multiAgentRunRoutes";
import { createFilmPipeline } from "./film/createFilmPipeline";
import { handleFilmPipelineRoute } from "./routes/filmPipelineRoutes";
import { createDirectorGame } from "./game/createDirectorGame";
import { createLiveStagePlaytestRunner } from "./game/liveStagePlaytest";
import { handleGameRoute } from "./routes/gameRoutes";
import { createVideoGenerationService } from "./video/createVideoGenerationService";
import { handleControlPlaneRoute } from "./routes/controlPlaneRoutes";
import { handleProductionJobRoute } from "./routes/productionJobRoutes";
import { ProductionJobStore } from "./jobs/productionJobStore";
import { ProductionArtifactStore } from "./artifacts/productionArtifactStore";
import { handleProductionArtifactRoute } from "./routes/productionArtifactRoutes";
import { createArtifactStorageBackend } from "./media/artifactStorage";
import { resolveArtifactRetentionPolicy } from "./media/artifactRetentionPolicy";
import { StorageOpsService } from "./media/storageOpsService";
import { handleStorageOpsRoute } from "./routes/storageOpsRoutes";
import { AgentToolAuditStore } from "./agentToolAuditStore";
import { AgentConfirmTokenStore } from "./agentConfirmTokenStore";
import { handleAgentToolAuditRoute } from "./routes/agentToolAuditRoutes";
import { handleAgentConfirmTokenRoute } from "./routes/agentConfirmTokenRoutes";
import { handleGeneratedAssetRoute } from "./routes/generatedAssetRoutes";
import { handleGenerationRoute } from "./routes/generationRoutes";
import { createComfyGenerationRuntime } from "./generation/createComfyGenerationRuntime";
import { createAssetSizeEstimator, createImagePromptExpander } from "./promptExpansion/createPromptExpanders";
import { createGenerated3DRuntime } from "./generation/createGenerated3DRuntime";
import { reconcileOutcomeUnknownJobs } from "./generation/startupReconciliation";
import { handleGenerated3DRoute } from "./routes/generated3dRoutes";
import { handleAssetSizeRoute } from "./routes/assetSizeRoutes";
import { ProductionMutationCoordinator } from "./production/productionMutationCoordinator";
import { ProductionStateStore } from "./production/productionStateStore";
import { createReferenceSceneAnalyzer } from "./reconstruction/referenceSceneAnalyzer";
import { handleReferenceSceneRoute } from "./routes/referenceSceneRoutes";
import { createMediaTranscriptionRuntime } from "./transcription/createMediaTranscriptionRuntime";
import { createMediaTranscodeRuntime } from "./media/createMediaTranscodeRuntime";
import { createCaptureReconstructionRuntime } from "./reconstruction/createCaptureReconstructionRuntime";
import { handleCaptureReconstructionRoute } from "./routes/captureReconstructionRoutes";
import { handleMediaTranscriptionRoute } from "./routes/mediaTranscriptionRoutes";
import { ArdyMotionService } from "./motion/ardyMotionService";
import { handleMotionGenerationRoute } from "./routes/motionGenerationRoutes";
import { handleSceneGenerationRoute } from "./routes/sceneGenerationRoutes";
import { registerBuiltinProviders, resolveModelProvider } from "./agents/modelProviderIntegration";
import { DirectorAgentTargetScheduler } from "./agents/agentToolScheduler";
import { AgentTraceStore } from "./agents/agentTraceStore";
import { handleAgentTraceRoute } from "./routes/agentTraceRoutes";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const controlPlaneConfig = loadDirectorControlPlaneConfig(root);
const dataDirectory = controlPlaneConfig.dataDirectory;
const scenePath = resolve(dataDirectory, "stage-scene.json");
const previewPath = resolve(dataDirectory, "latest-preview.png");
const productionManifestPath = resolve(dataDirectory, "director-production.json");
const productionStatePath = resolve(dataDirectory, "director-production-state.json");
const agentPlanSchemaPath = resolve(dataDirectory, "director-agent-plan.schema.json");
const workbenchProjectPath = resolve(dataDirectory, "director-workbench.json");
const generatedAssetRoot = resolve(root, "assets", "generated");
const port = controlPlaneConfig.http.port;
const host = controlPlaneConfig.http.host;
const gatewaySecret = createDirectorGatewaySecret();
const previewSecret = createDirectorPreviewSecret();
const gatewayEpoch = crypto.randomUUID();
const allowedBrowserOrigins = directorAllowedOrigins();
const responseCorsOrigins = new WeakMap<ServerResponse, string>();
// Child Agent/MCP processes inherit the same process-epoch capability.
process.env.DIRECTOR_GATEWAY_TOKEN = gatewaySecret;
const refSessions = new RefSessionRegistry();
const clients = new Set<WebSocket>();
const captureWaiters = new Map<string, (dataUrl: string | null) => void>();
/**
 * Live registration of a connected Director browser tab, maintained per-WebSocket
 * and updated on every `hello` message. The {@link targetToken} is the stable
 * process-epoch identity that agent bindings use to survive Vite HMR reloads and
 * transient reconnects.
 */
type WorkbenchClientRegistration = {
  /** Whether the browser tab is currently visible (not hidden/minimized). */
  visible: boolean;
  /** Epoch timestamp of the last received message from this tab. */
  lastSeenAt: number;
  /** Stable process-epoch token that persists across reconnects for the same tab identity. */
  targetToken: string;
  /** Client-side identifier, stable across reloads of the same tab. */
  clientId: string;
  /** Browser instance identifier, unique per browser process. */
  instanceId: string;
  /** Scene identifier the tab is scoped to. */
  sceneId: string;
  /** Creative workspace scope identifier for Canvas/Video tabs. */
  creativeScopeId: string;
  /** Protocol contract version negotiated by the tab. */
  contractVersion: 2;
  /** Which Director workspace the tab is currently displaying. */
  workspace: DirectorBrowserWorkspace;
  /** Whether the tab is ready to serve capture requests from the Stage workspace. */
  captureReady: boolean;
  /** True when the tab's bundled contract fingerprint mismatches this gateway. */
  contractStale: boolean;
};
const workbenchClients = new Map<WebSocket, WorkbenchClientRegistration>();
// Target tokens stay stable for a tab identity across websocket reconnects
// (Vite HMR reloads, transient drops) so agent bindings survive within one
// gateway process epoch. Keyed by the identity fields the token attests to.
const workbenchIdentityTokens = new Map<string, string>();

/**
 * Produces a stable compound key from the tab identity fields so the same tab
 * can recover its process-epoch target token across WebSocket reconnects.
 *
 * @param identity - The identity fields from a browser `hello` message.
 * @returns A NUL-delimited composite key for the {@link workbenchIdentityTokens} map.
 */
function workbenchIdentityKey(identity: {
  client_id: string;
  instance_id: string;
  scene_id: string;
  creative_scope_id: string;
  contract_version: number;
}) {
  return [
    identity.client_id,
    identity.instance_id,
    identity.scene_id,
    identity.creative_scope_id,
    String(identity.contract_version),
  ].join("\u0000");
}
/** Terminal message shape for a Director workbench command response from a browser tab. */
type WorkbenchCommandResponse = Extract<TerminalMessage, { type: "workbench-command-response" }>;
/** Terminal message shape for a Canvas/Video creative workspace command response from a browser tab. */
type CreativeWorkspaceCommandResponse = Extract<TerminalMessage, { type: "creative-workspace-command-response" }>;
/** Discriminator for routing browser commands to the workbench or creative workspace family. */
type BrowserCommandChannel = "workbench" | "creative";
const BROWSER_COMMAND_REQUEST_TYPE = {
  workbench: "workbench-command-request",
  creative: "creative-workspace-command-request",
} as const;
/**
 * Pending promise for a browser command sent to a specific client, keyed by
 * request ID. The resolver is called when the matching response arrives or the
 * request is cancelled.
 */
type BrowserCommandWaiter<Response> = {
  client: WebSocket;
  target: DirectorAgentTarget;
  resolve: (response: Response | null) => void;
};
const workbenchWaiters = new Map<string, BrowserCommandWaiter<WorkbenchCommandResponse>>();
const creativeWorkspaceWaiters = new Map<string, BrowserCommandWaiter<CreativeWorkspaceCommandResponse>>();
/** Target tokens a planner bound to during plan generation, one per workspace family. */
type PlannedAgentTargets = { workbench?: string; creative?: string };
/** Time-bounded lease on the target tokens a planner bound to, so an applied plan can route to the same tabs. */
type PlannedAgentTargetLease = { targets: PlannedAgentTargets; expiresAt: number };
const plannedAgentTargets = new Map<string, PlannedAgentTargetLease>();
let previewMimeType: StageCapturePayload["mimeType"] = "image/png";
const terminalSessions = new TerminalSessionManager(root);
// Team-readiness collaboration boundary: room auth defaults to local trust,
// persistence defaults to in-memory, and empty rooms are destroyed
// immediately; each is opt-in via environment (see createCollaborationRuntime).
const collaborationRuntime = createCollaborationRuntime({ dataDirectory, gatewaySecret });
const collaborationInviteSecret = collaborationRuntime.inviteSecret;
const collaborationRoomAuthorizer = collaborationRuntime.authorizer;
const collaborationSnapshotStore = collaborationRuntime.snapshotStore;
const collaborationHub = collaborationRuntime.hub;
const blenderBridge = createBlenderBridge({ workspaceRoot: root, dataDirectory });
const blenderReturnImporter = createBlenderReturnImporter({ workspaceRoot: root, dataDirectory });
const blenderSceneImporter = createBlenderSceneImporter({ workspaceRoot: root, dataDirectory });
const engineSceneImporter = createEngineSceneImporter({ workspaceRoot: root, dataDirectory });
const dccExchangePackager = createDirectorDccExchangePackager({ workspaceRoot: root, dataDirectory });
const dccEngineBridge = createDirectorDccEngineBridge({
  workspaceRoot: root,
  dataDirectory,
  exchangePackager: dccExchangePackager,
});
// Outbound-only Godot preview transport: the connector pushes ephemeral
// ordered frames to these token-guarded routes; nothing here can mutate the
// Director project.
const godotLiveLinkHub = createGodotLiveLinkHub();
const dccEngineReturnImporters = {
  unreal: createDccReturnImporter({ workspaceRoot: root, dataDirectory, provider: "unreal" }),
  unity: createDccReturnImporter({ workspaceRoot: root, dataDirectory, provider: "unity" }),
  godot: createDccReturnImporter({ workspaceRoot: root, dataDirectory, provider: "godot" }),
};
const dccProviders = createDirectorDccProviderRegistry({
  blender: blenderBridge,
  engines: dccEngineBridge,
  workspaceRoot: root,
});
await registerConfiguredDirectorDccProviders(dccProviders, { workspaceRoot: root });
const unityLiveLinkHub = createUnityLiveLinkHub();
const blenderNativeSession = createBlenderNativeSession(controlPlaneConfig.dcc.blender);

/** Hard deadline in milliseconds for a planner subprocess to produce output. */
const AGENT_PLAN_TIMEOUT_MS = 90_000;
/** Additional grace period in milliseconds after SIGTERM before the planner subprocess is forcibly killed. */
// Grace period after SIGTERM before escalating to SIGKILL, so a planner that
// traps SIGTERM cannot keep the HTTP request pending forever.
const AGENT_PLAN_KILL_GRACE_MS = 5_000;
/** Maximum bytes of stdout to buffer from a planner subprocess before truncation. */
const AGENT_PLAN_STDOUT_MAX_BYTES = 1024 * 1024;
/** Maximum bytes of stderr to buffer from a planner subprocess before truncation. */
const AGENT_PLAN_STDERR_MAX_BYTES = 64 * 1024;
/** Time-to-live in milliseconds for a remembered agent plan before it is evicted. */
const AGENT_PLAN_TTL_MS = 10 * 60_000;
/** Maximum number of concurrent authenticated WebSocket clients before the gateway rejects new connections. */
// Upper bound on concurrent authenticated WebSocket clients. The gateway is
// loopback-only and single-operator, so this is a generous backstop against a
// misbehaving or malicious local token holder exhausting sockets/PTYs.
const MAX_WEBSOCKET_CLIENTS = 64;

const AGENT_PLAN_SCHEMA = structuredClone(agentPlanSchema);
AGENT_PLAN_SCHEMA.properties.operations.items.properties.input_json.description =
  DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION;

await mkdir(dataDirectory, { recursive: true });
await writeJsonAtomic(agentPlanSchemaPath, AGENT_PLAN_SCHEMA, { space: 0 });
const agentPlanStore = new AgentPlanStore();
const localCliAvailability = probeLocalAgentCliAvailability();
const agentProfileRegistry = new AgentProfileRegistry(controlPlaneConfig, localCliAvailability);
const agentApiProviderStore = new AgentApiProviderStore(dataDirectory);
await agentApiProviderStore.load();
const agentWorkspaceStore = new AgentWorkspaceStore(dataDirectory);
const applyHostedApiProfiles = (profiles: readonly HostedAgentProfileConfig[]) => {
  agentProfileRegistry.replaceExtraHostedProfiles(profiles);
};
applyHostedApiProfiles(
  mergeHostedAgentProfiles(
    controlPlaneConfig.agents.profiles,
    expandAgentApiProvidersToHostedProfiles(agentApiProviderStore.list()),
  ),
);
const referenceSceneAnalyzer = createReferenceSceneAnalyzer({ profiles: agentProfileRegistry });
const agentTraceStore = new AgentTraceStore({ dataDirectory });
const productionAgentRunner = new HostedProductionAgentRunner(agentProfileRegistry, undefined, agentTraceStore.meter());
const multiAgentRunStore = new MultiAgentRunStore(dataDirectory);
const productionRunOrchestrator = new ProductionRunOrchestrator(
  productionAgentRunner,
  multiAgentRunStore,
  controlPlaneConfig.agents.roleProfiles,
);
// director_game runtime: durable slice store + playtest that prefers a live
// Stage tab (`game_playtest`) and falls back to the host-free kinematic runner.
const directorGame = createDirectorGame(dataDirectory, {
  runPlaytest: createLiveStagePlaytestRunner({
    requestWorkbenchCommand: async (input, timeoutMs) => {
      const remote = await requestWorkbenchCommand(input, timeoutMs);
      if (!remote) return null;
      return {
        success: remote.response.success,
        ...(remote.response.result !== undefined ? { result: remote.response.result } : {}),
        ...(remote.response.error ? { error: remote.response.error } : {}),
      };
    },
  }),
});
const filmPipeline = createFilmPipeline(controlPlaneConfig, dataDirectory, {
  workbenchExecute: async (input) => {
    const parsed = parseDirectorWorkbenchInput(input);
    if (!parsed.success) throw new Error(parsed.error);
    const remote = await requestWorkbenchCommand(parsed.operation);
    if (!remote) throw new Error("No connected Director workbench tab is available for stage-anchor capture");
    return remote.response.result;
  },
});
const videoGenerationService = createVideoGenerationService(controlPlaneConfig, dataDirectory, () =>
  clients.size ? requestCapture() : Promise.resolve(null),
);
const ardyMotionService = new ArdyMotionService({
  config: controlPlaneConfig.motion.ardy,
  dataDirectory,
});
const productionJobStore = new ProductionJobStore(dataDirectory);
// Unified tool-invocation audit trail shared by every POST /api/tools entry
// point (HTTP, MCP, CLI) plus UI-dispatched authoring ingest. Destructive /
// publish operations additionally consume single-use confirm tokens issued by
// POST /api/agent/confirm-token and stored hashed next to the audit trail.
const agentToolAuditStore = new AgentToolAuditStore(dataDirectory);
const agentConfirmTokenStore = new AgentConfirmTokenStore(dataDirectory);
const toolGovernance = { auditStore: agentToolAuditStore, confirmTokens: agentConfirmTokenStore };
const mediaTranscriptionRuntime = createMediaTranscriptionRuntime(
  controlPlaneConfig,
  dataDirectory,
  productionJobStore,
);
const mediaTranscodeRuntime = createMediaTranscodeRuntime(controlPlaneConfig, dataDirectory, productionJobStore);
const captureReconstructionRuntime = createCaptureReconstructionRuntime(
  controlPlaneConfig,
  productionJobStore,
  mediaTranscodeRuntime.inputs,
);
const comfyGenerationRuntime = createComfyGenerationRuntime(controlPlaneConfig, dataDirectory, productionJobStore);
const imagePromptExpander = createImagePromptExpander(controlPlaneConfig);
const assetSizeEstimator = createAssetSizeEstimator(controlPlaneConfig);
const generated3dRuntime = createGenerated3DRuntime(
  controlPlaneConfig,
  dataDirectory,
  productionJobStore,
  generatedAssetRoot,
);
const productionArtifactStore = new ProductionArtifactStore(dataDirectory);
// Storage retention/GC ops: filesystem backend rooted at the data directory
// (layout-compatible with the durable job store and staged inputs), a
// conservative env-resolved retention policy, and explicit confirmed sweeps.
const artifactStorageBackend = createArtifactStorageBackend({ dataDirectory });
const storageOpsService = new StorageOpsService({
  storage: artifactStorageBackend,
  jobs: productionJobStore,
  retention: resolveArtifactRetentionPolicy(),
  dataDirectory,
});

// A corrupt snapshot is quarantined (never silently replaced) and reported on /health.
const sceneLoadResult = await loadStageSceneWithRecovery(scenePath);
let scene: StageScene = sceneLoadResult.scene;
const sceneRecovery = sceneLoadResult.recovery;

const defaultProduction = (): ProductionRecord => ({
  productionId: "main",
  revision: 0,
  updatedAt: null,
  updatedBy: null,
  production: {
    version: 1,
    title: "Director 制作",
    activeSceneId: null,
    scenes: [],
    editorialTimeline: [],
  },
});

const productionStateStore = await ProductionStateStore.open({
  statePath: productionStatePath,
  legacyManifestPath: productionManifestPath,
  defaultProduction: defaultProduction(),
});
const productionMutationCoordinator = new ProductionMutationCoordinator();
const agentTargetScheduler = new DirectorAgentTargetScheduler();

function headers(response: ServerResponse, status = 200, contentType = "application/json; charset=utf-8") {
  const corsOrigin = responseCorsOrigins.get(response);
  response.writeHead(status, {
    "content-type": contentType,
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {}),
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, x-director-browser-token",
    "cache-control": "no-store",
  });
}

/**
 * Builds the full system prompt for an agent planner subprocess, including a
 * bounded current-scene summary and bounded workspace observations. The
 * prompt text itself lives in {@link buildPlannerPrompt} so it stays testable
 * without booting the gateway.
 *
 * @param agent - The agent identifier (determines which provider to invoke).
 * @param message - The user's natural-language request.
 * @param workbenchObservation - The latest observed state from the Director workbench, or null.
 * @param creativeWorkspaceObservation - The latest observed state from the Canvas/Video workspace, or null.
 * @returns A single concatenated prompt string ready for the planner subprocess.
 */
function plannerPrompt(
  agent: DirectorAgentId,
  message: string,
  workbenchObservation: unknown,
  creativeWorkspaceObservation: unknown,
) {
  return buildPlannerPrompt({
    agent,
    message,
    sceneSummary: executeStageTool(scene, "stage_read", { op: "scene_state" }).result,
    workbenchObservation,
    creativeWorkspaceObservation,
  });
}

/**
 * Persists a validated agent plan and records the target lease so a subsequent
 * apply can route operations to the same browser tabs the planner observed.
 *
 * @param plan - The validated plan to persist.
 * @param sessionId - The agent session this plan belongs to, or undefined.
 * @param targets - The target tokens the planner bound to during observation.
 */
function rememberAgentPlan(plan: DirectorAgentPlan, sessionId: string | undefined, targets: PlannedAgentTargets) {
  const expiresAt = Date.now() + AGENT_PLAN_TTL_MS;
  agentPlanStore.savePlan({
    plan,
    sessionId,
    sceneSignature: JSON.stringify(scene),
    expiresAt,
  });
  for (const [planId, lease] of plannedAgentTargets) {
    if (lease.expiresAt <= Date.now()) plannedAgentTargets.delete(planId);
  }
  plannedAgentTargets.set(plan.id, { targets, expiresAt });
}

/**
 * Removes a plan from storage and its target lease, and records the final
 * status in the agent harness for upstream session tracking.
 *
 * @param planId - The plan identifier to discard.
 * @param status - The terminal status to record; defaults to `"discarded"`.
 */
function discardAgentPlan(planId: string) {
  agentPlanStore.deletePlan(planId);
  plannedAgentTargets.delete(planId);
}

/**
 * @returns `"connected"` when both the ComfyUI base URL and workflow path are
 * configured, otherwise `"disconnected"`.
 */
function comfyUiStatus() {
  return controlPlaneConfig.video.comfyui.baseUrl && controlPlaneConfig.video.comfyui.workflowPath
    ? ("connected" as const)
    : ("disconnected" as const);
}

/**
 * @returns The validated gateway health wire payload, including gateway epoch,
 * Codex availability, and ComfyUI status.
 */
function directorAgentHealth() {
  return directorAgentHealthWireSchema.parse({
    gateway: { status: "ready", epoch: gatewayEpoch },
    codex: { status: localCliAvailability.codex ? "ready" : "missing" },
    comfyui: { status: comfyUiStatus() },
  });
}

/** Result of a planner subprocess invocation, capturing stdout, stderr, and termination flags. */
type PlannerRunResult = {
  output: string;
  error?: string;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
};

/**
 * Raised when a planner subprocess output file exceeds the
 * {@link AGENT_PLAN_STDOUT_MAX_BYTES} safety limit, aborting the read.
 */
class PlannerOutputLimitError extends Error {
  constructor(readonly byteLength: number) {
    super(`Planner output file exceeded ${AGENT_PLAN_STDOUT_MAX_BYTES} bytes (${byteLength} bytes)`);
    this.name = "PlannerOutputLimitError";
  }
}

/**
 * Reads the Codex planner's output file, falling back to a raw stdout string
 * when the file is missing, and throwing when the file exceeds the safety limit.
 *
 * @param path - Filesystem path to the planner's output file.
 * @param fallback - Raw stdout text to return when the file does not exist.
 * @returns The file contents as a UTF-8 string.
 * @throws {@link PlannerOutputLimitError} When the file size exceeds {@link AGENT_PLAN_STDOUT_MAX_BYTES}.
 */
async function readCodexPlannerOutput(path: string, fallback: string) {
  let fileStats;
  try {
    fileStats = await stat(path);
  } catch {
    return fallback;
  }
  if (fileStats.size > AGENT_PLAN_STDOUT_MAX_BYTES) throw new PlannerOutputLimitError(fileStats.size);
  return readFile(path, "utf8");
}

/**
 * Spawns a child process with bounded stdout/stderr buffers and a hard timeout.
 * When the timeout fires, the process tree is terminated with a grace period
 * before SIGKILL. Output truncation triggers early termination.
 *
 * @param command - The executable to spawn.
 * @param args - Command-line arguments for the executable.
 * @param options - Optional stdin payload and hard deadline (defaults to {@link AGENT_PLAN_TIMEOUT_MS}).
 * @returns A {@link PlannerRunResult} capturing stdout, stderr, and termination flags.
 */
function runProcess(
  command: string,
  args: string[],
  options: { stdinInput?: string; timeoutMs?: number } = {},
): Promise<PlannerRunResult> {
  const { stdinInput, timeoutMs = AGENT_PLAN_TIMEOUT_MS } = options;
  return new Promise((resolveRun) => {
    const output = new BoundedTextBuffer(
      AGENT_PLAN_STDOUT_MAX_BYTES,
      "[... planner stdout truncated; showing tail ...]\n",
    );
    const errorOutput = new BoundedTextBuffer(
      AGENT_PLAN_STDERR_MAX_BYTES,
      "[... planner stderr truncated; showing tail ...]\n",
    );
    let finished = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<void> | undefined;
    const finish = (result: PlannerRunResult) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolveRun(result);
    };
    let child;
    try {
      // Two literal stdio tuples keep the ChildProcessByStdio overloads, so
      // stdout/stderr stay typed as non-null streams in both branches.
      child =
        stdinInput === undefined
          ? spawn(command, args, {
              cwd: root,
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: SPAWN_IN_OWN_PROCESS_GROUP,
            })
          : spawn(command, args, {
              cwd: root,
              env: process.env,
              stdio: ["pipe", "pipe", "pipe"],
              detached: SPAWN_IN_OWN_PROCESS_GROUP,
            });
    } catch (error) {
      finish({ output: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (stdinInput !== undefined && child.stdin) {
      // The planner may exit before consuming the whole prompt; a surfaced
      // EPIPE here would crash the gateway, so the close handler owns the
      // failure report instead.
      child.stdin.on("error", () => {});
      child.stdin.end(stdinInput);
    }
    const terminate = () => {
      if (termination) return;
      termination = terminateChildProcess(child, { termGraceMs: AGENT_PLAN_KILL_GRACE_MS }).then(() =>
        finish({
          output: output.toString(),
          timedOut,
          outputLimitExceeded,
          error: errorOutput.toString().trim() || `${command} was terminated`,
        }),
      );
    };
    timer = setTimeout(() => {
      timedOut = true;
      // Escalate to a process-tree SIGKILL and force-settle inherited stdio so
      // descendants cannot keep the awaiting request open indefinitely.
      terminate();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      output.append(chunk);
      if (output.wasTruncated && !outputLimitExceeded) {
        outputLimitExceeded = true;
        terminate();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput.append(chunk);
    });
    child.on("error", (error) => finish({ output: output.toString(), error: error.message, outputLimitExceeded }));
    child.on("close", (code) =>
      finish({
        output: output.toString(),
        timedOut,
        outputLimitExceeded,
        ...(code === 0
          ? {}
          : { error: errorOutput.toString().trim() || `${command} exited with code ${code ?? "unknown"}` }),
      }),
    );
  });
}

/**
 * Dispatches a planning request to the configured agent provider. Observes
 * the current workbench and creative workspace state, builds the planner prompt,
 * and invokes the appropriate subprocess (Codex or Claude).
 *
 * @param agent - Which agent provider to use.
 * @param message - The user's natural-language request.
 * @returns The planner's draft, error details, and the target tokens bound during observation.
 */
async function runAgentPlanner(
  agent: DirectorAgentId,
  message: string,
): Promise<{ draft?: unknown; error?: string; code?: string; targets: PlannedAgentTargets }> {
  const normalizedMessage = message.toLocaleLowerCase();
  const needsCreativeWorkspace = /canvas|video editor|画布|视频编辑器|节点|pipeline|媒体|音频|图片生成|视频生成/.test(
    normalizedMessage,
  );
  const plannerFields: DirectorWorkbenchObserveField[] = ["counts", "objects", "cameras", "assets"];
  if (/动画|动作|关键帧|时间线|timeline|走路|跑步|姿势|motion|ik/.test(normalizedMessage)) {
    plannerFields.push("timeline");
  }
  if (/场景设置|环境|地面|背景|scene/.test(normalizedMessage)) plannerFields.push("scene");
  if (/分镜|storyboard|production|制作|shot|take|coverage/.test(normalizedMessage)) {
    plannerFields.push("storyboard", "production");
  }
  if (/灯光|light|雾|fog|环境光/.test(normalizedMessage)) plannerFields.push("lights");
  const [observed, creativeObserved] = await Promise.all([
    requestWorkbenchCommand({ op: "observe", fields: [...new Set(plannerFields)] }, 2_500).catch(() => null),
    needsCreativeWorkspace
      ? requestCreativeWorkspaceCommand({ op: "observe" }, 2_500).catch(() => null)
      : Promise.resolve(null),
  ]);
  const workbenchObservation = observed?.response.success ? (observed.response.result ?? null) : null;
  const creativeWorkspaceObservation = creativeObserved?.response.success
    ? (creativeObserved.response.result ?? null)
    : null;
  const targets: PlannedAgentTargets = {
    ...(observed ? { workbench: observed.target.token } : {}),
    ...(creativeObserved ? { creative: creativeObserved.target.token } : {}),
  };
  const completed = (result: { draft?: unknown; error?: string; code?: string }) => ({ ...result, targets });
  const outputLimitFailure = (agent: DirectorAgentId, diagnostic: string) => {
    const failure = reportPlannerOutputLimit(diagnostic, agent);
    return completed({ error: failure.publicMessage, code: "agent_output_limit" });
  };
  const invalidOutputFailure = (agent: DirectorAgentId, diagnostic: string) => {
    const failure = reportPlannerInvalidOutput(diagnostic, agent);
    return completed({ error: failure.publicMessage, code: "agent_invalid_json" });
  };
  const prompt = plannerPrompt(agent, message, workbenchObservation, creativeWorkspaceObservation);
  if (agent === "codex") {
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "director-codex-plan-"));
    const outputPath = resolve(temporaryDirectory, "plan.json");
    try {
      // The prompt embeds full authoring/creative JSON schemas plus live
      // observations, which can exceed the OS single-argument limit
      // (Linux MAX_ARG_STRLEN, 128 KiB) and fail spawn with E2BIG. The "-"
      // sentinel makes codex exec read the whole prompt from stdin instead.
      const result = await runProcess(
        "codex",
        [
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--skip-git-repo-check",
          "--output-schema",
          agentPlanSchemaPath,
          "--output-last-message",
          outputPath,
          "--cd",
          root,
          "-",
        ],
        { stdinInput: prompt },
      );
      if (result.outputLimitExceeded) {
        return outputLimitFailure(agent, `Codex stdout exceeded the safety limit\nretained_tail=${result.output}`);
      }
      if (result.timedOut) return completed({ error: "Codex 规划超时，请缩短请求后重试", code: "agent_timeout" });
      if (result.error) {
        const failure = reportPlannerFailure(result.error, agent);
        return completed({
          error: `Codex 无法生成计划：${failure.publicMessage}`,
          code: "agent_failed",
        });
      }
      const response = await readCodexPlannerOutput(outputPath, result.output);
      try {
        return completed({ draft: JSON.parse(response) });
      } catch (error) {
        return invalidOutputFailure(
          agent,
          `Codex JSON decoder failed: ${error instanceof Error ? error.message : String(error)}\nmodel_output=${response}`,
        );
      }
    } catch (error) {
      if (error instanceof PlannerOutputLimitError) return outputLimitFailure(agent, error.message);
      return invalidOutputFailure(
        agent,
        `Codex planner output could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  // The prompt is piped through stdin: claude --print reads it there when no
  // positional prompt is given, and stdin has no OS argument-length limit
  // (the argv form can fail spawn with E2BIG once schemas plus observations
  // pass Linux MAX_ARG_STRLEN). This also keeps the variadic --tools option
  // from consuming the prompt as another tool name.
  const result = await runProcess(
    "claude",
    [
      "--print",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
      "--effort",
      "low",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(AGENT_PLAN_SCHEMA),
      "--tools",
      "",
    ],
    { stdinInput: prompt },
  );
  if (result.outputLimitExceeded) {
    return outputLimitFailure(agent, `Claude stdout exceeded the safety limit\nretained_tail=${result.output}`);
  }
  if (result.timedOut) return completed({ error: "Claude 规划超时，请缩短请求后重试", code: "agent_timeout" });
  if (result.error) {
    const failure = reportPlannerFailure(result.error, agent);
    return completed({
      error: `Claude 无法生成计划：${failure.publicMessage}`,
      code: "agent_failed",
    });
  }
  try {
    return completed({ draft: decodeClaudePlannerOutput(result.output) });
  } catch (error) {
    return invalidOutputFailure(
      agent,
      `Claude JSON decoder failed: ${error instanceof Error ? error.message : String(error)}\nmodel_output=${result.output}`,
    );
  }
}

/**
 * Writes an HTTP JSON response with the given status code.
 *
 * @param response - The Node.js server response.
 * @param status - HTTP status code.
 * @param body - Value to serialize as JSON.
 */
function json(response: ServerResponse, status: number, body: unknown) {
  headers(response, status);
  response.end(JSON.stringify(body));
}

/**
 * A malformed or oversized request body is the caller's fault, so it carries
 * the client-error status the top-level handler should answer with instead of
 * being folded into the generic 500 path.
 */
class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

/**
 * Reads and parses the JSON request body, enforcing an 8 MiB size limit.
 *
 * @returns The parsed JSON value, or an empty object when the body is empty.
 * @throws {RequestBodyError} 413 when the body exceeds 8 MiB, 400 when it is not valid JSON.
 */
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024 * 1024) throw new RequestBodyError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new RequestBodyError(
      400,
      `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Atomically writes the current in-memory scene to the durable scene file. */
async function persistScene() {
  await writeJsonAtomic(scenePath, scene);
}

async function readPersistedWorkbenchProject(): Promise<DirectorProject | null> {
  try {
    const parsed = safeParseDirectorProject(JSON.parse(await readFile(workbenchProjectPath, "utf8")));
    if (parsed.success) return parsed.project;
  } catch {
    // A missing workbench file is a valid empty fallback.
  }
  const sceneId = productionStateStore.getProduction().production.activeSceneId;
  return sceneId ? (productionStateStore.getSceneProject(sceneId)?.project ?? null) : null;
}

async function loadNativeSceneSnapshot() {
  try {
    const status = await blenderNativeSession.status();
    if (!status.available) return null;
    return await blenderNativeSession.snapshot();
  } catch {
    return null;
  }
}

/**
 * Agent edits advance the same scene-project record a browser restores on boot,
 * so a tab that reloads before its own debounced autosave fires cannot
 * resurrect a project older than the last agent mutation.
 */
async function mirrorAgentProjectToSceneRecord(client: WebSocket, project: DirectorProject) {
  const sceneId = workbenchClients.get(client)?.sceneId;
  if (!sceneId) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await productionStateStore.saveSceneProject({
        sceneId,
        expectedRevision: productionStateStore.getSceneProject(sceneId)?.revision ?? 0,
        project,
        actor: "director-gateway:agent",
      });
      return;
    } catch {
      // A browser autosave already queued ahead of us can stale the first
      // expected revision. Read the committed revision and retry once.
      if (attempt === 0 && productionStateStore.getSceneProject(sceneId)) continue;
      // A scene outside the production keeps the durable workbench file as the
      // boot-restore source of truth.
      return;
    }
  }
}

/**
 * Sends a JSON message to every connected WebSocket client.
 *
 * @param message - The value to serialize and broadcast.
 */
function broadcast(message: unknown) {
  const payload = JSON.stringify(message);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
}

/**
 * Sends a JSON message to every connected WebSocket client except the specified one.
 *
 * @param message - The value to serialize and broadcast.
 * @param excludedClient - The client to skip.
 */
function broadcastExcept(message: unknown, excludedClient: WebSocket) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client !== excludedClient && client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

/**
 * Sends a JSON message to all workbench peers in the same scene and creative
 * scope as the source client, excluding the source client itself.
 *
 * @param message - The value to serialize and broadcast.
 * @param sourceClient - The originating client to exclude from the broadcast.
 */
function broadcastWorkbenchPeers(message: unknown, sourceClient: WebSocket) {
  const source = workbenchClients.get(sourceClient);
  if (!source) return;
  const payload = JSON.stringify(message);
  for (const [client, registration] of workbenchClients) {
    if (
      client !== sourceClient &&
      client.readyState === WebSocket.OPEN &&
      registration.sceneId === source.sceneId &&
      registration.creativeScopeId === source.creativeScopeId
    ) {
      client.send(payload);
    }
  }
}

/**
 * @returns Open workbench WebSocket clients sorted by visibility (visible first)
 * then recency (most recently seen first), as a plain array of sockets.
 */
function rankedConnectedClients() {
  return [...workbenchClients.entries()]
    .filter(([client]) => client.readyState === WebSocket.OPEN)
    .sort(
      (left, right) => Number(right[1].visible) - Number(left[1].visible) || right[1].lastSeenAt - left[1].lastSeenAt,
    )
    .map(([client]) => client);
}

/**
 * Delegates to {@link rankUntargetedWorkbenchClients} to produce a workspace-aware
 * ranking of open clients for the given operation type.
 *
 * @param input - The operation to rank clients for (the `op` field, plus the
 *   compare endpoints when ranking a compare operation).
 * @returns An ordered array of WebSocket client entries.
 */
function rankedWorkbenchClients(input: WorkbenchRoutingOperation) {
  return rankUntargetedWorkbenchClients(
    [...workbenchClients.entries()].filter(([client]) => client.readyState === WebSocket.OPEN),
    input,
  );
}

/**
 * Resolves a target token to an open WebSocket client, falling back to the
 * highest-ranked connected client when no token is provided.
 *
 * @param targetToken - The stable target token to look up, or undefined for best-effort routing.
 * @returns The matching open WebSocket, or null when no client is available.
 */
function clientForTarget(targetToken?: string) {
  if (!targetToken) return rankedConnectedClients()[0] ?? null;
  for (const [client, registration] of workbenchClients) {
    if (client.readyState === WebSocket.OPEN && registration.targetToken === targetToken) return client;
  }
  return null;
}

/**
 * Builds the wire-format agent target descriptor for a registered workbench client.
 *
 * @param client - The WebSocket whose registration to read.
 * @returns The target descriptor, or null when the client is not registered.
 */
function agentTargetForClient(client: WebSocket): DirectorAgentTarget | null {
  const registration = workbenchClients.get(client);
  if (!registration) return null;
  return {
    token: registration.targetToken,
    client_id: registration.clientId,
    instance_id: registration.instanceId,
    scene_id: registration.sceneId,
    creative_scope_id: registration.creativeScopeId,
    contract_version: registration.contractVersion,
  };
}

/**
 * Sends a cancel message to a browser client for a pending command, so the tab
 * can clean up in-progress work.
 *
 * @param client - The WebSocket client to notify.
 * @param family - Which command family to cancel (`"workbench"` or `"creative"`).
 * @param requestId - The request identifier to cancel.
 * @param target - The agent target the original request was bound to.
 * @param reason - Why the cancellation was triggered.
 */
function sendBrowserCommandCancel(
  client: WebSocket,
  family: "workbench" | "creative",
  requestId: string,
  target: DirectorAgentTarget,
  reason: "timeout" | "target_unavailable" | "superseded",
) {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(
    JSON.stringify({
      type: family === "workbench" ? "workbench-command-cancel" : "creative-workspace-command-cancel",
      requestId,
      target,
      reason,
    }),
  );
}

/**
 * Cancels every pending command waiter for a given client across both the
 * workbench and creative workspace families, resolving each with null.
 *
 * @param client - The WebSocket client whose waiters to cancel.
 */
function cancelTargetWaiters(client: WebSocket) {
  for (const [requestId, waiter] of [...workbenchWaiters]) {
    if (waiter.client !== client) continue;
    sendBrowserCommandCancel(client, "workbench", requestId, waiter.target, "target_unavailable");
    waiter.resolve(null);
  }
  for (const [requestId, waiter] of [...creativeWorkspaceWaiters]) {
    if (waiter.client !== client) continue;
    sendBrowserCommandCancel(client, "creative", requestId, waiter.target, "target_unavailable");
    waiter.resolve(null);
  }
}

/**
 * Sends a typed command to a specific browser client and returns a promise that
 * settles when the matching response arrives or the timeout fires. The promise
 * rejects with {@link BrowserCommandTimeoutError} on timeout and resolves to
 * null when the target does not match.
 *
 * @param channel - Which command family to send.
 * @param waiters - The waiter map to register the pending request in.
 * @param client - The WebSocket client to send the command to.
 * @param input - The typed command payload.
 * @param timeoutMs - Per-request timeout in milliseconds.
 * @returns The client, response, and target on success, or null on mismatch.
 */
function requestBrowserCommandFromClient<
  Input extends { op: string },
  Response extends { target: DirectorAgentTarget },
>(
  channel: BrowserCommandChannel,
  waiters: Map<string, BrowserCommandWaiter<Response>>,
  client: WebSocket,
  input: Input,
  timeoutMs: number,
): Promise<{
  client: WebSocket;
  response: Response;
  target: DirectorAgentTarget;
} | null> {
  const target = agentTargetForClient(client);
  if (!target) return Promise.resolve(null);
  const requestId = crypto.randomUUID();
  return new Promise((resolveCommand, rejectCommand) => {
    const timeout = setTimeout(() => {
      waiters.delete(requestId);
      sendBrowserCommandCancel(client, channel, requestId, target, "timeout");
      rejectCommand(new BrowserCommandTimeoutError(channel, input.op, timeoutMs));
    }, timeoutMs);
    waiters.set(requestId, {
      client,
      target,
      resolve: (response) => {
        clearTimeout(timeout);
        waiters.delete(requestId);
        resolveCommand(
          response && sameDirectorAgentTarget(target, response.target) ? { client, response, target } : null,
        );
      },
    });
    client.send(JSON.stringify({ type: BROWSER_COMMAND_REQUEST_TYPE[channel], requestId, target, input }));
  });
}

/**
 * Sends a Director workbench command to a specific browser client.
 *
 * @param client - The WebSocket client to target.
 * @param input - The typed workbench operation.
 * @param timeoutMs - Per-request timeout in milliseconds.
 * @returns The resolved command result, or null on mismatch.
 */
function requestWorkbenchCommandFromClient(client: WebSocket, input: DirectorWorkbenchOperation, timeoutMs: number) {
  return requestBrowserCommandFromClient("workbench", workbenchWaiters, client, input, timeoutMs);
}

/**
 * Returns the default timeout in milliseconds for a workbench operation,
 * tuned for expected latency of each operation type.
 *
 * @param input - The workbench operation to compute a timeout for.
 * @returns The timeout in milliseconds.
 */
function defaultWorkbenchCommandTimeoutMs(input: DirectorWorkbenchOperation) {
  if (input.op === "storyboard_artifact") return 120_000;
  if (input.op === "generation" && input.command.action === "promote") return 120_000;
  if (input.op === "generation" && input.command.action === "submit") return 30_000;
  if (input.op === "transcription" && input.command.action === "submit") return 120_000;
  if (input.op === "transcription" && input.command.action === "promote") return 120_000;
  if (input.op === "deliver") return 60_000;
  if (input.op === "shot_package") return 45_000;
  if (input.op === "capture") return 60_000;
  // compare may render up to two stage viewports and download plan artifacts.
  if (input.op === "compare") return 30_000;
  // Live game playtest timeout is overridden by the caller (script length);
  // keep a generous default if invoked without an override.
  if (input.op === "game_playtest") return 60_000;
  return 8_000;
}

/**
 * Sends a workbench command to the best available browser client, with optional
 * exact-target routing and discovery fallback for read-only operations.
 *
 * @param input - The typed workbench operation.
 * @param timeoutMs - Per-request timeout; defaults to {@link defaultWorkbenchCommandTimeoutMs}.
 * @param targetToken - Optional exact target token to route to; when omitted, the best-ranked client is used.
 * @returns The resolved command result, or null when no client is available.
 */
function requestWorkbenchCommand(
  input: DirectorWorkbenchOperation,
  timeoutMs = defaultWorkbenchCommandTimeoutMs(input),
  targetToken?: string,
) {
  const hasExactTarget = targetToken !== undefined;
  return requestFromBrowserClients({
    ...(hasExactTarget ? { exactClient: clientForTarget(targetToken) } : {}),
    rankedClients: rankedWorkbenchClients(input),
    allowDiscoveryFallback: !hasExactTarget && (input.op === "capabilities" || input.op === "observe"),
    request: (client) => requestWorkbenchCommandFromClient(client, input, timeoutMs),
    isRetryableDiscoveryError: isBrowserCommandTimeoutError,
  });
}

/**
 * Returns the default timeout in milliseconds for a creative workspace operation,
 * with longer windows for pipeline start/cancel and preview rendering.
 *
 * @param input - The creative workspace request to compute a timeout for.
 * @returns The timeout in milliseconds.
 */
function defaultCreativeWorkspaceCommandTimeoutMs(input: CreativeWorkspaceAgentRequest) {
  if (input.op === "preview") return 30_000;
  if (input.op === "pipeline") {
    if (input.request.action === "start" && input.request.await_completion) return 15 * 60_000;
    if (input.request.action === "cancel") return 120_000;
    return 30_000;
  }
  return 8_000;
}

/**
 * Sends a Canvas/Video creative workspace command to a specific browser client.
 *
 * @param client - The WebSocket client to target.
 * @param input - The typed creative workspace request.
 * @param timeoutMs - Per-request timeout in milliseconds.
 * @returns The resolved command result, or null on mismatch.
 */
function requestCreativeWorkspaceCommandFromClient(
  client: WebSocket,
  input: CreativeWorkspaceAgentRequest,
  timeoutMs: number,
) {
  return requestBrowserCommandFromClient("creative", creativeWorkspaceWaiters, client, input, timeoutMs);
}

/**
 * Sends a creative workspace command to the best available browser client, with
 * optional exact-target routing and discovery fallback for read-only operations.
 *
 * @param input - The typed creative workspace request.
 * @param timeoutMs - Per-request timeout; defaults to {@link defaultCreativeWorkspaceCommandTimeoutMs}.
 * @param targetToken - Optional exact target token to route to.
 * @returns The resolved command result, or null when no client is available.
 */
function requestCreativeWorkspaceCommand(
  input: CreativeWorkspaceAgentRequest,
  timeoutMs = defaultCreativeWorkspaceCommandTimeoutMs(input),
  targetToken?: string,
) {
  const hasExactTarget = targetToken !== undefined;
  return requestFromBrowserClients({
    ...(hasExactTarget ? { exactClient: clientForTarget(targetToken) } : {}),
    rankedClients: rankedConnectedClients(),
    allowDiscoveryFallback: !hasExactTarget && (input.op === "capabilities" || input.op === "observe"),
    request: (client) => requestCreativeWorkspaceCommandFromClient(client, input, timeoutMs),
    isRetryableDiscoveryError: isBrowserCommandTimeoutError,
  });
}

/**
 * Requests a capture or shot-package from the best available workbench client,
 * iterating through ranked clients until one returns a valid image data URL.
 * When an exact target is specified, only that client is tried.
 *
 * @param input - The capture or shot_package operation.
 * @param timeoutMs - Per-client timeout; defaults to {@link defaultWorkbenchCommandTimeoutMs}.
 * @param targetToken - Optional exact target token to restrict recipients.
 * @returns The last attempted response, or null when no client produced a valid capture.
 */
async function requestWorkbenchCapture(
  input: Extract<DirectorWorkbenchOperation, { op: "capture" | "shot_package" }>,
  timeoutMs = defaultWorkbenchCommandTimeoutMs(input),
  targetToken?: string,
) {
  let lastResponse: Awaited<ReturnType<typeof requestWorkbenchCommandFromClient>> = null;
  const hasExactTarget = targetToken !== undefined;
  const recipients = hasExactTarget
    ? [clientForTarget(targetToken)].filter((client): client is WebSocket => Boolean(client))
    : rankedWorkbenchClients(input);
  for (const client of recipients) {
    const perClientTimeout = hasExactTarget
      ? timeoutMs
      : input.op === "shot_package"
        ? Math.min(timeoutMs, 20_000)
        : Math.min(timeoutMs, 8_000);
    let remote: Awaited<ReturnType<typeof requestWorkbenchCommandFromClient>>;
    try {
      remote = await requestWorkbenchCommandFromClient(client, input, perClientTimeout);
    } catch (error) {
      if (hasExactTarget || !isBrowserCommandTimeoutError(error)) throw error;
      continue;
    }
    if (!remote) continue;
    lastResponse = remote;
    if (input.op === "shot_package" && remote.response.success) return remote;
    if (
      remote.response.success &&
      remote.response.captureDataUrl &&
      parseCaptureDataUrl(remote.response.captureDataUrl)
    ) {
      return remote;
    }
  }
  return lastResponse;
}

/**
 * Requests a lightweight screenshot from all connected WebSocket clients,
 * resolving with the first valid data URL or null when no client responds
 * within the timeout.
 *
 * @param cameraId - Optional camera identifier to capture from.
 * @param timeoutMs - Overall deadline in milliseconds; defaults to 2200.
 * @returns A base64 data URL string, or null on timeout / no clients.
 */
function requestCapture(cameraId?: string, timeoutMs = 2200): Promise<string | null> {
  const requestId = crypto.randomUUID();
  const recipients = [...clients].filter((client) => client.readyState === WebSocket.OPEN);
  if (!recipients.length) return Promise.resolve(null);
  return new Promise((resolveCapture) => {
    let remaining = recipients.length;
    let completed = false;
    const finish = (dataUrl: string | null) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      captureWaiters.delete(requestId);
      resolveCapture(dataUrl);
    };
    const timeout = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    captureWaiters.set(requestId, (dataUrl) => {
      if (dataUrl && parseCaptureDataUrl(dataUrl)) return finish(dataUrl);
      remaining -= 1;
      if (remaining <= 0) finish(null);
    });
    const message = JSON.stringify({ type: "capture-request", requestId, ...(cameraId ? { cameraId } : {}) });
    recipients.forEach((client) => client.send(message));
  });
}

/**
 * Writes a capture payload to the durable preview file and updates the cached MIME type.
 *
 * @param capture - The stage capture payload with base64-encoded image data.
 */
async function savePreview(capture: StageCapturePayload) {
  await writeFile(previewPath, Buffer.from(capture.data, "base64"));
  previewMimeType = capture.mimeType;
}

/**
 * Handles the assistant plan HTTP endpoint. Runs the planner up to twice with
 * a retry on validation failure, then persists the valid plan or returns an
 * appropriate error response.
 *
 * @param payload - The parsed plan request from the client.
 * @param response - The Node.js server response to write to.
 */
async function handleAssistantPlanRequest(payload: AssistantPlanRequest, response: ServerResponse) {
  const { agent, message, session_id: sessionId } = payload;
  let plan: DirectorAgentPlan | null = null;
  let targets: PlannedAgentTargets = {};
  let plannerMessage = message;
  let invalidPlanError = "Agent plan format invalid";
  let invalidPlanCode = "agent_invalid_plan";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const planned = await runAgentPlanner(agent, plannerMessage);
    if (!planned.draft) {
      json(response, planned.code === "agent_timeout" ? 504 : 502, {
        error: planned.error ?? "Agent 未能生成计划",
        code: planned.code ?? "agent_failed",
      });
      return;
    }
    let draft: unknown;
    try {
      draft = decodePlannerDraft(planned.draft);
    } catch (error) {
      const decoderDiagnostic = `Planner draft decoder failed on attempt ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`;
      invalidPlanError = `Agent plan input invalid: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt === 0) {
        plannerMessage = createPlannerRetryMessage(message, invalidPlanError);
        continue;
      }
      const failure = reportPlannerInvalidOutput(decoderDiagnostic, agent);
      invalidPlanError = failure.publicMessage;
      invalidPlanCode = "agent_invalid_json";
      break;
    }
    const validated = validateDirectorAgentPlan({
      draft,
      scene,
      agent,
      id: crypto.randomUUID(),
    });
    if (!("error" in validated)) {
      plan = validated;
      targets = planned.targets;
      break;
    }
    invalidPlanError = validated.error;
    if (attempt === 0) {
      plannerMessage = createPlannerRetryMessage(message, invalidPlanError);
    } else {
      const failure = reportPlannerInvalidOutput(
        `Planner semantic validation failed on attempt ${attempt + 1}; model-controlled validation details omitted`,
        agent,
      );
      invalidPlanError = failure.publicMessage;
      invalidPlanCode = "agent_invalid_json";
    }
  }
  if (!plan) {
    json(response, 422, { error: invalidPlanError, code: invalidPlanCode });
    return;
  }
  rememberAgentPlan(plan, sessionId, targets);
  json(response, 200, { plan });
}

/** Shape of a browser response returned by a planned operation execution. */
type PlannedBrowserResponse = {
  success: boolean;
  error?: string;
  result?: unknown;
};

/** Single operation result within a plan application, tagged with its plan operation ID and tool. */
type PlannedOperationResult = { id: string; tool: string; result: unknown; agent_boundary?: AgentBoundaryReceipt };

/**
 * Extracts the project revision from a workbench observe result for concurrency guarding.
 *
 * @param value - The raw observe result value.
 * @returns The revision string, or null when absent or invalid.
 */
function observedWorkbenchRevision(value: unknown) {
  const revision = asRecord(value)?.project_revision;
  return typeof revision === "string" && revision.trim() ? revision : null;
}

/**
 * Extracts the production revision from a production observe result for concurrency guarding.
 *
 * @param value - The raw observe result value.
 * @returns The revision as a string, or null when absent or invalid.
 */
function observedProductionRevision(value: unknown) {
  const revision = asRecord(value)?.production_revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? String(revision) : null;
}

/**
 * Extracts the snapshot fingerprint from a creative workspace observe result for concurrency guarding.
 *
 * @param value - The raw observe result value.
 * @returns The fingerprint string, or null when absent or invalid.
 */
function observedCreativeFingerprint(value: unknown) {
  const fingerprint = asRecord(asRecord(value)?.snapshot)?.snapshot_fingerprint;
  return typeof fingerprint === "string" && fingerprint.trim() ? fingerprint : null;
}

/**
 * Extracts the collaboration fingerprint from a collaboration observe result for concurrency guarding.
 *
 * @param value - The raw observe result value.
 * @returns The fingerprint string, or null when absent or invalid.
 */
function observedCollaborationFingerprint(value: unknown) {
  const state = asRecord(asRecord(asRecord(value)?.result)?.state);
  const fingerprint = state?.collaboration_fingerprint;
  return typeof fingerprint === "string" && fingerprint.trim() ? fingerprint : null;
}

/**
 * Performs the pre-mutation observe-and-guard step for a planned mutation.
 * When the mutation needs observation, it observes the target, validates the
 * guard value (revision or fingerprint), and injects the concurrency guard
 * into the mutation. Returns the secured mutation on success, or writes an
 * error response and returns null on any guard failure.
 *
 * @param input - The security context including the response, plan, session, target, and guard callbacks.
 * @returns The secured mutation with injected guard, or null when the guard check fails.
 */
async function securePlannedAgentMutation(input: {
  response: ServerResponse;
  planId: string;
  summary: string;
  sessionId: string;
  targetToken?: string;
  missingMessage: string;
  disconnectedMessage: string;
  prepared: PreparedMutation;
  guardName: string;
  observe: (targetToken: string) => Promise<{ target: DirectorAgentTarget; response: PlannedBrowserResponse } | null>;
  observedGuard: (result: unknown) => string | null;
}): Promise<PreparedMutation | null> {
  if (!input.prepared.needsObservation) return input.prepared;
  if (!input.targetToken) {
    discardAgentPlan(input.planId);
    json(input.response, 409, { success: false, error: input.missingMessage, code: "target_unavailable" });
    return null;
  }
  let observation: { target: DirectorAgentTarget; response: PlannedBrowserResponse } | null;
  try {
    observation = await input.observe(input.targetToken);
  } catch (error) {
    if (!isBrowserCommandTimeoutError(error)) throw error;
    json(input.response, 504, {
      success: false,
      error: `${input.summary}：守卫预检 observe 超时且已取消，未发送任何变更，请重试`,
      code: error.code,
    });
    return null;
  }
  if (!observation) {
    discardAgentPlan(input.planId);
    json(input.response, 409, { success: false, error: input.disconnectedMessage, code: "target_unavailable" });
    return null;
  }
  const guardValue = input.observedGuard(observation.response.result);
  if (!observation.response.success || !guardValue) {
    json(input.response, 502, {
      success: false,
      error: `${input.summary}：守卫预检未返回可用的${input.guardName}，未发送任何变更，请重新规划`,
      code: "invalid_preflight_revision",
    });
    return null;
  }
  return applyObservedAgentGuard(input.prepared, input.sessionId, guardValue);
}

/**
 * Routes a planned browser command to the target client and handles every
 * failure mode (target missing, timeout, disconnect, execution error) by
 * writing the appropriate HTTP response. Returns the remote result on success
 * or null on failure.
 *
 * @param input - The routing context including the response, plan, target, and request callback.
 * @returns The resolved remote response, or null when a failure response was already written.
 */
async function requestPlannedBrowserCommand<Remote extends { response: PlannedBrowserResponse }>(input: {
  response: ServerResponse;
  planId: string;
  targetToken?: string;
  summary: string;
  missingMessage: string;
  disconnectedMessage: string;
  unknownMessage: string;
  operationResults: PlannedOperationResult[];
  request: (targetToken: string) => Promise<Remote | null>;
}) {
  if (!input.targetToken) {
    discardAgentPlan(input.planId);
    json(input.response, 409, { success: false, error: input.missingMessage, code: "target_unavailable" });
    return null;
  }
  let remote: Remote | null;
  try {
    remote = await input.request(input.targetToken);
  } catch (error) {
    if (!isBrowserCommandTimeoutError(error)) throw error;
    json(input.response, error.code === "outcome_unknown" ? 409 : 504, {
      success: false,
      error: error.code === "outcome_unknown" ? input.unknownMessage : `${input.summary}：浏览器执行超时且已取消。`,
      code: error.code,
      result: {
        operations: input.operationResults,
        project_committed: "unknown",
        retry_requires_observe: true,
      },
    });
    return null;
  }
  if (!remote) {
    discardAgentPlan(input.planId);
    json(input.response, 409, { success: false, error: input.disconnectedMessage, code: "target_unavailable" });
    return null;
  }
  if (!remote.response.success) {
    json(input.response, 422, {
      success: false,
      error: `${input.summary}：${remote.response.error ?? "执行失败"}`,
      code: "plan_apply_failed",
      ...(remote.response.result !== undefined ? { result: remote.response.result } : {}),
    });
    return null;
  }
  return remote;
}

/**
 * Handles the assistant apply HTTP endpoint. Validates the plan is still fresh
 * and the scene has not changed, then executes each operation in order against
 * the appropriate target (workbench, creative workspace, Blender, stage tools,
 * or video generation). Commits scene changes and discards the plan on success.
 *
 * @param payload - The parsed apply request from the client.
 * @param response - The Node.js server response to write to.
 */
async function handleAssistantApplyRequest(payload: AssistantApplyRequest, response: ServerResponse) {
  const planId = payload.plan_id;
  const pending = agentPlanStore.getPlan(planId);
  if (!pending || pending.expiresAt <= Date.now()) {
    discardAgentPlan(planId);
    json(response, 404, { success: false, error: "Agent 计划已过期，请重新规划", code: "plan_expired" });
    return;
  }
  if (pending.sceneSignature !== JSON.stringify(scene)) {
    discardAgentPlan(planId);
    json(response, 409, { success: false, error: "场景在规划后已发生变化，请重新规划", code: "scene_conflict" });
    return;
  }
  if (pending.plan.requiresConfirmation && payload.confirmed !== true) {
    json(response, 428, { success: false, error: "该计划需要明确确认", code: "confirmation_required" });
    return;
  }

  let stagedScene = structuredClone(scene);
  const refs = new Map<string, string>();
  const events = [] as NonNullable<ReturnType<typeof executeStageTool>["events"]>;
  const operationResults: PlannedOperationResult[] = [];
  const videoOperations: DirectorAgentPlan["operations"] = [];
  const targetLease = plannedAgentTargets.get(planId);
  const targets = targetLease && targetLease.expiresAt > Date.now() ? targetLease.targets : undefined;
  const boundarySessionId = pending.sessionId ?? planId;
  for (const operation of pending.plan.operations) {
    if (operation.tool === "director_creative") {
      const parsedInput = creativeWorkspaceAgentRequestSchema.safeParse(operation.input);
      if (!parsedInput.success) {
        json(response, 422, {
          success: false,
          error: `${operation.summary}：director_creative 参数无效`,
          code: "plan_apply_failed",
        });
        return;
      }
      const missingMessage = `${operation.summary}：计划绑定的 Canvas/Video 标签页已失效，请重新规划`;
      const disconnectedMessage = `${operation.summary}：计划绑定的 Canvas/Video 标签页已断开或切换，请重新规划`;
      let creativeOperation = parsedInput.data;
      let agentBoundary: AgentBoundaryReceipt | undefined;
      if (isCreativeMutation(creativeOperation)) {
        const isCollaboration = creativeOperation.op === "collaboration";
        const secured = await securePlannedAgentMutation({
          response,
          planId,
          summary: operation.summary,
          sessionId: boundarySessionId,
          targetToken: targets?.creative,
          missingMessage,
          disconnectedMessage,
          prepared: prepareAgentMutation(
            { tool: "director_creative", operation: creativeOperation },
            boundarySessionId,
          ),
          guardName: isCollaboration ? "协作指纹" : "快照指纹",
          observe: (targetToken) =>
            requestCreativeWorkspaceCommand(
              isCollaboration ? { op: "collaboration", request: { action: "observe" } } : { op: "observe" },
              undefined,
              targetToken,
            ),
          observedGuard: isCollaboration ? observedCollaborationFingerprint : observedCreativeFingerprint,
        });
        if (!secured) return;
        creativeOperation = secured.mutation.operation as typeof creativeOperation;
        agentBoundary = secured.receipt;
      }
      const remote = await requestPlannedBrowserCommand({
        response,
        planId,
        targetToken: targets?.creative,
        summary: operation.summary,
        missingMessage,
        disconnectedMessage,
        unknownMessage: `${operation.summary}：浏览器未及时确认，结果未知。请刷新当前内容后重试。`,
        operationResults,
        request: (targetToken) => requestCreativeWorkspaceCommand(creativeOperation, undefined, targetToken),
      });
      if (!remote) return;
      operationResults.push({
        id: operation.id,
        tool: operation.tool,
        result: remote.response.result,
        ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
      });
      continue;
    }
    if (operation.tool === "director_workbench") {
      const parsedInput = parseDirectorWorkbenchInput(operation.input);
      if (!parsedInput.success) {
        json(response, 422, {
          success: false,
          error: `${operation.summary}：${parsedInput.error}`,
          code: "plan_apply_failed",
        });
        return;
      }
      const missingMessage = `${operation.summary}：计划绑定的 Director 标签页已失效，请重新规划`;
      const disconnectedMessage = `${operation.summary}：计划绑定的 Director 标签页已断开或切换，请重新规划`;
      let workbenchOperation = parsedInput.operation;
      let agentBoundary: AgentBoundaryReceipt | undefined;
      if (isWorkbenchDurableJobMutation(workbenchOperation)) {
        const prepared = prepareAgentDurableJobMutation({ tool: "director_workbench", operation: workbenchOperation });
        workbenchOperation = prepared.mutation.operation;
        agentBoundary = prepared.receipt;
      } else if (isWorkbenchMutation(workbenchOperation)) {
        const isProduction = workbenchOperation.op === "production";
        const secured = await securePlannedAgentMutation({
          response,
          planId,
          summary: operation.summary,
          sessionId: boundarySessionId,
          targetToken: targets?.workbench,
          missingMessage,
          disconnectedMessage,
          prepared: prepareAgentMutation(
            { tool: "director_workbench", operation: workbenchOperation },
            boundarySessionId,
          ),
          guardName: isProduction ? "制作修订号" : "项目修订号",
          observe: (targetToken) =>
            requestWorkbenchCommand(
              isProduction
                ? { op: "production", command: { action: "observe" } }
                : { op: "observe", fields: ["counts"] },
              undefined,
              targetToken,
            ),
          observedGuard: isProduction ? observedProductionRevision : observedWorkbenchRevision,
        });
        if (!secured) return;
        workbenchOperation = secured.mutation.operation as typeof workbenchOperation;
        agentBoundary = secured.receipt;
      }
      const remote = await requestPlannedBrowserCommand({
        response,
        planId,
        targetToken: targets?.workbench,
        summary: operation.summary,
        missingMessage,
        disconnectedMessage,
        unknownMessage: `${operation.summary}：浏览器未及时确认，项目结果未知。请刷新当前内容后重试。`,
        operationResults,
        request: (targetToken) => requestWorkbenchCommand(workbenchOperation, undefined, targetToken),
      });
      if (!remote) return;
      if (remote.response.stageScene !== undefined) {
        const parsedStage = parseStageScene(remote.response.stageScene);
        if (!parsedStage.success) {
          json(response, 502, {
            success: false,
            error: `${operation.summary}：工作台返回了无效的 Stage 投影`,
            code: "invalid_workbench_response",
          });
          return;
        }
        stagedScene = parsedStage.scene;
      }
      if (remote.response.project !== undefined) {
        const parsedProject = safeParseDirectorProject(remote.response.project);
        if (!parsedProject.success) {
          json(response, 502, {
            success: false,
            error: `${operation.summary}：${parsedProject.error}`,
            code: "invalid_workbench_response",
          });
          return;
        }
        await writeJsonAtomic(workbenchProjectPath, parsedProject.project);
        broadcastWorkbenchPeers(
          { type: "workbench-state", project: parsedProject.project, source: "agent" },
          remote.client,
        );
      }
      operationResults.push({
        id: operation.id,
        tool: operation.tool,
        result: remote.response.result,
        ...(agentBoundary ? { agent_boundary: agentBoundary } : {}),
      });

      // Delivery is opt-in. Ordinary author edits return after the mutation.
      if (workbenchOperation.op === "author" && workbenchOperation.delivery) {
        const deliveryBuild = buildAutomaticDeliveryOperation(workbenchOperation, remote.response.result);
        if (!deliveryBuild.success) {
          discardAgentPlan(planId);
          json(response, 502, {
            success: false,
            error: `${operation.summary}：${deliveryBuild.error}`,
            code: "invalid_workbench_response",
            result: { operations: operationResults, project_committed: true },
          });
          return;
        }

        let delivered: Awaited<ReturnType<typeof requestWorkbenchCommand>>;
        try {
          delivered = await requestWorkbenchCommand(deliveryBuild.operation, undefined, remote.target.token);
        } catch (error) {
          if (!isBrowserCommandTimeoutError(error)) throw error;
          json(response, 504, {
            success: false,
            error: `${operation.summary}：项目已提交，但交付超时；可以重新执行 deliver。`,
            code: "command_timeout",
            result: {
              operations: operationResults,
              project_committed: true,
              delivery_committed: false,
              retry_requires_observe: true,
            },
          });
          return;
        }
        if (!delivered) {
          discardAgentPlan(planId);
          json(response, 409, {
            success: false,
            error: `${operation.summary}：交付期间 Director 标签页已断开或切换`,
            code: "target_unavailable",
            result: { operations: operationResults, project_committed: true },
          });
          return;
        }
        if (!delivered.response.success) {
          const deliveryResult =
            delivered.response.result &&
            typeof delivered.response.result === "object" &&
            !Array.isArray(delivered.response.result)
              ? (delivered.response.result as Record<string, unknown>)
              : null;
          const deliveryCode = typeof deliveryResult?.code === "string" ? deliveryResult.code : "delivery_failed";
          discardAgentPlan(planId);
          json(response, deliveryCode === "stale_project_revision" ? 409 : 422, {
            success: false,
            error: `${operation.summary}：${delivered.response.error ?? "交付失败"}`,
            code: deliveryCode,
            result: {
              operations: operationResults,
              project_committed: true,
              delivery: delivered.response.result,
            },
          });
          return;
        }

        const deliveryCaptureDataUrl = delivered.response.captureDataUrl;
        const deliveryCapture = deliveryCaptureDataUrl ? parseCaptureDataUrl(deliveryCaptureDataUrl) : null;
        if (deliveryCapture) await savePreview(deliveryCapture);
        operationResults.push({
          id: `${operation.id}:delivery`,
          tool: operation.tool,
          result: {
            receipt: delivered.response.result,
            ...(deliveryCapture
              ? { preview_url: authenticatedDirectorPreviewUrl(`http://${host}:${port}`, previewSecret) }
              : {}),
          },
        });
      }
      continue;
    }
    if (operation.tool === "blender_native") {
      const parsedInput = blenderNativeToolRequestInputSchema.safeParse(operation.input);
      if (!parsedInput.success) {
        json(response, 422, {
          success: false,
          error: `${operation.summary}：blender_native 参数无效`,
          code: "plan_apply_failed",
        });
        return;
      }
      try {
        operationResults.push({
          id: operation.id,
          tool: operation.tool,
          result: await executeBlenderNativeTool(blenderNativeSession, parsedInput.data, {
            loadDirectorProject: () => readPersistedWorkbenchProject(),
          }),
        });
      } catch (error) {
        const outcomeUnknown = error instanceof BlenderNativeSessionError && error.code === "outcome_unknown";
        json(response, outcomeUnknown ? 409 : 422, {
          success: false,
          error: `${operation.summary}：${error instanceof Error ? error.message : String(error)}`,
          code: outcomeUnknown ? "outcome_unknown" : "plan_apply_failed",
          ...(outcomeUnknown && error.result ? { result: error.result } : {}),
        });
        return;
      }
      continue;
    }
    if (operation.tool === "stage_video") {
      videoOperations.push(operation);
      continue;
    }
    const execution = executeStageTool(stagedScene, operation.tool, operation.input, refs);
    if (!execution.success) {
      json(response, 422, {
        success: false,
        error: `${operation.summary}：${execution.error ?? "执行失败"}`,
        code: "plan_apply_failed",
      });
      return;
    }
    stagedScene = execution.scene;
    if (execution.events) events.push(...execution.events);
    operationResults.push({ id: operation.id, tool: operation.tool, result: execution.result });
  }

  const sceneChanged = JSON.stringify(stagedScene) !== JSON.stringify(scene);
  if (sceneChanged) {
    scene = stagedScene;
    await persistScene();
    broadcast({ type: "state", scene, source: "agent", events });
  }
  discardAgentPlan(planId);

  for (const operation of videoOperations) {
    const execution = await videoGenerationService.execute(scene, operation.input);
    if (!execution.success) {
      json(response, 502, {
        success: false,
        scene,
        error: `${operation.summary}：${execution.error ?? "视频任务失败"}`,
        code: "video_submit_failed",
        result: {
          scene_committed: sceneChanged,
          operations: operationResults,
          video_job: execution.result,
        },
      });
      return;
    }
    operationResults.push({ id: operation.id, tool: operation.tool, result: execution.result });
  }

  json(response, 200, {
    success: true,
    scene,
    events,
    result: { operations: operationResults, scene_committed: sceneChanged },
  });
}

function liveStageRouteDependencies(): Omit<StageRouteDependencies, "readBody" | "headers" | "json"> {
  return {
    getScene: () => scene,
    replaceScene: (nextScene) => {
      scene = nextScene;
    },
    persistScene,
    broadcast,
    broadcastExcept: (message, client) => {
      if (!(client instanceof WebSocket)) {
        throw new TypeError("Workbench route attempted to exclude a non-WebSocket client");
      }
      broadcastWorkbenchPeers(message, client);
    },
    readPreview: () => readFile(previewPath).catch(() => null),
    previewMimeType: () => previewMimeType,
    requestCapture,
    hasConnectedClient: () => clients.size > 0,
    savePreview,
    previewUrl: () => authenticatedDirectorPreviewUrl(`http://${host}:${port}`, previewSecret),
    refsForSession: (sessionId) => refSessions.get(sessionId),
    requestWorkbenchCommand,
    requestWorkbenchCapture,
    requestCreativeWorkspaceCommand,
    isTargetContractStale: (targetToken) => {
      const client = clientForTarget(targetToken);
      const registration = client ? workbenchClients.get(client) : undefined;
      return Boolean(registration?.contractStale);
    },
    persistWorkbenchProject: async (project, client) => {
      await writeJsonAtomic(workbenchProjectPath, project);
      if (!(client instanceof WebSocket)) {
        throw new TypeError("Workbench route attempted to persist a project for a non-WebSocket client");
      }
      await mirrorAgentProjectToSceneRecord(client, project);
      broadcastExcept({ type: "workbench-state", project, source: "agent" }, client);
    },
    loadDisconnectedWorkbenchSources: async () => ({
      project: await readPersistedWorkbenchProject(),
      blenderScene: await loadNativeSceneSnapshot(),
    }),
    executeVideoModel: (currentScene, input) => videoGenerationService.execute(currentScene, input),
    targetScheduler: agentTargetScheduler,
    recordTrace: (event) => {
      void agentTraceStore.record(event).catch((error) => {
        console.warn("Agent trace store rejected a tool trace event", error);
      });
    },
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (!trustedDirectorOrigin(origin, allowedBrowserOrigins)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "Origin is not allowed by the Director gateway.", code: "origin_denied" }));
      return;
    }
    if (origin) responseCorsOrigins.set(response, origin);
    if (request.method === "OPTIONS") {
      headers(response, 204);
      return response.end();
    }
    if (await handleGeneratedAssetRoute(request, response, url, generatedAssetRoot)) return;
    if (
      requiresDirectorGatewayAuth(request, url) &&
      !directorGatewayRequestAuthorized(request, url, gatewaySecret, previewSecret)
    ) {
      return json(response, 401, {
        error: "Director gateway authorization is required. Bootstrap this local client and retry.",
        code: "gateway_unauthorized",
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        ok: true,
        service: "director-stage-gateway",
        clients: clients.size,
        // Non-null when the durable scene snapshot was corrupt at startup and
        // got quarantined; operators recover it from `quarantinePath`.
        sceneRecovery,
      });
    }
    if (
      await handleControlPlaneRoute(request, response, url, {
        json,
        config: controlPlaneConfig,
        listAgentProfiles: () => agentProfileRegistry.list(),
        listAgentSessions: () => listAgentSessionTargets("director_workbench"),
        videoCapabilities: () => videoGenerationService.capabilities(),
        filmRole: () => process.env.DIRECTOR_FILM_ROLE?.trim() || null,
      })
    )
      return;
    if (
      await handleAgentApiProviderRoute(request, response, url, {
        readBody: body,
        json,
        store: agentApiProviderStore,
        environmentProfiles: controlPlaneConfig.agents.profiles,
        applyHostedProfiles: applyHostedApiProfiles,
      })
    )
      return;
    if (
      await handleAgentWorkspaceRoute(request, response, url, {
        readBody: body,
        json,
        store: agentWorkspaceStore,
      })
    )
      return;
    if (
      await handleMediaTranscriptionRoute(request, response, url, {
        readBody: body,
        json,
        store: productionJobStore,
        inputs: mediaTranscriptionRuntime.inputs,
        executor: mediaTranscriptionRuntime.executor,
        config: controlPlaneConfig.transcription,
        onBackgroundError: (error) => console.error("Media transcription failed", error),
      })
    )
      return;
    if (
      await handleGenerated3DRoute(request, response, url, {
        readBody: body,
        json,
        store: productionJobStore,
        providers: generated3dRuntime.providers,
        sources: generated3dRuntime.sources,
        executor: generated3dRuntime.executor,
        promotions: generated3dRuntime.promotions,
        sizeEstimator: assetSizeEstimator,
      })
    )
      return;
    if (
      await handleAssetSizeRoute(request, response, url, {
        readBody: body,
        json,
        sizeEstimator: assetSizeEstimator,
      })
    )
      return;
    if (
      await handleGenerationRoute(request, response, url, {
        readBody: body,
        json,
        store: productionJobStore,
        nodes: comfyGenerationRuntime.nodes,
        workflows: comfyGenerationRuntime.workflows,
        executor: comfyGenerationRuntime.executor,
        imagePromptExpander,
      })
    )
      return;
    if (
      await handleReferenceSceneRoute(request, response, url, {
        readBody: body,
        json,
        analyzer: referenceSceneAnalyzer,
      })
    )
      return;
    if (
      await handleCaptureReconstructionRoute(request, response, url, {
        readBody: body,
        json,
        store: productionJobStore,
        executor: captureReconstructionRuntime.executor,
        createJobId: () => `scenerecon-job-${crypto.randomUUID()}`,
        onBackgroundError: (error) => console.error("Capture reconstruction job failed", error),
      })
    )
      return;
    if (
      await handleProductionJobRoute(request, response, url, {
        readBody: body,
        json,
        store: productionJobStore,
        createJobId: () => `canvas-job-${crypto.randomUUID()}`,
        mediaTranscode: mediaTranscodeRuntime.executor,
        mediaInputs: mediaTranscodeRuntime.inputs,
        captureReconstruction: captureReconstructionRuntime.executor,
        artifactVersions: productionArtifactStore,
        onBackgroundError: (error) => console.error("Production job executor failed", error),
      })
    )
      return;
    if (
      await handleProductionArtifactRoute(request, response, url, {
        readBody: body,
        json,
        store: productionArtifactStore,
        now: () => new Date().toISOString(),
      })
    )
      return;
    if (
      await handleStorageOpsRoute(request, response, url, {
        readBody: body,
        json,
        service: storageOpsService,
      })
    )
      return;
    if (
      await handleCollaborationInviteRoute(request, response, url, {
        readBody: body,
        json,
        authorizer: collaborationRoomAuthorizer,
        inviteSecret: collaborationInviteSecret,
        revocations: collaborationRuntime.revocations,
      })
    )
      return;
    if (
      await handleCollaborationRoomRoute(request, response, url, {
        readBody: body,
        json,
        hub: collaborationHub,
        authorizer: collaborationRoomAuthorizer,
        snapshotStore: collaborationSnapshotStore,
        revocations: collaborationRuntime.revocations,
        emptyRoomTtlSeconds: collaborationRuntime.emptyRoomTtlSeconds,
      })
    )
      return;
    if (
      await handleMultiAgentRunRoute(request, response, url, {
        readBody: body,
        json,
        store: multiAgentRunStore,
        orchestrator: productionRunOrchestrator,
        profiles: agentProfileRegistry,
        isTargetAvailable: (target) => {
          const client = clientForTarget(target.token);
          return Boolean(client && sameDirectorAgentTarget(agentTargetForClient(client), target));
        },
      })
    )
      return;
    if (
      await handleFilmPipelineRoute(request, response, url, {
        readBody: body,
        json,
        store: filmPipeline.store,
        orchestrator: filmPipeline.orchestrator,
        unconfiguredReason: filmPipeline.unconfiguredReason,
      })
    )
      return;
    if (
      await handleGameRoute(request, response, url, {
        readBody: body,
        json,
        execute: directorGame.execute,
        governance: toolGovernance,
      })
    )
      return;
    if (
      await handleAgentTraceRoute(request, response, url, {
        json,
        store: agentTraceStore,
        listProductionJobs: () => productionJobStore.list(),
        listMultiAgentRuns: () => multiAgentRunStore.list(),
        listFilmRuns: () => filmPipeline.store.list(),
      })
    )
      return;
    if (
      await handleAssistantRoute(request, response, url, {
        readBody: body,
        json,
        plan: handleAssistantPlanRequest,
        apply: handleAssistantApplyRequest,
      })
    )
      return;
    if (request.method === "POST" && url.pathname === "/te-man/director/agent/bootstrap") {
      return json(
        response,
        200,
        directorAgentBootstrapWireSchema.parse({
          browserToken: gatewaySecret,
          service: "comfyui-3d-director-agent-gateway",
          health: directorAgentHealth(),
        }),
      );
    }
    if (request.method === "GET" && url.pathname === "/te-man/director/agent/health") {
      return json(response, 200, directorAgentHealth());
    }
    if (
      await handleBlenderLiveRoute(request, response, url, {
        assetRoot: generatedAssetRoot,
        bindDirectorProject: async ({ sessionId, targetToken }) => {
          let exactTarget =
            targetToken ?? (sessionId ? recallAgentSessionTarget("director_workbench", sessionId) : undefined);
          let remote = exactTarget
            ? await requestWorkbenchCommand({ op: "snapshot", scope: "project" }, undefined, exactTarget)
            : null;
          if (!remote && !targetToken) {
            const discovery = await requestWorkbenchCommand({ op: "observe", fields: ["counts"] });
            exactTarget = discovery?.target.token;
            remote = exactTarget
              ? await requestWorkbenchCommand({ op: "snapshot", scope: "project" }, undefined, exactTarget)
              : null;
          }
          if (!remote || !exactTarget) {
            const persisted = await readPersistedWorkbenchProject();
            const projectId = persisted?.nativeScene?.projectId;
            if (projectId) {
              await bindBlenderNativeSessionProject(blenderNativeSession, projectId);
              return;
            }
            throw new BlenderNativeSessionError(
              "No responsive Director project is available for this Blender operation.",
              503,
              "workbench_unavailable",
            );
          }
          if (sessionId) rememberAgentSessionTarget("director_workbench", sessionId, exactTarget);
          const result = remote?.response.result;
          const projectValue =
            result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>).project
              : undefined;
          const parsedProject = safeParseDirectorProject(projectValue);
          const projectId = parsedProject.success ? parsedProject.project.nativeScene?.projectId : undefined;
          if (!remote?.response.success || !projectId) {
            throw new BlenderNativeSessionError(
              "The bound Director project has no Blender scene identity.",
              409,
              "native_project_unbound",
            );
          }
          await bindBlenderNativeSessionProject(blenderNativeSession, projectId);
        },
        readBody: body,
        json,
        session: blenderNativeSession,
        loadDirectorProject: () => readPersistedWorkbenchProject(),
        governance: toolGovernance,
      })
    )
      return;
    if (
      await handleMotionGenerationRoute(request, response, url, {
        readBody: body,
        json,
        ardy: ardyMotionService,
      })
    )
      return;
    if (
      await handleDccRoute(request, response, url, {
        readBody: body,
        json,
        getProject: async () => {
          const remote = await requestWorkbenchCommand({ op: "snapshot", scope: "project" });
          const result = remote?.response.result;
          const liveProject =
            result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>).project
              : undefined;
          const parsedLive = safeParseDirectorProject(liveProject);
          if (parsedLive.success) {
            await writeJsonAtomic(workbenchProjectPath, parsedLive.project);
            return parsedLive.project;
          }
          return readFile(workbenchProjectPath, "utf8")
            .then((contents) => JSON.parse(contents) as unknown)
            .catch(() => null);
        },
        blender: blenderBridge,
        providers: dccProviders,
        exchangePackager: dccExchangePackager,
        sceneImporter: blenderSceneImporter,
        engineImporter: engineSceneImporter,
        returnImporter: blenderReturnImporter,
        engineBridge: dccEngineBridge,
        engineReturnImporters: dccEngineReturnImporters,
        unityLiveLink: unityLiveLinkHub,
        godotLiveLink: godotLiveLinkHub,
        applyAuthoring: async (operation) => {
          const remote = await requestWorkbenchCommand(operation);
          return remote
            ? {
                success: remote.response.success,
                ...(remote.response.result === undefined ? {} : { result: remote.response.result }),
                ...(remote.response.error ? { error: remote.response.error } : {}),
              }
            : null;
        },
        governance: toolGovernance,
      })
    )
      return;
    if (
      await handleProductionRoute(request, response, url, {
        readBody: body,
        json,
        readWorkbenchProjectFallback: () => readPersistedWorkbenchProject(),
        getProduction: () => productionStateStore.getProduction(),
        applyProductionUpdate: (mutation) =>
          productionMutationCoordinator.execute(
            () => productionStateStore.getProduction(),
            mutation,
            (next) => productionStateStore.commitProduction(next, mutation.sceneSeeds),
          ),
        getStageScene: () => scene,
        getSceneProject: (sceneId) => productionStateStore.getSceneProject(sceneId),
        saveSceneProject: (input) => productionStateStore.saveSceneProject(input),
      })
    )
      return;
    if (
      await handleStageRoute(request, response, url, {
        readBody: body,
        headers,
        json,
        ...liveStageRouteDependencies(),
        governance: toolGovernance,
      })
    )
      return;
    if (
      await handleSceneGenerationRoute(request, response, url, {
        readBody: body,
        json,
        resolveProvider: async (providerId) => resolveModelProvider(providerId),
        governance: toolGovernance,
      })
    )
      return;
    if (
      await handleAgentToolAuditRoute(request, response, url, {
        readBody: body,
        json,
        store: agentToolAuditStore,
      })
    )
      return;
    if (
      await handleAgentConfirmTokenRoute(request, response, url, {
        readBody: body,
        json,
        store: agentConfirmTokenStore,
      })
    )
      return;
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      // The client may still be streaming the rejected body on this socket.
      // Closing the connection keeps a poisoned keep-alive stream from
      // stalling the next request that would otherwise reuse it. The socket
      // is torn down only after the error response has been flushed.
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      return json(response, error.status, { error: error.message });
    }
    const reported = reportGatewayInternalFailure(error);
    return json(response, 500, { error: reported.publicMessage, code: reported.code, incidentId: reported.incidentId });
  }
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  if (url.pathname !== "/ws") return socket.destroy();
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  if (
    !trustedDirectorOrigin(origin, allowedBrowserOrigins) ||
    !directorGatewayTokenMatches(requestDirectorGatewayToken(request, url), gatewaySecret)
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  if (clients.size >= MAX_WEBSOCKET_CLIENTS) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  webSockets.handleUpgrade(request, socket, head, (client) => webSockets.emit("connection", client, request));
});

webSockets.on("connection", (client) => {
  clients.add(client);
  client.send(JSON.stringify({ type: "state", scene, source: "gateway" }));
  client.on("message", (data) => {
    try {
      const rawMessage: unknown = JSON.parse(data.toString());
      if (collaborationHub.handleUnknown(client, rawMessage)) return;
      const parsedMessage = terminalMessageSchema.safeParse(rawMessage);
      if (!parsedMessage.success) {
        const envelope = asRecord(rawMessage);
        const label = [
          typeof envelope?.type === "string" ? `type=${envelope.type.slice(0, 80)}` : null,
          typeof envelope?.requestId === "string" ? `requestId=${envelope.requestId.slice(0, 80)}` : null,
        ]
          .filter(Boolean)
          .join(" ");
        const issues = parsedMessage.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.map(String).join(".") || "$"}: ${issue.message}`)
          .join("; ");
        console.warn(`Director gateway dropped a browser websocket message${label ? ` (${label})` : ""}: ${issues}`);
        return;
      }
      const message = parsedMessage.data;
      if (message.type === "hello") {
        const previous = workbenchClients.get(client);
        const sameTarget =
          previous?.clientId === message.client_id &&
          previous.instanceId === message.instance_id &&
          previous.sceneId === message.scene_id &&
          previous.creativeScopeId === message.creative_scope_id;
        if (previous && !sameTarget) cancelTargetWaiters(client);
        const identityKey = workbenchIdentityKey(message);
        let targetToken = sameTarget ? previous.targetToken : workbenchIdentityTokens.get(identityKey);
        if (!sameTarget && targetToken) {
          for (const [peer, registration] of workbenchClients) {
            if (peer === client || registration.targetToken !== targetToken) continue;
            const samePeerIdentity =
              registration.clientId === message.client_id &&
              registration.instanceId === message.instance_id &&
              registration.sceneId === message.scene_id &&
              registration.creativeScopeId === message.creative_scope_id;
            if (samePeerIdentity) {
              // A reloading tab reconnected before its old socket closed. Move
              // the stable token to the new socket so agent bindings survive.
              registration.targetToken = crypto.randomUUID();
              cancelTargetWaiters(peer);
            } else {
              targetToken = undefined;
            }
          }
        }
        if (!targetToken) targetToken = crypto.randomUUID();
        workbenchIdentityTokens.set(identityKey, targetToken);
        // A tab without a fingerprint predates this check and stays best-effort;
        // a mismatched fingerprint marks the tab stale so mutations are refused
        // instead of silently dropping fields its bundle does not know.
        const contractStale =
          message.contract_fingerprint !== undefined &&
          message.contract_fingerprint !== DIRECTOR_WORKBENCH_CONTRACT_FINGERPRINT;
        if (contractStale && previous?.contractStale !== true) {
          console.warn(
            `Director tab ${message.client_id} announced contract ${message.contract_fingerprint}; gateway expects ${DIRECTOR_WORKBENCH_CONTRACT_FINGERPRINT}. Mutations toward it are refused until the tab reloads.`,
          );
        }
        workbenchClients.set(client, {
          visible: message.visible ?? true,
          lastSeenAt: Date.now(),
          targetToken,
          clientId: message.client_id,
          instanceId: message.instance_id,
          sceneId: message.scene_id,
          creativeScopeId: message.creative_scope_id,
          contractVersion: message.contract_version,
          workspace: message.workspace ?? "unknown",
          captureReady: message.capture_ready === true,
          contractStale,
        });
        const target = agentTargetForClient(client);
        if (target) client.send(JSON.stringify({ type: "target-bound", target }));
      } else if (message.type === "workbench-command-response") {
        const waiter = workbenchWaiters.get(message.requestId);
        if (waiter?.client === client && sameDirectorAgentTarget(waiter.target, message.target)) {
          waiter.resolve(message);
        } else if (waiter?.client === client) {
          waiter.resolve(null);
        }
      } else if (message.type === "creative-workspace-command-response") {
        const waiter = creativeWorkspaceWaiters.get(message.requestId);
        if (waiter?.client === client && sameDirectorAgentTarget(waiter.target, message.target)) {
          waiter.resolve(message);
        } else if (waiter?.client === client) {
          waiter.resolve(null);
        }
      } else if (message.type === "capture-response" && message.requestId) {
        captureWaiters.get(message.requestId)?.(message.dataUrl ?? null);
      } else if (message.type === "term.open" || message.type === "term.input" || message.type === "term.resize") {
        terminalSessions.handle(client, message);
      }
    } catch {
      // Ignore malformed client events.
    }
  });
  client.on("close", () => {
    collaborationHub.disconnect(client);
    terminalSessions.close(client);
    cancelTargetWaiters(client);
    workbenchClients.delete(client);
    clients.delete(client);
  });
  client.on("error", () => {
    collaborationHub.disconnect(client);
    terminalSessions.close(client);
    cancelTargetWaiters(client);
    workbenchClients.delete(client);
    clients.delete(client);
  });
});

registerBuiltinProviders();

server.listen(port, host, () => {
  console.log(`Director Stage gateway ready at http://${host}:${port}`);
  void reconcileOutcomeUnknownJobs(productionJobStore, [comfyGenerationRuntime.executor, generated3dRuntime.executor]);
});

server.on("close", () => {
  collaborationHub.destroy();
});
