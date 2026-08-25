import { Euler, Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";
import {
  CHARACTER_REFERENCE_HEIGHT,
  DIRECTOR_DEFAULT_CHARACTER_HEIGHT,
  FOLLOW_CAMERA_DEFAULTS,
  FOLLOW_CAMERA_MAX_DELTA_SECONDS,
  FOLLOW_GROUND_LIFT_FALL_RATE,
  FOLLOW_GROUND_LIFT_RISE_RATE,
  FOLLOW_PIVOT_SPRING_DAMPING,
  FOLLOW_PIVOT_SPRING_FREQ,
  FollowTargetVerticalSmoother,
  HERO_LOCOMOTION_DEFAULTS,
  applyFollowCameraZoomImpulse,
  computeFirstPersonCameraPose,
  computeThirdPersonCameraPose,
  deriveFollowCameraEntryPose,
  FOLLOW_ENTRY_PLAYABLE_DISTANCE_RATIO,
  getCharacterScaleFactor,
  getScaledPlayerConfig,
  resolveCharacterMovement,
  sampleFollowArmGroundLift,
  sanitizeFollowDelta,
  smoothCameraGroundFloor,
  stepAsymmetricExpDamp,
  stepCriticallyDampedSpring3,
  stepFollowCameraDistance,
  dampScalar,
} from "../../../../src/comprehensive/editor/player/characterFollowRuntime";

const CHARACTER_HEIGHT = DIRECTOR_DEFAULT_CHARACTER_HEIGHT;

function vector(tuple: [number, number, number]) {
  return new Vector3(tuple[0], tuple[1], tuple[2]);
}

function expectVectorClose(actual: [number, number, number], expected: Vector3, precision = 6) {
  expect(actual[0]).toBeCloseTo(expected.x, precision);
  expect(actual[1]).toBeCloseTo(expected.y, precision);
  expect(actual[2]).toBeCloseTo(expected.z, precision);
}

it("scales hero and follow defaults into Director metre space", () => {
  const scale = CHARACTER_HEIGHT / CHARACTER_REFERENCE_HEIGHT;
  const config = getScaledPlayerConfig(CHARACTER_HEIGHT);

  expect(config.walkSpeed).toBeCloseTo(HERO_LOCOMOTION_DEFAULTS.walkSpeed * scale, 6);
  expect(config.cameraDistance).toBeCloseTo(FOLLOW_CAMERA_DEFAULTS.followDistance * scale, 6);
  expect(config.cameraFollowHeight).toBeCloseTo(FOLLOW_CAMERA_DEFAULTS.followHeight * scale, 6);
  expect(config.cameraLookAtHeight).toBeCloseTo(FOLLOW_CAMERA_DEFAULTS.lookHeight * scale, 6);
  expect(config.cameraGroundClearance).toBeCloseTo(FOLLOW_CAMERA_DEFAULTS.groundClearance * scale, 6);
  expect(config.cameraGroundSoftness).toBeCloseTo(FOLLOW_CAMERA_DEFAULTS.groundSoftness * scale, 6);
  expect(config.pointerSensitivity).toBe(FOLLOW_CAMERA_DEFAULTS.pointerSensitivity);
});

it("doubles camera offsets when the hero is twice as tall", () => {
  const baseline = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT);
  const doubled = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT * 2);

  expect(getCharacterScaleFactor(DIRECTOR_DEFAULT_CHARACTER_HEIGHT * 2)).toBe(2);
  expect(doubled.cameraDistance).toBeCloseTo(baseline.cameraDistance * 2, 6);
  expect(doubled.cameraFollowHeight).toBeCloseTo(baseline.cameraFollowHeight * 2, 6);
  expect(doubled.cameraLookAtHeight).toBeCloseTo(baseline.cameraLookAtHeight * 2, 6);
  expect(doubled.cameraGroundClearance).toBeCloseTo(baseline.cameraGroundClearance * 2, 6);
  expect(doubled.cameraGroundSoftness).toBeCloseTo(baseline.cameraGroundSoftness * 2, 6);
  expect(doubled.playerRadius).toBeCloseTo(baseline.playerRadius * 2, 6);
  expect(doubled.acceleration).toBe(HERO_LOCOMOTION_DEFAULTS.acceleration);
  expect(doubled.decelerationAcceleration).toBe(HERO_LOCOMOTION_DEFAULTS.deceleration);
});

