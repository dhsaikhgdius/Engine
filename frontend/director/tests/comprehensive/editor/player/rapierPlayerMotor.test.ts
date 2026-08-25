import { expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import {
  createPlayerLocomotionState,
  PLAYER_CONTROLLER_CONFIG,
  type PlayerInput,
} from "../../../../src/comprehensive/editor/player/playerLocomotion";
import { createRapierPlayerMotor } from "../../../../src/comprehensive/editor/player/rapierPlayerMotor";
import { buildPlayerCollisionMeshesFromFlatMeshes } from "../../../../src/comprehensive/editor/player/playerCollisionMesh";

const idleInput: PlayerInput = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  sprint: false,
  jump: false,
  descend: false,
};
const TEST_MESH_OWNER = "test-environment";

it("keeps a capsule grounded and stops it at a full-height wall", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        position: [0, 0, 2],
        radius: 1,
        shape: "box",
        halfExtents: [1, 0.2],
        halfHeight: 1,
      },
    ],
  });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 120; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
    }

    expect(state.position[1]).toBeCloseTo(0, 4);
    expect(state.position[2]).toBeLessThan(1.8 - PLAYER_CONTROLLER_CONFIG.playerRadius + 0.02);
    expect(state.onGround).toBe(true);
    expect(Math.hypot(state.velocity[0], state.velocity[2])).toBeLessThan(0.02);
  } finally {
    motor.dispose();
  }
});

it("keeps a grounded capsule stable on a city-scale floor collider", async () => {
  const motor = await createRapierPlayerMotor({
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

  try {
    let state = createPlayerLocomotionState([1, 0, 2]);
    for (let index = 0; index < 120; index += 1) {
      state = motor.step(state, idleInput, 1 / 60);
    }

    expect(state.position[0]).toBeCloseTo(1, 5);
    expect(state.position[1]).toBeCloseTo(0, 4);
    expect(state.position[2]).toBeCloseTo(2, 5);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("keeps an idle character supported by a primitive road when the editor ground is hidden", async () => {
  const motor = await createRapierPlayerMotor({
    groundEnabled: false,
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

  try {
    let state = motor.snapStateToWalkableSurface(createPlayerLocomotionState([-7, 0.081, 320], Math.PI, 0.081));
    for (let index = 0; index < 120; index += 1) state = motor.step(state, idleInput, 1 / 60);

    expect(state.position[0]).toBeCloseTo(-7, 5);
    expect(state.position[1]).toBeCloseTo(0.08, 4);
    expect(state.position[2]).toBeCloseTo(320, 5);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("does not climb or vertically jitter while pushing into another character proxy", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "other-character",
        position: [0, 0, 1.25],
        radius: 0.42,
        shape: "circle",
        halfHeight: PLAYER_CONTROLLER_CONFIG.playerHeight * 0.5,
        walkableSurface: false,
      },
    ],
  });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    let maximumHeight = 0;
    let minimumHeight = 0;
    let minimumSeparation = Number.POSITIVE_INFINITY;
    for (let index = 0; index < 240; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
      minimumHeight = Math.min(minimumHeight, state.position[1]);
      minimumSeparation = Math.min(minimumSeparation, Math.hypot(state.position[0], state.position[2] - 1.25));
    }

    expect(maximumHeight).toBeLessThan(0.001);
    expect(minimumHeight).toBeGreaterThan(-0.001);
    expect(minimumSeparation).toBeGreaterThanOrEqual(PLAYER_CONTROLLER_CONFIG.playerRadius + 0.42 - 0.002);
    expect(Math.abs(state.velocity[1])).toBeLessThan(0.001);
  } finally {
    motor.dispose();
  }
});

it("takes one stable side around a character directly ahead without rebuilding the environment", async () => {
  const actorRadius = 0.42;
  const actorZ = 1.6;
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "oncoming-character",
        position: [0, 0, actorZ],
        radius: actorRadius,
        shape: "circle",
        halfHeight: PLAYER_CONTROLLER_CONFIG.playerHeight * 0.5,
        walkableSurface: false,
      },
    ],
  });

  try {
    const syncEnvironment = vi.spyOn(motor, "syncEnvironment");
    let state = createPlayerLocomotionState([0, 0, 0]);
    let lateralDirection = 0;
    let lateralDirectionChanged = false;
    let minimumSeparation = Number.POSITIVE_INFINITY;
    let separationAtFirstLateralMotion = 0;
    for (let index = 0; index < 240; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
      const separation = Math.hypot(state.position[0], state.position[2] - actorZ);
      minimumSeparation = Math.min(minimumSeparation, separation);
      const direction = Math.abs(state.velocity[0]) > 0.05 ? Math.sign(state.velocity[0]) : 0;
      if (direction && !lateralDirection) {
        lateralDirection = direction;
        separationAtFirstLateralMotion = separation;
      } else if (direction && direction !== lateralDirection) lateralDirectionChanged = true;
    }

    expect(minimumSeparation).toBeGreaterThanOrEqual(PLAYER_CONTROLLER_CONFIG.playerRadius + actorRadius - 0.002);
    expect(lateralDirection).not.toBe(0);
    expect(lateralDirectionChanged).toBe(false);
    expect(separationAtFirstLateralMotion).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.playerRadius + actorRadius + 0.1);
    expect(Math.abs(state.position[0])).toBeGreaterThan(0.5);
    expect(state.position[2]).toBeGreaterThan(actorZ + 0.6);
    expect(syncEnvironment).not.toHaveBeenCalled();
  } finally {
    motor.dispose();
  }
});

