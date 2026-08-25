import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { isPlayerCameraCollisionRoot, PlayerCameraCollisionProbe } from "../../../../src/comprehensive/editor/player/playerCameraCollision";
import { collectPlayerRaycastMeshes } from "../../../../src/comprehensive/editor/player/playerRaycastAcceleration";

const target = new Vector3(0, 1, 0);
const desiredPosition = new Vector3(0, 1, 4.8);
const right = new Vector3(1, 0, 0);
const up = new Vector3(0, 1, 0);

function cameraDistanceFor(collider: Group, minimumNearDistance = 0.04) {
  collider.updateMatrixWorld(true);
  return new PlayerCameraCollisionProbe().getSafeDistance({
    target,
    desiredPosition,
    right,
    up,
    colliders: collectPlayerRaycastMeshes([collider]),
    clearance: 0.18,
    minimumNearDistance,
  });
}

it("stops the third-person camera before a real mesh", () => {
  const collider = new Group();
  const wall = new Mesh(new BoxGeometry(4, 4, 0.2), new MeshBasicMaterial());
  wall.position.set(0, 1, 2);
  collider.add(wall);

  expect(cameraDistanceFor(collider)).toBeCloseTo(1.72, 2);
});

it("does not shorten the camera for meshes outside its near-plane probes", () => {
  const collider = new Group();
  const wall = new Mesh(new BoxGeometry(1, 4, 0.2), new MeshBasicMaterial());
  wall.position.set(4, 1, 2);
  collider.add(wall);

  expect(cameraDistanceFor(collider)).toBe(4.8);
});

it("ignores hidden meshes and viewport helpers", () => {
  const hiddenCollider = new Group();
  const hiddenWall = new Mesh(new BoxGeometry(4, 4, 0.2), new MeshBasicMaterial());
  hiddenWall.position.set(0, 1, 2);
  hiddenWall.visible = false;
  hiddenCollider.add(hiddenWall);

  const helperCollider = new Group();
  helperCollider.userData.hideFromViewportCapture = true;
  const helperWall = new Mesh(new BoxGeometry(4, 4, 0.2), new MeshBasicMaterial());
  helperWall.position.set(0, 1, 2);
  helperCollider.add(helperWall);

  expect(cameraDistanceFor(hiddenCollider)).toBe(4.8);
  expect(cameraDistanceFor(helperCollider)).toBe(4.8);
});

it("contracts below the preferred follow minimum to stay on the player side of a very close wall", () => {
  const collider = new Group();
  const wall = new Mesh(new BoxGeometry(4, 4, 0.12), new MeshBasicMaterial());
  wall.position.set(0, 1, 0.4);
  collider.add(wall);

  expect(cameraDistanceFor(collider)).toBeCloseTo(0.16, 5);
});

it("keeps clearance from a wall just behind the desired camera position", () => {
  const collider = new Group();
  const wall = new Mesh(new BoxGeometry(4, 4, 0.2), new MeshBasicMaterial());
  // Near face at 4.85, only 0.05m behind the desired camera at 4.8. Ending
  // the probe exactly at the desired position ignored this wall and let the
  // safe distance jump by the whole clearance once the face crossed 4.8.
  wall.position.set(0, 1, 4.95);
  collider.add(wall);

  expect(cameraDistanceFor(collider)).toBeCloseTo(4.67, 5);
});

it("ignores walls further behind the desired position than the clearance", () => {
  const collider = new Group();
  const wall = new Mesh(new BoxGeometry(4, 4, 0.2), new MeshBasicMaterial());
  wall.position.set(0, 1, 5.1); // near face at 5.0 > 4.8 + 0.18
  collider.add(wall);

  expect(cameraDistanceFor(collider)).toBe(4.8);
});

it("focuses the probe footprint at the camera end where the near plane lives", () => {
  const nearCamera = new Group();
  const cameraSidePillar = new Mesh(new BoxGeometry(0.1, 4, 0.1), new MeshBasicMaterial());
  cameraSidePillar.position.set(0.1, 1, 4); // brushes the near plane at the camera end
  nearCamera.add(cameraSidePillar);

  const nearTarget = new Group();
  const targetSidePillar = new Mesh(new BoxGeometry(0.1, 4, 0.1), new MeshBasicMaterial());
  targetSidePillar.position.set(0.1, 1, 0.5); // off the sightline, right next to the target
  nearTarget.add(targetSidePillar);

  const contracted = cameraDistanceFor(nearCamera);
  expect(contracted).toBeGreaterThan(3.5);
  expect(contracted).toBeLessThan(4);
  // A prop that never crosses the sightline or the near plane must not pull
  // the camera in; parallel offset rays used to flag it as an obstruction.
  expect(cameraDistanceFor(nearTarget)).toBe(4.8);
});

it("never pushes the camera through a wall that is closer than the old follow minimum", () => {
  const collider = new Group();
  const wall = new Mesh(new BoxGeometry(4, 4, 0.04), new MeshBasicMaterial());
  wall.position.set(0, 1, 0.22);
  collider.add(wall);

  // Near face is at 0.2m. With 0.18m clearance the only safe placement is
  // ~0.02m; the near plane clamps that to 0.04m, still on the target side.
  expect(cameraDistanceFor(collider)).toBeCloseTo(0.04, 5);
});

it("keeps animated characters out of the follow-camera raycast hot path", () => {
  const character = new Group();
  character.userData.directorObjectKind = "character";
  const body = new Mesh(new BoxGeometry(1, 2, 1), new MeshBasicMaterial());
  character.add(body);
  character.updateMatrixWorld(true);

  const staticSet = new Group();
  staticSet.userData.directorObjectKind = "prop";
  const wall = new Mesh(new BoxGeometry(4, 4, 0.2), new MeshBasicMaterial());
  wall.position.set(0, 1, 2);
  staticSet.add(wall);
  staticSet.updateMatrixWorld(true);

  const cameraRoots = [character, staticSet].filter(isPlayerCameraCollisionRoot);
  expect(cameraRoots).toEqual([staticSet]);
  const cameraMeshes = collectPlayerRaycastMeshes(cameraRoots);

  const characterRaycast = vi.spyOn(body, "raycast");
  const probe = new PlayerCameraCollisionProbe();
  let safeDistance = desiredPosition.length();
  for (let frame = 0; frame < 600; frame += 1) {
    safeDistance = probe.getSafeDistance({
      target,
      desiredPosition,
      right,
      up,
      colliders: cameraMeshes,
      clearance: 0.18,
      minimumNearDistance: 0.04,
    });
  }

  expect(characterRaycast).not.toHaveBeenCalled();
  expect(safeDistance).toBeCloseTo(1.72, 2);
});
