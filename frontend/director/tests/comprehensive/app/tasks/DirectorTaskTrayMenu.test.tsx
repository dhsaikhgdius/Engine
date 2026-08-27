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
