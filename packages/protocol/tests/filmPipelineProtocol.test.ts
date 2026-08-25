import { describe, expect, it } from "vitest";
import {
  createFilmRunRequestSchema,
  filmRunSchema,
  groupShotsIntoCameras,
  shotSpecSchema,
  validateCameraPlan,
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
    expect(filmRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });
});
