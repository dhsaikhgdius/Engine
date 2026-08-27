/**
 * Skeleton services for Mixamo-rigged characters: bone discovery through
 * canonical humanoid names, rest-pose capture/restore, skeleton-safe scene
 * cloning, character metrics (height normalization against the authored
 * default), and the layered rig application that stacks pose-control bone
 * rotations and two-bone IK effectors on top of sampled animation. IK
 * runtimes are cached per character root so per-frame solves allocate
 * nothing.
 */
import {
  Bone,
  Euler,
  Mesh,
  Quaternion,
  Vector3,
  type Box3,
  type Material,
  type Object3D,
  type SkinnedMesh,
} from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { VIEWPORT_OBJECT_LABEL_VERTICAL_GAP } from "../../schema/viewportLabels";
import type { DirectorCharacterIkEffector, DirectorCharacterIkState } from "../../schema/directorProject";
import type { CharacterBodyType } from "../mannequin/bodyTypes";
import {
  createTwoBoneIkRuntime,
  solveTwoBoneIkInto,
  type CharacterIkVector,
  type TwoBoneIkInput,
  type TwoBoneIkRuntime,
} from "../mannequin/characterIk";
import { canonicalizeHumanoidBoneName } from "../../loaders/humanoidRig";
import { getMixamoPoseBoneRotations, MIXAMO_BONE_ROLE_ALIASES, type MixamoBoneRole } from "./mixamoPoseAxes";
import { getBoundsInParentLocal } from "../objectBounds";

export {
  getMixamoPoseBoneRotations,
  getMixamoPoseControlsFromBoneRotation,
  MIXAMO_BONE_ROLE_ALIASES,
  MIXAMO_POSE_AXIS_BINDINGS,
  MIXAMO_POSE_BONE_ROLES,
} from "./mixamoPoseAxes";
export type { MixamoBoneRole, MixamoBoneRotationMap } from "./mixamoPoseAxes";

export type MixamoResolvedBones = Partial<Record<MixamoBoneRole, Bone>>;

const MIXAMO_IK_CHAINS: Record<
  DirectorCharacterIkEffector,
  { upper: MixamoBoneRole; lower: MixamoBoneRole; end: MixamoBoneRole }
> = {
  leftHand: { upper: "leftShoulder", lower: "leftElbow", end: "leftHand" },
  rightHand: { upper: "rightShoulder", lower: "rightElbow", end: "rightHand" },
  leftFoot: { upper: "leftHip", lower: "leftKnee", end: "leftFoot" },
  rightFoot: { upper: "rightHip", lower: "rightKnee", end: "rightFoot" },
};
const MIXAMO_IK_CHAIN_ENTRIES = Object.entries(MIXAMO_IK_CHAINS) as Array<
  [DirectorCharacterIkEffector, (typeof MIXAMO_IK_CHAINS)[DirectorCharacterIkEffector]]
>;

interface MixamoAimBoneScratch {
  boneWorldPosition: Vector3;
  childWorldPosition: Vector3;
  targetWorldPosition: Vector3;
  currentDirection: Vector3;
  desiredDirection: Vector3;
  currentWorldQuaternion: Quaternion;
  delta: Quaternion;
  targetWorldQuaternion: Quaternion;
  parentWorldQuaternion: Quaternion;
  targetLocalQuaternion: Quaternion;
}

interface MixamoIkChainRuntime {
  chainRoot: Vector3;
  chainMiddle: Vector3;
  chainEnd: Vector3;
  targetRootLocal: Vector3;
  poleRootLocal: Vector3;
  rootInput: CharacterIkVector;
  targetInput: CharacterIkVector;
  poleInput: CharacterIkVector;
  solverInput: TwoBoneIkInput;
  solver: TwoBoneIkRuntime;
  aim: MixamoAimBoneScratch;
  /** Last decisive lateral side of this chain root; reused near the mid plane. */
  side: number;
}

