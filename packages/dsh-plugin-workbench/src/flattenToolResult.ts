import { asRecord } from "@director/protocol/primitives";

const LIFTED_RESULT_KEYS = [
  "id",
  "name",
  "type",
  "mode",
  "dimensions",
  "position",
  "evaluatedBounds",
  "counts",
  "items",
  "objects",
  "mesh",
  "materials",
  "sceneMaterials",
  "cameraId",
  "width",
  "height",
  "mimeType",
  "project_revision",
  "active_camera_id",
  "ready",
  "error_count",
  "warning_count",
  "summary",
  "source",
  "workbench_connected",
  "warnings",
  "receipt",
  "metrics",
  "sceneEpoch",
] as const;

function jsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function unwrapNestedToolResult(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null;
  const inner = asRecord(result.result);
  if (inner && (result.job !== undefined || result.inspection !== undefined)) return inner;
  return result;
}

function liftKnownFields(core: Record<string, unknown>): Record<string, unknown> {
  const lifted: Record<string, unknown> = {};
  for (const key of LIFTED_RESULT_KEYS) {
    if (core[key] !== undefined) lifted[key] = core[key];
  }
  const receipt = asRecord(lifted.receipt) ?? asRecord(core.receipt);
  if (lifted.warnings === undefined && Array.isArray(receipt?.warnings) && receipt.warnings.length) {
    lifted.warnings = receipt.warnings;
  }
  if (lifted.metrics === undefined && receipt?.metrics !== undefined) {
    lifted.metrics = receipt.metrics;
  }
  if (lifted.receipt === undefined && receipt) lifted.receipt = receipt;
  return lifted;
}

/**
 * Flattens Gateway envelopes so DSH `code` can read `counts` / `dimensions` /
 * `receipt` without `undefined`, which that runner rejects as non-lossless JSON.
 */
export function flattenDirectorToolResult(body: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(body.result);
  const core = unwrapNestedToolResult(result) ?? result;
  const merged = { ...(result ?? {}), ...(core ?? {}) };
  return jsonSafe({
    success: body.success,
    ...liftKnownFields(merged),
    result: core ?? body.result,
    capture: body.capture,
    error: body.error,
    target: body.target,
    feedback: body.feedback,
    director_project_sync: body.director_project_sync,
  });
}
