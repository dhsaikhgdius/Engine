// Gateway bootstrap — creates and wires all services.
// Extracted from agent-gateway.ts to keep the entry point thin.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { z } from "zod";
import type { ServerResponse } from "node:http";

import agentPlanSchema from "./agentPlanSchema.json";
import { writeJsonAtomic } from "./atomicJsonFile";
import { createDefaultScene } from "@director/stage-protocol";
import { parseStageScene } from "@director/stage-protocol";
import type { StageScene } from "@director/stage-protocol";
import { directorAuthoringActionSchema } from "@director/agent-engine";
import { DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION } from "./plannerDraft";
import {
  creativeWorkspaceAgentOperationNames,
  creativeWorkspaceAgentRequestSchema,
} from "../../packages/protocol/src/creativeWorkspaceProtocol";
import type { DirectorAgentTarget, StageCapturePayload } from "@director/agent-engine";

import { loadDirectorControlPlaneConfig } from "./controlPlane/controlPlaneConfig";
import {
  createDirectorGatewaySecret,
  createDirectorPreviewSecret,
  directorAllowedOrigins,
  authenticatedDirectorPreviewUrl,
  directorGatewayRequestAuthorized,
  directorGatewayTokenMatches,
  requestDirectorGatewayToken,
  requiresDirectorGatewayAuth,
  trustedDirectorOrigin,
} from "./gatewayAuth";
import { RefSessionRegistry } from "./refSessions";
import { TerminalSessionManager } from "./terminalSessionManager";
import { DirectorCollaborationWebSocketHub } from "./collaborationWebSocketHub";
import { createCollaborationRoomAuthorizer } from "./collaborationRoomAuth";
import { CollaborationSnapshotStore } from "./collaboration/collaborationSnapshotStore";
import { createBlenderBridge } from "./dcc/blenderBridge";
import { createBlenderReturnImporter, createDccReturnImporter } from "./dcc/blenderReturnImport";
import { createBlenderSceneImporter } from "./dcc/blenderSceneImport";
import { createDirectorDccEngineBridge } from "./dcc/engineBridge";
import { createEngineSceneImporter } from "./dcc/engineSceneImport";
import { createDirectorDccProviderRegistry, registerConfiguredDirectorDccProviders } from "./dcc/dccProviderRegistry";
import { createDirectorDccExchangePackager } from "./dcc/dccExchangePackage";
import { createBlenderNativeSession } from "./dcc/blenderNativeSession";
import { AgentProfileRegistry } from "./agents/agentProfileRegistry";
import { probeLocalAgentCliAvailability } from "./agents/localAgentCliAvailability";
import { createFilmPipeline } from "./film/createFilmPipeline";
import { createVideoGenerationService } from "./video/createVideoGenerationService";
import { ProductionJobStore } from "./jobs/productionJobStore";
import { ProductionArtifactStore } from "./artifacts/productionArtifactStore";
import { ProductionStateStore } from "./production/productionStateStore";
import { ProductionMutationCoordinator } from "./production/productionMutationCoordinator";
import { createReferenceSceneAnalyzer } from "./reconstruction/referenceSceneAnalyzer";
import { createMediaTranscriptionRuntime } from "./transcription/createMediaTranscriptionRuntime";
import { createMediaTranscodeRuntime } from "./media/createMediaTranscodeRuntime";
import { createComfyGenerationRuntime } from "./generation/createComfyGenerationRuntime";
import { createGenerated3DRuntime } from "./generation/createGenerated3DRuntime";
import { createAssetSizeEstimator, createImagePromptExpander } from "./promptExpansion/createPromptExpanders";
import { ArdyMotionService } from "./motion/ardyMotionService";
import { rankUntargetedWorkbenchClients, type DirectorBrowserWorkspace } from "./workbenchClientRouting";
import type { TerminalMessage } from "./gatewaySchemas";
import { Container, loadPlugins } from "@director/di";
import { gatewayPlugins } from "./gatewayPlugin";

// ---- Types ----

/** Registration metadata for a connected Director browser workbench tab. */
export type WorkbenchClientRegistration = {
  visible: boolean;
  lastSeenAt: number;
  targetToken: string;
  clientId: string;
  instanceId: string;
  sceneId: string;
  creativeScopeId: string;
  contractVersion: 2;
  workspace: DirectorBrowserWorkspace;
  captureReady: boolean;
  /** True when the tab's bundled contract fingerprint mismatches this gateway. */
  contractStale: boolean;
};