export interface MixamoCharacterIkRuntime {
  chains: Record<DirectorCharacterIkEffector, MixamoIkChainRuntime>;
  applications: number;
}

export interface MixamoRestBoneTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export type MixamoRestPose = Record<string, MixamoRestBoneTransform>;

export interface MixamoCharacterMetrics {
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
  height: number;
  labelAnchorY: number;
  visualCenter: [number, number, number];
}

/** Default authored hero height in Director's metre-based stage. */
export const DEFAULT_DIRECTOR_CHARACTER_HEIGHT_M = 1.78;

/** Skip rescale when the measured height is already within this relative tolerance. */
export const MIXAMO_CHARACTER_HEIGHT_TOLERANCE = 0.02;

const rotationEulerScratch = new Euler();
const rotationQuaternionScratch = new Quaternion();

function isBone(object: Object3D): object is Bone {
  return "isBone" in object && object.isBone === true;
}

function isSkinnedMesh(object: Object3D): object is SkinnedMesh {
  return "isSkinnedMesh" in object && object.isSkinnedMesh === true;
}

function hasMaterial(object: Object3D): object is Mesh {
  return "isMesh" in object && object.isMesh === true;
}

/**
 * Mixamo exports use several namespace spellings depending on the downloader,
 * Blender version and whether FBX namespaces were retained. The runtime only
 * compares this canonical token; it never rewrites authored node names.
 */
export const canonicalizeMixamoBoneName = canonicalizeHumanoidBoneName;

export function collectMixamoBones(root: Object3D) {
  const bones: Bone[] = [];
  root.traverse((object) => {
    if (isBone(object)) bones.push(object);
  });
  return bones;
}

function indexMixamoBones(root: Object3D, deformBones?: readonly Bone[]) {
  const index = new Map<string, Bone>();

  const bones = deformBones ?? collectMixamoBones(root);
  bones.forEach((object) => {
    const canonicalName = canonicalizeMixamoBoneName(object.name);
    if (canonicalName && !index.has(canonicalName)) index.set(canonicalName, object);
  });

  return index;
}

export function resolveMixamoBones(root: Object3D, deformBones?: readonly Bone[]): MixamoResolvedBones {
  const index = indexMixamoBones(root, deformBones);
  const resolved: MixamoResolvedBones = {};

  (
    Object.entries(MIXAMO_BONE_ROLE_ALIASES) as Array<
      [MixamoBoneRole, (typeof MIXAMO_BONE_ROLE_ALIASES)[MixamoBoneRole]]
    >
  ).forEach(([role, aliases]) => {
    const bone = aliases.map((alias) => index.get(canonicalizeMixamoBoneName(alias))).find(Boolean);
    if (bone) resolved[role] = bone;
  });

  return resolved;
}

function cloneMaterial(material: Material | Material[]) {
  return Array.isArray(material) ? material.map((item) => item.clone()) : material.clone();
}

/**
 * SkeletonUtils is required here: Object3D.clone(true) leaves SkinnedMesh
 * skeletons pointing at the source hierarchy. Geometry and textures remain
 * shared, while materials are isolated so per-character edits cannot leak.
 */
export function cloneMixamoCharacterScene<T extends Object3D>(source: T): T {
  const clone = cloneSkeleton(source) as T;

  clone.traverse((object) => {
    if (hasMaterial(object)) {
      object.material = cloneMaterial(object.material);
      object.castShadow = true;
      object.receiveShadow = true;
    }
    if (isSkinnedMesh(object)) object.frustumCulled = false;
  });

  return clone;
}

/** Dispose only per-instance materials; geometry and textures belong to the loader cache. */
export function disposeMixamoCharacterInstanceMaterials(root: Object3D) {
  root.traverse((object) => {
    if (!hasMaterial(object)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => material.dispose());
  });
}

export function captureMixamoRestPose(root: Object3D): MixamoRestPose {
  return captureMixamoRestPoseAndBones(root).restPose;
}

