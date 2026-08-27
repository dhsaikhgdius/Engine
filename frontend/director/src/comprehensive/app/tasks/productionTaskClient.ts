import {
  isTerminalProductionJobStatus,
  productionJobRecordSchema,
  type ProductionJobKind,
  type ProductionJobRecord,
  type ProductionJobStatus,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import {
  productionJobReceiptSchema,
  type ProductionJobReceipt,
} from "../../../../../../packages/protocol/src/productionJobReceipt";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";
import { cancelGenerated3DJob, retryGenerated3DJob } from "../../editor/generated3d/generated3dClient";
import { cancelMediaTranscriptionJob, retryMediaTranscriptionJob } from "../../editor/media/mediaTranscriptionBridge";
import { cancelComfyGenerationJob, retryComfyGenerationJob } from "../../editor/workspaces/galleryGenerationBridge";

/**
 * ComfyUI generation, generated-3D, and transcription each expose their own
 * cancel/retry routes; the remaining kinds (canvas.*, media.transcode/proxy,
 * dcc.*) have no gateway action endpoints, so the tray keeps them read-only.
 */
const COMFY_GENERATION_KINDS: ReadonlySet<ProductionJobKind> = new Set([
  "image.generate",
  "video.generate",
  "audio.generate",
]);

const CANCELLABLE_KINDS: ReadonlySet<ProductionJobKind> = new Set([
  ...COMFY_GENERATION_KINDS,
  "model.generate",
  "media.transcribe",
]);

const RETRYABLE_KINDS = CANCELLABLE_KINDS;

/**
 * Fetches the production job list from the gateway.
 *
 * @param limit - Maximum number of jobs to fetch (clamped to 1–200).
 * @param signal - Optional AbortSignal for request cancellation.
 * @returns An array of production job records.
 */
export async function listProductionTasks(limit = 100, signal?: AbortSignal): Promise<ProductionJobRecord[]> {
  const response = await directorControlPlaneFetch(`/api/production-jobs?limit=${Math.max(1, Math.min(200, limit))}`, {
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as { message?: unknown; jobs?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : `任务列表请求失败（HTTP ${response.status}）`);
  }
  return productionJobRecordSchema.array().parse(body.jobs ?? []);
}

/**
 * Returns whether a job supports cancellation in its current state.
 *
 * @param job - The production job record.
 */
export function taskSupportsCancel(job: ProductionJobRecord): boolean {
  return CANCELLABLE_KINDS.has(job.kind) && (job.status === "queued" || job.status === "running");
}

/**
 * Returns whether a job supports retry in its current state.
 * Failed and cancelled jobs are retryable; transcription jobs also accept
 * outcome_unknown.
 *
 * @param job - The production job record.
 */
export function taskSupportsRetry(job: ProductionJobRecord): boolean {
  if (!RETRYABLE_KINDS.has(job.kind)) return false;
  if (job.status === "failed" || job.status === "cancelled") return true;
  // The transcription route additionally accepts interrupted attempts.
  return job.kind === "media.transcribe" && job.status === "outcome_unknown";
}

/**
 * Returns whether a job has reached a terminal status.
 *
 * @param job - The production job record.
 */
export function taskIsFinished(job: ProductionJobRecord): boolean {
  return isTerminalProductionJobStatus(job.status);
}

/** Statuses whose normalized receipts may carry live artifact byte presence. */
const RECEIPT_PROBE_STATUSES: ReadonlySet<ProductionJobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

/**
 * Returns whether the tray should probe `GET /api/production-jobs/:id/receipt`
 * for live artifact `storagePresence`.
 *
 * @param job - The production job record.
 */
export function taskNeedsReceiptProbe(job: ProductionJobRecord): boolean {
  return RECEIPT_PROBE_STATUSES.has(job.status);
}

/**
 * Fetches the normalized live receipt for one production job.
 *
 * @param jobId - The durable job id.
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function fetchProductionJobReceipt(jobId: string, signal?: AbortSignal): Promise<ProductionJobReceipt> {
  const response = await directorControlPlaneFetch(`/api/production-jobs/${encodeURIComponent(jobId)}/receipt`, {
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as { message?: unknown; receipt?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : `任务回执请求失败（HTTP ${response.status}）`);
  }
  return productionJobReceiptSchema.parse(body.receipt);
}

/**
 * Cancels a production job, dispatching to the correct cancel endpoint
 * based on the job's kind.
 *
 * @param job - The production job record.
 * @param signal - Optional AbortSignal for request cancellation.
 * @returns The updated job record after cancellation.
 * @throws When the job kind does not support cancellation.
 */
export async function cancelProductionTask(job: ProductionJobRecord, signal?: AbortSignal) {
  if (COMFY_GENERATION_KINDS.has(job.kind)) return cancelComfyGenerationJob(job.id, signal);
  if (job.kind === "model.generate") return cancelGenerated3DJob(job.id, signal);
  if (job.kind === "media.transcribe") return cancelMediaTranscriptionJob(job.id, signal);
  throw new Error("该任务类型不支持取消");
}

/**
 * Retries a production job, dispatching to the correct retry endpoint
 * based on the job's kind.
 *
 * @param job - The production job record.
 * @param signal - Optional AbortSignal for request cancellation.
 * @returns The updated job record after retry.
 * @throws When the job kind does not support retry.
 */
export async function retryProductionTask(job: ProductionJobRecord, signal?: AbortSignal) {
  if (COMFY_GENERATION_KINDS.has(job.kind)) return retryComfyGenerationJob(job.id, signal);
  if (job.kind === "model.generate") return retryGenerated3DJob(job.id, signal);
  if (job.kind === "media.transcribe") return retryMediaTranscriptionJob(job.id, undefined, signal);
  throw new Error("该任务类型不支持重试");
}
