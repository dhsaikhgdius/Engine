import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type {
  ProductionJobRecord,
  ProductionJobStatus,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobReceipt } from "../../../../../../packages/protocol/src/productionJobReceipt";
import { friendlyErrorMessage } from "../../editor/api/friendlyError";
import {
  getDirectorSessionRuntime,
  subscribeDirectorSessionRuntime,
} from "../../editor/session/directorSessionRuntime";
import { notifyDirector } from "../notifications/directorNotificationStore";
import {
  cancelProductionTask,
  fetchProductionJobReceipt,
  listProductionTasks,
  retryProductionTask,
  taskIsFinished,
  taskNeedsReceiptProbe,
  taskSupportsCancel,
  taskSupportsRetry,
} from "./productionTaskClient";
import {
  cancelDirectorMonitoredProductionRun,
  listDirectorMonitoredProductionRuns,
  monitoredProductionRunKey,
  type DirectorMonitoredProductionRun,
} from "./productionRunTaskClient";
import {
  productionRunCanCancel,
  productionRunCountsAsActive,
  productionRunDisplayName,
  productionRunFailureReason,
  productionRunIsFinished,
  productionRunKeepsFastPolling,
  productionRunStatus,
  productionRunTypeLabel,
} from "./productionRunPresentation";
import { taskDisplayName, taskFailureReason, taskIsActive, taskKindLabel } from "./taskTrayPresentation";

/** Polling interval (ms) when at least one task or run is active. */
export const ACTIVE_TASK_POLL_MS = 4_000;
/** Polling interval (ms) when the tray panel is open but nothing is active. */
export const PANEL_OPEN_TASK_POLL_MS = 15_000;
/** Polling interval (ms) when the tray panel is closed and nothing is active. */
export const IDLE_TASK_POLL_MS = 60_000;
const TASK_LIST_LIMIT = 100;
/** Maximum concurrent live receipt probes per tray refresh. */
export const RECEIPT_PROBE_CONCURRENCY = 4;

/** Live receipt probe state for one background job row. */
export type DirectorTaskJobReceiptEntry =
  | { phase: "idle" }
  | { phase: "loading"; cacheKey: string }
  | { phase: "ready"; cacheKey: string; receipt: ProductionJobReceipt }
  | { phase: "error"; cacheKey: string; message: string };

/** The full state of the task tray, including jobs, runs, and UI state. */
export interface DirectorTaskTrayState {
  /** Production jobs from the gateway. */
  jobs: readonly ProductionJobRecord[];
  /** Monitored production runs (multi-agent and film). */
  productionRuns: readonly DirectorMonitoredProductionRun[];
  /** Live normalized receipts keyed by job id (terminal jobs only). */
  jobReceipts: Readonly<Record<string, DirectorTaskJobReceiptEntry>>;
  /** idle until the first successful sync; error keeps the last good jobs list. */
  phase: "idle" | "ready" | "error";
  /** The last sync error message, or null when the last sync succeeded. */
  error: string | null;
  /** Whether the task tray panel is currently open. */
  panelOpen: boolean;
  /** Finished jobs the user cleared from the tray; pruned once the gateway forgets them. */
  dismissedIds: readonly string[];
  /** Finished production runs the user cleared from the tray. */
  dismissedRunKeys: readonly string[];
  /** Jobs with an in-flight cancel/retry action. */
  pendingActionIds: readonly string[];
  /** Production runs with an in-flight cancel action. */
  pendingRunActionKeys: readonly string[];
  /** Timestamp of the last successful sync, or null if never synced. */
  lastSyncAt: number | null;
}

const INITIAL_STATE: DirectorTaskTrayState = {
  jobs: [],
  productionRuns: [],
  jobReceipts: {},
  phase: "idle",
  error: null,
  panelOpen: false,
  dismissedIds: [],
  dismissedRunKeys: [],
  pendingActionIds: [],
  pendingRunActionKeys: [],
  lastSyncAt: null,
};

/** The vanilla Zustand store backing the task tray. */
export const directorTaskTrayStore = createStore<DirectorTaskTrayState>(() => INITIAL_STATE);

