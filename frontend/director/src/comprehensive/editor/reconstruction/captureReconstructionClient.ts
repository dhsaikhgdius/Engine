import { z } from "zod";
import {
  captureReconstructionJobInputSchema,
  captureReconstructionPlanResponseSchema,
  type CaptureReconstructionJobInput,
  type CaptureReconstructionPlan,
  type CaptureSourceKind,
} from "../../../../../../packages/protocol/src/captureReconstructionProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";

/** Error thrown by the capture reconstruction HTTP client when a request fails. */
export class CaptureReconstructionClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CaptureReconstructionClientError";
  }
}

const jobResponseSchema = z.looseObject({ job: productionJobRecordSchema });
const jobsResponseSchema = z.looseObject({ jobs: z.array(productionJobRecordSchema) });

async function readJson(response: Response) {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new CaptureReconstructionClientError(
      typeof body.message === "string" ? body.message : "采集重建请求失败",
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return body;
}

/** Detects the capture kind from the file: zip bundles are RGB-D scans. */
export function detectCaptureSourceKind(file: Pick<File, "name" | "type">): CaptureSourceKind {
  if (/\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
    return "rgbd-bundle";
  }
  return "rgb-video";
}

/**
 * Stages capture bytes into the content-addressed media-input store shared
 * with media.transcode. Re-uploading identical bytes is idempotent.
 */
export async function stageCaptureSource(file: File, signal?: AbortSignal) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const contentType = file.type.startsWith("video/") ? file.type : "application/octet-stream";
  const response = await directorControlPlaneFetch(`/api/production-jobs/media-inputs?sha256=${sha256}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bytes,
    signal,
  });
  const body = await readJson(response);
  const parsed = z
    .looseObject({
      input: z.looseObject({ sourceMediaId: z.string().min(1), sha256: z.string(), bytes: z.number() }),
    })
    .parse(body);
  return { sourceMediaId: parsed.input.sourceMediaId, sha256: parsed.input.sha256, bytes: parsed.input.bytes };
}

/**
 * Submits a capture reconstruction job to the gateway.
 *
 * @param input - The validated job input (source media, analysis options).
 * @param idempotencyKey - Client-generated key that prevents duplicate submissions.
 * @param signal - Optional abort signal for cancellation.
 * @returns The created production job record.
 */
export async function submitCaptureReconstruction(
  input: CaptureReconstructionJobInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ProductionJobRecord> {
  const response = await directorControlPlaneFetch("/api/reconstruction/capture/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: captureReconstructionJobInputSchema.parse(input), idempotencyKey }),
    signal,
  });
  return jobResponseSchema.parse(await readJson(response)).job;
}

/**
 * Fetches a single capture reconstruction job by its id.
 *
 * @param jobId - The production job id.
 * @param signal - Optional abort signal for cancellation.
 * @returns The current state of the production job record.
 */
export async function getCaptureReconstructionJob(jobId: string, signal?: AbortSignal): Promise<ProductionJobRecord> {
  const response = await directorControlPlaneFetch(`/api/reconstruction/capture/jobs/${encodeURIComponent(jobId)}`, {
    signal,
  });
  return jobResponseSchema.parse(await readJson(response)).job;
}

/**
 * Lists all capture reconstruction jobs for the current project.
 *
 * @param signal - Optional abort signal for cancellation.
 * @returns An array of production job records, most recent first.
 */
export async function listCaptureReconstructionJobs(signal?: AbortSignal): Promise<ProductionJobRecord[]> {
  const response = await directorControlPlaneFetch("/api/reconstruction/capture/jobs", { signal });
  return jobsResponseSchema.parse(await readJson(response)).jobs;
}

/**
 * Fetches the reconstruction plan produced by a completed capture job.
 *
 * @param jobId - The production job id.
 * @param signal - Optional abort signal for cancellation.
 * @returns The parsed capture reconstruction plan.
 */
export async function fetchCaptureReconstructionPlan(
  jobId: string,
  signal?: AbortSignal,
): Promise<CaptureReconstructionPlan> {
  const response = await directorControlPlaneFetch(
    `/api/reconstruction/capture/jobs/${encodeURIComponent(jobId)}/plan`,
    { signal },
  );
  return captureReconstructionPlanResponseSchema.parse(await readJson(response)).plan;
}

/** Fetches one production-job artifact (keyframe, shell mesh, report) as a Blob. */
export async function fetchCaptureArtifactBlob(jobId: string, artifactId: string, signal?: AbortSignal) {
  const response = await directorControlPlaneFetch(
    `/api/production-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { signal },
  );
  if (!response.ok) {
    throw new CaptureReconstructionClientError(`重建工件 ${artifactId} 不可用`, response.status);
  }
  return response.blob();
}