it("slides around another character on diagonal contact without overlap or lift", async () => {
  const actorRadius = 0.42;
  const actorZ = 1.5;
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "other-character",
        position: [0, 0, actorZ],
        radius: actorRadius,
        shape: "circle",
        halfHeight: PLAYER_CONTROLLER_CONFIG.playerHeight * 0.5,
        walkableSurface: false,
      },
    ],
  });

  try {
    const syncEnvironment = vi.spyOn(motor, "syncEnvironment");
    let state = createPlayerLocomotionState([-0.8, 0, 0]);
    let minimumSeparation = Number.POSITIVE_INFINITY;
    let maximumHeight = 0;
    for (let index = 0; index < 240; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, left: true }, 1 / 60);
      minimumSeparation = Math.min(minimumSeparation, Math.hypot(state.position[0], state.position[2] - actorZ));
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    }

    expect(minimumSeparation).toBeGreaterThanOrEqual(PLAYER_CONTROLLER_CONFIG.playerRadius + actorRadius - 0.002);
    expect(maximumHeight).toBeLessThan(0.001);
    expect(state.position[0]).toBeGreaterThan(2);
    expect(state.position[2]).toBeGreaterThan(3);
    expect(state.onGround).toBe(true);
    expect(syncEnvironment).not.toHaveBeenCalled();
  } finally {
    motor.dispose();
  }
});

it("does not snap onto a non-walkable actor proxy", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "actor-proxy",
        position: [0, 0, 0],
        radius: 0.42,
        shape: "circle",
        halfHeight: 0.14,
        walkableSurface: false,
      },
    ],
  });

  try {
    const state = motor.snapStateToWalkableSurface(createPlayerLocomotionState([0, 0.3, 0]), 0.2, 0.5);
    expect(state.position[1]).toBeCloseTo(0, 4);
  } finally {
    motor.dispose();
  }
});

it("still climbs an explicitly walkable static step", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "blocking-step",
        position: [0, 0, 1],
        radius: 1,
        shape: "box",
        halfExtents: [1, 0.5],
        halfHeight: 0.14,
        walkableSurface: true,
      },
    ],
  });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    let maximumHeight = 0;
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    }

    expect(maximumHeight).toBeGreaterThan(0.26);
    expect(state.position[2]).toBeGreaterThan(1.5);
  } finally {
    motor.dispose();
  }
});

