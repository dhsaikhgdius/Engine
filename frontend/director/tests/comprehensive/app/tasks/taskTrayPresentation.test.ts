import { describe, expect, it } from "vitest";
import type { ProductionJobRecord } from "../../../../../../packages/protocol/src/productionJobProtocol";
import {
  formatTaskRelativeTime,
  taskDisplayName,
  taskFailureReason,
  taskKindLabel,
  taskProgressPercent,
  taskStatusLabel,
} from "../../../../src/comprehensive/app/tasks/taskTrayPresentation";

function stubJob(partial: Record<string, unknown>): ProductionJobRecord {
  return partial as unknown as ProductionJobRecord;
}

describe("taskDisplayName", () => {
  it("uses the prompt for generation kinds and the given name for 3D jobs", () => {
    expect(taskDisplayName(stubJob({ kind: "image.generate", input: { prompt: "夜景" } }))).toBe("夜景");
    expect(taskDisplayName(stubJob({ kind: "model.generate", input: { name: "石狮子" } }))).toBe("石狮子");
    expect(taskDisplayName(stubJob({ kind: "media.transcribe", input: { sourceFileName: "旁白.wav" } }))).toBe(
      "旁白.wav",
    );
  });

  it("derives readable labels for media and DCC kinds", () => {
    expect(taskDisplayName(stubJob({ kind: "media.transcode", input: { targetMimeType: "video/mp4" } }))).toBe(
      "转码为 video/mp4",
    );
    expect(taskDisplayName(stubJob({ kind: "media.proxy", input: { maxWidth: 1280, maxHeight: 720 } }))).toBe(
      "代理 1280×720",
    );
    expect(taskDisplayName(stubJob({ kind: "dcc.export", input: { format: "glb" } }))).toBe("导出为 GLB");
    expect(taskDisplayName(stubJob({ kind: "dcc.import", input: { format: "usd" } }))).toBe("导入 USD 素材");
    expect(taskDisplayName(stubJob({ kind: "dcc.import", input: {} }))).toBe("导入外部素材");
    expect(taskDisplayName(stubJob({ kind: "episode.package", input: { episodeId: "ep-12" } }))).toBe("封装 ep-12");
  });
});

describe("taskFailureReason", () => {
  it("prefers the structured error from the latest attempt", () => {
    const job = stubJob({
      error: "legacy text",
      attempts: [{ error: { code: "x", message: "节点离线", retryable: true } }],
    });
    expect(taskFailureReason(job)).toBe("节点离线");
  });

  it("falls back to the legacy string error and returns null when both are missing", () => {
    expect(taskFailureReason(stubJob({ error: "legacy text", attempts: [{}] }))).toBe("legacy text");
    expect(taskFailureReason(stubJob({ attempts: [{}] }))).toBeNull();
  });
});

describe("labels and formatting", () => {
  it("labels every status and kind in Chinese", () => {
    expect(taskStatusLabel("running")).toBe("进行中");
    expect(taskStatusLabel("outcome_unknown")).toBe("结果待确认");
    expect(taskKindLabel("model.generate")).toBe("3D 生成");
    expect(taskKindLabel("media.transcode")).toBe("媒体转码");
  });

  it("clamps progress to a whole percentage", () => {
    expect(taskProgressPercent(stubJob({ progress: 0.336 }))).toBe(34);
    expect(taskProgressPercent(stubJob({ progress: 1.4 }))).toBe(100);
  });

  it("formats relative times in Chinese buckets", () => {
    const now = Date.parse("2026-08-13T12:00:00.000Z");
    expect(formatTaskRelativeTime("2026-08-13T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatTaskRelativeTime("2026-08-13T11:45:00.000Z", now)).toBe("15 分钟前");
    expect(formatTaskRelativeTime("2026-08-13T09:00:00.000Z", now)).toBe("3 小时前");
    expect(formatTaskRelativeTime("2026-08-10T09:30:00.000Z", now)).toMatch(/^8月10日 \d{2}:\d{2}$/);
    expect(formatTaskRelativeTime("not-a-date", now)).toBe("");
  });
});
