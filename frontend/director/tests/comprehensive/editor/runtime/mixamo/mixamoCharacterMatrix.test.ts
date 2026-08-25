import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimationMixer, Box3, Vector3, type AnimationClip, type Bone, type Object3D } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { localAssetIt } from "../../../../../../../packages/protocol/tests/localAssetTest";
import { configureDirectorGLTFLoader } from "../../../../../src/comprehensive/editor/runtime/gltfLoader";
import type { DirectorCharacterIkState } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  alignMixamoCharacterToGround,
  applyMixamoRestPoseAndRig,
  canonicalizeMixamoBoneName,
  captureMixamoRestPose,
  cloneMixamoCharacterScene,
  collectMixamoBones,
  DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M,
  measureMixamoCharacter,
  resolveMixamoBones,
  restoreMixamoRestPose,
  scaleMixamoCharacterToTargetHeight,
  type MixamoBoneRole,
  type MixamoResolvedBones,
  type MixamoRestPose,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import { configureDirectorCharacterMotionAction, retargetMixamoAnimationClip } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion";
import { applyMixamoFootGrounding, createMixamoFootGroundingState } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootGrounding";

/**
 * Cross-character smoke matrix. All runtime calibration (grounding clearance,
 * IK mirroring, retarget scaling) was tuned on the 1.78 m X Bot; this file
 * runs the same public pipeline over a body-type spread of packaged Mixamo
 * characters and asserts per-character invariants instead of X Bot constants.
 */
const MATRIX_CHARACTER_FILES = [
  "x-bot.glb",
  "y-bot.glb",
  "mannequin.glb",
  "amy.glb",
  "kachujin-g-rosales.glb",
  "big-vegas.glb",
  "mousey.glb",
  "mutant.glb",
] as const;

type MatrixCharacterFile = (typeof MATRIX_CHARACTER_FILES)[number];

const RETARGET_CLIP_FILES = ["walk.glb", "idle.glb"] as const;

const CORE_BONE_ROLES = [
  "body",
  "torso",
  "head",
  "leftShoulder",
  "leftElbow",
  "leftHand",
  "rightShoulder",
  "rightElbow",
  "rightHand",
  "leftHip",
  "leftKnee",
  "leftFoot",
  "rightHip",
  "rightKnee",
  "rightFoot",
] as const satisfies readonly MixamoBoneRole[];

/** Normalized characters must stay near the Director hero height. */
const NORMALIZED_HEIGHT_RANGE_M = [1.3, 2.4] as const;
const NORMALIZED_GROUND_TOLERANCE_M = 0.01;
/** X Bot measures < 0.0001; the matrix allows margin for other skeletons. */
const MAX_INPLACE_HIP_PLANAR_DRIFT = 0.01;
/**
 * Foot-grounding envelope for the whole-body Box3 min.y while walking.
 * Wider than the X Bot envelope (-0.005..0.06) because sole thickness and
 * mesh-below-toe-bone offsets vary a lot across body types.
 */
const GROUNDED_BOUNDS_MIN_Y_RANGE_M = [-0.05, 0.12] as const;
/** Reached IK goals may miss by solver/aim tolerance, never by a mirrored limb. */
const MAX_IK_SINGLE_SIDE_ERROR_M = 0.1;
const MAX_IK_LEFT_RIGHT_ERROR_GAP_M = 0.02;

type MatrixInvariant = "boneResolution" | "normalization" | "retargetDrift" | "groundingEnvelope" | "ikSymmetry";

interface MatrixKnownIssue {
  character: MatrixCharacterFile;
  invariant: MatrixInvariant;
  /** Restrict the waiver to one clip; undefined waives the invariant for all clips. */
  clip?: (typeof RETARGET_CLIP_FILES)[number];
  /** Measured value plus why this is a real per-character finding, not a threshold problem. */
  reason: string;
}

/**
 * Discovery ledger: entries here are real, reproducible per-character failures
 * of an invariant that holds for the rest of the matrix. Each entry keeps the
 * pipeline exercised (no crash regressions) while waiving only the failing
 * assertion, so a future runtime fix can delete the entry and go green.
 */
const KNOWN_ISSUES: readonly MatrixKnownIssue[] = [];

function findKnownIssue(
  character: MatrixCharacterFile,
  invariant: MatrixInvariant,
  clip?: (typeof RETARGET_CLIP_FILES)[number],
) {
  return KNOWN_ISSUES.find(
    (issue) =>
      issue.character === character &&
      issue.invariant === invariant &&
      (issue.clip === undefined || issue.clip === clip),
  );
}

