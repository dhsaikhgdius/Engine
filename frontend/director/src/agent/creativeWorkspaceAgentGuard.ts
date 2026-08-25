/**
 * Reentrancy guard between the creative workspace store and the agent execute path.
 *
 * The creative agent contract implements its operations by calling
 * directorWorkspaceStore mutators, and those same mutators route human edits
 * through the shared agent execute path. This depth counter breaks the cycle:
 * while an agent operation is executing, store mutators apply locally instead
 * of re-entering the contract.
 *
 * Kept dependency-free so both sides can import it without widening the
 * existing store/contract import cycle.
 */

let executionDepth = 0;

/** True while a creative workspace agent operation is executing on this task. */
export function isCreativeWorkspaceAgentExecuting(): boolean {
  return executionDepth > 0;
}

/** Run one synchronous agent execution with the reentrancy guard held. */
export function runWithCreativeWorkspaceAgentExecution<T>(run: () => T): T {
  executionDepth += 1;
  try {
    return run();
  } finally {
    executionDepth -= 1;
  }
}
