import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  productionJobRecordSchema,
  type ProductionJobRecord,
} from "../../../../../../packages/protocol/src/productionJobProtocol";
import { projectProductionJobReceipt } from "../../../../../../packages/protocol/src/productionJobReceipt";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import { DirectorTaskTrayMenu } from "../../../../src/comprehensive/app/tasks/DirectorTaskTrayMenu";
import {
  __resetDirectorTaskTrayForTests,
  directorTaskTrayStore,
} from "../../../../src/comprehensive/app/tasks/directorTaskTrayStore";
import type { DirectorMonitoredProductionRun } from "../../../../src/comprehensive/app/tasks/productionRunTaskClient";
import {
  resetDirectorSessionRuntime,
  updateDirectorSessionRuntime,
} from "../../../../src/comprehensive/editor/session/directorSessionRuntime";

vi.mock("../../../../src/comprehensive/app/tasks/directorTaskTrayStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/app/tasks/directorTaskTrayStore")>();
  return {
    ...actual,
    startDirectorTaskTrayPolling: vi.fn(() => () => {}),
    setDirectorTaskTrayPanelOpen: vi.fn(),
  };
});

function makeSucceededJob(id: string, prompt: string): ProductionJobRecord {
  const createdAt = "2026-08-13T10:00:00.000Z";
  return productionJobRecordSchema.parse({
    contractVersion: 1,
    id,
    kind: "image.generate",
    status: "succeeded",
    progress: 1,
    inputFingerprint: "fp-test",
    idempotencyKey: `key-${id}`,
    input: { prompt },
    attempts: [
      {
        id: `${id}-attempt-1`,
        number: 1,
        status: "succeeded",
        provider: "test.provider",
        inputFingerprint: "fp-test",
        idempotencyKey: `key-${id}`,
        sourceRevisions: {},
        timestamps: { createdAt, startedAt: createdAt, finishedAt: createdAt },
        artifacts: [],
      },
    ],
    createdAt,
    updatedAt: createdAt,
    artifacts: [],
  });
}

function makeFailedJob(
  id: string,
  prompt: string,
  error: { code: string; message: string; retryable: boolean },
): ProductionJobRecord {
  const createdAt = "2026-08-13T10:00:00.000Z";
  return productionJobRecordSchema.parse({
    contractVersion: 1,
    id,
    kind: "image.generate",
    status: "failed",
    progress: 0,
    inputFingerprint: "fp-test",
    idempotencyKey: `key-${id}`,
    input: { prompt },
    error: error.message,
    attempts: [
      {
        id: `${id}-attempt-1`,
        number: 1,
        status: "failed",
        provider: "test.provider",
        inputFingerprint: "fp-test",
        idempotencyKey: `key-${id}`,
        sourceRevisions: {},
        timestamps: { createdAt, startedAt: createdAt, finishedAt: createdAt },
        error,
        artifacts: [],
      },
    ],
    createdAt,
    updatedAt: createdAt,
    artifacts: [],
  });
}

function setTrayProductionRuns(runs: DirectorMonitoredProductionRun[]) {
  directorTaskTrayStore.setState({
    jobs: [],
    productionRuns: runs,
    jobReceipts: {},
    phase: "ready",
    error: null,
    panelOpen: false,
    dismissedIds: [],
    dismissedRunKeys: [],
    pendingActionIds: [],
    pendingRunActionKeys: [],
    lastSyncAt: Date.now(),
  });
}

function setTrayJobs(jobs: ProductionJobRecord[]) {
  directorTaskTrayStore.setState({
    jobs,
    productionRuns: [],
    jobReceipts: {},
    phase: "ready",
    error: null,
    panelOpen: false,
    dismissedIds: [],
    dismissedRunKeys: [],
    pendingActionIds: [],
    pendingRunActionKeys: [],
    lastSyncAt: Date.now(),
  });
}

function renderTray() {
  return render(
    <LanguageProvider>
      <DirectorTaskTrayMenu />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  __resetDirectorTaskTrayForTests();
  resetDirectorSessionRuntime();
  updateDirectorSessionRuntime({ gateway: "connected" });
});

afterEach(() => {
  cleanup();
  __resetDirectorTaskTrayForTests();
  resetDirectorSessionRuntime();
});

