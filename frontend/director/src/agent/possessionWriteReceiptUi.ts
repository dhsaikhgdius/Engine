/**
 * Possession write-depth receipt presentation: turn gateway `possession`
 * payloads (filled_targets auto-fill, target ambiguity, scope rejection) into
 * concise zh-CN notices for humans debugging Agent possession writes.
 *
 * @module possession-write-receipt-ui
 */

import type {
  DirectorPossessionScopeRejection,
  DirectorPossessionTargetAmbiguity,
  DirectorPossessionWriteReceipt,
} from "@director/agent-engine";
import { notifyDirector } from "../comprehensive/app/notifications/directorNotificationStore";

const POSSESSION_NOTICE_KEY = "possession-write-feedback";
const POSSESSION_NOTICE_DISMISS_MS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function formatFilledTargetLine(entry: { index: number; action: string; field: string; object_id: string }): string {
  return `actions[${entry.index}] ${entry.action}.${entry.field} → ${entry.object_id}`;
}

function formatOmittedTargetLine(entry: { index: number; action: string; field: string }): string {
  return `actions[${entry.index}] ${entry.action}.${entry.field}`;
}

/** Narrow an unknown gateway `possession` block to a successful auto-fill receipt. */
export function parsePossessionWriteReceipt(value: unknown): DirectorPossessionWriteReceipt | null {
  const record = asRecord(value);
  if (!record) return null;
  const filled = record.filled_targets;
  if (!Array.isArray(filled) || filled.length === 0) return null;
  const filled_targets: DirectorPossessionWriteReceipt["filled_targets"] = [];
  for (const entry of filled) {
    const row = asRecord(entry);
    if (!row) return null;
    if (typeof row.index !== "number" || !Number.isInteger(row.index) || row.index < 0) return null;
    if (typeof row.action !== "string" || !row.action) return null;
    if (row.field !== "object_id" && row.field !== "object_ids" && row.field !== "target_id") return null;
    if (typeof row.object_id !== "string" || !row.object_id) return null;
    filled_targets.push({
      index: row.index,
      action: row.action,
      field: row.field,
      object_id: row.object_id,
    });
  }
  return {
    session_id: typeof record.session_id === "string" ? record.session_id : "",
    possessed_object_ids: asStringArray(record.possessed_object_ids),
    filled_targets,
  };
}

/** Narrow an unknown gateway `possession` block to a multi-possess ambiguity detail. */
export function parsePossessionTargetAmbiguity(value: unknown): DirectorPossessionTargetAmbiguity | null {
  const record = asRecord(value);
  if (!record) return null;
  const omitted = record.omitted_targets;
  if (!Array.isArray(omitted) || omitted.length === 0) return null;
  if (Array.isArray(record.filled_targets)) return null;
  const omitted_targets: DirectorPossessionTargetAmbiguity["omitted_targets"] = [];
  for (const entry of omitted) {
    const row = asRecord(entry);
    if (!row) return null;
    if (typeof row.index !== "number" || !Number.isInteger(row.index) || row.index < 0) return null;
    if (typeof row.action !== "string" || !row.action) return null;
    if (row.field !== "object_id" && row.field !== "object_ids" && row.field !== "target_id") return null;
    omitted_targets.push({ index: row.index, action: row.action, field: row.field });
  }
  return {
    session_id: typeof record.session_id === "string" ? record.session_id : "",
    possessed_object_ids: asStringArray(record.possessed_object_ids),
    omitted_targets,
  };
}

/** Narrow an unknown gateway `possession` block to a scope-rejection detail. */
export function parsePossessionScopeRejection(value: unknown): DirectorPossessionScopeRejection | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.reason !== "string" || !record.reason) return null;
  if (typeof record.operation !== "string" || !record.operation) return null;
  if (Array.isArray(record.filled_targets) || Array.isArray(record.omitted_targets)) return null;
  return {
    session_id: typeof record.session_id === "string" ? record.session_id : "",
    possessed_object_ids: asStringArray(record.possessed_object_ids),
    operation: record.operation,
    reason: record.reason as DirectorPossessionScopeRejection["reason"],
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    ...(typeof record.target_id === "string" ? { target_id: record.target_id } : {}),
  };
}

