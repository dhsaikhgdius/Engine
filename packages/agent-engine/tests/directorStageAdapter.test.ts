import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import {
  getEquivalentFullFrameFocalLength,
  getVerticalFovFromFocalLength,
} from "@director/project-schema";
import { getMannequinPosePreset } from "@director/project-schema";
import { createDefaultScene } from "@director/stage-protocol";
import { executeStageTool } from "../src/commandEngine";
import {
  directorProjectToStageScene,
  stageManagedDirectorObjectIds,
  stageSceneToDirectorProject,
} from "../src/directorStageAdapter";

describe("Director stage adapter", () => {
  it("migrates the agent-native stage into the comprehensive editor", () => {
    const stage = createDefaultScene();
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());

    expect(project.objects.find((object) => object.id === "human-1")).toMatchObject({
      kind: "character",
      name: "人物 1",
    });
    expect(project.objects.some((object) => object.id === "char_default_a")).toBe(false);
    expect(project.cameras.find((camera) => camera.id === "camera-1")?.animation?.keyframes.length).toBeGreaterThan(8);
    expect(project.scene.backgroundColor).toBe("#c9cdd3");
    expect(project.scene.timeline?.frameEnd).toBeGreaterThanOrEqual(120);
  });

  it("projects comprehensive edits back to the existing MCP scene contract", () => {
    const initialStage = createDefaultScene();
    const project = stageSceneToDirectorProject(initialStage, createDefaultDirectorProject());
    const character = project.objects.find((object) => object.kind === "character")!;
    character.name = "主角";
    character.transform.position = [2, 0, -3];

    const projected = directorProjectToStageScene(project, initialStage, "9:16");

    expect(projected.recordAspect).toBe("9:16");
    expect(projected.objects[character.id]).toMatchObject({
      kind: "humanoid",
      name: "主角",
      position: [2, 0, -3],
    });
    expect(stageManagedDirectorObjectIds(projected)).toContain(character.id);
  });

  it("keeps character IK metadata across the legacy Stage projection", () => {
    const stage = createDefaultScene();
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    const character = project.objects.find((object) => object.kind === "character")!;
    character.characterRig!.ik = {
      leftHand: {
        target: [-0.8, 1.4, 0.3],
        pole: [-0.65, 1.1, 0.9],
        weight: 0.8,
        reachClamp: 0.95,
      },
    };

    const projected = directorProjectToStageScene(project, stage, "16:9");
    const restored = stageSceneToDirectorProject(projected, project);
    expect(restored.objects.find((object) => object.id === character.id)?.characterRig?.ik).toEqual(
      character.characterRig?.ik,
    );
  });

  it("keeps character skeletal motion across the legacy Stage projection", () => {
    const stage = createDefaultScene();
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    const character = project.objects.find((object) => object.kind === "character")!;
    character.characterRig!.motion = {
      clipId: "walk",
      enabled: true,
      loop: "repeat",
      speed: 1.25,
      weight: 0.8,
      startFrame: 12,
      blendInS: 0.2,
      blendOutS: 0.1,
      rootMotion: "in-place",
    };

    const projected = directorProjectToStageScene(project, stage, "16:9");
    const restored = stageSceneToDirectorProject(projected, project);
    expect(restored.objects.find((object) => object.id === character.id)?.characterRig?.motion).toEqual(
      character.characterRig?.motion,
    );
  });

  it("materializes Stage pose labels into runtime controls, including legacy empty-control rigs", () => {
    const stage = createDefaultScene();
    const stageCharacter = stage.objects["human-1"];
    if (!stageCharacter || stageCharacter.kind !== "humanoid") throw new Error("Expected default humanoid");
    stageCharacter.pose = "wave";

    const firstPass = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    const firstCharacter = firstPass.objects.find((object) => object.id === "human-1")!;
    expect(firstCharacter.characterRig).toMatchObject({
      posePresetId: "wave",
      controls: getMannequinPosePreset("wave")!.controls,
    });

    firstCharacter.characterRig = {
      rigType: "mixamo",
      posePresetId: "wave",
      controls: {},
    };
    const restoredLegacy = stageSceneToDirectorProject(stage, firstPass);
    expect(restoredLegacy.objects.find((object) => object.id === "human-1")?.characterRig).toMatchObject({
      posePresetId: "wave",
      controls: getMannequinPosePreset("wave")!.controls,
    });

    stageCharacter.pose = "sit";
    const changedPose = stageSceneToDirectorProject(stage, restoredLegacy);
    expect(changedPose.objects.find((object) => object.id === "human-1")?.characterRig).toMatchObject({
      posePresetId: "sit",
      controls: getMannequinPosePreset("sit")!.controls,
    });
  });

  it("preserves the physical focal length across Director and Stage projections", () => {
    const stage = createDefaultScene();
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    const camera = project.cameras.find((candidate) => candidate.id === "camera-1")!;
    camera.focalLengthMm = 50;
    camera.aspectRatio = "16:9";
    camera.fov = getVerticalFovFromFocalLength(50, "16:9");

    const projected = directorProjectToStageScene(project, stage, "16:9");
    expect(projected.objects["camera-1"]).toMatchObject({
      kind: "camera",
      focalLengthMm: 50,
    });

    const roundTripped = stageSceneToDirectorProject(projected, createDefaultDirectorProject());
    expect(roundTripped.cameras.find((candidate) => candidate.id === "camera-1")).toMatchObject({
      focalLengthMm: 50,
      aspectRatio: "16:9",
      fov: getVerticalFovFromFocalLength(50, "16:9"),
    });
  });

  it("preserves cinematic camera aspect ratios in the Stage projection", () => {
    const stage = createDefaultScene();
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    const projected = directorProjectToStageScene(project, stage, "2.39:1");

    expect(projected.recordAspect).toBe("2.39:1");
    expect(stageSceneToDirectorProject(projected, createDefaultDirectorProject()).cameras[0]?.aspectRatio).toBe(
      "2.39:1",
    );
  });

  it("projects a non-full-frame shot as an equivalent full-frame Stage focal length", () => {
    const stage = createDefaultScene();
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    const camera = project.cameras.find((candidate) => candidate.id === "camera-1")!;
    camera.sensorFormat = "super35";
    camera.focalLengthMm = 35;
    camera.aspectRatio = "4:3";
    camera.fov = getVerticalFovFromFocalLength(35, "4:3", "super35");
    const equivalentFullFrameFocal = getEquivalentFullFrameFocalLength(camera);

    const projected = directorProjectToStageScene(project, stage, "4:3");
    expect(projected.objects["camera-1"]).toMatchObject({
      kind: "camera",
      focalLengthMm: equivalentFullFrameFocal,
    });

    const roundTripped = stageSceneToDirectorProject(projected, createDefaultDirectorProject());
    const restoredCamera = roundTripped.cameras.find((candidate) => candidate.id === "camera-1")!;
    expect(restoredCamera.sensorFormat).toBe("fullFrame");
    expect(restoredCamera.fov).toBeCloseTo(camera.fov, 4);
  });

  it("preserves expanded white-box primitive geometry across the adapter", () => {
    const stage = createDefaultScene();
    stage.objects["column-1"] = {
      kind: "cylinder",
      name: "圆柱",
      position: [1, 0, 2],
      rotation: [0, 0, 0],
      scale: [0.5, 3, 0.5],
    };
    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    expect(project.objects.find((object) => object.id === "column-1")?.geometryType).toBe("cylinder");
    expect(directorProjectToStageScene(project, stage, "16:9").objects["column-1"]?.kind).toBe("cylinder");
  });

  it("clears example storyboard and animation content when the stage resets to a blank white-box", () => {
    const populatedStage = createDefaultScene();
    const populatedProject = stageSceneToDirectorProject(populatedStage, createDefaultDirectorProject());
    populatedProject.storyboard = {
      version: 1,
      title: "示例分镜",
      logline: "旧内容",
      shots: [
        {
          id: "example-shot",
          title: "示例镜头",
          cameraId: populatedProject.cameras[0]?.id ?? null,
          frameStart: 0,
          frameEnd: 120,
          shotSize: "wide",
          movement: "push-in",
          action: "旧动作",
        },
      ],
    };
    const populatedStageObjectIds = stageManagedDirectorObjectIds(populatedStage);
    const resetStage = executeStageTool(populatedStage, "stage_scene", {
      op: "reset",
      name: "未命名白膜场景",
      aspect: "16:9",
      with_camera: true,
    }).scene;

    const resetProject = stageSceneToDirectorProject(resetStage, populatedProject, populatedStageObjectIds);

    expect(resetProject.storyboard?.shots).toEqual([]);
    expect(resetProject.cameras).toHaveLength(1);
    expect(resetProject.cameras[0]?.animation).toBeUndefined();
    expect(resetProject.scene.timeline).toMatchObject({
      frameStart: 0,
      frameEnd: 240,
      currentFrame: 0,
      loop: false,
    });
  });

  it("preserves Follow camera intent between the agent stage and the Flick-style editor", () => {
    const stage = createDefaultScene();
    const cameraTrack = stage.show.tracks.find((track) => track.characterId === "camera-1");
    expect(cameraTrack).toBeTruthy();
    cameraTrack!.items = [
      {
        id: "follow-item",
        kind: "cam-follow",
        startS: 0,
        durationS: 5,
        objectId: "human-1",
      },
    ];

    const project = stageSceneToDirectorProject(stage, createDefaultDirectorProject());
    expect(project.cameras.find((camera) => camera.id === "camera-1")?.action).toMatchObject({
      mode: "follow",
      follow: { targetObjectId: "human-1" },
    });

    const local = createDefaultDirectorProject();
    local.cameras[0].action = {
      mode: "follow",
      follow: {
        targetObjectId: "char_default_a",
        positionOffset: [1, 2, 3],
        targetOffset: [0, 1, 0],
      },
    };
    const roundTrip = directorProjectToStageScene(local, createDefaultScene(), "16:9");
    expect(roundTrip.show.tracks.find((track) => track.characterId === "cam_object_1")?.items[0]).toMatchObject({
      kind: "cam-follow",
      objectId: "char_default_a",
    });
  });
});
