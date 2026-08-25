import { describe, expect, it } from "vitest";
import { Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Vector3 } from "three";
import {
  composeProjectToWorldMatrix,
  createWorldGroundProbe,
  isWorldGroundHitUsable,
  WORLD_GROUND_CELL_SIZE_M,
  worldGroundCellCenter,
  worldGroundCellKey,
} from "../../../../src/comprehensive/editor/world/worldGround";

function makeGroundMesh(worldY: number, size = 100): Mesh {
  const mesh = new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial());
  mesh.rotation.x = -Math.PI / 2; // face +Y
  mesh.position.y = worldY;
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("world ground cell quantization", () => {
  it("maps points inside one 0.5 m cell to the same key and neighbours to distinct keys", () => {
    expect(worldGroundCellKey(0.1, 0.1)).toBe(worldGroundCellKey(-0.1, 0.2));
    expect(worldGroundCellKey(0, 0)).not.toBe(worldGroundCellKey(WORLD_GROUND_CELL_SIZE_M, 0));
    expect(worldGroundCellKey(0, 0)).not.toBe(worldGroundCellKey(0, WORLD_GROUND_CELL_SIZE_M));
    // Symmetric coordinates must not collide (injective key).
    expect(worldGroundCellKey(1, 2)).not.toBe(worldGroundCellKey(2, 1));
    expect(worldGroundCellKey(-3, 4)).not.toBe(worldGroundCellKey(3, -4));
  });

  it("snaps to cell centres on the 0.5 m grid", () => {
    expect(worldGroundCellCenter(0.2)).toBe(0);
    expect(worldGroundCellCenter(0.3)).toBe(0.5);
    expect(worldGroundCellCenter(-0.3)).toBe(-0.5);
  });
});

describe("project/world matrix", () => {
  it("mirrors SceneRoot compose order and round-trips points", () => {
    const projectToWorld = composeProjectToWorldMatrix([1, 2, 3], [0, Math.PI / 2, 0], 2, new Matrix4());
    const worldToProject = projectToWorld.clone().invert();
    const projectPoint = new Vector3(4, 5, 6);
    const world = projectPoint.clone().applyMatrix4(projectToWorld);
    // Yaw +90° maps project +X to world -Z before translation; scale doubles.
    expect(world.x).toBeCloseTo(1 + 6 * 2, 10);
    expect(world.y).toBeCloseTo(2 + 5 * 2, 10);
    expect(world.z).toBeCloseTo(3 - 4 * 2, 10);
    const roundTripped = world.applyMatrix4(worldToProject);
    expect(roundTripped.x).toBeCloseTo(4, 10);
    expect(roundTripped.y).toBeCloseTo(5, 10);
    expect(roundTripped.z).toBeCloseTo(6, 10);
  });

  it("clamps a zero scale so the inverse stays finite", () => {
    const matrix = composeProjectToWorldMatrix([0, 0, 0], [0, 0, 0], 0, new Matrix4());
    const inverse = matrix.clone().invert();
    expect(inverse.elements.every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe("terrain hit filter", () => {
  it("accepts plain visible scene meshes", () => {
    const mesh = makeGroundMesh(0);
    expect(isWorldGroundHitUsable(mesh)).toBe(true);
  });

  it("rejects hidden nodes, opt-out flags, and helper names anywhere in the ancestor chain", () => {
    const parent = new Object3D();
    const mesh = makeGroundMesh(0);
    parent.add(mesh);

    parent.visible = false;
    expect(isWorldGroundHitUsable(mesh)).toBe(false);
    parent.visible = true;

    for (const key of [
      "collisionDisabled",
      "directorCollisionDisabled",
      "hideFromViewportCapture",
      "directorGroundRaycastDisabled",
      "directorDropPreview",
    ]) {
      parent.userData = { [key]: true };
      expect(isWorldGroundHitUsable(mesh)).toBe(false);
    }
    parent.userData = {};

    parent.name = "viewport-ground-grid";
    expect(isWorldGroundHitUsable(mesh)).toBe(false);
    parent.name = "";

    parent.userData = { directorObjectKind: "character" };
    expect(isWorldGroundHitUsable(mesh)).toBe(false);
  });

  it("rejects every Living World layer naming variant", () => {
    const wildlife = new Object3D();
    wildlife.name = "living-world-wildlife";
    const water = new Object3D();
    water.name = "director-living-world-water";
    const meshA = makeGroundMesh(0);
    const meshB = makeGroundMesh(0);
    wildlife.add(meshA);
    water.add(meshB);
    expect(isWorldGroundHitUsable(meshA)).toBe(false);
    expect(isWorldGroundHitUsable(meshB)).toBe(false);
  });
});

describe("world ground probe", () => {
  it("returns project-space heights, caches per cell, and misses to null", () => {
    const ground = makeGroundMesh(2);
    let meshFetches = 0;
    const identity = new Matrix4();
    const probe = createWorldGroundProbe({
      getMeshes: () => {
        meshFetches += 1;
        return [ground];
      },
      projectToWorld: identity,
      worldToProject: identity,
    });

    expect(probe.sample(0.1, 0.1)).toBeCloseTo(2, 6);
    expect(meshFetches).toBe(1);
    // Same 0.5 m cell: served from cache, no fresh raycast.
    expect(probe.sample(-0.1, 0.15)).toBeCloseTo(2, 6);
    expect(meshFetches).toBe(1);
    expect(probe.cellCount()).toBe(1);
    // Beyond the 100 m plane: no hit, cached as null.
    expect(probe.sample(500, 500)).toBeNull();
    expect(probe.sample(500, 500)).toBeNull();
    expect(meshFetches).toBe(2);

    probe.invalidate();
    expect(probe.cellCount()).toBe(0);
    expect(probe.sample(0, 0)).toBeCloseTo(2, 6);
    expect(meshFetches).toBe(3);
  });

  it("skips filtered hits and falls through to terrain below", () => {
    const helper = makeGroundMesh(5);
    helper.name = "living-world-decoy";
    const ground = makeGroundMesh(1);
    const identity = new Matrix4();
    const probe = createWorldGroundProbe({
      getMeshes: () => [helper, ground],
      projectToWorld: identity,
      worldToProject: identity,
    });
    expect(probe.sample(0, 0)).toBeCloseTo(1, 6);
  });

  it("converts through a non-identity scene transform", () => {
    // Scene shifted up 5 and scaled 2: a mesh at world y=9 is project y=2.
    const projectToWorld = composeProjectToWorldMatrix([0, 5, 0], [0, 0, 0], 2, new Matrix4());
    const worldToProject = projectToWorld.clone().invert();
    const ground = makeGroundMesh(9, 400);
    const probe = createWorldGroundProbe({
      getMeshes: () => [ground],
      projectToWorld,
      worldToProject,
    });
    expect(probe.sample(0, 0)).toBeCloseTo(2, 6);
  });
});
