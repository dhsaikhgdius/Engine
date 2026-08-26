/**
 * Locates a posed character's joints inside the live viewport scene.
 *
 * Director renders characters two ways: Mixamo/GLB assets with a real deform
 * skeleton, and the procedural mannequin used when no character asset resolves.
 * The pose rig has to attach to whichever is on screen, so this module reduces
 * both to the same pair of references per joint — the node whose world position
 * places the handle, and the node whose local rotation the pose controls drive.
 *
 * @module director/editor/pose/character-pose-joint-probe
 */

import { Bone, type Object3D } from "three";
import { resolveMixamoBones, type MixamoResolvedBones } from "../runtime/mixamo/mixamoCharacterRig";
import { CHARACTER_POSE_JOINTS, type CharacterPoseJoint } from "./characterPoseJoints";

/** Marks an anchor whose parent rotation is already owned by another joint. */
export const POSE_JOINT_ROTATABLE_KEY = "poseJointRotatable";

export interface CharacterPoseJointNode {
  joint: CharacterPoseJoint;
  /** Node whose world position places the viewport handle. */
  anchor: Object3D;
  /** Node whose local rotation the joint's pose controls drive. */
  rotationNode: Object3D | null;
}

export interface CharacterPoseRigBinding {
  joints: CharacterPoseJointNode[];
  /** Mixamo asset root, present only for skeleton-backed characters. */
  skeletonRoot: Object3D | null;
  /** Local coordinate space used by the existing character IK targets. */
  ikSpaceRoot: Object3D | null;
  /** Semantic bones, present only for skeleton-backed characters. */
  bones: MixamoResolvedBones | null;
}

const EMPTY_BINDING: CharacterPoseRigBinding = {
  joints: [],
  skeletonRoot: null,
  ikSpaceRoot: null,
  bones: null,
};

/**
 * A partially named export can resolve a handful of roles by accident. Require
 * most of the skeleton before preferring bones over mannequin anchors, so a
 * prop that happens to contain a bone named "Head" cannot hijack the rig.
 */
const MINIMUM_RESOLVED_BONE_ROLES = 8;

function findFirstBone(root: Object3D): Bone | null {
  let found: Bone | null = null;
  root.traverse((object) => {
    if (!found && object instanceof Bone) found = object;
  });
  return found;
}

/**
 * The Mixamo scene sits two levels below the character object: the rig
 * component renders an untransformed root group that holds the cloned asset.
 * IK goals are stored in the asset root's parent space, so the solver's notion
 * of "root" must be that cloned asset, not the bone's topmost ancestor.
 */
function findSkeletonRoot(characterRoot: Object3D, bone: Object3D) {
  let node: Object3D = bone;
  while (node.parent && node.parent !== characterRoot) {
    if (node.parent.parent === characterRoot) return node;
    node = node.parent;
  }
  return node;
}

function bindSkeletonJoints(bones: MixamoResolvedBones) {
  return CHARACTER_POSE_JOINTS.flatMap<CharacterPoseJointNode>((joint) => {
    const bone = bones[joint.id];
    return bone ? [{ joint, anchor: bone, rotationNode: bone }] : [];
  });
}

function bindMannequinJoints(characterRoot: Object3D) {
  const anchors = new Map<string, Object3D>();
  characterRoot.traverse((object) => {
    if (object.name.startsWith("mannequin-joint-") && !anchors.has(object.name)) anchors.set(object.name, object);
  });

  return CHARACTER_POSE_JOINTS.flatMap<CharacterPoseJointNode>((joint) => {
    const anchor = anchors.get(joint.mannequinNode);
    if (!anchor) return [];
    // Anchors sit at their driving node's origin without a local rotation, so
    // the parent is the node the pose controls actually rotate. Hands and feet
    // opt out: the mannequin renders them rigidly, and their parent rotation
    // already belongs to the elbow or knee.
    const rotatable = anchor.userData[POSE_JOINT_ROTATABLE_KEY] !== false;
    return [{ joint, anchor, rotationNode: rotatable ? (anchor.parent ?? null) : null }];
  });
}

function findTopLevelCharacterChild(characterRoot: Object3D, node: Object3D) {
  let current = node;
  while (current.parent && current.parent !== characterRoot) current = current.parent;
  return current;
}

/**
 * Resolve the joint handles for a character currently rendered in the viewport.
 *
 * @param characterRoot - The `director-object-*` group for the character.
 * @returns Joint bindings plus skeleton references when the rig has bones.
 */
export function resolveCharacterPoseRigBinding(characterRoot: Object3D | null | undefined): CharacterPoseRigBinding {
  if (!characterRoot) return EMPTY_BINDING;

  const bone = findFirstBone(characterRoot);
  if (bone) {
    const skeletonRoot = findSkeletonRoot(characterRoot, bone);
    const bones = resolveMixamoBones(skeletonRoot);
    if (Object.keys(bones).length >= MINIMUM_RESOLVED_BONE_ROLES) {
      return {
        joints: bindSkeletonJoints(bones),
        skeletonRoot,
        ikSpaceRoot: skeletonRoot.parent ?? characterRoot,
        bones,
      };
    }
  }

  const joints = bindMannequinJoints(characterRoot);
  return joints.length
    ? {
        joints,
        skeletonRoot: null,
        ikSpaceRoot: findTopLevelCharacterChild(characterRoot, joints[0]!.anchor),
        bones: null,
      }
    : EMPTY_BINDING;
}
