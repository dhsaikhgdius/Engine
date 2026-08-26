import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { StorageOpsService } from "../media/storageOpsService";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

/** Dependencies for {@link handleStorageOpsRoute}. */
export type StorageOpsRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  service: StorageOpsService;
};

const sweepRequestSchema = z.strictObject({
  planId: z.string().trim().min(1).max(240),
  /** Must echo `planId` exactly; sweeping is destructive and never implicit. */
  confirm: z.string().trim().min(1).max(240),
});

/** HTTP responses cap the reviewable entry/key lists to stay bounded. */
const MAX_RESPONSE_ENTRIES = 500;

function truncated<T>(values: readonly T[]) {
  return {
    values: values.slice(0, MAX_RESPONSE_ENTRIES),
    truncated: values.length > MAX_RESPONSE_ENTRIES,
  };
}

/**
 * Read-only storage health plus explicit two-step GC:
 *
 * - `GET  /api/storage/health` — backend, retention policy in effect, usage
 *   estimates, current sweep candidates, and recent executed sweeps.
 * - `POST /api/storage/gc/plan` — computes and retains a reviewable dry-run
 *   plan; nothing is deleted.
 * - `POST /api/storage/gc/sweep` — executes exactly one retained plan; the
 *   caller must echo the plan id as `confirm`. Idempotent on replay.
 */
export async function handleStorageOpsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: StorageOpsRouteDependencies,
): Promise<boolean> {
  const { json, service } = dependencies;

  if (request.method === "GET" && url.pathname === "/api/storage/health") {
    json(response, 200, { health: await service.health() });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/storage/gc/plan") {
    const summary = await service.plan();
    const entries = truncated(summary.sweepEntries);
    json(response, 200, {
      plan: {
        ...summary,
        sweepEntries: entries.values,
        sweepEntriesTruncated: entries.truncated,
      },
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/storage/gc/sweep") {
    const parsed = sweepRequestSchema.safeParse(await dependencies.readBody(request));
    if (!parsed.success) {
      json(response, 400, { message: "Storage GC sweep 请求格式无效", issues: parsed.error.issues });
      return true;
    }
    try {
      const outcome = await service.sweep(parsed.data);
      const deleted = truncated(outcome.deletedKeys);
      const skipped = truncated(outcome.skippedKeys);
      json(response, 200, {
        result: {
          ...outcome,
          deletedKeys: deleted.values,
          deletedKeysTruncated: deleted.truncated,
          skippedKeys: skipped.values,
          skippedKeysTruncated: skipped.truncated,
        },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "gc_confirm_mismatch") {
        json(response, 400, { code, message: (error as Error).message });
        return true;
      }
      if (code === "gc_plan_not_found" || code === "gc_plan_expired") {
        json(response, 409, { code, message: (error as Error).message });
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}
