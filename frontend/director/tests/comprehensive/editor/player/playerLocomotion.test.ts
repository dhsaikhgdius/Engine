import { expect, it } from "vitest";
import {
  createPlayerLocomotionState,
  getPlayerForward,
  getPlayerMoveAxes,
  getPlayerMovementFacingYaw,
  getPlayerRight,
  getThirdPersonCameraDistance,
  hasWalkableMeshPlayerEnvironment,
  PLAYER_CONTROLLER_CONFIG,
  PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
  resolvePlayerRoamGroundEnabled,
  settlePlayerLocomotionOntoGround,
  shouldShowThirdPersonPlayer,
  stepPlayerLocomotion,
} from "../../../../src/comprehensive/editor/player/playerLocomotion";

const noInput = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
  jump: false,
  descend: false,
};

it("moves in the player facing direction and accelerates for sprint", () => {
  const state = createPlayerLocomotionState([0, 0, 0], 0);
  const walking = stepPlayerLocomotion({
    state,
    input: { ...noInput, forward: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  const running = stepPlayerLocomotion({
    state,
    input: { ...noInput, forward: true, sprint: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });

  expect(walking.position[2]).toBeGreaterThan(0);
  expect(running.position[2]).toBeGreaterThan(walking.position[2]);
});

it("scales planar walk speed from the view-controls character speed multiplier", () => {
  const input = { ...noInput, forward: true };
  const baseline = stepPlayerLocomotion({
    state: createPlayerLocomotionState([0, 0, 0], 0),
    input,
    delta: 0.2,
    groundHeight: 0,
    obstacles: [],
  });
  const faster = stepPlayerLocomotion({
    state: createPlayerLocomotionState([0, 0, 0], 0),
    input,
    delta: 0.2,
    groundHeight: 0,
    obstacles: [],
    speedScale: 2,
  });

  expect(faster.position[2]).toBeGreaterThan(baseline.position[2]);
  expect(faster.velocity[2]).toBeGreaterThan(baseline.velocity[2]);
});

it("does not treat a hidden visual ground as a legacy physics floor", () => {
  let state = createPlayerLocomotionState([0, 0.1, 0], 0, 0);
  for (let index = 0; index < 30; index += 1) {
    state = stepPlayerLocomotion({
      state,
      input: noInput,
      delta: 1 / 60,
      groundEnabled: false,
      groundHeight: 0,
      obstacles: [],
    });
  }
  expect(state.position[1]).toBeLessThan(0);
  expect(state.onGround).toBe(false);
});

it("keeps an empty stage walkable even when the visual ground is hidden", () => {
  expect(
    resolvePlayerRoamGroundEnabled({
      showGround: false,
      hasWalkableMeshEnvironment: hasWalkableMeshPlayerEnvironment([], 0),
    }),
  ).toBe(true);
  expect(
    resolvePlayerRoamGroundEnabled({
      showGround: false,
      hasWalkableMeshEnvironment: hasWalkableMeshPlayerEnvironment(
        [{ id: "prop", position: [0, 0, 0], radius: 0, shape: "mesh" }],
        0,
      ),
    }),
  ).toBe(true);
  expect(
    resolvePlayerRoamGroundEnabled({
      showGround: false,
      hasWalkableMeshEnvironment: hasWalkableMeshPlayerEnvironment([], 3),
    }),
  ).toBe(false);
  expect(
    resolvePlayerRoamGroundEnabled({
      showGround: true,
      hasWalkableMeshEnvironment: true,
    }),
  ).toBe(true);
});

it("settles a floating roam spawn onto the Director plane instead of dropping", () => {
  const settled = settlePlayerLocomotionOntoGround(createPlayerLocomotionState([0, 2, 0], 0, 0), {
    groundEnabled: true,
    groundHeight: 0,
    obstacles: [],
  });
  expect(settled.position[1]).toBe(0);
  expect(settled.onGround).toBe(true);
  expect(settled.velocity[1]).toBe(0);
});

it("prefers a walkable platform underfoot over the fallback plane", () => {
  const settled = settlePlayerLocomotionOntoGround(createPlayerLocomotionState([0, 2, 0], 0, 0), {
    groundEnabled: true,
    groundHeight: 0,
    obstacles: [
      {
        id: "platform",
        position: [0, 0, 0],
        radius: 1,
        shape: "box",
        halfExtents: [1, 1],
        halfHeight: 0.4,
        walkableSurface: true,
      },
    ],
  });
  expect(settled.position[1]).toBeCloseTo(0.8, 6);
  expect(settled.onGround).toBe(true);
});

it("does not pull a grounded mesh spawn down onto the fallback plane", () => {
  const rooftop = {
    ...createPlayerLocomotionState([0, 10, 0], 0, 0),
    onGround: true,
  };
  const settled = settlePlayerLocomotionOntoGround(rooftop, {
    groundEnabled: true,
    groundHeight: 0,
    maxBelow: PLAYER_ROAM_SPAWN_SNAP_BELOW_M,
    obstacles: [],
  });
  expect(settled.position[1]).toBe(10);
  expect(settled.onGround).toBe(true);
});

it("does not settle a flying roam spawn onto the ground", () => {
  const flying = { ...createPlayerLocomotionState([0, 2, 0], 0, 0), flying: true };
  const settled = settlePlayerLocomotionOntoGround(flying, {
    groundEnabled: true,
    groundHeight: 0,
    obstacles: [],
  });
  expect(settled.position[1]).toBe(2);
  expect(settled.flying).toBe(true);
});

it("jumps from the ground and settles safely back onto it", () => {
  let state = createPlayerLocomotionState([0, 0, 0]);
  state = stepPlayerLocomotion({
    state,
    input: { ...noInput, jump: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  expect(state.position[1]).toBeGreaterThan(0);
  expect(state.onGround).toBe(false);

  for (let index = 0; index < 80; index += 1) {
    state = stepPlayerLocomotion({ state, input: noInput, delta: 0.05, groundHeight: 0, obstacles: [] });
  }
  expect(state.position[1]).toBe(0);
  expect(state.onGround).toBe(true);
});

it("clamps a falling actor onto the Director plane even when that frame is not grounded", () => {
  let state = {
    ...createPlayerLocomotionState([0, 1.07, 0], 0, 0),
    onGround: false,
    velocity: [0, -8, 0] as [number, number, number],
  };
  for (let index = 0; index < 30; index += 1) {
    state = stepPlayerLocomotion({
      state,
      input: noInput,
      delta: 1 / 60,
      groundEnabled: true,
      groundHeight: 0,
      obstacles: [],
    });
    expect(state.position[1]).toBeGreaterThanOrEqual(0);
  }
  expect(state.position[1]).toBe(0);
  expect(state.onGround).toBe(true);
});

it("accepts coyote-time jumps and buffers a jump pressed just before landing", () => {
  const airborne = {
    ...createPlayerLocomotionState([0, 0.2, 0]),
    coyoteTimeRemaining: 0.06,
    onGround: false,
  };
  const coyoteJump = stepPlayerLocomotion({
    state: airborne,
    input: { ...noInput, jump: true },
    delta: 1 / 60,
    groundHeight: 0,
    obstacles: [],
  });
  expect(coyoteJump.velocity[1]).toBeGreaterThan(0);

  let buffered = {
    ...createPlayerLocomotionState([0, 0.05, 0]),
    onGround: false,
    velocity: [0, -2, 0] as [number, number, number],
  };
  buffered = stepPlayerLocomotion({
    state: buffered,
    input: { ...noInput, jump: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  // Fixed substeps land and consume the queued jump within this render frame.
  expect(buffered.velocity[1]).toBeGreaterThan(0);
  expect(buffered.onGround).toBe(false);
});

it("keeps the player capsule outside nearby scene objects", () => {
  const next = stepPlayerLocomotion({
    state: createPlayerLocomotionState([0, 0, 0]),
    input: { ...noInput, forward: true, sprint: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [{ position: [0, 0, 0.22], radius: 0.45 }],
  });

  expect(Math.hypot(next.position[0], next.position[2] - 0.22)).toBeGreaterThanOrEqual(
    0.45 + PLAYER_CONTROLLER_CONFIG.playerRadius - 0.00001,
  );
  expect(Math.hypot(next.velocity[0], next.velocity[2])).toBeLessThan(0.6);
});

it("uses fixed simulation steps so a long frame matches normal render frames", () => {
  const input = { ...noInput, forward: true, right: true, sprint: true };
  const start = createPlayerLocomotionState([0, 0, 0], 0.4);
  const longFrame = stepPlayerLocomotion({
    state: start,
    input,
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  let normalFrames = start;
  for (let index = 0; index < 3; index += 1) {
    normalFrames = stepPlayerLocomotion({
      state: normalFrames,
      input,
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [],
    });
  }

  expect(longFrame.position[0]).toBeCloseTo(normalFrames.position[0], 8);
  expect(longFrame.position[2]).toBeCloseTo(normalFrames.position[2], 8);
  expect(longFrame.velocity[0]).toBeCloseTo(normalFrames.velocity[0], 8);
  expect(longFrame.velocity[2]).toBeCloseTo(normalFrames.velocity[2], 8);
});

it("recovers safely when a player is spawned inside a static prop", () => {
  const next = stepPlayerLocomotion({
    state: createPlayerLocomotionState([0, 0, 0]),
    input: noInput,
    delta: 1 / 60,
    groundHeight: 0,
    obstacles: [{ position: [0, 0, 0], radius: 0.5 }],
  });

  expect(Math.hypot(next.position[0], next.position[2])).toBeGreaterThanOrEqual(
    0.5 + PLAYER_CONTROLLER_CONFIG.playerRadius - 0.00001,
  );
});

it("does not eject a player across a large walkable floor during the Rapier warmup frame", () => {
  const initial = createPlayerLocomotionState([1, 1.36, 2]);
  const next = stepPlayerLocomotion({
    state: initial,
    input: noInput,
    delta: 1 / 60,
    groundHeight: 0,
    obstacles: [
      {
        position: [0, -0.4, 0],
        radius: Math.hypot(450, 450),
        shape: "box",
        halfExtents: [450, 450],
        halfHeight: 0.2,
      },
    ],
  });

  expect(next.position[0]).toBeCloseTo(initial.position[0], 6);
  expect(next.position[2]).toBeCloseTo(initial.position[2], 6);
});

it("keeps a supported player on a thin road during the Rapier warmup frame", () => {
  const initial = createPlayerLocomotionState([-7, 0.081, 320], Math.PI, 0);
  let next = initial;
  for (let frame = 0; frame < 12; frame += 1) {
    next = stepPlayerLocomotion({
      state: next,
      input: noInput,
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [
        {
          id: "city-road",
          position: [0, 0, 0],
          radius: Math.hypot(12, 450),
          shape: "box",
          halfExtents: [12, 450],
          halfHeight: 0.04,
          walkableSurface: true,
        },
      ],
    });
  }

  expect(next.position[0]).toBeCloseTo(initial.position[0], 6);
  expect(next.position[1]).toBeCloseTo(0.08, 6);
  expect(next.position[2]).toBeCloseTo(initial.position[2], 6);
  expect(next.onGround).toBe(true);
});

it("respects a scaled character collision radius", () => {
  const next = stepPlayerLocomotion({
    state: createPlayerLocomotionState([0, 0, 0]),
    input: { ...noInput, forward: true },
    delta: 1 / 60,
    groundHeight: 0,
    obstacles: [{ position: [0, 0, 0.4], radius: 0.45 }],
    playerRadius: 0.68,
  });

  expect(Math.hypot(next.position[0], next.position[2] - 0.4)).toBeGreaterThanOrEqual(1.13 - 0.00001);
});

it("slides along a rotated-box collider without entering it", () => {
  let state = createPlayerLocomotionState([0, 0, 0]);
  const obstacle = {
    position: [0, 0, 1] as [number, number, number],
    radius: Math.hypot(1, 0.2),
    shape: "box" as const,
    halfExtents: [1, 0.2] as [number, number],
    yaw: 0,
  };

  for (let index = 0; index < 60; index += 1) {
    state = stepPlayerLocomotion({
      state,
      input: { ...noInput, forward: true, right: true },
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [obstacle],
    });
  }

  expect(state.position[0]).toBeLessThan(-0.35);
  expect(state.position[2]).toBeLessThanOrEqual(0.65);
  expect(state.velocity[0]).toBeLessThan(0);
  expect(Math.abs(state.velocity[2])).toBeLessThan(1.5);
});

it("supports vertical flight and shortens a third-person camera before an obstacle", () => {
  const state = { ...createPlayerLocomotionState([0, 0, 0]), flying: true };
  const next = stepPlayerLocomotion({
    state,
    input: { ...noInput, jump: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });

  expect(next.position[1]).toBeGreaterThan(0);
  expect(getThirdPersonCameraDistance([0, 0, 0], 0, [{ position: [0, 0, -2], radius: 0.6 }], 4.8)).toBeLessThan(4.8);
  expect(getThirdPersonCameraDistance([0, 0, 0], Math.PI, [{ position: [0, 0, -2], radius: 0.6 }], 4.8)).toBe(4.8);
});

it("outruns sprint during a dash burst on the ground", () => {
  let state = createPlayerLocomotionState([0, 0, 0], 0);
  for (let index = 0; index < 90; index += 1) {
    state = stepPlayerLocomotion({
      state,
      input: { ...noInput, forward: true, dash: true },
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [],
    });
  }
  const dashSpeed = Math.hypot(state.velocity[0], state.velocity[2]);
  expect(dashSpeed).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.runSpeed * 1.5);
  expect(dashSpeed).toBeLessThanOrEqual(
    PLAYER_CONTROLLER_CONFIG.runSpeed * PLAYER_CONTROLLER_CONFIG.dashSpeedMultiplier + 0.001,
  );
});

it("caps crouched movement at crouchSpeed and suppresses sprint and dash", () => {
  let state = createPlayerLocomotionState([0, 0, 0], 0);
  for (let index = 0; index < 120; index += 1) {
    state = stepPlayerLocomotion({
      state,
      input: { ...noInput, forward: true, sprint: true, dash: true, crouch: true },
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [],
    });
  }

  const crouchedSpeed = Math.hypot(state.velocity[0], state.velocity[2]);
  expect(crouchedSpeed).toBeLessThanOrEqual(PLAYER_CONTROLLER_CONFIG.crouchSpeed + 0.001);
  expect(crouchedSpeed).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.crouchSpeed * 0.9);
  expect(crouchedSpeed).toBeLessThan(PLAYER_CONTROLLER_CONFIG.walkSpeed);
});

it("does not block a jump while crouched", () => {
  const state = createPlayerLocomotionState([0, 0, 0]);
  const next = stepPlayerLocomotion({
    state,
    input: { ...noInput, jump: true, crouch: true },
    delta: 1 / 60,
    groundHeight: 0,
    obstacles: [],
  });

  expect(next.velocity[1]).toBeGreaterThan(0);
  expect(next.onGround).toBe(false);
});

it("moves at slowWalkSpeed with the walk toggle and lets sprint override it", () => {
  let slow = createPlayerLocomotionState([0, 0, 0], 0);
  let sprinting = createPlayerLocomotionState([0, 0, 0], 0);
  for (let index = 0; index < 120; index += 1) {
    slow = stepPlayerLocomotion({
      state: slow,
      input: { ...noInput, forward: true, slowWalk: true },
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [],
    });
    sprinting = stepPlayerLocomotion({
      state: sprinting,
      input: { ...noInput, forward: true, slowWalk: true, sprint: true },
      delta: 1 / 60,
      groundHeight: 0,
      obstacles: [],
    });
  }

  const slowSpeed = Math.hypot(slow.velocity[0], slow.velocity[2]);
  expect(slowSpeed).toBeLessThanOrEqual(PLAYER_CONTROLLER_CONFIG.slowWalkSpeed + 0.001);
  expect(slowSpeed).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.slowWalkSpeed * 0.9);
  expect(Math.hypot(sprinting.velocity[0], sprinting.velocity[2])).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.walkSpeed);
});

it("honours the full coyote window instead of losing its final substep", () => {
  // The remaining window is shorter than one substep; decrement-then-compare
  // used to deny this jump even though the grace period was still open.
  const airborne = {
    ...createPlayerLocomotionState([0, 0.2, 0]),
    coyoteTimeRemaining: 0.005,
    onGround: false,
  };
  const next = stepPlayerLocomotion({
    state: airborne,
    input: { ...noInput, jump: true },
    delta: 1 / 60,
    groundHeight: 0,
    obstacles: [],
  });

  expect(next.velocity[1]).toBeGreaterThan(0);
});

it("clamps a long fall at the terminal fall speed", () => {
  let state = createPlayerLocomotionState([0, 200, 0], 0, 0);
  state = { ...state, onGround: false, coyoteTimeRemaining: 0 };
  for (let index = 0; index < 300; index += 1) {
    state = stepPlayerLocomotion({
      state,
      input: noInput,
      delta: 1 / 60,
      groundEnabled: false,
      groundHeight: 0,
      obstacles: [],
    });
  }

  expect(state.velocity[1]).toBeGreaterThanOrEqual(-PLAYER_CONTROLLER_CONFIG.maxFallSpeed - 0.001);
  expect(state.velocity[1]).toBeCloseTo(-PLAYER_CONTROLLER_CONFIG.maxFallSpeed, 4);
});

it("treats the E ascend alias as flight-only vertical thrust, never a ground jump", () => {
  const flying = { ...createPlayerLocomotionState([0, 5, 0]), flying: true, onGround: false };
  const rise = stepPlayerLocomotion({
    state: flying,
    input: { ...noInput, ascend: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  expect(rise.position[1]).toBeGreaterThan(5);

  const sink = stepPlayerLocomotion({
    state: flying,
    input: { ...noInput, descend: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  expect(sink.position[1]).toBeLessThan(5);

  const grounded = createPlayerLocomotionState([0, 0, 0]);
  const held = stepPlayerLocomotion({
    state: grounded,
    input: { ...noInput, ascend: true },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  expect(held.position[1]).toBe(0);
  expect(held.velocity[1]).toBe(0);
});

it("faces the actual movement vector and hides the actor before a close camera clips through it", () => {
  expect(getPlayerMovementFacingYaw([1, 0, 0], 0)).toBeCloseTo(Math.PI / 2);
  expect(getPlayerMovementFacingYaw([0, 0, 1], 1)).toBeCloseTo(0);
  expect(getPlayerMovementFacingYaw([0, 0, 0], 1.25)).toBe(1.25);
  expect(shouldShowThirdPersonPlayer(PLAYER_CONTROLLER_CONFIG.cameraHidePlayerDistance - 0.01)).toBe(false);
  expect(shouldShowThirdPersonPlayer(PLAYER_CONTROLLER_CONFIG.cameraHidePlayerDistance)).toBe(true);
});

it("shares the authored +Z heading contract between forward, right and facing yaw", () => {
  expect(getPlayerForward(0)).toEqual([0, 1]);
  expect(getPlayerRight(0)).toEqual([-1, 0]);
  expect(getPlayerForward(Math.PI / 2)[0]).toBeCloseTo(1);
  expect(getPlayerRight(Math.PI / 2)[1]).toBeCloseTo(1);

  const yaw = 0.73;
  const forward = getPlayerForward(yaw);
  expect(getPlayerMovementFacingYaw([forward[0], 0, forward[1]], 0)).toBeCloseTo(yaw);
});

it("lets analog gamepad axes replace the digital keys and scale speed with tilt", () => {
  expect(getPlayerMoveAxes({ ...noInput, forward: true })).toEqual([1, 0]);
  // Analog wins over held digital keys and keeps sub-unit magnitude.
  expect(getPlayerMoveAxes({ ...noInput, forward: true, moveForwardAxis: 0.5 })[0]).toBeCloseTo(0.5);
  // Over-unit diagonals are clamped back onto the unit circle.
  const [diagForward, diagRight] = getPlayerMoveAxes({ ...noInput, moveForwardAxis: 1, moveRightAxis: 1 });
  expect(Math.hypot(diagForward, diagRight)).toBeCloseTo(1, 6);

  const state = createPlayerLocomotionState([0, 0, 0], 0);
  const fullTilt = stepPlayerLocomotion({
    state,
    input: { ...noInput, moveForwardAxis: 1 },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  const halfTilt = stepPlayerLocomotion({
    state,
    input: { ...noInput, moveForwardAxis: 0.5 },
    delta: 0.05,
    groundHeight: 0,
    obstacles: [],
  });
  expect(fullTilt.position[2]).toBeGreaterThan(0);
  expect(halfTilt.position[2]).toBeGreaterThan(0);
  expect(halfTilt.position[2]).toBeLessThan(fullTilt.position[2]);
  expect(halfTilt.position[2]).toBeCloseTo(fullTilt.position[2] * 0.5, 3);
});
