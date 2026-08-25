/**
 * Normalizes arbitrary thrown values (fetch failures, HTTP errors, timeouts…)
 * into user-facing Chinese copy. Messages that already contain Chinese are
 * treated as intentional user-facing copy and pass through unchanged;
 * unrecognized machine messages keep their original text behind a prefix so
 * nothing is silently swallowed.
 */

const CJK_PATTERN = /[\u3400-\u9fff]/;

const NETWORK_FAILURE_PATTERN =
  /\b(failed to fetch|fetch failed|networkerror|network request failed|load failed|econnrefused|econnreset|enotfound|eai_again|socket hang up)\b/i;

const TIMEOUT_PATTERN = /\b(timeout|timed? ?out|etimedout)\b/i;

/** User-facing Chinese message shown when the gateway cannot be reached. */
export const GATEWAY_UNREACHABLE_MESSAGE = "无法连接到网关，请确认网关已启动";

/** True when the message looks like a transport-level failure rather than a server response. */
export function isNetworkFailureMessage(message: string): boolean {
  return NETWORK_FAILURE_PATTERN.test(message);
}

/**
 * Returns a user-facing Chinese error message for a given HTTP status code.
 *
 * @param status - The HTTP status code (400–599).
 * @returns A localized error message.
 */
export function friendlyHttpStatusMessage(status: number): string {
  if (status === 401 || status === 403) return `网关拒绝了请求（HTTP ${status}），请检查访问令牌或权限`;
  if (status === 404) return "请求的接口不存在（HTTP 404），请确认网关版本是否匹配";
  if (status === 408 || status === 504) return `网关请求超时（HTTP ${status}），请稍后重试`;
  if (status === 429) return "请求过于频繁（HTTP 429），请稍后重试";
  if (status >= 500) return `网关内部错误（HTTP ${status}），请查看网关日志`;
  if (status >= 400) return `请求被网关拒绝（HTTP ${status}），请检查提交内容`;
  return `请求失败（HTTP ${status}）`;
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "");
}

function matchHttpStatus(message: string): number | null {
  const match =
    message.match(/\(\s*(\d{3})\s*\)/) ?? message.match(/\bHTTP[\s/]*(\d{3})\b/i) ?? message.match(/\bstatus\s*(?:code\s*)?[:=]?\s*(\d{3})\b/i);
  if (!match) return null;
  const status = Number(match[1]);
  return status >= 400 && status <= 599 ? status : null;
}

/**
 * Converts any thrown error into a user-facing Chinese error message.
 *
 * Handles DOMException (AbortError, TimeoutError), network failures, HTTP
 * status codes, and timeouts. Messages already containing Chinese characters
 * are assumed to be intentional user-facing copy and pass through unchanged.
 *
 * @param error - Any thrown value (Error, string, DOMException, etc.).
 * @returns A user-facing Chinese error message.
 */
export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return error.name === "TimeoutError" ? "请求超时，请稍后重试" : "请求已取消";
  }
  const raw = extractMessage(error).trim();
  if (!raw) return "发生未知错误";
  // Chinese copy is assumed to be an intentional user-facing message.
  if (CJK_PATTERN.test(raw)) return raw;
  if (NETWORK_FAILURE_PATTERN.test(raw)) return GATEWAY_UNREACHABLE_MESSAGE;
  const status = matchHttpStatus(raw);
  if (status != null) return friendlyHttpStatusMessage(status);
  if (TIMEOUT_PATTERN.test(raw)) return "请求超时，请稍后重试";
  return `请求失败：${raw}`;
}