/** Waive a failing assertion only for ledger entries; everything else must assert. */
function expectUnlessKnownIssue(issue: MatrixKnownIssue | undefined, label: string, assert: () => void) {
  if (issue) {
    console.info(`[mixamo-matrix] waived known issue: ${label}: ${issue.reason}`);
    return;
  }
  assert();
}

const CHARACTER_MODEL_DIRECTORY = "assets/library/mixamo-characters/models";
const MOTION_CLIP_DIRECTORY = "assets/library/mixamo-animations/clips";

/** Parse each packaged GLB once; every test works on isolated skeleton clones. */
const packagedGltfCache = new Map<string, Promise<GLTF>>();

function loadPackagedGltf(directory: string, fileName: string) {
  const cacheKey = `${directory}/${fileName}`;
  const cached = packagedGltfCache.get(cacheKey);
  if (cached) return cached;

  const binary = readFileSync(resolve(process.cwd(), directory, fileName));
  const data = new ArrayBuffer(binary.byteLength);
  new Uint8Array(data).set(binary);
  // Packaged GLBs embed textures and jsdom lacks createImageBitmap.
  vi.stubGlobal("createImageBitmap", async () => ({ close: vi.fn() }));
  const gltf = configureDirectorGLTFLoader(new GLTFLoader()).parseAsync(data, "");
  packagedGltfCache.set(cacheKey, gltf);
  return gltf;
}

const loadPackagedMixamoCharacter = (fileName: string) => loadPackagedGltf(CHARACTER_MODEL_DIRECTORY, fileName);
const loadPackagedMixamoMotion = (fileName: string) => loadPackagedGltf(MOTION_CLIP_DIRECTORY, fileName);

interface MatrixCharacterInstance {
  character: Object3D;
  restPose: MixamoRestPose;
  deformBones: Bone[];
  bones: MixamoResolvedBones;
}

function instantiateMatrixCharacter(gltf: GLTF): MatrixCharacterInstance {
  const character = cloneMixamoCharacterScene(gltf.scene);
  const restPose = captureMixamoRestPose(character);
  const deformBones = collectMixamoBones(character);
  const bones = resolveMixamoBones(character, deformBones);
  return { character, restPose, deformBones, bones };
}

/** Production load order: neutral pose, metre-height rescale, ground alignment. */
function normalizeMatrixCharacter(character: Object3D, restPose: MixamoRestPose) {
  applyMixamoRestPoseAndRig(character, { controls: {}, restPose });
  scaleMixamoCharacterToTargetHeight(character, DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M);
  alignMixamoCharacterToGround(character);
  return measureMixamoCharacter(character);
}

async function retargetPackagedMotion(
  character: Object3D,
  restPose: MixamoRestPose,
  motionFileName: (typeof RETARGET_CLIP_FILES)[number],
) {
  const motionGltf = await loadPackagedMixamoMotion(motionFileName);
  return retargetMixamoAnimationClip({
    clip: motionGltf.animations[0]!,
    sourceRoot: motionGltf.scene,
    targetRoot: character,
    targetRestPose: restPose,
    rootMotion: "in-place",
  });
}

function findHipsPositionTrack(clip: AnimationClip) {
  const hipsName = canonicalizeMixamoBoneName("Hips");
  return clip.tracks.find((track) => {
    const separator = track.name.lastIndexOf(".");
    if (separator <= 0) return undefined;
    return (
      track.name.slice(separator + 1) === "position" &&
      canonicalizeMixamoBoneName(track.name.slice(0, separator)) === hipsName
    );
  });
}

/** Every retargeted keyframe; falls back to the densest track for hips-less rigs. */
function getClipSampleTimes(clip: AnimationClip) {
  const track =
    findHipsPositionTrack(clip) ??
    clip.tracks.reduce((densest, candidate) => (candidate.times.length > densest.times.length ? candidate : densest));
  return Array.from(track.times);
}

interface MatrixIkChainMeasurement {
  /** Anatomical lateral sign of the chain root in Director/world x. */
  side: number;
  /** Upper plus lower segment length in world metres. */
  reach: number;
  root: Vector3;
  end: Vector3;
}

function measureMatrixIkChain(character: Object3D, upper: Bone, middle: Bone, end: Bone): MatrixIkChainMeasurement {
  character.updateMatrixWorld(true);
  const root = upper.getWorldPosition(new Vector3());
  const middlePosition = middle.getWorldPosition(new Vector3());
  const endPosition = end.getWorldPosition(new Vector3());
  return {
    side: Math.sign(root.x) || 1,
    reach: root.distanceTo(middlePosition) + middlePosition.distanceTo(endPosition),
    root,
    end: endPosition,
  };
}