it("keeps exponential follow damping equivalent at 30, 60 and 144 Hz", () => {
  const simulateOneSecond = (refreshRate: number) => {
    let value = -3;
    for (let frame = 0; frame < refreshRate; frame += 1) {
      value = dampScalar(value, 11, 8, 1 / refreshRate);
    }
    return value;
  };

  const at30Hz = simulateOneSecond(30);
  expect(simulateOneSecond(60)).toBeCloseTo(at30Hz, 12);
  expect(simulateOneSecond(144)).toBeCloseTo(at30Hz, 12);
});

it("rejects invalid frame deltas and clamps a resumed-tab hitch", () => {
  expect(sanitizeFollowDelta(Number.NaN)).toBe(0);
  expect(sanitizeFollowDelta(Number.POSITIVE_INFINITY)).toBe(0);
  expect(sanitizeFollowDelta(-1 / 60)).toBe(0);
  expect(sanitizeFollowDelta(1)).toBe(FOLLOW_CAMERA_MAX_DELTA_SECONDS);

  expect(dampScalar(2, 9, 8, Number.NaN)).toBe(2);
  expect(dampScalar(2, 9, 8, -1)).toBe(2);
  expect(dampScalar(2, 9, 8, 1)).toBeCloseTo(dampScalar(2, 9, 8, FOLLOW_CAMERA_MAX_DELTA_SECONDS), 12);
});

it("applies a monotonic soft camera floor without crossing the safe height", () => {
  const config = getScaledPlayerConfig(CHARACTER_HEIGHT);
  const terrainY = 1.25;
  const safeFloor = terrainY + config.cameraGroundClearance;
  const desiredHeights = [-100, -2, safeFloor - 0.5, safeFloor, safeFloor + 0.5, 100];
  const resolvedHeights = desiredHeights.map((height) =>
    smoothCameraGroundFloor(height, safeFloor, config.cameraGroundSoftness),
  );

  expect(resolvedHeights.every((height) => height >= safeFloor)).toBe(true);
  expect(resolvedHeights[0]).toBe(safeFloor);
  for (let index = 1; index < resolvedHeights.length; index += 1) {
    expect(resolvedHeights[index]).toBeGreaterThanOrEqual(resolvedHeights[index - 1]);
  }
});

it("places the third-person camera behind Director's local +Z hero forward", () => {
  const config = getScaledPlayerConfig(CHARACTER_HEIGHT);
  const pose = computeThirdPersonCameraPose({
    targetPosition: [0, 0, 0],
    viewYaw: 0,
    viewPitch: 0.2,
    distance: config.cameraDistance,
    followHeight: config.cameraFollowHeight,
    lookHeight: config.cameraLookAtHeight,
    targetLead: config.cameraTargetLead,
  });

  const cameraFromTarget = vector(pose.position).sub(vector(pose.lookAt));
  expect(cameraFromTarget.dot(vector(pose.forward))).toBeLessThan(0);
  expect(pose.position[2]).toBeLessThan(0);
  expect(pose.lookAt[1]).toBeCloseTo(config.cameraLookAtHeight, 6);
});

it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])(
  "keeps a right-handed camera frame without up-vector flips at yaw %s",
  (yaw) => {
    const pose = computeThirdPersonCameraPose({
      targetPosition: [0, 0, 0],
      viewYaw: yaw,
      viewPitch: 0,
      distance: 5,
      followHeight: 2,
      lookHeight: 1,
      targetLead: 0.5,
    });
    const expectedForward = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    expectVectorClose(pose.forward, expectedForward);
    expect(vector(pose.position).sub(vector(pose.lookAt)).dot(vector(pose.forward))).toBeLessThan(0);
    expect(vector(pose.forward).cross(vector(pose.right)).normalize().dot(vector(pose.up))).toBeCloseTo(1, 6);
  },
);

