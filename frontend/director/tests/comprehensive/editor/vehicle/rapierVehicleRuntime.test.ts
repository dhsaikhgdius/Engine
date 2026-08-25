import RAPIER from "@dimforge/rapier3d-compat";
import { expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { createDefaultDirectorCarProfile } from "../../../../../../packages/protocol/src/vehicleProtocol";
import { createDirectorVehicleRuntime } from "../../../../src/comprehensive/editor/vehicle/rapierVehicleRuntime";
import type {
  DirectorVehicleControls,
  DirectorVehiclePose,
  DirectorVehicleRuntime,
} from "../../../../src/comprehensive/editor/vehicle/vehicleContracts";

let rapierReadyPromise: Promise<void> | null = null;

function ensureRapierReady() {
  rapierReadyPromise ??= RAPIER.init();
  return rapierReadyPromise;
}

const FRAME = 1 / 60;
const GROUND_HALF_SIZE = 150;
const GROUND_HALF_THICKNESS = 0.5;

function controlsWith(overrides: Partial<DirectorVehicleControls> = {}): DirectorVehicleControls {
  return { throttle: 0, steer: 0, brake: 0, handbrake: false, ...overrides };
}

function createPose(): DirectorVehiclePose {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    wheelPositions: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    wheelQuaternions: [new Quaternion(), new Quaternion(), new Quaternion(), new Quaternion()],
  };
}

/** Yaw of the chassis forward (+Z) axis; positive rotates +Z toward +X. */
function yawOf(pose: DirectorVehiclePose, scratch = new Vector3()) {
  scratch.set(0, 0, 1).applyQuaternion(pose.quaternion);
  return Math.atan2(scratch.x, scratch.z);
}

function upDotOf(pose: DirectorVehiclePose, scratch = new Vector3()) {
  return scratch.set(0, 1, 0).applyQuaternion(pose.quaternion).y;
}

async function createGroundedVehicle() {
  await ensureRapierReady();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(GROUND_HALF_SIZE, GROUND_HALF_THICKNESS, GROUND_HALF_SIZE).setTranslation(
      0,
      -GROUND_HALF_THICKNESS,
      0,
    ),
  );
  const runtime = createDirectorVehicleRuntime({
    profile: createDefaultDirectorCarProfile(),
    chassis: {
      // Sedan bounds: 2 m wide (x), 1.5 m tall (y), 4.4 m long (z = forward).
      halfExtents: new Vector3(1, 0.75, 2.2),
      // Spawn slightly above the suspension's rest height and let it settle.
      position: new Vector3(0, 1.4, 0),
      yawRadians: 0,
    },
    rapierWorld: world,
    rapier: RAPIER,
  });
  return { world, runtime };
}

function runSeconds(
  runtime: DirectorVehicleRuntime,
  controls: DirectorVehicleControls,
  seconds: number,
  onFrame?: () => void,
) {
  const frames = Math.round(seconds / FRAME);
  for (let frame = 0; frame < frames; frame += 1) {
    runtime.step(controls, FRAME);
    onFrame?.();
  }
}

it("accelerates straight and upright under full throttle, then brakes to a stop", async () => {
  const { world, runtime } = await createGroundedVehicle();
  try {
    runSeconds(runtime, controlsWith(), 0.8);
    const pose = createPose();
    runtime.readPose(pose);
    const startZ = pose.position.z;

    // Settled wheel poses mirror the tuning layout around the chassis.
    expect(pose.wheelPositions[0].x - pose.position.x).toBeCloseTo(0.82, 2);
    expect(pose.wheelPositions[1].x - pose.position.x).toBeCloseTo(-0.82, 2);
    expect(pose.wheelPositions[0].z - pose.position.z).toBeCloseTo(2.2 * 0.68, 2);
    expect(pose.wheelPositions[2].z - pose.position.z).toBeCloseTo(-(2.2 * 0.68), 2);
    for (const wheelPosition of pose.wheelPositions) expect(wheelPosition.y).toBeLessThan(pose.position.y);

    let frames = 0;
    let groundedFrames = 0;
    let minUpDot = 1;
    runSeconds(runtime, controlsWith({ throttle: 1 }), 3, () => {
      frames += 1;
      if (runtime.readTelemetry().onGroundWheelCount === 4) groundedFrames += 1;
      runtime.readPose(pose);
      minUpDot = Math.min(minUpDot, upDotOf(pose));
    });

    runtime.readPose(pose);
    expect(pose.position.z - startZ).toBeGreaterThanOrEqual(10);
    expect(Math.abs(pose.position.x)).toBeLessThan(2);
    expect(minUpDot).toBeGreaterThan(0.9);
    expect(groundedFrames / frames).toBeGreaterThan(0.85);
    const cruising = runtime.readTelemetry();
    expect(cruising.forwardSpeedMps).toBeGreaterThan(5);
    expect(cruising.speedKph).toBeGreaterThan(18);
    // Driving spun the wheels: their orientation departed from the chassis.
    expect(pose.wheelQuaternions[2].angleTo(pose.quaternion)).toBeGreaterThan(0.05);

    runSeconds(runtime, controlsWith({ brake: 1 }), 2.5);
    expect(Math.abs(runtime.readTelemetry().forwardSpeedMps)).toBeLessThan(1);
  } finally {
    runtime.dispose();
    world.free();
  }
});

