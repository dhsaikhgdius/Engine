import { describe, expect, it } from "vitest";
import {
  appendFilmRunCapabilityOmission,
  classifyFilmRunError,
  closeFilmRunPhaseReceipts,
  createFilmRunRequestSchema,
  FILM_PIPELINE_PUBLIC_ERROR_CODES,
  FILM_RUN_CAPABILITY_OMISSION_LIMIT,
  FILM_RUN_PHASE_RECEIPT_LIMIT,
  FILM_TIMELINE_OMITTED_SHOT_LIMIT,
  filmPipelineAvailabilitySchema,
  filmRunCapabilityOmissionSchema,
  filmRunProgress,
  filmRunSchema,
  filmTimelineExportReceiptSchema,
  groupShotsIntoCameras,
  openFilmRunPhaseReceipt,
  shotSpecSchema,
  validateCameraPlan,
  type FilmRunCapabilityOmission,
  type FilmRunPhaseReceipt,
  type FilmTimelineOmittedShot,
  type ShotSpec,
} from "../src/filmPipelineProtocol";

function spec(idx: number, camIdx: number): ShotSpec {
  return shotSpecSchema.parse({
    idx,
    camIdx,
    visualDesc: `shot ${idx}`,
    variationType: "small",
    ffDesc: `first frame ${idx}`,
    motionDesc: `motion ${idx}`,
  });
}

