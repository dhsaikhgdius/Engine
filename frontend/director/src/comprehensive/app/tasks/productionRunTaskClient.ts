import { z } from "zod";
import {
  filmPipelineAvailabilitySchema,
  filmRunSchema,
  type FilmRun,
} from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import { filmRunReceiptSchema, type FilmRunReceipt } from "../../../../../../packages/protocol/src/filmRunReceipt";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";

const filmRunEnvelopeSchema = z.strictObject({ run: filmRunSchema, receipt: filmRunReceiptSchema.optional() });
const filmRunListEnvelopeSchema = z.strictObject({
  runs: z.array(filmRunSchema),
  pipeline: filmPipelineAvailabilitySchema.optional(),
});

/** A film production run monitored by the tray. */
export type DirectorMonitoredProductionRun = {
  source: "film";
  run: FilmRun;
  /** Live receipt with probed `artifacts.storagePresence`; omitted until the detail fetch succeeds. */
  receipt?: FilmRunReceipt;
};

async function filmJsonRequest(path: string, init: RequestInit = {}) {
  const response = await directorControlPlaneFetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const message =
      (typeof record?.message === "string" && record.message) ||
      (typeof record?.error === "string" && record.error) ||
      `Film run 请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return body;
}

async function fetchDirectorMonitoredProductionRun(run: FilmRun): Promise<DirectorMonitoredProductionRun> {
  try {
    const body = filmRunEnvelopeSchema.parse(await filmJsonRequest(`/api/film/runs/${encodeURIComponent(run.id)}`));
    return { source: "film", run: body.run, receipt: body.receipt };
  } catch {
    // Keep the list snapshot when the live receipt fetch fails so the tray
    // stays usable and can retry on the next poll.
    return { source: "film", run };
  }
}

/**
 * Fetches film production runs for the task tray.
 *
 * Lists durable runs, then attaches a live receipt (with probed artifact
 * `storagePresence`) from `GET /api/film/runs/:id` for each entry.
 *
 * @returns Film production runs tagged for the tray.
 */
export async function listDirectorMonitoredProductionRuns(): Promise<DirectorMonitoredProductionRun[]> {
  const filmRuns = filmRunListEnvelopeSchema.parse(await filmJsonRequest("/api/film/runs")).runs;
  return Promise.all(filmRuns.map(fetchDirectorMonitoredProductionRun));
}

/**
 * Cancels a monitored film production run.
 *
 * @param entry - The monitored production run to cancel.
 * @returns The updated run record after cancellation.
 */
export async function cancelDirectorMonitoredProductionRun(
  entry: DirectorMonitoredProductionRun,
): Promise<DirectorMonitoredProductionRun> {
  const body = await filmJsonRequest(`/api/film/runs/${encodeURIComponent(entry.run.id)}/cancel`, {
    method: "POST",
  });
  const parsed = filmRunEnvelopeSchema.parse(body);
  return { source: entry.source, run: parsed.run, receipt: parsed.receipt };
}

/**
 * Returns a unique stable key for a monitored production run.
 *
 * @param entry - The monitored production run.
 * @returns A key like `"film:xyz789"`.
 */
export function monitoredProductionRunKey(entry: DirectorMonitoredProductionRun) {
  return `${entry.source}:${entry.run.id}`;
}
