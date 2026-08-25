import { z } from "zod";
import {
  episodePackageJobInputSchema,
  type EpisodePackageJobInput,
} from "@director/protocol/episode";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "@director/protocol/production-job";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";

/** Structured error thrown when the episode package API returns a non-2xx response. */
export class EpisodePackageClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EpisodePackageClientError";
  }
}

const jobResponseSchema = z.looseObject({ job: productionJobRecordSchema });

async function readJson(response: Response) {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new EpisodePackageClientError(
      typeof body.message === "string" ? body.message : "Episode 封装请求失败",
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return body;
}

/**
 * Stages an MP4 into the shared content-addressed media-input store.
 * Re-uploading identical bytes is idempotent.
 */
export async function stageEpisodeVideo(file: Blob, signal?: AbortSignal) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await directorControlPlaneFetch(`/api/production-jobs/media-inputs?sha256=${sha256}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "video/mp4" },
    body: bytes,
    signal,
  });
  const parsed = z
    .looseObject({
      input: z.looseObject({ sourceMediaId: z.string().min(1), sha256: z.string(), bytes: z.number() }),
    })
    .parse(await readJson(response));
  return { sourceMediaId: parsed.input.sourceMediaId, sha256: parsed.input.sha256, bytes: parsed.input.bytes };
}

/**
 * Submits an episode package job to the production job queue and returns the created job record.
 * The idempotency key prevents duplicate submissions for the same logical request.
 *
 * @param input - The validated episode package job input.
 * @param idempotencyKey - A unique key to prevent duplicate submissions.
 * @param signal - Optional AbortSignal for cancellation.
 * @returns The created production job record.
 */
export async function submitEpisodePackageJob(
  input: EpisodePackageJobInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ProductionJobRecord> {
  const response = await directorControlPlaneFetch("/api/production-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "episode.package",
      idempotencyKey,
      input: episodePackageJobInputSchema.parse(input),
    }),
    signal,
  });
  return jobResponseSchema.parse(await readJson(response)).job;
}
