import {
  comfyNodeDefinitionSchema,
  comfyNodeSnapshotSchema,
  comfyUploadedInputImageSchema,
  comfyWorkflowInspectionSchema,
  comfyWorkflowRecordSchema,
  type ComfyGenerationSubmitRequest,
  type ComfyMediaKind,
  type ComfyNodeDefinition,
} from "../../../../../../packages/protocol/src/comfyGenerationProtocol";
import { productionJobRecordSchema } from "../../../../../../packages/protocol/src/productionJobProtocol";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";
import { friendlyErrorMessage, friendlyHttpStatusMessage } from "../api/friendlyError";

/** Wraps the control-plane fetch so network-level failures surface as user-facing copy. */
async function bridgeFetch(...args: Parameters<typeof directorControlPlaneFetch>) {
  try {
    return await directorControlPlaneFetch(...args);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(friendlyErrorMessage(error), { cause: error });
  }
}

async function jsonResponse(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown } & Record<string, unknown>;
  if (!response.ok)
    throw new Error(typeof body.message === "string" ? body.message : friendlyHttpStatusMessage(response.status));
  return body;
}

/**
 * List all registered ComfyUI generation nodes.
 *
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns Array of node snapshots validated against the node schema.
 */
export async function listComfyGenerationNodes(signal?: AbortSignal) {
  const body = await jsonResponse(await bridgeFetch("/api/generation/nodes", { signal }));
  return comfyNodeSnapshotSchema.array().parse(body.nodes);
}

/**
 * Create or update a ComfyUI generation node definition.
 *
 * @param node - The node definition to save.
 * @returns The saved node definition validated against the schema.
 */
export async function saveComfyGenerationNode(node: ComfyNodeDefinition) {
  const body = await jsonResponse(
    await bridgeFetch("/api/generation/nodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(node),
    }),
  );
  return comfyNodeDefinitionSchema.parse(body.node);
}

/**
 * Remove a registered ComfyUI generation node.
 *
 * @param nodeId - ID of the node to remove.
 * @returns True if the node was successfully removed.
 */
export async function removeComfyGenerationNode(nodeId: string) {
  const body = await jsonResponse(
    await bridgeFetch(`/api/generation/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" }),
  );
  return body.removed === true;
}

/**
 * Send a lifecycle action to a ComfyUI generation node.
 *
 * @param nodeId - ID of the target node.
 * @param action - The action to perform: interrupt, free, or restart.
 * @returns The updated node snapshot after the action.
 */
export async function runComfyNodeAction(nodeId: string, action: "interrupt" | "free" | "restart") {
  const body = await jsonResponse(
    await bridgeFetch(`/api/generation/nodes/${encodeURIComponent(nodeId)}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  );
  return comfyNodeSnapshotSchema.parse(body.node);
}

/**
 * List all imported ComfyUI generation workflows.
 *
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns Array of workflow records validated against the workflow schema.
 */
export async function listComfyGenerationWorkflows(signal?: AbortSignal) {
  const body = await jsonResponse(await bridgeFetch("/api/generation/workflows", { signal }));
  return comfyWorkflowRecordSchema.array().parse(body.workflows);
}

/**
 * Inspect a ComfyUI workflow to extract its parameter and output metadata.
 *
 * @param workflow - The raw workflow object to inspect.
 * @param mediaKind - The media kind the workflow is expected to produce.
 * @returns A structured inspection result with parameter definitions.
 */
export async function inspectComfyGenerationWorkflow(workflow: unknown, mediaKind: ComfyMediaKind) {
  const body = await jsonResponse(
    await bridgeFetch("/api/generation/workflows/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow, mediaKind }),
    }),
  );
  return comfyWorkflowInspectionSchema.parse(body.inspection);
}

/**
 * Import a ComfyUI workflow into the generation library.
 *
 * @param input - Workflow metadata including name, description, category, media kind, and raw workflow.
 * @returns The imported workflow record validated against the schema.
 */
