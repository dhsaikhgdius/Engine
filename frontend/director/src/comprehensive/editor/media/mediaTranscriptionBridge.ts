/**
 * Typed HTTP bridge to the gateway's media transcription domain: probes
 * capabilities, submits transcription jobs for library media, polls job
 * records, and fetches finished transcripts. Responses are validated against
 * the shared transcription protocol schemas, and the same job records power
 * the task tray — so UI and agent-side `job_*` tooling observe one job model.
 */
import {
  directorMediaTranscriptSchema,
  mediaTranscriptionCapabilitiesSchema,
  type DirectorMediaTranscript,
} from "../../../../../../packages/protocol/src/mediaTranscriptionProtocol";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";
import type { CreativeMediaAsset } from "./persistentCreativeMediaStore";

/** A production job whose kind is "media.transcribe". */
export type MediaTranscriptionJob = Extract<ProductionJobRecord, { kind: "media.transcribe" }>;

/**
 * A non-ok transcription gateway response, preserving the gateway's stable
 * structured error code (for example `transcription_not_configured` or
 * `transcription_job_not_found`) and the HTTP status alongside the message,
 * so Agent surfaces can report the exact contract state instead of a blanket
 * "transcription failed".
 */
export class MediaTranscriptionRequestError extends Error {
  constructor(
    message: string,
    /** The gateway's structured error code, when the response carried one. */
    readonly code: string | null,
    /** The HTTP status of the failed response. */
    readonly status: number,
  ) {
    super(message);
    this.name = "MediaTranscriptionRequestError";
  }
}

/**
 * Parses a fetch response as JSON and throws on non-ok status.
 *
 * @param response - The fetch Response to parse.
 * @returns The parsed JSON body.
 * @throws {@link MediaTranscriptionRequestError} carrying the gateway's structured code.
 */
async function jsonResponse(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { message?: unknown; code?: unknown } & Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new MediaTranscriptionRequestError(
      typeof body.message === "string" ? body.message : `Transcription request failed (${response.status})`,
      typeof body.code === "string" && body.code ? body.code : null,
      response.status,
    );
  }
  return body;
}

/**
 * Parses and validates an unknown value as a media transcription job.
 *
 * @param value - The unknown value to parse.
 * @returns A validated MediaTranscriptionJob.
 * @throws If the value is not a valid transcription job.
 */
function parseJob(value: unknown): MediaTranscriptionJob {
  const job = productionJobRecordSchema.parse(value);
  if (job.kind !== "media.transcribe") throw new Error("Server returned a non-transcription job");
  return job;
}

/**
 * Computes a SHA-256 hex digest of a blob for content-addressed deduplication.
 *
 * @param blob - The media blob to hash.
 * @returns A lowercase hex SHA-256 digest string.
 */
export async function hashMediaTranscriptionSource(blob: Blob) {
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持转录所需的 SHA-256 校验");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetches the server's transcription capabilities (supported languages, models).
 *
 * @param signal - Optional AbortSignal.
 * @returns The validated capabilities object.
 */
export async function getMediaTranscriptionCapabilities(signal?: AbortSignal) {
  return mediaTranscriptionCapabilitiesSchema.parse(
    await jsonResponse(await directorControlPlaneFetch("/api/transcription/capabilities", { signal })),
  );
}

/**
 * Lists recent transcription jobs from the server.
 *
 * @param limit - Maximum number of jobs to return; clamped to [1, 200].
 * @param signal - Optional AbortSignal.
 * @returns An array of transcription jobs.
 */
export async function listMediaTranscriptionJobs(limit = 50, signal?: AbortSignal) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/transcription/jobs?limit=${Math.max(1, Math.min(200, limit))}`, { signal }),
  );
  return productionJobRecordSchema
    .array()
    .parse(body.jobs)
    .filter((job): job is MediaTranscriptionJob => job.kind === "media.transcribe");
}

/**
 * Fetches a single transcription job by its id.
 *
 * @param jobId - The job id to inspect.
 * @param signal - Optional AbortSignal.
 * @returns The validated transcription job.
 */
export async function inspectMediaTranscriptionJob(jobId: string, signal?: AbortSignal) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/transcription/jobs/${encodeURIComponent(jobId)}`, { signal }),
  );
  return parseJob(body.job);
}

/**
 * Submits a new media transcription job.
 *
 * The blob is hashed for content-addressed idempotency. The server
 * will skip duplicate processing when the idempotency key matches.
 *
 * @param input - Asset metadata, blob, and optional language/model/idempotencyKey.
 * @returns The created transcription job.
 */