/** Single hierarchy walk for rest-pose capture and deform-bone indexing. */
export function captureMixamoRestPoseAndBones(root: Object3D): { restPose: MixamoRestPose; bones: Bone[] } {
  const restPose: MixamoRestPose = {};
  const bones: Bone[] = [];

  root.traverse((object) => {
    if (!isBone(object)) return;
    bones.push(object);
    restPose[object.uuid] = {
      position: [object.position.x, object.position.y, object.position.z],
      quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
      scale: [object.scale.x, object.scale.y, object.scale.z],
    };
  });

  return { restPose, bones };
}

function applyRotationOffset(object: Object3D, rotation: [number, number, number]) {
  if (rotation[0] === 0 && rotation[1] === 0 && rotation[2] === 0) return;
  rotationEulerScratch.set(rotation[0], rotation[1], rotation[2]);
  rotationQuaternionScratch.setFromEuler(rotationEulerScratch);
  object.quaternion.multiply(rotationQuaternionScratch);
}

function writeVectorTuple(target: CharacterIkVector, vector: Vector3) {
  target[0] = vector.x;
  target[1] = vector.y;
  target[2] = vector.z;
}

function getRootLocalPositionInto(root: Object3D, object: Object3D, target: Vector3) {
  object.getWorldPosition(target);
  return root.worldToLocal(target);
}

/**
 * Director stores IK goals in the owning character object's metre-based local
 * space. The cloned Mixamo scene may itself be translated for grounding and
 * uniformly scaled from centimetres, so those points must be transformed into
 * the asset root's authored coordinate system before solving the bone chain.
 */
function directorLocalPointToRootLocalInto(root: Object3D, point: CharacterIkVector, mirrorX: number, result: Vector3) {
  root.updateWorldMatrix(true, false);
  result.set(point[0] * mirrorX, point[1], point[2]);
  if (root.parent) root.parent.localToWorld(result);
  return root.worldToLocal(result);
}

function getDirectorIkMirrorX(effector: DirectorCharacterIkEffector, skeletonSide: number) {
  // Director's procedural rig uses negative X for the actor's left side and
  // positive X for its right. Standard Mixamo exports use the opposite local
  // X handedness.
  const directorSide = effector === "leftHand" || effector === "leftFoot" ? -1 : 1;
  return skeletonSide !== 0 && skeletonSide !== directorSide ? -1 : 1;
}

/**
 * Lateral side encoded by a bone's authored local offset, or 0 when that
 * offset is not decisive. Mixamo leg chains store a strong lateral offset on
 * the thigh, but both upper-arm bones sit at local x ≈ 0 under their mirrored
 * shoulders, so a raw `Math.sign(position.x)` there is namespace-export noise
 * that used to pull right-arm IK targets across the body.
 */
export function getMixamoAuthoredBoneSide(bone: Object3D) {
  const offsetLength = bone.position.length();
  if (offsetLength < 1e-8) return 0;
  return Math.abs(bone.position.x) >= offsetLength * 0.25 ? Math.sign(bone.position.x) : 0;
}

/**
 * Resolve which lateral side a chain root sits on. The authored local offset
 * wins when decisive (stable under crossed-limb poses); otherwise the posed
 * root-local position decides, with the previous decisive side reused while
 * the joint hovers near the mid plane so the mirror cannot flicker.
 */
function resolveMixamoChainSide(upper: Bone, chainRootX: number, chainLength: number, previousSide: number) {
  const authoredSide = getMixamoAuthoredBoneSide(upper);
  if (authoredSide !== 0) return authoredSide;
  if (Math.abs(chainRootX) >= chainLength * 0.02) return Math.sign(chainRootX);
  return previousSide || Math.sign(chainRootX);
}

