import { describe, expect, it } from "vitest";
import type { ProductionJobRecord } from "../../../../../../packages/protocol/src/productionJobProtocol";
import {
  formatTaskRelativeTime,
  formatTaskAbsentArtifactLine,
  TASK_ERROR_CODE_LABELS,
  taskAbsentArtifactAriaLabel,
  taskAbsentArtifactSummaries,
  taskDisplayName,
  taskErrorCodeLabel,
  taskFailureDetail,
  taskFailureReason,
  taskKindLabel,
  taskProgressPercent,
  taskStatusLabel,
} from "../../../../src/comprehensive/app/tasks/taskTrayPresentation";
import { projectProductionJobReceipt } from "../../../../../../packages/protocol/src/productionJobReceipt";

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

describe("taskErrorCodeLabel", () => {
  it("labels the media transcode/proxy executor codes in Chinese", () => {
    expect(taskErrorCodeLabel("ffmpeg_not_configured")).toBe("FFmpeg 未配置");
    expect(taskErrorCodeLabel("ffprobe_not_configured")).toBe("ffprobe 未配置");
    expect(taskErrorCodeLabel("ffmpeg_failed")).toBe("FFmpeg 执行失败");
    expect(taskErrorCodeLabel("ffprobe_failed")).toBe("ffprobe 探测失败");
    expect(taskErrorCodeLabel("unsupported_target")).toBe("目标格式不支持");
    expect(taskErrorCodeLabel("unsupported_job_input")).toBe("任务输入不支持");
    expect(taskErrorCodeLabel("unsupported_source")).toBe("源媒体不支持");
    expect(taskErrorCodeLabel("media_transcode_timeout")).toBe("媒体转码超时");
    expect(taskErrorCodeLabel("media_transcode_failed")).toBe("媒体转码失败");
    expect(taskErrorCodeLabel("staged_input_missing")).toBe("暂存输入缺失");
    expect(taskErrorCodeLabel("staged_input_invalid")).toBe("暂存输入校验失败");
  });

  it("labels the store and reconcile codes in Chinese", () => {
    expect(taskErrorCodeLabel("outcome_unknown")).toBe("结果未知");
    expect(taskErrorCodeLabel("executor_restart_outcome_unknown")).toBe("网关重启后结果未知");
    expect(taskErrorCodeLabel("job_failed")).toBe("任务失败");
    expect(taskErrorCodeLabel("provider_timeout")).toBe("提供方超时");
    expect(taskErrorCodeLabel("reconciled_not_accepted")).toBe("核对确认未被提供方接受");
    expect(taskErrorCodeLabel("local_executor_failed")).toBe("本地执行器失败");
  });

  it("returns null for unknown machine codes instead of inventing a label", () => {
    expect(taskErrorCodeLabel("provider_http_500")).toBeNull();
    expect(taskErrorCodeLabel("")).toBeNull();
  });

  it("keeps every label a non-empty zh-CN string", () => {
    for (const [code, label] of Object.entries(TASK_ERROR_CODE_LABELS)) {
      expect(code).toMatch(/^[a-z0-9_]+$/);
      expect(label.trim()).not.toBe("");
    }
  });
});

describe("taskFailureDetail", () => {
  it("projects the structured attempt error with code, label, and retryable", () => {
    const job = stubJob({
      error: "legacy text",
      attempts: [
        { error: { code: "media_transcode_timeout", message: "The transcode timed out", retryable: true } },
      ],
    });
    expect(taskFailureDetail(job)).toEqual({
      code: "media_transcode_timeout",
      codeLabel: "媒体转码超时",
      retryable: true,
      message: "The transcode timed out",
    });
  });

  it("keeps unknown machine codes raw without a label", () => {
    const job = stubJob({
      attempts: [{ error: { code: "provider_http_500", message: "provider unreachable", retryable: false } }],
    });
    expect(taskFailureDetail(job)).toEqual({
      code: "provider_http_500",
      codeLabel: null,
      retryable: false,
      message: "provider unreachable",
    });
  });

  it("falls back to a message-only detail for legacy string errors", () => {
    expect(taskFailureDetail(stubJob({ error: " legacy text ", attempts: [{}] }))).toEqual({
      code: null,
      codeLabel: null,
      retryable: null,
      message: "legacy text",
    });
    expect(taskFailureDetail(stubJob({ attempts: [{}] }))).toBeNull();
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

describe("taskAbsentArtifactSummaries", () => {
  it("summarizes only artifacts with storagePresence absent", () => {
    const artifact = {
      id: "art-absent",
      attemptId: "job-a-attempt-1",
      role: "preview",
      mimeType: "image/png",
      fileName: "preview.png",
      sha256: "a".repeat(64),
      bytes: 128,
      createdAt: "2026-08-13T10:00:00.000Z",
    };
    const job = stubJob({
      id: "job-a",
      kind: "image.generate",
      status: "succeeded",
      input: { prompt: "x" },
      attempts: [
        {
          id: "job-a-attempt-1",
          number: 1,
          status: "succeeded",
          provider: "test",
          timestamps: {
            createdAt: "2026-08-13T10:00:00.000Z",
            startedAt: "2026-08-13T10:00:00.000Z",
            finishedAt: "2026-08-13T10:00:00.000Z",
          },
          artifacts: [artifact],
        },
      ],
      artifacts: [artifact],
      createdAt: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T10:00:00.000Z",
      idempotencyKey: "key-a",
      inputFingerprint: "fp-a",
      progress: 1,
    });
    const receipt = projectProductionJobReceipt(job, {
      artifactStoragePresence: new Map([["art-absent", "absent"]]),
    });
    const summaries = taskAbsentArtifactSummaries(receipt);
    expect(summaries).toEqual([
      {
        id: "art-absent",
        role: "preview",
        label: "产物字节已不可用 (GC)：preview · art-absent",
      },
    ]);
    expect(formatTaskAbsentArtifactLine({ id: "art-absent", role: "preview" })).toBe(
      "产物字节已不可用 (GC)：preview · art-absent",
    );
    expect(taskAbsentArtifactAriaLabel(summaries)).toBe("产物字节已不可用 (GC)：preview · art-absent");
  });
});
