/** The browser command family discriminator used in timeout and routing logic. */
export type BrowserCommandFamily = "workbench" | "creative";

const WORKBENCH_MUTATIONS = new Set(["patch", "author", "correct", "replace_project", "undo"]);
const CREATIVE_MUTATIONS = new Set(["execute", "execute_batch"]);

/**
 * Returns whether the given operation in the given family is a mutation
 * (as opposed to a read-only command). Mutations that time out have an
 * unknown outcome and must be reconciled, not retried blindly.
 */
export function browserCommandCanMutate(family: BrowserCommandFamily, operation: string) {
  return family === "workbench" ? WORKBENCH_MUTATIONS.has(operation) : CREATIVE_MUTATIONS.has(operation);
}

/**
 * A gateway timeout is not a target-disconnect. For asynchronous reads and
 * captures the browser receives a cancellation signal, so retrying is safe.
 * A synchronous mutation may already have committed before the browser can
 * process that cancellation; callers must observe/reconcile it instead of
 * reporting the target as unavailable or blindly issuing a new mutation.
 */
export class BrowserCommandTimeoutError extends Error {
  readonly kind = "browser_command_timeout";
  readonly code: "command_timeout" | "outcome_unknown";

  constructor(
    readonly family: BrowserCommandFamily,
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    const outcomeUnknown = browserCommandCanMutate(family, operation);
    super(
      outcomeUnknown
        ? `${family} mutation "${operation}" did not acknowledge within ${timeoutMs} ms; its outcome is unknown.`
        : `${family} command "${operation}" timed out after ${timeoutMs} ms and was cancelled.`,
    );
    this.name = "BrowserCommandTimeoutError";
    this.code = outcomeUnknown ? "outcome_unknown" : "command_timeout";
  }
}

/** Type guard for {@link BrowserCommandTimeoutError}. */
export function isBrowserCommandTimeoutError(error: unknown): error is BrowserCommandTimeoutError {
  return error instanceof BrowserCommandTimeoutError;
}
