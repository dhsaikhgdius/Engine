import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
  type ProductionJobStatus,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { filmRunSchema, type FilmRun } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import { resetDirectorSessionRuntime, updateDirectorSessionRuntime } from "../../../../src/comprehensive/editor/session/directorSessionRuntime";
import { clearDirectorNotifications, getDirectorNotifications } from "../../../../src/comprehensive/app/notifications/directorNotificationStore";

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: (path: string, init?: RequestInit) => fetch(`http://gateway.test${path}`, init),
  directorControlPlaneUrl: (path: string) => `http://gateway.test${path}`,
}));

import {
  ACTIVE_TASK_POLL_MS,
  IDLE_TASK_POLL_MS,
  PANEL_OPEN_TASK_POLL_MS,
  __resetDirectorTaskTrayForTests,
  cancelDirectorProductionRun,
  cancelDirectorTask,
  clearFinishedDirectorTasks,
  countActiveDirectorTasks,
  directorTaskTrayStore,
  retryDirectorTask,
  setDirectorTaskTrayPanelOpen,
  startDirectorTaskTrayPolling,
  visibleDirectorTasks,
} from "../../../../src/comprehensive/app/tasks/directorTaskTrayStore";

type JobOverrides = {
  id: string;
  status: ProductionJobStatus;
  kind?: "image.generate" | "model.generate" | "media.transcribe" | "canvas.image";
  createdAt?: string;
  progress?: number;
  message?: string;
  errorMessage?: string;
};

function jobInput(kind: NonNullable<JobOverrides["kind"]>) {
  if (kind === "model.generate") {
    return { mode: "text-to-3d", providerId: "meshy", name: "石狮子", prompt: "一只石狮子" };
  }
  if (kind === "media.transcribe") {
    return {
      sourceMediaId: "media-1",
      sourceSha256: "a".repeat(64),
      sourceMimeType: "audio/wav",
      sourceFileName: "旁白.wav",
      model: "whisper-1",
    };
  }
  if (kind === "canvas.image") return { nodeId: "node-1", prompt: "画布测试" };
  return { prompt: "赛博朋克城市夜景" };
}

function makeJob(overrides: JobOverrides): ProductionJobRecord {
  const kind = overrides.kind ?? "image.generate";
  const status = overrides.status;
  const createdAt = overrides.createdAt ?? "2026-08-13T10:00:00.000Z";
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  const failure = overrides.errorMessage ?? "节点崩溃";
  return productionJobRecordSchema.parse({
    contractVersion: 1,
    id: overrides.id,
    kind,
    status,
    progress: overrides.progress ?? (status === "succeeded" ? 1 : 0.4),
    inputFingerprint: "fp-test",
    idempotencyKey: `key-${overrides.id}`,
    input: jobInput(kind),
    attempts: [
      {
        id: `${overrides.id}-attempt-1`,
        number: 1,
        status,
        provider: "test.provider",
        inputFingerprint: "fp-test",
        idempotencyKey: `key-${overrides.id}`,
        sourceRevisions: {},
        timestamps: {
          createdAt,
          ...(status === "queued" ? {} : { startedAt: createdAt }),
          ...(status === "outcome_unknown" || status === "reconciling" ? { outcomeUnknownAt: createdAt } : {}),
          ...(status === "reconciling" ? { reconciliationStartedAt: createdAt } : {}),
          ...(terminal ? { finishedAt: createdAt } : {}),
        },
        ...(status === "failed" ? { error: { code: "job_failed", message: failure, retryable: true } } : {}),
        artifacts: [],
      },
    ],
    createdAt,
    updatedAt: createdAt,
    ...(overrides.message ? { message: overrides.message } : {}),
    artifacts: [],
    ...(status === "failed" ? { error: failure } : {}),
  });
}

function makeFilmRun(status: FilmRun["status"]): FilmRun {
  return filmRunSchema.parse({
    version: 1,
    id: "film-tray-1234",
    workflow: "idea-to-film",
    status,
    phase: status === "completed" ? "completed" : "render",
    input: { idea: "雨夜中的最后一班电车" },
    story: null,
    characters: null,
    scenes: [],
    portraitsReady: false,
    finalVideoPath: status === "completed" ? "final.mp4" : null,
    timelinePath: null,
    approvedAt: null,
    error: status === "failed" ? "渲染供应商不可用" : null,
    events: [],
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
  });
}

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
const jsonOk = (body: unknown): MockResponse => ({ ok: true, status: 200, json: async () => body });
const jsonFail = (status: number, body: unknown = {}): MockResponse => ({
  ok: false,
  status,
  json: async () => body,
});

