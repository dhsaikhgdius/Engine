/**
 * Human-facing presentation for `director_creative media.verify` receipts.
 * Labels stay zh-CN source strings (translated via i18n); outcomes and omit
 * reasons match the Agent contract enums exactly — never invent a sixth status.
 *
 * @module media-verify-presentation
 */

import type { z } from "zod";
import {
  creativeWorkspaceMediaDurabilityOmitReasonSchema,
  creativeWorkspaceMediaDurabilityOutcomeSchema,
  creativeWorkspaceMediaDurabilityProbeSchema,
  creativeWorkspaceMediaStorageStanzaSchema,
  creativeWorkspaceMediaVerifyResultSchema,
} from "../../../../../../packages/protocol/src/creativeWorkspaceProtocol";

/** Typed durability outcome from the media.verify contract. */
export type MediaVerifyOutcome = z.infer<typeof creativeWorkspaceMediaDurabilityOutcomeSchema>;

/** Typed omit reason when a probe could not complete. */
export type MediaVerifyOmitReason = z.infer<typeof creativeWorkspaceMediaDurabilityOmitReasonSchema>;

/** One probed item from a media.verify receipt. */
export type MediaVerifyProbeItem = z.infer<typeof creativeWorkspaceMediaDurabilityProbeSchema>;

/** Storage stanza stamped on media.verify receipts. */
export type MediaVerifyStorageStanza = z.infer<typeof creativeWorkspaceMediaStorageStanzaSchema>;

/** Full media.verify result payload. */
export type MediaVerifyResult = z.infer<typeof creativeWorkspaceMediaVerifyResultSchema>;

/** zh-CN labels for each typed durability outcome. */
export const MEDIA_VERIFY_OUTCOME_LABELS: Record<MediaVerifyOutcome, string> = {
  verified: "已验证",
  size_mismatch: "大小不匹配",
  missing_bytes: "字节缺失",
  not_cataloged: "未入册",
  unverified: "未验证",
};

/** zh-CN labels for typed omit reasons (probe skipped, not guessed). */
export const MEDIA_VERIFY_OMIT_REASON_LABELS: Record<MediaVerifyOmitReason, string> = {
  blob_reader_unavailable: "无法读取持久字节",
  probe_failed: "探测失败",
};

/**
 * Returns the zh-CN label for a media.verify outcome enum.
 *
 * @param outcome - Contract outcome code.
 */
export function mediaVerifyOutcomeLabel(outcome: MediaVerifyOutcome): string {
  return MEDIA_VERIFY_OUTCOME_LABELS[outcome];
}

/**
 * Returns the zh-CN label for a media.verify omit reason, or null when absent.
 *
 * @param reason - Contract omit reason, or null when the probe completed.
 */
export function mediaVerifyOmitReasonLabel(reason: MediaVerifyOmitReason | null): string | null {
  return reason ? MEDIA_VERIFY_OMIT_REASON_LABELS[reason] : null;
}

/**
 * One display row for the structured verify results list.
 */
export type MediaVerifyResultRow = {
  mediaId: string;
  outcome: MediaVerifyOutcome;
  outcomeLabel: string;
  omitReasonLabel: string | null;
  detail: string | null;
  catalogedBytes: number | null;
  storedBytes: number | null;
};

/**
 * Projects probed items into display rows. Does not invent outcomes.
 *
 * @param items - Probe items from a completed media.verify receipt.
 */
export function mediaVerifyResultRows(items: readonly MediaVerifyProbeItem[]): MediaVerifyResultRow[] {
  return items.map((item) => ({
    mediaId: item.media_id,
    outcome: item.outcome,
    outcomeLabel: mediaVerifyOutcomeLabel(item.outcome),
    omitReasonLabel: mediaVerifyOmitReasonLabel(item.omit_reason),
    detail: item.detail,
    catalogedBytes: item.cataloged_bytes,
    storedBytes: item.stored_bytes,
  }));
}

/**
 * Short storage honesty line: memory mode is never claimed durable.
 *
 * @param storage - Storage stanza from the verify receipt.
 */
export function mediaVerifyStorageSummary(storage: MediaVerifyStorageStanza): string {
  if (storage.durable) {
    return storage.mode === "indexeddb" ? "持久存储（IndexedDB）" : "持久存储";
  }
  return storage.warning?.trim() || "内存模式（不可持久，刷新后丢失）";
}

/**
 * Summary counts line for the completed probe (zh-CN source).
 *
 * @param counts - Aggregate counts from the verify receipt.
 */
export function mediaVerifyCountsSummary(counts: MediaVerifyResult["counts"]): string {
  return `${counts.verified} 已验证 · ${counts.size_mismatch} 大小不匹配 · ${counts.missing_bytes} 字节缺失 · ${counts.not_cataloged} 未入册 · ${counts.unverified} 未验证`;
}

/**
 * UI state for a media.verify run. Honesty: pending never claims verified.
 */
export type MediaVerifyUiState =
  | { status: "idle" }
  | { status: "pending"; mediaIds: readonly string[] }
  | { status: "done"; result: MediaVerifyResult }
  | { status: "error"; message: string };

/** True while a probe is in flight — UI must not show a verified claim. */
export function mediaVerifyIsPending(
  state: MediaVerifyUiState,
): state is Extract<MediaVerifyUiState, { status: "pending" }> {
  return state.status === "pending";
}

/** True only after a completed receipt with at least one verified item. */
export function mediaVerifyHasVerified(state: MediaVerifyUiState): boolean {
  return state.status === "done" && state.result.counts.verified > 0;
}
