import { Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";
import { createEmptyPlayerVehicleDriveInput } from "../../../../src/comprehensive/editor/player/playerInput";
import {
  getPlayerVehicleHudPhase,
  getVehicleChaseLookLead,
  getVehicleSeatWorldPosition,
  getVehicleSteerDirection,
  mapVehicleDriveControls,
  PLAYER_VEHICLE_ENTER_RANGE_M,
  selectNearestEnterableVehicle,
  selectVehicleExitPose,
  stepVehicleSteerSmoothing,
  VEHICLE_REVERSE_ENGAGE_SPEED_MPS,
  VEHICLE_STEER_ENGAGE_RATE_PER_S,
  VEHICLE_STEER_RECENTER_RATE_PER_S,
  type PlayerVehicleEnterCandidate,
} from "../../../../src/comprehensive/editor/player/playerVehicleSession";

function enterCandidate(id: string, x: number, z: number, enterable = true): PlayerVehicleEnterCandidate {
  return { id, enterable, seatPosition: [x, 1, z] };
}

it("selects the nearest enterable vehicle by horizontal seat distance", () => {
  const candidates = [enterCandidate("far", 0, 2.2), enterCandidate("near", 0.5, 0)];

  expect(selectNearestEnterableVehicle([0, 0, 0], candidates)).toBe("near");
});

it("ignores vehicles outside the enter range even when nothing is closer", () => {
  const justInside = enterCandidate("inside", PLAYER_VEHICLE_ENTER_RANGE_M, 0);
  const justOutside = enterCandidate("outside", PLAYER_VEHICLE_ENTER_RANGE_M + 0.01, 0);

  expect(selectNearestEnterableVehicle([0, 0, 0], [justOutside])).toBeNull();
  expect(selectNearestEnterableVehicle([0, 0, 0], [justOutside, justInside])).toBe("inside");
});

it("measures the enter range horizontally so a raised seat still prompts", () => {
  const elevated: PlayerVehicleEnterCandidate = { id: "raised", enterable: true, seatPosition: [1, 40, 0] };

  expect(selectNearestEnterableVehicle([0, 0, 0], [elevated])).toBe("raised");
});

it("skips non-enterable vehicles (missing or failed physics runtimes)", () => {
  const candidates = [enterCandidate("stub", 0.2, 0, false), enterCandidate("ready", 0, 1.5)];

  expect(selectNearestEnterableVehicle([0, 0, 0], candidates)).toBe("ready");
  expect(selectNearestEnterableVehicle([0, 0, 0], [enterCandidate("only-stub", 0.2, 0, false)])).toBeNull();
});

it("transforms the seat offset by the live vehicle pose", () => {
  const quarterTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  const seat = getVehicleSeatWorldPosition(new Vector3(10, 0, 5), quarterTurn, [1, 1, 0], new Vector3());

  // A +90° yaw sends local +X to world -Z, so the seat lands at z = 5 - 1.
  expect(seat.x).toBeCloseTo(10, 5);
  expect(seat.y).toBeCloseTo(1, 5);
  expect(seat.z).toBeCloseTo(4, 5);
});

it("ramps steering toward full lock at the engage rate", () => {
  let steer = 0;
  steer = stepVehicleSteerSmoothing(steer, 1, 0.1);
  expect(steer).toBeCloseTo(VEHICLE_STEER_ENGAGE_RATE_PER_S * 0.1, 5);

  // Saturates at +1 and stays there while held.
  for (let step = 0; step < 20; step += 1) steer = stepVehicleSteerSmoothing(steer, 1, 0.1);
  expect(steer).toBe(1);
});

it("re-centers released steering at the slower rate without crossing zero", () => {
  let steer = 1;
  steer = stepVehicleSteerSmoothing(steer, 0, 0.1);
  expect(steer).toBeCloseTo(1 - VEHICLE_STEER_RECENTER_RATE_PER_S * 0.1, 5);

  // A step larger than the remaining distance lands exactly on the target.
  steer = stepVehicleSteerSmoothing(0.05, 0, 0.1);
  expect(steer).toBe(0);
});

it("steers deterministically for identical input sequences", () => {
  const run = () => {
    let steer = 0;
    const trace: number[] = [];
    const directions: Array<-1 | 0 | 1> = [1, 1, 1, 0, -1, -1, 0, 0];
    for (const direction of directions) {
      steer = stepVehicleSteerSmoothing(steer, direction, 1 / 60);
      trace.push(steer);
    }
    return trace;
  };

  expect(run()).toEqual(run());
});

it("maps A/D to the contract's positive-left steer convention", () => {
  const input = createEmptyPlayerVehicleDriveInput();
  input.left = true;
  expect(getVehicleSteerDirection(input)).toBe(1);

  input.right = true;
  expect(getVehicleSteerDirection(input)).toBe(0);

  input.left = false;
  expect(getVehicleSteerDirection(input)).toBe(-1);
});

it("maps W to throttle and Space to the handbrake", () => {
  const input = createEmptyPlayerVehicleDriveInput();
  input.forward = true;
  input.handbrake = true;
  const controls = mapVehicleDriveControls({ input, steer: 0.4, forwardSpeedMps: 10 });

  expect(controls).toEqual({ throttle: 1, steer: 0.4, brake: 0, handbrake: true });
});

it("treats the S key as a service brake while rolling forward", () => {
  const input = createEmptyPlayerVehicleDriveInput();
  input.backward = true;
  const controls = mapVehicleDriveControls({
    input,
    steer: 0,
    forwardSpeedMps: VEHICLE_REVERSE_ENGAGE_SPEED_MPS + 0.01,
  });

  expect(controls.brake).toBe(1);
  expect(controls.throttle).toBe(0);
});

it("turns the S key into reverse throttle once (nearly) stopped", () => {
  const input = createEmptyPlayerVehicleDriveInput();
  input.backward = true;
  const stopped = mapVehicleDriveControls({ input, steer: 0, forwardSpeedMps: 0 });
  const reversing = mapVehicleDriveControls({ input, steer: 0, forwardSpeedMps: -3 });

  expect(stopped).toMatchObject({ throttle: -1, brake: 0 });
  expect(reversing).toMatchObject({ throttle: -1, brake: 0 });
});

it("lets the brake win over throttle at speed but the throttle win at a standstill", () => {
  const input = createEmptyPlayerVehicleDriveInput();
  input.forward = true;
  input.backward = true;

  const rolling = mapVehicleDriveControls({ input, steer: 0, forwardSpeedMps: 12 });
  expect(rolling).toMatchObject({ throttle: 1, brake: 1 });

  const stopped = mapVehicleDriveControls({ input, steer: 0, forwardSpeedMps: 0 });
  expect(stopped).toMatchObject({ throttle: 1, brake: 0 });
});

it("tries exit offsets in order and takes the first unblocked probe with ground", () => {
  const vehiclePosition = new Vector3(0, 0.5, 0);
  const identity = new Quaternion();
  const offsets: Array<[number, number, number]> = [
    [-1.6, 0.2, 0],
    [1.6, 0.2, 0],
    [0, 0.2, -2.6],
  ];
  const blockedProbes: Vector3[] = [];

  const exit = selectVehicleExitPose({
    exitOffsets: offsets,
    vehiclePosition,
    vehicleQuaternion: identity,
    // The left door (-X) is against a wall; everything else is free.
    isBlocked: (probe) => {
      blockedProbes.push(probe.clone());
      return probe.x < 0;
    },
    findGroundYBelow: () => 0,
  });

  expect(exit).not.toBeNull();
  expect(exit!.offsetIndex).toBe(1);
  expect(exit!.position).toEqual([1.6, 0, 0]);
  // Probe order matches the authored offsets: left door first.
  expect(blockedProbes[0]!.x).toBeCloseTo(-1.6, 5);
});

it("rejects exit probes whose ground is missing or too far below", () => {
  const vehiclePosition = new Vector3(0, 10, 0);
  const identity = new Quaternion();

  const noGround = selectVehicleExitPose({
    exitOffsets: [[-1.6, 0.2, 0]],
    vehiclePosition,
    vehicleQuaternion: identity,
    isBlocked: () => false,
    findGroundYBelow: () => null,
  });
  expect(noGround).toBeNull();

  const cliff = selectVehicleExitPose({
    exitOffsets: [[-1.6, 0.2, 0]],
    vehiclePosition,
    vehicleQuaternion: identity,
    isBlocked: () => false,
    findGroundYBelow: () => 0, // 10.2 m below the probe > 3 m allowance
  });
  expect(cliff).toBeNull();
});

it("rotates exit probes with the vehicle pose", () => {
  const halfTurn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  const exit = selectVehicleExitPose({
    exitOffsets: [[-1.6, 0.2, 0]],
    vehiclePosition: new Vector3(0, 0, 0),
    vehicleQuaternion: halfTurn,
    isBlocked: () => false,
    findGroundYBelow: () => 0,
  });

  expect(exit).not.toBeNull();
  expect(exit!.position[0]).toBeCloseTo(1.6, 5);
});

it("returns null when every exit probe is blocked so the driver stays seated", () => {
  const exit = selectVehicleExitPose({
    exitOffsets: [
      [-1.6, 0.2, 0],
      [1.6, 0.2, 0],
    ],
    vehiclePosition: new Vector3(0, 0, 0),
    vehicleQuaternion: new Quaternion(),
    isBlocked: () => true,
    findGroundYBelow: () => 0,
  });

  expect(exit).toBeNull();
});

it("derives the HUD phase from driving state and prompt proximity", () => {
  expect(getPlayerVehicleHudPhase({ driving: false, nearestEnterableVehicleId: null })).toBe("hidden");
  expect(getPlayerVehicleHudPhase({ driving: false, nearestEnterableVehicleId: "car" })).toBe("prompt");
  expect(getPlayerVehicleHudPhase({ driving: true, nearestEnterableVehicleId: null })).toBe("driving");
  // Driving wins even if another vehicle happens to be nearby.
  expect(getPlayerVehicleHudPhase({ driving: true, nearestEnterableVehicleId: "car" })).toBe("driving");
});

it("clamps the chase-camera look lead to forward travel", () => {
  expect(getVehicleChaseLookLead(0)).toBe(0);
  expect(getVehicleChaseLookLead(8)).toBeCloseTo(2, 5);
  expect(getVehicleChaseLookLead(100)).toBe(4);
  // Reversing never pulls the look target behind the car.
  expect(getVehicleChaseLookLead(-10)).toBe(0);
});
