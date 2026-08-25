import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { directorDccOperationSchema } from "@director/dcc-protocol";
import { safeParseDirectorProject } from "@director/project-schema";
import type { BlenderBridge } from "../dcc/blenderBridge";
import { DirectorBlendSceneImportError, type BlenderSceneImporter } from "../dcc/blenderSceneImport";
import {
  DirectorDccImportError,
  type BlenderReturnImporter,
  type DirectorDccAuthoringResponse,
} from "../dcc/blenderReturnImport";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import { directorDccProviderIdSchema } from "@director/dcc-protocol";
import type { DirectorDccProviderRegistry } from "../dcc/dccProviderRegistry";
import { DirectorDccExchangePackageError, type DirectorDccExchangePackager } from "../dcc/dccExchangePackage";
import {
  evaluateHttpToolGovernance,
  recordRejectedHttpToolCall,
  withHttpToolAudit,
  type HttpToolGovernanceDependencies,
} from "../agents/httpToolGovernance";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

const envelopeSchema = z.looseObject({
  input: z.unknown().optional(),
  session_id: z.string().trim().min(1).max(160).optional(),
});

const skipDirectorIdsSchema = z.array(z.string().trim().min(1).max(200)).max(20_000);

/**
 * import_return_package accepts an optional skip_director_ids list on top of the
 * strict shared operation schema; extract it before strict parsing rejects it.
 */
function extractSkipDirectorIds(input: unknown): {
  operationInput: unknown;
  skipDirectorIds?: string[];
  error?: string;
} {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input as Record<string, unknown>).op !== "import_return_package" ||
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
  returnImporter?: BlenderReturnImporter;
  applyAuthoring?: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>;
  /** Film-role/plan-mode policy overrides plus the audit trail for POST /api/tools. */
  governance?: HttpToolGovernanceDependencies;
}

/** Agent-native DCC route. Blender execution remains server-side and path constrained. */
export async function handleDccRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: DccRouteDependencies,
): Promise<boolean> {
  const { readBody, getProject, blender, providers, exchangePackager, sceneImporter, returnImporter, applyAuthoring } =
    dependencies;
  // Reassigned with an audit-recording wrapper once a governed tool call is admitted.
  let json = dependencies.json;

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
    if (!returnImporter) {
      json(response, 503, {
        success: false,
        code: "return_import_unavailable",
        error: "Blender return importer is not configured.",
      });
      return true;
    }
    if (parsed.data.op === "import_return_package") {
      const plan = skipDirectorIds
        ? await returnImporter.buildImportPlan(parsed.data.package_dir, project, { skipDirectorIds })
        : await returnImporter.buildImportPlan(parsed.data.package_dir, project);
      json(response, plan.ready ? 200 : 409, {
        success: plan.ready,
        ...(plan.ready ? {} : { code: plan.conflicts[0]?.code ?? "conflict_unresolved" }),
        result: {
          ready: plan.ready,
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
    if (!applyAuthoring) {
      json(response, 503, {
        success: false,
        code: "browser_target_unavailable",
        error: "No Director authoring transport is configured for applying the import plan.",
      });
      return true;
    }
    const result = await returnImporter.applyImportPlan(
      parsed.data.plan,
      project,
      parsed.data.expected_revision,
      parsed.data.idempotency_key,
      applyAuthoring,
    );
    json(response, 200, { success: true, result });
  } catch (error) {
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
    json(response, 500, { success: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
