import { describe, expect, it } from "vitest";
import { filmRunSchema, type FilmRun } from "../src/filmPipelineProtocol";
import {
  FILM_RUN_RECEIPT_CONTRACT,
  filmRunReceiptSchema,
  isTerminalFilmRunStatus,
  projectFilmRunReceipt,
} from "../src/filmRunReceipt";

function makeRun(overrides: Record<string, unknown> = {}): FilmRun {
  const now = "2026-08-13T00:00:00.000Z";
  return filmRunSchema.parse({
    version: 1,
    id: "film-receipt-test-0001",
    workflow: "idea-to-film",
    status: "running",
    phase: "render",
    input: { idea: "海边灯塔看守人的一夜" },
    scenes: [
      { idx: 0, script: "Scene 0", clipCount: 3, videoPath: "scene_0/scene_video.mp4" },
      { idx: 1, script: "Scene 1", clipCount: 0, videoPath: null },
    ],
    portraitsReady: true,
    events: [{ at: now, stage: "render", message: "Rendering scene 1" }],
    phaseReceipts: [{ phase: "plan-scenes", startedAt: now, finishedAt: now }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe("filmRunReceipt", () => {
  it("classifies terminal statuses like the production job receipt", () => {
    expect(isTerminalFilmRunStatus("completed")).toBe(true);
    expect(isTerminalFilmRunStatus("failed")).toBe(true);
    expect(isTerminalFilmRunStatus("cancelled")).toBe(true);
    expect(isTerminalFilmRunStatus("queued")).toBe(false);
    expect(isTerminalFilmRunStatus("running")).toBe(false);
    expect(isTerminalFilmRunStatus("waiting_approval")).toBe(false);
  });

  it("projects a deterministic contract-tagged receipt from the run document", () => {
    const run = makeRun();
    const receipt = projectFilmRunReceipt(run);
    expect(receipt).toEqual({
      contract: FILM_RUN_RECEIPT_CONTRACT,
      runId: run.id,
      workflow: "idea-to-film",
      status: "running",
      phase: "render",
      terminal: false,
      progress: 5 / 7 + 0.5 / 7,
      sceneCount: 2,
      renderedSceneCount: 1,
      clipCount: 3,
      portraitsReady: true,
      awaitingApproval: false,
      phaseReceipts: run.phaseReceipts,
      artifacts: { finalVideoPath: null, timelinePath: null },
      timestamps: { createdAt: run.createdAt, updatedAt: run.updatedAt },
    });
    // Deterministic: the same document always yields the same receipt.
    expect(projectFilmRunReceipt(makeRun())).toEqual(receipt);
  });

  it("reports the review gate and approval timestamps honestly", () => {
    const waiting = projectFilmRunReceipt(makeRun({ status: "waiting_approval", phase: "await-approval" }));
    expect(waiting.awaitingApproval).toBe(true);
    expect(waiting.terminal).toBe(false);

    const approved = projectFilmRunReceipt(
      makeRun({
        status: "waiting_approval",
        phase: "await-approval",
        approvedAt: "2026-08-13T00:05:00.000Z",
      }),
    );
    expect(approved.awaitingApproval).toBe(false);
    expect(approved.timestamps.approvedAt).toBe("2026-08-13T00:05:00.000Z");
  });

  it("carries the stable error code and falls back for legacy uncoded errors", () => {
    const coded = projectFilmRunReceipt(
      makeRun({ status: "failed", error: "provider unavailable", errorCode: "film_provider_error" }),
    );
    expect(coded.terminal).toBe(true);
    expect(coded.error).toEqual({ code: "film_provider_error", message: "provider unavailable" });

    // Legacy documents that stored only free text keep a stable code.
    const legacy = projectFilmRunReceipt(makeRun({ status: "failed", error: "old failure", errorCode: null }));
    expect(legacy.error).toEqual({ code: "film_run_error", message: "old failure" });

    const healthy = projectFilmRunReceipt(makeRun());
    expect(healthy.error).toBeUndefined();
  });

  it("exposes final artifacts once assembly and timeline export finish", () => {
    const receipt = projectFilmRunReceipt(
      makeRun({
        status: "completed",
        phase: "completed",
        finalVideoPath: "/runs/final_video.mp4",
        timelinePath: "/runs/timeline.otio",
      }),
    );
    expect(receipt.terminal).toBe(true);
    expect(receipt.progress).toBe(1);
    expect(receipt.artifacts).toEqual({ finalVideoPath: "/runs/final_video.mp4", timelinePath: "/runs/timeline.otio" });
  });

  it("rejects receipts whose invariants are violated", () => {
    const receipt = projectFilmRunReceipt(makeRun());
    expect(filmRunReceiptSchema.safeParse({ ...receipt, terminal: true }).success).toBe(false);
    expect(filmRunReceiptSchema.safeParse({ ...receipt, renderedSceneCount: 3 }).success).toBe(false);
  });
});
