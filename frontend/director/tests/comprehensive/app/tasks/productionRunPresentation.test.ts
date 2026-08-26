import { describe, expect, it } from "vitest";
import { filmRunProgress } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import type { DirectorMonitoredProductionRun } from "../../../../src/comprehensive/app/tasks/productionRunTaskClient";
import {
  productionRunCountsAsActive,
  productionRunDisplayName,
  productionRunProgressPercent,
  productionRunStage,
  productionRunStatusLabel,
  productionRunTypeLabel,
} from "../../../../src/comprehensive/app/tasks/productionRunPresentation";

function entry(value: unknown): DirectorMonitoredProductionRun {
  return value as DirectorMonitoredProductionRun;
}

describe("production run task presentation", () => {
  it("maps film phases to readable stage progress", () => {
    const run = entry({
      source: "film",
      run: {
        id: "film-test",
        workflow: "idea-to-film",
        status: "running",
        phase: "render",
        input: { idea: "雨夜电车" },
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
        error: null,
      },
    });
    expect(productionRunTypeLabel(run)).toBe("电影管线");
    expect(productionRunDisplayName(run)).toBe("雨夜电车");
    expect(productionRunStage(run)).toEqual({ label: "渲染镜头", current: 6, total: 8 });
    expect(productionRunProgressPercent(run)).toBe(Math.round((5 / 7) * 100));
    expect(productionRunStatusLabel(run)).toBe("进行中");
    expect(productionRunCountsAsActive(run)).toBe(true);
  });

  it("advances tray percent from durable scene completion when filmRunProgress does", () => {
    const midRender = entry({
      source: "film",
      run: {
        id: "film-mid",
        workflow: "idea-to-film",
        status: "running",
        phase: "render",
        scenes: [
          { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: "/a.mp4" },
          { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: null },
        ],
        input: { idea: "雨夜电车" },
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
        error: null,
      },
    });
    // On main without intra-phase progress this stays at the phase floor; once
    // filmRunProgress reads scenes, the tray follows the same helper.
    expect(productionRunProgressPercent(midRender)).toBe(Math.round((filmRunProgress(midRender.run) ?? 0) * 100));
  });
});