it("caps crouched movement at crouchSpeed and suppresses sprint and dash on the Rapier path", async () => {
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 150; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, sprint: true, dash: true, crouch: true }, 1 / 60);
    }

    const crouchedSpeed = Math.hypot(state.velocity[0], state.velocity[2]);
    expect(crouchedSpeed).toBeLessThanOrEqual(PLAYER_CONTROLLER_CONFIG.crouchSpeed + 0.01);
    expect(crouchedSpeed).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.crouchSpeed * 0.9);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("jumps out of a crouch and moves at slowWalkSpeed with the walk toggle on the Rapier path", async () => {
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    state = motor.step(state, { ...idleInput, jump: true, crouch: true }, 1 / 60);
    expect(state.position[1]).toBeGreaterThan(0);
    expect(state.onGround).toBe(false);
    for (let index = 0; index < 100; index += 1) {
      state = motor.step(state, { ...idleInput, crouch: true }, 1 / 60);
    }
    expect(state.position[1]).toBeCloseTo(0, 4);
    expect(state.onGround).toBe(true);

    for (let index = 0; index < 150; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, slowWalk: true }, 1 / 60);
    }
    const slowSpeed = Math.hypot(state.velocity[0], state.velocity[2]);
    expect(slowSpeed).toBeLessThanOrEqual(PLAYER_CONTROLLER_CONFIG.slowWalkSpeed + 0.01);
    expect(slowSpeed).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.slowWalkSpeed * 0.9);
  } finally {
    motor.dispose();
  }
});

it("kills the remaining jump velocity on a head bump instead of hovering at the ceiling", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "low-ceiling",
        position: [0, 2, 0],
        radius: Math.hypot(1.5, 1.5),
        shape: "box",
        halfExtents: [1.5, 1.5],
        halfHeight: 0.25,
        walkableSurface: false,
      },
    ],
  });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    state = motor.step(state, { ...idleInput, jump: true }, 1 / 60);
    expect(state.velocity[1]).toBeGreaterThan(0);

    // Within a fraction of the nominal jump arc the head hits the ceiling and
    // the upward velocity must be gone; the pre-fix motor kept pressing into
    // the ceiling with several m/s for the remainder of the arc.
    for (let index = 0; index < 12; index += 1) {
      state = motor.step(state, idleInput, 1 / 60);
    }
    expect(state.velocity[1]).toBeLessThanOrEqual(0);

    for (let index = 0; index < 60; index += 1) {
      state = motor.step(state, idleInput, 1 / 60);
    }
    expect(state.position[1]).toBeCloseTo(0, 3);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("completes a jump and landing cycle while moving forward", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [],
  });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 120; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, sprint: true }, 1 / 60);
    }
    expect(state.position[2]).toBeGreaterThan(1.5);

    state = motor.step(state, { ...idleInput, jump: true }, 1 / 60);
    expect(state.position[1]).toBeGreaterThan(0);
    expect(state.onGround).toBe(false);
    for (let index = 0; index < 100; index += 1) {
      state = motor.step(state, idleInput, 1 / 60);
    }
    expect(state.position[1]).toBeCloseTo(0, 4);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

function importedEnvironment(...meshes: Mesh[]) {
  const directorSpace = new Group();
  const root = new Group();
  directorSpace.add(root);
  root.add(...meshes);
  directorSpace.updateMatrixWorld(true);
  return buildPlayerCollisionMeshesFromFlatMeshes(meshes, directorSpace);
}