it("transforms the follow basis through a rotated scene parent", () => {
  const parentRotation = new Quaternion().setFromEuler(new Euler(0.28, 0.73, -0.19));
  const referenceForward = new Vector3(0, 0, 1).applyQuaternion(parentRotation).normalize();
  const referenceRight = new Vector3(1, 0, 0).applyQuaternion(parentRotation).normalize();
  const referenceUp = new Vector3(0, 1, 0).applyQuaternion(parentRotation).normalize();
  const yaw = 0.41;
  const pose = computeThirdPersonCameraPose({
    targetPosition: [3, 2, -4],
    viewYaw: yaw,
    viewPitch: 0.1,
    distance: 5,
    followHeight: 2,
    lookHeight: 1,
    targetLead: 0.5,
    referenceFrame: {
      forward: referenceForward.toArray(),
      right: referenceRight.toArray(),
      up: referenceUp.toArray(),
    },
  });
  const expectedForward = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).applyQuaternion(parentRotation).normalize();

  expectVectorClose(pose.forward, expectedForward);
  expectVectorClose(pose.up, referenceUp);
  expect(vector(pose.position).sub(vector(pose.lookAt)).dot(expectedForward)).toBeLessThan(0);
  expect(vector(pose.forward).cross(vector(pose.right)).normalize().dot(vector(pose.up))).toBeCloseTo(1, 6);
});

it("aims first-person view along the same pitched world forward used for movement", () => {
  const parentRotation = new Quaternion().setFromEuler(new Euler(0.12, -0.52, 0.08));
  const yaw = 0.64;
  const pitch = -0.21;
  const expectedForward = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    .normalize()
    .applyQuaternion(parentRotation)
    .normalize();
  const pose = computeFirstPersonCameraPose({
    targetPosition: [2, 3, 4],
    forward: expectedForward.toArray(),
    forwardOffset: 0.25,
    lookDistance: 8,
  });
  const actualLookDirection = vector(pose.lookAt).sub(vector(pose.position)).normalize();

  expect(actualLookDirection.dot(expectedForward)).toBeCloseTo(1, 6);
  expect(
    vector(pose.position)
      .sub(new Vector3(2, 3, 4))
      .dot(expectedForward),
  ).toBeCloseTo(0.25, 6);
});

it("keeps high-resolution wheel zoom proportional instead of applying fixed steps", () => {
  const baseDistance = 5;
  const fineZoom = applyFollowCameraZoomImpulse({
    currentDistance: baseDistance,
    deltaY: 0.25,
    minDistance: 1,
    maxDistance: 20,
  });
  const restored = applyFollowCameraZoomImpulse({
    currentDistance: fineZoom,
    deltaY: -0.25,
    minDistance: 1,
    maxDistance: 20,
  });
  const lineZoom = applyFollowCameraZoomImpulse({
    currentDistance: baseDistance,
    deltaMode: 1,
    deltaY: 1,
    minDistance: 1,
    maxDistance: 20,
  });

  expect(fineZoom).toBeGreaterThan(baseDistance);
  expect(fineZoom - baseDistance).toBeLessThan(0.01);
  expect(restored).toBeCloseTo(baseDistance, 10);
  expect(lineZoom - baseDistance).toBeGreaterThan(fineZoom - baseDistance);
});

