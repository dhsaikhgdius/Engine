import { BufferAttribute, BufferGeometry } from "three";
import type { WorldWildlifeSpecies } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";

/**
 * Procedural placeholder silhouettes for wildlife groups.
 *
 * Herd quadrupeds (deer, rabbits, wolves, sheep) are articulated: every
 * species is still ONE merged, non-indexed BufferGeometry rendered as a single
 * InstancedMesh, but each vertex carries part metadata (`aPartId`,
 * `aPartPivot`, `aPartAxis`) so a vertex shader can rotate legs, head, and
 * tail about their pivots from per-instance angle attributes (see
 * `wildlifePartMaterial.ts` for the shader and `wildlifeGait.ts` for the angle
 * math). This keeps one draw call per group while giving real leg swing,
 * head-down grazing, and tail motion at silhouette distances.
 *
 * Flock/school species (birds, butterflies, fish) keep their whole-body
 * flap/wiggle animation and get inert part metadata (all body) so every
 * species shares one geometry layout.
 *
 * Geometry is non-indexed so computeVertexNormals yields faceted (flat)
 * shading, which reads better at silhouette distances than smooth normals on
 * this few triangles. Builders are pure: identical inputs produce identical
 * vertex buffers (asserted by tests), keeping deterministic exports
 * byte-stable.
 *
 * Conventions: model forward is +Z, up is +Y, origin at the body center.
 * `sizeScale` is baked into the vertex positions AND part pivots so instance
 * matrices stay scale-free (unit scale) in the per-frame compose loop.
 * `bodyOffsetYM` equals the leg reach below the origin, so feet touch the
 * ground exactly when the render layer lifts the body by that offset.
 */

export interface WildlifeRenderProfile {
  /** Species tint for the shared MeshStandardMaterial. */
  tintHex: number;
  /** Body-center height above ground at sizeScale 1 (herd species only). */
  bodyOffsetYM: number;
  /** Whole-body roll oscillation frequency that fakes a wing flap (flock species). */
  flapHz: number;
  /** Peak roll amplitude of the wing-flap oscillation, radians. */
  flapAmplitudeRad: number;
  /** Yaw oscillation frequency that fakes a tail wiggle (fish). */
  wiggleHz: number;
  /** Peak yaw amplitude of the tail-wiggle oscillation, radians. */
  wiggleAmplitudeRad: number;
}

/** Per-species tuning constants for the placeholder silhouette render path. */
export const WILDLIFE_RENDER_PROFILES: Record<WorldWildlifeSpecies, WildlifeRenderProfile> = {
  birds: {
    tintHex: 0x4a5568,
    bodyOffsetYM: 0,
    flapHz: 4,
    flapAmplitudeRad: 0.45,
    wiggleHz: 0,
    wiggleAmplitudeRad: 0,
  },
  butterflies: {
    tintHex: 0xe8863a,
    bodyOffsetYM: 0,
    flapHz: 9,
    flapAmplitudeRad: 0.85,
    wiggleHz: 0,
    wiggleAmplitudeRad: 0,
  },
  fish: {
    tintHex: 0x7fa8c9,
    bodyOffsetYM: 0,
    flapHz: 0,
    flapAmplitudeRad: 0,
    wiggleHz: 3.5,
    wiggleAmplitudeRad: 0.22,
  },
  deer: {
    tintHex: 0x8a6240,
    bodyOffsetYM: 0.78,
    flapHz: 0,
    flapAmplitudeRad: 0,
    wiggleHz: 0,
    wiggleAmplitudeRad: 0,
  },
  rabbits: {
    tintHex: 0xb7a68e,
    bodyOffsetYM: 0.17,
    flapHz: 0,
    flapAmplitudeRad: 0,
    wiggleHz: 0,
    wiggleAmplitudeRad: 0,
  },
  wolves: {
    tintHex: 0x5a5f66,
    bodyOffsetYM: 0.59,
    flapHz: 0,
    flapAmplitudeRad: 0,
    wiggleHz: 0,
    wiggleAmplitudeRad: 0,
  },
  sheep: {
    tintHex: 0xe6e2d6,
    bodyOffsetYM: 0.49,
    flapHz: 0,
    flapAmplitudeRad: 0,
    wiggleHz: 0,
    wiggleAmplitudeRad: 0,
  },
};

