/**
 * Creative Workspace semantic operation executor.
 *
 * Translates high-level Agent creative-workspace requests (interchange,
 * collaboration, pipeline) into concrete browser-side operations.
 */

import type {
  DirectorCollaborationSession,
  DirectorReviewAnchor,
} from "../comprehensive/editor/collaboration/directorCollaboration";
import {
  persistentCreativeMediaLibrary,
  type PersistentCreativeMediaState,
} from "../comprehensive/editor/media/persistentCreativeMediaStore";
import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { stableLexicalJson } from "@director/protocol/stableJson";
import { useDirectorStore } from "../comprehensive/editor/store/directorStore";
import {
  getDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
  type DirectorCreativeWorkspaceState,
} from "../comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  getActiveDirectorCanvasPipelineHandle,
  startDirectorCanvasPipeline,
} from "../comprehensive/editor/workspaces/canvasPipeline";
import {
  creativeWorkspaceCollaborationToolResultSchema,
  creativeWorkspaceInterchangeToolResultSchema,
  creativeWorkspacePipelineToolResultSchema,
  type CreativeWorkspaceCollaborationRequest,
  type CreativeWorkspaceCollaborationToolResult,
  type CreativeWorkspaceInterchangeRequest,
  type CreativeWorkspaceInterchangeToolResult,
  type CreativeWorkspacePipelineRequest,
  type CreativeWorkspacePipelineToolResult,
  type CreativeWorkspaceInterchangeFormat as InterchangeFormat,
  type CreativeWorkspaceInterchangeImportPlan as InterchangeImportPlanRecord,
  type CreativeWorkspaceInterchangePlan as InterchangePlanRecord,
  type CreativeWorkspaceInterchangeWorkspace as InterchangeWorkspace,
  type CreativeWorkspaceReviewAnchor,
  type CreativeWorkspaceSemanticGuard as SemanticGuard,
} from "@director/protocol/creativeWorkspaceProtocol";
import {
  observeCreativeWorkspaceAgentSnapshot,
  projectCreativeWorkspacePipelineRun,
} from "./creativeWorkspaceAgentContract";
import interchangeFormats from "./creativeWorkspaceInterchangeFormats.json";

const MAX_INLINE_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_PLANS_PER_CONTEXT = 32;
const AGENT_IDENTITY_STORAGE_KEY = "director.collaboration.agent-identity.v1";
const COLLABORATION_UPDATE_KEY_PREFIX = "director.collaboration.update.v1";

/** Live workspace state bridge consumed by semantic operation executors. */
export interface CreativeWorkspaceSemanticContext {
  getScopeId(): string;
  getStageProject(): DirectorProject;
  replaceStageProject?(project: DirectorProject): void;
  getCreativeState(): DirectorCreativeWorkspaceState;
  getMediaState(): PersistentCreativeMediaState;
  getCreativeSnapshotFingerprint(): string;
  getCollaborationSession?(scopeId: string, signal?: AbortSignal): Promise<DirectorCollaborationSession>;
  resolveWorkspacePath?(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string }>;
}

const defaultSemanticContext: CreativeWorkspaceSemanticContext = {
  getScopeId: () => getDirectorCreativeWorkspaceScope(),
  getStageProject: () => useDirectorStore.getState().project,
  replaceStageProject: (project) => useDirectorStore.getState().replaceProject(project),
  getCreativeState: () => useDirectorCreativeWorkspaceStore.getState(),
  getMediaState: () => persistentCreativeMediaLibrary.store.getState(),
  getCreativeSnapshotFingerprint: () => observeCreativeWorkspaceAgentSnapshot().snapshot_fingerprint,
  getCollaborationSession: getManagedAgentCollaborationSession,
};

const interchangePlans = new WeakMap<object, Map<string, InterchangePlanRecord>>();
type PreparedImportPayload =
  | {
      kind: "stage";
      project: DirectorProject;
      warnings: string[];
      omitted: Array<{ code: string; subject: string; reason: string }>;
    }
  | {
      kind: "video";
      imported: { editTracks: unknown; editSettings: unknown; warnings: string[]; omitted?: unknown };
      warnings: string[];
      omitted: Array<{ code: string; subject: string; reason: string }>;
    };
const interchangeImportPayloads = new WeakMap<
  object,
  Map<string, { plan: InterchangeImportPlanRecord; payload: PreparedImportPayload }>
>();
const collaborationRevisions = new WeakMap<DirectorCollaborationSession, { content: string; revision: number }>();

function requestKeyId(prefix: string, key: string) {
  return `${prefix}-${key.replace(/[^A-Za-z0-9._:-]/g, "-")}`.slice(0, 160);
}

function plansFor(context: CreativeWorkspaceSemanticContext) {
  let plans = interchangePlans.get(context);
  if (!plans) {
    plans = new Map();
    interchangePlans.set(context, plans);
  }
  return plans;
}

function rememberPlan(context: CreativeWorkspaceSemanticContext, plan: InterchangePlanRecord) {
  const plans = plansFor(context);
  plans.delete(plan.plan_id);
  plans.set(plan.plan_id, plan);
  while (plans.size > MAX_PLANS_PER_CONTEXT) plans.delete(plans.keys().next().value!);
}

function normalizedScopeId(context: CreativeWorkspaceSemanticContext) {
  return context.getScopeId().trim() || "default";
}

function abortError(action: string, suggestedNext: string) {
  return {
    success: false as const,
    action,
    code: "aborted" as const,
    error: `${action} was cancelled before a stable receipt could be produced.`,
    suggested_next: suggestedNext,
  };
}

function safeFileName(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value
    .replace(/[\\/\0]/g, "-")
    .trim()
    .slice(0, 240);
  return normalized || fallback;
}

const FORMAT_CAPABILITIES = interchangeFormats as Array<{
  id: InterchangeFormat;
  workspaces: InterchangeWorkspace[];
  payload_encoding: "utf8" | "base64";
  mime_type: string;
  extensions: string[];
}>;

function formatCapability(format: InterchangeFormat) {
  return FORMAT_CAPABILITIES.find((candidate) => candidate.id === format)!;
}

function defaultExportFileName(workspace: InterchangeWorkspace, format: InterchangeFormat) {
  if (format === "obj" || format === "stl") return `director-${workspace}-${format}.zip`;
  const extension = formatCapability(format).extensions[0];
  return `director-${workspace}${extension}`;
}

function currentInterchangeGuard(
  context: CreativeWorkspaceSemanticContext,
  workspace: InterchangeWorkspace,
): SemanticGuard {
  return workspace === "stage"
    ? { kind: "stage_project_revision", fingerprint: getDirectorProjectRevision(context.getStageProject()) }
    : { kind: "creative_snapshot", fingerprint: context.getCreativeSnapshotFingerprint() };
}

function interchangeFailure(
  action: string,
  code:
    | "unsupported"
    | "not_found"
    | "stale_guard"
    | "capacity"
    | "unavailable"
    | "export_failed"
    | "import_failed"
    | "aborted",
  error: string,
  suggestedNext: string,
  currentGuard?: SemanticGuard,
): CreativeWorkspaceInterchangeToolResult {
  return creativeWorkspaceInterchangeToolResultSchema.parse({
    op: "interchange",
    result: {
      success: false,
      action,
      code,
      error,
      ...(currentGuard ? { current_guard: currentGuard } : {}),
      suggested_next: suggestedNext,
    },
  });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  }
  return btoa(binary);
}

