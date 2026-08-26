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
      capabilityOmissions: [],
      artifacts: { finalVideoPath: null, timelinePath: null, timelineExport: null },
      timestamps: { createdAt: run.createdAt, updatedAt: run.updatedAt },
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
    });
    // Deterministic: the same document always yields the same receipt.
    expect(projectFilmRunReceipt(makeRun())).toEqual(receipt);
  });

  it("projects durable per-scope usage onto the receipt", () => {
    const receipt = projectFilmRunReceipt(
      makeRun({
        usage: {
          "film-llm": {
            sample_count: 2,
            input_tokens: 100,
            output_tokens: 40,
            total_tokens: 140,
            total_duration_ms: 900,
            retries: 1,
            failure_count: 0,
          },
          "film-image": {
            sample_count: 1,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            total_duration_ms: 1_200,
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
        },
      }),
    );
    expect(receipt.usage["film-llm"].sample_count).toBe(2);
    expect(receipt.usage["film-llm"].total_tokens).toBe(140);
    expect(receipt.usage["film-image"].total_duration_ms).toBe(1_200);
    expect(receipt.usage["film-video"].sample_count).toBe(0);
    // Run documents persisted before speech metering existed carry no
    // film-tts key; the schema backfills zeros instead of rejecting them.
    expect(receipt.usage["film-tts"].sample_count).toBe(0);
  });

  it("projects metered speech synthesis usage onto the receipt", () => {
    const zeros = {
      sample_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_duration_ms: 0,
      retries: 0,
      failure_count: 0,
    };
    const receipt = projectFilmRunReceipt(
      makeRun({
        usage: {
          "film-llm": zeros,
          "film-image": zeros,
          "film-video": zeros,
          "film-tts": {
            sample_count: 3,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            total_duration_ms: 2_400,
            retries: 1,
            failure_count: 1,
          },
        },
      }),
    );
    expect(receipt.usage["film-tts"].sample_count).toBe(3);
    expect(receipt.usage["film-tts"].total_duration_ms).toBe(2_400);
    expect(receipt.usage["film-tts"].failure_count).toBe(1);
    expect(receipt.usage["film-llm"].sample_count).toBe(0);
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
    const timelineExport = {
      shotCount: 4,
      clipCount: 3,
      omittedShotCount: 1,
      omittedShots: [{ sceneIdx: 1, shotIdx: 0, code: "clip_missing" as const, reason: "clip bytes were missing" }],
    };
    const receipt = projectFilmRunReceipt(
      makeRun({
        status: "completed",
        phase: "completed",
        finalVideoPath: "/runs/final_video.mp4",
        timelinePath: "/runs/timeline.otio",
        timelineExport,
      }),
    );
    expect(receipt.terminal).toBe(true);
    expect(receipt.progress).toBe(1);
    expect(receipt.artifacts).toEqual({
      finalVideoPath: "/runs/final_video.mp4",
      timelinePath: "/runs/timeline.otio",
      timelineExport,
    });
  });

  it("projects typed capability omissions onto the receipt", () => {
    const omissions = [
      {
        capability: "dialogue_audio" as const,
        code: "tts_unconfigured" as const,
        sceneIdx: null,
        reason: "enableAudio was requested but no TTS provider is configured",
        at: "2026-08-13T00:01:00.000Z",
      },
      {
        capability: "stage_anchors" as const,
        code: "anchor_resolution_failed" as const,
        sceneIdx: 1,
        reason: "Stage anchor resolution failed for scene 1",
        at: "2026-08-13T00:02:00.000Z",
      },
    ];
    const receipt = projectFilmRunReceipt(makeRun({ capabilityOmissions: omissions }));
    expect(receipt.capabilityOmissions).toEqual(omissions);

    // Documents that predate typed omissions project an empty list, never invented records.
    expect(projectFilmRunReceipt(makeRun()).capabilityOmissions).toEqual([]);
  });

  it("keeps timelineExport null for legacy runs that predate typed export receipts", () => {
    const legacy = projectFilmRunReceipt(
      makeRun({ status: "completed", phase: "completed", timelinePath: "/runs/timeline.otio" }),
    );
    // A complete handoff is never invented for documents without a receipt.
    expect(legacy.artifacts.timelineExport).toBeNull();
  });

  it("rejects a timelineExport receipt without a claimed timelinePath", () => {
    const receipt = projectFilmRunReceipt(makeRun());
    expect(
      filmRunReceiptSchema.safeParse({
        ...receipt,
        artifacts: {
          ...receipt.artifacts,
          timelineExport: { shotCount: 1, clipCount: 1, omittedShotCount: 0, omittedShots: [] },
        },
      }).success,
    ).toBe(false);
  });

  it("stamps live artifact storagePresence only when probe results are provided", () => {
    const completed = makeRun({
      status: "completed",
      phase: "completed",
      finalVideoPath: "/runs/final_video.mp4",
      timelinePath: "/runs/timeline.otio",
    });

    // Pure projections (tests, offline consumers) never invent a probe.
    expect(projectFilmRunReceipt(completed).artifacts.storagePresence).toBeUndefined();

    const live = projectFilmRunReceipt(completed, {
      artifactStoragePresence: {
        finalVideo: "present",
        timeline: "absent",
        sceneVideos: [{ sceneIdx: 0, presence: "present" }],
      },
    });
    expect(live.artifacts.storagePresence).toEqual({
      finalVideo: "present",
      timeline: "absent",
      sceneVideos: [{ sceneIdx: 0, presence: "present" }],
    });

    // Missing probe keys degrade to absent instead of silently over-claiming;
    // that covers claimed scene videos with no verdict too.
    const partial = projectFilmRunReceipt(completed, { artifactStoragePresence: { finalVideo: "present" } });
    expect(partial.artifacts.storagePresence).toEqual({
      finalVideo: "present",
      timeline: "absent",
      sceneVideos: [{ sceneIdx: 0, presence: "absent" }],
    });

    // Unclaimed (null-path) artifacts normalize to null presence, and only
    // scenes that claim a rendered video get a verdict (scene 1 has none).
    const unclaimed = projectFilmRunReceipt(makeRun(), { artifactStoragePresence: {} });
    expect(unclaimed.artifacts.storagePresence).toEqual({
      finalVideo: null,
      timeline: null,
      sceneVideos: [{ sceneIdx: 0, presence: "absent" }],
    });

    // Runs with no scene claims stamp an empty verdict list, never invented entries.
    const sceneless = projectFilmRunReceipt(makeRun({ scenes: [] }), { artifactStoragePresence: {} });
    expect(sceneless.artifacts.storagePresence).toEqual({ finalVideo: null, timeline: null, sceneVideos: [] });
  });

  it("rejects storagePresence verdicts that disagree with the path claims", () => {
    const receipt = projectFilmRunReceipt(makeRun(), { artifactStoragePresence: {} });
    const sceneVideos = [{ sceneIdx: 0, presence: "absent" as const }];
    // A probe verdict on an unclaimed path is a contradiction.
    expect(
      filmRunReceiptSchema.safeParse({
        ...receipt,
        artifacts: { ...receipt.artifacts, storagePresence: { finalVideo: "present", timeline: null, sceneVideos } },
      }).success,
    ).toBe(false);
    // A claimed path must carry a probe verdict when the stanza is present.
    expect(
      filmRunReceiptSchema.safeParse({
        ...receipt,
        artifacts: {
          finalVideoPath: "/runs/final_video.mp4",
          timelinePath: null,
          timelineExport: null,
          storagePresence: { finalVideo: null, timeline: null, sceneVideos },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects sceneVideos verdicts that disagree with the rendered-scene claims", () => {
    const receipt = projectFilmRunReceipt(makeRun(), { artifactStoragePresence: {} });
    // One verdict per rendered scene: an empty list under-reports renderedSceneCount = 1.
    expect(
      filmRunReceiptSchema.safeParse({
        ...receipt,
        artifacts: { ...receipt.artifacts, storagePresence: { finalVideo: null, timeline: null, sceneVideos: [] } },
      }).success,
    ).toBe(false);
    // Duplicate sceneIdx entries are a contradiction even when the count matches.
    const duplicated = projectFilmRunReceipt(
      makeRun({
        scenes: [
          { idx: 0, script: "Scene 0", clipCount: 3, videoPath: "scene_0/scene_video.mp4" },
          { idx: 1, script: "Scene 1", clipCount: 2, videoPath: "scene_1/scene_video.mp4" },
        ],
      }),
      { artifactStoragePresence: {} },
    );
    expect(
      filmRunReceiptSchema.safeParse({
        ...duplicated,
        artifacts: {
          ...duplicated.artifacts,
          storagePresence: {
            finalVideo: null,
            timeline: null,
            sceneVideos: [
              { sceneIdx: 0, presence: "present" },
              { sceneIdx: 0, presence: "absent" },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects receipts whose invariants are violated", () => {
    const receipt = projectFilmRunReceipt(makeRun());
    expect(filmRunReceiptSchema.safeParse({ ...receipt, terminal: true }).success).toBe(false);
    expect(filmRunReceiptSchema.safeParse({ ...receipt, renderedSceneCount: 3 }).success).toBe(false);
  });
});
