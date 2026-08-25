import { Bone, Object3D, Vector3 } from "three";

const LOCOMOTION_GROUND_CLEARANCE_M = 0.03;

export type MixamoFootGroundingState = {
  baseRootY: number;
  bones: Bone[];
  restAnchorY: number;
  scratchWorldPosition: Vector3;
};

function isGroundingBone(object: Object3D): object is Bone {
  return "isBone" in object && object.isBone === true && /(foot|toe)/i.test(object.name);
}

function getLowestAnchorY(root: Object3D, bones: readonly Bone[], worldPosition: Vector3) {
  root.updateWorldMatrix(true, true);
  let lowestAnchorY = Number.POSITIVE_INFINITY;
  for (const bone of bones) {
    bone.getWorldPosition(worldPosition);
    root.worldToLocal(worldPosition);
    lowestAnchorY = Math.min(lowestAnchorY, worldPosition.y);
  }
  return lowestAnchorY;
}

/** Cache the rest-pose foot/toe plane once; no mesh bounds are scanned per frame. */
export function createMixamoFootGroundingState(root: Object3D): MixamoFootGroundingState | null {
  const bones: Bone[] = [];
  root.traverse((object) => {
    if (isGroundingBone(object)) bones.push(object);
  });
  if (bones.length === 0) return null;
  const scratchWorldPosition = new Vector3();
  return {
    baseRootY: root.position.y,
    bones,
    restAnchorY: getLowestAnchorY(root, bones, scratchWorldPosition),
    scratchWorldPosition,
  };
}

/**
 * Keep locomotion feet on the prepared character's rest-pose ground plane.
 * A small clearance accounts for shoe/toe mesh below the deform bones while
 * avoiding the per-frame Box3 skinning traversal that previously hurt Stage FPS.
 */
export function applyMixamoFootGrounding(root: Object3D, state: MixamoFootGroundingState | null, enabled: boolean) {
  if (!state) return;
  root.position.y = state.baseRootY;
  if (!enabled) {
    root.updateMatrixWorld(true);
    return;
  }
  const currentAnchorY = getLowestAnchorY(root, state.bones, state.scratchWorldPosition);
  root.position.y = state.baseRootY + state.restAnchorY - currentAnchorY + LOCOMOTION_GROUND_CLEARANCE_M;
  root.updateMatrixWorld(true);
}
