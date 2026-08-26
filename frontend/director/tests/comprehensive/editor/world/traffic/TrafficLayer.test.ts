import { BufferGeometry, InstancedMesh, MeshBasicMaterial } from "three";
import { vi } from "vitest";
import { disposeTrafficInstancedMesh } from "../../../../../src/comprehensive/editor/world/traffic/TrafficLayer";

it("disposes traffic instance buffers after R3F shadows the instance method", () => {
  const geometry = new BufferGeometry();
  const material = new MeshBasicMaterial();
  const mesh = new InstancedMesh(geometry, material, 1);
  const onDispose = vi.fn();
  mesh.addEventListener("dispose", onDispose);
  Object.defineProperty(mesh, "dispose", { configurable: true, value: null });

  disposeTrafficInstancedMesh(mesh);

  expect(onDispose).toHaveBeenCalledOnce();
  geometry.dispose();
  material.dispose();
});