function mediaSources(context: CreativeWorkspaceSemanticContext) {
  return context.getMediaState().assets.map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    sourceUrl: asset.source ?? asset.objectUrl,
    durationSec: asset.durationSec ?? undefined,
    availability: asset.objectUrl || asset.source ? ("online" as const) : ("offline" as const),
  }));
}

async function createInterchangePayload(
  context: CreativeWorkspaceSemanticContext,
  plan: InterchangePlanRecord,
): Promise<{
  bytes: Uint8Array;
  payload: string;
  warnings: string[];
  omitted: Array<{ code: string; subject: string; reason: string }>;
}> {
  const interchange = await import("../comprehensive/editor/interchange");
  let value: string | Uint8Array;
  let warnings: string[] = [];
  let omitted: Array<{ code: string; subject: string; reason: string }> = [];
  if (plan.workspace === "video") {
    const state = context.getCreativeState();
    const source = { editTracks: structuredClone(state.editTracks), editSettings: structuredClone(state.editSettings) };
    if (plan.format === "otio") {
      value = interchange.serializeDirectorCreativeTimelineToOtio(source, mediaSources(context));
    } else if (plan.format === "otioz") {
      value = await interchange.exportDirectorCreativeTimelineToOtioz(source, mediaSources(context));
    } else {
      throw new Error(`${plan.format} export is not defined for the Video Editor workspace`);
    }
  } else {
    const project = structuredClone(context.getStageProject());
    if (plan.format === "otio") value = interchange.serializeDirectorProjectToOtio(project);
    else if (plan.format === "otioz") value = await interchange.exportDirectorProjectToOtioz(project);
    else if (plan.format === "fountain") value = interchange.exportDirectorProjectToFountain(project);
    else if (plan.format === "gltf") value = await interchange.serializeDirectorProjectToGltf(project);
    else if (plan.format === "glb") value = await interchange.exportDirectorProjectToGlb(project);
    else if (plan.format === "usd") value = interchange.exportDirectorProjectToUsda(project);
    else if (plan.format === "usdz") value = await interchange.exportDirectorProjectToUsdz(project);
    else if (plan.format === "obj") {
      const archive = await interchange.exportDirectorProjectToObjArchive(project, {
        objectIds: plan.object_ids ?? undefined,
      });
      value = archive.bytes;
      warnings = archive.report.warnings;
      omitted = meshExportOmissions(archive.report);
    } else {
      const archive = await interchange.exportDirectorProjectToStlArchive(project, {
        objectIds: plan.object_ids ?? undefined,
      });
      value = archive.bytes;
      warnings = archive.report.warnings;
      omitted = meshExportOmissions(archive.report);
    }
  }
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return { bytes, payload: typeof value === "string" ? value : bytesToBase64(bytes), warnings, omitted };
}

/** Project the typed mesh loss report onto interchange receipt omissions: subject is the exact Stage object ID. */
function meshExportOmissions(report: {
  omitted: Array<{ stableId: string; code: string; reason: string }>;
}): Array<{ code: string; subject: string; reason: string }> {
  return report.omitted
    .slice(0, 50)
    .map((entry) => ({ code: entry.code, subject: entry.stableId, reason: entry.reason }));
}

/**
 * Execute an interchange request (import/export) within the active workspace.
 *
 * @param input - The validated interchange request from the Agent.
 * @param context - The live workspace state bridge.
 * @returns A structured interchange tool result.
 */
export async function executeCreativeWorkspaceInterchangeRequest(
  input: CreativeWorkspaceInterchangeRequest,
  context: CreativeWorkspaceSemanticContext = defaultSemanticContext,
  signal?: AbortSignal,
): Promise<CreativeWorkspaceInterchangeToolResult> {
  const request = input.request;
  if (request.action === "capabilities") {
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: {
        success: true,
        action: "capabilities",
        contract: "director-interchange-agent-v1",
        formats: FORMAT_CAPABILITIES,
        actions: ["capabilities", "plan-export", "export", "plan-import", "import"],
        import_mode: "agent-transfer",
        max_inline_bytes: MAX_INLINE_EXPORT_BYTES,
      },
    });
  }
  if (signal?.aborted) {
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: abortError(request.action, "Retry against a freshly observed target."),
    });
  }
  if (request.action === "plan-export") {
    const capability = formatCapability(request.format);
    if (!capability.workspaces.includes(request.workspace as never)) {
      return interchangeFailure(
        request.action,
        "unsupported",
        `${request.format} export is not supported for the ${request.workspace} workspace.`,
        `Use ${capability.workspaces.join(" or ")} for this format, or choose OTIO/OTIOZ for Video Editor exchange.`,
      );
    }
    const isMeshExport = request.format === "obj" || request.format === "stl";
    if (request.object_ids && (!isMeshExport || request.workspace !== "stage")) {
      return interchangeFailure(
        request.action,
        "unsupported",
        "object_ids scope is supported only for Stage OBJ/STL mesh export.",
        "Remove object_ids for this format, or choose Stage OBJ/STL export.",
      );
    }
    if (request.object_ids) {
      const knownObjectIds = new Set(context.getStageProject().objects.map((object) => object.id));
      const unknownObjectIds = request.object_ids.filter((objectId) => !knownObjectIds.has(objectId));
      if (unknownObjectIds.length) {
        return interchangeFailure(
          request.action,
          "not_found",
          `Stage mesh scope contains unknown object id(s): ${unknownObjectIds.join(", ")}`,
          "Observe the current Stage, then retry with exact object IDs from that snapshot.",
        );
      }
    }
    const guard = currentInterchangeGuard(context, request.workspace);
    const plan: InterchangePlanRecord = {
      contract: "director-interchange-plan-v1",
      plan_id: `interchange-plan:v1:${crypto.randomUUID()}`,
      format: request.format,
      workspace: request.workspace,
      file_name: safeFileName(request.file_name, defaultExportFileName(request.workspace, request.format)),
      mime_type: capability.mime_type,
      payload_encoding: capability.payload_encoding,
      object_ids: request.object_ids ?? null,
      max_inline_bytes: request.max_inline_bytes,
      guard,
      warnings:
        request.format === "gltf" || request.format === "glb"
          ? ["glTF/GLB contains the Director interchange scene contract; linked runtime assets remain URI references."]
          : isMeshExport
            ? [
                `${request.format.toUpperCase()} transfer is a ZIP containing static primitive geometry and director-export.json with units, axes, stable IDs, and omissions.`,
                request.object_ids
                  ? `Selection scope contains ${request.object_ids.length} exact Stage object ID(s).`
                  : "Scope contains all visible supported Stage primitives.",
              ]
            : [],
    };
    rememberPlan(context, plan);
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: { success: true, action: "plan-export", plan },
    });
  }

  if (request.action === "plan-import") {
    return planInterchangeImport(request, context, signal);
  }

  if (request.action === "import") {
    return commitInterchangeImport(request, context, signal);
  }

  const plan = plansFor(context).get(request.plan_id);
  if (!plan) {
    return interchangeFailure(
      request.action,
      "not_found",
      `Interchange plan ${request.plan_id} is not available on this browser target.`,
      "Call interchange plan-export again on the current exact target, then export that returned plan_id.",
    );
  }
  const beforeGuard = currentInterchangeGuard(context, plan.workspace);
  if (
    request.expected_guard_fingerprint !== plan.guard.fingerprint ||
    beforeGuard.fingerprint !== plan.guard.fingerprint
  ) {
    return interchangeFailure(
      request.action,
      "stale_guard",
      "The Stage or Video workspace changed after this export plan was created.",
      "Create a new plan-export and pass its exact guard fingerprint.",
      beforeGuard,
    );
  }
  try {
    const { bytes, payload, warnings, omitted } = await createInterchangePayload(context, plan);
    if (signal?.aborted) {
      return creativeWorkspaceInterchangeToolResultSchema.parse({
        op: "interchange",
        result: abortError(request.action, "Retry plan-export and export on the current target."),
      });
    }
    if (bytes.byteLength > plan.max_inline_bytes || bytes.byteLength > MAX_INLINE_EXPORT_BYTES) {
      return interchangeFailure(
        request.action,
        "capacity",
        `The ${plan.format} payload is ${bytes.byteLength} bytes, above the bounded inline limit of ${plan.max_inline_bytes} bytes.`,
        "Use the human Interchange menu for a file download, or create a plan with a larger max_inline_bytes up to 8388608.",
        beforeGuard,
      );
    }
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: {
        success: true,
        action: "export",
        receipt: {
          contract: "director-interchange-export-v1",
          receipt_id: `interchange-receipt:v1:${crypto.randomUUID()}`,
          plan_id: plan.plan_id,
          format: plan.format,
          workspace: plan.workspace,
          file_name: plan.file_name,
          mime_type: plan.mime_type,
          payload_encoding: plan.payload_encoding,
          byte_length: bytes.byteLength,
          guard: beforeGuard,
          payload,
          warnings: [...new Set([...plan.warnings, ...warnings])].slice(0, 50),
          ...(omitted.length ? { omitted_count: omitted.length, omitted } : {}),
        },
      },
    });
  } catch (error) {
    return interchangeFailure(
      request.action,
      "export_failed",
      error instanceof Error ? error.message : String(error),
      "Inspect the Stage/Video source data, correct invalid asset bindings, then create a fresh export plan.",
      currentInterchangeGuard(context, plan.workspace),
    );
  }
}

