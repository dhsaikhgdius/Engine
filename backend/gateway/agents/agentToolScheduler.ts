import { directorAgentToolExecutionMode } from "./agentToolRegistry";

export type ScheduledDirectorToolCall = {
  name: string;
  arguments: unknown;
};

export interface DirectorAgentToolSchedulingMetric {
  index: number;
  tool: string;
  executionMode: "parallel" | "exclusive";
  harnessQueueWaitMs: number;
  targetQueueWaitMs?: number;
  queueWaitMs: number;
  executionMs: number;
  elapsedMs: number;
  windowSize: number;
  concurrencyLimit: number;
}

export type DirectorAgentToolExecutionMode = "parallel" | "exclusive";

/** Internal HTTP header carrying target-lease wait time back to the Harness. */
export const DIRECTOR_TARGET_QUEUE_WAIT_HEADER = "x-director-target-queue-ms";

export interface DirectorAgentTargetLease {
  queueWaitMs: number;
  release(): void;
}

type PendingTargetLease = {
  mode: DirectorAgentToolExecutionMode;
  queuedAt: number;
  resolve: (lease: DirectorAgentTargetLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

type TargetQueueState = {
  activeReaders: number;
  writerActive: boolean;
  queue: PendingTargetLease[];
};

/** Maximum number of independent read calls executed at once. */
export const DEFAULT_AGENT_TOOL_CONCURRENCY = 4;

let configuredToolConcurrency = DEFAULT_AGENT_TOOL_CONCURRENCY;

/** Current process-wide parallel-read bound, including plugin-settings overrides. */
export function directorAgentToolConcurrency() {
  return configuredToolConcurrency;
}

/**
 * Updates the process-wide parallel-read bound used by the hosted tool loop.
 *
 * @param value - Integer from 1 through 16.
 */
export function setDirectorAgentToolConcurrency(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new TypeError("Tool concurrency must be an integer from 1 through 16");
  }
  configuredToolConcurrency = value;
}

/** Move target-lock waiting out of execution and into the combined queue total. */
export function applyDirectorTargetQueueTiming(
  metric: DirectorAgentToolSchedulingMetric,
  targetQueueWaitMs: number | undefined,
): DirectorAgentToolSchedulingMetric {
  if (targetQueueWaitMs === undefined) return metric;
  const targetWait = Math.max(0, targetQueueWaitMs);
  return {
    ...metric,
    targetQueueWaitMs: targetWait,
    queueWaitMs: metric.harnessQueueWaitMs + targetWait,
    executionMs: Math.max(0, metric.executionMs - targetWait),
  };
}

/**
 * Process-wide reader/writer scheduler keyed by an exact Director target.
 * Calls keep arrival order across mutation barriers while independent targets
 * remain isolated.
 */
export class DirectorAgentTargetScheduler {
  private readonly targets = new Map<string, TargetQueueState>();
  private readConcurrency: number;

  constructor(readConcurrency = DEFAULT_AGENT_TOOL_CONCURRENCY) {
    if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1) {
      throw new TypeError("Target read concurrency must be positive");
    }
    this.readConcurrency = readConcurrency;
  }

  /**
   * Changes the per-target read window without dropping in-flight leases.
   *
   * @param readConcurrency - Integer from 1 through 16.
   */
  configureReadConcurrency(readConcurrency: number) {
    if (!Number.isSafeInteger(readConcurrency) || readConcurrency < 1 || readConcurrency > 16) {
      throw new TypeError("Target read concurrency must be an integer from 1 through 16");
    }
    this.readConcurrency = readConcurrency;
  }

  acquire(
    targetKey: string,
    mode: DirectorAgentToolExecutionMode,
    signal?: AbortSignal,
  ): Promise<DirectorAgentTargetLease> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    const state = this.targets.get(targetKey) ?? { activeReaders: 0, writerActive: false, queue: [] };
    this.targets.set(targetKey, state);

    return new Promise((resolve, reject) => {
      const pending: PendingTargetLease = { mode, queuedAt: performance.now(), resolve, reject, signal };
      if (signal) {
        pending.abort = () => {
          const index = state.queue.indexOf(pending);
          if (index < 0) return;
          state.queue.splice(index, 1);
          reject(this.abortError(signal));
          this.drain(targetKey, state);
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      state.queue.push(pending);
      this.drain(targetKey, state);
    });
  }

  private drain(targetKey: string, state: TargetQueueState) {
    if (state.writerActive) return;
    const next = state.queue[0];
    if (!next) {
      if (!state.activeReaders && this.targets.get(targetKey) === state) this.targets.delete(targetKey);
      return;
    }
    if (next.mode === "exclusive") {
      if (state.activeReaders) return;
      state.queue.shift();
      state.writerActive = true;
      this.start(targetKey, state, next);
      return;
    }
    while (state.queue[0]?.mode === "parallel" && !state.writerActive && state.activeReaders < this.readConcurrency) {
      const reader = state.queue.shift()!;
      state.activeReaders += 1;
      this.start(targetKey, state, reader);
    }
  }

  private start(targetKey: string, state: TargetQueueState, pending: PendingTargetLease) {
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    let released = false;
    pending.resolve({
      queueWaitMs: Math.max(0, performance.now() - pending.queuedAt),
      release: () => {
        if (released) return;
        released = true;
        if (pending.mode === "exclusive") state.writerActive = false;
        else state.activeReaders -= 1;
        this.drain(targetKey, state);
      },
    });
  }

  private abortError(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Tool call cancelled", "AbortError");
  }
}

async function executeParallelWindow<TCall extends ScheduledDirectorToolCall, TResult>(
  calls: readonly TCall[],
  offset: number,
  results: TResult[],
  execute: (call: TCall, index: number) => Promise<TResult>,
  concurrency: number,
) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, calls.length) }, async () => {
    while (cursor < calls.length) {
      const localIndex = cursor;
      cursor += 1;
      results[offset + localIndex] = await execute(calls[localIndex], offset + localIndex);
    }
  });
  await Promise.all(workers);
}

