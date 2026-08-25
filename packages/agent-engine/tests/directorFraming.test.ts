import { describe, expect, it } from "vitest";
import {
  DIRECTOR_SHOT_LEVEL_IDS,
  DIRECTOR_SHOT_SIZE_IDS,
  DIRECTOR_SHOT_VIEW_IDS,
  deriveDirectorShotLanguage,
  getCameraViewSnapshotFromShot,
  type DirectorProject,
  type DirectorShotLevel,
  type DirectorShotSide,
  type DirectorShotSize,
  type DirectorShotView,
} from "@director/project-schema";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { applyDirectorAuthoringActions, directorAuthoringActionSchema } from "../src/directorAuthoring";
import { describeDirectorCameraMoveFromProject, directorFramingSubjectForObject } from "../src/directorFraming";

const CAMERA_ID = "cam-frame";
const SUBJECT_ID = "hero";

function stageWithHeroAndCamera(): DirectorProject {
  return applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    { action: "start_scene" },
    {
      action: "add_object",
      id: SUBJECT_ID,
      name: "主角",
      kind: "character",
      placement_mode: "grounded",
      transform: { position: [1.5, 0, -2], rotation: [0, Math.PI / 3, 0], scale: [1, 1, 1] },
    },
    {
      action: "add_camera",
      id: CAMERA_ID,
      object_id: `${CAMERA_ID}-rig`,
      name: "取景机位",
      position: [0, 1.6, 8],
      target: [0, 1.2, 0],
    },
  ]).project;
}

function frameShot(
  project: DirectorProject,
  intent: {
    size?: DirectorShotSize;
    view?: DirectorShotView;
    side?: DirectorShotSide;
    level?: DirectorShotLevel;
    focal_length_mm?: number;
    activate?: boolean;
  },
) {
  const action = directorAuthoringActionSchema.parse({
    action: "frame_shot",
    camera_id: CAMERA_ID,
    subject_object_id: SUBJECT_ID,
    ...intent,
  });
  return applyDirectorAuthoringActions(project, [action]);
}

function derivedLanguage(project: DirectorProject) {
  const camera = project.cameras.find((item) => item.id === CAMERA_ID)!;
  const subject = directorFramingSubjectForObject(project.objects.find((item) => item.id === SUBJECT_ID)!, project);
  const view = getCameraViewSnapshotFromShot(camera);
  return deriveDirectorShotLanguage(
    {
      position: view.position,
      target: view.target,
      focalLengthMm: camera.focalLengthMm ?? 35,
      aspectRatio: camera.aspectRatio,
      sensorFormat: camera.sensorFormat,
    },
    subject,
  );
}