function importPayloadsFor(context: CreativeWorkspaceSemanticContext) {
  let payloads = interchangeImportPayloads.get(context);
  if (!payloads) {
    payloads = new Map();
    interchangeImportPayloads.set(context, payloads);
  }
  return payloads;
}

function rememberImportPlan(
  context: CreativeWorkspaceSemanticContext,
  plan: InterchangeImportPlanRecord,
  payload: PreparedImportPayload,
) {
  const payloads = importPayloadsFor(context);
  payloads.delete(plan.plan_id);
  payloads.set(plan.plan_id, { plan, payload });
  while (payloads.size > MAX_PLANS_PER_CONTEXT) payloads.delete(payloads.keys().next().value!);
}

function base64ToBytes(payload: string) {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function resolveImportSourceBytes(
  context: CreativeWorkspaceSemanticContext,
  source: Extract<CreativeWorkspaceInterchangeRequest["request"], { action: "plan-import" }>["source"],
  maxInlineBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; fileName: string; sourceKind: "inline" | "media_id" | "workspace_path" }> {
  if (source.kind === "inline") {
    const bytes = source.encoding === "utf8" ? new TextEncoder().encode(source.payload) : base64ToBytes(source.payload);
    if (bytes.byteLength > maxInlineBytes || bytes.byteLength > MAX_INLINE_EXPORT_BYTES) {
      throw Object.assign(
        new Error(`Inline import payload is ${bytes.byteLength} bytes, above the ${maxInlineBytes} byte limit.`),
        {
          code: "capacity" as const,
        },
      );
    }
    return {
      bytes,
      fileName: safeFileName(source.file_name, "director-import.bin"),
      sourceKind: "inline",
    };
  }
  if (source.kind === "media_id") {
    const blob = await persistentCreativeMediaLibrary.getBlob(source.media_id);
    if (!blob) {
      throw Object.assign(new Error(`Gallery media ${source.media_id} is not available as import bytes.`), {
        code: "not_found" as const,
      });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > maxInlineBytes || bytes.byteLength > MAX_INLINE_EXPORT_BYTES) {
      throw Object.assign(
        new Error(`Media ${source.media_id} is ${bytes.byteLength} bytes, above the ${maxInlineBytes} byte limit.`),
        {
          code: "capacity" as const,
        },
      );
    }
    const asset = persistentCreativeMediaLibrary.getAsset(source.media_id);
    return {
      bytes,
      fileName: safeFileName(asset?.name, `${source.media_id}.bin`),
      sourceKind: "media_id",
    };
  }
  if (!context.resolveWorkspacePath) {
    throw Object.assign(
      new Error(
        "workspace_path imports require a host that can read the Agent workspace; use inline or media_id in the browser.",
      ),
      { code: "unavailable" as const },
    );
  }
  if (signal?.aborted) {
    throw Object.assign(new Error("Import source resolution was cancelled."), { code: "aborted" as const });
  }
  const resolved = await context.resolveWorkspacePath(source.path, signal);
  if (resolved.bytes.byteLength > maxInlineBytes || resolved.bytes.byteLength > MAX_INLINE_EXPORT_BYTES) {
    throw Object.assign(
      new Error(
        `Workspace path ${source.path} is ${resolved.bytes.byteLength} bytes, above the ${maxInlineBytes} byte limit.`,
      ),
      { code: "capacity" as const },
    );
  }
  return {
    bytes: resolved.bytes,
    fileName: safeFileName(resolved.fileName, source.path.split(/[\\/]/).at(-1) ?? "import.bin"),
    sourceKind: "workspace_path",
  };
}

async function parseInterchangeImport(
  context: CreativeWorkspaceSemanticContext,
  format: InterchangeFormat,
  workspace: InterchangeWorkspace,
  bytes: Uint8Array,
): Promise<PreparedImportPayload> {
  const interchange = await import("../comprehensive/editor/interchange");
  const text = () => new TextDecoder().decode(bytes);
  if (workspace === "video") {
    if (format !== "otio" && format !== "otioz") {
      throw new Error(`${format} import is not defined for the Video Editor workspace`);
    }
    const knownMediaIds = mediaSources(context)
      .filter((asset) => asset.availability === "online")
      .map((asset) => asset.id);
    const imported =
      format === "otio"
        ? interchange.importDirectorCreativeTimelineFromOtio(text(), { knownMediaIds })
        : await interchange.importDirectorCreativeTimelineFromOtioz(bytes, { knownMediaIds });
    const videoOmitted = Array.isArray((imported as unknown as { omitted?: unknown }).omitted)
      ? (imported as unknown as { omitted: Array<{ code: string; subject: string; reason: string }> }).omitted.slice(
          0,
          50,
        )
      : [];
    return {
      kind: "video",
      imported,
      warnings: imported.warnings,
      omitted: videoOmitted,
    };
  }
  if (format === "obj" || format === "stl") {
    throw new Error(`${format.toUpperCase()} import is not supported; only Stage mesh export is available`);
  }
  const baseProject = context.getStageProject();
  let result: {
    project: DirectorProject;
    warnings: string[];
    omitted?: Array<{ code: string; subject: string; reason: string }>;
  };
  if (format === "otio") result = interchange.importDirectorProjectFromOtio(text(), { baseProject });
  else if (format === "otioz") result = await interchange.importDirectorProjectFromOtioz(bytes, { baseProject });
  else if (format === "fountain") result = interchange.importDirectorProjectFromFountain(text(), { baseProject });
  else if (format === "gltf") result = await interchange.importDirectorProjectFromGltf(text(), { baseProject });
  else if (format === "glb") result = await interchange.importDirectorProjectFromGlb(bytes, { baseProject });
  else if (format === "usd") result = interchange.importDirectorProjectFromUsda(text(), { baseProject });
  else if (format === "usdz") result = await interchange.importDirectorProjectFromUsdz(bytes, { baseProject });
  else throw new Error(`${format} import is not supported`);
  return {
    kind: "stage",
    project: result.project,
    warnings: result.warnings,
    omitted: Array.isArray(result.omitted) ? result.omitted.slice(0, 50) : [],
  };
}

async function planInterchangeImport(
  request: Extract<CreativeWorkspaceInterchangeRequest["request"], { action: "plan-import" }>,
  context: CreativeWorkspaceSemanticContext,
  signal?: AbortSignal,
): Promise<CreativeWorkspaceInterchangeToolResult> {
  const capability = formatCapability(request.format);
  if (!capability.workspaces.includes(request.workspace as never)) {
    return interchangeFailure(
      request.action,
      "unsupported",
      `${request.format} import is not supported for the ${request.workspace} workspace.`,
      `Use ${capability.workspaces.join(" or ")} for this format, or choose OTIO/OTIOZ for Video Editor exchange.`,
    );
  }
  try {
    const resolved = await resolveImportSourceBytes(context, request.source, request.max_inline_bytes, signal);
    if (signal?.aborted) {
      return creativeWorkspaceInterchangeToolResultSchema.parse({
        op: "interchange",
        result: abortError(request.action, "Retry plan-import on the current target."),
      });
    }
    const payload = await parseInterchangeImport(context, request.format, request.workspace, resolved.bytes);
    const guard = currentInterchangeGuard(context, request.workspace);
    const summary =
      payload.kind === "stage"
        ? {
            stage_objects: payload.project.objects.length,
            cameras: payload.project.cameras.length,
          }
        : {
            video_tracks: Array.isArray((payload.imported as { editTracks?: unknown[] }).editTracks)
              ? (payload.imported as { editTracks: unknown[] }).editTracks.length
              : 0,
            video_clips: Array.isArray((payload.imported as { editTracks?: Array<{ clips?: unknown[] }> }).editTracks)
              ? (payload.imported as { editTracks: Array<{ clips?: unknown[] }> }).editTracks.reduce(
                  (total, track) => total + (track.clips?.length ?? 0),
                  0,
                )
              : 0,
          };
    const plan: InterchangeImportPlanRecord = {
      contract: "director-interchange-import-plan-v1",
      plan_id: `interchange-plan:v1:${crypto.randomUUID()}`,
      format: request.format,
      workspace: request.workspace,
      file_name: resolved.fileName,
      source_kind: resolved.sourceKind,
      byte_length: resolved.bytes.byteLength,
      guard,
      summary,
      warnings: payload.warnings.slice(0, 50),
      ...(payload.omitted.length
        ? {
            omitted_count: payload.omitted.length,
            omitted: payload.omitted.slice(0, 50) as InterchangeImportPlanRecord["omitted"],
          }
        : {}),
    };
    rememberImportPlan(context, plan, payload);
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: { success: true, action: "plan-import", plan },
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (
            error as {
              code:
                | "unsupported"
                | "not_found"
                | "stale_guard"
                | "capacity"
                | "unavailable"
                | "export_failed"
                | "import_failed"
                | "aborted";
            }
          ).code
        : "import_failed";
    return interchangeFailure(
      request.action,
      code,
      error instanceof Error ? error.message : String(error),
      "Provide a bounded inline payload, an available Gallery media_id, or a readable workspace_path, then retry plan-import.",
      currentInterchangeGuard(context, request.workspace),
    );
  }
}

async function commitInterchangeImport(
  request: Extract<CreativeWorkspaceInterchangeRequest["request"], { action: "import" }>,
  context: CreativeWorkspaceSemanticContext,
  signal?: AbortSignal,
): Promise<CreativeWorkspaceInterchangeToolResult> {
  const prepared = importPayloadsFor(context).get(request.plan_id);
  if (!prepared) {
    return interchangeFailure(
      request.action,
      "not_found",
      `Interchange import plan ${request.plan_id} is not available on this browser target.`,
      "Call interchange plan-import again on the current exact target, then import that returned plan_id with confirm:true.",
    );
  }
  const { plan, payload } = prepared;
  const beforeGuard = currentInterchangeGuard(context, plan.workspace);
  if (
    request.expected_guard_fingerprint !== plan.guard.fingerprint ||
    beforeGuard.fingerprint !== plan.guard.fingerprint
  ) {
    return interchangeFailure(
      request.action,
      "stale_guard",
      "The Stage or Video workspace changed after this import plan was created.",
      "Create a new plan-import and pass its exact guard fingerprint.",
      beforeGuard,
    );
  }
  if (signal?.aborted) {
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: abortError(request.action, "Retry plan-import and import on the current target."),
    });
  }
  try {
    if (payload.kind === "stage") {
      (
        context.replaceStageProject ??
        ((project: DirectorProject) => useDirectorStore.getState().replaceProject(project))
      )(payload.project);
    } else {
      const interchange = await import("../comprehensive/editor/interchange");
      if (!interchange.applyDirectorCreativeOtioImport(payload.imported as never)) {
        throw new Error("Video Editor timeline import failed");
      }
    }
    const afterGuard = currentInterchangeGuard(context, plan.workspace);
    importPayloadsFor(context).delete(plan.plan_id);
    return creativeWorkspaceInterchangeToolResultSchema.parse({
      op: "interchange",
      result: {
        success: true,
        action: "import",
        receipt: {
          contract: "director-interchange-import-v1",
          receipt_id: `interchange-receipt:v1:${crypto.randomUUID()}`,
          plan_id: plan.plan_id,
          format: plan.format,
          workspace: plan.workspace,
          file_name: plan.file_name,
          before_guard: beforeGuard,
          after_guard: afterGuard,
          warnings: plan.warnings,
          ...(plan.omitted !== undefined
            ? {
                omitted_count: plan.omitted_count ?? plan.omitted.length,
                omitted: plan.omitted,
              }
            : {}),
        },
      },
    });
  } catch (error) {
    return interchangeFailure(
      request.action,
      "import_failed",
      error instanceof Error ? error.message : String(error),
      "Inspect the import source, correct invalid bindings, then create a fresh import plan.",
      currentInterchangeGuard(context, plan.workspace),
    );
  }
}