let pollingActive = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribeRuntime: (() => void) | null = null;
let lastGatewayState: string | null = null;
let refreshSequence = 0;
/** Suppresses transition notifications for the very first snapshot after (re)start. */
let jobBaselineReady = false;
let runBaselineReady = false;
let receiptProbeSequence = 0;
const knownStatuses = new Map<string, ProductionJobStatus>();
const knownRunStatuses = new Map<string, string>();

function gatewayConnected() {
  return getDirectorSessionRuntime().gateway === "connected";
}

function clearPollTimer() {
  if (pollTimer === null) return;
  clearTimeout(pollTimer);
  pollTimer = null;
}

function scheduleNextPoll() {
  clearPollTimer();
  if (!pollingActive || !gatewayConnected()) return;
  const state = directorTaskTrayStore.getState();
  const hasActiveTask = state.jobs.some(taskIsActive) || state.productionRuns.some(productionRunKeepsFastPolling);
  const interval = hasActiveTask ? ACTIVE_TASK_POLL_MS : state.panelOpen ? PANEL_OPEN_TASK_POLL_MS : IDLE_TASK_POLL_MS;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshDirectorTasks();
  }, interval);
}

function settled(status: ProductionJobStatus) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function announceTaskTransitions(jobs: readonly ProductionJobRecord[]) {
  if (!jobBaselineReady) {
    // The first snapshot only records history; notifying about jobs that
    // finished before this session started would be noise.
    jobs.forEach((job) => knownStatuses.set(job.id, job.status));
    jobBaselineReady = true;
    return;
  }
  for (const job of jobs) {
    const previous = knownStatuses.get(job.id);
    knownStatuses.set(job.id, job.status);
    if (!previous || previous === job.status || settled(previous)) continue;
    if (job.status === "succeeded") {
      notifyDirector({
        key: `director-task-${job.id}`,
        severity: "success",
        title: `任务完成：${taskDisplayName(job)}`,
        detail: `${taskKindLabel(job.kind)}任务已成功结束。`,
      });
    } else if (job.status === "failed") {
      const reason = taskFailureReason(job);
      notifyDirector({
        key: `director-task-${job.id}`,
        severity: "error",
        title: `任务失败：${taskDisplayName(job)}`,
        detail: reason
          ? `${taskKindLabel(job.kind)}任务失败：${reason}`
          : `${taskKindLabel(job.kind)}任务失败，未返回具体原因。`,
      });
    }
  }
  const liveIds = new Set(jobs.map((job) => job.id));
  for (const id of [...knownStatuses.keys()]) {
    if (!liveIds.has(id)) knownStatuses.delete(id);
  }
}

function announceProductionRunTransitions(runs: readonly DirectorMonitoredProductionRun[]) {
  if (!runBaselineReady) {
    runs.forEach((entry) => knownRunStatuses.set(monitoredProductionRunKey(entry), productionRunStatus(entry)));
    runBaselineReady = true;
    return;
  }
  for (const entry of runs) {
    const key = monitoredProductionRunKey(entry);
    const status = productionRunStatus(entry);
    const previous = knownRunStatuses.get(key);
    knownRunStatuses.set(key, status);
    if (!previous || previous === status || ["completed", "failed", "cancelled"].includes(previous)) continue;
    if (status === "completed") {
      notifyDirector({
        key: `director-production-run-${key}`,
        severity: "success",
        title: `生产运行完成：${productionRunDisplayName(entry)}`,
        detail: `${productionRunTypeLabel(entry)}已完成全部阶段。`,
      });
    } else if (status === "failed") {
      notifyDirector({
        key: `director-production-run-${key}`,
        severity: "error",
        title: `生产运行失败：${productionRunDisplayName(entry)}`,
        detail: productionRunFailureReason(entry) ?? `${productionRunTypeLabel(entry)}失败，未返回具体原因。`,
      });
    }
  }
  const liveKeys = new Set(runs.map(monitoredProductionRunKey));
  for (const key of [...knownRunStatuses.keys()]) {
    if (!liveKeys.has(key)) knownRunStatuses.delete(key);
  }
}

function jobReceiptCacheKey(job: ProductionJobRecord): string {
  return `${job.id}:${job.updatedAt}`;
}

