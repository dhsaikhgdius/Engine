/**
 * The fetch implementation type — used for dependency injection in tests.
 */
export type FetchImplementation = typeof fetch;

/**
 * An HTTP-level error from a model driver request.
 *
 * Carries the provider id, HTTP status, and whether the error is retryable.
 */
export class ModelDriverHttpError extends Error {
  readonly name = "ModelDriverHttpError";

  /**
   * @param providerId - The provider id.
   * @param status - The HTTP status code (0 for network errors).
   * @param retryable - Whether the request may succeed on retry.
   * @param message - The error message (secrets already redacted).
   */
  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A response-level error from a model driver — the HTTP request succeeded
 * but the response body was invalid or unexpected.
 */
export class ModelDriverResponseError extends Error {
  readonly name = "ModelDriverResponseError";

  /**
   * @param providerId - The provider id.
   * @param message - The error message (secrets already redacted).
   */
  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Options for HTTP fetch operations within the model driver layer.
 */
type FetchJsonOptions = {
  fetch: FetchImplementation;
  url: string;
  init: RequestInit;
  signal?: AbortSignal;
  providerId: string;
  /** Secrets to redact from error messages before logging. */
  secrets?: readonly (string | undefined)[];
  /** Maximum number of retries for retryable errors (default 2). */
  maxRetries?: number;
  /** Called once per retry attempt, so callers can meter retry counts. */
  onRetry?: () => void;
};

/**
 * Redacts secrets and auth headers from a string for safe logging.
 *
 * Replaces exact secret values and strips `authorization` and `x-api-key`
 * header values. Truncates to 2,000 characters.
 *
 * @param value - The string to redact.
 * @param secrets - Known secret values to redact.
 * @returns The redacted string.
 */
export function redactModelDriverText(value: string, secrets: readonly (string | undefined)[] = []) {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

/**
 * Computes the retry delay from a response's `retry-after` header or
 * exponential backoff.
 *
 * Capped at 30 seconds for header-based delays and 8 seconds for backoff.
 */
function retryDelay(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(30_000, Math.max(0, timestamp - Date.now()));
  }
  return Math.min(8_000, 250 * 2 ** attempt);
}

/**
 * Waits for a given number of milliseconds, respecting an AbortSignal.
 */
function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * HTTP fetch with bounded 429/5xx/network retries and secret-safe failures.
 *
 * Resolves with the successful response before its body has been consumed, so
 * callers can either read it as JSON or stream it as server-sent events.
 *
 * @param options - The fetch options.
 * @returns The successful HTTP response.
 * @throws {@link ModelDriverHttpError} When all retries are exhausted or the
 *         error is not retryable.
 */
export async function fetchModelResponse(options: FetchJsonOptions): Promise<Response> {
  const maxRetries = Math.max(0, Math.min(8, options.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    options.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await options.fetch(options.url, { ...options.init, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (attempt < maxRetries) {
        options.onRetry?.();
        await wait(Math.min(8_000, 250 * 2 ** attempt), options.signal);
        continue;
      }
      const detail = redactModelDriverText(error instanceof Error ? error.message : String(error), options.secrets);
      throw new ModelDriverHttpError(
        options.providerId,
        0,
        true,
        `${options.providerId} transport failed${detail ? `: ${detail}` : ""}`,
      );
    }

    if (response.ok) return response;

    const body = await response.text().catch(() => "");
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxRetries) {
      options.onRetry?.();
      await wait(retryDelay(response, attempt), options.signal);
      continue;
    }
    const detail = redactModelDriverText(body, options.secrets);
    throw new ModelDriverHttpError(
      options.providerId,
      response.status,
      retryable,
      `${options.providerId} request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  throw new ModelDriverHttpError(options.providerId, 0, true, `${options.providerId} request exhausted retries`);
}

/**
 * Fetches a JSON response from a model provider.
 *
 * Convenience wrapper around {@link fetchModelResponse} that parses the
 * response body as JSON.
 *
 * @param options - The fetch options.
 * @returns The parsed JSON body.
 * @throws {@link ModelDriverHttpError} When the HTTP request fails.
 * @throws {@link ModelDriverResponseError} When the response is not valid JSON.
 */
export async function fetchModelJson(options: FetchJsonOptions): Promise<unknown> {
  const response = await fetchModelResponse(options);
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ModelDriverResponseError(options.providerId, `${options.providerId} returned invalid JSON`);
  }
}

/**
 * Returns whether an HTTP response is a server-sent event stream.
 *
 * @param response - The HTTP response.
 * @returns `true` when the content-type indicates `text/event-stream`.
 */
export function isEventStreamResponse(response: Response) {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * A single server-sent event with an optional event name and joined data.
 */
export type ServerSentEvent = { event: string | null; data: string };

/**
 * Minimal SSE reader: yields each event's name and joined data payload.
 *
 * Handles the standard SSE line format: `event:`, `data:`, and blank-line
 * delimiters. The reader body is cancelled on completion or error.
 *
 * @param response - The event-stream response.
 * @param providerId - The provider id for error messages.
 * @yields Parsed server-sent events.
 */
export async function* readServerSentEvents(response: Response, providerId: string): AsyncGenerator<ServerSentEvent> {
  if (!response.body) {
    throw new ModelDriverResponseError(providerId, `${providerId} returned an event stream without a body`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let eventName: string | null = null;
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffered.indexOf("\n")) >= 0) {
        const rawLine = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") {
          if (dataLines.length) yield { event: eventName, data: dataLines.join("\n") };
          eventName = null;
          dataLines = [];
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).replace(/^ /, "");
        }
      }
      if (done) {
        if (dataLines.length) yield { event: eventName, data: dataLines.join("\n") };
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Creates a {@link ModelDriverResponseError} from Zod validation issues.
 *
 * Only the first 12 issues are included in the message; secrets are
 * redacted from the detail text.
 *
 * @param providerId - The provider id.
 * @param issues - The Zod validation issues.
 * @param secrets - Secrets to redact.
 * @returns A response validation error.
 */
export function responseValidationError(
  providerId: string,
  issues: readonly { path: PropertyKey[]; message: string }[],
  secrets: readonly (string | undefined)[] = [],
) {
  const detail = issues
    .slice(0, 12)
    .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");
  return new ModelDriverResponseError(
    providerId,
    redactModelDriverText(`${providerId} returned an invalid response${detail ? ` (${detail})` : ""}`, secrets),
  );
}