it("damps intentional zoom-in but contracts immediately for a real obstruction", () => {
  const zoomed = stepFollowCameraDistance({
    currentDistance: 6,
    safeDistance: 4,
    obstructed: false,
    snap: false,
    response: 8,
    delta: 1 / 60,
  });
  const obstructed = stepFollowCameraDistance({
    currentDistance: 6,
    safeDistance: 4,
    obstructed: true,
    snap: false,
    response: 8,
    delta: 1 / 60,
  });
  const released = stepFollowCameraDistance({
    currentDistance: 4,
    safeDistance: 6,
    obstructed: false,
    snap: false,
    response: 8,
    delta: 1 / 60,
  });

  expect(zoomed).toBeGreaterThan(4);
  expect(zoomed).toBeLessThan(6);
  expect(obstructed).toBe(4);
  expect(released).toBeGreaterThan(4);
  expect(released).toBeLessThan(6);
});

it("keeps scaled follow heights linear with character height (no quadratic drift)", () => {
  const scaleFactor = 2.5;
  const height = DIRECTOR_DEFAULT_CHARACTER_HEIGHT * scaleFactor;
  const config = getScaledPlayerConfig(height);
  const pose = computeThirdPersonCameraPose({
    targetPosition: [0, 0, 0],
    viewYaw: 0,
    viewPitch: 0,
    distance: config.cameraDistance,
    followHeight: config.cameraFollowHeight,
    lookHeight: config.cameraLookAtHeight,
    targetLead: config.cameraTargetLead,
  });

  const baseline = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT);
  expect(pose.lookAt[1]).toBeCloseTo(baseline.cameraLookAtHeight * scaleFactor, 6);
  expect(pose.position[1]).toBeCloseTo(baseline.cameraFollowHeight * scaleFactor, 6);
});

it("slides hero movement against blocking props", () => {
  const resolved = resolveCharacterMovement({
    currentPosition: [0, 0, 0],
    desiredPosition: [1, 0, 0],
    obstacles: [{ position: [0.6, 0, 0], radius: 0.5 }],
    radius: getScaledPlayerConfig(CHARACTER_HEIGHT).playerRadius,
  });

  expect(resolved[0]).toBeLessThan(1);
});

it("collides with yawed box props on their true world footprint, not its mirror", () => {
  const yaw = Math.PI / 4;
  // Long thin wall: local X is the long axis, rotated +45 degrees in world.
  const wall = { position: [0, 0, 0] as [number, number, number], halfX: 2, halfZ: 0.1, rotationY: yaw };
  // One metre along the wall's actual world long axis: inside the footprint.
  const onWall: [number, number, number] = [Math.cos(yaw), 0, -Math.sin(yaw)];
  // The same point mirrored across Z: on the rotated wall's clear side.
  const mirrored: [number, number, number] = [Math.cos(yaw), 0, Math.sin(yaw)];

  const blocked = resolveCharacterMovement({
    currentPosition: [2, 0, 2],
    desiredPosition: onWall,
    obstacles: [wall],
    radius: 0.3,
  });
  expect(blocked).not.toEqual(onWall);

  const free = resolveCharacterMovement({
    currentPosition: [2, 0, 2],
    desiredPosition: mirrored,
    obstacles: [wall],
    radius: 0.3,
  });
  expect(free).toEqual(mirrored);
});

it("smooths follow target height with deadband and snap logic", () => {
  const smoother = new FollowTargetVerticalSmoother();
  expect(
    smoother.step({
      signature: "a",
      rawTargetY: 1,
      delta: 0.016,
      deadband: 0.1,
      snapDistance: 2,
      walkLambda: 2,
      idleLambda: 8,
    }),
  ).toBe(1);
});

it("snaps the smoothed height exactly on a signature change", () => {
  const smoother = new FollowTargetVerticalSmoother();
  const params = { delta: 1 / 60, deadband: 0.18, snapDistance: 0.7, walkLambda: 2.4, idleLambda: 8 };
  smoother.step({ ...params, signature: "actor-a:third", rawTargetY: 0 });
  expect(smoother.step({ ...params, signature: "actor-a:first", rawTargetY: 5 })).toBe(5);
});

