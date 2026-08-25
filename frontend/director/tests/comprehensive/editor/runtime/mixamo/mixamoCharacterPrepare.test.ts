import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import { prepareMixamoCharacterInstance, resetMixamoCharacterScaleCache } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterPrepare";

const HERO_FBX_URL = "/director-characters/models/Standing%20Idle.fbx";

function loadHeroFbx() {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/director-characters/models/Standing Idle.fbx"));
  return new FBXLoader().parse(binary.buffer, "");
}

localAssetIt("captures rest pose and deform bones in one hierarchy walk", async () => {
  const { captureMixamoRestPose, captureMixamoRestPoseAndBones, collectMixamoBones } =
    await import("../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig");
  const fbx = loadHeroFbx();
  const combined = captureMixamoRestPoseAndBones(fbx);
  const restPose = captureMixamoRestPose(fbx);
  const bones = collectMixamoBones(fbx);

  expect(Object.keys(combined.restPose)).toEqual(Object.keys(restPose));
  expect(combined.bones.map((bone) => bone.uuid)).toEqual(bones.map((bone) => bone.uuid));
});

localAssetIt("prepares the bundled hero FBX at the catalog height and reuses scale measurements", () => {
  resetMixamoCharacterScaleCache();
  const source = loadHeroFbx();
  const first = prepareMixamoCharacterInstance(source, HERO_FBX_URL, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);
  const second = prepareMixamoCharacterInstance(source, HERO_FBX_URL, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);

  expect(first.metrics?.height).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, 2);
  expect(first.metrics?.bounds.min[1]).toBeCloseTo(0, 4);
  expect(second.metrics?.height).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, 2);
  expect(second.scene).not.toBe(first.scene);
});

it("normalizes layout with a cached scale factor", async () => {
  const { normalizeMixamoCharacterLayout } = await import("../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig");
  const { BoxGeometry, Group, Mesh, MeshStandardMaterial } = await import("three");
  const character = new Group();
  const body = new Mesh(new BoxGeometry(0.8, 180, 0.4), new MeshStandardMaterial());
  body.position.y = -90;
  character.add(body);
  character.updateMatrixWorld(true);

  const measured = normalizeMixamoCharacterLayout(character, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);
  expect(measured.scaleFactor).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M / 180, 6);
  expect(measured.metrics?.height).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, 3);

  const duplicate = new Group();
  const duplicateBody = new Mesh(new BoxGeometry(0.8, 180, 0.4), new MeshStandardMaterial());
  duplicateBody.position.y = -90;
  duplicate.add(duplicateBody);
  duplicate.updateMatrixWorld(true);

  const cached = normalizeMixamoCharacterLayout(duplicate, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, measured.scaleFactor);
  expect(cached.scaleFactor).toBeCloseTo(measured.scaleFactor, 6);
  expect(cached.metrics?.height).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, 3);
  expect(cached.metrics?.bounds.min[1]).toBeCloseTo(0, 5);
});