/** Convert a Director-local metre offset into the local axes/units of a bone's parent. */
function directorLocalOffsetToObjectParentLocal(root: Object3D, object: Object3D, offset: CharacterIkVector) {
  root.updateWorldMatrix(true, false);
  const origin = new Vector3();
  const endpoint = new Vector3(...offset);
  if (root.parent) {
    root.parent.localToWorld(origin);
    root.parent.localToWorld(endpoint);
  }
  const objectParent = object.parent;
  if (objectParent) {
    objectParent.worldToLocal(origin);
    objectParent.worldToLocal(endpoint);
  }
  return endpoint.sub(origin);
}

/**
 * Rotate one deform bone towards a root-local point while preserving the
 * authored rest/pose twist. The result is converted back into the bone's local
 * quaternion so it remains portable across namespaced Mixamo hierarchies.
 */
function aimBoneAtRootLocalPoint(
  root: Object3D,
  bone: Bone,
  child: Bone,
  target: CharacterIkVector,
  weight: number,
  scratch: MixamoAimBoneScratch,
) {
  root.updateMatrixWorld(true);
  const boneWorldPosition = bone.getWorldPosition(scratch.boneWorldPosition);
  const childWorldPosition = child.getWorldPosition(scratch.childWorldPosition);
  const targetWorldPosition = root.localToWorld(scratch.targetWorldPosition.fromArray(target));
  const currentDirection = scratch.currentDirection.subVectors(childWorldPosition, boneWorldPosition).normalize();
  const desiredDirection = scratch.desiredDirection.subVectors(targetWorldPosition, boneWorldPosition).normalize();
  if (!Number.isFinite(currentDirection.lengthSq()) || currentDirection.lengthSq() < 1e-12) return;
  if (!Number.isFinite(desiredDirection.lengthSq()) || desiredDirection.lengthSq() < 1e-12) return;

  const currentWorldQuaternion = bone.getWorldQuaternion(scratch.currentWorldQuaternion);
  const delta = scratch.delta.setFromUnitVectors(currentDirection, desiredDirection);
  const targetWorldQuaternion = scratch.targetWorldQuaternion.copy(delta).multiply(currentWorldQuaternion).normalize();
  const parentWorldQuaternion = scratch.parentWorldQuaternion.identity();
  if (bone.parent) bone.parent.getWorldQuaternion(parentWorldQuaternion);
  const targetLocalQuaternion = scratch.targetLocalQuaternion
    .copy(parentWorldQuaternion)
    .invert()
    .multiply(targetWorldQuaternion)
    .normalize();
  bone.quaternion.slerp(targetLocalQuaternion, Math.min(1, Math.max(0, weight))).normalize();
  root.updateMatrixWorld(true);
}

function createMixamoAimBoneScratch(): MixamoAimBoneScratch {
  return {
    boneWorldPosition: new Vector3(),
    childWorldPosition: new Vector3(),
    targetWorldPosition: new Vector3(),
    currentDirection: new Vector3(),
    desiredDirection: new Vector3(),
    currentWorldQuaternion: new Quaternion(),
    delta: new Quaternion(),
    targetWorldQuaternion: new Quaternion(),
    parentWorldQuaternion: new Quaternion(),
    targetLocalQuaternion: new Quaternion(),
  };
}

function createMixamoIkChainRuntime(): MixamoIkChainRuntime {
  const rootInput: CharacterIkVector = [0, 0, 0];
  const targetInput: CharacterIkVector = [0, 0, 0];
  const poleInput: CharacterIkVector = [0, 0, 0];
  return {
    chainRoot: new Vector3(),
    chainMiddle: new Vector3(),
    chainEnd: new Vector3(),
    targetRootLocal: new Vector3(),
    poleRootLocal: new Vector3(),
    rootInput,
    targetInput,
    poleInput,
    solverInput: {
      root: rootInput,
      target: targetInput,
      pole: poleInput,
      upperLength: 0,
      lowerLength: 0,
      reachClamp: 1,
    },
    solver: createTwoBoneIkRuntime(),
    aim: createMixamoAimBoneScratch(),
    side: 0,
  };
}

