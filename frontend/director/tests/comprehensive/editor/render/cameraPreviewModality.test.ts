import {
  BatchedMesh,
  Box3,
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshNormalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
} from "three";
import type { WebGLRenderer } from "three";
import {
  applyDirectorCameraPreviewModalityScope,
  applyDirectorCameraPreviewSegmentationScope,
  collectDirectorCameraPreviewSegmentationEntries,
  commitDirectorCameraPreviewMotionHistory,
  computeDirectorCameraPreviewSceneBounds,
  DIRECTOR_CAMERA_PREVIEW_MODES,
  DIRECTOR_DEPTH_PREVIEW_FAR_M,
  DIRECTOR_DEPTH_PREVIEW_NEAR_M,
  getDirectorCameraPreviewDepthRange,
  getDirectorCameraPreviewOverrideMaterial,
  isDirectorCameraPreviewMode,
  isDirectorCameraPreviewSegmentationMode,
  resetDirectorCameraPreviewMotionHistory,
  updateDirectorCameraPreviewMotionUniforms,
} from "../../../../src/comprehensive/editor/render/cameraPreviewModality";
import { createDirectorObjectIdColorMap } from "../../../../src/comprehensive/editor/render/renderPassCapture";

function createBatchedBoxPair(material: MeshBasicMaterial) {
  const source = new BoxGeometry(1, 1, 1);
  const positionCount = source.getAttribute("position").count;
  const indexCount = source.getIndex()?.count ?? positionCount;
  const batch = new BatchedMesh(2, positionCount, indexCount, material);
  const geometryId = batch.addGeometry(source);
  const first = batch.addInstance(geometryId);
  const second = batch.addInstance(geometryId);
  batch.userData.directorInstanceObjectIds = ["box-a", "box-b"];
  batch.setColorAt(first, new Color(0xff0000));
  batch.setColorAt(second, new Color(0x00ff00));
  return { batch, first, second };
}

function createRendererStub() {
  let clearColor = new Color("#123456");
  let clearAlpha = 0.5;
  return {
    getClearColor: (target: Color) => target.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor: (color: Color | number, alpha?: number) => {
      clearColor = new Color(color as never);
      if (alpha !== undefined) clearAlpha = alpha;
    },
    readClearState: () => ({ alpha: clearAlpha, hex: clearColor.getHexString() }),
  };
}

it("exposes the eight monitor modalities with previz first as the default", () => {
  expect(DIRECTOR_CAMERA_PREVIEW_MODES).toEqual([
    "previz",
    "rgb",
    "depth",
    "normal",
    "objectid",
    "mask",
    "motion",
    "wireframe",
  ]);
  expect(isDirectorCameraPreviewMode("depth")).toBe(true);
  expect(isDirectorCameraPreviewMode("objectid")).toBe(true);
  expect(isDirectorCameraPreviewMode("motion")).toBe(true);
  expect(isDirectorCameraPreviewMode("object-id")).toBe(false);
  expect(isDirectorCameraPreviewSegmentationMode("objectid")).toBe(true);
  expect(isDirectorCameraPreviewSegmentationMode("mask")).toBe(true);
  expect(isDirectorCameraPreviewSegmentationMode("motion")).toBe(false);
  expect(isDirectorCameraPreviewSegmentationMode("wireframe")).toBe(false);
});

it("only overrides materials for the scene-wide technical modalities", () => {
  expect(getDirectorCameraPreviewOverrideMaterial("previz")).toBeNull();
  expect(getDirectorCameraPreviewOverrideMaterial("rgb")).toBeNull();
  expect(getDirectorCameraPreviewOverrideMaterial("depth")).toBeInstanceOf(ShaderMaterial);
  expect(getDirectorCameraPreviewOverrideMaterial("normal")).toBeInstanceOf(MeshNormalMaterial);
  // Segmentation modes recolor meshes one by one instead of a scene override.
  expect(getDirectorCameraPreviewOverrideMaterial("objectid")).toBeNull();
  expect(getDirectorCameraPreviewOverrideMaterial("mask")).toBeNull();
  const motion = getDirectorCameraPreviewOverrideMaterial("motion") as ShaderMaterial;
  expect(motion).toBeInstanceOf(ShaderMaterial);
  expect(motion.toneMapped).toBe(false);
  expect(motion.vertexShader).toContain("uPreviousModelMatrix");
  expect(motion.fragmentShader).toContain("directorMotionHsvRgb");
  const wireframe = getDirectorCameraPreviewOverrideMaterial("wireframe") as MeshBasicMaterial;
  expect(wireframe).toBeInstanceOf(MeshBasicMaterial);
  expect(wireframe.wireframe).toBe(true);
  expect(wireframe.toneMapped).toBe(false);
});