localAssetIt.each([...MATRIX_CHARACTER_FILES])(
  "resolves every core semantic bone on %s",
  async (fileName) => {
    const gltf = await loadPackagedMixamoCharacter(fileName);
    const bones = resolveMixamoBones(gltf.scene);
    const missing = CORE_BONE_ROLES.filter((role) => !bones[role]);
    console.info(`[mixamo-matrix] ${fileName} boneResolution missing=[${missing.join(", ")}]`);

    expectUnlessKnownIssue(findKnownIssue(fileName, "boneResolution"), `${fileName} bone resolution`, () => {
      expect(missing).toEqual([]);
    });
  },
  60_000,
);

localAssetIt.each([...MATRIX_CHARACTER_FILES])(
  "normalizes %s to Director metre scale on the ground plane",
  async (fileName) => {
    const gltf = await loadPackagedMixamoCharacter(fileName);
    const { character, restPose } = instantiateMatrixCharacter(gltf);
    const metrics = normalizeMatrixCharacter(character, restPose);

    expect(metrics).not.toBeNull();
    const height = metrics!.height;
    const groundMinY = metrics!.bounds.min[1];
    console.info(`[mixamo-matrix] ${fileName} normalization height=${height.toFixed(4)} minY=${groundMinY.toFixed(5)}`);

    expectUnlessKnownIssue(findKnownIssue(fileName, "normalization"), `${fileName} normalization`, () => {
      expect(height).toBeGreaterThanOrEqual(NORMALIZED_HEIGHT_RANGE_M[0]);
      expect(height).toBeLessThanOrEqual(NORMALIZED_HEIGHT_RANGE_M[1]);
      expect(Math.abs(groundMinY)).toBeLessThanOrEqual(NORMALIZED_GROUND_TOLERANCE_M);
    });
  },
  90_000,
);

localAssetIt.each(MATRIX_CHARACTER_FILES.flatMap((character) => RETARGET_CLIP_FILES.map((clip) => [character, clip] as const)))(
  "retargets %s x %s in place with finite bones and no planar hip drift",
  async (fileName, clipFileName) => {
    const gltf = await loadPackagedMixamoCharacter(fileName);
    const { character, restPose, deformBones, bones } = instantiateMatrixCharacter(gltf);
    expect(bones.body).toBeDefined();

    const clip = await retargetPackagedMotion(character, restPose, clipFileName);
    // A raw track-count floor is skeleton-dependent (Mutant has no finger
    // bones and retargets to 38 tracks where X Bot gets 66). The portable
    // invariant is full coverage of the core semantic skeleton.
    CORE_BONE_ROLES.forEach((role) => {
      const bone = bones[role];
      expect(bone, `${fileName} ${role}`).toBeDefined();
      expect(
        clip.tracks.some((track) => track.name === `${bone!.name}.quaternion`),
        `${fileName} ${clipFileName} missing ${role} rotation track`,
      ).toBe(true);
    });
    expect(findHipsPositionTrack(clip), `${fileName} ${clipFileName} hips position track`).toBeDefined();

    const mixer = new AnimationMixer(character);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const times = getClipSampleTimes(clip);
    expect(times.length).toBeGreaterThan(1);

    restoreMixamoRestPose(character, restPose, { bones: deformBones });
    const hips = bones.body!;
    const restHips = character.worldToLocal(hips.getWorldPosition(new Vector3()));
    const sampledHips = new Vector3();
    let maxPlanarDrift = 0;
    let nonFiniteBoneSamples = 0;

    times.forEach((time) => {
      restoreMixamoRestPose(character, restPose, { bones: deformBones, updateMatrixWorld: false });
      action.time = time;
      mixer.update(0);
      character.updateMatrixWorld(true);
      deformBones.forEach((bone) => {
        if (!bone.quaternion.toArray().every(Number.isFinite)) nonFiniteBoneSamples += 1;
      });
      character.worldToLocal(hips.getWorldPosition(sampledHips));
      maxPlanarDrift = Math.max(maxPlanarDrift, Math.hypot(sampledHips.x - restHips.x, sampledHips.z - restHips.z));
    });

    console.info(
      `[mixamo-matrix] ${fileName} retarget ${clipFileName} tracks=${clip.tracks.length} keys=${times.length} planarDrift=${maxPlanarDrift.toFixed(6)} nonFinite=${nonFiniteBoneSamples}`,
    );

    // A non-finite bone sample is a hard corruption; it is never waivable.
    expect(nonFiniteBoneSamples).toBe(0);
    expectUnlessKnownIssue(
      findKnownIssue(fileName, "retargetDrift", clipFileName),
      `${fileName} ${clipFileName} planar drift`,
      () => {
        expect(maxPlanarDrift).toBeLessThan(MAX_INPLACE_HIP_PLANAR_DRIFT);
      },
    );
  },
  120_000,
);

