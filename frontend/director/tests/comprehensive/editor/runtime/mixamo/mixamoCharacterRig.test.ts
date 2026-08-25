import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AnimationMixer,
  Bone,
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import { DIRECTOR_CHARACTER_MOTION_CATALOG } from "@director/agent-engine/character-motions";
import {
  alignMixamoCharacterToGround,
  applyMixamoCharacterIk,
  applyMixamoRigLayers,
  applyMixamoRestPoseAndRig,
  canonicalizeMixamoBoneName,
  captureMixamoRestPose,
  cloneMixamoCharacterScene,
  collectMixamoBones,
  DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M,
  disposeMixamoCharacterInstanceMaterials,
  getMixamoCharacterIkRuntime,
  measureMixamoCharacter,
  resolveMixamoBones,
  restoreMixamoRestPose,
  scaleMixamoCharacterToTargetHeight,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import {
  configureDirectorCharacterMotionAction,
  retargetMixamoAnimationClip,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion";
import {
  applyMixamoFootGrounding,
  createMixamoFootGroundingState,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootGrounding";

async function loadPackagedMixamoCharacter(fileName: string) {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/mixamo-characters/models", fileName));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  const loader = configureDirectorGLTFLoader(new GLTFLoader());

  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  return loader.parseAsync(data, "");
}

async function loadPackagedMixamoMotion(fileName: string) {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/mixamo-animations/clips", fileName));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  return configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
}

function createRightArmIkRig() {
  const root = new Group();
  const upperArm = new Bone();
  const lowerArm = new Bone();
  const hand = new Bone();
  upperArm.name = "mixamorig:RightArm";
  lowerArm.name = "mixamorig:RightForeArm";
  hand.name = "mixamorig:RightHand";
  upperArm.position.set(0, 1, 0);
  lowerArm.position.set(0, -1, 0);
  hand.position.set(0, -1, 0);
  upperArm.add(lowerArm);
  lowerArm.add(hand);
  root.add(upperArm);
  return {
    root,
    hand,
    bones: resolveMixamoBones(root),
    restPose: captureMixamoRestPose(root),
  };
}

it.each([
  ["mixamorig:Hips", "hips"],
  ["mixamorig1:LeftForeArm", "leftforearm"],
  ["mixamorig_12_Right_Hand", "righthand"],
  ["Armature|mixamorig-3-Head", "head"],
  ["LeftUpLeg", "leftupleg"],
])("canonicalizes Mixamo namespace variant %s", (source, expected) => {
  expect(canonicalizeMixamoBoneName(source)).toBe(expected);
});

localAssetIt("maps Director signed hip spread to symmetric outward movement on the real X Bot skeleton", async () => {
  const gltf = await loadPackagedMixamoCharacter("x-bot.glb");
  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  const bones = resolveMixamoBones(character);
  character.updateMatrixWorld(true);
  const leftBefore = character.worldToLocal(bones.leftKnee!.getWorldPosition(new Vector3())).x;
  const rightBefore = character.worldToLocal(bones.rightKnee!.getWorldPosition(new Vector3())).x;

  applyMixamoRestPoseAndRig(character, {
    controls: { "leftHip.spread": -34, "rightHip.spread": 34 },
    restPose,
  });

  const leftAfter = character.worldToLocal(bones.leftKnee!.getWorldPosition(new Vector3())).x;
  const rightAfter = character.worldToLocal(bones.rightKnee!.getWorldPosition(new Vector3())).x;
  expect(leftAfter).toBeGreaterThan(leftBefore);
  expect(rightAfter).toBeLessThan(rightBefore);
  expect(Math.abs(leftAfter)).toBeCloseTo(Math.abs(rightAfter), 4);
});

localAssetIt("lowers both T-pose arms on the real X Bot local X axis", async () => {
  const gltf = await loadPackagedMixamoCharacter("x-bot.glb");
  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  const bones = resolveMixamoBones(character);

  applyMixamoRestPoseAndRig(character, { controls: {}, restPose });

  character.updateMatrixWorld(true);
  const leftShoulder = character.worldToLocal(bones.leftShoulder!.getWorldPosition(new Vector3()));
  const leftHand = character.worldToLocal(bones.leftHand!.getWorldPosition(new Vector3()));
  const rightShoulder = character.worldToLocal(bones.rightShoulder!.getWorldPosition(new Vector3()));
  const rightHand = character.worldToLocal(bones.rightHand!.getWorldPosition(new Vector3()));
  expect(leftHand.y).toBeLessThan(leftShoulder.y - 0.4);
  expect(rightHand.y).toBeLessThan(rightShoulder.y - 0.4);
  expect(leftHand.x).toBeGreaterThan(leftShoulder.x);
  expect(rightHand.x).toBeLessThan(rightShoulder.x);
});

it("resolves standard semantic bones across namespaced, underscored and bare node names", () => {
  const root = new Group();
  const namedBones = [
    "mixamorig:Hips",
    "mixamorig1:Spine2",
    "Head",
    "mixamorig_LeftArm",
    "mixamorig2:RightArm",
    "mixamorig_4_LeftForeArm",
    "RightForeArm",
    "LeftUpLeg",
    "mixamorig1:RightUpLeg",
    "mixamorig_LeftLeg",
    "RightLeg",
    "LeftFoot",
    "RightFoot",
  ];

  namedBones.forEach((name) => {
    const bone = new Bone();
    bone.name = name;
    root.add(bone);
  });

  const bones = resolveMixamoBones(root);

  expect(bones.body?.name).toBe("mixamorig:Hips");
  expect(bones.torso?.name).toBe("mixamorig1:Spine2");
  expect(bones.leftShoulder?.name).toBe("mixamorig_LeftArm");
  expect(bones.rightElbow?.name).toBe("RightForeArm");
  expect(bones.leftHip?.name).toBe("LeftUpLeg");
  expect(bones.rightFoot?.name).toBe("RightFoot");
});

it("clones the skinned hierarchy and isolates materials for each character instance", () => {
  const source = new Group();
  const rootBone = new Bone();
  const childBone = new Bone();
  rootBone.name = "mixamorig:Hips";
  childBone.name = "mixamorig:Spine";
  rootBone.add(childBone);

  const material = new MeshStandardMaterial({ color: "#ffffff" });
  const mesh = new SkinnedMesh(new BoxGeometry(), material);
  mesh.add(rootBone);
  mesh.bind(new Skeleton([rootBone, childBone]));
  source.add(mesh);

  const first = cloneMixamoCharacterScene(source);
  const second = cloneMixamoCharacterScene(source);
  const firstMesh = first.children[0] as SkinnedMesh;
  const secondMesh = second.children[0] as SkinnedMesh;

  expect(firstMesh.skeleton).not.toBe(mesh.skeleton);
  expect(firstMesh.skeleton.bones[0]).not.toBe(rootBone);
  expect(firstMesh.skeleton.bones[0]).not.toBe(secondMesh.skeleton.bones[0]);
  expect(firstMesh.material).not.toBe(material);
  expect(firstMesh.material).not.toBe(secondMesh.material);

  (firstMesh.material as MeshStandardMaterial).color.set("#ff0000");
  expect((secondMesh.material as MeshStandardMaterial).color.getHexString()).toBe("ffffff");

  const firstMaterial = firstMesh.material as MeshStandardMaterial;
  const dispose = vi.spyOn(firstMaterial, "dispose");
  const sourceDispose = vi.spyOn(material, "dispose");
  disposeMixamoCharacterInstanceMaterials(first);
  expect(dispose).toHaveBeenCalledOnce();
  expect(sourceDispose).not.toHaveBeenCalled();
});

it("restores bind transforms before applying semantic controls so pose changes do not accumulate", () => {
  const root = new Group();
  const hips = new Bone();
  const head = new Bone();
  hips.name = "mixamorig3:Hips";
  head.name = "mixamorig3:Head";
  hips.add(head);
  root.add(hips);
  const restPose = captureMixamoRestPose(root);

  applyMixamoRestPoseAndRig(root, {
    controls: { "head.yaw": 35 },
    restPose,
  });
  const first = head.quaternion.clone();

  applyMixamoRestPoseAndRig(root, {
    controls: { "head.yaw": -15 },
    restPose,
  });
  const second = head.quaternion.clone();

  applyMixamoRestPoseAndRig(root, {
    controls: { "head.yaw": -15 },
    restPose,
  });

  expect(head.quaternion.angleTo(second)).toBeLessThan(0.000001);
  expect(head.quaternion.angleTo(first)).toBeGreaterThan(0.1);
});

it("reuses indexed bones during frame sampling without traversing the character hierarchy", () => {
  const root = new Group();
  const hips = new Bone();
  const head = new Bone();
  hips.name = "mixamorig:Hips";
  head.name = "mixamorig:Head";
  hips.add(head);
  root.add(hips);
  const restPose = captureMixamoRestPose(root);
  const deformBones = collectMixamoBones(root);
  const resolvedBones = resolveMixamoBones(root, deformBones);
  const traverse = vi.spyOn(root, "traverse");

  head.rotation.y = 0.5;
  restoreMixamoRestPose(root, restPose, { bones: deformBones, updateMatrixWorld: false });
  applyMixamoRigLayers(root, {
    controls: {},
    restPose,
    animated: true,
    bones: resolvedBones,
  });

  expect(traverse).not.toHaveBeenCalled();
  expect(head.rotation.y).toBeCloseTo(0, 6);
});

it("applies Agent-authored IK goals to the real Mixamo deform chain", () => {
  const root = new Group();
  const upperArm = new Bone();
  const lowerArm = new Bone();
  const hand = new Bone();
  upperArm.name = "mixamorig:RightArm";
  lowerArm.name = "mixamorig:RightForeArm";
  hand.name = "mixamorig:RightHand";
  upperArm.position.set(0, 1, 0);
  lowerArm.position.set(0, -1, 0);
  hand.position.set(0, -1, 0);
  upperArm.add(lowerArm);
  lowerArm.add(hand);
  root.add(upperArm);
  const restPose = captureMixamoRestPose(root);

  applyMixamoRestPoseAndRig(root, {
    controls: {},
    ik: {
      rightHand: {
        target: [1, 0, 0],
        pole: [0, 1, 1],
        weight: 1,
        reachClamp: 1,
      },
    },
    restPose,
  });

  root.updateMatrixWorld(true);
  const handPosition = root.worldToLocal(hand.getWorldPosition(new Vector3()));
  expect(handPosition.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(0.0001);
});

it("reuses per-character IK scratch across frames while isolating separate characters", () => {
  const first = createRightArmIkRig();
  const firstRuntime = getMixamoCharacterIkRuntime(first.root);
  const firstSolution = firstRuntime.chains.rightHand.solver.solution;
  const firstMiddle = firstSolution.middle;
  const firstTargetRootLocal = firstRuntime.chains.rightHand.targetRootLocal;
  const firstAimTargetWorld = firstRuntime.chains.rightHand.aim.targetWorldPosition;
  const target = {
    rightHand: {
      target: [1, 0, 0] as [number, number, number],
      pole: [0, 1, 1] as [number, number, number],
      weight: 1,
      reachClamp: 1,
    },
  };

  applyMixamoCharacterIk(first.root, first.bones, target);
  const firstFramePosition = first.root.worldToLocal(first.hand.getWorldPosition(new Vector3())).clone();
  const firstSolutionSnapshot = [...firstSolution.middle, ...firstSolution.end];
  restoreMixamoRestPose(first.root, first.restPose);
  applyMixamoCharacterIk(first.root, first.bones, target);
  const secondFramePosition = first.root.worldToLocal(first.hand.getWorldPosition(new Vector3()));

  expect(getMixamoCharacterIkRuntime(first.root)).toBe(firstRuntime);
  expect(firstRuntime.chains.rightHand.solver.solution).toBe(firstSolution);
  expect(firstRuntime.chains.rightHand.solver.solution.middle).toBe(firstMiddle);
  expect(firstRuntime.chains.rightHand.targetRootLocal).toBe(firstTargetRootLocal);
  expect(firstRuntime.chains.rightHand.aim.targetWorldPosition).toBe(firstAimTargetWorld);
  expect(firstRuntime.applications).toBe(2);
  expect(secondFramePosition.distanceTo(firstFramePosition)).toBeLessThan(0.000001);
  expect(secondFramePosition.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(0.0001);

  const second = createRightArmIkRig();
  const secondRuntime = getMixamoCharacterIkRuntime(second.root);
  expect(secondRuntime).not.toBe(firstRuntime);
  expect(secondRuntime.chains.rightHand.solver).not.toBe(firstRuntime.chains.rightHand.solver);
  expect(secondRuntime.chains.rightHand.aim).not.toBe(firstRuntime.chains.rightHand.aim);

  applyMixamoCharacterIk(second.root, second.bones, {
    rightHand: {
      target: [-1, 0, 0],
      pole: [0, 1, -1],
      weight: 1,
      reachClamp: 1,
    },
  });
  expect([...firstSolution.middle, ...firstSolution.end]).toEqual(firstSolutionSnapshot);
  expect(secondRuntime.applications).toBe(1);
});

it("mirrors right-hand IK even when the upper-arm local offset carries no lateral information", () => {
  // Mixamo upper-arm bones hang below mirrored shoulder joints with local
  // x ~ 0; the tiny signed noise used to be read as "the right chain is on
  // +X", which pulled right-hand goals across the body while the left hand
  // behaved. The side must come from the posed chain root instead.
  const root = new Group();
  const shoulder = new Bone();
  const upperArm = new Bone();
  const lowerArm = new Bone();
  const hand = new Bone();
  shoulder.name = "mixamorig:RightShoulder";
  upperArm.name = "mixamorig:RightArm";
  lowerArm.name = "mixamorig:RightForeArm";
  hand.name = "mixamorig:RightHand";
  shoulder.position.set(-0.35, 1.4, 0);
  upperArm.position.set(0.0001, -0.05, 0);
  lowerArm.position.set(0, -0.3, 0);
  hand.position.set(0, -0.3, 0);
  shoulder.add(upperArm);
  upperArm.add(lowerArm);
  lowerArm.add(hand);
  root.add(shoulder);
  const restPose = captureMixamoRestPose(root);
  const directorTarget = new Vector3(0.4, 1.2, 0.2);
  const mirroredTarget = new Vector3(-directorTarget.x, directorTarget.y, directorTarget.z);

  applyMixamoRestPoseAndRig(root, {
    controls: {},
    ik: {
      rightHand: {
        target: directorTarget.toArray() as [number, number, number],
        pole: [-0.4, 1.1, 0.6],
        weight: 1,
        reachClamp: 1,
      },
    },
    restPose,
  });

  root.updateMatrixWorld(true);
  const handPosition = root.worldToLocal(hand.getWorldPosition(new Vector3()));
  expect(handPosition.x).toBeLessThan(-0.2);
  expect(handPosition.distanceTo(mirroredTarget)).toBeLessThan(0.05);
  expect(handPosition.distanceTo(directorTarget)).toBeGreaterThan(0.6);
});

localAssetIt("maps Director right-hand IK coordinates onto the packaged Mixamo handedness", async () => {
  const gltf = await loadPackagedMixamoCharacter("x-bot.glb");
  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  const bones = resolveMixamoBones(character);
  const directorTarget = new Vector3(0.45, 1.1, 0.1);
  const mixamoTarget = new Vector3(-directorTarget.x, directorTarget.y, directorTarget.z);

  applyMixamoRestPoseAndRig(character, {
    controls: {},
    ik: {
      rightHand: {
        target: directorTarget.toArray(),
        pole: [0.4, 1, 0.7],
        weight: 1,
        reachClamp: 1,
      },
    },
    restPose,
  });

  character.updateMatrixWorld(true);
  const handPosition = character.worldToLocal(bones.rightHand!.getWorldPosition(new Vector3()));
  expect(handPosition.distanceTo(mixamoTarget)).toBeLessThan(0.001);
  expect(handPosition.distanceTo(directorTarget)).toBeGreaterThan(0.8);
});

localAssetIt("maps Director left-hand IK coordinates onto the packaged Mixamo handedness", async () => {
  const gltf = await loadPackagedMixamoCharacter("x-bot.glb");
  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  const bones = resolveMixamoBones(character);
  const directorTarget = new Vector3(-0.45, 1.1, 0.1);
  const mixamoTarget = new Vector3(-directorTarget.x, directorTarget.y, directorTarget.z);

  applyMixamoRestPoseAndRig(character, {
    controls: {},
    ik: {
      leftHand: {
        target: directorTarget.toArray(),
        pole: [-0.4, 1, 0.7],
        weight: 1,
        reachClamp: 1,
      },
    },
    restPose,
  });

  character.updateMatrixWorld(true);
  const handPosition = character.worldToLocal(bones.leftHand!.getWorldPosition(new Vector3()));
  expect(handPosition.distanceTo(mixamoTarget)).toBeLessThan(0.0001);
  expect(handPosition.distanceTo(directorTarget)).toBeGreaterThan(0.8);
});

it("keeps IK targets in Director metres for centimetre-authored Mixamo roots", () => {
  const root = new Group();
  root.scale.setScalar(0.01);
  root.position.y = 0.25;
  const upperArm = new Bone();
  const lowerArm = new Bone();
  const hand = new Bone();
  upperArm.name = "mixamorig:RightArm";
  lowerArm.name = "mixamorig:RightForeArm";
  hand.name = "mixamorig:RightHand";
  upperArm.position.set(0, 100, 0);
  lowerArm.position.set(0, -100, 0);
  hand.position.set(0, -100, 0);
  upperArm.add(lowerArm);
  lowerArm.add(hand);
  root.add(upperArm);
  const restPose = captureMixamoRestPose(root);

  applyMixamoRestPoseAndRig(root, {
    controls: {},
    ik: {
      rightHand: {
        target: [1, 0.25, 0],
        pole: [0, 1.25, 1],
        weight: 1,
        reachClamp: 1,
      },
    },
    restPose,
  });

  root.updateMatrixWorld(true);
  expect(hand.getWorldPosition(new Vector3()).distanceTo(new Vector3(1, 0.25, 0))).toBeLessThan(0.0001);
});

it("applies body offsetY in Director metres after character normalization", () => {
  const root = new Group();
  root.scale.setScalar(0.01);
  root.position.y = 0.25;
  const hips = new Bone();
  hips.name = "mixamorig:Hips";
  hips.position.y = 100;
  root.add(hips);
  const restPose = captureMixamoRestPose(root);
  root.updateMatrixWorld(true);
  const before = hips.getWorldPosition(new Vector3());

  applyMixamoRestPoseAndRig(root, {
    controls: { "body.offsetY": 0.2 },
    restPose,
  });

  root.updateMatrixWorld(true);
  const after = hips.getWorldPosition(new Vector3());
  expect(after.y - before.y).toBeCloseTo(0.2, 6);
});

it("scales centimetre-authored Mixamo exports into Director metre space", () => {
  const character = new Group();
  const body = new Mesh(new BoxGeometry(0.8, 180, 0.4), new MeshStandardMaterial());
  body.position.y = -90;
  character.add(body);
  character.updateMatrixWorld(true);

  const scaleFactor = scaleMixamoCharacterToTargetHeight(character, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);
  alignMixamoCharacterToGround(character);
  const metrics = measureMixamoCharacter(character);

  expect(scaleFactor).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M / 180, 6);
  expect(metrics?.height).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, 3);
  expect(metrics?.bounds.min[1]).toBeCloseTo(0, 5);
  expect(metrics?.visualCenter[1]).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M / 2, 3);
});

localAssetIt("leaves already metre-scaled packaged GLB characters unchanged", async () => {
  const gltf = await loadPackagedMixamoCharacter("mannequin.glb");
  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  applyMixamoRestPoseAndRig(character, { controls: {}, restPose });

  const beforeScale = character.scale.clone();
  const scaleFactor = scaleMixamoCharacterToTargetHeight(character, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);
  const metrics = measureMixamoCharacter(character);

  expect(scaleFactor).toBe(1);
  expect(character.scale.toArray()).toEqual(beforeScale.toArray());
  expect(metrics?.height).toBeGreaterThan(1.5);
  expect(metrics?.height).toBeLessThan(2.3);
});

localAssetIt("normalizes the bundled Director hero FBX into metre space", () => {
  const binary = readFileSync(resolve(process.cwd(), "assets/library/director-characters/models/Standing Idle.fbx"));
  const fbx = new FBXLoader().parse(binary.buffer, "") as Group;
  const restPose = captureMixamoRestPose(fbx);
  applyMixamoRestPoseAndRig(fbx, { controls: {}, restPose });

  scaleMixamoCharacterToTargetHeight(fbx, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);
  alignMixamoCharacterToGround(fbx);
  const metrics = measureMixamoCharacter(fbx);

  expect(metrics?.height).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M, 2);
  expect(metrics?.bounds.min[1]).toBeCloseTo(0, 4);
  expect(metrics?.visualCenter[1]).toBeCloseTo(DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M / 2, 2);
});

it("grounds visible geometry exactly at y=0 and reports a local visual center and label anchor", () => {
  const wrapper = new Group();
  const character = new Group();
  const body = new Mesh(new BoxGeometry(0.8, 1.8, 0.4), new MeshStandardMaterial());
  body.position.y = -0.35;
  character.position.set(1.2, -4, -0.8);
  wrapper.scale.set(0.65, 0.65, 0.65);
  character.add(body);
  wrapper.add(character);
  wrapper.updateMatrixWorld(true);

  alignMixamoCharacterToGround(character);
  wrapper.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(wrapper, true);
  const metrics = measureMixamoCharacter(character);

  expect(bounds.min.y).toBeCloseTo(0, 5);
  expect(character.position.x).toBeCloseTo(1.2);
  expect(character.position.z).toBeCloseTo(-0.8);
  expect(metrics?.bounds.min[1]).toBeCloseTo(0, 5);
  expect(metrics?.visualCenter[1]).toBeCloseTo(0.9, 5);
  expect(metrics?.labelAnchorY).toBeGreaterThan(metrics?.bounds.max[1] ?? Number.POSITIVE_INFINITY);
});

localAssetIt("decodes the packaged Meshopt GLB and exposes its canonical Mixamo skeleton", async () => {
  const gltf = await loadPackagedMixamoCharacter("mannequin.glb");
  const bones = resolveMixamoBones(gltf.scene);
  let skinnedMeshCount = 0;

  gltf.scene.traverse((object) => {
    if ("isSkinnedMesh" in object && object.isSkinnedMesh === true) skinnedMeshCount += 1;
  });

  expect(skinnedMeshCount).toBeGreaterThan(0);
  expect(bones.body?.name).toBe("Hips");
  expect(bones.torso?.name).toBe("Spine2");
  expect(bones.head?.name).toBe("Head");
  expect(bones.leftFoot?.name).toBe("LeftFoot");
  expect(gltf.animations).toHaveLength(0);

  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  applyMixamoRestPoseAndRig(character, { controls: {}, restPose });
  alignMixamoCharacterToGround(character);
  const metrics = measureMixamoCharacter(character);

  expect(metrics?.bounds.min[1]).toBeCloseTo(0, 4);
  expect(metrics?.height).toBeGreaterThan(1.5);
  expect(metrics?.height).toBeLessThan(2.3);
  expect(metrics?.visualCenter[1]).toBeGreaterThan(0.75);
});

localAssetIt(
  "layers pose controls over an animated X Bot without double-lowering its arms or erasing root height",
  async () => {
    const [characterGltf, motionGltf] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      loadPackagedMixamoMotion("jump.glb"),
    ]);
    const character = cloneMixamoCharacterScene(characterGltf.scene);
    const restPose = captureMixamoRestPose(character);
    const clip = retargetMixamoAnimationClip({
      clip: motionGltf.animations[0]!,
      sourceRoot: motionGltf.scene,
      targetRoot: character,
      targetRestPose: restPose,
      rootMotion: "in-place",
    });
    const hipsTrack = clip.tracks.find((track) => track.name === "Hips.position")!;
    const mixer = new AnimationMixer(character);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const bones = resolveMixamoBones(character);
    restoreMixamoRestPose(character, restPose);
    character.updateMatrixWorld(true);
    const restHipsY = character.worldToLocal(bones.body!.getWorldPosition(new Vector3())).y;
    let sampleTime = hipsTrack.times[0]!;
    let greatestVerticalDelta = 0;
    hipsTrack.times.forEach((time) => {
      restoreMixamoRestPose(character, restPose);
      action.time = time;
      mixer.update(0);
      character.updateMatrixWorld(true);
      const hipsY = character.worldToLocal(bones.body!.getWorldPosition(new Vector3())).y;
      const verticalDelta = Math.abs(hipsY - restHipsY);
      if (verticalDelta <= greatestVerticalDelta) return;
      greatestVerticalDelta = verticalDelta;
      sampleTime = time;
    });

    restoreMixamoRestPose(character, restPose);
    action.time = sampleTime;
    mixer.update(0);
    character.updateMatrixWorld(true);
    const animatedHipsY = character.worldToLocal(bones.body!.getWorldPosition(new Vector3())).y;
    const animatedLeftArm = bones.leftShoulder!.quaternion.clone().normalize();
    expect(Math.abs(animatedHipsY - restHipsY)).toBeGreaterThan(0.001);

    applyMixamoRigLayers(character, {
      controls: {},
      restPose,
      animated: true,
    });

    character.updateMatrixWorld(true);
    expect(character.worldToLocal(bones.body!.getWorldPosition(new Vector3())).y).toBeCloseTo(animatedHipsY, 6);
    expect(bones.leftShoulder!.quaternion.clone().normalize().angleTo(animatedLeftArm)).toBeLessThan(0.000001);
  },
);

