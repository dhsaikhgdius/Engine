import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import type { DirectorCameraShot, DirectorProject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { directorProjectSchema } from "../../../../src/comprehensive/editor/schema/directorProjectSchema";
import {
  createDefaultDirectorProduction,
  DEFAULT_DIRECTOR_COVERAGE_SEQUENCE_ID,
  DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
  getDirectorProductionIssues,
  isDirectorProductionValid,
  migrateDirectorProduction,
  reconcileDirectorProduction,
} from "../../../../src/comprehensive/editor/schema/directorProduction";
import { evaluateDirectorProductionAtFrame } from "../../../../src/comprehensive/editor/schema/directorProductionEvaluator";

function withoutProduction(project: DirectorProject): DirectorProject {
  const legacy = structuredClone(project);
  delete legacy.production;
  return legacy;
}

describe("Director production take and coverage model", () => {
  it("creates one backward-compatible take and one camera coverage by default", () => {
    const project = createDefaultDirectorProject();
    const production = project.production;

    expect(production).toBeDefined();
    expect(production?.activeTakeId).toBe(DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID);
    expect(production?.activeSequenceId).toBe(DEFAULT_DIRECTOR_COVERAGE_SEQUENCE_ID);
    expect(production?.takes).toEqual([
      expect.objectContaining({
        id: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        frameStart: project.scene.timeline?.frameStart,
        frameEnd: project.scene.timeline?.frameEnd,
        objectIds: ["char_default_a"],
      }),
    ]);
    expect(production?.sequences[0]?.shots).toEqual([
      expect.objectContaining({
        takeId: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        cameraId: "cam_1",
        frameStart: project.scene.timeline?.frameStart,
        frameEnd: project.scene.timeline?.frameEnd,
      }),
    ]);
    expect(getDirectorProductionIssues(project)).toEqual([]);
    expect(directorProjectSchema.safeParse(project).success).toBe(true);
  });

  it("migrates storyboard coverage and take-owned entity animation deterministically", () => {
    const legacy = withoutProduction(createDefaultDirectorProject());
    legacy.objects[0]!.animation = {
      version: 1,
      source: "manual",
      keyframes: [
        { frame: 0, poseValues: { "head.yaw": 0 } },
        { frame: 180, poseValues: { "head.yaw": 25 } },
      ],
    };
    legacy.storyboard = {
      version: 1,
      title: "共享表演，多机覆盖",
      logline: "同一动作由两台机位覆盖。",
      shots: [
        {
          id: "board-wide",
          title: "全景",
          cameraId: "cam_1",
          frameStart: 0,
          frameEnd: 95,
          shotSize: "wide",
          movement: "static",
          action: "表演",
        },
        {
          id: "board-close",
          title: "近景",
          cameraId: "cam_1",
          frameStart: 96,
          frameEnd: 180,
          shotSize: "close-up",
          movement: "push-in",
          action: "同一表演",
        },
      ],
    };

    const migrated = migrateDirectorProduction(legacy);
    const take = migrated.production?.takes[0];
    const shots = migrated.production?.sequences[0]?.shots;

    expect(take).toEqual(
      expect.objectContaining({
        id: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        frameStart: 0,
        frameEnd: legacy.scene.timeline?.frameEnd,
        objectIds: ["char_default_a"],
      }),
    );
    expect(take?.entityTracks[0]).toEqual(
      expect.objectContaining({ objectId: "char_default_a", animation: legacy.objects[0]?.animation }),
    );
    expect(take?.entityTracks[0]?.animation).not.toBe(legacy.objects[0]?.animation);
    expect(shots).toEqual([
      expect.objectContaining({
        storyboardShotId: "board-wide",
        takeId: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        frameStart: 0,
        frameEnd: 95,
      }),
      expect.objectContaining({
        storyboardShotId: "board-close",
        takeId: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        frameStart: 96,
        frameEnd: 180,
      }),
    ]);
    expect(getDirectorProductionIssues(migrated)).toEqual([]);
  });

  it("allows several independently-lensed shots to reuse one performance take", () => {
    const project = createDefaultDirectorProject();
    const secondCamera: DirectorCameraShot = {
      ...structuredClone(project.cameras[0]!),
      id: "cam_2",
      name: "近景机位",
      focalLengthMm: 85,
    };
    project.cameras.push(secondCamera);
    project.production!.sequences[0]!.shots = [
      {
        id: "wide",
        name: "全景覆盖",
        takeId: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        cameraId: "cam_1",
        frameStart: 0,
        frameEnd: 60,
      },
      {
        id: "close",
        name: "近景覆盖",
        takeId: DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
        cameraId: "cam_2",
        frameStart: 0,
        frameEnd: 60,
      },
    ];

    expect(project.production!.sequences[0]?.shots.map((shot) => shot.takeId)).toEqual([
      DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
      DEFAULT_DIRECTOR_PERFORMANCE_TAKE_ID,
    ]);
    expect(project.cameras.map((camera) => camera.focalLengthMm)).toEqual([35, 85]);
    expect(isDirectorProductionValid(project)).toBe(true);
  });

  it("evaluates two camera coverages from the same take-owned performance frame", () => {
    const project = createDefaultDirectorProject();
    const secondCamera: DirectorCameraShot = {
      ...structuredClone(project.cameras[0]!),
      id: "cam_2",
      name: "近景机位",
      transform: {
        position: [1, 2, 3],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      focalLengthMm: 85,
    };
    project.cameras.push(secondCamera);
    project.objects[0]!.animation = {
      version: 1,
      keyframes: [
        { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 60, transform: { position: [99, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    };
    project.production!.takes[0]!.entityTracks = [
      {
        id: "performance_char",
        objectId: "char_default_a",
        animation: {
          version: 1,
          keyframes: [
            { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
            { frame: 60, transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          ],
        },
      },
    ];
    project.production!.sequences[0]!.shots = [
      {
        id: "wide",
        name: "全景覆盖",
        takeId: "take_default",
        cameraId: "cam_1",
        frameStart: 0,
        frameEnd: 60,
      },
      {
        id: "close",
        name: "近景覆盖",
        takeId: "take_default",
        cameraId: "cam_2",
        frameStart: 0,
        frameEnd: 60,
      },
    ];

    const wide = evaluateDirectorProductionAtFrame(project, { coverageShotId: "wide", frame: 60 });
    const close = evaluateDirectorProductionAtFrame(project, { coverageShotId: "close", frame: 60 });

    expect(wide.objects.find((object) => object.id === "char_default_a")?.transform.position).toEqual([4, 0, 0]);
    expect(close.objects.find((object) => object.id === "char_default_a")?.transform.position).toEqual([4, 0, 0]);
    expect(wide.camera.id).toBe("cam_1");
    expect(close.camera.id).toBe("cam_2");
    expect(close.camera.focalLengthMm).toBe(85);
    expect(project.objects[0]?.animation?.keyframes[1]?.transform?.position).toEqual([99, 0, 0]);
  });

  it("defaults to the shot start and rejects frames outside take or coverage", () => {
    const project = createDefaultDirectorProject();
    project.production!.sequences[0]!.shots[0]!.frameStart = 10;
    project.production!.sequences[0]!.shots[0]!.frameEnd = 20;

    expect(evaluateDirectorProductionAtFrame(project).frame).toBe(10);
    expect(() => evaluateDirectorProductionAtFrame(project, { frame: 21 })).toThrow(/CoverageShot/);
    expect(() => evaluateDirectorProductionAtFrame(project, { coverageShotId: "missing" })).toThrow(/不存在/);
  });

  it("resolves a linked Stage camera-rig id without changing coverage or frame selection", () => {
    const project = createDefaultDirectorProject();
    const camera = project.cameras[0]!;
    const rig = project.objects.find((object) => object.kind === "camera" && object.linkedCameraId === camera.id)!;
    const coverage = project.production!.sequences[0]!.shots[0]!;

    const evaluated = evaluateDirectorProductionAtFrame(project, {
      coverageShotId: coverage.id,
      cameraId: rig.id,
      frame: 24,
    });

    expect(evaluated.camera.id).toBe(camera.id);
    expect(evaluated.shot?.id).toBe(coverage.id);
    expect(evaluated.frame).toBe(24);
  });

  it("can evaluate a requested take without borrowing an unrelated active coverage shot", () => {
    const project = createDefaultDirectorProject();
    project.production!.takes.push({
      id: "take_alternate",
      name: "备用表演",
      frameStart: 0,
      frameEnd: 30,
      objectIds: ["char_default_a"],
      entityTracks: [],
    });

    const evaluated = evaluateDirectorProductionAtFrame(project, { takeId: "take_alternate", frame: 12 });

    expect(evaluated.take.id).toBe("take_alternate");
    expect(evaluated.shot).toBeNull();
    expect(evaluated.camera.id).toBe(project.activeCameraId);
    expect(evaluated.frame).toBe(12);
  });

  it("reports duplicate IDs, broken references, and invalid frame relationships", () => {
    const project = createDefaultDirectorProject();
    const production = project.production!;
    production.takes.push(structuredClone(production.takes[0]!));
    production.activeSequenceId = "missing-sequence";
    production.takes[0]!.objectIds.push("missing-object", "char_default_a");
    production.takes[0]!.entityTracks.push({
      id: "track_bad",
      objectId: "missing-object",
      animation: { version: 1, keyframes: [{ frame: 999 }] },
    });
    production.sequences[0]!.shots[0] = {
      id: "broken-shot",
      name: "坏镜头",
      takeId: "missing-take",
      cameraId: "missing-camera",
      frameStart: 20,
      frameEnd: 10,
      storyboardShotId: "missing-board",
    };

    const issues = getDirectorProductionIssues(project);
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["duplicate-id", "duplicate-ref", "missing-ref", "invalid-frame-range"]),
    );
    expect(issues.some((issue) => issue.path.endsWith("animation.keyframes.0.frame"))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith("cameraId"))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith("storyboardShotId"))).toBe(true);
    expect(isDirectorProductionValid(project)).toBe(false);
  });

  it("keeps an existing authored production model unchanged during migration", () => {
    const project = createDefaultDirectorProject();
    const result = migrateDirectorProduction(project);

    expect(result).toBe(project);
    expect(result.production).toBe(project.production);
  });

  it("reconciles deleted object, camera, and storyboard references without mutating the source", () => {
    const project = createDefaultDirectorProject();
    const source = structuredClone(project.production!);
    project.objects = [];
    project.cameras = [];
    project.storyboard = { ...project.storyboard!, shots: [] };

    const reconciled = reconcileDirectorProduction(project, source)!;

    expect(reconciled.takes[0]).toMatchObject({ objectIds: [], entityTracks: [] });
    expect(reconciled.sequences[0]?.shots).toEqual([]);
    expect(source.takes[0]?.objectIds).toEqual(["char_default_a"]);
    expect(source.sequences[0]?.shots).toHaveLength(1);
  });

  it("keeps legacy JSON schema-compatible and rejects malformed production structure", () => {
    const legacy = withoutProduction(createDefaultDirectorProject());
    expect(directorProjectSchema.safeParse(legacy).success).toBe(true);

    const malformed = createDefaultDirectorProduction(legacy) as unknown as Record<string, unknown>;
    (malformed.takes as Array<Record<string, unknown>>)[0]!.entityTracks = "not-an-array";
    expect(directorProjectSchema.safeParse({ ...legacy, production: malformed }).success).toBe(false);
  });
});