it("yaws positive under positive steer at ~40 kph (+steer = +yaw, steering left)", async () => {
  const { world, runtime } = await createGroundedVehicle();
  try {
    runSeconds(runtime, controlsWith(), 0.8);
    runSeconds(runtime, controlsWith({ throttle: 1 }), 1.8);
    const beforeTurn = runtime.readTelemetry();
    expect(beforeTurn.speedKph).toBeGreaterThan(30);
    expect(beforeTurn.speedKph).toBeLessThan(55);

    const pose = createPose();
    runtime.readPose(pose);
    let previousYaw = yawOf(pose);
    let totalYawDelta = 0;
    let minUpDot = 1;
    runSeconds(runtime, controlsWith({ throttle: 0.4, steer: 0.6 }), 2, () => {
      runtime.readPose(pose);
      const yaw = yawOf(pose);
      let delta = yaw - previousYaw;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      totalYawDelta += delta;
      previousYaw = yaw;
      minUpDot = Math.min(minUpDot, upDotOf(pose));
    });

    // Contract sign: positive steer turns left = positive yaw around +Y.
    expect(totalYawDelta).toBeGreaterThanOrEqual(0.4);
    expect(minUpDot).toBeGreaterThan(0.8);
    expect(runtime.readTelemetry().speedKph).toBeGreaterThan(15);
  } finally {
    runtime.dispose();
    world.free();
  }
});

it("reset teleports the chassis to the requested pose and zeroes velocity", async () => {
  const { world, runtime } = await createGroundedVehicle();
  try {
    runSeconds(runtime, controlsWith(), 0.8);
    runSeconds(runtime, controlsWith({ throttle: 1 }), 1.5);
    expect(runtime.readTelemetry().forwardSpeedMps).toBeGreaterThan(4);

    runtime.reset(new Vector3(4, 1.35, -6), 0.7);
    const pose = createPose();
    runtime.readPose(pose);
    expect(pose.position.x).toBeCloseTo(4, 5);
    expect(pose.position.y).toBeCloseTo(1.35, 5);
    expect(pose.position.z).toBeCloseTo(-6, 5);
    expect(yawOf(pose)).toBeCloseTo(0.7, 5);
    const telemetry = runtime.readTelemetry();
    expect(telemetry.speedKph).toBeCloseTo(0, 6);
    expect(telemetry.forwardSpeedMps).toBeCloseTo(0, 6);

    // With no residual velocity the car settles in place instead of drifting.
    runSeconds(runtime, controlsWith(), 1);
    runtime.readPose(pose);
    expect(pose.position.x).toBeCloseTo(4, 1);
    expect(pose.position.z).toBeCloseTo(-6, 1);
    expect(upDotOf(pose)).toBeGreaterThan(0.99);
  } finally {
    runtime.dispose();
    world.free();
  }
});

function scriptedControls(frame: number): DirectorVehicleControls {
  if (frame < 90) return controlsWith({ throttle: 1 });
  if (frame < 150) return controlsWith({ throttle: 1, steer: 0.5 });
  if (frame < 210) return controlsWith({ throttle: 0.3, steer: -0.4, handbrake: true });
  return controlsWith({ brake: 0.8 });
}

async function runScriptedTelemetry() {
  const { world, runtime } = await createGroundedVehicle();
  try {
    const samples: number[] = [];
    for (let frame = 0; frame < 270; frame += 1) {
      runtime.step(scriptedControls(frame), FRAME);
      const telemetry = runtime.readTelemetry();
      samples.push(telemetry.speedKph, telemetry.forwardSpeedMps, telemetry.onGroundWheelCount);
    }
    return samples;
  } finally {
    runtime.dispose();
    world.free();
  }
}

it("produces bit-identical telemetry for two runs with identical inputs", async () => {
  const first = await runScriptedTelemetry();
  const second = await runScriptedTelemetry();
  expect(second).toEqual(first);
  // The scripted run actually drove somewhere; this was not a null test.
  expect(Math.max(...first)).toBeGreaterThan(5);
});

it("dispose removes the controller, collider, and body from the shared session world", async () => {
  await ensureRapierReady();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(GROUND_HALF_SIZE, GROUND_HALF_THICKNESS, GROUND_HALF_SIZE).setTranslation(
      0,
      -GROUND_HALF_THICKNESS,
      0,
    ),
  );
  const before = {
    bodies: world.bodies.len(),
    colliders: world.colliders.len(),
    controllers: world.vehicleControllers.size,
  };

  const runtime = createDirectorVehicleRuntime({
    profile: createDefaultDirectorCarProfile(),
    chassis: { halfExtents: new Vector3(1, 0.75, 2.2), position: new Vector3(0, 1.4, 0), yawRadians: 0 },
    rapierWorld: world,
    rapier: RAPIER,
  });
  try {
    expect(world.bodies.len()).toBe(before.bodies + 1);
    expect(world.colliders.len()).toBe(before.colliders + 1);
    expect(world.vehicleControllers.size).toBe(before.controllers + 1);

    runtime.dispose();
    expect(world.bodies.len()).toBe(before.bodies);
    expect(world.colliders.len()).toBe(before.colliders);
    expect(world.vehicleControllers.size).toBe(before.controllers);

    // Post-dispose calls are inert instead of touching freed physics objects.
    runtime.step(controlsWith({ throttle: 1 }), FRAME);
    expect(runtime.readTelemetry()).toEqual({ speedKph: 0, forwardSpeedMps: 0, onGroundWheelCount: 0 });
  } finally {
    runtime.dispose();
    world.free();
  }
});