describe("DirectorTaskTrayMenu", () => {
  it("renders absent artifact warnings only after a probed receipt is ready", () => {
    const job = makeSucceededJob("job-done", "赛博朋克城市夜景");
    const artifact = {
      id: "art-absent",
      attemptId: "job-done-attempt-1",
      role: "primary",
      mimeType: "image/png",
      fileName: "output.png",
      sha256: "c".repeat(64),
      bytes: 512,
      createdAt: job.createdAt,
    };
    const receipt = projectProductionJobReceipt(
      productionJobRecordSchema.parse({
        ...job,
        artifacts: [artifact],
        attempts: [{ ...job.attempts[0]!, artifacts: [artifact] }],
      }),
      { artifactStoragePresence: new Map([["art-absent", "absent"]]) },
    );

    directorTaskTrayStore.setState({
      jobs: [job],
      productionRuns: [],
      jobReceipts: { "job-done": { phase: "ready", cacheKey: "job-done:2026-08-13T10:00:00.000Z", receipt } },
      phase: "ready",
      error: null,
      panelOpen: false,
      dismissedIds: [],
      dismissedRunKeys: [],
      pendingActionIds: [],
      pendingRunActionKeys: [],
      lastSyncAt: Date.now(),
    });

    renderTray();
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const tray = screen.getByRole("dialog", { name: "任务中心" });
    expect(within(tray).getByText("赛博朋克城市夜景")).toBeTruthy();
    const warning = within(tray).getByLabelText("产物字节已不可用 (GC)：primary · art-absent");
    expect(warning.textContent).toContain("产物字节已不可用 (GC)：primary · art-absent");
  });

  it("surfaces the structured attempt error code with its zh label and a retryable hint", () => {
    setTrayJobs([
      makeFailedJob("job-timeout", "转码超时的任务", {
        code: "media_transcode_timeout",
        message: "The media transcode timeout budget was exhausted",
        retryable: true,
      }),
    ]);

    renderTray();
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const tray = screen.getByRole("dialog", { name: "任务中心" });
    const codeRow = within(tray).getByLabelText("失败错误码");
    expect(within(codeRow).getByText("media_transcode_timeout").tagName).toBe("CODE");
    expect(codeRow.textContent).toContain("media_transcode_timeout");
    expect(codeRow.textContent).toContain("· 媒体转码超时");
    expect(within(codeRow).getByText("可重试")).toBeTruthy();
    expect(within(tray).getByText("The media transcode timeout budget was exhausted")).toBeTruthy();
  });

  it("shows unknown machine codes raw without inventing a label or a retryable hint", () => {
    setTrayJobs([
      makeFailedJob("job-unknown", "未知错误码的任务", {
        code: "provider_http_500",
        message: "provider unreachable",
        retryable: false,
      }),
    ]);

    renderTray();
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const tray = screen.getByRole("dialog", { name: "任务中心" });
    const codeRow = within(tray).getByLabelText("失败错误码");
    expect(within(codeRow).getByText("provider_http_500").tagName).toBe("CODE");
    expect(codeRow.textContent).not.toContain("·");
    expect(within(codeRow).queryByText("可重试")).toBeNull();
    expect(within(tray).getByText("provider unreachable")).toBeTruthy();
  });

  it("does not render an error-code row for a failed job with only a legacy string error", () => {
    const legacyJob = productionJobRecordSchema.parse({
      ...makeFailedJob("job-legacy", "历史错误的任务", {
        code: "job_failed",
        message: "placeholder",
        retryable: false,
      }),
      error: "renderer unavailable",
      attempts: [
        {
          id: "job-legacy-attempt-1",
          number: 1,
          status: "failed",
          provider: "test.provider",
          inputFingerprint: "fp-test",
          idempotencyKey: "key-job-legacy",
          sourceRevisions: {},
          timestamps: {
            createdAt: "2026-08-13T10:00:00.000Z",
            startedAt: "2026-08-13T10:00:00.000Z",
            finishedAt: "2026-08-13T10:00:00.000Z",
          },
          artifacts: [],
        },
      ],
    });
    setTrayJobs([legacyJob]);

    renderTray();
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const tray = screen.getByRole("dialog", { name: "任务中心" });
    expect(within(tray).queryByLabelText("失败错误码")).toBeNull();
    expect(within(tray).getByText("renderer unavailable")).toBeTruthy();
  });

  it("surfaces structured film-run errorCode with its zh label on failed production runs", () => {
    setTrayProductionRuns([
      {
        source: "film",
        run: {
          id: "film-run-failed",
          workflow: "idea-to-film",
          status: "failed",
          phase: "render",
          input: { idea: "雨夜电车" },
          error: "gateway restarted during render",
          errorCode: "film_run_interrupted",
          createdAt: "2026-08-13T10:00:00.000Z",
          updatedAt: "2026-08-13T10:00:00.000Z",
        },
      },
    ]);

    renderTray();
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const tray = screen.getByRole("dialog", { name: "任务中心" });
    const codeRow = within(tray).getByLabelText("失败错误码");
    expect(within(codeRow).getByText("film_run_interrupted").tagName).toBe("CODE");
    expect(codeRow.textContent).toContain("· 运行被中断");
    expect(within(tray).getByText("gateway restarted during render")).toBeTruthy();
  });

  it("does not show an absent-artifact warning while the receipt is still loading", () => {
    const job = makeSucceededJob("job-loading", "加载中的任务");
    directorTaskTrayStore.setState({
      jobs: [job],
      productionRuns: [],
      jobReceipts: { "job-loading": { phase: "loading", cacheKey: "job-loading:2026-08-13T10:00:00.000Z" } },
      phase: "ready",
      error: null,
      panelOpen: false,
      dismissedIds: [],
      dismissedRunKeys: [],
      pendingActionIds: [],
      pendingRunActionKeys: [],
      lastSyncAt: Date.now(),
    });

    renderTray();
    fireEvent.click(screen.getByRole("button", { name: "任务中心" }));
    const tray = screen.getByRole("dialog", { name: "任务中心" });
    expect(within(tray).queryByText(/产物字节已不可用/)).toBeNull();
  });
});