/** Concise zh-CN notice for a successful sole-possession auto-fill receipt. */
export function formatPossessionFilledTargetsNotice(receipt: DirectorPossessionWriteReceipt): {
  title: string;
  detail: string;
} {
  const lines = receipt.filled_targets.map(formatFilledTargetLine);
  const preview = lines.slice(0, 3).join("；");
  const more = lines.length > 3 ? `；另有 ${lines.length - 3} 项` : "";
  return {
    title: "占有写入已自动填充目标",
    detail: preview + more,
  };
}

/** Concise zh-CN notice when omitted targets cannot be auto-filled. */
export function formatPossessionAmbiguityNotice(possession: DirectorPossessionTargetAmbiguity): {
  title: string;
  detail: string;
} {
  const possessed = possession.possessed_object_ids.length ? possession.possessed_object_ids.join(", ") : "（无）";
  const omitted = possession.omitted_targets.map(formatOmittedTargetLine).slice(0, 3).join("；");
  const more = possession.omitted_targets.length > 3 ? `；另有 ${possession.omitted_targets.length - 3} 项省略` : "";
  return {
    title: "占有目标不明确，无法自动填充",
    detail: `已占有：${possessed}。省略：${omitted}${more}`,
  };
}

/** Concise zh-CN notice for a typed possession scope rejection. */
export function formatPossessionScopeRejectionNotice(possession: DirectorPossessionScopeRejection): {
  title: string;
  detail: string;
} {
  const possessed = possession.possessed_object_ids.length ? possession.possessed_object_ids.join(", ") : "（无）";
  const parts = [`已占有：${possessed}`, `operation=${possession.operation}`, `reason=${possession.reason}`];
  if (possession.action) parts.push(`action=${possession.action}`);
  if (possession.target_id) parts.push(`target=${possession.target_id}`);
  return {
    title: "占有范围拒绝写入",
    detail: parts.join("。"),
  };
}

export type DirectorPossessionFeedbackAnnouncement = {
  title: string;
  detail: string;
  severity: "info" | "warning" | "error";
};

/**
 * Build a notice from a gateway execution `code` + `possession` payload.
 * Returns null when the payload is not a recognized possession write-depth shape.
 */
export function presentDirectorPossessionFeedback(input: {
  code?: string | null;
  possession: unknown;
}): DirectorPossessionFeedbackAnnouncement | null {
  const filled = parsePossessionWriteReceipt(input.possession);
  if (filled) {
    const notice = formatPossessionFilledTargetsNotice(filled);
    return { ...notice, severity: "info" };
  }
  if (input.code === "possession_target_ambiguous" || parsePossessionTargetAmbiguity(input.possession)) {
    const ambiguity = parsePossessionTargetAmbiguity(input.possession);
    if (ambiguity) {
      const notice = formatPossessionAmbiguityNotice(ambiguity);
      return { ...notice, severity: "warning" };
    }
  }
  if (input.code === "possession_scope_violation" || parsePossessionScopeRejection(input.possession)) {
    const rejection = parsePossessionScopeRejection(input.possession);
    if (rejection) {
      const notice = formatPossessionScopeRejectionNotice(rejection);
      return { ...notice, severity: "error" };
    }
  }
  return null;
}

/**
 * Project a possession write-depth receipt or rejection into the Director
 * notification layer. Returns true when a notice was shown.
 */
export function announceDirectorPossessionFeedback(input: { code?: string | null; possession: unknown }): boolean {
  const notice = presentDirectorPossessionFeedback(input);
  if (!notice) return false;
  notifyDirector({
    key: POSSESSION_NOTICE_KEY,
    severity: notice.severity,
    title: notice.title,
    detail: notice.detail,
    autoDismissMs: POSSESSION_NOTICE_DISMISS_MS,
  });
  return true;
}