export function createMixamoCharacterIkRuntime(): MixamoCharacterIkRuntime {
  return {
    chains: {
      leftHand: createMixamoIkChainRuntime(),
      rightHand: createMixamoIkChainRuntime(),
      leftFoot: createMixamoIkChainRuntime(),
      rightFoot: createMixamoIkChainRuntime(),
    },
    applications: 0,
  };
}

const mixamoCharacterIkRuntimeByRoot = new WeakMap<Object3D, MixamoCharacterIkRuntime>();

/** Per-character scratch ownership avoids both render-loop allocations and cross-character aliasing. */
export function getMixamoCharacterIkRuntime(root: Object3D) {
  const existing = mixamoCharacterIkRuntimeByRoot.get(root);
  if (existing) return existing;
  const runtime = createMixamoCharacterIkRuntime();
  mixamoCharacterIkRuntimeByRoot.set(root, runtime);
  return runtime;
}

/**
 * Handedness factor between Director-local IK goals and this skeleton.
 *
 * Viewport IK dragging reads a world point and must store it the way
 * {@link applyMixamoCharacterIk} will read it back, so the mirror decision has
 * to come from the same chain-side resolution rather than a second guess.
 *
 * @param root - The Mixamo asset root whose skeleton owns the chain.
 * @param bones - Semantic bones resolved from that root.
 * @param effector - The IK chain being edited.
 * @returns 1 when Director-local X already matches the skeleton, -1 otherwise.
 */
export function resolveMixamoIkMirrorX(
  root: Object3D,
  bones: MixamoResolvedBones,
  effector: DirectorCharacterIkEffector,
) {
  const chain = MIXAMO_IK_CHAINS[effector];
  const upper = bones[chain.upper];
  const lower = bones[chain.lower];
  const end = bones[chain.end];
  if (!upper || !lower || !end) return 1;

  root.updateMatrixWorld(true);
  const runtime = getMixamoCharacterIkRuntime(root);
  const chainRuntime = runtime.chains[effector];
  const chainRoot = getRootLocalPositionInto(root, upper, chainRuntime.chainRoot);
  const chainMiddle = getRootLocalPositionInto(root, lower, chainRuntime.chainMiddle);
  const chainEnd = getRootLocalPositionInto(root, end, chainRuntime.chainEnd);
  const chainLength = chainRoot.distanceTo(chainMiddle) + chainMiddle.distanceTo(chainEnd);
  const side = resolveMixamoChainSide(upper, chainRoot.x, chainLength, chainRuntime.side);
  return getDirectorIkMirrorX(effector, side);
}

/** Apply portable hand/foot goals to the real Mixamo deform skeleton. */
export function applyMixamoCharacterIk(
  root: Object3D,
  bones: MixamoResolvedBones,
  ik: DirectorCharacterIkState | undefined,
) {
  if (!ik) return;
  root.updateMatrixWorld(true);
  const runtime = getMixamoCharacterIkRuntime(root);
  runtime.applications += 1;

  for (let chainIndex = 0; chainIndex < MIXAMO_IK_CHAIN_ENTRIES.length; chainIndex += 1) {
    const [effector, chain] = MIXAMO_IK_CHAIN_ENTRIES[chainIndex]!;
    const target = ik[effector];
    const upper = bones[chain.upper];
    const lower = bones[chain.lower];
    const end = bones[chain.end];
    if (!target || !upper || !lower || !end || target.weight <= 0) continue;
    const chainRuntime = runtime.chains[effector];

    root.updateMatrixWorld(true);
    const chainRoot = getRootLocalPositionInto(root, upper, chainRuntime.chainRoot);
    const chainMiddle = getRootLocalPositionInto(root, lower, chainRuntime.chainMiddle);
    const chainEnd = getRootLocalPositionInto(root, end, chainRuntime.chainEnd);
    const upperLength = chainRoot.distanceTo(chainMiddle);
    const lowerLength = chainMiddle.distanceTo(chainEnd);
    if (upperLength < 1e-6 || lowerLength < 1e-6) continue;
    const skeletonSide = resolveMixamoChainSide(upper, chainRoot.x, upperLength + lowerLength, chainRuntime.side);
    chainRuntime.side = skeletonSide;
    const mirrorX = getDirectorIkMirrorX(effector, skeletonSide);

    const targetRootLocal = directorLocalPointToRootLocalInto(
      root,
      target.target,
      mirrorX,
      chainRuntime.targetRootLocal,
    );
    const poleRootLocal = directorLocalPointToRootLocalInto(root, target.pole, mirrorX, chainRuntime.poleRootLocal);
    writeVectorTuple(chainRuntime.rootInput, chainRoot);
    writeVectorTuple(chainRuntime.targetInput, targetRootLocal);
    writeVectorTuple(chainRuntime.poleInput, poleRootLocal);
    chainRuntime.solverInput.upperLength = upperLength;
    chainRuntime.solverInput.lowerLength = lowerLength;
    chainRuntime.solverInput.reachClamp = target.reachClamp;

    const solution = solveTwoBoneIkInto(chainRuntime.solverInput, chainRuntime.solver);

    aimBoneAtRootLocalPoint(root, upper, lower, solution.middle, target.weight, chainRuntime.aim);
    aimBoneAtRootLocalPoint(root, lower, end, solution.end, target.weight, chainRuntime.aim);
  }
}