/** A terminal message indicating a workbench command completed. */
export type WorkbenchCommandResponse = Extract<TerminalMessage, { type: "workbench-command-response" }>;
/** A terminal message indicating a creative workspace command completed. */
export type CreativeWorkspaceCommandResponse = Extract<
  TerminalMessage,
  { type: "creative-workspace-command-response" }
>;
/** The browser command channel discriminator. */
export type BrowserCommandChannel = "workbench" | "creative";

/** A pending browser command with its WebSocket client, agent target, and resolution callback. */
export type BrowserCommandWaiter<Response> = {
  client: WebSocket;
  target: DirectorAgentTarget;
  resolve: (response: Response | null) => void;
};

/** Agent-targeted browser tabs for a plan execution. */
export type PlannedAgentTargets = { workbench?: string; creative?: string };
/** A time-bounded lease on planned agent targets. */
export type PlannedAgentTargetLease = { targets: PlannedAgentTargets; expiresAt: number };

// ---- Gateway context ----

/**
 * The dependency-injection context for the entire gateway process. All
 * services, configuration, and mutable registries are wired through this
 * single object, assembled by {@link createGatewayContext}.
 */
export interface GatewayContext {
  // Paths
  /** Repository root directory. */
  root: string;
  /** Runtime data directory (persisted across restarts). */
  dataDirectory: string;
  /** Path to the stage scene JSON file. */
  scenePath: string;
  /** Path to the latest preview render. */
  previewPath: string;
  /** Path to the agent plan JSON Schema file. */
  agentPlanSchemaPath: string;
  /** Root directory for generated assets. */
  generatedAssetRoot: string;
  /** Path to the workbench project JSON file. */
  workbenchProjectPath: string;

  // Config
  /** HTTP port the gateway listens on. */
  port: number;
  /** HTTP host the gateway binds to. */
  host: string;
  /** The master gateway authentication token. */
  gatewaySecret: string;
  /** A process-epoch read-only preview capability token. */
  previewSecret: string;
  /** A UUID that changes on every gateway restart, used to invalidate stale client connections. */
  gatewayEpoch: string;
  /** Origins allowed for CORS and WebSocket upgrades. */
  allowedBrowserOrigins: Set<string>;

  // Auth
  /** Constructs an authenticated preview URL for the given base. */
  authenticatedDirectorPreviewUrl: typeof authenticatedDirectorPreviewUrl;
  /** Returns whether the request is authorized for the protected route. */
  directorGatewayRequestAuthorized: typeof directorGatewayRequestAuthorized;
  /** Timing-safe comparison of a provided token against the expected token. */
  directorGatewayTokenMatches: typeof directorGatewayTokenMatches;
  /** Extracts the gateway token from request headers or query params. */
  requestDirectorGatewayToken: typeof requestDirectorGatewayToken;
  /** Returns whether the request path requires gateway authentication. */
  requiresDirectorGatewayAuth: typeof requiresDirectorGatewayAuth;
  /** Returns whether the origin is in the trusted set. */
  trustedDirectorOrigin: typeof trustedDirectorOrigin;

  // Mutable state
  /** Maps HTTP responses to their resolved CORS origin. */
  responseCorsOrigins: WeakMap<ServerResponse, string>;
  /** All connected WebSocket clients. */
  clients: Set<WebSocket>;
  /** Pending capture waiters keyed by request ID. */
  captureWaiters: Map<string, (dataUrl: string | null) => void>;
  /** Registered workbench browser tabs. */
  workbenchClients: Map<WebSocket, WorkbenchClientRegistration>;
  /** Stable identity tokens for workbench tabs. */
  workbenchIdentityTokens: Map<string, string>;
  /** Pending workbench command waiters. */
  workbenchWaiters: Map<string, BrowserCommandWaiter<WorkbenchCommandResponse>>;
  /** Pending creative workspace command waiters. */
  creativeWorkspaceWaiters: Map<string, BrowserCommandWaiter<CreativeWorkspaceCommandResponse>>;
  /** Time-bounded agent target leases set by plan execution. */
  plannedAgentTargets: Map<string, PlannedAgentTargetLease>;
  /** The MIME type of the latest preview capture. */
  previewMimeType: StageCapturePayload["mimeType"];
  /** The live stage scene object. */
  scene: StageScene;