localAssetIt.each([...MATRIX_CHARACTER_FILES])(
  "keeps %s inside the walk foot-grounding envelope",
  async (fileName) => {
    const gltf = await loadPackagedMixamoCharacter(fileName);
    const { character, restPose, deformBones } = instantiateMatrixCharacter(gltf);
    const clip = await retargetPackagedMotion(character, restPose, "walk.glb");
    normalizeMatrixCharacter(character, restPose);

    const grounding = createMixamoFootGroundingState(character);
    expect(grounding).not.toBeNull();

    const mixer = new AnimationMixer(character);
    const action = configureDirectorCharacterMotionAction(mixer.clipAction(clip));
    const times = getClipSampleTimes(clip);
    let lowestBoundsMinY = Number.POSITIVE_INFINITY;
    let highestBoundsMinY = Number.NEGATIVE_INFINITY;

    times.forEach((time) => {
      restoreMixamoRestPose(character, restPose, { bones: deformBones, updateMatrixWorld: false });
      action.time = time;
      mixer.update(0);
      applyMixamoFootGrounding(character, grounding, true);
      character.updateMatrixWorld(true);
      const boundsMinY = new Box3().setFromObject(character, true).min.y;
      lowestBoundsMinY = Math.min(lowestBoundsMinY, boundsMinY);
      highestBoundsMinY = Math.max(highestBoundsMinY, boundsMinY);
    });

    console.info(
      `[mixamo-matrix] ${fileName} grounding walk minY=[${lowestBoundsMinY.toFixed(4)}, ${highestBoundsMinY.toFixed(4)}]`,
    );

    expectUnlessKnownIssue(
      findKnownIssue(fileName, "groundingEnvelope", "walk.glb"),
      `${fileName} walk grounding envelope`,
      () => {
        expect(lowestBoundsMinY).toBeGreaterThanOrEqual(GROUNDED_BOUNDS_MIN_Y_RANGE_M[0]);
        expect(highestBoundsMinY).toBeLessThanOrEqual(GROUNDED_BOUNDS_MIN_Y_RANGE_M[1]);
      },
    );
  },
  180_000,
);