describe("filmPipelineProtocol", () => {
  it("groups shots into cameras preserving shot order", () => {
    const cameras = groupShotsIntoCameras([spec(0, 0), spec(1, 1), spec(2, 0), spec(3, 1)]);
    expect(cameras).toHaveLength(2);
    expect(cameras[0]).toMatchObject({ idx: 0, activeShotIdxs: [0, 2] });
    expect(cameras[1]).toMatchObject({ idx: 1, activeShotIdxs: [1, 3] });
  });

  it("rejects self-parenting, dangling references and cycles in the camera plan", () => {
    const shots = [spec(0, 0), spec(1, 1), spec(2, 2)];
    const base = groupShotsIntoCameras(shots);

    const selfParent = base.map((camera) => ({ ...camera }));
    selfParent[0].parentCamIdx = 0;
    expect(() => validateCameraPlan(selfParent, shots)).toThrow(/its own parent/);

    const dangling = base.map((camera) => ({ ...camera }));
    dangling[1].parentCamIdx = 99;
    expect(() => validateCameraPlan(dangling, shots)).toThrow(/invalid parent camera/);

    const danglingShot = base.map((camera) => ({ ...camera }));
    danglingShot[1].parentCamIdx = 0;
    danglingShot[1].parentShotIdx = 42;
    expect(() => validateCameraPlan(danglingShot, shots)).toThrow(/invalid parent shot/);

    const cyclic = base.map((camera) => ({ ...camera }));
    cyclic[1].parentCamIdx = 2;
    cyclic[2].parentCamIdx = 1;
    expect(() => validateCameraPlan(cyclic, shots)).toThrow(/cycle/);

    const valid = base.map((camera) => ({ ...camera }));
    valid[1].parentCamIdx = 0;
    valid[1].parentShotIdx = 0;
    valid[2].parentCamIdx = 1;
    valid[2].parentShotIdx = 1;
    expect(() => validateCameraPlan(valid, shots)).not.toThrow();
  });

  it("requires idea, script or sceneScripts on run creation", () => {
    expect(
      createFilmRunRequestSchema.safeParse({ workflow: "idea-to-film", input: { userRequirement: "x" } }).success,
    ).toBe(false);
    const parsed = createFilmRunRequestSchema.parse({ input: { idea: "一只猫和一只狗成为朋友" } });
    expect(parsed.workflow).toBe("idea-to-film");
    expect(parsed.input.style.length).toBeGreaterThan(0);
    expect(parsed.input.aspectRatio).toBe("16:9");
  });

  it("round-trips a durable run document with defaults applied", () => {
    const run = filmRunSchema.parse({
      version: 1,
      id: "film-12345678-abcd",
      workflow: "script-to-film",
      status: "queued",
      phase: "extract-characters",
      input: { script: "INT. 客栈 - 夜" },
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(run.scenes).toEqual([]);
    expect(run.characters).toBeNull();
    expect(run.portraitsReady).toBe(false);
    // Pre-hardening documents parse with honest defaults for the new fields.
    expect(run.errorCode).toBeNull();
    expect(run.phaseReceipts).toEqual([]);
    expect(run.timelineExport).toBeNull();
    expect(run.capabilityOmissions).toEqual([]);
    expect(filmRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("reports optional capabilities on the pipeline availability surface", () => {
    const capabilities = {
      dialogueAudio: { configured: false, reason: "对白 TTS 未配置" },
      stageAnchors: { configured: true, reason: null },
    };
    expect(filmPipelineAvailabilitySchema.safeParse({ configured: true, reason: null, capabilities }).success).toBe(
      true,
    );
    // The capability report is part of the contract, never silently dropped.
    expect(filmPipelineAvailabilitySchema.safeParse({ configured: true, reason: null }).success).toBe(false);
  });

  it("rejects dishonest capability omission records", () => {
    const valid: FilmRunCapabilityOmission = {
      capability: "dialogue_audio",
      code: "tts_unconfigured",
      sceneIdx: null,
      reason: "enableAudio was requested but no TTS provider is configured",
      at: "2026-08-26T00:00:00.000Z",
    };
    expect(filmRunCapabilityOmissionSchema.safeParse(valid).success).toBe(true);
    // A code cannot claim a capability it does not belong to.
    expect(filmRunCapabilityOmissionSchema.safeParse({ ...valid, capability: "stage_anchors" }).success).toBe(false);
    // Run-level codes carry no sceneIdx; scene-scoped codes must carry one.
    expect(filmRunCapabilityOmissionSchema.safeParse({ ...valid, sceneIdx: 0 }).success).toBe(false);
    expect(
      filmRunCapabilityOmissionSchema.safeParse({
        capability: "stage_anchors",
        code: "anchor_resolution_failed",
        sceneIdx: null,
        reason: "anchor capture failed",
        at: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      filmRunCapabilityOmissionSchema.safeParse({
        capability: "stage_anchors",
        code: "anchor_resolution_failed",
        sceneIdx: 3,
        reason: "anchor capture failed",
        at: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("appends capability omissions idempotently within a bounded window", () => {
    const omission: FilmRunCapabilityOmission = {
      capability: "dialogue_audio",
      code: "tts_unconfigured",
      sceneIdx: null,
      reason: "enableAudio was requested but no TTS provider is configured",
      at: "2026-08-26T00:00:00.000Z",
    };
    const once = appendFilmRunCapabilityOmission([], omission);
    expect(once).toEqual([omission]);
    // A resumed run re-enters the same decision; the first record keeps its timestamp.
    expect(appendFilmRunCapabilityOmission(once, { ...omission, at: "2026-08-26T01:00:00.000Z" })).toEqual([omission]);

    // Different scenes are distinct facts.
    const perScene = (sceneIdx: number): FilmRunCapabilityOmission => ({
      capability: "stage_anchors",
      code: "anchor_resolution_failed",
      sceneIdx,
      reason: `anchor capture failed for scene ${sceneIdx}`,
      at: "2026-08-26T00:00:00.000Z",
    });
    const two = appendFilmRunCapabilityOmission(appendFilmRunCapabilityOmission([], perScene(0)), perScene(1));
    expect(two).toHaveLength(2);

    // The window stays bounded; the newest records win.
    let many: FilmRunCapabilityOmission[] = [];
    for (let index = 0; index < FILM_RUN_CAPABILITY_OMISSION_LIMIT + 8; index += 1) {
      many = appendFilmRunCapabilityOmission(many, perScene(index));
    }
    expect(many).toHaveLength(FILM_RUN_CAPABILITY_OMISSION_LIMIT);
    expect(many.at(-1)?.sceneIdx).toBe(FILM_RUN_CAPABILITY_OMISSION_LIMIT + 7);
  });

  it("enforces the timeline export receipt accounting invariants", () => {
    const omitted: FilmTimelineOmittedShot = {
      sceneIdx: 0,
      shotIdx: 1,
      code: "clip_missing",
      reason: "clip bytes were missing at export time",
    };
    expect(
      filmTimelineExportReceiptSchema.safeParse({
        shotCount: 3,
        clipCount: 2,
        omittedShotCount: 1,
        omittedShots: [omitted],
      }).success,
    ).toBe(true);
    // Every planned shot is either a clip or a typed omission — no third bucket.
    expect(
      filmTimelineExportReceiptSchema.safeParse({
        shotCount: 3,
        clipCount: 2,
        omittedShotCount: 0,
        omittedShots: [],
      }).success,
    ).toBe(false);
    // The typed records must match the count while it fits inside the window.
    expect(
      filmTimelineExportReceiptSchema.safeParse({
        shotCount: 3,
        clipCount: 2,
        omittedShotCount: 1,
        omittedShots: [],
      }).success,
    ).toBe(false);
    // Past the bounded window, the exact count survives with truncated records.
    const overflowCount = FILM_TIMELINE_OMITTED_SHOT_LIMIT + 5;
    expect(
      filmTimelineExportReceiptSchema.safeParse({
        shotCount: overflowCount + 1,
        clipCount: 1,
        omittedShotCount: overflowCount,
        omittedShots: Array.from({ length: FILM_TIMELINE_OMITTED_SHOT_LIMIT }, (_, index) => ({
          ...omitted,
          shotIdx: index,
        })),
      }).success,
    ).toBe(true);
  });

  it("freezes the public film HTTP error codes", () => {
    // Agents branch on these codes; this list only ever grows.
    expect(FILM_PIPELINE_PUBLIC_ERROR_CODES).toEqual([
      "film_pipeline_unconfigured",
      "invalid_request",
      "invalid_run_id",
      "run_not_found",
    ]);
  });

  it("classifies execution failures into stable run error codes", () => {
    const providerError = new Error("HTTP 502 from provider");
    providerError.name = "ModelDriverHttpError";
    expect(classifyFilmRunError(providerError)).toBe("film_provider_error");
    expect(classifyFilmRunError(new Error("ffmpeg exited with code 1"))).toBe("film_run_error");
    expect(classifyFilmRunError("string failure")).toBe("film_run_error");
  });

  it("opens and closes phase receipts idempotently within a bounded window", () => {
    let receipts: FilmRunPhaseReceipt[] = [];
    receipts = openFilmRunPhaseReceipt(receipts, "develop-story", "2026-08-13T00:00:00.000Z");
    expect(receipts).toEqual([{ phase: "develop-story", startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null }]);

    // Opening the next phase closes the previous receipt at the same instant.
    receipts = openFilmRunPhaseReceipt(receipts, "extract-characters", "2026-08-13T00:01:00.000Z");
    expect(receipts[0]).toEqual({
      phase: "develop-story",
      startedAt: "2026-08-13T00:00:00.000Z",
      finishedAt: "2026-08-13T00:01:00.000Z",
    });
    expect(receipts[1]).toMatchObject({ phase: "extract-characters", finishedAt: null });

    // Closing is idempotent: settled receipts keep their original finishedAt.
    const closed = closeFilmRunPhaseReceipts(receipts, "2026-08-13T00:02:00.000Z");
    expect(closed[0].finishedAt).toBe("2026-08-13T00:01:00.000Z");
    expect(closed[1].finishedAt).toBe("2026-08-13T00:02:00.000Z");
    expect(closeFilmRunPhaseReceipts(closed, "2026-08-13T00:03:00.000Z")).toEqual(closed);

    // The window stays bounded; the newest receipts win.
    let many: FilmRunPhaseReceipt[] = [];
    for (let index = 0; index < FILM_RUN_PHASE_RECEIPT_LIMIT + 8; index += 1) {
      many = openFilmRunPhaseReceipt(
        many,
        "plan-scenes",
        `2026-08-13T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      );
    }
    expect(many).toHaveLength(FILM_RUN_PHASE_RECEIPT_LIMIT);
    expect(many.at(-1)?.finishedAt).toBeNull();
  });

  it("reports phase-fraction progress shared by receipt and unified progress", () => {
    expect(filmRunProgress({ phase: "develop-story" })).toBe(0);
    expect(filmRunProgress({ phase: "render" })).toBeCloseTo(5 / 7);
    expect(filmRunProgress({ phase: "completed" })).toBe(1);
    expect(filmRunProgress({ phase: "not-a-phase" as never })).toBeNull();
  });

  it("advances render progress from durable per-scene videoPath completion", () => {
    const floor = 5 / 7;
    const span = 1 / 7;
    const half = filmRunProgress({
      phase: "render",
      scenes: [
        {
          storyboard: null,
          shotSpecs: null,
          cameraPlan: null,
          videoPath: "/tmp/a.mp4",
        },
        {
          storyboard: null,
          shotSpecs: null,
          cameraPlan: null,
          videoPath: null,
        },
      ],
    });
    expect(half).toBeCloseTo(floor + span * 0.5);
    expect(
      filmRunProgress({
        phase: "render",
        scenes: [
          { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: "/a.mp4" },
          { storyboard: null, shotSpecs: null, cameraPlan: null, videoPath: "/b.mp4" },
        ],
      }),
    ).toBeCloseTo(floor + span);
  });

  it("advances plan-scenes progress only when storyboard, shotSpecs, and cameraPlan exist", () => {
    const floor = 3 / 7;
    const span = 1 / 7;
    expect(
      filmRunProgress({
        phase: "plan-scenes",
        scenes: [
          { storyboard: [], shotSpecs: [], cameraPlan: [], videoPath: null },
          { storyboard: [], shotSpecs: null, cameraPlan: null, videoPath: null },
        ],
      }),
    ).toBeCloseTo(floor + span * 0.5);
    expect(filmRunProgress({ phase: "plan-scenes", scenes: [] })).toBeCloseTo(floor);
  });
});
