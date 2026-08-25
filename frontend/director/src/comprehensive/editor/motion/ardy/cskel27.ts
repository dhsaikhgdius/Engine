/**
 * NVIDIA ARDY CoreSkeleton27 (cskel27) definition: joint order, parent
 * hierarchy, and the neutral T-pose. Transcribed from the ARDY reference
 * implementation (github.com/nv-tlabs/ardy, Apache-2.0) — the joint index in
 * these tables equals the joint index in a generated motion npz
 * (`local_rot_mats[:, i]`, `posed_joints[:, i]`).
 *
 * Units are metres, Y-up. The neutral pose puts the hips at the origin with
 * arms extended along ±X and the lowest joints (toes) at y = -0.9544128.
 */

/** The 27 ARDY core-skeleton joints in npz index order. */
export const CSKEL27_JOINTS = [
  "Hips",
  "Spine",
  "Spine1",
  "Spine2",
  "Spine3",
  "Neck",
  "Head",
  "RightShoulder",
  "RightArm",
  "RightForeArm",
  "RightHand",
  "RightHandEnd",
  "RightHandThumb1",
  "LeftShoulder",
  "LeftArm",
  "LeftForeArm",
  "LeftHand",
  "LeftHandEnd",
  "LeftHandThumb1",
  "RightUpLeg",
  "RightLeg",
  "RightFoot",
  "RightToeBase",
  "LeftUpLeg",
  "LeftLeg",
  "LeftFoot",
  "LeftToeBase",
] as const;

/** Number of joints in the cskel27 skeleton (always 27). */
export const CSKEL27_JOINT_COUNT = CSKEL27_JOINTS.length;

const JOINT_INDEX = new Map<string, number>(CSKEL27_JOINTS.map((name, index) => [name, index]));

const PARENT_BY_NAME: Record<string, string | null> = {
  Hips: null,
  Spine: "Hips",
  Spine1: "Spine",
  Spine2: "Spine1",
  Spine3: "Spine2",
  Neck: "Spine3",
  Head: "Neck",
  RightShoulder: "Spine3",
  RightArm: "RightShoulder",
  RightForeArm: "RightArm",
  RightHand: "RightForeArm",
  RightHandEnd: "RightHand",
  RightHandThumb1: "RightHand",
  LeftShoulder: "Spine3",
  LeftArm: "LeftShoulder",
  LeftForeArm: "LeftArm",
  LeftHand: "LeftForeArm",
  LeftHandEnd: "LeftHand",
  LeftHandThumb1: "LeftHand",
  RightUpLeg: "Hips",
  RightLeg: "RightUpLeg",
  RightFoot: "RightLeg",
  RightToeBase: "RightFoot",
  LeftUpLeg: "Hips",
  LeftLeg: "LeftUpLeg",
  LeftFoot: "LeftLeg",
  LeftToeBase: "LeftFoot",
};

/** Parent joint index per cskel27 index; the root (Hips) is -1. Parents
 * always precede children, so a single forward pass is a valid FK order. */
export const CSKEL27_PARENTS: readonly number[] = CSKEL27_JOINTS.map((name) => {
  const parentName = PARENT_BY_NAME[name];
  return parentName === null || parentName === undefined ? -1 : (JOINT_INDEX.get(parentName) ?? -1);
});

/** Neutral-pose joint positions (metres, Y-up), index order == CSKEL27_JOINTS. */
export const CSKEL27_NEUTRAL: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.0, 0.0], // Hips
  [0.0, 0.0709891, -0.0473261], // Spine
  [0.0, 0.1642033, -0.0637623], // Spine1
  [0.0, 0.2584953, -0.0720118], // Spine2
  [0.0, 0.3531475, -0.0720119], // Spine3
  [0.0, 0.6016096, -0.0365176], // Neck
  [0.0, 0.7297793, -0.0139179], // Head
  [-0.0319949, 0.5259196, -0.0186873], // RightShoulder
  [-0.1909029, 0.5259195, -0.0186873], // RightArm
  [-0.4863389, 0.5259194, -0.0186873], // RightForeArm
  [-0.7189909, 0.5259193, -0.0186873], // RightHand
  [-0.7886024, 0.5259193, -0.0186873], // RightHandEnd
  [-0.7468355, 0.5073563, 0.0277204], // RightHandThumb1
  [0.0319949, 0.5259196, -0.0186873], // LeftShoulder
  [0.1909029, 0.5259196, -0.0186873], // LeftArm
  [0.4863389, 0.5259196, -0.0186873], // LeftForeArm
  [0.7189909, 0.5259196, -0.0186873], // LeftHand
  [0.7886024, 0.5259196, -0.0186873], // LeftHandEnd
  [0.7468355, 0.5073565, 0.0277204], // LeftHandThumb1
  [-0.0949182, -0.0277289, 0.0], // RightUpLeg
  [-0.0949182, -0.4398469, 0.0], // RightLeg
  [-0.0949182, -0.8959379, 0.0], // RightFoot
  [-0.0949182, -0.9544128, 0.1606583], // RightToeBase
  [0.0949182, -0.0277289, 0.0], // LeftUpLeg
  [0.0949182, -0.4398469, 0.0], // LeftLeg
  [0.0949182, -0.8959379, 0.0], // LeftFoot
  [0.0949182, -0.9544128, 0.1606583], // LeftToeBase
];

/** Toe depth of the neutral pose below the hips origin. */
export const CSKEL27_NEUTRAL_MIN_Y = -0.9544128;

/**
 * Forward kinematics over one frame of npz local rotations: writes the GLOBAL
 * (ARDY-world) row-major 3x3 rotation of every joint into `outGlobals`
 * (27 * 9 floats). `rotMats` is the whole clip's `local_rot_mats` buffer and
 * `frameBase` the float offset of the requested frame (frame * 27 * 9).
 */
export function computeCskel27GlobalRotations(
  rotMats: Float32Array,
  frameBase: number,
  outGlobals: Float64Array,
): void {
  for (let joint = 0; joint < CSKEL27_JOINT_COUNT; joint += 1) {
    const local = frameBase + joint * 9;
    const out = joint * 9;
    const parent = CSKEL27_PARENTS[joint]!;
    if (parent < 0) {
      for (let i = 0; i < 9; i += 1) outGlobals[out + i] = rotMats[local + i]!;
      continue;
    }
    const parentBase = parent * 9;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        outGlobals[out + row * 3 + column] =
          outGlobals[parentBase + row * 3]! * rotMats[local + column]! +
          outGlobals[parentBase + row * 3 + 1]! * rotMats[local + 3 + column]! +
          outGlobals[parentBase + row * 3 + 2]! * rotMats[local + 6 + column]!;
      }
    }
  }
}