it("uses the actual imported wall instead of a false cylinder at the scene origin", async () => {
  const wall = new Mesh(new BoxGeometry(3, 2.5, 0.3), new MeshBasicMaterial());
  wall.position.set(0, 1.25, 3);
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [{ id: "blender-scene", position: [0, 0, 0], radius: 0, shape: "mesh" }],
  });
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(wall));

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
    }
    expect(state.position[2]).toBeGreaterThan(1);
    expect(state.position[2]).toBeLessThan(2.85 - PLAYER_CONTROLLER_CONFIG.playerRadius + 0.03);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("keeps the previous owner collider when an atomic replacement fails", async () => {
  const wall = new Mesh(new BoxGeometry(3, 2.5, 0.3), new MeshBasicMaterial());
  wall.position.set(0, 1.25, 3);
  const replacement = new Mesh(new BoxGeometry(3, 2.5, 0.3), new MeshBasicMaterial());
  replacement.position.set(0, 1.25, 8);
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });
  motor.replaceMeshEnvironment("blender-live", importedEnvironment(wall));

  const world = (motor as unknown as { world: { createCollider: (descriptor: unknown) => unknown } }).world;
  const createCollider = vi.spyOn(world, "createCollider").mockImplementationOnce(() => {
    throw new Error("replacement failed");
  });

  try {
    expect(() => motor.replaceMeshEnvironment("blender-live", importedEnvironment(replacement))).toThrowError(
      "replacement failed",
    );
    createCollider.mockRestore();

    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
    }
    expect(state.position[2]).toBeLessThan(2.85 - PLAYER_CONTROLLER_CONFIG.playerRadius + 0.03);
  } finally {
    createCollider.mockRestore();
    motor.dispose();
  }
});

it("removes one mesh owner without disturbing another owner's collider", async () => {
  const directorWall = new Mesh(new BoxGeometry(3, 2.5, 0.3), new MeshBasicMaterial());
  directorWall.position.set(0, 1.25, 3);
  const liveWall = new Mesh(new BoxGeometry(3, 2.5, 0.3), new MeshBasicMaterial());
  liveWall.position.set(0, 1.25, 8);
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });
  motor.replaceMeshEnvironment("director-project", importedEnvironment(directorWall));
  motor.replaceMeshEnvironment("blender-live", importedEnvironment(liveWall));
  motor.replaceMeshEnvironment("blender-live", []);

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
    }
    expect(state.position[2]).toBeLessThan(2.85 - PLAYER_CONTROLLER_CONFIG.playerRadius + 0.03);
  } finally {
    motor.dispose();
  }
});

it("walks up an imported step and a walkable ramp without rebuilding colliders per step", async () => {
  const step = new Mesh(new BoxGeometry(2, 0.28, 1.2), new MeshBasicMaterial());
  step.position.set(0, 0.14, 1.4);
  const ramp = new Mesh(new BoxGeometry(2, 0.12, 3), new MeshBasicMaterial());
  ramp.position.set(0, 0.33, 3.45);
  ramp.rotation.x = -Math.PI / 12;
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });
  const collisionMeshes = importedEnvironment(step, ramp);
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, collisionMeshes);
  const replaceMeshEnvironment = vi.spyOn(motor, "replaceMeshEnvironment");

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    let maximumHeight = 0;
    for (let index = 0; index < 360; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    }
    expect(maximumHeight).toBeGreaterThan(0.22);
    expect(state.position[2]).toBeGreaterThan(4.2);
    expect(replaceMeshEnvironment).not.toHaveBeenCalled();
  } finally {
    motor.dispose();
  }
});

it("does not use step assist to pass through a low ceiling", async () => {
  const step = new Mesh(new BoxGeometry(2, 0.28, 1.2), new MeshBasicMaterial());
  step.position.set(0, 0.14, 1.4);
  const ceiling = new Mesh(new BoxGeometry(2, 0.3, 1.4), new MeshBasicMaterial());
  ceiling.position.set(0, 1.95, 1.25);
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(step, ceiling));

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
    }
    expect(state.position[1]).toBeLessThan(0.05);
    expect(state.position[2]).toBeLessThan(0.8);
  } finally {
    motor.dispose();
  }
});