export async function submitMediaTranscription(input: {
  asset: Pick<CreativeMediaAsset, "id" | "fileName" | "mimeType" | "durationSec">;
  blob: Blob;
  language?: string;
  model?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}) {
  if (input.blob.type && !input.blob.type.startsWith("audio/") && !input.blob.type.startsWith("video/")) {
    throw new Error("只有音频或视频素材可以转录");
  }
  const sha256 = await hashMediaTranscriptionSource(input.blob);
  input.signal?.throwIfAborted();
  const query = new URLSearchParams({
    source_media_id: input.asset.id,
    source_sha256: sha256,
    file_name: input.asset.fileName,
    idempotency_key: input.idempotencyKey ?? `transcription:${crypto.randomUUID()}`,
  });
  if (input.asset.durationSec) query.set("duration_seconds", String(input.asset.durationSec));
  if (input.language?.trim()) query.set("language", input.language.trim());
  if (input.model?.trim()) query.set("model", input.model.trim());
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/transcription/jobs?${query}`, {
      method: "POST",
      headers: { "content-type": input.blob.type || input.asset.mimeType },
      body: input.blob,
      signal: input.signal,
    }),
  );
  return parseJob(body.job);
}

/**
 * Sends a cancel or retry action for a transcription job.
 *
 * @param jobId - The job to act on.
 * @param action - "cancel" or "retry".
 * @param idempotencyKey - Optional idempotency key for retry deduplication.
 * @param signal - Optional AbortSignal.
 * @returns The updated transcription job.
 */
async function transcriptionAction(
  jobId: string,
  action: "cancel" | "retry",
  idempotencyKey?: string,
  signal?: AbortSignal,
) {
  const body = await jsonResponse(
    await directorControlPlaneFetch(`/api/transcription/jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: "POST",
      headers: action === "retry" ? { "content-type": "application/json" } : undefined,
      body: action === "retry" ? JSON.stringify({ idempotencyKey }) : undefined,
      signal,
    }),
  );
  return parseJob(body.job);
}

/** Cancels a transcription job by its id. */
export const cancelMediaTranscriptionJob = (jobId: string, signal?: AbortSignal) =>
  transcriptionAction(jobId, "cancel", undefined, signal);

/** Retries a failed transcription job with an optional idempotency key. */
export const retryMediaTranscriptionJob = (jobId: string, idempotencyKey?: string, signal?: AbortSignal) =>
  transcriptionAction(jobId, "retry", idempotencyKey ?? `transcription-retry:${crypto.randomUUID()}`, signal);

/**
 * Downloads a raw transcription artifact blob from the server.
 *
 * @param jobId - The job id.
 * @param artifactId - The artifact id within the job.
 * @param signal - Optional AbortSignal.
 * @returns The artifact blob.
 */
export async function fetchMediaTranscriptionArtifact(jobId: string, artifactId: string, signal?: AbortSignal) {
  const response = await directorControlPlaneFetch(
    `/api/production-jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { signal },
  );
  if (!response.ok) {
    throw new MediaTranscriptionRequestError(
      `Transcription artifact download failed (${response.status})`,
      null,
      response.status,
    );
  }
  return response.blob();
}

/**
 * Fetches, validates, and integrity-checks the full transcript from a completed job.
 *
 * @param job - The transcription job, must be in "succeeded" status.
 * @param signal - Optional AbortSignal.
 * @returns The validated transcript.
 */
export async function fetchDirectorMediaTranscript(
  job: MediaTranscriptionJob,
  signal?: AbortSignal,
): Promise<DirectorMediaTranscript> {
  if (job.status !== "succeeded") throw new Error(`Transcription job ${job.id} is ${job.status}`);
  const artifact = job.artifacts.find((candidate) => candidate.role === "transcript");
  if (!artifact) throw new Error(`Transcription job ${job.id} has no transcript artifact`);
  const blob = await fetchMediaTranscriptionArtifact(job.id, artifact.id, signal);
  if (blob.size !== artifact.bytes) throw new Error("Transcript artifact byte count mismatch");
  const sha256 = await hashMediaTranscriptionSource(blob);
  if (sha256 !== artifact.sha256) throw new Error("Transcript artifact failed SHA-256 verification");
  return directorMediaTranscriptSchema.parse(JSON.parse(await blob.text()) as unknown);
}

/**
 * Fetches the WebVTT caption artifact from a completed transcription job.
 *
 * @param job - The transcription job, must be in "succeeded" status.
 * @param signal - Optional AbortSignal.
 * @returns The raw VTT blob.
 */
export async function fetchMediaTranscriptionVtt(job: MediaTranscriptionJob, signal?: AbortSignal) {
  if (job.status !== "succeeded") throw new Error(`Transcription job ${job.id} is ${job.status}`);
  const artifact = job.artifacts.find((candidate) => candidate.role === "captions");
  if (!artifact) throw new Error(`Transcription job ${job.id} has no caption artifact`);
  const blob = await fetchMediaTranscriptionArtifact(job.id, artifact.id, signal);
  if (blob.size !== artifact.bytes) throw new Error("Caption artifact byte count mismatch");
  return blob;
}