let jobsPayload: ProductionJobRecord[] = [];
let filmRunsPayload: FilmRun[] = [];
let listHandler: () => MockResponse;
let actionHandler: (collection: string, jobId: string, action: string) => MockResponse;
let runActionHandler: (source: "film", runId: string) => MockResponse;
const requests: Array<{ url: string; method: string }> = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<MockResponse> => {
  const url = String(input);
  const method = init?.method ?? "GET";
  requests.push({ url, method });
  if (method === "GET" && url.includes("/api/production-jobs")) return listHandler();
  if (method === "GET" && url.includes("/api/film/runs")) return jsonOk({ runs: filmRunsPayload });
  const runAction = url.match(/\/api\/film\/runs\/([^/]+)\/cancel$/);
  if (method === "POST" && runAction) {
    return runActionHandler("film", decodeURIComponent(runAction[1]!));
  }
  const action = url.match(
    /\/api\/(generation\/jobs|generation\/3d\/jobs|transcription\/jobs)\/([^/]+)\/(cancel|retry)$/,
  );
  if (method === "POST" && action) return actionHandler(action[1]!, decodeURIComponent(action[2]!), action[3]!);
  return jsonFail(404, { message: `unexpected request ${method} ${url}` });
});

function listRequestCount() {
  return requests.filter((request) => request.method === "GET" && request.url.includes("/api/production-jobs")).length;
}

async function flushAsync() {
  await vi.advanceTimersByTimeAsync(0);
}

async function startConnectedTray(jobs: ProductionJobRecord[]) {
  jobsPayload = jobs;
  updateDirectorSessionRuntime({ gateway: "connected" });
  startDirectorTaskTrayPolling();
  await flushAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  __resetDirectorTaskTrayForTests();
  resetDirectorSessionRuntime();
  clearDirectorNotifications();
  fetchMock.mockClear();
  requests.length = 0;
  jobsPayload = [];
  filmRunsPayload = [];
  listHandler = () => jsonOk({ jobs: jobsPayload });
  actionHandler = () => jsonFail(500, { message: "no action handler installed" });
  runActionHandler = () => jsonFail(500, { message: "no run action handler installed" });
});

afterEach(() => {
  __resetDirectorTaskTrayForTests();
  resetDirectorSessionRuntime();
  clearDirectorNotifications();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("polling cadence", () => {
  it("does not poll while the gateway is disconnected, then syncs once it connects", async () => {
    startDirectorTaskTrayPolling();
    await vi.advanceTimersByTimeAsync(IDLE_TASK_POLL_MS * 2);
    expect(listRequestCount()).toBe(0);

    jobsPayload = [makeJob({ id: "job-a", status: "running" })];
    updateDirectorSessionRuntime({ gateway: "connected" });
    await flushAsync();
    expect(listRequestCount()).toBe(1);
    expect(directorTaskTrayStore.getState().jobs).toHaveLength(1);
    expect(directorTaskTrayStore.getState().phase).toBe("ready");
  });

  it("polls every 4 seconds while a task is active", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "running" })]);
    expect(listRequestCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS);
    expect(listRequestCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS);
    expect(listRequestCount()).toBe(3);
  });

  it("drops to the slow cadence when nothing is active and the panel is closed", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "succeeded" })]);
    expect(listRequestCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS * 3);
    expect(listRequestCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(IDLE_TASK_POLL_MS - ACTIVE_TASK_POLL_MS * 3);
    expect(listRequestCount()).toBe(2);
  });

  it("refreshes immediately when the panel opens and keeps a medium cadence while it stays open", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "succeeded" })]);
    expect(listRequestCount()).toBe(1);

    setDirectorTaskTrayPanelOpen(true);
    await flushAsync();
    expect(listRequestCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(PANEL_OPEN_TASK_POLL_MS);
    expect(listRequestCount()).toBe(3);
  });

  it("pauses while the gateway drops and resumes with a fresh sync on reconnect", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "running" })]);
    expect(listRequestCount()).toBe(1);

    updateDirectorSessionRuntime({ gateway: "disconnected" });
    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS * 5);
    expect(listRequestCount()).toBe(1);

    updateDirectorSessionRuntime({ gateway: "connected" });
    await flushAsync();
    expect(listRequestCount()).toBe(2);
  });

  it("records list failures in the panel state without raising a notification", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "running" })]);
    expect(directorTaskTrayStore.getState().jobs).toHaveLength(1);

    listHandler = () => jsonFail(500, { message: "boom" });
    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS);
    const state = directorTaskTrayStore.getState();
    expect(state.phase).toBe("error");
    expect(state.error).toBeTruthy();
    // The previous good snapshot stays visible.
    expect(state.jobs).toHaveLength(1);
    expect(getDirectorNotifications()).toHaveLength(0);
  });
});