function pruneJobReceipts(
  jobReceipts: Readonly<Record<string, DirectorTaskJobReceiptEntry>>,
  jobs: readonly ProductionJobRecord[],
): Readonly<Record<string, DirectorTaskJobReceiptEntry>> {
  const liveIds = new Set(jobs.map((job) => job.id));
  const next: Record<string, DirectorTaskJobReceiptEntry> = {};
  for (const [jobId, entry] of Object.entries(jobReceipts)) {
    if (liveIds.has(jobId)) next[jobId] = entry;
  }
  return next;
}

function receiptEntryIsFresh(entry: DirectorTaskJobReceiptEntry | undefined, cacheKey: string) {
  return entry?.phase === "ready" && entry.cacheKey === cacheKey;
}

function receiptEntryIsLoading(entry: DirectorTaskJobReceiptEntry | undefined, cacheKey: string) {
  return entry?.phase === "loading" && entry.cacheKey === cacheKey;
}

async function probeJobReceipt(job: ProductionJobRecord, sequence: number): Promise<void> {
  const cacheKey = jobReceiptCacheKey(job);
  const existing = directorTaskTrayStore.getState().jobReceipts[job.id];
  if (receiptEntryIsFresh(existing, cacheKey) || receiptEntryIsLoading(existing, cacheKey)) return;

  directorTaskTrayStore.setState((state) => ({
    jobReceipts: {
      ...state.jobReceipts,
      [job.id]: { phase: "loading", cacheKey },
    },
  }));

  try {
    const receipt = await fetchProductionJobReceipt(job.id);
    if (sequence !== receiptProbeSequence) return;
    const current = directorTaskTrayStore.getState().jobs.find((candidate) => candidate.id === job.id);
    if (!current || jobReceiptCacheKey(current) !== cacheKey) return;
    directorTaskTrayStore.setState((state) => ({
      jobReceipts: {
        ...state.jobReceipts,
        [job.id]: { phase: "ready", cacheKey, receipt },
      },
    }));
  } catch (error) {
    if (sequence !== receiptProbeSequence) return;
    const current = directorTaskTrayStore.getState().jobs.find((candidate) => candidate.id === job.id);
    if (!current || jobReceiptCacheKey(current) !== cacheKey) return;
    directorTaskTrayStore.setState((state) => ({
      jobReceipts: {
        ...state.jobReceipts,
        [job.id]: { phase: "error", cacheKey, message: friendlyErrorMessage(error) },
      },
    }));
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  async function runWorker() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      if (current === undefined) continue;
      await worker(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
}

/**
 * Probes live normalized receipts for terminal jobs, reusing cached entries
 * keyed by job id + updatedAt and capping concurrent fetches.
 */
export async function probeTerminalJobReceipts(jobs: readonly ProductionJobRecord[]): Promise<void> {
  if (!pollingActive || !gatewayConnected()) return;
  const sequence = ++receiptProbeSequence;
  const state = directorTaskTrayStore.getState();
  const targets = jobs.filter((job) => {
    if (!taskNeedsReceiptProbe(job)) return false;
    const cacheKey = jobReceiptCacheKey(job);
    const entry = state.jobReceipts[job.id];
    return !receiptEntryIsFresh(entry, cacheKey) && !receiptEntryIsLoading(entry, cacheKey);
  });
  await mapWithConcurrency(targets, RECEIPT_PROBE_CONCURRENCY, (job) => probeJobReceipt(job, sequence));
}

/**
 * Fetches the latest jobs and production runs from the gateway and updates
 * the store. Stale responses (from a superseded polling cycle) are discarded.
 * On error, the store phase becomes "error" but the last good data is preserved.
 */
export async function refreshDirectorTasks(): Promise<void> {
  if (!pollingActive || !gatewayConnected()) return;
  const sequence = ++refreshSequence;
  try {
    const [jobs, productionRuns] = await Promise.all([
      listProductionTasks(TASK_LIST_LIMIT),
      listDirectorMonitoredProductionRuns(),
    ]);
    if (!pollingActive || sequence !== refreshSequence) return;
    announceTaskTransitions(jobs);
    announceProductionRunTransitions(productionRuns);
    directorTaskTrayStore.setState((state) => ({
      jobs,
      productionRuns,
      jobReceipts: pruneJobReceipts(state.jobReceipts, jobs),
      phase: "ready",
      error: null,
      lastSyncAt: Date.now(),
      dismissedIds: state.dismissedIds.filter((id) => jobs.some((job) => job.id === id)),
      dismissedRunKeys: state.dismissedRunKeys.filter((key) =>
        productionRuns.some((entry) => monitoredProductionRunKey(entry) === key),
      ),
    }));
    void probeTerminalJobReceipts(jobs);
  } catch (error) {
    if (!pollingActive || sequence !== refreshSequence) return;
    // A failed poll stays inside the tray panel; the gateway-offline banner
    // already covers the disconnected case, so no notification is raised.
    directorTaskTrayStore.setState({ phase: "error", error: friendlyErrorMessage(error) });
  } finally {
    if (pollingActive && sequence === refreshSequence) scheduleNextPoll();
  }
}

function handleRuntimeChange() {
  if (!pollingActive) return;
  const gateway = getDirectorSessionRuntime().gateway;
  if (gateway === lastGatewayState) return;
  lastGatewayState = gateway;
  if (gateway === "connected") {
    void refreshDirectorTasks();
  } else {
    clearPollTimer();
  }
}

/**
 * Idempotent; returns the matching stop function. Mounted once by the tray menu.
 *
 * Starts the polling loop and subscribes to gateway connectivity changes.
 * When the gateway disconnects, polling pauses; when it reconnects, a fresh
 * sync is triggered.
 *
 * @returns A function that stops polling and cleans up subscriptions.
 */
export function startDirectorTaskTrayPolling(): () => void {
  if (!pollingActive) {
    pollingActive = true;
    lastGatewayState = getDirectorSessionRuntime().gateway;
    unsubscribeRuntime = subscribeDirectorSessionRuntime(handleRuntimeChange);
    if (gatewayConnected()) void refreshDirectorTasks();
  }
  return stopDirectorTaskTrayPolling;
}

/** Stops the polling loop, clears timers, and resets transition baselines. */
export function stopDirectorTaskTrayPolling() {
  if (!pollingActive) return;
  pollingActive = false;
  refreshSequence += 1;
  receiptProbeSequence += 1;
  clearPollTimer();
  unsubscribeRuntime?.();
  unsubscribeRuntime = null;
  lastGatewayState = null;
  // The next start rebuilds its baseline instead of treating everything that
  // changed while unmounted as a fresh transition.
  jobBaselineReady = false;
  runBaselineReady = false;
  knownStatuses.clear();
  knownRunStatuses.clear();
}

/**
 * Toggles the task tray panel open/closed state.
 * Opening the panel triggers an immediate sync; closing it reschedules the
 * next poll at the appropriate interval.
 *
 * @param open - Whether the panel should be open.
 */
export function setDirectorTaskTrayPanelOpen(open: boolean) {
  if (directorTaskTrayStore.getState().panelOpen === open) return;
  directorTaskTrayStore.setState({ panelOpen: open });
  if (open) {
    if (pollingActive && gatewayConnected()) void refreshDirectorTasks();
  } else {
    scheduleNextPoll();
  }
}

function mergeJob(job: ProductionJobRecord) {
  knownStatuses.set(job.id, job.status);
  directorTaskTrayStore.setState((state) => ({
    jobs: state.jobs.some((candidate) => candidate.id === job.id)
      ? state.jobs.map((candidate) => (candidate.id === job.id ? job : candidate))
      : [job, ...state.jobs],
  }));
}

function mergeProductionRun(entry: DirectorMonitoredProductionRun) {
  const key = monitoredProductionRunKey(entry);
  knownRunStatuses.set(key, productionRunStatus(entry));
  directorTaskTrayStore.setState((state) => ({
    productionRuns: state.productionRuns.some((candidate) => monitoredProductionRunKey(candidate) === key)
      ? state.productionRuns.map((candidate) => (monitoredProductionRunKey(candidate) === key ? entry : candidate))
      : [entry, ...state.productionRuns],
  }));
}

function beginPendingAction(jobId: string) {
  directorTaskTrayStore.setState((state) => ({
    pendingActionIds: state.pendingActionIds.includes(jobId)
      ? state.pendingActionIds
      : [...state.pendingActionIds, jobId],
  }));
}

function endPendingAction(jobId: string) {
  directorTaskTrayStore.setState((state) => ({
    pendingActionIds: state.pendingActionIds.filter((id) => id !== jobId),
  }));
}

function beginPendingRunAction(key: string) {
  directorTaskTrayStore.setState((state) => ({
    pendingRunActionKeys: state.pendingRunActionKeys.includes(key)
      ? state.pendingRunActionKeys
      : [...state.pendingRunActionKeys, key],
  }));
}

function endPendingRunAction(key: string) {
  directorTaskTrayStore.setState((state) => ({
    pendingRunActionKeys: state.pendingRunActionKeys.filter((candidate) => candidate !== key),
  }));
}

/**
 * Cancels a production job. No-op when the job is not found or not cancellable.
 * Shows a notification on failure.
 *
 * @param jobId - The id of the job to cancel.
 */
export async function cancelDirectorTask(jobId: string): Promise<void> {
  const job = directorTaskTrayStore.getState().jobs.find((candidate) => candidate.id === jobId);
  if (!job || !taskSupportsCancel(job)) return;
  beginPendingAction(jobId);
  try {
    mergeJob(await cancelProductionTask(job));
  } catch (error) {
    notifyDirector({
      key: `director-task-action-${jobId}`,
      severity: "error",
      title: `取消任务失败：${taskDisplayName(job)}`,
      detail: friendlyErrorMessage(error),
    });
  } finally {
    endPendingAction(jobId);
    scheduleNextPoll();
  }
}

/**
 * Retries a production job. No-op when the job is not found or not retryable.
 * Shows a notification on success or failure.
 *
 * @param jobId - The id of the job to retry.
 */
export async function retryDirectorTask(jobId: string): Promise<void> {
  const job = directorTaskTrayStore.getState().jobs.find((candidate) => candidate.id === jobId);
  if (!job || !taskSupportsRetry(job)) return;
  beginPendingAction(jobId);
  try {
    const retried = await retryProductionTask(job);
    mergeJob(retried);
    notifyDirector({
      key: `director-task-${retried.id}`,
      severity: "info",
      title: `任务已重新排队：${taskDisplayName(retried)}`,
    });
  } catch (error) {
    notifyDirector({
      key: `director-task-action-${jobId}`,
      severity: "error",
      title: `重试任务失败：${taskDisplayName(job)}`,
      detail: friendlyErrorMessage(error),
    });
  } finally {
    endPendingAction(jobId);
    scheduleNextPoll();
  }
}

/**
 * Cancels a monitored production run. No-op when the run is not found or not
 * cancellable. Shows a notification on failure.
 *
 * @param key - The production run key (from `monitoredProductionRunKey`).
 */
export async function cancelDirectorProductionRun(key: string): Promise<void> {
  const entry = directorTaskTrayStore
    .getState()
    .productionRuns.find((candidate) => monitoredProductionRunKey(candidate) === key);
  if (!entry || !productionRunCanCancel(entry)) return;
  beginPendingRunAction(key);
  try {
    mergeProductionRun(await cancelDirectorMonitoredProductionRun(entry));
  } catch (error) {
    notifyDirector({
      key: `director-production-run-action-${key}`,
      severity: "error",
      title: `取消生产运行失败：${productionRunDisplayName(entry)}`,
      detail: friendlyErrorMessage(error),
    });
  } finally {
    endPendingRunAction(key);
    scheduleNextPoll();
  }
}

/**
 * Dismisses a finished job from the tray. No-op when the job is not found
 * or not yet finished.
 *
 * @param jobId - The id of the job to dismiss.
 */
export function dismissDirectorTask(jobId: string) {
  const job = directorTaskTrayStore.getState().jobs.find((candidate) => candidate.id === jobId);
  if (!job || !taskIsFinished(job)) return;
  directorTaskTrayStore.setState((state) => ({
    dismissedIds: state.dismissedIds.includes(jobId) ? state.dismissedIds : [...state.dismissedIds, jobId],
  }));
}

/**
 * Dismisses a finished production run from the tray. No-op when the run is
 * not found or not yet finished.
 *
 * @param key - The production run key (from `monitoredProductionRunKey`).
 */
export function dismissDirectorProductionRun(key: string) {
  const entry = directorTaskTrayStore
    .getState()
    .productionRuns.find((candidate) => monitoredProductionRunKey(candidate) === key);
  if (!entry || !productionRunIsFinished(entry)) return;
  directorTaskTrayStore.setState((state) => ({
    dismissedRunKeys: state.dismissedRunKeys.includes(key) ? state.dismissedRunKeys : [...state.dismissedRunKeys, key],
  }));
}

/** Dismisses all finished jobs and production runs at once. */
export function clearFinishedDirectorTasks() {
  directorTaskTrayStore.setState((state) => {
    const dismissed = new Set(state.dismissedIds);
    state.jobs.filter(taskIsFinished).forEach((job) => dismissed.add(job.id));
    const dismissedRuns = new Set(state.dismissedRunKeys);
    state.productionRuns
      .filter(productionRunIsFinished)
      .forEach((entry) => dismissedRuns.add(monitoredProductionRunKey(entry)));
    return { dismissedIds: [...dismissed], dismissedRunKeys: [...dismissedRuns] };
  });
}

/** React hook that subscribes to a slice of the task tray state. */
export function useDirectorTaskTray<T>(selector: (state: DirectorTaskTrayState) => T): T {
  return useStore(directorTaskTrayStore, selector);
}

/**
 * Stable-order projection of visible jobs used by the panel.
 * Call inside `useMemo`. Active jobs sort first, then by creation time (newest first).
 * Capped at 50 entries.
 *
 * @param jobs - All production jobs from the store.
 * @param dismissedIds - The set of dismissed job ids.
 * @returns The filtered, sorted list of visible jobs.
 */
export function visibleDirectorTasks(
  jobs: readonly ProductionJobRecord[],
  dismissedIds: readonly string[],
): ProductionJobRecord[] {
  const dismissed = new Set(dismissedIds);
  return jobs
    .filter((job) => !dismissed.has(job.id))
    .sort((left, right) => {
      const activeDelta = Number(taskIsActive(right)) - Number(taskIsActive(left));
      if (activeDelta !== 0) return activeDelta;
      return right.createdAt.localeCompare(left.createdAt);
    })
    .slice(0, 50);
}

/**
 * Stable-order projection of visible production runs used by the panel.
 * Active runs sort first, then by update time (newest first). Capped at 30 entries.
 *
 * @param runs - All production runs from the store.
 * @param dismissedRunKeys - The set of dismissed run keys.
 * @returns The filtered, sorted list of visible runs.
 */
export function visibleDirectorProductionRuns(
  runs: readonly DirectorMonitoredProductionRun[],
  dismissedRunKeys: readonly string[],
): DirectorMonitoredProductionRun[] {
  const dismissed = new Set(dismissedRunKeys);
  return [...runs]
    .filter((entry) => !dismissed.has(monitoredProductionRunKey(entry)))
    .sort((left, right) => {
      const activeDelta = Number(productionRunCountsAsActive(right)) - Number(productionRunCountsAsActive(left));
      if (activeDelta !== 0) return activeDelta;
      return right.run.updatedAt.localeCompare(left.run.updatedAt);
    })
    .slice(0, 30);
}

/**
 * Counts active jobs and production runs for the top-bar badge.
 *
 * @param state - The current task tray state.
 * @returns The total number of active items.
 */
export function countActiveDirectorTasks(state: DirectorTaskTrayState): number {
  return (
    state.jobs.reduce((count, job) => count + (taskIsActive(job) ? 1 : 0), 0) +
    state.productionRuns.reduce((count, entry) => count + (productionRunCountsAsActive(entry) ? 1 : 0), 0)
  );
}

/** Test hook: clears module-level polling state alongside the store. */
export function __resetDirectorTaskTrayForTests() {
  stopDirectorTaskTrayPolling();
  refreshSequence += 1;
  receiptProbeSequence += 1;
  directorTaskTrayStore.setState(INITIAL_STATE, true);
}