localAssetIt.each(["walk.glb", "run.glb"])(
  "retargets real %s onto X Bot as Y-up in-place motion without planar root drift",
  async (motionFileName) => {
    const [characterGltf, motionGltf] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      loadPackagedMixamoMotion(motionFileName),
    ]);
    const character = cloneMixamoCharacterScene(characterGltf.scene);
    const restPose = captureMixamoRestPose(character);
    const clip = retargetMixamoAnimationClip({
      clip: motionGltf.animations[0]!,
      sourceRoot: motionGltf.scene,
      targetRoot: character,
      targetRestPose: restPose,
      rootMotion: "in-place",
    });
    const hipsTrack = clip.tracks.find((track) => track.name === "Hips.position")!;
    const mixer = new AnimationMixer(character);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const hips = resolveMixamoBones(character).body!;
    const grounding = createMixamoFootGroundingState(character);

    restoreMixamoRestPose(character, restPose);
    character.updateMatrixWorld(true);
    const restHips = character.worldToLocal(hips.getWorldPosition(new Vector3()));
    const groundedBoundsMinY: number[] = [];
    const samples = Array.from(hipsTrack.times, (time) => {
      restoreMixamoRestPose(character, restPose);
      action.time = time;
      mixer.update(0);
      applyMixamoFootGrounding(character, grounding, true);
      character.updateMatrixWorld(true);
      groundedBoundsMinY.push(new Box3().setFromObject(character, true).min.y);
      return character.worldToLocal(hips.getWorldPosition(new Vector3()));
    });
    const planarDrift = Math.max(
      ...samples.map((position) => Math.hypot(position.x - restHips.x, position.z - restHips.z)),
    );
    const verticalValues = samples.map((position) => position.y);
    const verticalRange = Math.max(...verticalValues) - Math.min(...verticalValues);
    const loopPlanarSeam = Math.hypot(samples[0]!.x - samples.at(-1)!.x, samples[0]!.z - samples.at(-1)!.z);

    expect(planarDrift).toBeLessThan(0.0001);
    expect(verticalRange).toBeGreaterThan(0.01);
    expect(Math.abs(samples[0]!.y - restHips.y)).toBeGreaterThan(0.01);
    expect(loopPlanarSeam).toBeLessThan(0.0001);
    expect(Math.min(...groundedBoundsMinY)).toBeGreaterThan(-0.005);
    expect(Math.max(...groundedBoundsMinY)).toBeLessThan(0.06);
  },
);