export function applyMixamoRestPoseAndRig(
  root: Object3D,
  {
    bodyType,
    controls,
    ik,
    restPose,
    animated,
  }: {
    bodyType?: CharacterBodyType;
    controls: Record<string, number>;
    ik?: DirectorCharacterIkState;
    restPose: MixamoRestPose;
    animated?: boolean;
  },
) {
  const bones = collectMixamoBones(root);
  restoreMixamoRestPose(root, restPose, { bones });
  applyMixamoRigLayers(root, {
    bodyType,
    controls,
    ik,
    restPose,
    animated,
    bones: resolveMixamoBones(root, bones),
  });
}

/** Restore the authored deform skeleton before deterministic clip sampling. */
export function restoreMixamoRestPose(
  root: Object3D,
  restPose: MixamoRestPose,
  {
    bones,
    updateMatrixWorld = true,
  }: {
    bones?: readonly Bone[];
    updateMatrixWorld?: boolean;
  } = {},
) {
  const deformBones = bones ?? collectMixamoBones(root);
  deformBones.forEach((object) => {
    const rest = restPose[object.uuid];
    if (!rest) return;
    object.position.set(...rest.position);
    object.quaternion.set(...rest.quaternion);
    object.scale.set(...rest.scale);
  });
  if (updateMatrixWorld) root.updateMatrixWorld(true);
}

/** Apply semantic pose offsets and IK over either the rest pose or a sampled clip. */
export function applyMixamoRigLayers(
  root: Object3D,
  {
    bodyType,
    controls,
    ik,
    restPose,
    animated = false,
    bones: resolvedBones,
  }: {
    bodyType?: CharacterBodyType;
    controls: Record<string, number>;
    ik?: DirectorCharacterIkState;
    restPose: MixamoRestPose;
    /** Preserve the sampled clip as the base pose before controls and IK. */
    animated?: boolean;
    /** Pre-indexed semantic bones for per-frame animation sampling. */
    bones?: MixamoResolvedBones;
  },
) {
  const bones = resolvedBones ?? resolveMixamoBones(root);
  const rotations = getMixamoPoseBoneRotations(controls, bodyType, animated);

  (Object.entries(rotations) as Array<[MixamoBoneRole, [number, number, number]]>).forEach(([role, rotation]) => {
    const bone = bones[role];
    if (bone) applyRotationOffset(bone, rotation);
  });

  const hips = bones.body;
  if (hips) {
    const rest = restPose[hips.uuid];
    const offsetY = controls["body.offsetY"] ?? 0;
    if (!animated && rest) hips.position.set(...rest.position);
    if (offsetY !== 0) {
      hips.position.add(directorLocalOffsetToObjectParentLocal(root, hips, [0, offsetY, 0]));
    }
  }

  applyMixamoCharacterIk(root, bones, ik);
  root.updateMatrixWorld(true);
}

