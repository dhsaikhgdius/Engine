import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  directorDccEngineIdSchema,
  directorDccOperationSchema,
  directorEngineSessionCommandResultSchema,
  type DirectorEngineSessionSceneSnapshot,
  type DirectorDccEngineId,
} from "@director/dcc-protocol";
import { safeParseDirectorProject } from "@director/project-schema";
import { directorProjectSchema, type DirectorProject } from "@director/project-schema";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { directorEngineSceneProviderSchema } from "@director/dcc-protocol";
import type { BlenderBridge } from "../dcc/blenderBridge";
import { DirectorBlendSceneImportError, type BlenderSceneImporter } from "../dcc/blenderSceneImport";
import { DirectorEngineSceneImportError, type EngineSceneImporter } from "../dcc/engineSceneImport";
import {
  DirectorDccImportError,
  type DccReturnImporter,
  type DirectorDccAuthoringResponse,
} from "../dcc/blenderReturnImport";
import { directorWorkbenchOperationSchema, type DirectorWorkbenchOperation } from "@director/agent-engine";
import { directorDccProviderIdSchema } from "@director/dcc-protocol";
import type { DirectorDccProviderRegistry } from "../dcc/dccProviderRegistry";
import { DirectorDccExchangePackageError, type DirectorDccExchangePackager } from "../dcc/dccExchangePackage";
import { DirectorDccEngineBridgeError, type DirectorDccEngineBridge } from "../dcc/engineBridge";
import {
  evaluateHttpToolGovernance,
  recordRejectedHttpToolCall,
  withHttpToolAudit,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";
import {
  UnityLiveLinkError,
  unityLiveLinkCommandResultSchema,
  unityLiveLinkEventPayloadSchema,
  type UnityLiveLinkHub,
} from "../dcc/unityLiveLink";
import { DirectorGodotLiveLinkError, type GodotLiveLinkHub } from "../dcc/godotLiveLink";
import { DirectorUnrealLivePreviewHubError, type UnrealLivePreviewHub } from "../dcc/unrealLivePreviewHub";
import { DirectorDccEngineRunError, type DirectorDccEngineRunManager } from "../dcc/engineRun";
import type { DirectorDccEngineFrameRenderer } from "../dcc/engineCapture";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const envelopeSchema = z.looseObject({
  input: z.unknown().optional(),
  session_id: z.string().trim().min(1).max(160).optional(),
});

const skipDirectorIdsSchema = z.array(z.string().trim().min(1).max(200)).max(20_000);

/**
 * import_return_package and receive_from_engine accept an optional
 * skip_director_ids list on top of the strict shared operation schema;
 * extract it before strict parsing rejects it.
 */
function extractSkipDirectorIds(input: unknown): {
  operationInput: unknown;
  skipDirectorIds?: string[];
  error?: string;
} {
  const op =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).op : undefined;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (op !== "import_return_package" && op !== "receive_from_engine") ||
    !("skip_director_ids" in input)
  ) {
    return { operationInput: input };
  }
  const { skip_director_ids: rawSkipDirectorIds, ...operationInput } = input as Record<string, unknown>;
  const parsed = skipDirectorIdsSchema.safeParse(rawSkipDirectorIds);
  if (!parsed.success) {
    return {
      operationInput,
      error: "Invalid director_dcc input at skip_director_ids: expected an array of non-empty director_id strings.",
    };
  }
  return { operationInput, skipDirectorIds: parsed.data };
}

export interface DccRouteDependencies {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  getProject: () => Promise<unknown>;
  blender: BlenderBridge;
  providers?: DirectorDccProviderRegistry;
  exchangePackager?: DirectorDccExchangePackager;
  sceneImporter?: BlenderSceneImporter;
  engineImporter?: EngineSceneImporter;
  returnImporter?: DccReturnImporter;
  /** Headless engine connector bridge for Unreal/Unity/Godot send jobs. */
  engineBridge?: DirectorDccEngineBridge;
  /** Per-engine return importers scoped to each engine's job root. */
  engineReturnImporters?: Partial<Record<DirectorDccEngineId, DccReturnImporter>>;
  /** Director → Unity live preview hub (outbound-only polling, never authoritative). */
  unityLiveLink?: UnityLiveLinkHub;
  /** In-memory Godot live-link preview hub (outbound-only transport, never authoritative). */
  godotLiveLink?: GodotLiveLinkHub;
  /** Gateway → Unreal editor loopback preview plus opt-in workshop commands. */
  unrealLivePreview?: UnrealLivePreviewHub;
  /** Engine editor launches and bounded-output project runs (fixed argv, trusted local). */
  engineRun?: DirectorDccEngineRunManager;
  /** On-demand engine frame renders (the engine-side perception primitive). */
  engineFrames?: DirectorDccEngineFrameRenderer;
  applyAuthoring?: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
}

const UNITY_LIVE_LINK_SESSIONS_PATH = "/api/dcc/unity/live-link/sessions";

const unityLiveLinkCreateSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  allowCode: z.boolean().optional().default(false),
  authority: z.enum(["director", "engine"]).optional().default("director"),
});

const unityLiveLinkPublishSchema = z.strictObject({
  events: z.array(unityLiveLinkEventPayloadSchema).min(1).max(64),
});

const unityLiveLinkPollQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  wait_ms: z.coerce.number().int().min(0).max(55_000).default(25_000),
});

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function matrixFromReviewTransform(transform: DirectorEngineSessionSceneSnapshot["entities"][number]["transform"]) {
  return new Matrix4().compose(
    new Vector3(...transform.location),
    new Quaternion(...transform.rotationQuaternion).normalize(),
    new Vector3(...transform.scale),
  );
}

function sceneMatrix(project: DirectorProject) {
  return new Matrix4().compose(
    new Vector3(...project.scene.position),
    new Quaternion().setFromEuler(new Euler(...project.scene.rotation, "XYZ")),
    new Vector3(project.scene.scale, project.scene.scale, project.scene.scale),
  );
}