describe("transition notifications", () => {
  it("does not notify for the first snapshot, then notifies success and failure transitions", async () => {
    await startConnectedTray([
      makeJob({ id: "job-done", status: "succeeded" }),
      makeJob({ id: "job-a", status: "running" }),
      makeJob({ id: "job-b", status: "running" }),
    ]);
    expect(getDirectorNotifications()).toHaveLength(0);

    jobsPayload = [
      makeJob({ id: "job-done", status: "succeeded" }),
      makeJob({ id: "job-a", status: "succeeded" }),
      makeJob({ id: "job-b", status: "failed", errorMessage: "ComfyUI 节点离线" }),
    ];
    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS);

    const notifications = getDirectorNotifications();
    expect(notifications).toHaveLength(2);
    expect(notifications.map((notification) => notification.severity).sort()).toEqual(["error", "success"]);
    const success = notifications.find((notification) => notification.severity === "success");
    expect(success?.title).toBe("任务完成：赛博朋克城市夜景");
    const failure = notifications.find((notification) => notification.severity === "error");
    expect(failure?.title).toBe("任务失败：赛博朋克城市夜景");
    expect(failure?.detail).toContain("ComfyUI 节点离线");
  });

  it("does not repeat a notification for a status that stays terminal", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "running" })]);
    jobsPayload = [makeJob({ id: "job-a", status: "succeeded" })];
    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS);
    expect(getDirectorNotifications()).toHaveLength(1);
    clearDirectorNotifications();

    await vi.advanceTimersByTimeAsync(IDLE_TASK_POLL_MS);
    expect(getDirectorNotifications()).toHaveLength(0);
  });

  it("tracks film runs and announces their terminal transitions", async () => {
    filmRunsPayload = [makeFilmRun("running")];
    await startConnectedTray([]);

    expect(directorTaskTrayStore.getState().productionRuns).toHaveLength(1);
    expect(countActiveDirectorTasks(directorTaskTrayStore.getState())).toBe(1);
    expect(getDirectorNotifications()).toHaveLength(0);

    filmRunsPayload = [makeFilmRun("failed")];
    await vi.advanceTimersByTimeAsync(ACTIVE_TASK_POLL_MS);

    const notifications = getDirectorNotifications();
    expect(notifications.map((notification) => notification.title)).toEqual(["生产运行失败：雨夜中的最后一班电车"]);
    expect(notifications.find((notification) => notification.severity === "error")?.detail).toContain(
      "渲染供应商不可用",
    );
  });
});

