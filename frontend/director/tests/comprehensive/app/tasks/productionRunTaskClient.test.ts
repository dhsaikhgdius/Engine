import { beforeEach, describe, expect, it, vi } from "vitest";
import { filmRunSchema } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import { FILM_RUN_RECEIPT_CONTRACT } from "../../../../../../packages/protocol/src/filmRunReceipt";

const mocks = vi.hoisted(() => ({
  directorControlPlaneFetch: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: mocks.directorControlPlaneFetch,
}));

import {
  cancelDirectorMonitoredProductionRun,
  listDirectorMonitoredProductionRuns,
} from "../../../../src/comprehensive/app/tasks/productionRunTaskClient";

const now = "2026-08-13T12:00:00.000Z";
const filmRun = filmRunSchema.parse({
  version: 1,
  id: "film-monitor-1234",
  workflow: "idea-to-film",
  status: "running",
  phase: "render",
  input: { idea: "雨夜中的最后一班电车" },
  story: null,
  characters: null,
  scenes: [],
  portraitsReady: false,
  finalVideoPath: null,
  timelinePath: null,
  approvedAt: null,
  error: null,
  events: [],
  createdAt: now,
  updatedAt: now,
});

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directorControlPlaneFetch.mockImplementation(async (path: string) => {
    if (path === "/api/film/runs") {
      return response({ runs: [filmRun] });
    }
    if (path === `/api/film/runs/${filmRun.id}`) {
      return response({
        run: filmRun,
        receipt: {
          contract: FILM_RUN_RECEIPT_CONTRACT,
          runId: filmRun.id,
          workflow: filmRun.workflow,
          status: filmRun.status,
          phase: filmRun.phase,
          terminal: false,
          progress: 0.5,
          sceneCount: 0,
          renderedSceneCount: 0,
          clipCount: 0,
          portraitsReady: false,
          awaitingApproval: false,
          phaseReceipts: [],
          capabilityOmissions: [],
          artifacts: {
            finalVideoPath: null,
            timelinePath: null,
            timelineExport: null,
            storagePresence: { finalVideo: null, timeline: null, sceneVideos: [] },
          },
          timestamps: { createdAt: now, updatedAt: now },
          usage: {
            "film-llm": {
              sample_count: 0,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              total_duration_ms: 0,
              retries: 0,
              failure_count: 0,
            },
            "film-image": {
              sample_count: 0,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              total_duration_ms: 0,
              retries: 0,
              failure_count: 0,
            },
            "film-video": {
              sample_count: 0,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              total_duration_ms: 0,
              retries: 0,
              failure_count: 0,
            },
            "film-tts": {
              sample_count: 0,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              total_duration_ms: 0,
              retries: 0,
              failure_count: 0,
            },
          },
        },
      });
    }
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe("production run task client", () => {
  it("lists film runs with live receipts", async () => {
    await expect(listDirectorMonitoredProductionRuns()).resolves.toEqual([
      {
        source: "film",
        run: filmRun,
        receipt: expect.objectContaining({
          artifacts: expect.objectContaining({
            storagePresence: { finalVideo: null, timeline: null, sceneVideos: [] },
          }),
        }),
      },
    ]);
    expect(mocks.directorControlPlaneFetch).toHaveBeenCalledWith("/api/film/runs", {});
    expect(mocks.directorControlPlaneFetch).toHaveBeenCalledWith(`/api/film/runs/${filmRun.id}`, {});
  });

  it("falls back to the list snapshot when a live receipt fetch fails", async () => {
    mocks.directorControlPlaneFetch.mockImplementation(async (path: string) => {
      if (path === "/api/film/runs") return response({ runs: [filmRun] });
      return response({ error: "offline" }, 503);
    });
    await expect(listDirectorMonitoredProductionRuns()).resolves.toEqual([{ source: "film", run: filmRun }]);
  });

  it("cancels a film run through its endpoint", async () => {
    mocks.directorControlPlaneFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === `/api/film/runs/${filmRun.id}/cancel` && init?.method === "POST") {
        return response({
          run: { ...filmRun, status: "cancelled" },
          receipt: {
            contract: FILM_RUN_RECEIPT_CONTRACT,
            runId: filmRun.id,
            workflow: filmRun.workflow,
            status: "cancelled",
            phase: filmRun.phase,
            terminal: true,
            progress: null,
            sceneCount: 0,
            renderedSceneCount: 0,
            clipCount: 0,
            portraitsReady: false,
            awaitingApproval: false,
            phaseReceipts: [],
            capabilityOmissions: [],
            artifacts: {
              finalVideoPath: null,
              timelinePath: null,
              timelineExport: null,
              storagePresence: { finalVideo: null, timeline: null, sceneVideos: [] },
            },
            timestamps: { createdAt: now, updatedAt: now },
            usage: {
              "film-llm": {
                sample_count: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                total_duration_ms: 0,
                retries: 0,
                failure_count: 0,
              },
              "film-image": {
                sample_count: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                total_duration_ms: 0,
                retries: 0,
                failure_count: 0,
              },
              "film-video": {
                sample_count: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                total_duration_ms: 0,
                retries: 0,
                failure_count: 0,
              },
              "film-tts": {
                sample_count: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                total_duration_ms: 0,
                retries: 0,
                failure_count: 0,
              },
            },
          },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    await expect(cancelDirectorMonitoredProductionRun({ source: "film", run: filmRun })).resolves.toEqual({
      source: "film",
      run: { ...filmRun, status: "cancelled" },
      receipt: expect.objectContaining({ status: "cancelled" }),
    });
    expect(mocks.directorControlPlaneFetch).toHaveBeenLastCalledWith(`/api/film/runs/${filmRun.id}/cancel`, {
      method: "POST",
    });
  });
});
