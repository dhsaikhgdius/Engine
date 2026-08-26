import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { directorDccOperationSchema, type DirectorDccEngineId } from "@director/dcc-protocol";
import { safeParseDirectorProject } from "@director/project-schema";
import { directorEngineSceneProviderSchema } from "@director/dcc-protocol";
import type { BlenderBridge } from "../dcc/blenderBridge";
import { DirectorBlendSceneImportError, type BlenderSceneImporter } from "../dcc/blenderSceneImport";
import { DirectorEngineSceneImportError, type EngineSceneImporter } from "../dcc/engineSceneImport";
import {
  DirectorDccImportError,
  type DccReturnImporter,
  type DirectorDccAuthoringResponse,
} from "../dcc/blenderReturnImport";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
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
import { UnityLiveLinkError, unityLiveLinkEventPayloadSchema, type UnityLiveLinkHub } from "../dcc/unityLiveLink";
import { DirectorGodotLiveLinkError, type GodotLiveLinkHub } from "../dcc/godotLiveLink";
import type { DirectorUnrealLivePreviewHub } from "../dcc/unrealLivePreview";

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
  /** Unreal loopback live preview hub (read-only status; preview-only, never authoritative). */
  unrealLivePreview?: DirectorUnrealLivePreviewHub;
  applyAuthoring?: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
}

const UNITY_LIVE_LINK_SESSIONS_PATH = "/api/dcc/unity/live-link/sessions";

const unityLiveLinkCreateSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
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
          json(response, 400, { success: false, error: "Live-link session body must be { label? }." });
          return;
        }
        const created = unityLiveLink.createSession(body.data.label);
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

    const sessionMatch = url.pathname.match(/^\/api\/dcc\/unity\/live-link\/sessions\/([^/]+)(\/events)?$/);
    if (!sessionMatch) {
      json(response, 404, { success: false, error: `Unknown Unity live-link path: ${url.pathname}` });
      return;
    }
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    const isEventsPath = sessionMatch[2] === "/events";

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
    json(response, 405, { success: false, error: "Unsupported method for this Unity live-link path." });
  } catch (error) {
    if (error instanceof UnityLiveLinkError) {
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
    applyAuthoring,
  } = dependencies;
  // Reassigned with an audit-recording wrapper once a governed tool call is admitted.
  let json = dependencies.json;

  if (url.pathname === UNITY_LIVE_LINK_SESSIONS_PATH || url.pathname.startsWith(`${UNITY_LIVE_LINK_SESSIONS_PATH}/`)) {
    await handleUnityLiveLinkRoute(request, response, url, { readBody, json, unityLiveLink });
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
  // Read-only Unreal live-preview status snapshot for UI polling. The preview
  // channel is loopback-only and never authoritative; this route exposes
  // lifecycle states and counters only — never scene data — and reading it
  // never mutates a session or the project.
  if (url.pathname === "/api/dcc/unreal/live-preview/status") {
    if (request.method !== "GET") {
      json(response, 405, { success: false, error: "The Unreal live-preview status route is read-only (GET)." });
      return true;
    }
    if (!unrealLivePreview) {
      json(response, 503, {
        success: false,
        code: "live_preview_unavailable",
        error: "The Unreal live-preview hub is not configured on this gateway.",
      });
      return true;
    }
    json(response, 200, { success: true, result: unrealLivePreview.status() });
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
  // Godot live-link preview transport. Godot never listens on a port: the
  // connector opens authenticated requests against these token-guarded routes
  // (outbound to Director only). Frames are ephemeral and never authoritative;
  // durable changes still travel through the reviewed return-package path.
  const liveLinkMatch = url.pathname.match(/^\/api\/dcc\/live-link\/godot\/(hello|frame|bye|preview)$/);
  if (liveLinkMatch) {
    if (!godotLiveLink) {
      json(response, 503, {
        success: false,
        code: "live_link_unavailable",
        error: "The Godot live-link hub is not configured on this gateway.",
      });
      return true;
    }
    const liveLinkOperation = liveLinkMatch[1] as "hello" | "frame" | "bye" | "preview";
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
        error: "Engine scene upload requires a provider query parameter of unreal or unity.",
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

  const project = await liveProject();
  if (!project) return true;
  try {
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
      const plan = skipDirectorIds
        ? await engineImporter.buildImportPlan(parsed.data.package_dir, project, { skipDirectorIds })
        : await engineImporter.buildImportPlan(parsed.data.package_dir, project);
      json(response, plan.ready ? 200 : 409, {
        success: plan.ready,
        ...(plan.ready ? {} : { code: plan.conflicts[0]?.code ?? "conflict_unresolved" }),
        result: {
          ready: plan.ready,
          provider: parsed.data.provider,
          dry_run: parsed.data.dry_run,
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
    json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