it("keeps animated characters correct by compiling skinning and morph chunks into the depth override", () => {
  const material = getDirectorCameraPreviewOverrideMaterial("depth") as ShaderMaterial;
  expect(material.vertexShader).toContain("#include <skinning_vertex>");
  expect(material.vertexShader).toContain("#include <morphtarget_vertex>");
});

it("keeps batched scene geometry visible in the depth override", () => {
  const material = getDirectorCameraPreviewOverrideMaterial("depth") as ShaderMaterial;
  expect(material.vertexShader).toMatch(
    /#include <begin_vertex>[\s\S]*#include <batching_vertex>[\s\S]*#include <project_vertex>/,
  );
});

it("keeps animated characters correct in the optical-flow override", () => {
  const material = getDirectorCameraPreviewOverrideMaterial("motion") as ShaderMaterial;
  expect(material.vertexShader).toContain("#include <skinning_vertex>");
  expect(material.vertexShader).toContain("#include <morphtarget_vertex>");
});

it("seeds optical-flow history from the current camera so the first frame is still", () => {
  resetDirectorCameraPreviewMotionHistory();
  const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 100);
  camera.position.set(0, 2, 8);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  updateDirectorCameraPreviewMotionUniforms(camera, 320, 180);
  const material = getDirectorCameraPreviewOverrideMaterial("motion") as ShaderMaterial;
  expect(material.uniforms.uPreviousViewMatrix.value.equals(camera.matrixWorldInverse)).toBe(true);
  expect(material.uniforms.uPreviousProjectionMatrix.value.equals(camera.projectionMatrix)).toBe(true);
  expect(material.uniforms.uResolution.value.x).toBe(320);
  expect(material.uniforms.uMaxMagnitudePx.value).toBeGreaterThan(0);

  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1));
  mesh.position.set(1, 0, 0);
  mesh.updateMatrixWorld();
  scene.add(mesh);
  commitDirectorCameraPreviewMotionHistory(camera, scene);

  camera.position.set(2, 2, 8);
  camera.updateMatrixWorld();
  updateDirectorCameraPreviewMotionUniforms(camera, 320, 180);
  expect(material.uniforms.uPreviousViewMatrix.value.equals(camera.matrixWorldInverse)).toBe(false);

  resetDirectorCameraPreviewMotionHistory();
  updateDirectorCameraPreviewMotionUniforms(camera, 320, 180);
  expect(material.uniforms.uPreviousViewMatrix.value.equals(camera.matrixWorldInverse)).toBe(true);
});

it("swaps scene state for depth preview and restores it exactly once", () => {
  const renderer = createRendererStub();
  const scene = new Scene();
  const background = new Color("#aabbcc");
  scene.background = background;
  const authoredOverride = new MeshBasicMaterial();
  scene.overrideMaterial = authoredOverride;
  scene.add(new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial()));

  const scope = applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "depth");

  expect(scope).not.toBeNull();
  expect(scene.overrideMaterial).toBeInstanceOf(ShaderMaterial);
  expect(scene.background).toBeNull();
  expect(renderer.readClearState()).toEqual({ alpha: 1, hex: "000000" });

  scope!.restore();
  scope!.restore();

  expect(scene.overrideMaterial).toBe(authoredOverride);
  expect(scene.background).toBe(background);
  expect(renderer.readClearState()).toEqual({ alpha: 0.5, hex: "123456" });
});

const lookForward = new Vector3(0, 0, -1);

