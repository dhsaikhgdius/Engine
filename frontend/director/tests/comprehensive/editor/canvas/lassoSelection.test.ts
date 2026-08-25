import {
  BatchedMesh,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
} from "three";
import { expect, it } from "vitest";
import { getLassoObjectScreenBounds, getLassoSelectionIds } from "../../../../src/comprehensive/editor/canvas/lassoSelection";

const scene = {
  backgroundColor: "#373a40",
  groundHeight: 0,
  groundOpacity: 0.9,
  panoramaRadius: 60,
  panoramaYaw: 0,
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: 1,
  showGround: true,
  showGrid: true,
  showLabels: true,
  snapToGrid: false,
};

const objects = [
  {
    id: "left",
    kind: "prop" as const,
    name: "Left",
    visible: true,
    locked: false,
    transform: {
      position: [-2, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  },
  {
    id: "right",
    kind: "prop" as const,
    name: "Right",
    visible: true,
    locked: false,
    transform: {
      position: [2, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
  },
];

function createCamera() {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

it("selects objects whose projected centers fall inside the lasso rectangle", () => {
  expect(
    getLassoSelectionIds({
      camera: createCamera(),
      objects,
      scene,
      selection: { startX: 0, startY: 0, endX: 500, endY: 500 },
      viewport: { left: 0, top: 0, width: 500, height: 500 },
    }),
  ).toEqual(["left", "right"]);

  expect(
    getLassoSelectionIds({
      camera: createCamera(),
      objects,
      scene,
      selection: { startX: 200, startY: 200, endX: 300, endY: 300 },
      viewport: { left: 0, top: 0, width: 500, height: 500 },
    }),
  ).toEqual([]);
});

it("selects visible geometry when its screen bounds intersect the rectangle", () => {
  const camera = createCamera();
  const sceneRoot = new Group();
  const objectRoot = new Group();
  objectRoot.userData.directorObjectId = "left";
  objectRoot.position.set(-2, 0, 0);
  objectRoot.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  sceneRoot.add(objectRoot);
  const viewport = { left: 0, top: 0, width: 500, height: 500 };
  const screenBoundsById = getLassoObjectScreenBounds(sceneRoot, camera, viewport);
  const screenBounds = screenBoundsById.get("left");
  expect(screenBounds).toBeDefined();

  const edgeSelection = {
    startX: screenBounds!.minX,
    startY: screenBounds!.minY,
    endX: screenBounds!.minX + 2,
    endY: screenBounds!.maxY,
  };
  expect(getLassoSelectionIds({ camera, objects, scene, selection: edgeSelection, viewport })).toEqual([]);
  expect(
    getLassoSelectionIds({ camera, objects, scene, screenBoundsById, selection: edgeSelection, viewport }),
  ).toEqual(["left"]);
});

it("keeps per-object screen bounds for static primitive instances", () => {
  const camera = createCamera();
  const sceneRoot = new Group();
  const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 2);
  instances.userData.directorInstanceObjectIds = ["left", "right"];
  instances.setMatrixAt(0, new Matrix4().makeTranslation(-2, 0, 0));
  instances.setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
  sceneRoot.add(instances);

  const screenBoundsById = getLassoObjectScreenBounds(sceneRoot, camera, {
    left: 0,
    top: 0,
    width: 500,
    height: 500,
  });

  expect(screenBoundsById.get("left")?.maxX).toBeLessThan(screenBoundsById.get("right")!.minX);
});

it("keeps per-object screen bounds for GPU multi-draw primitive batches", () => {
  const camera = createCamera();
  const sceneRoot = new Group();
  const source = new BoxGeometry(1, 1, 1);
  const positionCount = source.getAttribute("position").count;
  const indexCount = source.getIndex()?.count ?? positionCount;
  const batch = new BatchedMesh(2, positionCount, indexCount, new MeshBasicMaterial());
  const geometryId = batch.addGeometry(source);
  const left = batch.addInstance(geometryId);
  const right = batch.addInstance(geometryId);
  batch.userData.directorInstanceObjectIds = ["left", "right"];
  batch.setMatrixAt(left, new Matrix4().makeTranslation(-2, 0, 0));
  batch.setMatrixAt(right, new Matrix4().makeTranslation(2, 0, 0));
  sceneRoot.add(batch);

  const screenBoundsById = getLassoObjectScreenBounds(sceneRoot, camera, {
    left: 0,
    top: 0,
    width: 500,
    height: 500,
  });

  expect(screenBoundsById.get("left")?.maxX).toBeLessThan(screenBoundsById.get("right")!.minX);
});

it("does not select objects on hidden layers", () => {
  const hiddenObjects = objects.map((object) => (object.id === "left" ? { ...object, layer: "hidden" } : object));

  expect(
    getLassoSelectionIds({
      camera: createCamera(),
      objects: hiddenObjects,
      scene: {
        ...scene,
        objectLayers: [
          { id: "default", visible: true, locked: false },
          { id: "hidden", visible: false, locked: false },
        ],
      },
      selection: { startX: 0, startY: 0, endX: 249, endY: 500 },
      viewport: { left: 0, top: 0, width: 500, height: 500 },
    }),
  ).toEqual([]);
});

it("selects the whole crowd when one visible member is inside the rectangle", () => {
  const crowdObjects = objects.map((object) => ({ ...object, crowdId: "crowd_1" }));

  expect(
    getLassoSelectionIds({
      camera: createCamera(),
      objects: crowdObjects,
      scene,
      selection: { startX: 0, startY: 0, endX: 249, endY: 500 },
      viewport: { left: 0, top: 0, width: 500, height: 500 },
    }),
  ).toEqual(["left", "right"]);
});