export async function importComfyGenerationWorkflow(input: {
  name: string;
  description?: string;
  category?: string;
  mediaKind: ComfyMediaKind;
  workflow: unknown;
}) {
  const body = await jsonResponse(
    await bridgeFetch("/api/generation/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return comfyWorkflowRecordSchema.parse(body.workflow);
}

/**
 * Remove an imported ComfyUI generation workflow.
 *
 * @param workflowId - ID of the workflow to remove.
 * @returns True if the workflow was successfully removed.
 */
export async function removeComfyGenerationWorkflow(workflowId: string) {
  const body = await jsonResponse(
    await bridgeFetch(`/api/generation/workflows/${encodeURIComponent(workflowId)}`, {
      method: "DELETE",
    }),
  );
  return body.removed === true;
}

/**
 * List recent ComfyUI generation jobs.
 *
 * @param limit - Maximum number of jobs to return, clamped to 1–200. Defaults to 50.
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns Array of production job records validated against the schema.
 */
export async function listComfyGenerationJobs(limit = 50, signal?: AbortSignal) {
  const body = await jsonResponse(
    await bridgeFetch(`/api/generation/jobs?limit=${Math.max(1, Math.min(200, limit))}`, { signal }),
  );
  return productionJobRecordSchema.array().parse(body.jobs);
}

/**
 * Inspect a single ComfyUI generation job by ID.
 *
 * @param jobId - ID of the job to inspect.
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns The production job record validated against the schema.
 */
export async function inspectComfyGenerationJob(jobId: string, signal?: AbortSignal) {
  const body = await jsonResponse(
    await bridgeFetch(`/api/generation/jobs/${encodeURIComponent(jobId)}`, { signal }),
  );
  return productionJobRecordSchema.parse(body.job);
}

/**
 * Submit a new ComfyUI generation job.
 *
 * @param request - The generation submit request including workflow, parameters, and node target.
 * @param signal - Optional AbortSignal to cancel the submission.
 * @returns An object with the group ID and the array of created job records.
 */
export async function submitComfyGeneration(request: ComfyGenerationSubmitRequest, signal?: AbortSignal) {
  const body = await jsonResponse(
    await bridgeFetch("/api/generation/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    }),
  );
  return {
    groupId: String(body.groupId),
    jobs: productionJobRecordSchema.array().parse(body.jobs),
  };
}

async function sha256Hex(blob: Blob) {
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持参考图所需的 SHA-256 校验");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Upload an input image to a ComfyUI generation node for use as a reference
 * or control input.
 *
 * Computes a SHA-256 hash of the blob for server-side deduplication.
 * Only image MIME types are accepted.
 *
 * @param input - The node ID, source media ID, file metadata, image blob, and optional signal.
 * @returns The uploaded input image metadata validated against the schema.
 */
export async function uploadComfyGenerationInputImage(input: {
  nodeId: string;
  sourceMediaId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  signal?: AbortSignal;
}) {
  if (!input.mimeType.startsWith("image/") && !input.blob.type.startsWith("image/")) {
    throw new Error("参考素材必须是图片");
  }
  const sourceSha256 = await sha256Hex(input.blob);
  input.signal?.throwIfAborted();
  const query = new URLSearchParams({
    source_media_id: input.sourceMediaId,
    source_sha256: sourceSha256,
    file_name: input.fileName,
  });
  return comfyUploadedInputImageSchema.parse(
    await jsonResponse(
      await bridgeFetch(
        `/api/generation/nodes/${encodeURIComponent(input.nodeId)}/input-images?${query}`,
        {
          method: "POST",
          headers: { "content-type": input.blob.type || input.mimeType },
          body: input.blob,
          signal: input.signal,
        },
      ),
    ),
  );
}

async function generationJobAction(
  jobId: string,
  action: "cancel" | "retry" | "reconcile",
  idempotencyKey?: string,
  signal?: AbortSignal,
) {
  const body = await jsonResponse(
    await bridgeFetch(`/api/generation/jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: "POST",
      headers: action === "retry" ? { "content-type": "application/json" } : undefined,
      body: action === "retry" ? JSON.stringify({ idempotencyKey }) : undefined,
      signal,
    }),
  );
  return productionJobRecordSchema.parse(body.job);
}

/**
 * Cancel a running ComfyUI generation job.
 *
 * @param jobId - ID of the job to cancel.
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns The updated job record after cancellation.
 */
export const cancelComfyGenerationJob = (jobId: string, signal?: AbortSignal) =>
  generationJobAction(jobId, "cancel", undefined, signal);

/**
 * Retry a failed or completed ComfyUI generation job.
 *
 * @param jobId - ID of the job to retry.
 * @param idempotencyKeyOrSignal - Optional idempotency key to prevent duplicate retries, or an AbortSignal.
 * @param signal - Optional AbortSignal when the first argument is an idempotency key.
 * @returns The new or updated job record.
 */
export const retryComfyGenerationJob = (
  jobId: string,
  idempotencyKeyOrSignal?: string | AbortSignal,
  signal?: AbortSignal,
) =>
  generationJobAction(
    jobId,
    "retry",
    typeof idempotencyKeyOrSignal === "string" ? idempotencyKeyOrSignal : undefined,
    typeof idempotencyKeyOrSignal === "string" ? signal : idempotencyKeyOrSignal,
  );

/**
 * Reconcile a ComfyUI generation job whose backend state is uncertain.
 *
 * @param jobId - ID of the job to reconcile.
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns The reconciled job record.
 */
export const reconcileComfyGenerationJob = (jobId: string, signal?: AbortSignal) =>
  generationJobAction(jobId, "reconcile", undefined, signal);

/**
 * Download a generation artifact blob from a completed job.
 *
 * @param jobId - ID of the production job.
 * @param artifactId - ID of the artifact to download.
 * @param signal - Optional AbortSignal to cancel the download.
 * @returns The artifact as a Blob.
 */
export async function fetchGenerationArtifact(jobId: string, artifactId: string, signal?: AbortSignal) {
  const response = await bridgeFetch(
    `/api/production-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { signal },
  );
  if (!response.ok) throw new Error(`成品下载失败：${friendlyHttpStatusMessage(response.status)}`);
  return response.blob();
}