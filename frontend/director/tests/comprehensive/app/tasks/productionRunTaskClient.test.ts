import { beforeEach, describe, expect, it, vi } from "vitest";
import { filmRunSchema } from "../../../../../../packages/protocol/src/filmPipelineProtocol";

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
  mocks.directorControlPlaneFetch.mockResolvedValue(response({ runs: [filmRun] }));
});

describe("production run task client", () => {
  it("lists film runs", async () => {
    await expect(listDirectorMonitoredProductionRuns()).resolves.toEqual([{ source: "film", run: filmRun }]);
    expect(mocks.directorControlPlaneFetch).toHaveBeenCalledWith("/api/film/runs", {});
  });

  it("cancels a film run through its endpoint", async () => {
    mocks.directorControlPlaneFetch.mockResolvedValueOnce(response({ run: { ...filmRun, status: "cancelled" } }));
    await cancelDirectorMonitoredProductionRun({ source: "film", run: filmRun });
    expect(mocks.directorControlPlaneFetch).toHaveBeenLastCalledWith(`/api/film/runs/${filmRun.id}/cancel`, {
      method: "POST",
    });
  });
});
