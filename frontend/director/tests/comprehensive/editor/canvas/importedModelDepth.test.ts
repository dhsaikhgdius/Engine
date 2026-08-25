import { BoxGeometry, BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { expect, it } from "vitest";
import {
  getPrimitiveCoplanarBiasRank,
  getPrimitiveCoplanarDepthBias,
  stabilizeImportedModelCoplanarDepth,
} from "../../../../src/comprehensive/editor/canvas/importedModelDepth";

function mesh(name: string, size: number, material = new MeshStandardMaterial()) {
  const result = new Mesh(new BoxGeometry(size, size, size), material);
  result.name = name;
  return result;
}

function standardMaterial(meshObject: Mesh) {
  return meshObject.material as MeshStandardMaterial;
}

it("pushes larger walls behind smaller trim so flush coplanar panels stop flickering", () => {
  const root = new Group();
  const wall = mesh("wall", 20);
  const panel = mesh("panel", 2);
  root.add(wall, panel);

  stabilizeImportedModelCoplanarDepth(root, false);

  expect(standardMaterial(wall).polygonOffset).toBe(true);
  expect(standardMaterial(wall).polygonOffsetUnits).toBeGreaterThan(standardMaterial(panel).polygonOffsetUnits);
  expect(standardMaterial(wall).polygonOffsetFactor).toBeGreaterThan(standardMaterial(panel).polygonOffsetFactor);
});

it("flips the bias sign for the Stage reversed-Z framebuffer", () => {
  const traditional = new Group();
  const reversed = new Group();
  traditional.add(mesh("wall", 20), mesh("panel", 2));
  reversed.add(mesh("wall", 20), mesh("panel", 2));

  stabilizeImportedModelCoplanarDepth(traditional, false);
  stabilizeImportedModelCoplanarDepth(reversed, true);

  const traditionalWall = traditional.children[0] as Mesh<BoxGeometry, MeshStandardMaterial>;
  const reversedWall = reversed.children[0] as Mesh<BoxGeometry, MeshStandardMaterial>;
  expect(reversedWall.material.polygonOffsetUnits).toBe(-traditionalWall.material.polygonOffsetUnits);
  expect(reversedWall.material.polygonOffsetFactor).toBe(-traditionalWall.material.polygonOffsetFactor);
});

it("clones a shared glTF material so the wall and flush panel keep different biases", () => {
  const shared = new MeshStandardMaterial();
  const root = new Group();
  const wall = mesh("wall", 20, shared);
  const panel = mesh("panel", 2, shared);
  root.add(wall, panel);

  stabilizeImportedModelCoplanarDepth(root, true);

  expect(standardMaterial(wall)).not.toBe(shared);
  expect(standardMaterial(panel)).not.toBe(shared);
  expect(standardMaterial(wall)).not.toBe(standardMaterial(panel));
  expect(standardMaterial(wall).polygonOffsetUnits).toBeLessThan(standardMaterial(panel).polygonOffsetUnits);
  expect(shared.polygonOffset).toBe(false);
});

it("still biases a single large wall so it can sit behind a separately imported panel", () => {
  const wall = mesh("wall", 40);
  stabilizeImportedModelCoplanarDepth(wall, true);

  expect(standardMaterial(wall).polygonOffset).toBe(true);
  expect(standardMaterial(wall).polygonOffsetUnits).toBeLessThan(0);
});

it("pushes a large wall slab behind a flush door panel by face area", () => {
  const wall = getPrimitiveCoplanarDepthBias([20.1, 8.4, 0.8], true);
  const door = getPrimitiveCoplanarDepthBias([2.95, 5.4, 0.13], true);
  expect(getPrimitiveCoplanarBiasRank([20.1, 8.4, 0.8])).not.toBe(getPrimitiveCoplanarBiasRank([2.95, 5.4, 0.13]));
  expect(wall.units).toBeLessThan(door.units);
});

it("splits a multi-material facade so the larger wall group sits behind the trim group", () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        -10, -10, 0, 10, -10, 0, 10, 10, 0, -10, -10, 0, 10, 10, 0, -10, 10, 0, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0,
        1, 1, 0, -1, 1, 0,
      ]),
      3,
    ),
  );
  geometry.addGroup(0, 6, 0);
  geometry.addGroup(6, 6, 1);
  const wallMaterial = new MeshStandardMaterial();
  const trimMaterial = new MeshStandardMaterial();
  const facade = new Mesh(geometry, [wallMaterial, trimMaterial]);

  stabilizeImportedModelCoplanarDepth(facade, false);

  const [biasedWall, biasedTrim] = facade.material as MeshStandardMaterial[];
  expect(biasedWall).not.toBe(wallMaterial);
  expect(biasedTrim).not.toBe(trimMaterial);
  expect(biasedWall.polygonOffsetUnits).toBeGreaterThan(biasedTrim.polygonOffsetUnits);
});
