/**
 * Shared sensitive-value redaction used by planner diagnostics and the agent
 * workspace prompt/export surfaces. Keeping one rule set guarantees that text
 * persisted in the agent workspace is redacted with exactly the same rules as
 * existing harness diagnostics.
 */

/** Key names whose values are always redacted, in JSON, query strings, or headers. */
export const SENSITIVE_KEY_PATTERN =
  "(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|browser[_-]?token|preview[_-]?token|gateway[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|token|secret|authorization|cookie)";

/**
 * Redacts credential-like values from arbitrary text: JSON string values,
 * escaped-JSON string values, query parameters, HTTP auth headers, and
 * `key=value` assignments whose key matches {@link SENSITIVE_KEY_PATTERN}.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      new RegExp(`(\\\\\"${SENSITIVE_KEY_PATTERN}\\\\\"\\s*:\\s*)\\\\\"(?:\\\\\\\\.|[^\"\\\\])*\\\\\"`, "gi"),
      '$1\\"[REDACTED]\\"',
    )
    .replace(new RegExp(`("${SENSITIVE_KEY_PATTERN}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi"), '$1"[REDACTED]"')
    .replace(new RegExp(`('${SENSITIVE_KEY_PATTERN}'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`, "gi"), "$1'[REDACTED]'")
    .replace(new RegExp(`([?&]${SENSITIVE_KEY_PATTERN}=)[^&#\\s]*`, "gi"), "$1[REDACTED]")
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|x-auth-token|x-director-browser-token|cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
      "$1: [REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;&]+/gi, "$1 [REDACTED]")
    .replace(/\b(authorization|proxy-authorization)\s*=\s*(?:Bearer|Basic)\s+[^\s,;&]+/gi, "$1=[REDACTED]")
    .replace(new RegExp(`\\b(${SENSITIVE_KEY_PATTERN})\\b\\s*[:=]\\s*([^\\s,;&]+)`, "gi"), "$1=[REDACTED]");
}