it("fits the depth ramp to the visible set so aerials and close-ups both stay readable", () => {
  const mesh = new Mesh(new BoxGeometry(2, 2, 2));
  mesh.position.set(0, 0, -10);
  mesh.updateMatrixWorld(true);
  const bounds = computeDirectorCameraPreviewSceneBounds([mesh]);
  expect(bounds).toBeInstanceOf(Box3);

  const range = getDirectorCameraPreviewDepthRange(new Vector3(0, 0, 0), lookForward, bounds);
  expect(range.nearM).toBeCloseTo(9, 5);
  expect(range.farM).toBeCloseTo(11, 5);

  const aerial = getDirectorCameraPreviewDepthRange(new Vector3(0, 200, -10), new Vector3(0, -1, 0), bounds);
  expect(aerial.nearM).toBeCloseTo(199, 5);
  expect(aerial.farM).toBeCloseTo(201, 5);
});

it("ignores set geometry behind the camera when fitting the depth ramp", () => {
  // A long axial set: camera stands inside it at the origin looking down -z.
  const nearHall = new Mesh(new BoxGeometry(2, 2, 2));
  nearHall.position.set(0, 0, -20);
  nearHall.updateMatrixWorld(true);
  const rearGate = new Mesh(new BoxGeometry(2, 2, 2));
  rearGate.position.set(0, 0, 500);
  rearGate.updateMatrixWorld(true);
  const bounds = computeDirectorCameraPreviewSceneBounds([nearHall, rearGate]);

  const range = getDirectorCameraPreviewDepthRange(new Vector3(0, 0, 0), lookForward, bounds);
  // The 500m rear gate is behind the camera and must not stretch the ramp.
  expect(range.farM).toBeCloseTo(21, 5);
  // Inside the set the closest visible surface can hug the lens.
  expect(range.nearM).toBeLessThanOrEqual(1);
});

it("falls back to fixed depth bounds when the scene is empty or fully behind the camera", () => {
  expect(computeDirectorCameraPreviewSceneBounds([])).toBeNull();
  expect(getDirectorCameraPreviewDepthRange(new Vector3(), lookForward, null)).toEqual({
    nearM: DIRECTOR_DEPTH_PREVIEW_NEAR_M,
    farM: DIRECTOR_DEPTH_PREVIEW_FAR_M,
  });

  const behind = new Mesh(new BoxGeometry(2, 2, 2));
  behind.position.set(0, 0, 50);
  behind.updateMatrixWorld(true);
  const bounds = computeDirectorCameraPreviewSceneBounds([behind]);
  expect(getDirectorCameraPreviewDepthRange(new Vector3(0, 0, 0), lookForward, bounds)).toEqual({
    nearM: DIRECTOR_DEPTH_PREVIEW_NEAR_M,
    farM: DIRECTOR_DEPTH_PREVIEW_FAR_M,
  });
});

it("applies the fitted depth range to the override uniforms", () => {
  const renderer = createRendererStub();
  const scene = new Scene();
  const scope = applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "depth", {
    nearM: 4,
    farM: 44,
  });
  const material = scene.overrideMaterial as ShaderMaterial;
  expect(material.uniforms.uDepthNear.value).toBe(4);
  expect(material.uniforms.uDepthFar.value).toBe(44);
  scope!.restore();
});

it("returns no scope for previz and rgb so authored rendering stays untouched", () => {
  const renderer = createRendererStub();
  const scene = new Scene();
  expect(applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "previz")).toBeNull();
  expect(applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "rgb")).toBeNull();
  expect(scene.overrideMaterial).toBeNull();
});

it("overrides the scene with optical-flow visualization and restores the dark background", () => {
  const renderer = createRendererStub();
  const scene = new Scene();
  const background = new Color("#aabbcc");
  scene.background = background;

  const scope = applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "motion");

  expect(scene.overrideMaterial).toBe(getDirectorCameraPreviewOverrideMaterial("motion"));
  expect(scene.background).toBeNull();
  expect(renderer.readClearState()).toEqual({ alpha: 1, hex: "000000" });

  scope!.restore();
  expect(scene.overrideMaterial).toBeNull();
  expect(scene.background).toBe(background);
});