describe("actions", () => {
  it("cancels a generation job through the generation route and merges the result silently", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "running" })]);
    actionHandler = (collection, jobId, action) => {
      expect(collection).toBe("generation/jobs");
      expect(jobId).toBe("job-a");
      expect(action).toBe("cancel");
      return jsonOk({ job: makeJob({ id: "job-a", status: "cancelled" }) });
    };

    await cancelDirectorTask("job-a");
    expect(directorTaskTrayStore.getState().jobs[0]?.status).toBe("cancelled");
    expect(getDirectorNotifications()).toHaveLength(0);

    // The next poll re-reads the cancelled job without announcing a transition.
    jobsPayload = [makeJob({ id: "job-a", status: "cancelled" })];
    await vi.advanceTimersByTimeAsync(IDLE_TASK_POLL_MS);
    expect(getDirectorNotifications()).toHaveLength(0);
  });

  it("routes cancel and retry by job kind", async () => {
    const model = makeJob({ id: "job-3d", status: "running", kind: "model.generate" });
    const transcription = makeJob({ id: "job-stt", status: "failed", kind: "media.transcribe" });
    await startConnectedTray([model, transcription]);

    const actions: Array<{ collection: string; jobId: string; action: string }> = [];
    actionHandler = (collection, jobId, action) => {
      actions.push({ collection, jobId, action });
      if (action === "cancel")
        return jsonOk({ job: makeJob({ id: jobId, status: "cancelled", kind: "model.generate" }) });
      return jsonOk({ job: makeJob({ id: `${jobId}-retry`, status: "queued", kind: "media.transcribe" }) });
    };

    await cancelDirectorTask("job-3d");
    await retryDirectorTask("job-stt");
    expect(actions).toEqual([
      { collection: "generation/3d/jobs", jobId: "job-3d", action: "cancel" },
      { collection: "transcription/jobs", jobId: "job-stt", action: "retry" },
    ]);
    const jobIds = directorTaskTrayStore.getState().jobs.map((job) => job.id);
    expect(jobIds).toContain("job-stt-retry");
    const retryNotice = getDirectorNotifications().find((notification) => notification.severity === "info");
    expect(retryNotice?.title).toBe("任务已重新排队：旁白.wav");
  });

  it("surfaces a cancel failure as an error notification", async () => {
    await startConnectedTray([makeJob({ id: "job-a", status: "running" })]);
    actionHandler = () => jsonFail(409, { message: "任务已经开始出图，无法取消" });

    await cancelDirectorTask("job-a");
    const notifications = getDirectorNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.severity).toBe("error");
    expect(notifications[0]?.title).toBe("取消任务失败：赛博朋克城市夜景");
    expect(notifications[0]?.detail).toContain("无法取消");
    // The job keeps its previous status until the next poll says otherwise.
    expect(directorTaskTrayStore.getState().jobs[0]?.status).toBe("running");
  });

  it("ignores cancel/retry requests for kinds without gateway actions", async () => {
    await startConnectedTray([makeJob({ id: "job-canvas", status: "running", kind: "canvas.image" })]);
    await cancelDirectorTask("job-canvas");
    await retryDirectorTask("job-canvas");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("cancels a production run through its source endpoint", async () => {
    filmRunsPayload = [makeFilmRun("running")];
    await startConnectedTray([]);
    runActionHandler = (source, runId) => {
      expect(source).toBe("film");
      expect(runId).toBe("film-tray-1234");
      return jsonOk({ run: makeFilmRun("cancelled") });
    };

    await cancelDirectorProductionRun("film:film-tray-1234");
    expect(directorTaskTrayStore.getState().productionRuns[0]?.run.status).toBe("cancelled");
    expect(getDirectorNotifications()).toHaveLength(0);
  });
});

describe("tray projection", () => {
  it("clears finished tasks locally while keeping active ones", async () => {
    await startConnectedTray([
      makeJob({ id: "job-run", status: "running", createdAt: "2026-08-13T10:03:00.000Z" }),
      makeJob({ id: "job-old", status: "succeeded", createdAt: "2026-08-13T10:01:00.000Z" }),
      makeJob({ id: "job-fail", status: "failed", createdAt: "2026-08-13T10:02:00.000Z" }),
    ]);

    clearFinishedDirectorTasks();
    const state = directorTaskTrayStore.getState();
    expect(visibleDirectorTasks(state.jobs, state.dismissedIds).map((job) => job.id)).toEqual(["job-run"]);
    expect(countActiveDirectorTasks(state)).toBe(1);
  });

  it("sorts active tasks first, newest first inside each group", async () => {
    await startConnectedTray([
      makeJob({ id: "job-done-new", status: "succeeded", createdAt: "2026-08-13T10:05:00.000Z" }),
      makeJob({ id: "job-run-old", status: "running", createdAt: "2026-08-13T10:01:00.000Z" }),
      makeJob({ id: "job-queued-new", status: "queued", createdAt: "2026-08-13T10:04:00.000Z" }),
      makeJob({ id: "job-done-old", status: "failed", createdAt: "2026-08-13T10:00:00.000Z" }),
    ]);
    const state = directorTaskTrayStore.getState();
    expect(visibleDirectorTasks(state.jobs, state.dismissedIds).map((job) => job.id)).toEqual([
      "job-queued-new",
      "job-run-old",
      "job-done-new",
      "job-done-old",
    ]);
  });
});
