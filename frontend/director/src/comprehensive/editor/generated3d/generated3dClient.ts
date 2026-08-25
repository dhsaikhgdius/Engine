import {
  generated3dPromotionSchema,
  generated3dProviderCapabilitySchema,
  generated3dProviderIdSchema,
  generated3dSubmitRequestSchema,
  type Generated3DSubmitRequest,
} from "../../../../../../packages/protocol/src/generated3dProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { directorControlPlaneFetch, directorControlPlaneUrl } from "../api/directorControlPlaneClient";

/** A production job record of kind "model.generate", representing a 3D asset generation task. */
export type Generated3DJob = Extract<ProductionJobRecord, { kind: "model.generate" }>;

function asGenerated3DJob(value: unknown) {
  const job = productionJobRecordSchema.parse(value);
  if (job.kind !== "model.generate") throw new Error(`Expected a model.generate job, received ${job.kind}`);
  return job as Generated3DJob;
}

async function jsonResponse(response: Response) {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : null;
    throw new Error(message ?? `Generated 3D request failed (${response.status})`);
  }
  return body;
}

/**
 * Lists available 3D generation providers and their capabilities.
 *
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the default provider ID and the list of provider capabilities.
 */
export async function listGenerated3DProviders(signal?: AbortSignal) {
  const body = await jsonResponse(await directorControlPlaneFetch("/api/generation/3d/providers", { signal }));
  return {
    defaultProvider: generated3dProviderIdSchema.parse(body.defaultProvider),
    providers: generated3dProviderCapabilitySchema.array().parse(body.providers),
  };
}

/**
 * Lists recent 3D generation jobs, filtered to model.generate jobs only.
 *
 * @param limit - Maximum number of jobs to return (clamped to 1–200, default 50).
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to an array of generated 3D job records.
 */
export async function listGenerated3DJobs(limit = 50, signal?: AbortSignal) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/generation/3d/jobs?limit=${Math.max(1, Math.min(200, limit))}`, { signal }),
  );
  return productionJobRecordSchema
    .array()
    .parse(body.jobs)
    .filter((job): job is Generated3DJob => job.kind === "model.generate");
}

/**
 * Fetches a single 3D generation job by its identifier.
 *
 * @param jobId - The unique identifier of the job to inspect.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the generated 3D job record.
 */
export async function inspectGenerated3DJob(jobId: string, signal?: AbortSignal) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/generation/3d/jobs/${encodeURIComponent(jobId)}`, { signal }),
  );
  return asGenerated3DJob(body.job);
}

/**
 * Submits a new 3D generation job with the given request parameters.
 *
 * @param request - The validated submission request including provider, model, and prompt.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the newly created generated 3D job record.
 */
export async function submitGenerated3DJob(request: Generated3DSubmitRequest, signal?: AbortSignal) {
  const body = await jsonResponse(
    await directorControlPlaneFetch("/api/generation/3d/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(generated3dSubmitRequestSchema.parse(request)),
      signal,
    }),
  );
  return asGenerated3DJob(body.job);
}

async function generated3DJobAction(
  jobId: string,
  action: "cancel" | "retry" | "reconcile",
  idempotencyKey?: string,
  signal?: AbortSignal,
) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/generation/3d/jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: "POST",
      headers: action === "retry" ? { "content-type": "application/json" } : undefined,
      body: action === "retry" ? JSON.stringify({ idempotencyKey }) : undefined,
      signal,
    }),
  );
  return asGenerated3DJob(body.job);
}

/**
 * Cancels a pending or in-progress 3D generation job.
 *
 * @param jobId - The unique identifier of the job to cancel.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the updated job record.
 */
export const cancelGenerated3DJob = (jobId: string, signal?: AbortSignal) =>
  generated3DJobAction(jobId, "cancel", undefined, signal);

/**
 * Retries a failed or cancelled 3D generation job.
 *
 * @param jobId - The unique identifier of the job to retry.
 * @param idempotencyKeyOrSignal - An optional idempotency key to prevent duplicate retries, or an abort signal.
 * @param signal - Optional abort signal (only when the second argument is an idempotency key).
 * @returns A promise resolving to the updated job record.
 */
export const retryGenerated3DJob = (
  jobId: string,
  idempotencyKeyOrSignal?: string | AbortSignal,
  signal?: AbortSignal,
) =>
  generated3DJobAction(
    jobId,
    "retry",
    typeof idempotencyKeyOrSignal === "string" ? idempotencyKeyOrSignal : undefined,
    typeof idempotencyKeyOrSignal === "string" ? signal : idempotencyKeyOrSignal,
  );

/**
 * Reconciles a 3D generation job that may be in an inconsistent state.
 *
 * @param jobId - The unique identifier of the job to reconcile.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the updated job record.
 */
export const reconcileGenerated3DJob = (jobId: string, signal?: AbortSignal) =>
  generated3DJobAction(jobId, "reconcile", undefined, signal);

/**
 * Requests a promotion receipt for a completed 3D generation job.
 *
 * A promotion receipt contains signed artifact paths and metadata needed
 * to import the generated assets into the production.
 *
 * @param jobId - The unique identifier of the completed job to promote.
 * @param signal - Optional abort signal to cancel the request.
 * @returns A promise resolving to the generated 3D promotion receipt.
 */
export async function requestGenerated3DPromotion(jobId: string, signal?: AbortSignal) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/generation/3d/jobs/${encodeURIComponent(jobId)}/promote`, {
      method: "POST",
      signal,
    }),
  );
  return generated3dPromotionSchema.parse(body.promotion);
}

/**
 * Downloads a public artifact blob from the generated 3D artifact store.
 *
 * @param path - The public URL path of the artifact to download.
 * @param signal - Optional abort signal to cancel the download.
 * @returns A promise resolving to the artifact blob.
 */
export async function fetchGenerated3DPublicArtifact(path: string, signal?: AbortSignal) {
  const response = await directorControlPlaneFetch(path, { signal });
  if (!response.ok) throw new Error(`Generated 3D artifact download failed (${response.status})`);
  return response.blob();
}

/**
 * Resolves a relative artifact path to its full public URL.
 *
 * @param path - The relative artifact path.
 * @returns The fully qualified public URL for the artifact.
 */
export function generated3DPublicUrl(path: string) {
  return directorControlPlaneUrl(path);
}