localAssetIt.each([...MATRIX_CHARACTER_FILES])(
  "solves mirror-symmetric IK goals on all four %s limb chains",
  async (fileName) => {
    const gltf = await loadPackagedMixamoCharacter(fileName);
    const { character, restPose, bones } = instantiateMatrixCharacter(gltf);
    const chainRoles: readonly MixamoBoneRole[] = [
      "leftShoulder",
      "leftElbow",
      "leftHand",
      "rightShoulder",
      "rightElbow",
      "rightHand",
      "leftHip",
      "leftKnee",
      "leftFoot",
      "rightHip",
      "rightKnee",
      "rightFoot",
    ];
    chainRoles.forEach((role) => expect(bones[role], `${fileName} ${role}`).toBeDefined());
    normalizeMatrixCharacter(character, restPose);

    const leftArm = measureMatrixIkChain(character, bones.leftShoulder!, bones.leftElbow!, bones.leftHand!);
    const rightArm = measureMatrixIkChain(character, bones.rightShoulder!, bones.rightElbow!, bones.rightHand!);
    const leftLeg = measureMatrixIkChain(character, bones.leftHip!, bones.leftKnee!, bones.leftFoot!);
    const rightLeg = measureMatrixIkChain(character, bones.rightHip!, bones.rightKnee!, bones.rightFoot!);
    expect(leftArm.side * rightArm.side, `${fileName} arm chain roots must sit on opposite sides`).toBe(-1);
    expect(leftLeg.side * rightLeg.side, `${fileName} leg chain roots must sit on opposite sides`).toBe(-1);

    // Reachable mirror-symmetric goals derived from the measured rest chains.
    const armReach = Math.min(leftArm.reach, rightArm.reach);
    const shoulderLateral = (Math.abs(leftArm.root.x) + Math.abs(rightArm.root.x)) / 2;
    const shoulderHeight = (leftArm.root.y + rightArm.root.y) / 2;
    const handTarget = new Vector3(shoulderLateral + 0.45 * armReach, shoulderHeight - 0.2 * armReach, 0.35 * armReach);
    const handPole = new Vector3(shoulderLateral + 0.3 * armReach, shoulderHeight - 0.1 * armReach, 0.7 * armReach);

    const legReach = Math.min(leftLeg.reach, rightLeg.reach);
    const hipLateral = (Math.abs(leftLeg.root.x) + Math.abs(rightLeg.root.x)) / 2;
    const hipHeight = (leftLeg.root.y + rightLeg.root.y) / 2;
    const footRestHeight = (leftLeg.end.y + rightLeg.end.y) / 2;
    const footTarget = new Vector3(hipLateral + 0.25 * legReach, footRestHeight + 0.2 * legReach, 0.3 * legReach);
    const footPole = new Vector3(hipLateral + 0.25 * legReach, hipHeight, legReach);

    expect(new Vector3(leftArm.side * handTarget.x, handTarget.y, handTarget.z).distanceTo(leftArm.root)).toBeLessThan(
      leftArm.reach * 0.98,
    );
    expect(new Vector3(leftLeg.side * footTarget.x, footTarget.y, footTarget.z).distanceTo(leftLeg.root)).toBeLessThan(
      leftLeg.reach * 0.98,
    );

    // Director semantics: the actor's left is -X; the runtime mirrors onto the
    // asset's authored handedness (Mixamo usually keeps the left limbs at +X).
    const ik: DirectorCharacterIkState = {
      leftHand: {
        target: [-handTarget.x, handTarget.y, handTarget.z],
        pole: [-handPole.x, handPole.y, handPole.z],
        weight: 1,
        reachClamp: 1,
      },
      rightHand: {
        target: [handTarget.x, handTarget.y, handTarget.z],
        pole: [handPole.x, handPole.y, handPole.z],
        weight: 1,
        reachClamp: 1,
      },
      leftFoot: {
        target: [-footTarget.x, footTarget.y, footTarget.z],
        pole: [-footPole.x, footPole.y, footPole.z],
        weight: 1,
        reachClamp: 1,
      },
      rightFoot: {
        target: [footTarget.x, footTarget.y, footTarget.z],
        pole: [footPole.x, footPole.y, footPole.z],
        weight: 1,
        reachClamp: 1,
      },
    };

    applyMixamoRestPoseAndRig(character, { controls: {}, ik, restPose });
    character.updateMatrixWorld(true);

    // Correctly mirrored chains land on their own anatomical side of the body.
    const errorTo = (bone: Bone, side: number, target: Vector3) =>
      bone.getWorldPosition(new Vector3()).distanceTo(new Vector3(side * target.x, target.y, target.z));
    const leftHandError = errorTo(bones.leftHand!, leftArm.side, handTarget);
    const rightHandError = errorTo(bones.rightHand!, rightArm.side, handTarget);
    const leftFootError = errorTo(bones.leftFoot!, leftLeg.side, footTarget);
    const rightFootError = errorTo(bones.rightFoot!, rightLeg.side, footTarget);
    const handErrorGap = Math.abs(leftHandError - rightHandError);
    const footErrorGap = Math.abs(leftFootError - rightFootError);

    console.info(
      `[mixamo-matrix] ${fileName} ik hand=[${leftHandError.toFixed(6)}, ${rightHandError.toFixed(6)}] gap=${handErrorGap.toFixed(6)} foot=[${leftFootError.toFixed(6)}, ${rightFootError.toFixed(6)}] gap=${footErrorGap.toFixed(6)}`,
    );

    expectUnlessKnownIssue(findKnownIssue(fileName, "ikSymmetry"), `${fileName} IK symmetry`, () => {
      expect(leftHandError).toBeLessThan(MAX_IK_SINGLE_SIDE_ERROR_M);
      expect(rightHandError).toBeLessThan(MAX_IK_SINGLE_SIDE_ERROR_M);
      expect(leftFootError).toBeLessThan(MAX_IK_SINGLE_SIDE_ERROR_M);
      expect(rightFootError).toBeLessThan(MAX_IK_SINGLE_SIDE_ERROR_M);
      expect(handErrorGap).toBeLessThan(MAX_IK_LEFT_RIGHT_ERROR_GAP_M);
      expect(footErrorGap).toBeLessThan(MAX_IK_LEFT_RIGHT_ERROR_GAP_M);
    });
  },
  90_000,
);