// ---------------------------------------------------------------------------
// Part vocabulary shared by geometry, gait math, and the part shader
// ---------------------------------------------------------------------------

/**
 * Angle-slot index per animated part. Slots index into the two per-instance
 * vec4 angle attributes (8 slots total; 7 is spare). `body` never rotates in
 * the shader (whole-body motion lives in the instance matrix) so its slot
 * always carries angle 0.
 */
export const WILDLIFE_PART_SLOTS = {
  body: 0,
  head: 1,
  legFrontLeft: 2,
  legFrontRight: 3,
  legHindLeft: 4,
  legHindRight: 5,
  tail: 6,
} as const;

/** Named part identifiers matching WILDLIFE_PART_SLOTS keys. */
export type WildlifePartName = keyof typeof WILDLIFE_PART_SLOTS;

/** Total slots in the per-instance angle buffer (2 × vec4 attributes). */
export const WILDLIFE_PART_ANGLE_SLOTS = 8;

/** Vertex attribute name for the part-slot index (float, 0..7). */
export const WILDLIFE_PART_ID_ATTRIBUTE = "aPartId";
/** Vertex attribute name for the part rotation pivot in model space. */
export const WILDLIFE_PART_PIVOT_ATTRIBUTE = "aPartPivot";
/** Vertex attribute name for the unit rotation axis in model space. */
export const WILDLIFE_PART_AXIS_ATTRIBUTE = "aPartAxis";

export interface WildlifePartPivot {
  /** Which articulated body part this pivot belongs to. */
  name: WildlifePartName;
  /** Angle slot in the per-instance attributes (== WILDLIFE_PART_SLOTS). */
  slot: number;
  /** Rotation pivot in model space, sizeScale-baked. */
  pivot: [number, number, number];
  /** Unit rotation axis in model space (X = pitch swing, Y = side wag). */
  axis: [number, number, number];
}

export interface WildlifeModelBuild {
  /** Non-indexed BufferGeometry with position, normal, partId, partPivot, and partAxis attributes. */
  geometry: BufferGeometry;
  /** Per-part pivot metadata (body first), for tests and future multi-mesh use. */
  parts: WildlifePartPivot[];
}

// ---------------------------------------------------------------------------
// Triangle-soup helpers
// ---------------------------------------------------------------------------

function pushTriangle(
  target: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  target.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

/** Unit-cube corner signs; faces below index into this table. */
const BOX_CORNER_SIGNS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

/** Quad faces (corner indices) with CCW outward winding: +Z, -Z, +X, -X, +Y, -Y. */
const BOX_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [4, 5, 6, 7],
  [1, 0, 3, 2],
  [5, 1, 2, 6],
  [0, 4, 7, 3],
  [7, 6, 2, 3],
  [0, 1, 5, 4],
];

/**
 * Box (12 triangles) centered at (cx, cy, cz), optionally rotated about its
 * own center: pitch about X first (positive leans the top toward +Z), then
 * roll about Z (positive leans the top toward -X).
 */
function pushBox(
  target: number[],
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
  pitchRad = 0,
  rollRad = 0,
): void {
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const cr = Math.cos(rollRad);
  const sr = Math.sin(rollRad);
  const corners: Array<[number, number, number]> = [];
  for (const [gx, gy, gz] of BOX_CORNER_SIGNS) {
    const lx = gx * (sx / 2);
    const ly = gy * (sy / 2);
    const lz = gz * (sz / 2);
    // rotX(pitch)
    const y1 = ly * cp - lz * sp;
    const z1 = ly * sp + lz * cp;
    // rotZ(roll)
    const x2 = lx * cr - y1 * sr;
    const y2 = lx * sr + y1 * cr;
    corners.push([cx + x2, cy + y2, cz + z1]);
  }
  for (const [a, b, c, d] of BOX_FACES) {
    const pa = corners[a];
    const pb = corners[b];
    const pc = corners[c];
    const pd = corners[d];
    pushTriangle(target, pa[0], pa[1], pa[2], pb[0], pb[1], pb[2], pc[0], pc[1], pc[2]);
    pushTriangle(target, pa[0], pa[1], pa[2], pc[0], pc[1], pc[2], pd[0], pd[1], pd[2]);
  }
}