localAssetIt(
  "retargets all packaged Mixamo motions onto X Bot with zero-based keys and catalog-exact durations",
  async () => {
    const [characterGltf, ...motionGltfs] = await Promise.all([
      loadPackagedMixamoCharacter("x-bot.glb"),
      ...DIRECTOR_CHARACTER_MOTION_CATALOG.map((item) => loadPackagedMixamoMotion(item.fileName)),
    ]);

    for (const [index, item] of DIRECTOR_CHARACTER_MOTION_CATALOG.entries()) {
      const character = cloneMixamoCharacterScene(characterGltf.scene);
      const restPose = captureMixamoRestPose(character);
      const source = motionGltfs[index]!;
      const clip = retargetMixamoAnimationClip({
        clip: source.animations[0]!,
        sourceRoot: source.scene,
        targetRoot: character,
        targetRestPose: restPose,
        rootMotion: item.recommendedRootMotion,
        name: item.id,
      });

      expect(clip.tracks.length, item.id).toBeGreaterThan(40);
      expect(Math.min(...clip.tracks.map((track) => track.times[0] ?? Number.POSITIVE_INFINITY)), item.id).toBe(0);
      expect(clip.duration, item.id).toBeCloseTo(item.durationS, 5);

      const mixer = new AnimationMixer(character);
      const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
      restoreMixamoRestPose(character, restPose);
      action.time = clip.duration;
      mixer.update(0);
      const resolved = resolveMixamoBones(character);
      expect(resolved.body?.quaternion.toArray().every(Number.isFinite), item.id).toBe(true);
      expect(resolved.leftHand?.quaternion.toArray().every(Number.isFinite), item.id).toBe(true);
      expect(resolved.rightFoot?.quaternion.toArray().every(Number.isFinite), item.id).toBe(true);
    }
  },
);