describe("frame_shot authoring", () => {
  it("frames an existing camera from cinematic intent and reports the slate", () => {
    const result = frameShot(stageWithHeroAndCamera(), {
      size: "medium-close-up",
      view: "profile",
      side: "left",
      level: "knee",
    });

    const language = derivedLanguage(result.project);
    expect(language.size).toBe("medium-close-up");
    expect(language.view).toBe("profile");
    expect(language.side).toBe("left");
    expect(language.level).toBe("knee");

    const camera = result.project.cameras.find((item) => item.id === CAMERA_ID)!;
    expect(camera.targetObjectId).toBeNull();
    expect(camera.targetMode).toBe("manual");
    expect(result.notes.some((note) => note.includes("frame_shot") && note.includes("MEDIUM-CLOSE-UP"))).toBe(true);
    expect(result.updated.camera_ids).toContain(CAMERA_ID);
  });

  const ROUND_TRIP_CASES = [
    ...DIRECTOR_SHOT_SIZE_IDS.flatMap((size) =>
      DIRECTOR_SHOT_VIEW_IDS.flatMap((view) =>
        (["left", "right"] as const).map((side) => ({ size, view, side, level: "eye" as const })),
      ),
    ),
    ...DIRECTOR_SHOT_SIZE_IDS.flatMap((size) =>
      DIRECTOR_SHOT_LEVEL_IDS.map((level) => ({ size, view: "front-quarter" as const, side: "right" as const, level })),
    ),
  ];

  it(`round-trips ${ROUND_TRIP_CASES.length} intents through the live authoring pipeline`, () => {
    const project = stageWithHeroAndCamera();
    for (const intent of ROUND_TRIP_CASES) {
      const result = frameShot(project, intent);
      const language = derivedLanguage(result.project);
      const flattened = result.notes.some((note) => note.includes("level"));
      expect(language.size, JSON.stringify(intent)).toBe(intent.size);
      expect(language.view, JSON.stringify(intent)).toBe(intent.view);
      if (intent.view !== "front" && intent.view !== "back") {
        expect(language.side, JSON.stringify(intent)).toBe(intent.side);
      }
      if (!flattened) expect(language.level, JSON.stringify(intent)).toBe(intent.level);
    }
  });

  it("extends a lens that cannot hold the size instead of failing silently", () => {
    const result = frameShot(stageWithHeroAndCamera(), {
      size: "extreme-close-up",
      focal_length_mm: 12,
    });
    expect(result.notes.some((note) => note.includes("extended"))).toBe(true);
    const language = derivedLanguage(result.project);
    expect(language.size).toBe("extreme-close-up");
    expect(language.focalLengthMm).toBeGreaterThan(12);
  });

  it("activates the framed camera only when asked", () => {
    const project = applyDirectorAuthoringActions(stageWithHeroAndCamera(), [
      {
        action: "add_camera",
        id: "cam-other",
        object_id: "cam-other-rig",
        name: "另一机位",
        position: [4, 2, 4],
        target: [0, 1, 0],
        activate: true,
      },
    ]).project;
    expect(project.activeCameraId).toBe("cam-other");

    const framed = frameShot(project, { size: "wide" });
    expect(framed.project.activeCameraId).toBe("cam-other");

    const activated = frameShot(project, { size: "wide", activate: true });
    expect(activated.project.activeCameraId).toBe(CAMERA_ID);
  });

  it("rejects a missing camera, a missing subject, and a camera subject", () => {
    const project = stageWithHeroAndCamera();
    expect(() =>
      applyDirectorAuthoringActions(project, [
        directorAuthoringActionSchema.parse({
          action: "frame_shot",
          camera_id: "cam-ghost",
          subject_object_id: SUBJECT_ID,
        }),
      ]),
    ).toThrow(/No camera/);
    expect(() =>
      applyDirectorAuthoringActions(project, [
        directorAuthoringActionSchema.parse({
          action: "frame_shot",
          camera_id: CAMERA_ID,
          subject_object_id: "ghost",
        }),
      ]),
    ).toThrow(/No object/);
    expect(() =>
      applyDirectorAuthoringActions(project, [
        directorAuthoringActionSchema.parse({
          action: "frame_shot",
          camera_id: CAMERA_ID,
          subject_object_id: `${CAMERA_ID}-rig`,
        }),
      ]),
    ).toThrow(/cannot be a framing subject/);
  });
});

describe("mark_camera_move authoring", () => {
  it("pins the current framing as a keyframe and preserves other marks", () => {
    let project = frameShot(stageWithHeroAndCamera(), { size: "full", view: "front-quarter" }).project;
    project = applyDirectorAuthoringActions(project, [
      directorAuthoringActionSchema.parse({ action: "mark_camera_move", camera_id: CAMERA_ID, frame: 0 }),
    ]).project;
    project = frameShot(project, { size: "close-up", view: "front-quarter" }).project;
    const marked = applyDirectorAuthoringActions(project, [
      directorAuthoringActionSchema.parse({ action: "mark_camera_move", camera_id: CAMERA_ID, frame: 48 }),
    ]);
    project = marked.project;

    const camera = project.cameras.find((item) => item.id === CAMERA_ID)!;
    expect(camera.animation?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 48]);
    expect(marked.notes.some((note) => note.includes("mark_camera_move"))).toBe(true);

    const remarked = applyDirectorAuthoringActions(project, [
      directorAuthoringActionSchema.parse({ action: "mark_camera_move", camera_id: CAMERA_ID, frame: 48 }),
    ]);
    const remarkedCamera = remarked.project.cameras.find((item) => item.id === CAMERA_ID)!;
    expect(remarkedCamera.animation?.keyframes.map((keyframe) => keyframe.frame)).toEqual([0, 48]);
    expect(remarked.notes.some((note) => note.includes("re-marked"))).toBe(true);
  });
});

