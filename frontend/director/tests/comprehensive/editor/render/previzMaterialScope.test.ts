import {
  BatchedMesh,
  BoxGeometry,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  Texture,
} from "three";
import { DIRECTOR_PREVIZ_PALETTE } from "@director/project-schema";
import {
  applyDirectorPrevizMaterialScope,
  isDirectorPrevizColorLeakObject,
  isDirectorPrevizOverlayObject,
  resolveDirectorPrevizClayRole,
} from "../../../../src/comprehensive/editor/render/previzMaterialScope";

function addOwnedMesh(scene: Scene, kind: "character" | "prop") {
  const owner = new Group();
  owner.userData.directorObjectKind = kind;
  const original = new MeshBasicMaterial({ color: kind === "character" ? "#ff00ff" : "#00ffff" });
  const mesh = new Mesh(new PlaneGeometry(1, 1), original);
  owner.add(mesh);
  scene.add(owner);
  return { mesh, original };
}

it("applies warm character clay against cool environment clay and restores instanced colors", () => {
  const scene = new Scene();
  const background = new Color("#112233");
  scene.background = background;
  const character = addOwnedMesh(scene, "character");
  const prop = addOwnedMesh(scene, "prop");
  const groundMaterial = new MeshBasicMaterial({ color: "#123456" });
  const ground = new Mesh(new PlaneGeometry(1, 1), groundMaterial);
  const instancedMaterial = new MeshBasicMaterial({ color: "#ffffff" });
  const instances = new InstancedMesh(new PlaneGeometry(1, 1), instancedMaterial, 2);
  instances.setColorAt(0, new Color("#ff0000"));
  instances.setColorAt(1, new Color("#00ff00"));
  const originalInstanceColor = instances.instanceColor;
  scene.add(ground, instances);

  const scope = applyDirectorPrevizMaterialScope(scene);

  expect(scope.changedCount).toBe(4);
  expect(character.mesh.material).not.toBe(character.original);
  expect(prop.mesh.material).not.toBe(prop.original);
  expect(resolveDirectorPrevizClayRole(character.mesh)).toBe("character");
  expect(resolveDirectorPrevizClayRole(prop.mesh)).toBe("environment");
  expect(character.mesh.material).not.toBe(prop.mesh.material);
  expect(prop.mesh.material).toBe(ground.material);
  expect(ground.material).toBe(instances.material);
  expect(character.mesh.material).toBeInstanceOf(MeshStandardMaterial);
  expect((character.mesh.material as unknown as MeshStandardMaterial).color.getHexString()).toBe(
    DIRECTOR_PREVIZ_PALETTE.human.slice(1),
  );
  expect((prop.mesh.material as unknown as MeshStandardMaterial).color.getHexString()).toBe(
    DIRECTOR_PREVIZ_PALETTE.clay.slice(1),
  );
  expect((character.mesh.material as unknown as MeshStandardMaterial).userData.directorClayStudio).toBe(true);
  expect(instances.instanceColor).toBeNull();
  expect((scene.background as Color).getHexString()).toBe(DIRECTOR_PREVIZ_PALETTE.sky.slice(1));

  scope.restore();
  scope.restore();

  expect(character.mesh.material).toBe(character.original);
  expect(prop.mesh.material).toBe(prop.original);
  expect(ground.material).toBe(groundMaterial);
  expect(instances.material).toBe(instancedMaterial);
  expect(instances.instanceColor).toBe(originalInstanceColor);
  expect(scene.background).toBe(background);
});

it("removes and restores authored colors on GPU multi-draw batches", () => {
  const scene = new Scene();
  const source = new BoxGeometry(1, 1, 1);
  const material = new MeshBasicMaterial({ color: "#ffffff" });
  const positionCount = source.getAttribute("position").count;
  const indexCount = source.getIndex()?.count ?? positionCount;
  const batch = new BatchedMesh(2, positionCount, indexCount, material);
  const geometryId = batch.addGeometry(source);
  const first = batch.addInstance(geometryId);
  const second = batch.addInstance(geometryId);
  batch.setColorAt(first, new Color("#ff0000"));
  batch.setColorAt(second, new Color("#00ff00"));
  scene.add(batch);

  const scope = applyDirectorPrevizMaterialScope(scene);
  expect(batch.getColorAt(first, new Color()).getHex()).toBe(0xffffff);

  scope.restore();
  expect(batch.material).toBe(material);
  expect(batch.getColorAt(first, new Color()).getHex()).toBe(0xff0000);
  expect(batch.getColorAt(second, new Color()).getHex()).toBe(0x00ff00);
});

it("detaches scene IBL so clay is not tinted by sky or panorama probes", () => {
  const scene = new Scene();
  const environment = new Texture();
  scene.environment = environment;
  scene.environmentIntensity = 0.55;
  const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: "#ff00ff" }));
  scene.add(mesh);

  const scope = applyDirectorPrevizMaterialScope(scene);

  expect(scene.environment).toBeNull();
  expect(scene.environmentIntensity).toBe(0);
  expect((mesh.material as unknown as MeshStandardMaterial).envMapIntensity).toBe(0);

  scope.restore();

  expect(scene.environment).toBe(environment);
  expect(scene.environmentIntensity).toBe(0.55);
});

it("hides custom-shader overlays instead of turning them into depth-writing clay", () => {
  const scene = new Scene();
  const shader = new ShaderMaterial();
  const sky = new Mesh(new PlaneGeometry(1, 1), shader);
  sky.name = "living-world-atmosphere-sky";
  scene.add(sky);
  expect(isDirectorPrevizOverlayObject(sky)).toBe(true);

  const scope = applyDirectorPrevizMaterialScope(scene);
  expect(scope.changedCount).toBe(0);
  expect(sky.visible).toBe(false);
  expect(sky.material).toBe(shader);

  scope.restore();
  expect(sky.visible).toBe(true);
});

it("keeps authored polygon offsets so overlapping courtyard slabs do not sparkle", () => {
  const scene = new Scene();
  const material = new MeshBasicMaterial({ color: "#ff0000" });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -16;
  const floor = new Mesh(new PlaneGeometry(1, 1), material);
  scene.add(floor);

  const scope = applyDirectorPrevizMaterialScope(scene);
  const clay = floor.material as unknown as MeshStandardMaterial;
  expect(clay.polygonOffset).toBe(true);
  expect(clay.polygonOffsetFactor).toBe(-2);
  expect(clay.polygonOffsetUnits).toBe(-16);
  expect(clay.userData.directorClayStudio).toBe(true);

  scope.restore();
  expect(floor.material).toBe(material);
});

it("hides particle and splat draws that would keep authored RGB", () => {
  const scene = new Scene();
  const points = new Points(new BufferGeometry(), new PointsMaterial({ color: 0xff0000 }));
  scene.add(points);
  expect(isDirectorPrevizColorLeakObject(points)).toBe(true);

  const scope = applyDirectorPrevizMaterialScope(scene);
  expect(points.visible).toBe(false);

  scope.restore();
  expect(points.visible).toBe(true);
});