it("overrides the scene with a light wireframe and restores the dark background", () => {
  const renderer = createRendererStub();
  const scene = new Scene();
  const background = new Color("#aabbcc");
  scene.background = background;

  const scope = applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "wireframe");

  const material = scene.overrideMaterial as MeshBasicMaterial;
  expect(material).toBeInstanceOf(MeshBasicMaterial);
  expect(material.wireframe).toBe(true);
  expect(scene.background).toBeNull();
  expect(renderer.readClearState()).toEqual({ alpha: 1, hex: "000000" });

  scope!.restore();
  expect(scene.overrideMaterial).toBeNull();
  expect(scene.background).toBe(background);
});

it("blacks out the background for segmentation modes without a scene override", () => {
  const renderer = createRendererStub();
  const scene = new Scene();
  const authoredOverride = new MeshBasicMaterial();
  scene.overrideMaterial = authoredOverride;

  const scope = applyDirectorCameraPreviewModalityScope(renderer as unknown as WebGLRenderer, scene, "objectid");

  expect(scope).not.toBeNull();
  // Per-mesh segmentation materials must win over any authored override.
  expect(scene.overrideMaterial).toBeNull();
  expect(scene.background).toBeNull();
  expect(renderer.readClearState()).toEqual({ alpha: 1, hex: "000000" });

  scope!.restore();
  expect(scene.overrideMaterial).toBe(authoredOverride);
  expect(renderer.readClearState()).toEqual({ alpha: 0.5, hex: "123456" });
});

function createSegmentationScene() {
  const scene = new Scene();
  const hero = new Group();
  hero.userData.directorObjectId = "prop-hero";
  const heroMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0x123456 }));
  hero.add(heroMesh);
  const extra = new Group();
  extra.userData.directorObjectId = "char-extra";
  const extraMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  extra.add(extraMesh);
  const ground = new Mesh(new PlaneGeometry(10, 10), new MeshBasicMaterial({ color: 0x445566 }));
  scene.add(hero, extra, ground);
  return { scene, heroMesh, extraMesh, ground };
}

it("indexes meshes with the nearest ancestor directorObjectId", () => {
  const { scene, heroMesh, extraMesh, ground } = createSegmentationScene();
  const entries = collectDirectorCameraPreviewSegmentationEntries(scene);

  expect(entries).toEqual([
    { mesh: heroMesh, objectId: "prop-hero" },
    { mesh: extraMesh, objectId: "char-extra" },
    { mesh: ground, objectId: null },
  ]);
});

it("colors object-id segmentation like the capture pass and keeps untagged meshes black", () => {
  const { scene, heroMesh, extraMesh, ground } = createSegmentationScene();
  const originalHeroMaterial = heroMesh.material;
  const entries = collectDirectorCameraPreviewSegmentationEntries(scene);
  const colorMap = createDirectorObjectIdColorMap(["prop-hero", "char-extra"]);

  const scope = applyDirectorCameraPreviewSegmentationScope("objectid", entries);

  const packHex = ([red, green, blue]: [number, number, number]) => (red << 16) | (green << 8) | blue;
  expect((heroMesh.material as MeshBasicMaterial).color.getHex()).toBe(packHex(colorMap["prop-hero"]));
  expect((extraMesh.material as MeshBasicMaterial).color.getHex()).toBe(packHex(colorMap["char-extra"]));
  expect(heroMesh.material).not.toBe(extraMesh.material);
  expect((ground.material as MeshBasicMaterial).color.getHex()).toBe(0x000000);

  scope.restore();
  scope.restore();
  expect(heroMesh.material).toBe(originalHeroMaterial);
  expect((ground.material as MeshBasicMaterial).color.getHex()).toBe(0x445566);
});