it("bounds vertical follow lag during a fast fall without a one-frame snapshot pop", () => {
  const smoother = new FollowTargetVerticalSmoother();
  const params = {
    signature: "a",
    delta: 1 / 60,
    stableLocomotion: false,
    deadband: 0.18,
    snapDistance: 0.7,
    walkLambda: 2.4,
    idleLambda: 8,
  };
  let raw = 10;
  let previous = smoother.step({ ...params, rawTargetY: raw });
  const rawStep = 9 / 60; // a 9 m/s fall outruns the idle damper
  let maxFrameStep = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    raw -= rawStep;
    const next = smoother.step({ ...params, rawTargetY: raw });
    maxFrameStep = Math.max(maxFrameStep, Math.abs(next - previous));
    // The smoothed height must never trail further than the snap distance...
    expect(Math.abs(raw - next)).toBeLessThanOrEqual(0.7 + 0.000001);
    previous = next;
  }
  // ...but catching up must stay continuous instead of jumping the whole
  // snap distance in a single frame.
  expect(maxFrameStep).toBeLessThan(0.3);
});

it("recovers a large same-signature height jump smoothly with bounded lag", () => {
  const smoother = new FollowTargetVerticalSmoother();
  const params = {
    signature: "a",
    delta: 1 / 60,
    stableLocomotion: false,
    deadband: 0.18,
    snapDistance: 0.7,
    walkLambda: 2.4,
    idleLambda: 8,
  };
  smoother.step({ ...params, rawTargetY: 0 });
  const afterJump = smoother.step({ ...params, rawTargetY: 100 });
  expect(afterJump).toBeGreaterThanOrEqual(99.3);
  expect(afterJump).toBeLessThan(100);
});

it("derives the roam entry orbit from the live editor camera", () => {
  const config = getScaledPlayerConfig(CHARACTER_HEIGHT);
  const pose = deriveFollowCameraEntryPose({
    actorPosition: [4, 0, -2],
    actorYaw: 0.4,
    cameraPosition: [4, config.cameraFollowHeight + 1.5, -2 + 6],
    characterHeight: CHARACTER_HEIGHT,
    fallbackDistance: config.cameraDistance,
    fallbackPitch: -0.12,
    maxPitch: 1.2,
    minPitch: -1.2,
  });

  expect(pose.derivedFromCamera).toBe(true);
  // Camera sits on the actor's +Z side, so the derived view forward is -Z.
  expect(Math.abs(Math.abs(pose.viewYaw) - Math.PI)).toBeLessThan(0.000001);
  expect(pose.viewPitch).toBeGreaterThan(0);
  expect(pose.viewPitch).toBeLessThan(0.5);
  expect(pose.preferredDistance).toBeCloseTo(Math.hypot(6, 1.5), 3);

  const roundTrip = computeThirdPersonCameraPose({
    targetPosition: [4, 0, -2],
    viewYaw: pose.viewYaw,
    viewPitch: pose.viewPitch,
    distance: pose.preferredDistance,
    followHeight: config.cameraFollowHeight,
    lookHeight: config.cameraLookAtHeight,
    targetLead: config.cameraTargetLead,
  });
  // Re-running the follow rig with the derived orbit must land near the
  // original editor camera so the mode switch reads as a continuous shot.
  expect(roundTrip.position[0]).toBeCloseTo(4, 1);
  expect(roundTrip.position[2]).toBeGreaterThan(-2 + 3);
});