  // Constants
  /** The terminal message types for browser command requests. */
  BROWSER_COMMAND_REQUEST_TYPE: {
    workbench: "workbench-command-request";
    creative: "creative-workspace-command-request";
  };
  /** Maximum time an agent plan process may run before being killed. */
  AGENT_PLAN_TIMEOUT_MS: number;
  /** Grace period after timeout before SIGKILL. */
  AGENT_PLAN_KILL_GRACE_MS: number;
  /** Maximum bytes of stdout to capture per plan. */
  AGENT_PLAN_STDOUT_MAX_BYTES: number;
  /** Maximum bytes of stderr to capture per plan. */
  AGENT_PLAN_STDERR_MAX_BYTES: number;
  /** Time-to-live for cached plan data. */
  AGENT_PLAN_TTL_MS: number;
  /** Maximum concurrent WebSocket connections. */
  MAX_WEBSOCKET_CLIENTS: number;
  /** JSON Schema for the director authoring action, serialized as a string. */
  DIRECTOR_AUTHORING_ACTION_SCHEMA_JSON: string;
  /** JSON Schema for the creative workspace request, serialized as a string. */
  CREATIVE_WORKSPACE_REQUEST_SCHEMA_JSON: string;
  /** The agent plan JSON Schema object. */
  AGENT_PLAN_SCHEMA: Record<string, unknown>;

  // Services
  /** Registry for ref-based terminal sessions. */
  refSessions: RefSessionRegistry;
  /** Manager for agent terminal sessions. */
  terminalSessions: TerminalSessionManager;
  /** WebSocket hub for collaborative editing rooms. */
  collaborationHub: DirectorCollaborationWebSocketHub;
  /** Bridge to the local Blender DCC instance. */
  blenderBridge: ReturnType<typeof createBlenderBridge>;
  /** Importer for Blender-to-Director return workflows. */
  blenderReturnImporter: ReturnType<typeof createBlenderReturnImporter>;
  /** Importer for Blender scene files. */
  blenderSceneImporter: ReturnType<typeof createBlenderSceneImporter>;
  /** Importer for Unreal / Unity engine scene packages. */
  engineSceneImporter: ReturnType<typeof createEngineSceneImporter>;
  /** Registry of configured DCC providers. */
  dccProviders: ReturnType<typeof createDirectorDccProviderRegistry>;
  /** Packager for DCC exchange files. */
  dccExchangePackager: ReturnType<typeof createDirectorDccExchangePackager>;
  /** Headless engine connector bridge for Unreal/Unity/Godot. */
  dccEngineBridge: ReturnType<typeof createDirectorDccEngineBridge>;
  /** Per-engine return importers for engine round trips. */
  dccEngineReturnImporters: Record<"unreal" | "unity" | "godot", ReturnType<typeof createDccReturnImporter>>;
  /** Native Blender session for live Blender operations. */
  blenderNativeSession: ReturnType<typeof createBlenderNativeSession>;
  /** Registry of agent profile definitions. */
  agentProfileRegistry: AgentProfileRegistry;
  /** The film production pipeline service. */
  filmPipeline: ReturnType<typeof createFilmPipeline>;
  /** Video generation service. */
  videoGenerationService: ReturnType<typeof createVideoGenerationService>;
  /** Motion service for character animation. */
  ardyMotionService: ArdyMotionService;
  /** Persistent store for production jobs. */
  productionJobStore: ProductionJobStore;
  /** Persistent store for production artifacts. */
  productionArtifactStore: ProductionArtifactStore;
  /** Persistent store for production state. */
  productionStateStore: ProductionStateStore;
  /** Coordinator for production mutations. */
  productionMutationCoordinator: ProductionMutationCoordinator;
  /** Analyzer for reference scene images. */
  referenceSceneAnalyzer: ReturnType<typeof createReferenceSceneAnalyzer>;
  /** Runtime for media transcription jobs. */
  mediaTranscriptionRuntime: ReturnType<typeof createMediaTranscriptionRuntime>;
  /** Runtime for media transcoding jobs. */
  mediaTranscodeRuntime: ReturnType<typeof createMediaTranscodeRuntime>;
  /** Runtime for ComfyUI generation jobs. */
  comfyGenerationRuntime: ReturnType<typeof createComfyGenerationRuntime>;
  /** Runtime for generated 3D asset jobs. */
  generated3dRuntime: ReturnType<typeof createGenerated3DRuntime>;
  /** Expander for image generation prompts. */
  imagePromptExpander: ReturnType<typeof createImagePromptExpander>;
  /** Estimator for generated asset file sizes. */
  assetSizeEstimator: ReturnType<typeof createAssetSizeEstimator>;
  /** Factory for the default production record. */
  defaultProduction: () => Record<string, unknown>;
  /** DI container for plugin-based services. */
  container?: Container;
}