it("preserves one object-id color per static primitive instance", () => {
  const scene = new Scene();
  const originalMaterial = new MeshBasicMaterial({ color: 0x123456 });
  const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), originalMaterial, 2);
  instances.userData.directorInstanceObjectIds = ["box-a", "box-b"];
  instances.setMatrixAt(0, new Matrix4().makeTranslation(-1, 0, 0));
  instances.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, 0));
  scene.add(instances);
  const entries = collectDirectorCameraPreviewSegmentationEntries(scene);

  const scope = applyDirectorCameraPreviewSegmentationScope("objectid", entries);

  expect(entries[0]).toMatchObject({ objectId: null, instanceObjectIds: ["box-a", "box-b"] });
  expect(instances.instanceColor).not.toBeNull();
  expect(Array.from(instances.instanceColor!.array.slice(0, 3))).not.toEqual(
    Array.from(instances.instanceColor!.array.slice(3, 6)),
  );
  scope.restore();
  expect(instances.material).toBe(originalMaterial);
  expect(instances.instanceColor).toBeNull();
});

it("preserves object IDs and binary masks for GPU multi-draw batches", () => {
  const scene = new Scene();
  const originalMaterial = new MeshBasicMaterial({ color: 0x123456 });
  const { batch, first, second } = createBatchedBoxPair(originalMaterial);
  scene.add(batch);
  const entries = collectDirectorCameraPreviewSegmentationEntries(scene);

  const objectIdScope = applyDirectorCameraPreviewSegmentationScope("objectid", entries);
  expect((batch.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
  expect(batch.getColorAt(first, new Color()).getHex()).not.toBe(batch.getColorAt(second, new Color()).getHex());
  objectIdScope.restore();
  expect(batch.material).toBe(originalMaterial);
  expect(batch.getColorAt(first, new Color()).getHex()).toBe(0xff0000);

  const maskScope = applyDirectorCameraPreviewSegmentationScope("mask", entries);
  expect((batch.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
  expect(batch.getColorAt(first, new Color()).getHex()).toBe(0xffffff);
  expect(batch.getColorAt(second, new Color()).getHex()).toBe(0xffffff);
  maskScope.restore();
  expect(batch.material).toBe(originalMaterial);
  expect(batch.getColorAt(second, new Color()).getHex()).toBe(0x00ff00);
});

it("reuses cached segmentation materials across renders instead of recreating them", () => {
  const { scene, heroMesh } = createSegmentationScene();
  const entries = collectDirectorCameraPreviewSegmentationEntries(scene);

  const firstScope = applyDirectorCameraPreviewSegmentationScope("objectid", entries);
  const firstMaterial = heroMesh.material;
  firstScope.restore();

  const secondScope = applyDirectorCameraPreviewSegmentationScope("objectid", entries);
  expect(heroMesh.material).toBe(firstMaterial);
  secondScope.restore();
});

it("renders the mask mode as white tagged foreground over black geometry", () => {
  const { scene, heroMesh, extraMesh, ground } = createSegmentationScene();
  const originalGroundMaterial = ground.material;
  const entries = collectDirectorCameraPreviewSegmentationEntries(scene);

  const scope = applyDirectorCameraPreviewSegmentationScope("mask", entries);

  expect((heroMesh.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
  expect((extraMesh.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
  expect(heroMesh.material).toBe(extraMesh.material);
  expect((ground.material as MeshBasicMaterial).color.getHex()).toBe(0x000000);

  scope.restore();
  expect(ground.material).toBe(originalGroundMaterial);
});

it("removes authored static-instance colors while rendering a white mask", () => {
  const scene = new Scene();
  const originalMaterial = new MeshBasicMaterial({ color: 0xffffff });
  const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), originalMaterial, 2);
  instances.userData.directorInstanceObjectIds = ["red-box", "green-box"];
  instances.setColorAt(0, new Color(0xff0000));
  instances.setColorAt(1, new Color(0x00ff00));
  const originalInstanceColor = instances.instanceColor;
  scene.add(instances);

  const scope = applyDirectorCameraPreviewSegmentationScope(
    "mask",
    collectDirectorCameraPreviewSegmentationEntries(scene),
  );

  expect((instances.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
  expect(instances.instanceColor).toBeNull();

  scope.restore();
  expect(instances.material).toBe(originalMaterial);
  expect(instances.instanceColor).toBe(originalInstanceColor);
});
