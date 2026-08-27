/**
 * Presentation helpers for media transcription panel honesty: map stable
 * gateway / bridge failure codes onto zh-CN source labels so operators see a
 * typed code, not only free-text from `friendlyErrorMessage`.
 *
 * Codes are discovered from the gateway transcription routes, the browser
 * bridge, and the Agent workbench — do not invent new taxonomy here.
 *
 * @module media-transcription-presentation
 */

import { friendlyErrorMessage, isNetworkFailureMessage } from "../api/friendlyError";
import { MediaTranscriptionRequestError } from "./mediaTranscriptionBridge";

/**
 * zh-CN labels for known public transcription failure codes.
 * Keys match gateway HTTP `code` fields and Agent workbench transport mappings.
 */
export const MEDIA_TRANSCRIPTION_ERROR_LABELS: Readonly<Record<string, string>> = {
  transcription_not_configured: "转录服务未配置",
  transcription_job_not_found: "转录任务不存在",
  transcription_source_missing: "转录源文件缺失",
  transcription_cancel_conflict: "无法取消该转录任务",
  transcription_retry_conflict: "无法重试该转录任务",
  gateway_unreachable: "无法连接转录网关",
  invalid_request: "转录请求无效",
  unsupported_source_type: "不支持的转录源类型",
  source_too_large: "转录源文件过大",
  invalid_source: "转录源文件无效",
  production_job_idempotency_conflict: "转录幂等键冲突",
  transcription_failed: "转录失败",
  cancelled: "转录已取消",
};

/** Structured view of a transcription panel error for display. */
export type MediaTranscriptionErrorPresentation = {
  /** Stable code when known (gateway body, or transport mapping). */
  code: string | null;
  /** zh-CN source label when the code is in {@link MEDIA_TRANSCRIPTION_ERROR_LABELS}. */
  label: string | null;
  /** Friendly free-text fallback (never invents a code). */
  detail: string;
};

/**
 * Resolves a stable transcription failure code from a thrown value.
 * Mirrors Agent workbench mapping for `MediaTranscriptionRequestError` and
 * transport-level `TypeError` → `gateway_unreachable`.
 */
export function mediaTranscriptionErrorCode(error: unknown): string | null {
  if (error instanceof MediaTranscriptionRequestError && error.code) return error.code;
  if (error instanceof TypeError && isNetworkFailureMessage(error.message)) return "gateway_unreachable";
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  return null;
}

/**
 * Returns the zh-CN source label for a known transcription error code, or null.
 */
export function mediaTranscriptionErrorLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return MEDIA_TRANSCRIPTION_ERROR_LABELS[code] ?? null;
}

/**
 * Builds a presentation object for a transcription panel catch path.
 *
 * @param error - Thrown value from bridge / fetch.
 * @param fallbackZh - zh-CN fallback when no friendly detail is available.
 */
export function presentMediaTranscriptionError(
  error: unknown,
  fallbackZh = "转录请求失败",
): MediaTranscriptionErrorPresentation {
  const code = mediaTranscriptionErrorCode(error);
  const label = mediaTranscriptionErrorLabel(code);
  const detail = error instanceof Error || typeof error === "string" ? friendlyErrorMessage(error) : fallbackZh;
  return { code, label, detail: detail || fallbackZh };
}

type Translate = (source: string) => string;

/**
 * Formats a transcription error for the panel alert: prefers
 * `标签（code）` when the code is known, otherwise friendly detail (and
 * appends an unknown code when the gateway sent one we have no label for).
 */
export function formatMediaTranscriptionErrorMessage(
  error: unknown,
  options?: { fallbackZh?: string; t?: Translate },
): string {
  const presentation = presentMediaTranscriptionError(error, options?.fallbackZh);
  const t = options?.t ?? ((source: string) => source);
  if (presentation.label && presentation.code) {
    return `${t(presentation.label)}（${presentation.code}）`;
  }
  if (presentation.code) {
    return `${presentation.detail}（${presentation.code}）`;
  }
  return presentation.detail;
}

/**
 * zh-CN source line shown when capabilities report `configured: false`.
 * Keeps the stable code visible so the panel matches submit/retry refusals.
 */
export const MEDIA_TRANSCRIPTION_UNCONFIGURED_CAPABILITIES_MESSAGE =
  "转录服务未配置（transcription_not_configured）。请在网关设置 DIRECTOR_TRANSCRIPTION_API_KEY（或 OPENAI_API_KEY）后重启网关；未配置时无法提交或重试转录任务。";