function collaborationPersistenceKey(scopeId: string) {
  return `${COLLABORATION_UPDATE_KEY_PREFIX}.${scopeId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "local"}`;
}

function agentIdentity() {
  const fallback = {
    id: `agent-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    name: "Director Agent",
    color: "#7c5cff",
  };
  try {
    const stored = window.sessionStorage.getItem(AGENT_IDENTITY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as typeof fallback;
      if (parsed.id && parsed.name && /^#[0-9a-f]{6}$/i.test(parsed.color)) return parsed;
    }
    window.sessionStorage.setItem(AGENT_IDENTITY_STORAGE_KEY, JSON.stringify(fallback));
  } catch {
    // A private context may deny storage. The live session still has a distinct identity.
  }
  return fallback;
}

const managedCollaborationSessions = new Map<
  string,
  Promise<{ session: DirectorCollaborationSession; dispose: () => void }>
>();

async function waitForCollaborationSync(signal?: AbortSignal) {
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, 120);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function createManagedAgentCollaborationSession(scopeId: string, signal?: AbortSignal) {
  const [collaboration, gateway] = await Promise.all([
    import("../comprehensive/editor/collaboration/directorCollaboration"),
    import("../comprehensive/editor/collaboration/directorCollaborationGatewayTransport"),
  ]);
  const session = new collaboration.DirectorCollaborationSession({ scopeId, identity: agentIdentity() });
  try {
    const persisted = window.localStorage.getItem(collaborationPersistenceKey(scopeId));
    if (persisted) session.applyPersistenceUpdate(persisted);
  } catch {
    // Live transports remain authoritative when persistence is unavailable.
  }
  const transports = [
    collaboration.createBroadcastChannelDirectorTransport(scopeId),
    gateway.createGatewayWebSocketDirectorTransport(scopeId, session.doc.clientID),
  ].filter((candidate) => candidate !== null);
  const detach = transports.map((transport) => session.attachTransport(transport));
  await waitForCollaborationSync(signal);
  return {
    session,
    dispose: () => {
      detach.forEach((stop) => stop());
      session.destroy();
    },
  };
}

async function getManagedAgentCollaborationSession(scopeId: string, signal?: AbortSignal) {
  let managed = managedCollaborationSessions.get(scopeId);
  if (!managed) {
    managed = createManagedAgentCollaborationSession(scopeId, signal);
    managedCollaborationSessions.set(scopeId, managed);
    void managed.catch(() => managedCollaborationSessions.delete(scopeId));
    while (managedCollaborationSessions.size > 8) {
      const oldest = managedCollaborationSessions.entries().next().value as
        [string, Promise<{ session: DirectorCollaborationSession; dispose: () => void }>] | undefined;
      if (!oldest) break;
      managedCollaborationSessions.delete(oldest[0]);
      void oldest[1].then((entry) => entry.dispose()).catch(() => undefined);
    }
  }
  return (await managed).session;
}

function toDirectorAnchor(anchor: CreativeWorkspaceReviewAnchor): DirectorReviewAnchor {
  if (anchor.type === "scene") return { type: "scene", sceneId: anchor.scene_id };
  if (anchor.type === "object") return { type: "object", sceneId: anchor.scene_id, objectId: anchor.object_id };
  return {
    type: "time",
    sceneId: anchor.scene_id,
    frame: anchor.frame,
    ...(anchor.track_id ? { trackId: anchor.track_id } : {}),
  };
}

function fromDirectorAnchor(anchor: DirectorReviewAnchor): CreativeWorkspaceReviewAnchor {
  if (anchor.type === "scene") return { type: "scene", scene_id: anchor.sceneId };
  if (anchor.type === "object") return { type: "object", scene_id: anchor.sceneId, object_id: anchor.objectId };
  return {
    type: "time",
    scene_id: anchor.sceneId,
    frame: anchor.frame,
    ...(anchor.trackId ? { track_id: anchor.trackId } : {}),
  };
}

function collaborationComment(comment: ReturnType<DirectorCollaborationSession["addReviewComment"]>) {
  return {
    id: comment.id,
    anchor: fromDirectorAnchor(comment.anchor),
    author: comment.author,
    body: comment.body,
    status: comment.status,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    ...(comment.resolvedAt ? { resolved_at: comment.resolvedAt } : {}),
    ...(comment.resolvedBy ? { resolved_by: comment.resolvedBy } : {}),
  };
}

function collaborationFingerprint(session: DirectorCollaborationSession) {
  const shared = session.getSharedState();
  const comments = session
    .getReviewComments()
    .map(collaborationComment)
    .sort((left, right) => left.id.localeCompare(right.id));
  const versions = session
    .listVersionSnapshots()
    .map(({ id, name, author, createdAt }) => ({ id, name, author, createdAt }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const content = stableLexicalJson({
    scopeId: session.scopeId,
    shared: shared ?? null,
    comments,
    versions,
  });
  const previous = collaborationRevisions.get(session);
  if (previous?.content === content) return `collaboration-revision:v1:${previous.revision}`;
  const revision = (previous?.revision ?? 0) + 1;
  collaborationRevisions.set(session, { content, revision });
  return `collaboration-revision:v1:${revision}`;
}

function collaborationGuard(session: DirectorCollaborationSession): SemanticGuard {
  return { kind: "collaboration_state", fingerprint: collaborationFingerprint(session) };
}

function collaborationFailure(
  action: string,
  code: "not_found" | "stale_guard" | "unavailable" | "invalid_anchor" | "conflict" | "operation_rejected" | "aborted",
  error: string,
  suggestedNext: string,
  session?: DirectorCollaborationSession,
): CreativeWorkspaceCollaborationToolResult {
  return creativeWorkspaceCollaborationToolResultSchema.parse({
    op: "collaboration",
    result: {
      success: false,
      action,
      code,
      error,
      ...(session ? { current_guard: collaborationGuard(session) } : {}),
      suggested_next: suggestedNext,
    },
  });
}

function validateCollaborationAnchor(session: DirectorCollaborationSession, anchor: CreativeWorkspaceReviewAnchor) {
  if (anchor.scene_id !== session.scopeId)
    return `Anchor scene ${anchor.scene_id} is not exact room ${session.scopeId}.`;
  const shared = session.getSharedState();
  if (!shared) return "The collaboration room has not synchronized a shared Director project yet.";
  if (anchor.type === "object" && !shared.stage.objects.some((object) => object.id === anchor.object_id)) {
    return `Object ${anchor.object_id} does not exist in collaboration room ${session.scopeId}.`;
  }
  if (anchor.type === "time") {
    const timeline = shared.stage.scene.timeline;
    if (timeline && (anchor.frame < timeline.frameStart || anchor.frame > timeline.frameEnd)) {
      return `Frame ${anchor.frame} is outside the Stage range ${timeline.frameStart}-${timeline.frameEnd}.`;
    }
    if (anchor.track_id && !shared.creative.editTracks.some((track) => track.id === anchor.track_id)) {
      return `Track ${anchor.track_id} does not exist in collaboration room ${session.scopeId}.`;
    }
  }
  return null;
}

function versionMetadata(version: ReturnType<DirectorCollaborationSession["listVersionSnapshots"]>[number]) {
  return { id: version.id, name: version.name, author: version.author, created_at: version.createdAt };
}

function comparisonResult(
  comparison: NonNullable<ReturnType<DirectorCollaborationSession["compareVersionToCurrent"]>>,
) {
  return {
    before_version_id: comparison.versionId,
    after_version_id: comparison.comparedToVersionId ?? null,
    changes: comparison.changes,
    truncated: comparison.truncated,
    summary: {
      added: comparison.summary.added,
      removed: comparison.summary.removed,
      changed: comparison.summary.changed,
      stage_objects_before: comparison.summary.stageObjectsBefore,
      stage_objects_after: comparison.summary.stageObjectsAfter,
      cameras_before: comparison.summary.camerasBefore,
      cameras_after: comparison.summary.camerasAfter,
      canvas_nodes_before: comparison.summary.canvasNodesBefore,
      canvas_nodes_after: comparison.summary.canvasNodesAfter,
      video_clips_before: comparison.summary.videoClipsBefore,
      video_clips_after: comparison.summary.videoClipsAfter,
    },
  };
}

export async function executeCreativeWorkspaceCollaborationRequest(
  input: CreativeWorkspaceCollaborationRequest,
  context: CreativeWorkspaceSemanticContext = defaultSemanticContext,
  signal?: AbortSignal,
): Promise<CreativeWorkspaceCollaborationToolResult> {
  const action = input.request.action;
  if (signal?.aborted) {
    return creativeWorkspaceCollaborationToolResultSchema.parse({
      op: "collaboration",
      result: abortError(action, "Observe the current collaboration target and retry."),
    });
  }
  let session: DirectorCollaborationSession;
  try {
    session = await (context.getCollaborationSession ?? getManagedAgentCollaborationSession)(
      normalizedScopeId(context),
      signal,
    );
  } catch (error) {
    return collaborationFailure(
      action,
      "unavailable",
      error instanceof Error ? error.message : String(error),
      "Keep the exact Director browser target open with collaboration enabled, then retry observe.",
    );
  }
  if (signal?.aborted) {
    return collaborationFailure(
      action,
      "aborted",
      "Collaboration request was cancelled.",
      "Observe and retry.",
      session,
    );
  }

  const fingerprint = collaborationFingerprint(session);
  if (action === "observe") {
    const shared = session.getSharedState();
    return creativeWorkspaceCollaborationToolResultSchema.parse({
      op: "collaboration",
      result: {
        success: true,
        action,
        state: {
          contract: "director-collaboration-agent-v1",
          room_id: session.scopeId,
          ready: Boolean(shared),
          collaboration_fingerprint: fingerprint,
          shared_project_revision: shared ? getDirectorProjectRevision(shared.stage) : null,
          agent_identity: session.identity,
          participant_count: session.getPresences().length,
          comment_count: session.getReviewComments().length,
          version_count: session.listVersionSnapshots().length,
        },
      },
    });
  }
  if (action === "list-comments") {
    if (input.request.anchor) {
      const issue = validateCollaborationAnchor(session, input.request.anchor);
      if (issue)
        return collaborationFailure(
          action,
          "invalid_anchor",
          issue,
          "Observe the exact room and use IDs from its current shared state.",
          session,
        );
    }
    const comments = session
      .getReviewComments({
        ...(input.request.status ? { status: input.request.status } : {}),
        ...(input.request.anchor ? { anchor: toDirectorAnchor(input.request.anchor) } : {}),
      })
      .map(collaborationComment);
    return creativeWorkspaceCollaborationToolResultSchema.parse({
      op: "collaboration",
      result: { success: true, action, collaboration_fingerprint: fingerprint, comments },
    });
  }
  if (action === "list-versions") {
    return creativeWorkspaceCollaborationToolResultSchema.parse({
      op: "collaboration",
      result: {
        success: true,
        action,
        collaboration_fingerprint: fingerprint,
        versions: session.listVersionSnapshots().map(versionMetadata),
      },
    });
  }
  if (action === "compare") {
    const comparison = input.request.after_version_id
      ? session.compareVersionSnapshots(input.request.before_version_id, input.request.after_version_id)
      : session.compareVersionToCurrent(input.request.before_version_id);
    if (!comparison) {
      return collaborationFailure(
        action,
        "not_found",
        input.request.after_version_id
          ? "One or both requested version IDs do not exist in this exact collaboration room."
          : "The requested version does not exist, or the current shared state is not synchronized.",
        "Call list-versions and observe, then compare using exact returned IDs.",
        session,
      );
    }
    return creativeWorkspaceCollaborationToolResultSchema.parse({
      op: "collaboration",
      result: {
        success: true,
        action,
        collaboration_fingerprint: fingerprint,
        comparison: comparisonResult(comparison),
      },
    });
  }

  if (!input.request.expected_collaboration_fingerprint) {
    return collaborationFailure(
      action,
      "stale_guard",
      `Collaboration ${action} requires expected_collaboration_fingerprint at the browser execution boundary.`,
      "Use the public Agent boundary so it can observe and inject the current collaboration guard.",
      session,
    );
  }
  if (!input.request.idempotency_key) {
    return collaborationFailure(
      action,
      "conflict",
      `Collaboration ${action} requires idempotency_key at the browser execution boundary.`,
      "Use the public Agent boundary so it can assign a stable retry key.",
      session,
    );
  }

  const idempotencyKey = input.request.idempotency_key;

  // Idempotent retries must succeed even after the first write advanced the fingerprint.
  if (action === "add-comment") {
    const commentId = requestKeyId("agent-review", idempotencyKey);
    const priorComment = session.getReviewComments().find((comment) => comment.id === commentId);
    if (priorComment) {
      const sameIntent =
        priorComment.body === input.request.body &&
        stableLexicalJson(priorComment.anchor) === stableLexicalJson(toDirectorAnchor(input.request.anchor));
      if (!sameIntent) {
        return collaborationFailure(
          action,
          "conflict",
          `Request key "${idempotencyKey}" was already used for a different collaboration comment.`,
          "Use a new request key for a changed comment.",
          session,
        );
      }
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-comment-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: fingerprint,
            comment: collaborationComment(priorComment),
            idempotency: { key: idempotencyKey, replayed: true },
          },
        },
      });
    }
  }

  if (input.request.expected_collaboration_fingerprint !== fingerprint) {
    return collaborationFailure(
      action,
      "stale_guard",
      `Collaboration state changed since observe (expected ${input.request.expected_collaboration_fingerprint}, current ${fingerprint}).`,
      "Observe again and retry with the current collaboration state.",
      session,
    );
  }

  try {
    if (action === "add-comment") {
      const issue = validateCollaborationAnchor(session, input.request.anchor);
      if (issue) {
        return collaborationFailure(
          action,
          session.getSharedState() ? "invalid_anchor" : "unavailable",
          issue,
          "Observe the synchronized room and anchor the comment to its exact scene/object/track IDs.",
          session,
        );
      }
      const commentId = requestKeyId("agent-review", idempotencyKey);
      const comment = session.addReviewComment({
        id: commentId,
        anchor: toDirectorAnchor(input.request.anchor),
        body: input.request.body,
        author: session.identity,
      });
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-comment-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: collaborationFingerprint(session),
            comment: collaborationComment(comment),
            idempotency: { key: idempotencyKey, replayed: false },
          },
        },
      });
    }

    if (
      input.request.action === "resolve-comment" ||
      input.request.action === "reopen-comment" ||
      input.request.action === "update-comment"
    ) {
      const request = input.request;
      const comment = session.getReviewComments().find((entry) => entry.id === request.comment_id);
      if (!comment) {
        return collaborationFailure(
          action,
          "not_found",
          `Comment ${request.comment_id} does not exist in this collaboration room.`,
          "Call list-comments and retry with an exact returned comment ID.",
          session,
        );
      }
      if (request.action === "update-comment") {
        if (!session.updateReviewComment(request.comment_id, request.body)) {
          return collaborationFailure(
            action,
            "operation_rejected",
            `Unable to update comment ${request.comment_id}.`,
            "Observe the room and retry.",
            session,
          );
        }
      } else {
        const status = action === "resolve-comment" ? "resolved" : "open";
        if (comment.status === status) {
          return creativeWorkspaceCollaborationToolResultSchema.parse({
            op: "collaboration",
            result: {
              success: true,
              action,
              receipt: {
                contract: "director-collaboration-comment-v1",
                receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
                before_fingerprint: fingerprint,
                after_fingerprint: fingerprint,
                comment: collaborationComment(comment),
                idempotency: { key: idempotencyKey, replayed: true },
              },
            },
          });
        }
        if (!session.setReviewCommentStatus(request.comment_id, status)) {
          return collaborationFailure(
            action,
            "operation_rejected",
            `Unable to ${action === "resolve-comment" ? "resolve" : "reopen"} comment ${request.comment_id}.`,
            "Observe the room and retry.",
            session,
          );
        }
      }
      const updated = session.getReviewComments().find((entry) => entry.id === request.comment_id);
      if (!updated) {
        return collaborationFailure(
          action,
          "operation_rejected",
          `Comment ${request.comment_id} disappeared after the write.`,
          "Observe the room and retry.",
          session,
        );
      }
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-comment-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: collaborationFingerprint(session),
            comment: collaborationComment(updated),
            idempotency: { key: idempotencyKey, replayed: false },
          },
        },
      });
    }

    if (input.request.action === "delete-comment") {
      const request = input.request;
      const existed = session.getReviewComments().some((entry) => entry.id === request.comment_id);
      if (!existed) {
        return creativeWorkspaceCollaborationToolResultSchema.parse({
          op: "collaboration",
          result: {
            success: true,
            action,
            receipt: {
              contract: "director-collaboration-comment-delete-v1",
              receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
              before_fingerprint: fingerprint,
              after_fingerprint: fingerprint,
              comment_id: request.comment_id,
              idempotency: { key: idempotencyKey, replayed: true },
            },
          },
        });
      }
      if (!session.deleteReviewComment(request.comment_id)) {
        return collaborationFailure(
          action,
          "operation_rejected",
          `Unable to delete comment ${request.comment_id}.`,
          "Observe the room and retry.",
          session,
        );
      }
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-comment-delete-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: collaborationFingerprint(session),
            comment_id: request.comment_id,
            idempotency: { key: idempotencyKey, replayed: false },
          },
        },
      });
    }

    if (action === "create-version") {
      const version = session.createVersionSnapshot({ name: input.request.name });
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-version-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: collaborationFingerprint(session),
            version: versionMetadata(version),
            version_id: version.id,
            idempotency: { key: idempotencyKey, replayed: false },
          },
        },
      });
    }

    if (input.request.action === "restore-version") {
      const request = input.request;
      const version = session.listVersionSnapshots().find((entry) => entry.id === request.version_id);
      if (!version) {
        return collaborationFailure(
          action,
          "not_found",
          `Version ${request.version_id} does not exist in this collaboration room.`,
          "Call list-versions and retry with an exact returned version ID.",
          session,
        );
      }
      if (!session.restoreVersionSnapshot(request.version_id)) {
        return collaborationFailure(
          action,
          "operation_rejected",
          `Unable to restore version ${request.version_id}.`,
          "Observe the room and retry.",
          session,
        );
      }
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-version-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: collaborationFingerprint(session),
            version: versionMetadata(version),
            version_id: version.id,
            idempotency: { key: idempotencyKey, replayed: false },
          },
        },
      });
    }

    if (input.request.action === "delete-version") {
      const request = input.request;
      const version = session.listVersionSnapshots().find((entry) => entry.id === request.version_id);
      if (!version) {
        return creativeWorkspaceCollaborationToolResultSchema.parse({
          op: "collaboration",
          result: {
            success: true,
            action,
            receipt: {
              contract: "director-collaboration-version-v1",
              receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
              before_fingerprint: fingerprint,
              after_fingerprint: fingerprint,
              version: null,
              version_id: request.version_id,
              idempotency: { key: idempotencyKey, replayed: true },
            },
          },
        });
      }
      if (!session.deleteVersionSnapshot(request.version_id)) {
        return collaborationFailure(
          action,
          "operation_rejected",
          `Unable to delete version ${request.version_id}.`,
          "Observe the room and retry.",
          session,
        );
      }
      return creativeWorkspaceCollaborationToolResultSchema.parse({
        op: "collaboration",
        result: {
          success: true,
          action,
          receipt: {
            contract: "director-collaboration-version-v1",
            receipt_id: `collaboration-receipt:v1:${crypto.randomUUID()}`,
            before_fingerprint: fingerprint,
            after_fingerprint: collaborationFingerprint(session),
            version: versionMetadata(version),
            version_id: version.id,
            idempotency: { key: idempotencyKey, replayed: false },
          },
        },
      });
    }

    return collaborationFailure(
      action,
      "operation_rejected",
      `Unsupported collaboration action: ${action}`,
      "Use capabilities to discover supported collaboration actions.",
      session,
    );
  } catch (error) {
    return collaborationFailure(
      action,
      "operation_rejected",
      error instanceof Error ? error.message : String(error),
      "Inspect the current collaboration room and retry.",
      session,
    );
  }
}

function canvasPipelineFailure(
  action: string,
  code: "not_found" | "stale_guard" | "conflict" | "unavailable" | "operation_rejected" | "aborted",
  error: string,
  suggestedNext: string,
): CreativeWorkspacePipelineToolResult {
  return creativeWorkspacePipelineToolResultSchema.parse({
    op: "pipeline",
    result: { success: false, action, code, error, suggested_next: suggestedNext },
  });
}

function canvasPipelineRun(context: CreativeWorkspaceSemanticContext, runId?: string) {
  const runs = context.getCreativeState().boardPipelineRuns;
  return runId ? (runs.find((run) => run.id === runId) ?? null) : (runs.at(-1) ?? null);
}

export async function executeCreativeWorkspacePipelineRequest(
  input: CreativeWorkspacePipelineRequest,
  context: CreativeWorkspaceSemanticContext = defaultSemanticContext,
  signal?: AbortSignal,
): Promise<CreativeWorkspacePipelineToolResult> {
  const request = input.request;
  if (request.action === "capabilities") {
    return creativeWorkspacePipelineToolResultSchema.parse({
      op: "pipeline",
      result: {
        success: true,
        action: "capabilities",
        contract: "director-canvas-pipeline-agent-v1",
        actions: ["capabilities", "start", "status", "cancel"],
        execution: "topological-levels-with-bounded-parallelism",
        reference_binding: "direct-upstream-persistent-images",
      },
    });
  }
  if (request.action === "status") {
    const run = canvasPipelineRun(context, request.run_id);
    return run
      ? creativeWorkspacePipelineToolResultSchema.parse({
          op: "pipeline",
          result: { success: true, action: "status", run: projectCreativeWorkspacePipelineRun(run) },
        })
      : canvasPipelineFailure(
          request.action,
          "not_found",
          request.run_id ? `Canvas pipeline run "${request.run_id}" does not exist.` : "No Canvas pipeline run exists.",
          "Start a pipeline run or observe board.pipeline_runs, then request status with an exact run_id.",
        );
  }
  if (request.action === "cancel") {
    const run = canvasPipelineRun(context, request.run_id);
    if (!run) {
      return canvasPipelineFailure(
        request.action,
        "not_found",
        `Canvas pipeline run "${request.run_id}" does not exist.`,
        "Observe board.pipeline_runs and retry with an exact run_id.",
      );
    }
    if (run.status !== "running") {
      return creativeWorkspacePipelineToolResultSchema.parse({
        op: "pipeline",
        result: { success: true, action: "cancel", run: projectCreativeWorkspacePipelineRun(run) },
      });
    }
    const active = getActiveDirectorCanvasPipelineHandle();
    if (!active || active.runId !== run.id) {
      return canvasPipelineFailure(
        request.action,
        "unavailable",
        `Canvas pipeline run "${run.id}" is recorded as running, but this browser no longer owns its active controller.`,
        "Inspect the durable provider job IDs in the run and reconcile or cancel them from the generation job surface.",
      );
    }
    active.cancel();
    try {
      const cancelled = await active.promise;
      return creativeWorkspacePipelineToolResultSchema.parse({
        op: "pipeline",
        result: { success: true, action: "cancel", run: projectCreativeWorkspacePipelineRun(cancelled) },
      });
    } catch (error) {
      return canvasPipelineFailure(
        request.action,
        "operation_rejected",
        error instanceof Error ? error.message : String(error),
        "Inspect board.pipeline_runs and generation job status before retrying cancellation.",
      );
    }
  }

  if (signal?.aborted) {
    return canvasPipelineFailure(
      request.action,
      "aborted",
      "Canvas pipeline start was cancelled before submission.",
      "Retry the pipeline start when ready.",
    );
  }
  const currentFingerprint = context.getCreativeSnapshotFingerprint();
  if (!request.expected_snapshot_fingerprint) {
    return canvasPipelineFailure(
      request.action,
      "stale_guard",
      "Canvas pipeline start requires expected_snapshot_fingerprint at the browser execution boundary.",
      "Use the public Agent boundary so it can observe and inject the current Canvas guard.",
    );
  }
  if (!request.idempotency_key) {
    return canvasPipelineFailure(
      request.action,
      "conflict",
      "Canvas pipeline start requires idempotency_key at the browser execution boundary.",
      "Use the public Agent boundary so it can assign a stable retry key.",
    );
  }
  const runId = requestKeyId("canvas-run-agent", request.idempotency_key);
  const priorRun = canvasPipelineRun(context, runId);
  if (priorRun) {
    const sameIntent =
      priorRun.agentRequest?.idempotencyKey === request.idempotency_key &&
      stableLexicalJson(priorRun.agentRequest.targetNodeIds) === stableLexicalJson(request.target_node_ids) &&
      stableLexicalJson(priorRun.agentRequest.forceNodeIds) === stableLexicalJson(request.force_node_ids) &&
      priorRun.agentRequest.maxParallel === request.max_parallel;
    if (!sameIntent) {
      return canvasPipelineFailure(
        request.action,
        "conflict",
        `Request key "${request.idempotency_key}" was already used for a different Canvas pipeline intent.`,
        "Use a new request key for changed targets, force nodes, or parallelism.",
      );
    }
    return creativeWorkspacePipelineToolResultSchema.parse({
      op: "pipeline",
      result: {
        success: true,
        action: "start",
        run: projectCreativeWorkspacePipelineRun(priorRun),
        idempotency: { key: request.idempotency_key, replayed: true },
      },
    });
  }
  if (request.expected_snapshot_fingerprint !== currentFingerprint) {
    return canvasPipelineFailure(
      request.action,
      "stale_guard",
      `Creative workspace changed since observe (expected ${request.expected_snapshot_fingerprint}, current ${currentFingerprint}).`,
      "Observe again and retry with the current Canvas state.",
    );
  }
  const knownNodeIds = new Set(context.getCreativeState().boardNodes.map((node) => node.id));
  const unknownNodeIds = [...request.target_node_ids, ...request.force_node_ids].filter(
    (nodeId) => !knownNodeIds.has(nodeId),
  );
  if (unknownNodeIds.length) {
    return canvasPipelineFailure(
      request.action,
      "not_found",
      `Canvas pipeline references unknown node IDs: ${[...new Set(unknownNodeIds)].join(", ")}.`,
      "Observe board.nodes and retry with exact node IDs.",
    );
  }
  const active = getActiveDirectorCanvasPipelineHandle();
  if (active) {
    return canvasPipelineFailure(
      request.action,
      "conflict",
      `Canvas pipeline run "${active.runId}" is already active in this browser.`,
      "Request pipeline status or cancel the active run before starting another.",
    );
  }
  const handle = startDirectorCanvasPipeline({
    runId,
    targetNodeIds: request.target_node_ids,
    forceNodeIds: request.force_node_ids,
    maxParallel: request.max_parallel,
    agentRequest: {
      idempotencyKey: request.idempotency_key,
      targetNodeIds: request.target_node_ids,
      forceNodeIds: request.force_node_ids,
      maxParallel: request.max_parallel,
    },
  });
  signal?.addEventListener("abort", handle.cancel, { once: true });
  try {
    const run = request.await_completion ? await handle.promise : canvasPipelineRun(context, runId);
    if (!run) {
      await handle.promise;
      const failedRun = canvasPipelineRun(context, runId);
      if (!failedRun) throw new Error("Canvas pipeline did not create a durable run receipt");
      return creativeWorkspacePipelineToolResultSchema.parse({
        op: "pipeline",
        result: {
          success: true,
          action: "start",
          run: projectCreativeWorkspacePipelineRun(failedRun),
          idempotency: { key: request.idempotency_key, replayed: false },
        },
      });
    }
    return creativeWorkspacePipelineToolResultSchema.parse({
      op: "pipeline",
      result: {
        success: true,
        action: "start",
        run: projectCreativeWorkspacePipelineRun(run),
        idempotency: { key: request.idempotency_key, replayed: false },
      },
    });
  } catch (error) {
    return canvasPipelineFailure(
      request.action,
      signal?.aborted ? "aborted" : "operation_rejected",
      error instanceof Error ? error.message : String(error),
      "Inspect the Canvas DAG and generation runtime, then retry the failed start.",
    );
  } finally {
    signal?.removeEventListener("abort", handle.cancel);
  }
}

export async function executeCreativeWorkspaceSemanticRequest(
  input: CreativeWorkspaceInterchangeRequest | CreativeWorkspaceCollaborationRequest | CreativeWorkspacePipelineRequest,
  context: CreativeWorkspaceSemanticContext = defaultSemanticContext,
  signal?: AbortSignal,
) {
  return input.op === "interchange"
    ? executeCreativeWorkspaceInterchangeRequest(input, context, signal)
    : input.op === "collaboration"
      ? executeCreativeWorkspaceCollaborationRequest(input, context, signal)
      : executeCreativeWorkspacePipelineRequest(input, context, signal);
}