function localTransformFromEngine(
  transform: DirectorEngineSessionSceneSnapshot["entities"][number]["transform"],
  inverseScene: Matrix4,
) {
  const local = inverseScene.clone().multiply(matrixFromReviewTransform(transform));
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  local.decompose(position, rotation, scale);
  const euler = new Euler().setFromQuaternion(rotation.normalize(), "XYZ");
  return {
    position: [position.x, position.y, position.z] as [number, number, number],
    rotation: [euler.x, euler.y, euler.z] as [number, number, number],
    scale: [scale.x, scale.y, scale.z] as [number, number, number],
  };
}

function projectEngineSnapshotForReview(
  project: DirectorProject,
  snapshot: DirectorEngineSessionSceneSnapshot,
  sessionId: string,
) {
  const next = structuredClone(project);
  const inverseScene = sceneMatrix(project).invert();
  let syncedEntityCount = 0;
  let skippedEntityCount = 0;

  for (const entity of snapshot.entities) {
    if (entity.entityType === "object") {
      const object = next.objects.find((candidate) => candidate.id === entity.directorId);
      if (!object) {
        skippedEntityCount += 1;
        continue;
      }
      object.transform = localTransformFromEngine(entity.transform, inverseScene);
      syncedEntityCount += 1;
      continue;
    }

    const worldPosition = new Vector3(...entity.transform.location);
    const worldRotation = new Quaternion(...entity.transform.rotationQuaternion).normalize();
    const localPosition = worldPosition.clone().applyMatrix4(inverseScene);
    const forward = new Vector3(0, 0, -1).applyQuaternion(worldRotation).normalize();

    if (entity.entityType === "camera") {
      const camera = next.cameras.find((candidate) => candidate.id === entity.directorId);
      if (!camera) {
        skippedEntityCount += 1;
        continue;
      }
      const aimDistance = Math.max(
        0.1,
        new Vector3(...camera.target).distanceTo(new Vector3(...camera.transform.position)),
      );
      camera.transform = localTransformFromEngine(entity.transform, inverseScene);
      const localTarget = worldPosition.clone().addScaledVector(forward, aimDistance).applyMatrix4(inverseScene);
      camera.target = [localTarget.x, localTarget.y, localTarget.z];
      syncedEntityCount += 1;
      continue;
    }

    const light = next.lights?.find((candidate) => candidate.id === entity.directorId);
    if (!light) {
      skippedEntityCount += 1;
      continue;
    }
    const previousLightPosition = light.position ? new Vector3(...light.position) : null;
    if (previousLightPosition) {
      light.position = [localPosition.x, localPosition.y, localPosition.z];
    }
    if (light.target && previousLightPosition) {
      const aimDistance = Math.max(0.1, new Vector3(...light.target).distanceTo(previousLightPosition));
      const localTarget = worldPosition.clone().addScaledVector(forward, aimDistance).applyMatrix4(inverseScene);
      light.target = [localTarget.x, localTarget.y, localTarget.z];
    }
    syncedEntityCount += 1;
  }

  next.engineWorkspace = {
    provider: snapshot.provider,
    authority: "engine",
    projectId: `${snapshot.provider}:${snapshot.scenePath ?? "active-scene"}`.slice(0, 240),
    scenePath: snapshot.scenePath,
    sessionId,
    lastSyncAt: snapshot.capturedAt,
    syncedEntityCount,
  };
  return {
    project: directorProjectSchema.parse(next),
    syncedEntityCount,
    skippedEntityCount,
  };
}

/**
 * Unity live-link routes. Session lifecycle and publishing stay on the
 * gateway's local Director-side trust like every other `/api/dcc` route; the
 * events poll is the connector-facing surface and requires the per-session
 * bearer token. There is no endpoint through which the Unity editor can
 * mutate the project — the link is preview-only and never authoritative.
 */