describe("describe_camera_move", () => {
  // A true push-in holds the lens: framing tighter on the same 35mm prime
  // moves the camera in, instead of letting a longer lens do the work.
  function markedPushIn(): DirectorProject {
    let project = frameShot(stageWithHeroAndCamera(), {
      size: "full",
      view: "front-quarter",
      side: "right",
      focal_length_mm: 35,
    }).project;
    project = applyDirectorAuthoringActions(project, [
      directorAuthoringActionSchema.parse({ action: "mark_camera_move", camera_id: CAMERA_ID, frame: 0 }),
    ]).project;
    project = frameShot(project, {
      size: "close-up",
      view: "front-quarter",
      side: "right",
      focal_length_mm: 35,
    }).project;
    return applyDirectorAuthoringActions(project, [
      directorAuthoringActionSchema.parse({ action: "mark_camera_move", camera_id: CAMERA_ID, frame: 48 }),
    ]).project;
  }

  it("names the move the marked track proves", () => {
    const report = describeDirectorCameraMoveFromProject(markedPushIn(), {
      camera_id: CAMERA_ID,
      subject_object_id: SUBJECT_ID,
    });
    expect(report.move).toBe("push-in");
    expect(report.from_frame).toBe(0);
    expect(report.to_frame).toBe(48);
    expect(String(report.phrase)).toContain("push-in");
    expect(Array.isArray(report.segments) && report.segments.length).toBe(1);
    const from = report.from as { size: string };
    const to = report.to as { size: string };
    expect(from.size).toBe("full");
    expect(to.size).toBe("close-up");
  });

  it("chains segment phrases across three marks in time order", () => {
    let project = markedPushIn();
    project = frameShot(project, { size: "close-up", view: "profile", side: "right", focal_length_mm: 35 }).project;
    project = applyDirectorAuthoringActions(project, [
      directorAuthoringActionSchema.parse({ action: "mark_camera_move", camera_id: CAMERA_ID, frame: 96 }),
    ]).project;

    const report = describeDirectorCameraMoveFromProject(project, {
      camera_id: CAMERA_ID,
      subject_object_id: SUBJECT_ID,
    });
    expect(Array.isArray(report.segments) && report.segments.length).toBe(2);
    expect(String(report.phrase)).toContain(", then ");

    const segments = report.segments as Array<{ move: string; from_frame: number; to_frame: number }>;
    expect(segments[0]).toMatchObject({ move: "push-in", from_frame: 0, to_frame: 48 });
    expect(segments[1].from_frame).toBe(48);
    expect(segments[1].to_frame).toBe(96);
    expect(segments[1].move).toMatch(/orbit/);
  });

  it("supports an explicit frame window over the marked track", () => {
    const report = describeDirectorCameraMoveFromProject(markedPushIn(), {
      camera_id: CAMERA_ID,
      subject_object_id: SUBJECT_ID,
      from_frame: 0,
      to_frame: 24,
    });
    expect(report.from_frame).toBe(0);
    expect(report.to_frame).toBe(24);
  });

  it("explains how to author marks when the track cannot prove a move", () => {
    const project = frameShot(stageWithHeroAndCamera(), { size: "full" }).project;
    expect(() =>
      describeDirectorCameraMoveFromProject(project, { camera_id: CAMERA_ID, subject_object_id: SUBJECT_ID }),
    ).toThrow(/mark_camera_move/);
  });
});
