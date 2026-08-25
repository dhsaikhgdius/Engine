import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
  DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
  DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
  DEFAULT_DIRECTOR_CAMERA_ISO,
  DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  VIEWPORT_CAMERA_FRUSTUM_DEPTH,
  VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH,
  VIEWPORT_CAMERA_VISUAL_SCALE,
  getCameraRotationDegrees,
  getDirectorCameraUsedSensorHeight,
  getFocalLengthFromVerticalFov,
  getCameraRigPositionFromViewSnapshot,
  getCameraViewSnapshotFromShot,
  getVerticalFovFromFocalLength,
  normalizeDirectorCameraOptics,
} from "../../../../src/comprehensive/editor/schema/cameraGeometry";

it("places the camera viewing point on the 16:9 viewfinder frame", () => {
  const camera = createDefaultDirectorProject().cameras[0];
  const viewSnapshot = getCameraViewSnapshotFromShot(camera);

  expect(viewSnapshot.position[2]).toBeLessThan(camera.transform.position[2]);
  expect(viewSnapshot.target).toEqual(camera.target);
  expect(viewSnapshot.fov).toBe(camera.fov);
});

it("moves the camera rig behind a saved viewport snapshot", () => {
  const snapshot = {
    fov: 50,
    position: [0, 1.62, 3.8] as [number, number, number],
    target: [0, 1.2, 0] as [number, number, number],
  };
  const rigPosition = getCameraRigPositionFromViewSnapshot(snapshot);

  expect(rigPosition[2]).toBeGreaterThan(snapshot.position[2]);
  expect(rigPosition[2] - snapshot.position[2]).toBeGreaterThan(VIEWPORT_CAMERA_FRUSTUM_DEPTH * 0.9);
});

it("scales the viewport camera viewfinder from one visual scale", () => {
  expect(VIEWPORT_CAMERA_VISUAL_SCALE).toBeCloseTo(0.8);
  expect(VIEWPORT_CAMERA_FRUSTUM_DEPTH).toBeCloseTo(5.2 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH).toBeCloseTo(3.2 * VIEWPORT_CAMERA_VISUAL_SCALE);
});

it("uses Flick's 35mm 16:9 camera default and preserves the reference pose", () => {
  const camera = createDefaultDirectorProject().cameras[0]!;

  expect(camera.focalLengthMm).toBe(DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM);
  expect(camera.sensorFormat).toBe(DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT);
  expect(camera.aspectRatio).toBe("16:9");
  expect(camera.handheldShake).toBe("off");
  expect(normalizeDirectorCameraOptics(camera)).toEqual({
    apertureFStop: DEFAULT_DIRECTOR_CAMERA_APERTURE_F_STOP,
    focusDistanceM: DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
    shutterAngle: DEFAULT_DIRECTOR_CAMERA_SHUTTER_ANGLE,
    iso: DEFAULT_DIRECTOR_CAMERA_ISO,
    nearClipM: DEFAULT_DIRECTOR_CAMERA_NEAR_CLIP_M,
    farClipM: DEFAULT_DIRECTOR_CAMERA_FAR_CLIP_M,
    anamorphicSqueeze: DEFAULT_DIRECTOR_CAMERA_ANAMORPHIC_SQUEEZE,
  });
  expect(getCameraViewSnapshotFromShot(camera).position).toEqual([-0.843, 1.676, 0.675]);
  expect(getCameraRotationDegrees(camera)).toEqual([-8.658, -13.209, -1.993]);
  expect(DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.fov).toBeCloseTo(getVerticalFovFromFocalLength(35), 6);
});

it("normalizes external optical metadata and keeps the far plane beyond the near plane", () => {
  expect(
    normalizeDirectorCameraOptics({
      apertureFStop: 0,
      focusDistanceM: Number.NaN,
      shutterAngle: 999,
      iso: 1,
      nearClipM: 80,
      farClipM: 2,
      anamorphicSqueeze: 9,
    }),
  ).toEqual({
    apertureFStop: 0.7,
    focusDistanceM: DEFAULT_DIRECTOR_CAMERA_FOCUS_DISTANCE_M,
    shutterAngle: 360,
    iso: 25,
    nearClipM: 80,
    farClipM: 80.001,
    anamorphicSqueeze: 2.5,
  });
});

it("round-trips focal length through the vertical FOV used by Three.js", () => {
  const fov = getVerticalFovFromFocalLength(50, "2.39:1");

  expect(getFocalLengthFromVerticalFov(fov, "2.39:1")).toBeCloseTo(50, 2);
});

it.each(["super16", "super35", "fullFrame", "imax65"] as const)(
  "round-trips physical focal length on the %s sensor",
  (sensorFormat) => {
    const fov = getVerticalFovFromFocalLength(50, "16:9", sensorFormat);

    expect(getFocalLengthFromVerticalFov(fov, "16:9", sensorFormat)).toBeCloseTo(50, 2);
  },
);

it("crop-to-aspect never expands portrait or 4:3 beyond the physical full-frame gate", () => {
  expect(getDirectorCameraUsedSensorHeight("9:16", "fullFrame")).toBe(24);
  expect(getDirectorCameraUsedSensorHeight("4:3", "fullFrame")).toBe(24);
  expect(getDirectorCameraUsedSensorHeight("16:9", "fullFrame")).toBeCloseTo(20.25, 6);

  const portraitFov = getVerticalFovFromFocalLength(35, "9:16", "fullFrame");
  const fourThreeFov = getVerticalFovFromFocalLength(35, "4:3", "fullFrame");
  expect(portraitFov).toBeCloseTo(fourThreeFov, 6);
  expect(getFocalLengthFromVerticalFov(portraitFov, "9:16", "fullFrame")).toBeCloseTo(35, 2);
});