/** Slim four-sided pyramid pointing +Z: the fuselage silhouette. */
function pushFuselageCone(target: number[], noseZ: number, tailZ: number, halfWidth: number): void {
  const nose: [number, number, number] = [0, 0, noseZ];
  const corners: [number, number, number][] = [
    [-halfWidth, -halfWidth, tailZ],
    [halfWidth, -halfWidth, tailZ],
    [halfWidth, halfWidth, tailZ],
    [-halfWidth, halfWidth, tailZ],
  ];
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    pushTriangle(target, nose[0], nose[1], nose[2], a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  // Base cap (two triangles).
  pushTriangle(
    target,
    corners[0][0],
    corners[0][1],
    corners[0][2],
    corners[2][0],
    corners[2][1],
    corners[2][2],
    corners[1][0],
    corners[1][1],
    corners[1][2],
  );
  pushTriangle(
    target,
    corners[0][0],
    corners[0][1],
    corners[0][2],
    corners[3][0],
    corners[3][1],
    corners[3][2],
    corners[2][0],
    corners[2][1],
    corners[2][2],
  );
}

// ---------------------------------------------------------------------------
// Flock/school silhouettes (whole-body animated; single "body" part)
// ---------------------------------------------------------------------------

interface FlockSilhouetteSpec {
  bodyNoseZ: number;
  bodyTailZ: number;
  bodyHalfWidth: number;
  /** Wing triangles: [rootZ, tipX, tipY, tipZ, rootBackZ] per wing pair. */
  wingPairs: Array<{ rootZ: number; rootBackZ: number; tipX: number; tipY: number; tipZ: number }>;
}

const BIRD_SPEC: FlockSilhouetteSpec = {
  bodyNoseZ: 0.24,
  bodyTailZ: -0.12,
  bodyHalfWidth: 0.05,
  wingPairs: [{ rootZ: 0.04, rootBackZ: -0.1, tipX: 0.45, tipY: 0.03, tipZ: -0.06 }],
};

const BUTTERFLY_SPEC: FlockSilhouetteSpec = {
  bodyNoseZ: 0.05,
  bodyTailZ: -0.05,
  bodyHalfWidth: 0.012,
  wingPairs: [
    { rootZ: 0.03, rootBackZ: -0.01, tipX: 0.09, tipY: 0.012, tipZ: 0.035 },
    { rootZ: -0.005, rootBackZ: -0.045, tipX: 0.075, tipY: 0.008, tipZ: -0.05 },
  ],
};

function buildFlockPositions(spec: FlockSilhouetteSpec): number[] {
  const positions: number[] = [];
  pushFuselageCone(positions, spec.bodyNoseZ, spec.bodyTailZ, spec.bodyHalfWidth);
  for (const wing of spec.wingPairs) {
    // Right wing then left wing; single triangles, double-sided material.
    pushTriangle(
      positions,
      spec.bodyHalfWidth * 0.5,
      0,
      wing.rootZ,
      wing.tipX,
      wing.tipY,
      wing.tipZ,
      spec.bodyHalfWidth * 0.5,
      0,
      wing.rootBackZ,
    );
    pushTriangle(
      positions,
      -spec.bodyHalfWidth * 0.5,
      0,
      wing.rootZ,
      -spec.bodyHalfWidth * 0.5,
      0,
      wing.rootBackZ,
      -wing.tipX,
      wing.tipY,
      wing.tipZ,
    );
  }
  return positions;
}

/** Flattened teardrop (elongated octahedron) plus a vertical tail fin. */
function buildFishPositions(): number[] {
  const positions: number[] = [];
  const nose: [number, number, number] = [0, 0, 0.16];
  const tail: [number, number, number] = [0, 0, -0.1];
  const ring: [number, number, number][] = [
    [0, 0.05, 0.02], // top
    [0.018, 0, 0.02], // right (flattened in X)
    [0, -0.05, 0.02], // bottom
    [-0.018, 0, 0.02], // left
  ];
  for (let i = 0; i < 4; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    pushTriangle(positions, nose[0], nose[1], nose[2], b[0], b[1], b[2], a[0], a[1], a[2]);
    pushTriangle(positions, tail[0], tail[1], tail[2], a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  // Tail fin: single vertical triangle behind the body.
  pushTriangle(positions, 0, 0, -0.08, 0, 0.055, -0.17, 0, -0.055, -0.17);
  return positions;
}

// ---------------------------------------------------------------------------
// Herd quadruped silhouettes (articulated parts)
// ---------------------------------------------------------------------------

interface QuadrupedBoxSpec {
  part: WildlifePartName;
  center: readonly [number, number, number];
  size: readonly [number, number, number];
  pitchRad?: number;
  rollRad?: number;
}

interface QuadrupedPartDef {
  name: WildlifePartName;
  pivot: readonly [number, number, number];
  axis: readonly [number, number, number];
}

interface QuadrupedModelSpec {
  /** Animated part pivots; `body` is implicit (pivot origin, axis X). */
  parts: readonly QuadrupedPartDef[];
  /** Ordered box list; ordering is part of the deterministic vertex layout. */
  boxes: readonly QuadrupedBoxSpec[];
}

const AXIS_X: readonly [number, number, number] = [1, 0, 0];
const AXIS_Y: readonly [number, number, number] = [0, 1, 0];

/**
 * Proportions at sizeScale 1 (metres). Shoulder height = bodyOffsetYM + body
 * top; leg boxes reach exactly -bodyOffsetYM so feet touch the ground.
 *
 * deer:    shoulder ≈ 1.00, slender body, long legs, raised neck, antler Y-forks
 * wolves:  shoulder ≈ 0.75, low profile, thick drooping tail, ears
 * sheep:   shoulder ≈ 0.77, rounded stepped back, short legs
 * rabbits: crouched ≈ 0.30 total, big haunches, upright ear pair
 */
const QUADRUPED_MODEL_SPECS: Record<"deer" | "rabbits" | "wolves" | "sheep", QuadrupedModelSpec> = {
  deer: {
    parts: [
      { name: "head", pivot: [0, 0.1, 0.44], axis: AXIS_X },
      { name: "legFrontLeft", pivot: [-0.095, -0.1, 0.36], axis: AXIS_X },
      { name: "legFrontRight", pivot: [0.095, -0.1, 0.36], axis: AXIS_X },
      { name: "legHindLeft", pivot: [-0.095, -0.1, -0.38], axis: AXIS_X },
      { name: "legHindRight", pivot: [0.095, -0.1, -0.38], axis: AXIS_X },
      { name: "tail", pivot: [0, 0.18, -0.49], axis: AXIS_X },
    ],
    boxes: [
      { part: "body", center: [0, 0.02, 0], size: [0.26, 0.4, 1.0] },
      { part: "head", center: [0, 0.34, 0.5], size: [0.1, 0.42, 0.13], pitchRad: 0.55 }, // neck
      { part: "head", center: [0, 0.56, 0.68], size: [0.11, 0.13, 0.3] }, // head + muzzle
      { part: "head", center: [-0.05, 0.7, 0.6], size: [0.03, 0.18, 0.03], rollRad: 0.3 }, // antler beam L
      { part: "head", center: [-0.1, 0.74, 0.66], size: [0.025, 0.12, 0.025], pitchRad: 0.5, rollRad: 0.55 }, // fork L
      { part: "head", center: [0.05, 0.7, 0.6], size: [0.03, 0.18, 0.03], rollRad: -0.3 }, // antler beam R
      { part: "head", center: [0.1, 0.74, 0.66], size: [0.025, 0.12, 0.025], pitchRad: 0.5, rollRad: -0.55 }, // fork R
      { part: "tail", center: [0, 0.16, -0.55], size: [0.06, 0.1, 0.12], pitchRad: -0.25 },
      { part: "legFrontLeft", center: [-0.095, -0.44, 0.36], size: [0.07, 0.68, 0.07] },
      { part: "legFrontRight", center: [0.095, -0.44, 0.36], size: [0.07, 0.68, 0.07] },
      { part: "legHindLeft", center: [-0.095, -0.44, -0.38], size: [0.08, 0.68, 0.08] },
      { part: "legHindRight", center: [0.095, -0.44, -0.38], size: [0.08, 0.68, 0.08] },
    ],
  },
  wolves: {
    parts: [
      { name: "head", pivot: [0, 0.08, 0.4], axis: AXIS_X },
      { name: "legFrontLeft", pivot: [-0.085, -0.08, 0.3], axis: AXIS_X },
      { name: "legFrontRight", pivot: [0.085, -0.08, 0.3], axis: AXIS_X },
      { name: "legHindLeft", pivot: [-0.085, -0.08, -0.32], axis: AXIS_X },
      { name: "legHindRight", pivot: [0.085, -0.08, -0.32], axis: AXIS_X },
      { name: "tail", pivot: [0, 0.04, -0.46], axis: AXIS_Y }, // side-to-side wag
    ],
    boxes: [
      { part: "body", center: [0, 0, -0.02], size: [0.24, 0.32, 0.92] },
      { part: "head", center: [0, 0.16, 0.52], size: [0.14, 0.15, 0.2] },
      { part: "head", center: [0, 0.12, 0.68], size: [0.08, 0.09, 0.16] }, // snout
      { part: "head", center: [-0.05, 0.28, 0.48], size: [0.04, 0.09, 0.03] }, // ear L
      { part: "head", center: [0.05, 0.28, 0.48], size: [0.04, 0.09, 0.03] }, // ear R
      { part: "tail", center: [0, 0.02, -0.62], size: [0.08, 0.09, 0.36], pitchRad: -0.35 }, // thick, drooping
      { part: "legFrontLeft", center: [-0.085, -0.33, 0.3], size: [0.065, 0.52, 0.065] },
      { part: "legFrontRight", center: [0.085, -0.33, 0.3], size: [0.065, 0.52, 0.065] },
      { part: "legHindLeft", center: [-0.085, -0.33, -0.32], size: [0.07, 0.52, 0.07] },
      { part: "legHindRight", center: [0.085, -0.33, -0.32], size: [0.07, 0.52, 0.07] },
    ],
  },
  sheep: {
    parts: [
      { name: "head", pivot: [0, 0.12, 0.4], axis: AXIS_X },
      { name: "legFrontLeft", pivot: [-0.11, -0.15, 0.26], axis: AXIS_X },
      { name: "legFrontRight", pivot: [0.11, -0.15, 0.26], axis: AXIS_X },
      { name: "legHindLeft", pivot: [-0.11, -0.15, -0.24], axis: AXIS_X },
      { name: "legHindRight", pivot: [0.11, -0.15, -0.24], axis: AXIS_X },
      { name: "tail", pivot: [0, 0.1, -0.39], axis: AXIS_X },
    ],
    boxes: [
      { part: "body", center: [0, 0, 0.02], size: [0.36, 0.44, 0.78] },
      { part: "body", center: [0, 0.18, -0.02], size: [0.3, 0.2, 0.6] }, // wool hump rounds the back
      { part: "head", center: [0, 0.14, 0.52], size: [0.14, 0.16, 0.22] },
      { part: "tail", center: [0, 0.1, -0.44], size: [0.05, 0.05, 0.1] },
      { part: "legFrontLeft", center: [-0.11, -0.32, 0.26], size: [0.07, 0.34, 0.07] },
      { part: "legFrontRight", center: [0.11, -0.32, 0.26], size: [0.07, 0.34, 0.07] },
      { part: "legHindLeft", center: [-0.11, -0.32, -0.24], size: [0.07, 0.34, 0.07] },
      { part: "legHindRight", center: [0.11, -0.32, -0.24], size: [0.07, 0.34, 0.07] },
    ],
  },
  rabbits: {
    parts: [
      { name: "head", pivot: [0, 0.05, 0.11], axis: AXIS_X },
      { name: "legFrontLeft", pivot: [-0.05, -0.05, 0.1], axis: AXIS_X },
      { name: "legFrontRight", pivot: [0.05, -0.05, 0.1], axis: AXIS_X },
      { name: "legHindLeft", pivot: [-0.06, -0.05, -0.1], axis: AXIS_X },
      { name: "legHindRight", pivot: [0.06, -0.05, -0.1], axis: AXIS_X },
      { name: "tail", pivot: [0, 0.05, -0.185], axis: AXIS_X },
    ],
    boxes: [
      { part: "body", center: [0, 0.01, 0.03], size: [0.14, 0.15, 0.28] },
      { part: "body", center: [0, 0.04, -0.1], size: [0.16, 0.18, 0.18] }, // haunches
      { part: "head", center: [0, 0.07, 0.17], size: [0.09, 0.1, 0.13] },
      { part: "head", center: [-0.028, 0.19, 0.13], size: [0.03, 0.15, 0.02], pitchRad: -0.25 }, // ear L
      { part: "head", center: [0.028, 0.19, 0.13], size: [0.03, 0.15, 0.02], pitchRad: -0.25 }, // ear R
      { part: "tail", center: [0, 0.05, -0.21], size: [0.05, 0.05, 0.05] },
      { part: "legFrontLeft", center: [-0.05, -0.11, 0.1], size: [0.035, 0.12, 0.035] },
      { part: "legFrontRight", center: [0.05, -0.11, 0.1], size: [0.035, 0.12, 0.035] },
      { part: "legHindLeft", center: [-0.06, -0.11, -0.1], size: [0.05, 0.12, 0.06] },
      { part: "legHindRight", center: [0.06, -0.11, -0.1], size: [0.05, 0.12, 0.06] },
    ],
  },
};

interface BasePositionsBuild {
  positions: number[];
  /** Part slot per vertex, parallel to positions/3. */
  partSlots: number[];
  parts: WildlifePartPivot[];
}

const BODY_PART_PIVOT: WildlifePartPivot = {
  name: "body",
  slot: WILDLIFE_PART_SLOTS.body,
  pivot: [0, 0, 0],
  axis: [1, 0, 0],
};

function buildQuadruped(spec: QuadrupedModelSpec): BasePositionsBuild {
  const positions: number[] = [];
  const partSlots: number[] = [];
  for (const box of spec.boxes) {
    const before = positions.length / 3;
    pushBox(
      positions,
      box.center[0],
      box.center[1],
      box.center[2],
      box.size[0],
      box.size[1],
      box.size[2],
      box.pitchRad ?? 0,
      box.rollRad ?? 0,
    );
    const added = positions.length / 3 - before;
    const slot = WILDLIFE_PART_SLOTS[box.part];
    for (let i = 0; i < added; i += 1) partSlots.push(slot);
  }
  const parts: WildlifePartPivot[] = [
    { ...BODY_PART_PIVOT, pivot: [0, 0, 0], axis: [1, 0, 0] },
    ...spec.parts.map((part) => ({
      name: part.name,
      slot: WILDLIFE_PART_SLOTS[part.name],
      pivot: [part.pivot[0], part.pivot[1], part.pivot[2]] as [number, number, number],
      axis: [part.axis[0], part.axis[1], part.axis[2]] as [number, number, number],
    })),
  ];
  return { positions, partSlots, parts };
}

function buildRigidBody(positions: number[]): BasePositionsBuild {
  const vertexCount = positions.length / 3;
  const partSlots = new Array<number>(vertexCount).fill(WILDLIFE_PART_SLOTS.body);
  return {
    positions,
    partSlots,
    parts: [{ ...BODY_PART_PIVOT, pivot: [0, 0, 0], axis: [1, 0, 0] }],
  };
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

function buildBase(species: WorldWildlifeSpecies): BasePositionsBuild {
  switch (species) {
    case "birds":
      return buildRigidBody(buildFlockPositions(BIRD_SPEC));
    case "butterflies":
      return buildRigidBody(buildFlockPositions(BUTTERFLY_SPEC));
    case "fish":
      return buildRigidBody(buildFishPositions());
    case "deer":
    case "rabbits":
    case "wolves":
    case "sheep":
      return buildQuadruped(QUADRUPED_MODEL_SPECS[species]);
  }
}

/**
 * Deterministic placeholder geometry plus part pivot metadata for a wildlife
 * group. The caller owns geometry disposal (the render layer disposes on
 * unmount and species/sizeScale changes).
 *
 * Geometry attributes: `position`, `normal` (computed, faceted), `aPartId`
 * (float slot), `aPartPivot` (vec3, sizeScale-baked), `aPartAxis` (unit vec3).
 */
export function buildWildlifeModel(species: WorldWildlifeSpecies, sizeScale: number): WildlifeModelBuild {
  const base = buildBase(species);
  const vertexCount = base.positions.length / 3;

  const scaled = new Float32Array(base.positions.length);
  for (let index = 0; index < base.positions.length; index += 1) {
    scaled[index] = base.positions[index] * sizeScale;
  }

  const parts: WildlifePartPivot[] = base.parts.map((part) => ({
    name: part.name,
    slot: part.slot,
    pivot: [part.pivot[0] * sizeScale, part.pivot[1] * sizeScale, part.pivot[2] * sizeScale],
    axis: [part.axis[0], part.axis[1], part.axis[2]],
  }));
  const partBySlot = new Map<number, WildlifePartPivot>();
  for (const part of parts) partBySlot.set(part.slot, part);

  const partIds = new Float32Array(vertexCount);
  const pivots = new Float32Array(vertexCount * 3);
  const axes = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    const slot = base.partSlots[v];
    const part = partBySlot.get(slot) ?? parts[0];
    partIds[v] = slot;
    pivots[v * 3] = part.pivot[0];
    pivots[v * 3 + 1] = part.pivot[1];
    pivots[v * 3 + 2] = part.pivot[2];
    axes[v * 3] = part.axis[0];
    axes[v * 3 + 1] = part.axis[1];
    axes[v * 3 + 2] = part.axis[2];
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(scaled, 3));
  geometry.setAttribute(WILDLIFE_PART_ID_ATTRIBUTE, new BufferAttribute(partIds, 1));
  geometry.setAttribute(WILDLIFE_PART_PIVOT_ATTRIBUTE, new BufferAttribute(pivots, 3));
  geometry.setAttribute(WILDLIFE_PART_AXIS_ATTRIBUTE, new BufferAttribute(axes, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.name = `wildlife-placeholder-${species}`;
  return { geometry, parts };
}

/**
 * Convenience wrapper that returns only the geometry from {@link buildWildlifeModel}.
 * Callers that need part pivot metadata should use buildWildlifeModel directly.
 *
 * @param species - Which wildlife species to build the placeholder for.
 * @param sizeScale - Uniform scale factor baked into vertex positions.
 * @returns Non-indexed BufferGeometry ready for InstancedMesh.
 */
export function buildWildlifeGeometry(species: WorldWildlifeSpecies, sizeScale: number): BufferGeometry {
  return buildWildlifeModel(species, sizeScale).geometry;
}
