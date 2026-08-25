import { describe, expect, it } from "vitest";
import { createDefaultScene, DEFAULT_IDS } from "@director/stage-protocol";
import type { StageItem, StageScene } from "@director/stage-protocol";
import { describeStageCameraAction, stageSceneCameraFraming } from "../../promptExpansion/sceneFraming";

function cameraOf(scene: StageScene) {
  const camera = scene.objects[DEFAULT_IDS.camera];
  if (camera.kind !== "camera") throw new Error("default camera missing");
  return camera;
}

/** Default scene remodelled into a controlled front framing: subject at the
 * origin facing +Z, camera 2.4m in front at eye height on a 50mm lens. */
function frontFramedScene(): StageScene {
  const scene = createDefaultScene();
  const human = scene.objects[DEFAULT_IDS.human];
  human.position = [0, 0, 0];
  human.rotation = [0, 0, 0];
  scene.objects[DEFAULT_IDS.target].position = [0, 1.2, 0];
  const camera = cameraOf(scene);
  camera.position = [0, 1.6, 2.4];
  camera.focalLengthMm = 50;
  return scene;
}

describe("stageSceneCameraFraming", () => {
  it("reads a measured framing phrase from camera and subject geometry", () => {
    const scene = frontFramedScene();
    expect(stageSceneCameraFraming(scene, cameraOf(scene))).toBe(
      "close-up on a 50mm lens, eye level, seen squarely from the front, 2.4m from the subject",
    );
  });

  it("resolves mirrored Euler rotations to the true facing", () => {
    // The default scene stores the character's heading as (π, yaw, π); the
    // view/side must read from the effective facing, not the raw yaw value.
    const scene = createDefaultScene();
    expect(stageSceneCameraFraming(scene, cameraOf(scene))).toBe(
      "close-up on a 35mm lens, eye level, a three-quarter rear view from the subject's left, 1.9m from the subject",
    );
  });

  it("reads against the humanoid nearest the camera's aim point", () => {
    const scene = frontFramedScene();
    scene.objects["human-far"] = {
      ...structuredClone(scene.objects[DEFAULT_IDS.human]),
      position: [40, 0, 40],
    };
    expect(stageSceneCameraFraming(scene, cameraOf(scene))).toContain("2.4m from the subject");
  });

  it("returns null when the scene has no humanoid to frame", () => {
    const scene = frontFramedScene();
    delete scene.objects[DEFAULT_IDS.human];
    expect(stageSceneCameraFraming(scene, cameraOf(scene))).toBeNull();
  });
});

describe("describeStageCameraAction", () => {
  const base = { id: "item-1", startS: 0, durationS: 5 };
  const move = (patch: Partial<Extract<StageItem, { kind: "cam-move" }>>): StageItem => ({
    ...base,
    kind: "cam-move",
    move: "orbit",
    subjectId: null,
    direction: "ccw",
    angleDeg: 360,
    heightDeltaUnits: 0,
    distanceScale: 1,
    ...patch,
  });

  it("names every camera move with its direction and amplitude", () => {
    expect(describeStageCameraAction(move({}))).toBe("orbit left 360° around the subject @0.00s+5.00s");
    expect(describeStageCameraAction(move({ direction: "cw", angleDeg: 90, heightDeltaUnits: 1.2 }))).toBe(
      "orbit right 90° around the subject while rising 1.2m @0.00s+5.00s",
    );
    expect(describeStageCameraAction(move({ move: "dolly", distanceScale: 0.5 }))).toBe(
      "dolly in to 0.50x the starting distance @0.00s+5.00s",
    );
    expect(describeStageCameraAction(move({ move: "dolly", distanceScale: 1.6 }))).toBe(
      "dolly out to 1.60x the starting distance @0.00s+5.00s",
    );
    expect(describeStageCameraAction(move({ move: "truck", distanceScale: 2 }))).toBe(
      "truck 2.0m across the subject line @0.00s+5.00s",
    );
    expect(describeStageCameraAction(move({ move: "crane", heightDeltaUnits: -1.5 }))).toBe(
      "crane down 1.5m @0.00s+5.00s",
    );
    expect(describeStageCameraAction(move({ move: "pan", direction: "cw", angleDeg: 45 }))).toBe(
      "pan right 45° @0.00s+5.00s",
    );
  });

  it("describes stills, paths, and follows in plain language", () => {
    expect(describeStageCameraAction({ ...base, kind: "cam-still", focalLengthMm: 85 })).toBe(
      "hold a locked-off frame on a 85mm lens @0.00s+5.00s",
    );
    expect(describeStageCameraAction({ ...base, kind: "cam-still" })).toBe("hold a locked-off frame @0.00s+5.00s");
    expect(
      describeStageCameraAction({
        ...base,
        kind: "cam-path",
        points: [
          [0, 1, 0],
          [1, 1, 0],
          [2, 1, 1],
        ],
        speedUnitsPerS: 1,
        aim: "subject",
        subjectId: "human-1",
      }),
    ).toBe("travel a 3-point path aiming at the subject @0.00s+5.00s");
    expect(describeStageCameraAction({ ...base, kind: "cam-follow", objectId: "human-1" })).toBe(
      "follow the subject @0.00s+5.00s",
    );
  });

  it("keeps the raw kind for non-camera items", () => {
    expect(describeStageCameraAction({ ...base, kind: "clip", clip: "walk" })).toBe("clip @0.00s+5.00s");
  });
});
