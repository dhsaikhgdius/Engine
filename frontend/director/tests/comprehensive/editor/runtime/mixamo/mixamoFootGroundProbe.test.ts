import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import { prepareMixamoCharacterInstance } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterPrepare";
import { MixamoFootGroundProbe, isMixamoWalkableGroundHit } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootGroundProbe";

function plane(width = 8, height = 8) {
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial());
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function footAt(parent: Group, x: number, y: number, z: number) {
  const foot = new Group();
  foot.position.set(x, y, z);
  parent.add(foot);
  return foot;
}

function createStage() {
  const sceneRoot = new Group();
  const stage = new Group();
  stage.userData.directorObjectKind = "scene";
  sceneRoot.add(stage);
  const ground = plane();
  ground.name = "director-player-ground";
  stage.add(ground);

  const characterRoot = new Group();
  characterRoot.userData.directorObjectKind = "character";
  sceneRoot.add(characterRoot);
  return { characterRoot, sceneRoot, stage };
}

describe("MixamoFootGroundProbe", () => {
  it("samples a step independently for each foot and keeps the result object stable", () => {
    const { characterRoot, sceneRoot, stage } = createStage();
    const step = new Mesh(new BoxGeometry(0.7, 0.32, 0.8), new MeshBasicMaterial());
    step.position.set(-0.42, 0.16, 0);
    stage.add(step);
    const leftFoot = footAt(characterRoot, -0.42, 0.11, 0);
    const rightFoot = footAt(characterRoot, 0.42, 0.11, 0);
    sceneRoot.updateMatrixWorld(true);
    const probe = new MixamoFootGroundProbe();
    const first = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      rightFoot,
      fallbackGroundHeightWorld: 0,
    });
    const second = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      rightFoot,
      fallbackGroundHeightWorld: 0,
    });

    expect(second).toBe(first);
    expect(first.leftHit).toBe(true);
    expect(first.leftGroundHeightWorld).toBeCloseTo(0.32, 5);
    expect(first.rightHit).toBe(true);
    expect(first.rightGroundHeightWorld).toBeCloseTo(0, 5);
  });

  it("tracks the two heights of a walkable incline", () => {
    const { characterRoot, sceneRoot, stage } = createStage();
    const incline = plane(3, 3);
    incline.position.y = 0.35;
    incline.rotation.order = "ZXY";
    incline.rotation.z = Math.PI / 9;
    stage.add(incline);
    const leftFoot = footAt(characterRoot, -0.5, 0.45, 0);
    const rightFoot = footAt(characterRoot, 0.5, 0.45, 0);
    sceneRoot.updateMatrixWorld(true);

    const sample = new MixamoFootGroundProbe().sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      rightFoot,
      fallbackGroundHeightWorld: 0,
    });

    expect(sample.leftHit).toBe(true);
    expect(sample.rightHit).toBe(true);
    expect(Math.abs(sample.leftGroundHeightWorld - sample.rightGroundHeightWorld)).toBeGreaterThan(0.2);
    expect(sample.leftGroundHeightWorld).toBeGreaterThanOrEqual(0);
    expect(sample.rightGroundHeightWorld).toBeGreaterThanOrEqual(0);
  });

  it("reports each foot's walkable world normal independently and reuses the vector instances", () => {
    const { characterRoot, sceneRoot, stage } = createStage();
    const tiltRad = Math.PI / 9;
    const slope = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshBasicMaterial());
    slope.position.set(-0.5, 0.5, 0);
    slope.rotation.x = tiltRad;
    stage.add(slope);
    const leftFoot = footAt(characterRoot, -0.5, 0.75, 0);
    const rightFoot = footAt(characterRoot, 0.5, 0.11, 0);
    sceneRoot.updateMatrixWorld(true);
    const probe = new MixamoFootGroundProbe();

    const first = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      rightFoot,
      fallbackGroundHeightWorld: 0,
    });
    const leftNormal = first.leftGroundNormalWorld;
    const rightNormal = first.rightGroundNormalWorld;

    expect(first.leftHit).toBe(true);
    expect(leftNormal.x).toBeCloseTo(0, 5);
    expect(leftNormal.y).toBeCloseTo(Math.cos(tiltRad), 5);
    expect(leftNormal.z).toBeCloseTo(Math.sin(tiltRad), 5);
    expect(first.rightHit).toBe(true);
    expect(rightNormal.x).toBeCloseTo(0, 5);
    expect(rightNormal.y).toBeCloseTo(1, 5);
    expect(rightNormal.z).toBeCloseTo(0, 5);

    const second = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      rightFoot,
      fallbackGroundHeightWorld: 0,
    });
    expect(second.leftGroundNormalWorld).toBe(leftNormal);
    expect(second.rightGroundNormalWorld).toBe(rightNormal);
    expect(second.leftGroundNormalWorld.z).toBeCloseTo(Math.sin(tiltRad), 5);
  });

  it("resets a previously inclined normal to up when the probe misses or a foot is absent", () => {
    const { characterRoot, sceneRoot, stage } = createStage();
    const slope = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshBasicMaterial());
    slope.position.set(0, 0.5, 0);
    slope.rotation.x = Math.PI / 9;
    stage.add(slope);
    const inclinedFoot = footAt(characterRoot, 0, 0.75, 0);
    sceneRoot.updateMatrixWorld(true);
    const probe = new MixamoFootGroundProbe();
    const inclined = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot: inclinedFoot,
      fallbackGroundHeightWorld: 0,
    });
    expect(inclined.leftHit).toBe(true);
    expect(inclined.leftGroundNormalWorld.z).toBeGreaterThan(0.3);

    const emptySceneRoot = new Group();
    const emptyCharacterRoot = new Group();
    emptySceneRoot.add(emptyCharacterRoot);
    const strandedFoot = footAt(emptyCharacterRoot, 0, 2, 0);
    emptySceneRoot.updateMatrixWorld(true);
    const missed = probe.sample({
      sceneRoot: emptySceneRoot,
      characterRoot: emptyCharacterRoot,
      leftFoot: strandedFoot,
      fallbackGroundHeightWorld: 0,
    });

    expect(missed.leftHit).toBe(false);
    expect(missed.leftGroundNormalWorld.x).toBeCloseTo(0, 6);
    expect(missed.leftGroundNormalWorld.y).toBeCloseTo(1, 6);
    expect(missed.leftGroundNormalWorld.z).toBeCloseTo(0, 6);
    expect(missed.rightHit).toBe(false);
    expect(missed.rightGroundNormalWorld.y).toBeCloseTo(1, 6);
  });

  it("rejects a surface steeper than the player motor climb limit", () => {
    const { characterRoot, sceneRoot, stage } = createStage();
    const steepSurface = plane(3, 3);
    steepSurface.position.y = 0.4;
    steepSurface.rotation.order = "ZXY";
    steepSurface.rotation.z = Math.PI / 3;
    stage.add(steepSurface);
    const leftFoot = footAt(characterRoot, 0, 0.2, 0);
    sceneRoot.updateMatrixWorld(true);

    const sample = new MixamoFootGroundProbe().sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      fallbackGroundHeightWorld: 0,
    });

    expect(sample.leftHit).toBe(true);
    expect(sample.leftGroundHeightWorld).toBeCloseTo(0, 5);
  });

  it("ignores the character, cameras, helpers, and explicitly non-collidable meshes", () => {
    const { characterRoot, sceneRoot } = createStage();
    const leftFoot = footAt(characterRoot, 0, 0.1, 0);
    const rightFoot = footAt(characterRoot, 0.4, 0.1, 0);
    const selfMesh = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
    selfMesh.position.y = 0.42;
    characterRoot.add(selfMesh);
    const camera = new Group();
    camera.userData.directorObjectKind = "camera";
    const cameraHitArea = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
    cameraHitArea.position.y = 0.36;
    camera.add(cameraHitArea);
    sceneRoot.add(camera);
    const helper = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
    helper.position.y = 0.3;
    helper.userData.hideFromViewportCapture = true;
    sceneRoot.add(helper);
    const nonCollidable = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshBasicMaterial());
    nonCollidable.position.y = 0.24;
    nonCollidable.userData.directorGroundRaycastDisabled = true;
    sceneRoot.add(nonCollidable);
    sceneRoot.updateMatrixWorld(true);

    const sample = new MixamoFootGroundProbe().sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      rightFoot,
      fallbackGroundHeightWorld: 0,
    });

    expect(isMixamoWalkableGroundHit(selfMesh, characterRoot)).toBe(false);
    expect(isMixamoWalkableGroundHit(cameraHitArea, characterRoot)).toBe(false);
    expect(isMixamoWalkableGroundHit(helper, characterRoot)).toBe(false);
    expect(isMixamoWalkableGroundHit(nonCollidable, characterRoot)).toBe(false);
    expect(sample.leftGroundHeightWorld).toBeCloseTo(0, 5);
    expect(sample.rightGroundHeightWorld).toBeCloseTo(0, 5);
  });

  it("falls back independently when a foot or a walkable surface is missing", () => {
    const sceneRoot = new Group();
    const characterRoot = new Group();
    sceneRoot.add(characterRoot);
    const leftFoot = footAt(characterRoot, -0.2, 2, 0);
    sceneRoot.updateMatrixWorld(true);
    const sample = new MixamoFootGroundProbe().sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      fallbackGroundHeightWorld: 1.25,
    });

    expect(sample.leftHit).toBe(false);
    expect(sample.rightHit).toBe(false);
    expect(sample.leftGroundHeightWorld).toBe(1.25);
    expect(sample.rightGroundHeightWorld).toBe(1.25);
  });

  it("never invokes Line2-like helper raycasts and caches real mesh candidates", () => {
    const { characterRoot, sceneRoot } = createStage();
    const leftFoot = footAt(characterRoot, 0, 0.15, 0);
    const throwingHelper = new Object3D();
    throwingHelper.name = "drei-camera-frustum-line2";
    throwingHelper.raycast = vi.fn(() => {
      throw new Error("LineSegments2: Raycaster.camera needs to be set");
    });
    sceneRoot.add(throwingHelper);
    sceneRoot.updateMatrixWorld(true);
    const traverse = vi.spyOn(sceneRoot, "traverse");
    const probe = new MixamoFootGroundProbe();

    const first = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      fallbackGroundHeightWorld: -1,
    });
    const traversalCountAfterFirstSample = traverse.mock.calls.length;
    const second = probe.sample({
      sceneRoot,
      characterRoot,
      leftFoot,
      fallbackGroundHeightWorld: -1,
    });

    expect(throwingHelper.raycast).not.toHaveBeenCalled();
    expect(traversalCountAfterFirstSample).toBeGreaterThan(0);
    expect(traverse).toHaveBeenCalledTimes(traversalCountAfterFirstSample);
    expect(first.leftHit).toBe(true);
    expect(second.leftHit).toBe(true);
    expect(second.leftGroundHeightWorld).toBeCloseTo(0, 5);
  });

  it("refreshes an initially empty owner after async mesh mount and removes stale meshes", async () => {
    const sceneRoot = new Group();
    const characterRoot = new Group();
    characterRoot.userData.directorObjectKind = "character";
    sceneRoot.add(characterRoot);
    const leftFoot = footAt(characterRoot, 0, 0.15, 0);
    sceneRoot.updateMatrixWorld(true);
    const probe = new MixamoFootGroundProbe();
    const input = {
      sceneRoot,
      characterRoot,
      leftFoot,
      fallbackGroundHeightWorld: -1,
    };

    expect(probe.sample(input).leftHit).toBe(false);

    const asyncGround = plane();
    sceneRoot.add(asyncGround);
    sceneRoot.updateMatrixWorld(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(probe.sample(input).leftGroundHeightWorld).toBeCloseTo(0, 5);
    expect(probe.sample(input).leftHit).toBe(true);

    sceneRoot.remove(asyncGround);
    sceneRoot.updateMatrixWorld(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const removed = probe.sample(input);
    expect(removed.leftHit).toBe(false);
    expect(removed.leftGroundHeightWorld).toBe(-1);
  });
});

