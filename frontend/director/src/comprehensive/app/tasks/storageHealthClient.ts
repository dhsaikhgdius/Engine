import { z } from "zod";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";

/**
 * Minimal client for the gateway storage/jobs health surface:
 * `GET /api/storage/health`, the dry-run `POST /api/storage/gc/plan`, and the
 * explicitly confirmed `POST /api/storage/gc/sweep`. Sweeping echoes the plan
 * id as `confirm`, matching the gateway's two-step destructive contract.
 */

const usageSchema = z.object({
  objects: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
});

const sweepReasonCountsSchema = z.object({
  unreachable: z.number().int().nonnegative(),
  retentionExpired: z.number().int().nonnegative(),
});

/** The subset of the gateway health report the tray section renders. */
export const storageHealthSummarySchema = z.object({
  generatedAt: z.string(),
  backend: z.string(),
  policy: z.object({
    source: z.enum(["default", "environment"]),
    minimumAgeHours: z.number(),
    rules: z.array(z.unknown()),
    legalHold: z.object({
      keys: z.number().int().nonnegative(),
      keyPrefixes: z.number().int().nonnegative(),
      jobIds: z.number().int().nonnegative(),
    }),
  }),
  usage: z.object({
    jobArtifacts: usageSchema,
    jobMetadata: usageSchema,
    stagedMediaInputs: usageSchema,
    total: usageSchema,
  }),
  jobs: z.object({
    total: z.number().int().nonnegative(),
    nonTerminal: z.number().int().nonnegative(),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
  }),
  sweepCandidates: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    byReason: sweepReasonCountsSchema,
  }),
  recentSweeps: z
    .array(
      z.object({
        planId: z.string(),
        sweptAt: z.string(),
        deletedCount: z.number().int().nonnegative(),
        reclaimedBytes: z.number().nonnegative(),
      }),
    )
    .default([]),
});

/** The subset of the health report the tray renders. */
export type StorageHealthSummary = z.infer<typeof storageHealthSummarySchema>;

/** The reviewable dry-run plan summary the tray renders before a sweep. */
export const storageGcPlanSummarySchema = z.object({
  planId: z.string().min(1),
  plannedAt: z.string(),
  expiresAt: z.string(),
  examined: z.number().int().nonnegative(),
  sweep: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    byReason: sweepReasonCountsSchema,
  }),
});

/** The reviewable dry-run plan summary. */
export type StorageGcPlanSummary = z.infer<typeof storageGcPlanSummarySchema>;

/** The outcome of one confirmed sweep. */
export const storageGcSweepOutcomeSchema = z.object({
  planId: z.string().min(1),
  sweptAt: z.string(),
  replayed: z.boolean(),
  deletedCount: z.number().int().nonnegative(),
  reclaimedBytes: z.number().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});

/** The outcome of one confirmed sweep. */
export type StorageGcSweepOutcome = z.infer<typeof storageGcSweepOutcomeSchema>;

async function readJson(response: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : `${fallbackMessage}（HTTP ${response.status}）`);
  }
  return body;
}

/**
 * Fetches the read-only storage/jobs health report.
 *
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function fetchStorageHealth(signal?: AbortSignal): Promise<StorageHealthSummary> {
  const response = await directorControlPlaneFetch("/api/storage/health", { signal });
  const body = await readJson(response, "存储健康信息请求失败");
  return storageHealthSummarySchema.parse(body.health);
}

/**
 * Computes a reviewable dry-run GC plan on the gateway. Nothing is deleted.
 *
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function planStorageGc(signal?: AbortSignal): Promise<StorageGcPlanSummary> {
  const response = await directorControlPlaneFetch("/api/storage/gc/plan", { method: "POST", signal });
  const body = await readJson(response, "存储清扫计划请求失败");
  return storageGcPlanSummarySchema.parse(body.plan);
}

/**
 * Executes one previously reviewed plan. The gateway requires the plan id to
 * be echoed as `confirm`; the caller's explicit confirmation is the reviewed
 * plan itself.
 *
 * @param planId - The plan id returned by {@link planStorageGc}.
 * @param signal - Optional AbortSignal for request cancellation.
 */
export async function sweepStorageGc(planId: string, signal?: AbortSignal): Promise<StorageGcSweepOutcome> {
  const response = await directorControlPlaneFetch("/api/storage/gc/sweep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, confirm: planId }),
    signal,
  });
  const body = await readJson(response, "存储清扫执行失败");
  return storageGcSweepOutcomeSchema.parse(body.result);
}

/**
 * Formats a byte count for the compact health rows (e.g. "3.2 MB").
 *
 * @param bytes - The byte count.
 */
export function formatStorageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
