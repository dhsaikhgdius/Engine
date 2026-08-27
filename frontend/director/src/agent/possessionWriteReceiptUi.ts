/**
 * Possession write-depth receipt presentation: turn gateway `possession`
 * payloads (filled_targets auto-fill, target ambiguity, scope rejection) into
 * concise zh-CN notices for humans debugging Agent possession writes.
 *
 * @module possession-write-receipt-ui
 */

import type {
  DirectorPossessionScopeRejection,
  DirectorPossessionScopeRejectionReason,
  DirectorPossessionTargetAmbiguity,
  DirectorPossessionWriteReceipt,
} from "@director/agent-engine";
import { notifyDirector } from "../comprehensive/app/notifications/directorNotificationStore";

const POSSESSION_NOTICE_KEY = "possession-write-feedback";
const POSSESSION_NOTICE_DISMISS_MS = 8_000;

/** zh-CN labels for typed possession scope rejection reasons (gateway vocabulary). */
export const POSSESSION_REASON_LABELS: Record<DirectorPossessionScopeRejectionReason, string> = {
  stage_wide_mutation: "全场写入被拒绝",
  unscoped_author_action: "未限定到占有角色的写入",
  target_not_possessed: "目标不在占有范围内",
  actor_id_omitted: "缺少 actor_id",
  live_actor_conflict: "与 live player 冲突",
  live_player_inactive: "Player Mode 未激活",
};

/** zh-CN recovery hints mirroring gateway Agent recovery suggestions. */
export const POSSESSION_REASON_RECOVERY: Record<DirectorPossessionScopeRejectionReason, string> = {
  live_actor_conflict:
    "观察 ui 直至 player_mode 为 false 或 player_actor_id 为占有角色，再重试 player.enter/set_actor 并显式指定 actor_id。",
  live_player_inactive:
    "先对占有角色调用 player.enter 并显式指定 actor_id，再观察 ui 确认 player_mode/player_actor_id 后重试其余 player 动词。",
  actor_id_omitted:
    "在 player.enter、player.set_actor、player.teleport 或 player.walk_to 中显式指定一个占有角色 id 作为 actor_id。",
  target_not_possessed:
    "将写入重定向到 possession.possessed_object_ids 中的占有角色 id，或 unbind_character_agent 解除限制。",
  unscoped_author_action:
    "改用每个变更目标 id 均为占有角色的 character-scoped author 动作，或 unbind_character_agent 解除限制。",
  stage_wide_mutation: "全场写入在占有模式下被拒绝。请先 unbind_character_agent，或在未占有 session 中执行该意图。",
};

/** Returns the zh-CN label for a possession scope rejection reason, or null when unknown. */
export function possessionReasonLabel(reason: string): string | null {
  return reason in POSSESSION_REASON_LABELS
    ? POSSESSION_REASON_LABELS[reason as DirectorPossessionScopeRejectionReason]
    : null;
}

/** Returns a zh-CN recovery hint for a possession scope rejection reason, or null when unknown. */
export function possessionReasonRecoveryHint(reason: string): string | null {
  return reason in POSSESSION_REASON_RECOVERY
    ? POSSESSION_REASON_RECOVERY[reason as DirectorPossessionScopeRejectionReason]
    : null;
}

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
  const reasonLabel = possessionReasonLabel(possession.reason) ?? possession.reason;
  const recovery = possessionReasonRecoveryHint(possession.reason);
  const parts = [`已占有：${possessed}`, `操作：${possession.operation}`, `原因：${reasonLabel}`];
  if (possession.action) parts.push(`动作：${possession.action}`);
  if (possession.target_id) parts.push(`目标：${possession.target_id}`);
  if (recovery) parts.push(`建议：${recovery}`);
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
