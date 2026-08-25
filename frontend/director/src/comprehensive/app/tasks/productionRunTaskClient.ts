import { z } from "zod";
import { filmRunSchema, type FilmRun } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import { directorControlPlaneFetch } from "../../editor/api/directorControlPlaneClient";

const filmRunEnvelopeSchema = z.strictObject({ run: filmRunSchema });
const filmRunListEnvelopeSchema = z.strictObject({ runs: z.array(filmRunSchema) });

/** A film production run monitored by the tray. */
export type DirectorMonitoredProductionRun = { source: "film"; run: FilmRun };

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

/**
 * Fetches film production runs for the task tray.
 *
 * @returns Film production runs tagged for the tray.
 */
export async function listDirectorMonitoredProductionRuns(): Promise<DirectorMonitoredProductionRun[]> {
  const filmRuns = filmRunListEnvelopeSchema.parse(await filmJsonRequest("/api/film/runs")).runs;
  return filmRuns.map((run) => ({ source: "film" as const, run }));
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
  return { source: entry.source, run: filmRunEnvelopeSchema.parse(body).run };
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
