import { describe, expect, it } from "vitest";
import {
  classifyFilmRunError,
  closeFilmRunPhaseReceipts,
  createFilmRunRequestSchema,
  FILM_PIPELINE_PUBLIC_ERROR_CODES,
  FILM_RUN_PHASE_RECEIPT_LIMIT,
  filmRunProgress,
  filmRunSchema,
  groupShotsIntoCameras,
  openFilmRunPhaseReceipt,
  shotSpecSchema,
  validateCameraPlan,
  type FilmRunPhaseReceipt,
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
    expect(filmRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
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