localAssetIt("samples independent real X Bot foot surfaces", async () => {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/mixamo-characters/models/x-bot.glb"));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  const gltf = await configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
  const prepared = prepareMixamoCharacterInstance(gltf.scene, "x-bot-ground-probe", 1.78);
  const sceneRoot = new Group();
  const stage = new Group();
  stage.userData.directorObjectKind = "scene";
  sceneRoot.add(stage);
  stage.add(plane());
  const characterRoot = new Group();
  characterRoot.userData.directorObjectKind = "character";
  characterRoot.add(prepared.scene);
  sceneRoot.add(characterRoot);
  sceneRoot.updateMatrixWorld(true);

  const leftWorld = prepared.resolvedBones.leftFoot!.getWorldPosition(new Vector3());
  const step = new Mesh(new BoxGeometry(0.06, 0.18, 0.12), new MeshBasicMaterial());
  step.position.set(leftWorld.x, 0.09, leftWorld.z);
  stage.add(step);
  sceneRoot.updateMatrixWorld(true);

  const sample = new MixamoFootGroundProbe().sample({
    sceneRoot,
    characterRoot,
    leftFoot: prepared.resolvedBones.leftFoot,
    rightFoot: prepared.resolvedBones.rightFoot,
    fallbackGroundHeightWorld: 0,
  });

  expect(sample.leftHit).toBe(true);
  expect(sample.leftGroundHeightWorld).toBeCloseTo(0.18, 5);
  expect(sample.rightHit).toBe(true);
  expect(sample.rightGroundHeightWorld).toBeCloseTo(0, 5);
});