/**
 * Uniformly scales a posed Mixamo character into Director metre space.
 * Mixamo FBX exports are typically authored in centimetres (~180 units tall)
 * while packaged GLBs are already near human scale.
 */
export function scaleMixamoCharacterToTargetHeight(root: Object3D, targetHeightM: number): number {
  if (!Number.isFinite(targetHeightM) || targetHeightM <= 0) return 1;

  root.updateMatrixWorld(true);
  const bounds = getBoundsInParentLocal(root);
  if (bounds.isEmpty()) return 1;

  const currentHeight = bounds.getSize(new Vector3()).y;
  if (!Number.isFinite(currentHeight) || currentHeight <= 0) return 1;

  const relativeError = Math.abs(currentHeight - targetHeightM) / targetHeightM;
  if (relativeError <= MIXAMO_CHARACTER_HEIGHT_TOLERANCE) return 1;

  const scaleFactor = targetHeightM / currentHeight;
  root.scale.set(root.scale.x * scaleFactor, root.scale.y * scaleFactor, root.scale.z * scaleFactor);
  root.updateMatrixWorld(true);
  return scaleFactor;
}

/** Moves the rendered character, not its authored skeleton root, to y=0. */
export function alignMixamoCharacterToGround(root: Object3D) {
  const rootX = root.position.x;
  const rootZ = root.position.z;
  root.position.set(rootX, 0, rootZ);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bounds = getBoundsInParentLocal(root);
    const correctionY = bounds.isEmpty() || !Number.isFinite(bounds.min.y) ? 0 : -bounds.min.y;
    if (Math.abs(correctionY) < 0.00001) break;
    root.position.y += correctionY;
  }

  (root.parent ?? root).updateMatrixWorld(true);
  return root.position.y;
}

function metricsFromBounds(bounds: Box3): MixamoCharacterMetrics {
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());

  return {
    bounds: {
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    },
    height: size.y,
    labelAnchorY: bounds.max.y + VIEWPORT_OBJECT_LABEL_VERTICAL_GAP,
    visualCenter: [center.x, center.y, center.z],
  };
}

export function measureMixamoCharacter(root: Object3D): MixamoCharacterMetrics | null {
  const bounds = getBoundsInParentLocal(root);
  if (bounds.isEmpty()) return null;
  return metricsFromBounds(bounds);
}

/**
 * Applies cached or measured uniform scale, grounds the character, and returns
 * layout metrics in one pass to avoid redundant bounding-box walks during load.
 */
export function normalizeMixamoCharacterLayout(
  root: Object3D,
  targetHeightM: number,
  cachedScaleFactor?: number,
): { scaleFactor: number; metrics: MixamoCharacterMetrics | null } {
  let scaleFactor = cachedScaleFactor ?? 1;

  if (cachedScaleFactor === undefined) {
    scaleFactor = scaleMixamoCharacterToTargetHeight(root, targetHeightM);
  } else if (cachedScaleFactor !== 1) {
    root.scale.set(
      root.scale.x * cachedScaleFactor,
      root.scale.y * cachedScaleFactor,
      root.scale.z * cachedScaleFactor,
    );
    root.updateMatrixWorld(true);
  }

  const rootX = root.position.x;
  const rootZ = root.position.z;
  root.position.set(rootX, 0, rootZ);

  let bounds = getBoundsInParentLocal(root);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const correctionY = bounds.isEmpty() || !Number.isFinite(bounds.min.y) ? 0 : -bounds.min.y;
    if (Math.abs(correctionY) < 0.00001) break;
    root.position.y += correctionY;
    bounds = getBoundsInParentLocal(root);
  }

  (root.parent ?? root).updateMatrixWorld(true);
  return {
    scaleFactor,
    metrics: bounds.isEmpty() ? null : metricsFromBounds(bounds),
  };
}
