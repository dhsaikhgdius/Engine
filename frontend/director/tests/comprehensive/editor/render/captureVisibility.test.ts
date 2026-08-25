import { BoxGeometry, DirectionalLight, Group, InstancedMesh, Mesh, MeshBasicMaterial, Scene } from "three";
import { expect, it } from "vitest";
import {
  suppressDirectorCaptureHelpers,
  suppressDirectorEnvironmentDressing,
  withDirectorCaptureHelpersHidden,
} from "../../../../src/comprehensive/editor/render/captureVisibility";

it("restores mixed helper visibility idempotently", () => {
  const scene = new Scene();
  const visibleHelper = new Group();
  visibleHelper.userData.hideFromViewportCapture = true;
  const alreadyHiddenHelper = new Group();
  alreadyHiddenHelper.userData.hideFromViewportCapture = true;
  alreadyHiddenHelper.visible = false;
  scene.add(visibleHelper, alreadyHiddenHelper);

  const scope = suppressDirectorCaptureHelpers(scene);
  expect(scope.hiddenCount).toBe(2);
  expect(visibleHelper.visible).toBe(false);
  expect(alreadyHiddenHelper.visible).toBe(false);

  scope.restore();
  scope.restore();
  expect(visibleHelper.visible).toBe(true);
  expect(alreadyHiddenHelper.visible).toBe(false);
});

it("restores helpers when a reusable capture callback throws", () => {
  const scene = new Scene();
  const helper = new Group();
  helper.userData.hideFromViewportCapture = true;
  scene.add(helper);

  expect(() =>
    withDirectorCaptureHelpersHidden(scene, () => {
      expect(helper.visible).toBe(false);
      throw new Error("capture failed");
    }),
  ).toThrow("capture failed");
  expect(helper.visible).toBe(true);
});

it("hides only environment-dressing renderables and restores them idempotently", () => {
  const scene = new Scene();
  const owner = new Group();
  owner.userData.directorObjectId = "obj-1";
  const authoredMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  owner.add(authoredMesh);
  const stageFloor = new Mesh(new BoxGeometry(4, 0.1, 4), new MeshBasicMaterial());
  const backdropGroup = new Group();
  const backdropDome = new Mesh(new BoxGeometry(8, 8, 8), new MeshBasicMaterial());
  backdropGroup.add(backdropDome);
  const alreadyHidden = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  alreadyHidden.visible = false;
  const light = new DirectionalLight();
  scene.add(owner, stageFloor, backdropGroup, alreadyHidden, light);

  const scope = suppressDirectorEnvironmentDressing(scene);
  // Only the two visible untagged renderables count: authored content stays,
  // lights and empty groups draw nothing, hidden dressing needs no change.
  expect(scope.hiddenCount).toBe(2);
  expect(authoredMesh.visible).toBe(true);
  expect(stageFloor.visible).toBe(false);
  expect(backdropDome.visible).toBe(false);
  expect(backdropGroup.visible).toBe(true);
  expect(light.visible).toBe(true);
  expect(alreadyHidden.visible).toBe(false);

  scope.restore();
  scope.restore();
  expect(stageFloor.visible).toBe(true);
  expect(backdropDome.visible).toBe(true);
  expect(alreadyHidden.visible).toBe(false);
});

it("keeps authored static primitive batches in transparent captures", () => {
  const scene = new Scene();
  const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
  instances.userData.directorInstanceObjectIds = ["box-a", "box-b"];
  const environment = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  scene.add(instances, environment);

  const scope = suppressDirectorEnvironmentDressing(scene);

  expect(instances.visible).toBe(true);
  expect(environment.visible).toBe(false);
  scope.restore();
});