/**
 * Executes tool calls in model order with bounded parallel read windows.
 * Exclusive calls flush the preceding read window and block the following one.
 */
export async function executeDirectorAgentToolCalls<TCall extends ScheduledDirectorToolCall, TResult>(
  calls: readonly TCall[],
  execute: (call: TCall, index: number) => Promise<TResult>,
  concurrency = DEFAULT_AGENT_TOOL_CONCURRENCY,
  onMetric?: (metric: DirectorAgentToolSchedulingMetric) => void,
): Promise<TResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("Tool concurrency must be positive");
  const results = new Array<TResult>(calls.length);
  const scheduleStartedAt = performance.now();
  const executeMeasured = async (
    call: TCall,
    callIndex: number,
    executionMode: "parallel" | "exclusive",
    windowSize: number,
  ) => {
    const startedAt = performance.now();
    try {
      return await execute(call, callIndex);
    } finally {
      const completedAt = performance.now();
      const harnessQueueWaitMs = Math.max(0, startedAt - scheduleStartedAt);
      onMetric?.({
        index: callIndex,
        tool: call.name,
        executionMode,
        harnessQueueWaitMs,
        queueWaitMs: harnessQueueWaitMs,
        executionMs: Math.max(0, completedAt - startedAt),
        elapsedMs: Math.max(0, completedAt - scheduleStartedAt),
        windowSize,
        concurrencyLimit: concurrency,
      });
    }
  };
  let index = 0;
  while (index < calls.length) {
    const call = calls[index];
    if (directorAgentToolExecutionMode(call.name, call.arguments) === "exclusive") {
      results[index] = await executeMeasured(call, index, "exclusive", 1);
      index += 1;
      continue;
    }
    const start = index;
    while (
      index < calls.length &&
      directorAgentToolExecutionMode(calls[index].name, calls[index].arguments) === "parallel"
    ) {
      index += 1;
    }
    const windowSize = index - start;
    await executeParallelWindow(
      calls.slice(start, index),
      start,
      results,
      (parallelCall, callIndex) => executeMeasured(parallelCall, callIndex, "parallel", windowSize),
      concurrency,
    );
  }
  return results;
}