it("snaps authored spawns from slightly above or below an imported floor", async () => {
  const floor = new Mesh(new BoxGeometry(4, 0.2, 4), new MeshBasicMaterial());
  floor.position.y = 0.1;
  const motor = await createRapierPlayerMotor({ groundHeight: -2, obstacles: [] });
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(floor));

  try {
    const above = motor.snapStateToWalkableSurface(createPlayerLocomotionState([0, 0.45, 0], 0, -2));
    const below = motor.snapStateToWalkableSurface(createPlayerLocomotionState([0, 0.05, 0], 0, -2));
    expect(above.position[1]).toBeCloseTo(0.2, 4);
    expect(below.position[1]).toBeCloseTo(0.2, 4);
    expect(above.onGround).toBe(true);
    expect(below.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

// Underside at 1.25 m: above the crouched capsule (~1.09 m incl. offset) but
// far below the 1.78 m standing capsule, so it blocks standing traversal only.
function lowCeilingMesh() {
  const ceiling = new Mesh(new BoxGeometry(4, 0.3, 8), new MeshBasicMaterial());
  ceiling.position.set(0, 1.4, 4.5);
  return ceiling;
}

it("passes under a low beam crouched that blocks the standing capsule", async () => {
  const motor = await createRapierPlayerMotor({
    groundHeight: 0,
    obstacles: [
      {
        id: "low-beam",
        position: [0, 1.25, 3],
        radius: Math.hypot(2, 0.6),
        shape: "box",
        halfExtents: [2, 0.6],
        halfHeight: 0.2,
      },
    ],
  });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 240; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
    }
    expect(state.position[2]).toBeGreaterThan(1.9);
    expect(state.position[2]).toBeLessThan(2.4 - PLAYER_CONTROLLER_CONFIG.playerRadius + 0.05);
    expect(state.position[1]).toBeCloseTo(0, 3);
    expect(motor.crouching).toBe(false);

    let maximumHeight = 0;
    for (let index = 0; index < 600; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, crouch: true }, 1 / 60);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    }
    expect(motor.crouching).toBe(true);
    expect(state.position[2]).toBeGreaterThan(3.8);
    expect(maximumHeight).toBeLessThan(0.05);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("keeps the crouched capsule and crouch speed cap when crouch is released under a low ceiling", async () => {
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(lowCeilingMesh()));

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, crouch: true }, 1 / 60);
    }
    expect(state.position[2]).toBeGreaterThan(1.6);
    expect(motor.crouching).toBe(true);

    let maximumSpeed = 0;
    let maximumHeight = 0;
    const trackReleasedStep = () => {
      state = motor.step(state, { ...idleInput, forward: true, sprint: true }, 1 / 60);
      maximumSpeed = Math.max(maximumSpeed, Math.hypot(state.velocity[0], state.velocity[2]));
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    };
    for (let index = 0; index < 60; index += 1) trackReleasedStep();
    expect(motor.crouching).toBe(true);

    // A mesh-environment rebuild (e.g. a re-mounted GLB) must not stand the
    // capsule back up while the ceiling still denies headroom.
    motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(lowCeilingMesh()));
    for (let index = 0; index < 60; index += 1) trackReleasedStep();

    expect(motor.crouching).toBe(true);
    expect(maximumSpeed).toBeLessThanOrEqual(PLAYER_CONTROLLER_CONFIG.crouchSpeed + 0.01);
    expect(maximumHeight).toBeLessThan(0.05);
    expect(state.position[2]).toBeLessThan(6);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("stands up and restores speed automatically after leaving the low space", async () => {
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(lowCeilingMesh()));

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, crouch: true }, 1 / 60);
    }
    expect(motor.crouching).toBe(true);

    // Crouch released while still inside: crawl out capped at crouchSpeed,
    // then the headroom cast clears past the ceiling edge (z > ~8.5).
    let maximumHeight = 0;
    for (let index = 0; index < 480; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, sprint: true }, 1 / 60);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    }
    expect(state.position[2]).toBeGreaterThan(8.7);
    expect(motor.crouching).toBe(false);
    expect(maximumHeight).toBeLessThan(0.05);

    for (let index = 0; index < 90; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true, sprint: true }, 1 / 60);
    }
    const restoredSpeed = Math.hypot(state.velocity[0], state.velocity[2]);
    expect(restoredSpeed).toBeGreaterThan(PLAYER_CONTROLLER_CONFIG.walkSpeed);
    expect(state.position[1]).toBeCloseTo(0, 3);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("does not drift or sink after rapid crouch toggling", async () => {
  const motor = await createRapierPlayerMotor({ groundHeight: 0, obstacles: [] });

  try {
    let state = createPlayerLocomotionState([0.6, 0, -1.2]);
    let minimumHeight = Number.POSITIVE_INFINITY;
    let maximumHeight = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < 240; index += 1) {
      state = motor.step(state, { ...idleInput, crouch: index % 2 === 0 }, 1 / 60);
      minimumHeight = Math.min(minimumHeight, state.position[1]);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
    }
    for (let index = 0; index < 30; index += 1) {
      state = motor.step(state, idleInput, 1 / 60);
    }

    expect(state.position[0]).toBeCloseTo(0.6, 5);
    expect(state.position[2]).toBeCloseTo(-1.2, 5);
    expect(minimumHeight).toBeGreaterThan(-0.001);
    expect(maximumHeight).toBeLessThan(0.001);
    expect(state.position[1]).toBeCloseTo(0, 4);
    expect(motor.crouching).toBe(false);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("snaps an empty-stage roam spawn from well above the Director plane", async () => {
  const motor = await createRapierPlayerMotor({ groundEnabled: true, groundHeight: 0, obstacles: [] });

  try {
    const state = motor.snapStateToWalkableSurface(
      createPlayerLocomotionState([0, 3, 0], 0, 0),
      PLAYER_CONTROLLER_CONFIG.stepHeight + PLAYER_CONTROLLER_CONFIG.groundSnapDistance,
      24,
    );
    expect(state.position[1]).toBeCloseTo(0, 4);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("lands a floating empty-stage actor on the Director plane instead of falling through", async () => {
  const motor = await createRapierPlayerMotor({ groundEnabled: true, groundHeight: 0, obstacles: [] });

  try {
    let state = createPlayerLocomotionState([0, 1.066, 0], 0, 0);
    expect(state.onGround).toBe(false);
    for (let index = 0; index < 180; index += 1) state = motor.step(state, idleInput, 1 / 60);
    expect(state.position[1]).toBeGreaterThanOrEqual(-0.001);
    expect(state.position[1]).toBeCloseTo(0, 2);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("keeps the Director plane under an actor that walks far from the origin", async () => {
  const motor = await createRapierPlayerMotor({ groundEnabled: true, groundHeight: 0, obstacles: [] });

  try {
    let state = createPlayerLocomotionState([250, 0, 0]);
    for (let index = 0; index < 120; index += 1) state = motor.step(state, idleInput, 1 / 60);
    expect(state.position[1]).toBeCloseTo(0, 3);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("does not vertically hitch while walking across a stationary ground pad", async () => {
  const motor = await createRapierPlayerMotor({ groundEnabled: true, groundHeight: 0, obstacles: [] });

  try {
    let state = createPlayerLocomotionState([0, 0, 0]);
    let maximumHeight = 0;
    let minimumHeight = 0;
    for (let index = 0; index < 180; index += 1) {
      state = motor.step(state, { ...idleInput, forward: true }, 1 / 60);
      maximumHeight = Math.max(maximumHeight, state.position[1]);
      minimumHeight = Math.min(minimumHeight, state.position[1]);
    }
    expect(Math.hypot(state.position[0], state.position[2])).toBeGreaterThan(2);
    expect(maximumHeight).toBeLessThan(0.002);
    expect(minimumHeight).toBeGreaterThan(-0.002);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});

it("allows a hidden Director ground to reach a below-zero imported floor", async () => {
  const basementFloor = new Mesh(new BoxGeometry(4, 0.2, 4), new MeshBasicMaterial());
  basementFloor.position.y = -1.1;
  const motor = await createRapierPlayerMotor({ groundEnabled: false, groundHeight: 0, obstacles: [] });
  motor.replaceMeshEnvironment(TEST_MESH_OWNER, importedEnvironment(basementFloor));

  try {
    let state = motor.snapStateToWalkableSurface(createPlayerLocomotionState([0, -0.5, 0], 0, -2), 0.4, 1);
    expect(state.position[1]).toBeCloseTo(-1, 4);
    for (let index = 0; index < 60; index += 1) state = motor.step(state, idleInput, 1 / 60);
    expect(state.position[1]).toBeCloseTo(-1, 3);
    expect(state.onGround).toBe(true);
  } finally {
    motor.dispose();
  }
});