// ---- Bootstrap ----

/**
 * Derives a stable identity key from a workbench client's identifying fields.
 * Used to deduplicate reconnecting tabs across ephemeral WebSocket connections.
 */
export function workbenchIdentityKey(identity: {
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

/**
 * Creates and wires all gateway services into a single {@link GatewayContext}.
 * Loads the control-plane config, initializes the SQLite session store, starts
 * DCC providers, and assembles the full dependency graph.
 *
 * Must be called once at gateway startup. The returned context owns all
 * service lifecycles.
 *
 * @returns A fully wired gateway context.
 */
export async function createGatewayContext(): Promise<GatewayContext> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const controlPlaneConfig = loadDirectorControlPlaneConfig(root);
  const dataDirectory = controlPlaneConfig.dataDirectory;
  const scenePath = resolve(dataDirectory, "stage-scene.json");
  const previewPath = resolve(dataDirectory, "latest-preview.png");
  const agentPlanSchemaPath = resolve(dataDirectory, "director-agent-plan.schema.json");
  const workbenchProjectPath = resolve(dataDirectory, "director-workbench.json");
  const generatedAssetRoot = resolve(root, "assets", "generated");
  const port = controlPlaneConfig.http.port;
  const host = controlPlaneConfig.http.host;
  const gatewaySecret = createDirectorGatewaySecret();
  const previewSecret = createDirectorPreviewSecret();
  const gatewayEpoch = crypto.randomUUID();

  process.env.DIRECTOR_GATEWAY_TOKEN = gatewaySecret;

  // ---- Services ----
  const refSessions = new RefSessionRegistry();
  const terminalSessions = new TerminalSessionManager(root);
  const collaborationSnapshotStore =
    process.env.DIRECTOR_COLLAB_PERSISTENCE?.trim() === "1" ? new CollaborationSnapshotStore(dataDirectory) : null;
  const collaborationHub = new DirectorCollaborationWebSocketHub({
    authorizer: createCollaborationRoomAuthorizer({
      secret: process.env.DIRECTOR_COLLAB_INVITE_SECRET?.trim() || gatewaySecret,
    }),
    ...(collaborationSnapshotStore ? { persistence: collaborationSnapshotStore } : {}),
  });
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
  const dccEngineReturnImporters = {
    unreal: createDccReturnImporter({ workspaceRoot: root, dataDirectory, provider: "unreal" }),
    unity: createDccReturnImporter({ workspaceRoot: root, dataDirectory, provider: "unity" }),
    godot: createDccReturnImporter({ workspaceRoot: root, dataDirectory, provider: "godot" }),
  } as const;
  const dccProviders = createDirectorDccProviderRegistry({
    blender: blenderBridge,
    engines: dccEngineBridge,
    workspaceRoot: root,
  });
  await registerConfiguredDirectorDccProviders(dccProviders, { workspaceRoot: root });
  const blenderNativeSession = createBlenderNativeSession(controlPlaneConfig.dcc.blender);

  // Agent plan schema
  const DIRECTOR_AUTHORING_ACTION_SCHEMA_JSON = JSON.stringify(z.toJSONSchema(directorAuthoringActionSchema));
  const CREATIVE_WORKSPACE_REQUEST_SCHEMA_JSON = JSON.stringify(z.toJSONSchema(creativeWorkspaceAgentRequestSchema));
  const AGENT_PLAN_SCHEMA = structuredClone(agentPlanSchema) as any;
  AGENT_PLAN_SCHEMA.properties.operations.items.properties.input_json.description =
    DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION;

  await mkdir(dataDirectory, { recursive: true });
  await writeJsonAtomic(agentPlanSchemaPath, AGENT_PLAN_SCHEMA, { space: 0 });

  const agentProfileRegistry = new AgentProfileRegistry(controlPlaneConfig, probeLocalAgentCliAvailability());
  const referenceSceneAnalyzer = createReferenceSceneAnalyzer({ profiles: agentProfileRegistry });

  // filmPipeline needs workbenchExecute which requires requestWorkbenchCommand — inject later
  const filmPipeline = null as unknown as ReturnType<typeof createFilmPipeline>;

  const videoGenerationService = createVideoGenerationService(
    controlPlaneConfig,
    dataDirectory,
    () => Promise.resolve(null), // capture function injected later
  );

  const ardyMotionService = new ArdyMotionService({
    config: controlPlaneConfig.motion.ardy,
    dataDirectory,
  });

  const productionJobStore = new ProductionJobStore(dataDirectory);
  const mediaTranscriptionRuntime = createMediaTranscriptionRuntime(
    controlPlaneConfig,
    dataDirectory,
    productionJobStore,
  );
  const mediaTranscodeRuntime = createMediaTranscodeRuntime(controlPlaneConfig, dataDirectory, productionJobStore);
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

  let scene: StageScene = await readFile(scenePath, "utf8")
    .then((contents) => {
      const parsed = parseStageScene(JSON.parse(contents));
      return parsed.success ? parsed.scene : createDefaultScene();
    })
    .catch(() => createDefaultScene());

  const defaultProduction = (): {
    productionId: string;
    revision: number;
    updatedAt: null;
    updatedBy: null;
    production: { version: number; title: string; activeSceneId: null; scenes: never[]; editorialTimeline: never[] };
  } => ({
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
    statePath: resolve(dataDirectory, "director-production-state.json"),
    legacyManifestPath: resolve(dataDirectory, "director-production.json"),
    defaultProduction: defaultProduction() as any,
  });

  const productionMutationCoordinator = new ProductionMutationCoordinator();

  const ctx: GatewayContext = {
    root,
    dataDirectory,
    scenePath,
    previewPath,
    agentPlanSchemaPath,
    generatedAssetRoot,
    workbenchProjectPath,
    port,
    host,
    gatewaySecret,
    previewSecret,
    gatewayEpoch,
    allowedBrowserOrigins: directorAllowedOrigins(),
    authenticatedDirectorPreviewUrl,
    directorGatewayRequestAuthorized,
    directorGatewayTokenMatches,
    requestDirectorGatewayToken,
    requiresDirectorGatewayAuth,
    trustedDirectorOrigin,
    responseCorsOrigins: new WeakMap(),
    clients: new Set(),
    captureWaiters: new Map(),
    workbenchClients: new Map(),
    workbenchIdentityTokens: new Map(),
    workbenchWaiters: new Map(),
    creativeWorkspaceWaiters: new Map(),
    plannedAgentTargets: new Map(),
    previewMimeType: "image/png" as StageCapturePayload["mimeType"],
    scene,
    BROWSER_COMMAND_REQUEST_TYPE: {
      workbench: "workbench-command-request",
      creative: "creative-workspace-command-request",
    } as const,
    AGENT_PLAN_TIMEOUT_MS: 90_000,
    AGENT_PLAN_KILL_GRACE_MS: 5_000,
    AGENT_PLAN_STDOUT_MAX_BYTES: 1024 * 1024,
    AGENT_PLAN_STDERR_MAX_BYTES: 64 * 1024,
    AGENT_PLAN_TTL_MS: 10 * 60_000,
    MAX_WEBSOCKET_CLIENTS: 64,
    DIRECTOR_AUTHORING_ACTION_SCHEMA_JSON,
    CREATIVE_WORKSPACE_REQUEST_SCHEMA_JSON,
    AGENT_PLAN_SCHEMA: AGENT_PLAN_SCHEMA as Record<string, unknown>,
    refSessions,
    terminalSessions,
    collaborationHub,
    blenderBridge,
    blenderReturnImporter,
    blenderSceneImporter,
    engineSceneImporter,
    dccProviders,
    dccExchangePackager,
    dccEngineBridge,
    dccEngineReturnImporters,
    blenderNativeSession,
    agentProfileRegistry,
    filmPipeline,
    videoGenerationService,
    ardyMotionService,
    productionJobStore,
    productionArtifactStore,
    productionStateStore,
    productionMutationCoordinator,
    referenceSceneAnalyzer,
    mediaTranscriptionRuntime,
    mediaTranscodeRuntime,
    comfyGenerationRuntime,
    generated3dRuntime,
    imagePromptExpander,
    assetSizeEstimator,
    defaultProduction,
  };

  // Initialize DI container with gateway plugins
  const container = new Container();
  await loadPlugins(container, gatewayPlugins);
  (ctx as GatewayContext).container = container;

  return ctx;
}
