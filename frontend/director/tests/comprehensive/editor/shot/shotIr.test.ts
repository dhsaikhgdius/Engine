import { describe, expect, it } from "vitest";
import type { DirectorCameraShot, DirectorObject, DirectorProject } from "../../../../src/comprehensive/editor/schema/directorProject";
import { buildDirectorShotIr } from "../../../../src/comprehensive/editor/shot/shotIr";

function createCamera(): DirectorCameraShot {
  return {
    id: "camera-main",
    name: "Main camera",
    fov: 40,
    aspectRatio: "16:9",
    action: { mode: "path", path: { speed: 1, lockTarget: false } },
    transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 2, 0],
    captures: [{ id: "capture-1", index: 1, name: "binary capture", dataUrl: "data:image/png;base64,AAAA" }],
    lastCaptureUrl: "blob:camera-capture",
    referenceBindings: [
      { id: "camera-safe", kind: "prompt", label: "Safe", ref: "camera-prompt" },
      { id: "camera-data", kind: "image", label: "Binary", ref: "data:image/png;base64,BBBB" },
    ],
    animation: {
      version: 1,
      keyframes: [
        {
          frame: 0,
          transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
          lookTarget: [0, 2, 0],
          fov: 40,
        },
        {
          frame: 24,
          transform: { position: [24, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
          lookTarget: [24, 2, 0],
          fov: 60,
        },
      ],
    },
  };
}

function createVisibleCharacter(): DirectorObject {
  return {
    id: "character-visible",
    name: "Visible actor",
    kind: "character",
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    assetRefId: "asset-actor",
    lookTargetObjectId: "prop-target",
    characterRig: {
      rigType: "mannequin",
      posePresetId: "neutral",
      controls: { arm: 0 },
      ik: {
        rightHand: {
          target: [0.8, 1.4, 0.3],
          pole: [0.6, 1.1, 0.9],
          weight: 0.75,
          reachClamp: 0.9,
        },
      },
    },
    referenceBindings: [
      { id: "safe-ref", kind: "action", label: "Walk", ref: "walk-cycle" },
      { id: "blob-ref", kind: "video", label: "Binary", ref: "blob:local-video" },
    ],
    animation: {
      version: 1,
      keyframes: [
        {
          frame: 0,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          poseValues: { arm: 0 },
        },
        {
          frame: 24,
          transform: { position: [24, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          poseValues: { arm: 1 },
        },
      ],
    },
  };
}

function createProject(): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#101820",
      panoramaYaw: 0,
      panoramaRadius: 60,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.9,
      groundHeight: 0,
      timeline: {
        version: 1,
        fps: 24,
        frameStart: 0,
        frameEnd: 24,
        currentFrame: 12,
        loop: false,
      },
    },
    assets: [
      {
        id: "asset-actor",
        kind: "character",
        sourceType: "model",
        fileName: "actor.glb",
        url: "blob:asset-binary",
      },
    ],
    objects: [
      createVisibleCharacter(),
      {
        id: "hidden-prop",
        name: "Hidden prop",
        kind: "prop",
        visible: false,
        locked: false,
        transform: { position: [99, 99, 99], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: "camera-object-proxy",
        name: "Camera proxy",
        kind: "camera",
        visible: true,
        locked: false,
        transform: { position: [1, 1, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
    cameras: [createCamera()],
    activeCameraId: "camera-main",
    panoramaAssetId: null,
  };
}

function addSharedTakeCoverage(project: DirectorProject): void {
  project.cameras.push({
    ...structuredClone(project.cameras[0]!),
    id: "camera-close",
    name: "Close coverage",
    focalLengthMm: 85,
    transform: { position: [3, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  project.production = {
    version: 1,
    activeTakeId: "take-performance",
    activeSequenceId: "sequence-coverage",
    takes: [
      {
        id: "take-performance",
        name: "Shared performance",
        frameStart: 0,
        frameEnd: 24,
        objectIds: ["character-visible"],
        entityTracks: [
          {
            id: "take-performance-character",
            objectId: "character-visible",
            animation: {
              version: 1,
              keyframes: [
                {
                  frame: 0,
                  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                  poseValues: { arm: 0 },
                },
                {
                  frame: 24,
                  transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                  poseValues: { arm: 1 },
                },
              ],
            },
          },
        ],
      },
    ],
    sequences: [
      {
        id: "sequence-coverage",
        name: "Coverage",
        shots: [
          {
            id: "coverage-wide",
            name: "Wide",
            takeId: "take-performance",
            cameraId: "camera-main",
            frameStart: 0,
            frameEnd: 24,
          },
          {
            id: "coverage-close",
            name: "Close",
            takeId: "take-performance",
            cameraId: "camera-close",
            frameStart: 0,
            frameEnd: 24,
          },
        ],
      },
    ],
  };
}

describe("buildDirectorShotIr", () => {
  it("is stable for the same evaluated shot and excludes hidden, camera, and binary payload data", () => {
    const project = createProject();

    const first = buildDirectorShotIr(project);
    const second = buildDirectorShotIr(project);

    expect(second).toEqual(first);
    expect(first.id).toBe("director-shot:camera-main:frame:12");
    expect(first.revisionFingerprint).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(first.objects.map((item) => item.id)).toEqual(["character-visible"]);
    expect(first.camera.referenceRefs).toEqual([{ id: "camera-safe", kind: "prompt", ref: "camera-prompt" }]);
    expect(first.objects[0]?.referenceRefs).toEqual([{ id: "safe-ref", kind: "action", ref: "walk-cycle" }]);
    expect(JSON.stringify(first)).not.toMatch(/data:|blob:|dataUrl|lastCaptureUrl/);
  });

  it("accepts a linked Stage camera-rig id and emits the canonical Director camera id", () => {
    const project = createProject();
    project.objects.push({
      id: "camera-main-rig",
      name: "Main camera rig",
      kind: "camera",
      visible: true,
      locked: false,
      transform: structuredClone(project.cameras[0]!.transform),
      linkedCameraId: "camera-main",
    });

    const shot = buildDirectorShotIr(project, { cameraId: "camera-main-rig", frame: 12 });

    expect(shot.camera.id).toBe("camera-main");
    expect(shot.id).toBe("director-shot:camera-main:frame:12");
  });

  it("evaluates object transforms, rig pose, camera transform, target, and optics at the same frame", () => {
    const shot = buildDirectorShotIr(createProject(), { frame: 12 });

    expect(shot.fps).toBe(24);
    expect(shot.frame).toBe(12);
    expect(shot.timeSeconds).toBe(0.5);
    expect(shot.objects[0]?.transform.position).toEqual([12, 0, 0]);
    expect(shot.objects[0]?.rigPose?.controls.arm).toBeCloseTo(0.5);
    expect(shot.objects[0]?.rigPose?.ik?.rightHand).toEqual({
      target: [0.8, 1.4, 0.3],
      pole: [0.6, 1.1, 0.9],
      weight: 0.75,
      reachClamp: 0.9,
    });
    expect(shot.camera.position).toEqual([12, 2, 3.84]);
    expect(shot.camera.target).toEqual([12, 2, 0]);
    expect(shot.camera.fov).toBe(50);
    expect(shot.camera.focalLengthMm).toBeCloseTo(21.713, 3);
    expect(shot.camera).toMatchObject({
      apertureFStop: 2.8,
      focusDistanceM: 5,
      shutterAngle: 180,
      iso: 800,
      nearClipM: 0.1,
      farClipM: 2_000,
      anamorphicSqueeze: 1,
    });
    expect(shot.camera.actionMode).toBe("path");
    expect(shot.camera.sensor).toEqual({
      format: "fullFrame",
      gateWidthMm: 36,
      gateHeightMm: 24,
      usedWidthMm: 36,
      usedHeightMm: 20.25,
    });
  });

  it("carries the authored physical sensor and its crop into the portable shot contract", () => {
    const project = createProject();
    project.cameras[0] = { ...project.cameras[0]!, sensorFormat: "super35" };

    const shot = buildDirectorShotIr(project, { frame: 12 });

    expect(shot.camera.sensor).toEqual({
      format: "super35",
      gateWidthMm: 24.89,
      gateHeightMm: 18.66,
      usedWidthMm: 24.89,
      usedHeightMm: 14.000625,
    });
    expect(shot.camera.focalLengthMm).toBeCloseTo(15.01, 2);
  });

  it("carries authored exposure, focus, clipping, and anamorphic metadata into Shot IR", () => {
    const project = createProject();
    project.cameras[0] = {
      ...project.cameras[0]!,
      apertureFStop: 1.4,
      focusDistanceM: 2.75,
      shutterAngle: 144,
      iso: 1_600,
      nearClipM: 0.02,
      farClipM: 8_000,
      anamorphicSqueeze: 1.8,
    };

    expect(buildDirectorShotIr(project, { frame: 12 }).camera).toMatchObject({
      apertureFStop: 1.4,
      focusDistanceM: 2.75,
      shutterAngle: 144,
      iso: 1_600,
      nearClipM: 0.02,
      farClipM: 8_000,
      anamorphicSqueeze: 1.8,
    });
  });

  it("changes the revision fingerprint when derived shot content changes", () => {
    const original = createProject();
    const modified = createProject();
    modified.objects[0] = { ...modified.objects[0], name: "Renamed actor" };

    expect(buildDirectorShotIr(modified).revisionFingerprint).not.toBe(
      buildDirectorShotIr(original).revisionFingerprint,
    );
  });

  it("reuses one take evaluation across independently lensed coverage shots", () => {
    const project = createProject();
    addSharedTakeCoverage(project);

    const wide = buildDirectorShotIr(project, { coverageShotId: "coverage-wide", frame: 12 });
    const close = buildDirectorShotIr(project, { coverageShotId: "coverage-close", frame: 12 });

    expect(wide.objects).toEqual(close.objects);
    expect(wide.objects[0]?.transform.position).toEqual([2, 0, 0]);
    expect(wide.camera.id).toBe("camera-main");
    expect(close.camera.id).toBe("camera-close");
    expect(wide.production).toEqual({
      takeId: "take-performance",
      sequenceId: "sequence-coverage",
      coverageShotId: "coverage-wide",
    });
    expect(close.production?.coverageShotId).toBe("coverage-close");
    expect(wide.id).toBe("director-shot:camera-main:take:take-performance:coverage:coverage-wide:frame:12");
    expect(close.revisionFingerprint).not.toBe(wide.revisionFingerprint);
    expect(project.objects[0]?.animation?.keyframes[1]?.transform?.position).toEqual([24, 0, 0]);
  });

  it("rejects inconsistent or missing production references without falling back", () => {
    const project = createProject();
    addSharedTakeCoverage(project);

    expect(() =>
      buildDirectorShotIr(project, {
        coverageShotId: "coverage-wide",
        cameraId: "camera-close",
        frame: 12,
      }),
    ).toThrow(/与请求的.*camera-close.*不一致/);
    expect(() => buildDirectorShotIr(project, { takeId: "missing-take", frame: 12 })).toThrow(
      /PerformanceTake.*missing-take.*不存在/,
    );
    expect(() => buildDirectorShotIr(project, { coverageShotId: "coverage-wide", frame: 25 })).toThrow(
      /不在 0-24 范围内/,
    );
  });

  it("reports missing cameras and invalid frames clearly", () => {
    const project = createProject();

    expect(() => buildDirectorShotIr(project, { cameraId: "missing-camera" })).toThrow(
      'ShotIR camera "missing-camera" does not exist in the project.',
    );
    expect(() => buildDirectorShotIr(project, { frame: 1.5 })).toThrow(
      "ShotIR frame must be a non-negative finite integer; received 1.5.",
    );
    expect(() => buildDirectorShotIr(project, { frame: -1 })).toThrow(
      "ShotIR frame must be a non-negative finite integer; received -1.",
    );
    expect(() => buildDirectorShotIr(project, { frame: 25 })).toThrow(
      "ShotIR frame 25 is outside the timeline range 0-24.",
    );
  });
});