async function handleUnityLiveLinkRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: Pick<DccRouteDependencies, "readBody" | "json" | "unityLiveLink">,
): Promise<void> {
  const { readBody, json, unityLiveLink } = dependencies;
  if (!unityLiveLink) {
    json(response, 503, {
      success: false,
      code: "live_link_unavailable",
      error: "The Unity live-link hub is not configured on this gateway.",
    });
    return;
  }
  try {
    if (url.pathname === UNITY_LIVE_LINK_SESSIONS_PATH) {
      if (request.method === "GET") {
        json(response, 200, { success: true, result: { sessions: unityLiveLink.status() } });
        return;
      }
      if (request.method === "POST") {
        const body = unityLiveLinkCreateSchema.safeParse((await readBody(request)) ?? {});
        if (!body.success) {
          json(response, 400, {
            success: false,
            error: "Live-link session body must be { label?, allowCode?, authority? }.",
          });
          return;
        }
        const created = unityLiveLink.createSession(body.data);
        json(response, 200, {
          success: true,
          result: {
            ...created,
            pollPath: `${UNITY_LIVE_LINK_SESSIONS_PATH}/${created.sessionId}/events`,
          },
        });
        return;
      }
      json(response, 405, { success: false, error: "Unity live-link sessions support GET and POST." });
      return;
    }

    const sessionMatch = url.pathname.match(
      /^\/api\/dcc\/unity\/live-link\/sessions\/([^/]+)(?:\/(events|command-results))?$/,
    );
    if (!sessionMatch) {
      json(response, 404, { success: false, error: `Unknown Unity live-link path: ${url.pathname}` });
      return;
    }
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    const sessionResource = sessionMatch[2] ?? "";
    const isEventsPath = sessionResource === "events";

    if (!isEventsPath && request.method === "DELETE") {
      const closed = unityLiveLink.closeSession(sessionId);
      json(response, closed ? 200 : 404, {
        success: closed,
        ...(closed ? { result: { sessionId, closed: true } } : { error: `Unknown live-link session: ${sessionId}` }),
      });
      return;
    }
    if (isEventsPath && request.method === "POST") {
      const body = unityLiveLinkPublishSchema.safeParse(await readBody(request));
      if (!body.success) {
        const issue = body.error.issues[0];
        json(response, 400, {
          success: false,
          error: `Invalid live-link publish body at ${issue?.path.join(".") || "events"}: ${issue?.message ?? "invalid value"}`,
        });
        return;
      }
      json(response, 200, { success: true, result: unityLiveLink.publish(sessionId, body.data.events) });
      return;
    }
    if (isEventsPath && request.method === "GET") {
      const token = bearerToken(request);
      if (!token) {
        json(response, 401, {
          success: false,
          code: "live_link_token_missing",
          error: "Polling live-link events requires the session bearer token.",
        });
        return;
      }
      const query = unityLiveLinkPollQuerySchema.safeParse({
        ...(url.searchParams.has("after") ? { after: url.searchParams.get("after") } : {}),
        ...(url.searchParams.has("wait_ms") ? { wait_ms: url.searchParams.get("wait_ms") } : {}),
      });
      if (!query.success) {
        json(response, 400, {
          success: false,
          error: "Live-link poll expects non-negative integer after and wait_ms (max 55000) query parameters.",
        });
        return;
      }
      // Disconnect safety: abort the long poll the moment the connector's
      // request goes away so its waiter never outlives the socket.
      const abortController = new AbortController();
      const onRequestClose = () => abortController.abort();
      request.on("close", onRequestClose);
      try {
        const result = await unityLiveLink.poll({
          sessionId,
          token,
          afterSeq: query.data.after,
          waitMs: query.data.wait_ms,
          signal: abortController.signal,
        });
        json(response, 200, { success: true, result });
      } finally {
        request.off("close", onRequestClose);
      }
      return;
    }
    if (sessionResource === "command-results" && request.method === "POST") {
      const token = bearerToken(request);
      if (!token) {
        json(response, 401, {
          success: false,
          code: "live_link_token_missing",
          error: "Submitting a Unity command result requires the session bearer token.",
        });
        return;
      }
      const result = unityLiveLinkCommandResultSchema.safeParse(await readBody(request));
      if (!result.success) {
        const issue = result.error.issues[0];
        json(response, 400, {
          success: false,
          error: `Invalid live-link command result at ${issue?.path.join(".") || "result"}: ${issue?.message ?? "invalid value"}`,
        });
        return;
      }
      json(response, 200, {
        success: true,
        result: unityLiveLink.completeCommand(sessionId, token, result.data),
      });
      return;
    }
    json(response, 405, { success: false, error: "Unsupported method for this Unity live-link path." });
  } catch (error) {
    if (error instanceof UnityLiveLinkError) {
      json(response, error.status, { success: false, code: error.code, error: error.message });
      return;
    }
    json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const UNREAL_LIVE_PREVIEW_SESSIONS_PATH = "/api/dcc/unreal/live-preview/sessions";

/**
 * Unreal live preview routes. The gateway is the outbound client of the
 * connector's 127.0.0.1 listener: these routes open sessions, push
 * sequence-numbered camera frames, and read session counters. The shared
 * token stays in the gateway environment (DIRECTOR_UNREAL_PREVIEW_TOKEN) and
 * never crosses this surface, and no route can turn a preview frame into a
 * project mutation.
 */
async function handleUnrealLivePreviewRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: Pick<DccRouteDependencies, "readBody" | "json" | "unrealLivePreview">,
): Promise<void> {
  const { readBody, json, unrealLivePreview } = dependencies;
  if (!unrealLivePreview) {
    json(response, 503, {
      success: false,
      code: "live_preview_unavailable",
      error: "The Unreal live preview hub is not configured on this gateway.",
    });
    return;
  }
  try {
    if (url.pathname === UNREAL_LIVE_PREVIEW_SESSIONS_PATH) {
      if (request.method === "GET") {
        json(response, 200, { success: true, result: { sessions: unrealLivePreview.status() } });
        return;
      }
      if (request.method === "POST") {
        const session = await unrealLivePreview.open(await readBody(request));
        json(response, 200, { success: true, result: { session } });
        return;
      }
      json(response, 405, { success: false, error: "Unreal live preview sessions support GET and POST." });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/dcc\/unreal\/live-preview\/sessions\/([^/]+)(\/frames)?$/);
    if (!sessionMatch) {
      json(response, 404, { success: false, error: `Unknown Unreal live preview path: ${url.pathname}` });
      return;
    }
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    const isFramesPath = sessionMatch[2] === "/frames";
    if (isFramesPath && request.method === "POST") {
      const result = unrealLivePreview.frame(sessionId, await readBody(request));
      json(response, 200, { success: true, result });
      return;
    }
    if (!isFramesPath && request.method === "GET") {
      json(response, 200, { success: true, result: { session: unrealLivePreview.read(sessionId) } });
      return;
    }
    if (!isFramesPath && request.method === "DELETE") {
      const session = await unrealLivePreview.close(sessionId);
      json(response, 200, { success: true, result: { session } });
      return;
    }
    json(response, 405, { success: false, error: "Unsupported method for this Unreal live preview path." });
  } catch (error) {
    if (error instanceof DirectorUnrealLivePreviewHubError) {
      json(response, error.status, { success: false, code: error.code, error: error.message });
      return;
    }
    json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Agent-native DCC route. Blender execution remains server-side and path constrained. */
export async function handleDccRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: DccRouteDependencies,
): Promise<boolean> {
  const {
    readBody,
    getProject,
    blender,
    providers,
    exchangePackager,
    sceneImporter,
    engineImporter,
    returnImporter,
    engineBridge,
    engineReturnImporters,
    unityLiveLink,
    godotLiveLink,
    unrealLivePreview,
    engineRun,
    engineFrames,
    applyAuthoring,
  } = dependencies;
  // Reassigned with an audit-recording wrapper once a governed tool call is admitted.
  let json = dependencies.json;

  if (url.pathname === UNITY_LIVE_LINK_SESSIONS_PATH || url.pathname.startsWith(`${UNITY_LIVE_LINK_SESSIONS_PATH}/`)) {
    await handleUnityLiveLinkRoute(request, response, url, { readBody, json, unityLiveLink });
    return true;
  }

  if (
    url.pathname === UNREAL_LIVE_PREVIEW_SESSIONS_PATH ||
    url.pathname.startsWith(`${UNREAL_LIVE_PREVIEW_SESSIONS_PATH}/`)
  ) {
    await handleUnrealLivePreviewRoute(request, response, url, { readBody, json, unrealLivePreview });
    return true;
  }

  async function liveProject() {
    const parsed = safeParseDirectorProject(await getProject());
    if (!parsed.success) {
      json(response, 503, { success: false, error: `No valid live Director project is available. ${parsed.error}` });
      return null;
    }
    return parsed.project;
  }

  if (request.method === "GET" && url.pathname === "/api/dcc/status") {
    json(response, 200, { success: true, result: await blender.status() });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/dcc/providers") {
    if (!providers) {
      json(response, 503, { success: false, error: "DCC provider registry is not configured." });
      return true;
    }
    json(response, 200, { success: true, result: await providers.discover() });
    return true;
  }
  // Read-only engine connector health: the same versioned probe that gates
  // send_to_engine, exposed so the editor can render connector version,
  // warnings, and recovery steps without triggering a failing send.
  const engineHealthMatch = url.pathname.match(/^\/api\/dcc\/engines\/([^/]+)\/health$/);
  if (engineHealthMatch) {
    if (request.method !== "GET") {
      json(response, 405, { success: false, error: "Engine connector health requires GET." });
      return true;
    }
    if (!engineBridge) {
      json(response, 503, {
        success: false,
        code: "engine_bridge_unavailable",
        error: "The DCC engine bridge is not configured on this gateway.",
      });
      return true;
    }
    const parsedEngineId = directorDccEngineIdSchema.safeParse(decodeURIComponent(engineHealthMatch[1] ?? ""));
    if (!parsedEngineId.success) {
      json(response, 400, {
        success: false,
        code: "engine_provider_invalid",
        error: "Engine connector health supports the unreal, unity, and godot providers.",
      });
      return true;
    }
    json(response, 200, { success: true, result: await engineBridge.health(parsedEngineId.data) });
    return true;
  }
  // Godot live-link preview transport. Godot never listens on a port: the
  // connector opens authenticated requests against these token-guarded routes
  // (outbound to Director only). Frames are ephemeral and never authoritative;
  // durable changes still travel through the reviewed return-package path.
  const liveLinkMatch = url.pathname.match(/^\/api\/dcc\/live-link\/godot\/(hello|frame|bye|preview|command-result)$/);
  if (liveLinkMatch) {
    if (!godotLiveLink) {
      json(response, 503, {
        success: false,
        code: "live_link_unavailable",
        error: "The Godot live-link hub is not configured on this gateway.",
      });
      return true;
    }
    const liveLinkOperation = liveLinkMatch[1] as "hello" | "frame" | "bye" | "preview" | "command-result";
    const expectedMethod = liveLinkOperation === "preview" ? "GET" : "POST";
    if (request.method !== expectedMethod) {
      json(response, 405, { success: false, error: `live-link ${liveLinkOperation} requires ${expectedMethod}.` });
      return true;
    }
    try {
      if (liveLinkOperation === "preview") {
        json(response, 200, { success: true, result: godotLiveLink.preview() });
        return true;
      }
      const liveLinkBody = await readBody(request);
      if (liveLinkOperation === "command-result") {
        if (!liveLinkBody || typeof liveLinkBody !== "object" || Array.isArray(liveLinkBody)) {
          json(response, 400, { success: false, error: "Godot command result must be an object." });
          return true;
        }
        const { sessionId, ...rawResult } = liveLinkBody as Record<string, unknown>;
        const parsedSessionId = z.string().uuid().safeParse(sessionId);
        const parsedResult = directorEngineSessionCommandResultSchema.safeParse(rawResult);
        if (!parsedSessionId.success || !parsedResult.success) {
          json(response, 400, { success: false, error: "Invalid Godot engine session command result." });
          return true;
        }
        json(response, 200, {
          success: true,
          result: godotLiveLink.completeCommand(parsedSessionId.data, parsedResult.data),
        });
        return true;
      }
      const result =
        liveLinkOperation === "hello"
          ? godotLiveLink.hello(liveLinkBody)
          : liveLinkOperation === "frame"
            ? godotLiveLink.frame(liveLinkBody)
            : godotLiveLink.bye(liveLinkBody);
      json(response, 200, { success: true, result });
    } catch (error) {
      if (error instanceof DirectorGodotLiveLinkError) {
        json(response, error.status, { success: false, code: error.code, error: error.message });
      } else {
        json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }
  const providerStatusMatch = url.pathname.match(/^\/api\/dcc\/providers\/([^/]+)\/status$/);
  if (request.method === "GET" && providerStatusMatch) {
    if (!providers) {
      json(response, 503, { success: false, error: "DCC provider registry is not configured." });
      return true;
    }
    const parsedProviderId = directorDccProviderIdSchema.safeParse(decodeURIComponent(providerStatusMatch[1] ?? ""));
    if (!parsedProviderId.success) {
      json(response, 400, { success: false, code: "dcc_provider_invalid", error: "Invalid DCC provider id." });
      return true;
    }
    const providerId = parsedProviderId.data;
    const providerStatus = await providers.status(providerId);
    if (!providerStatus) {
      json(response, 404, {
        success: false,
        code: "dcc_provider_unknown",
        error: `Unknown DCC provider: ${providerId}`,
      });
      return true;
    }
    json(response, 200, { success: true, result: providerStatus });
    return true;
  }
  if (url.pathname === "/api/dcc/blender-scene/uploads") {
    if (request.method !== "POST") {
      json(response, 405, { success: false, error: "Blender scene uploads require POST." });
      return true;
    }
    if (!sceneImporter) {
      json(response, 503, {
        success: false,
        code: "blend_scene_import_unavailable",
        error: "Blender scene importer is not configured.",
      });
      return true;
    }
    const contentType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/x-blender" && contentType !== "application/octet-stream") {
      json(response, 415, { success: false, error: "Blender scene upload must use application/x-blender." });
      return true;
    }
    const fileName = url.searchParams.get("filename")?.trim();
    if (!fileName) {
      json(response, 400, { success: false, error: "Blender scene upload requires a filename query parameter." });
      return true;
    }
    const project = await liveProject();
    if (!project) return true;
    const contentLengthHeader = request.headers["content-length"];
    const declaredBytes =
      typeof contentLengthHeader === "string" && contentLengthHeader.trim() ? Number(contentLengthHeader) : undefined;
    try {
      const result = await sceneImporter.ingestUpload(fileName, request, project, declaredBytes);
      json(response, 200, { success: true, result });
    } catch (error) {
      if (error instanceof DirectorBlendSceneImportError) {
        json(response, error.status, {
          success: false,
          code: error.code,
          error: error.message,
          recovery: error.recovery,
        });
      } else {
        json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }
  if (url.pathname === "/api/dcc/engine-scene/uploads") {
    if (request.method !== "POST") {
      json(response, 405, { success: false, error: "Engine scene uploads require POST." });
      return true;
    }
    if (!engineImporter) {
      json(response, 503, {
        success: false,
        code: "engine_scene_import_unavailable",
        error: "Engine scene importer is not configured.",
      });
      return true;
    }
    const contentType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/zip" && contentType !== "application/octet-stream") {
      json(response, 415, { success: false, error: "Engine scene upload must use application/zip." });
      return true;
    }
    const providerParameter = directorEngineSceneProviderSchema.safeParse(url.searchParams.get("provider") ?? "");
    if (!providerParameter.success) {
      json(response, 400, {
        success: false,
        error: "Engine scene upload requires a provider query parameter of unreal, unity, or godot.",
      });
      return true;
    }
    const fileName = url.searchParams.get("filename")?.trim();
    if (!fileName) {
      json(response, 400, { success: false, error: "Engine scene upload requires a filename query parameter." });
      return true;
    }
    const project = await liveProject();
    if (!project) return true;
    const contentLengthHeader = request.headers["content-length"];
    const declaredBytes =
      typeof contentLengthHeader === "string" && contentLengthHeader.trim() ? Number(contentLengthHeader) : undefined;
    try {
      const result = await engineImporter.ingestUpload(
        providerParameter.data,
        fileName,
        request,
        project,
        declaredBytes,
      );
      json(response, 200, { success: true, result });
    } catch (error) {
      if (error instanceof DirectorEngineSceneImportError) {
        json(response, error.status, {
          success: false,
          code: error.code,
          error: error.message,
          recovery: error.recovery,
        });
      } else {
        json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }
  if (request.method !== "POST" || (url.pathname !== "/api/tools/director_dcc" && url.pathname !== "/api/dcc/blender"))
    return false;

  const body = envelopeSchema.safeParse(await readBody(request));
  if (!body.success) {
    json(response, 400, { success: false, error: "DCC request body must be a JSON object." });
    return true;
  }
  const input = Object.prototype.hasOwnProperty.call(body.data, "input") ? body.data.input : body.data;
  const { operationInput, skipDirectorIds, error: skipError } = extractSkipDirectorIds(input);
  if (skipError) {
    json(response, 400, { success: false, error: skipError });
    return true;
  }
  const parsed = directorDccOperationSchema.safeParse(operationInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    json(response, 400, {
      success: false,
      error: `Invalid director_dcc input at ${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid value"}`,
    });
    return true;
  }
  // Same film-role and plan-mode policy as MCP, checked before any DCC work.
  const governance = evaluateHttpToolGovernance({
    request,
    tool: "director_dcc",
    toolInput: parsed.data,
    sessionId: body.data.session_id,
    dependencies: dependencies.governance,
  });
  const auditContext = {
    store: dependencies.governance?.auditStore,
    tool: "director_dcc",
    toolInput: parsed.data,
    roleId: governance.roleId,
    source: governance.source,
    sessionId: body.data.session_id,
  };
  if (!governance.allowed) {
    recordRejectedHttpToolCall(governance, auditContext);
    json(response, governance.status, governance.body);
    return true;
  }
  json = withHttpToolAudit(json, auditContext);
  if (parsed.data.op === "discover") {
    if (!providers) {
      json(response, 503, { success: false, error: "DCC provider registry is not configured." });
      return true;
    }
    json(response, 200, { success: true, result: await providers.discover() });
    return true;
  }
  if (parsed.data.op === "status") {
    if (!parsed.data.provider) {
      json(response, 200, { success: true, result: await blender.status() });
      return true;
    }
    if (!providers) {
      json(response, 503, { success: false, error: "DCC provider registry is not configured." });
      return true;
    }
    const providerStatus = await providers.status(parsed.data.provider);
    if (!providerStatus) {
      json(response, 404, {
        success: false,
        code: "dcc_provider_unknown",
        error: `Unknown DCC provider: ${parsed.data.provider}`,
      });
      return true;
    }
    json(response, 200, { success: true, result: providerStatus });
    return true;
  }
  if (
    parsed.data.op === "start_engine_session" ||
    parsed.data.op === "engine_session_command" ||
    parsed.data.op === "engine_session_command_status" ||
    parsed.data.op === "stop_engine_session"
  ) {
    const sessionProvider = parsed.data.provider;
    const sessionHub =
      sessionProvider === "unity" ? unityLiveLink : sessionProvider === "godot" ? godotLiveLink : unrealLivePreview;
    if (!sessionHub) {
      json(response, 503, {
        success: false,
        code: "engine_session_unavailable",
        error: `The ${sessionProvider} engine session hub is not configured on this gateway.`,
      });
      return true;
    }
    try {
      if (parsed.data.op === "start_engine_session") {
        if (sessionProvider === "unreal" && !parsed.data.port) {
          json(response, 400, {
            success: false,
            code: "engine_session_port_required",
            error: "Unreal start_engine_session requires the loopback port printed by --mode live-preview.",
          });
          return true;
        }
        const created =
          sessionProvider === "unity"
            ? unityLiveLink!.createSession({
                ...(parsed.data.label ? { label: parsed.data.label } : {}),
                allowCode: parsed.data.allow_code,
                authority: parsed.data.authority,
              })
            : sessionProvider === "godot"
              ? godotLiveLink!.startEngineSession({
                  ...(parsed.data.label ? { label: parsed.data.label } : {}),
                  allowCode: parsed.data.allow_code,
                  authority: parsed.data.authority,
                })
              : await unrealLivePreview!.open({
                  port: parsed.data.port!,
                  allowCode: parsed.data.allow_code,
                  authority: parsed.data.authority,
                });
        json(response, 200, {
          success: true,
          result: {
            ...created,
            ...(sessionProvider === "unity"
              ? { pollPath: `${UNITY_LIVE_LINK_SESSIONS_PATH}/${created.sessionId}/events` }
              : {}),
          },
        });
        return true;
      }
      if (parsed.data.op === "stop_engine_session") {
        const closed =
          sessionProvider === "unity"
            ? unityLiveLink!.closeSession(parsed.data.session_id)
            : sessionProvider === "godot"
              ? godotLiveLink!.stopEngineSession(parsed.data.session_id)
              : Boolean(await unrealLivePreview!.close(parsed.data.session_id));
        json(response, closed ? 200 : 404, {
          success: closed,
          ...(closed
            ? { result: { provider: sessionProvider, sessionId: parsed.data.session_id, closed: true } }
            : {
                code: "engine_session_unknown",
                error: `Unknown ${sessionProvider} engine session: ${parsed.data.session_id}`,
              }),
        });
        return true;
      }
      let command;
      if (parsed.data.op === "engine_session_command_status") {
        command = sessionHub.commandStatus(parsed.data.session_id, parsed.data.command_id);
      } else {
        if (parsed.data.command === "execute_code" && !parsed.data.code) {
          json(response, 400, {
            success: false,
            code: "engine_session_code_missing",
            error: "execute_code requires a non-empty code field.",
          });
          return true;
        }
        const commandInput =
          parsed.data.command === "capture_frame"
            ? {
                command: "capture_frame" as const,
                ...(parsed.data.camera ? { camera: parsed.data.camera } : {}),
                ...(parsed.data.width ? { width: parsed.data.width } : {}),
                ...(parsed.data.height ? { height: parsed.data.height } : {}),
              }
            : parsed.data.command === "execute_code"
              ? { command: "execute_code" as const, code: parsed.data.code ?? "" }
              : { command: "sync_scene" as const };
        command = sessionHub.requestCommand(parsed.data.session_id, commandInput);
      }
      json(response, 200, {
        success: true,
        result: command,
        ...(command.capture ? { capture: command.capture } : {}),
      });
      return true;
    } catch (error) {
      if (
        error instanceof UnityLiveLinkError ||
        error instanceof DirectorGodotLiveLinkError ||
        error instanceof DirectorUnrealLivePreviewHubError
      ) {
        json(response, error.status, { success: false, code: error.code, error: error.message });
      } else {
        json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
  }
  // On-demand engine frame render: the perception primitive. The receipt is
  // hash-verified and the PNG travels once through the shared capture
  // attachment channel so agents see the engine's pixels.
  if (parsed.data.op === "render_engine_frame") {
    if (!engineFrames) {
      json(response, 503, {
        success: false,
        code: "engine_frame_unavailable",
        error: "The engine frame renderer is not configured on this gateway.",
      });
      return true;
    }
    try {
      const rendered = await engineFrames.render(parsed.data.provider, {
        ...(parsed.data.job_id !== undefined ? { jobId: parsed.data.job_id } : {}),
        ...(parsed.data.scene !== undefined ? { scene: parsed.data.scene } : {}),
        ...(parsed.data.camera !== undefined ? { camera: parsed.data.camera } : {}),
        ...(parsed.data.width !== undefined ? { width: parsed.data.width } : {}),
        ...(parsed.data.height !== undefined ? { height: parsed.data.height } : {}),
        ...(parsed.data.frame !== undefined ? { frame: parsed.data.frame } : {}),
      });
      if (rendered.receipt.status === "skipped") {
        json(response, 502, {
          success: false,
          code: "engine_frame_skipped",
          error: rendered.receipt.skipReason,
          result: rendered.receipt,
        });
        return true;
      }
      json(response, 200, {
        success: true,
        result: rendered.receipt,
        ...(rendered.imageBase64
          ? {
              capture: {
                mimeType: "image/png",
                dataBase64: rendered.imageBase64,
                width: rendered.receipt.width,
                height: rendered.receipt.height,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof DirectorDccEngineRunError) {
        json(response, error.status, {
          success: false,
          code: error.code,
          error: error.message,
          ...(error.recovery.length ? { recovery: error.recovery } : {}),
        });
      } else {
        json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }
  // Local engine process ops (editor launch, project run, run status/stop):
  // fixed argument vectors against the configured engine project, no live
  // Director project required, and never a request-supplied script.
  if (
    parsed.data.op === "launch_engine_editor" ||
    parsed.data.op === "run_engine_project" ||
    parsed.data.op === "engine_run_status" ||
    parsed.data.op === "stop_engine_project"
  ) {
    if (!engineRun) {
      json(response, 503, {
        success: false,
        code: "engine_run_unavailable",
        error: "The engine run manager is not configured on this gateway.",
      });
      return true;
    }
    try {
      if (parsed.data.op === "launch_engine_editor") {
        json(response, 200, { success: true, result: await engineRun.launchEditor(parsed.data.provider) });
        return true;
      }
      if (parsed.data.op === "run_engine_project") {
        const result = await engineRun.runProject(parsed.data.provider, {
          ...(parsed.data.scene !== undefined ? { scene: parsed.data.scene } : {}),
          ...(parsed.data.headless !== undefined ? { headless: parsed.data.headless } : {}),
        });
        json(response, 200, { success: true, result });
        return true;
      }
      if (parsed.data.op === "engine_run_status") {
        json(response, 200, { success: true, result: engineRun.runStatus(parsed.data.provider) });
        return true;
      }
      json(response, 200, { success: true, result: await engineRun.stopRun(parsed.data.provider) });
    } catch (error) {
      if (error instanceof DirectorDccEngineRunError) {
        json(response, error.status, {
          success: false,
          code: error.code,
          error: error.message,
          ...(error.recovery.length ? { recovery: error.recovery } : {}),
        });
      } else {
        json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }

  const project = await liveProject();
  if (!project) return true;
  try {
    if (parsed.data.op === "sync_engine_session_to_director") {
      const sessionHub =
        parsed.data.provider === "unity"
          ? unityLiveLink
          : parsed.data.provider === "godot"
            ? godotLiveLink
            : unrealLivePreview;
      if (!sessionHub || !applyAuthoring) {
        json(response, 503, {
          success: false,
          code: "engine_session_sync_unavailable",
          error: "The engine session hub and Director authoring transport are required for review sync.",
        });
        return true;
      }
      const command = sessionHub.commandStatus(parsed.data.session_id, parsed.data.command_id);
      if (command.command !== "sync_scene" || command.status !== "completed" || !command.snapshot) {
        json(response, 409, {
          success: false,
          code: "engine_session_sync_not_ready",
          error:
            command.status === "failed"
              ? (command.error ?? "The engine scene sync failed.")
              : "Run engine_session_command with command: sync_scene and wait for completion first.",
        });
        return true;
      }
      const projected = projectEngineSnapshotForReview(project, command.snapshot, parsed.data.session_id);
      const operation = directorWorkbenchOperationSchema.parse({
        op: "replace_project",
        project: projected.project,
        expected_revision: parsed.data.expected_revision,
        idempotency_key: parsed.data.idempotency_key,
      });
      const authoring = await applyAuthoring(operation);
      json(response, 200, {
        success: true,
        result: {
          provider: parsed.data.provider,
          authority: "engine",
          sessionId: parsed.data.session_id,
          commandId: parsed.data.command_id,
          syncedEntityCount: projected.syncedEntityCount,
          skippedEntityCount: projected.skippedEntityCount,
          engineWorkspace: projected.project.engineWorkspace,
          authoring,
        },
      });
      return true;
    }
    if (parsed.data.op === "export_exchange_package") {
      if (!providers || !exchangePackager) {
        json(response, 503, { success: false, error: "DCC exchange packager is not configured." });
        return true;
      }
      const adapter = providers.get(parsed.data.provider);
      if (!adapter) {
        json(response, 404, {
          success: false,
          code: "dcc_provider_unknown",
          error: `Unknown DCC provider: ${parsed.data.provider}`,
        });
        return true;
      }
      const providerStatus = await providers.status(parsed.data.provider);
      if (!providerStatus) {
        json(response, 404, {
          success: false,
          code: "dcc_provider_unknown",
          error: `Unknown DCC provider: ${parsed.data.provider}`,
        });
        return true;
      }
      if (!providerStatus.exchangeReady) {
        json(response, 409, {
          success: false,
          code: "dcc_exchange_unavailable",
          error: providerStatus.reason ?? `Portable exchange is not ready for ${parsed.data.provider}.`,
        });
        return true;
      }
      const result = await exchangePackager.exportPackage(project, {
        provider: parsed.data.provider,
        descriptor: adapter.descriptor,
        exchangeReady: providerStatus.exchangeReady,
        formats: parsed.data.formats,
        cameraId: parsed.data.camera_id,
        frame: parsed.data.frame,
      });
      json(response, 200, { success: true, result });
      return true;
    }
    if (parsed.data.op === "export_blend") {
      const result = await blender.exportBlend(project, {
        renderPreview: parsed.data.render_preview,
        cameraId: parsed.data.camera_id,
        frame: parsed.data.frame,
      });
      json(response, 200, { success: true, result });
      return true;
    }
    if (parsed.data.op === "send_to_engine") {
      if (!engineBridge) {
        json(response, 503, {
          success: false,
          code: "engine_bridge_unavailable",
          error: "The DCC engine bridge is not configured on this gateway.",
        });
        return true;
      }
      const result = await engineBridge.send(project, {
        provider: parsed.data.provider,
        formats: parsed.data.formats,
        cameraId: parsed.data.camera_id,
        frame: parsed.data.frame,
        cleanFrame: parsed.data.clean_frame,
      });
      json(response, 200, { success: true, result });
      return true;
    }
    if (parsed.data.op === "receive_from_engine") {
      const engineImporter = engineReturnImporters?.[parsed.data.provider];
      if (!engineImporter) {
        json(response, 503, {
          success: false,
          code: "return_import_unavailable",
          error: `The ${parsed.data.provider} return importer is not configured on this gateway.`,
        });
        return true;
      }
      const plan = await engineImporter.buildImportPlan(parsed.data.package_dir, project, {
        ...(skipDirectorIds ? { skipDirectorIds } : {}),
        includeNewObjects: parsed.data.include_new_objects,
      });
      json(response, plan.ready ? 200 : 409, {
        success: plan.ready,
        ...(plan.ready ? {} : { code: plan.conflicts[0]?.code ?? "conflict_unresolved" }),
        result: {
          ready: plan.ready,
          provider: parsed.data.provider,
          dry_run: parsed.data.dry_run,
          include_new_objects: parsed.data.include_new_objects,
          summary: {
            operation_count: plan.operations.filter((operation) => operation.op !== "skip" && operation.op !== "warn")
              .length,
            skipped_count: plan.operations.filter((operation) => operation.op === "skip").length,
            conflict_count: plan.conflicts.length,
            warning_count: plan.warnings.length,
          },
          plan,
        },
      });
      return true;
    }
    if (parsed.data.op === "preview_blend_scene_import") {
      if (!sceneImporter) {
        json(response, 503, {
          success: false,
          code: "blend_scene_import_unavailable",
          error: "Blender scene importer is not configured.",
        });
        return true;
      }
      const plan = await sceneImporter.buildImportPlan(parsed.data.package_dir, project, parsed.data.selection);
      json(response, plan.ready ? 200 : 409, { success: plan.ready, result: { plan } });
      return true;
    }
    if (parsed.data.op === "apply_blend_scene_import") {
      if (!sceneImporter) {
        json(response, 503, {
          success: false,
          code: "blend_scene_import_unavailable",
          error: "Blender scene importer is not configured.",
        });
        return true;
      }
      if (!applyAuthoring) {
        json(response, 503, {
          success: false,
          code: "browser_target_unavailable",
          error: "No Director authoring transport is configured for applying the Blender scene.",
        });
        return true;
      }
      const result = await sceneImporter.applyImportPlan(
        parsed.data.plan_id,
        project,
        parsed.data.expected_revision,
        parsed.data.idempotency_key,
        applyAuthoring,
      );
      json(response, 200, { success: true, result });
      return true;
    }
    if (
      parsed.data.op === "preview_engine_scene_import" ||
      parsed.data.op === "apply_engine_scene_import" ||
      parsed.data.op === "extract_engine_scene"
    ) {
      if (!engineImporter) {
        json(response, 503, {
          success: false,
          code: "engine_scene_import_unavailable",
          error: "Engine scene importer is not configured.",
        });
        return true;
      }
      if (parsed.data.op === "preview_engine_scene_import") {
        const plan = await engineImporter.buildImportPlan(
          parsed.data.provider,
          parsed.data.package_dir,
          project,
          parsed.data.selection,
        );
        json(response, plan.ready ? 200 : 409, { success: plan.ready, result: { plan } });
        return true;
      }
      if (parsed.data.op === "extract_engine_scene") {
        const result = await engineImporter.ingestProject(
          parsed.data.provider,
          parsed.data.project_dir,
          project,
          parsed.data.scene,
        );
        json(response, 200, { success: true, result });
        return true;
      }
      if (!applyAuthoring) {
        json(response, 503, {
          success: false,
          code: "browser_target_unavailable",
          error: "No Director authoring transport is configured for applying the engine scene.",
        });
        return true;
      }
      const result = await engineImporter.applyImportPlan(
        parsed.data.plan_id,
        project,
        parsed.data.expected_revision,
        parsed.data.idempotency_key,
        applyAuthoring,
      );
      json(response, 200, { success: true, result });
      return true;
    }
    if (parsed.data.op === "import_return_package") {
      if (!returnImporter) {
        json(response, 503, {
          success: false,
          code: "return_import_unavailable",
          error: "Blender return importer is not configured.",
        });
        return true;
      }
      const plan = await returnImporter.buildImportPlan(parsed.data.package_dir, project, {
        ...(skipDirectorIds ? { skipDirectorIds } : {}),
        includeNewObjects: parsed.data.include_new_objects,
      });
      json(response, plan.ready ? 200 : 409, {
        success: plan.ready,
        ...(plan.ready ? {} : { code: plan.conflicts[0]?.code ?? "conflict_unresolved" }),
        result: {
          ready: plan.ready,
          dry_run: parsed.data.dry_run,
          include_new_objects: parsed.data.include_new_objects,
          summary: {
            operation_count: plan.operations.filter((operation) => operation.op !== "skip" && operation.op !== "warn")
              .length,
            skipped_count: plan.operations.filter((operation) => operation.op === "skip").length,
            conflict_count: plan.conflicts.length,
            warning_count: plan.warnings.length,
          },
          plan,
        },
      });
      return true;
    }
    const applyProvider = parsed.data.provider ?? "blender";
    const applyImporter = applyProvider === "blender" ? returnImporter : engineReturnImporters?.[applyProvider];
    if (!applyImporter) {
      json(response, 503, {
        success: false,
        code: "return_import_unavailable",
        error: `The ${applyProvider} return importer is not configured on this gateway.`,
      });
      return true;
    }
    if (!applyAuthoring) {
      json(response, 503, {
        success: false,
        code: "browser_target_unavailable",
        error: "No Director authoring transport is configured for applying the import plan.",
      });
      return true;
    }
    const result = await applyImporter.applyImportPlan(
      parsed.data.plan,
      project,
      parsed.data.expected_revision,
      parsed.data.idempotency_key,
      applyAuthoring,
    );
    json(response, 200, { success: true, result: { provider: applyProvider, ...result } });
  } catch (error) {
    if (error instanceof DirectorDccEngineBridgeError) {
      json(response, error.status, {
        success: false,
        code: error.code,
        error: error.message,
        ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      });
      return true;
    }
    if (error instanceof DirectorDccExchangePackageError) {
      json(response, error.status, {
        success: false,
        code: error.code,
        error: error.message,
      });
      return true;
    }
    if (error instanceof DirectorDccImportError) {
      json(response, error.status, {
        success: false,
        code: error.code,
        error: error.message,
        recovery: error.recovery,
      });
      return true;
    }
    if (error instanceof DirectorBlendSceneImportError) {
      json(response, error.status, {
        success: false,
        code: error.code,
        error: error.message,
        recovery: error.recovery,
      });
      return true;
    }
    if (error instanceof DirectorEngineSceneImportError) {
      json(response, error.status, {
        success: false,
        code: error.code,
        error: error.message,
        recovery: error.recovery,
      });
      return true;
    }
    if (error instanceof UnityLiveLinkError || error instanceof DirectorGodotLiveLinkError) {
      json(response, error.status, { success: false, code: error.code, error: error.message });
      return true;
    }
    json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