it("keeps the derived entry distance inside the follow zoom range", () => {
  const reference = getScaledPlayerConfig(DIRECTOR_DEFAULT_CHARACTER_HEIGHT);
  const farAway = deriveFollowCameraEntryPose({
    actorPosition: [0, 0, 0],
    actorYaw: 0,
    cameraPosition: [0, 4, 500],
    characterHeight: CHARACTER_HEIGHT,
    fallbackDistance: reference.cameraDistance,
    fallbackPitch: -0.12,
    maxPitch: 1.2,
    minPitch: -1.2,
  });
  // Distant editor overviews ease to a playable follow distance; keeping the
  // raw 500 m orbit would shrink the actor into an unusable speck.
  expect(farAway.preferredDistance).toBeLessThanOrEqual(
    reference.cameraDistance * FOLLOW_ENTRY_PLAYABLE_DISTANCE_RATIO + 0.000001,
  );
  // Direction continuity survives the distance easing (camera stays on +Z).
  expect(Math.abs(Math.abs(farAway.viewYaw) - Math.PI)).toBeLessThan(0.000001);

  const scaledActor = deriveFollowCameraEntryPose({
    actorPosition: [0, 0, 0],
    actorYaw: 0,
    cameraPosition: [0, 4, 12],
    characterHeight: CHARACTER_HEIGHT * 2,
    fallbackDistance: reference.cameraDistance,
    fallbackPitch: -0.12,
    maxPitch: 1.2,
    minPitch: -1.2,
  });
  // Distances persist in default-character reference space; a taller actor
  // divides the measured world distance by its scale factor.
  expect(scaledActor.preferredDistance).toBeLessThan(12);
});

it("falls back to the authored facing for top-down or degenerate editor cameras", () => {
  const config = getScaledPlayerConfig(CHARACTER_HEIGHT);
  const topDown = deriveFollowCameraEntryPose({
    actorPosition: [1, 0, 1],
    actorYaw: 0.8,
    cameraPosition: [1, 40, 1],
    characterHeight: CHARACTER_HEIGHT,
    fallbackDistance: config.cameraDistance,
    fallbackPitch: -0.12,
    maxPitch: 1.2,
    minPitch: -1.2,
  });

  expect(topDown).toEqual({
    derivedFromCamera: false,
    preferredDistance: config.cameraDistance,
    viewPitch: -0.12,
    viewYaw: 0.8,
  });

  const invalid = deriveFollowCameraEntryPose({
    actorPosition: [0, 0, 0],
    actorYaw: 0.3,
    cameraPosition: [Number.NaN, 2, 4],
    characterHeight: CHARACTER_HEIGHT,
    fallbackDistance: config.cameraDistance,
    fallbackPitch: -0.12,
    maxPitch: 1.2,
    minPitch: -1.2,
  });
  expect(invalid.derivedFromCamera).toBe(false);
});

it("critically damps a pivot without overshooting a stationary target", () => {
  const position: [number, number, number] = [0, 0, 0];
  const velocity: [number, number, number] = [4, 0, -3];
  const target = [2, 1, 5] as const;
  for (let i = 0; i < 240; i += 1) {
    stepCriticallyDampedSpring3(
      position,
      velocity,
      target,
      FOLLOW_PIVOT_SPRING_FREQ,
      FOLLOW_PIVOT_SPRING_DAMPING,
      1 / 60,
    );
  }
  expect(position[0]).toBeCloseTo(2, 2);
  expect(position[1]).toBeCloseTo(1, 2);
  expect(position[2]).toBeCloseTo(5, 2);
  expect(Math.hypot(velocity[0], velocity[1], velocity[2])).toBeLessThan(0.05);
});

it("rises faster than it falls so a crest does not pop the lens back down", () => {
  const up = stepAsymmetricExpDamp(0, 1, FOLLOW_GROUND_LIFT_RISE_RATE, FOLLOW_GROUND_LIFT_FALL_RATE, 1 / 60);
  const down = stepAsymmetricExpDamp(1, 0, FOLLOW_GROUND_LIFT_RISE_RATE, FOLLOW_GROUND_LIFT_FALL_RATE, 1 / 60);
  expect(1 - down).toBeLessThan(up);
});

it("lifts the spring arm from the worst sample along the boom, not only the eye", () => {
  const need = sampleFollowArmGroundLift({
    pivot: [0, 2, 0],
    camera: [0, 1.1, -4],
    groundY: 0.8,
    clearance: 1.2,
  });
  expect(need).toBeGreaterThan(0.4);
});
