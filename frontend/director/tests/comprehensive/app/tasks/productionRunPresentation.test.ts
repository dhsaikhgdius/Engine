import { describe, expect, it } from "vitest";
import { filmRunProgress } from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import type { DirectorMonitoredProductionRun } from "../../../../src/comprehensive/app/tasks/productionRunTaskClient";
import {
  formatProductionRunUsageLine,
  formatProductionRunAbsentArtifactWarnings,
  formatProductionRunCapabilityOmissionWarnings,
  formatProductionRunTimelineOmittedShotWarnings,
  productionRunAbsentArtifactWarnings,
  productionRunArtifactPresencePending,
  productionRunCapabilityOmissionWarnings,
  productionRunCountsAsActive,
  productionRunDisplayName,
  productionRunErrorCodeLabel,
  productionRunFailureDetail,
  productionRunIntraPhaseDetail,
  productionRunLatestMessage,
  productionRunProgressPercent,
  productionRunShowsLatestMessage,
  productionRunStage,
  productionRunStatusLabel,
  productionRunTimelineOmittedShotWarnings,
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
    expect(productionRunIntraPhaseDetail(midRender)).toBe("已渲染 1/2 场景");
  });

  it("projects latest durable event messages and intra-phase planning detail", () => {
    const planning = entry({
      source: "film",
      run: {
        id: "film-plan",
        workflow: "idea-to-film",
        status: "running",
        phase: "plan-scenes",
        scenes: [
          { storyboard: [], shotSpecs: [], cameraPlan: [], videoPath: null },
          { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: null },
        ],
        events: [{ at: "2026-08-13T12:00:00.000Z", stage: "plan-scenes", message: "正在规划第 2 镜" }],
        input: { idea: "雨夜电车" },
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
        error: null,
      },
    });
    expect(productionRunLatestMessage(planning)).toBe("正在规划第 2 镜");
    expect(productionRunShowsLatestMessage(planning)).toBe(true);
    expect(productionRunIntraPhaseDetail(planning)).toBe("已规划 1/2 场景");

    const completed = entry({
      source: "film",
      run: { ...planning.run, status: "completed", phase: "completed", events: planning.run.events },
    });
    expect(productionRunShowsLatestMessage(completed)).toBe(false);
    expect(productionRunIntraPhaseDetail(completed)).toBeNull();
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

  it("formats absent artifact warnings from live storagePresence", () => {
    expect(
      formatProductionRunAbsentArtifactWarnings({
        finalVideo: "absent",
        timeline: "present",
        sceneVideos: [
          { sceneIdx: 0, presence: "absent" },
          { sceneIdx: 2, presence: "present" },
        ],
      }),
    ).toEqual([
      { key: "finalVideo", message: "成片文件已不在存储中" },
      { key: "scene-0", message: "场景 1 渲染视频已不在存储中" },
    ]);

    const withReceipt = entry({
      source: "film",
      run: {
        id: "film-artifacts",
        workflow: "idea-to-film",
        status: "completed",
        phase: "completed",
        finalVideoPath: "/runs/final.mp4",
        timelinePath: "/runs/timeline.otio",
        input: { idea: "雨夜电车" },
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
        error: null,
      },
      receipt: {
        contract: "director-film-run-receipt-v1",
        runId: "film-artifacts",
        workflow: "idea-to-film",
        status: "completed",
        phase: "completed",
        terminal: true,
        progress: 1,
        sceneCount: 1,
        renderedSceneCount: 1,
        clipCount: 1,
        portraitsReady: false,
        awaitingApproval: false,
        phaseReceipts: [],
        capabilityOmissions: [],
        artifacts: {
          finalVideoPath: "/runs/final.mp4",
          timelinePath: "/runs/timeline.otio",
          timelineExport: null,
          storagePresence: {
            finalVideo: "absent",
            timeline: "absent",
            sceneVideos: [{ sceneIdx: 0, presence: "absent" }],
          },
        },
        timestamps: {
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
        },
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
    expect(productionRunAbsentArtifactWarnings(withReceipt).map((warning) => warning.message)).toEqual([
      "成片文件已不在存储中",
      "时间线文件已不在存储中",
      "场景 1 渲染视频已不在存储中",
    ]);
    expect(productionRunArtifactPresencePending(withReceipt)).toBe(false);
    expect(productionRunArtifactPresencePending(entry({ source: "film", run: withReceipt.run }))).toBe(true);
    expect(
      productionRunArtifactPresencePending(
        entry({
          source: "film",
          run: {
            ...withReceipt.run,
            status: "running",
            phase: "develop-story",
            finalVideoPath: null,
            timelinePath: null,
            scenes: [],
          },
        }),
      ),
    ).toBe(false);
  });

  it("formats capability omission and timeline omitted-shot lines from live receipts only", () => {
    expect(
      formatProductionRunCapabilityOmissionWarnings([
        {
          capability: "dialogue_audio",
          code: "tts_unconfigured",
          sceneIdx: null,
          reason: "no TTS",
          at: "2026-08-13T12:00:00.000Z",
        },
        {
          capability: "stage_anchors",
          code: "anchor_hook_unavailable",
          sceneIdx: null,
          reason: "no hook",
          at: "2026-08-13T12:00:00.000Z",
        },
        {
          capability: "stage_anchors",
          code: "anchor_resolution_failed",
          sceneIdx: 1,
          reason: "resolve failed",
          at: "2026-08-13T12:01:00.000Z",
        },
      ]).map((warning) => warning.message),
    ).toEqual([
      "对白配音已跳过：未配置 TTS",
      "舞台锚点已跳过：无工作台执行通道",
      "场景 2 舞台锚点解析失败，已跳过白盒锚定",
    ]);

    expect(
      formatProductionRunTimelineOmittedShotWarnings([
        { sceneIdx: 0, shotIdx: 2, code: "clip_missing", reason: "clip bytes were missing" },
      ]),
    ).toEqual([
      {
        key: "timeline-omit-0-2-clip_missing-0",
        message: "时间线省略：场景 1 镜头 3 缺少成片片段",
      },
    ]);

    const withOmissions = entry({
      source: "film",
      run: {
        id: "film-omissions",
        workflow: "idea-to-film",
        status: "completed",
        phase: "completed",
        finalVideoPath: "/runs/final.mp4",
        timelinePath: "/runs/timeline.otio",
        input: { idea: "雨夜电车", enableAudio: true, autoStageAnchors: true },
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
        error: null,
        capabilityOmissions: [
          {
            capability: "dialogue_audio",
            code: "tts_unconfigured",
            sceneIdx: null,
            reason: "no TTS",
            at: "2026-08-13T12:00:00.000Z",
          },
        ],
      },
      receipt: {
        contract: "director-film-run-receipt-v1",
        runId: "film-omissions",
        workflow: "idea-to-film",
        status: "completed",
        phase: "completed",
        terminal: true,
        progress: 1,
        sceneCount: 1,
        renderedSceneCount: 1,
        clipCount: 1,
        portraitsReady: false,
        awaitingApproval: false,
        phaseReceipts: [],
        capabilityOmissions: [
          {
            capability: "dialogue_audio",
            code: "tts_unconfigured",
            sceneIdx: null,
            reason: "no TTS",
            at: "2026-08-13T12:00:00.000Z",
          },
          {
            capability: "stage_anchors",
            code: "anchor_hook_unavailable",
            sceneIdx: null,
            reason: "no hook",
            at: "2026-08-13T12:00:00.000Z",
          },
        ],
        artifacts: {
          finalVideoPath: "/runs/final.mp4",
          timelinePath: "/runs/timeline.otio",
          timelineExport: {
            shotCount: 2,
            clipCount: 1,
            omittedShotCount: 1,
            omittedShots: [{ sceneIdx: 0, shotIdx: 1, code: "clip_missing", reason: "clip bytes were missing" }],
          },
          storagePresence: {
            finalVideo: "present",
            timeline: "present",
            sceneVideos: [{ sceneIdx: 0, presence: "present" }],
          },
        },
        timestamps: {
          createdAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-13T12:00:00.000Z",
        },
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

    expect(productionRunCapabilityOmissionWarnings(withOmissions).map((warning) => warning.message)).toEqual([
      "对白配音已跳过：未配置 TTS",
      "舞台锚点已跳过：无工作台执行通道",
    ]);
    expect(productionRunTimelineOmittedShotWarnings(withOmissions).map((warning) => warning.message)).toEqual([
      "时间线省略：场景 1 镜头 2 缺少成片片段",
    ]);

    // Honest while the live receipt is pending: list-snapshot run omissions
    // must not invent tray warnings before the receipt fetch completes.
    const pending = entry({ source: "film", run: withOmissions.run });
    expect(productionRunCapabilityOmissionWarnings(pending)).toEqual([]);
    expect(productionRunTimelineOmittedShotWarnings(pending)).toEqual([]);
    expect(productionRunArtifactPresencePending(pending)).toBe(true);
  });

  it("projects structured film-run errorCode with zh labels beside the free-text error", () => {
    const failed = entry({
      source: "film",
      run: {
        id: "film-failed",
        workflow: "idea-to-film",
        status: "failed",
        phase: "render",
        input: { idea: "雨夜电车" },
        error: "ModelDriverHttpError: upstream 503",
        errorCode: "film_provider_error",
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
      },
    });
    expect(productionRunFailureDetail(failed)).toEqual({
      code: "film_provider_error",
      codeLabel: "提供方调用失败",
      message: "ModelDriverHttpError: upstream 503",
    });
    expect(productionRunErrorCodeLabel("film_run_interrupted")).toBe("运行被中断");
    expect(productionRunErrorCodeLabel("not_a_film_code")).toBeNull();
  });

  it("returns message-only failure detail when errorCode is absent", () => {
    const legacy = entry({
      source: "film",
      run: {
        id: "film-legacy",
        workflow: "script-to-film",
        status: "failed",
        phase: "assemble",
        input: { script: "INT. ROOM - DAY" },
        error: "ffmpeg ENOENT",
        errorCode: null,
        createdAt: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
      },
    });
    expect(productionRunFailureDetail(legacy)).toEqual({
      code: null,
      codeLabel: null,
      message: "ffmpeg ENOENT",
    });
  });
});
