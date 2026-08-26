import { describe, expect, it } from "vitest";
import { filmRunProgress } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import type { DirectorMonitoredProductionRun } from "../../../../src/comprehensive/app/tasks/productionRunTaskClient";
import {
  formatProductionRunUsageLine,
  productionRunCountsAsActive,
  productionRunDisplayName,
  productionRunProgressPercent,
  productionRunStage,
  productionRunStatusLabel,
  productionRunTypeLabel,
  productionRunUsageLines,
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

  it("projects durable per-scope usage lines and formats tray copy", () => {
    const run = entry({
      source: "film",
      run: {
        id: "film-usage",
        workflow: "idea-to-film",
        status: "running",
        phase: "render",
        input: { idea: "雨夜电车" },
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
        error: null,
        usage: {
          "film-llm": {
            sample_count: 2,
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            total_duration_ms: 4200,
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
            sample_count: 3,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            total_duration_ms: 91_000,
            retries: 1,
            failure_count: 1,
          },
          "film-tts": {
            sample_count: 5,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            total_duration_ms: 6_000,
            retries: 0,
            failure_count: 0,
          },
        },
      },
    });
    const lines = productionRunUsageLines(run);
    expect(lines.map((line) => line.scope)).toEqual(["film-llm", "film-video", "film-tts"]);
    expect(formatProductionRunUsageLine(lines[0]!)).toBe("规划 LLM 150 tokens · 4s");
    expect(formatProductionRunUsageLine(lines[1]!)).toBe("视频生成 3 次 · 91s · 失败 1");
    expect(formatProductionRunUsageLine(lines[2]!)).toBe("语音合成 5 次 · 6s");
    expect(productionRunUsageLines(entry({ source: "film", run: { ...run.run, usage: undefined } }))).toEqual([]);
  });
});
