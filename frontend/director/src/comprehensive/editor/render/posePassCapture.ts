import { Vector3, type Bone, type Matrix4, type Object3D, type Camera, type SkinnedMesh } from "three";
import { canonicalizeHumanoidBoneName } from "../loaders/humanoidRig";
import { DIRECTOR_HIDE_FROM_CAPTURE_KEY } from "./captureVisibility";
import { assertDirectorRenderDimension as assertDimension } from "./renderCaptureUtils";

const DIRECTOR_OBJECT_KIND_KEY = "directorObjectKind";
const DIRECTOR_OBJECT_ID_KEY = "directorObjectId";

/** COCO-18 body joints in canonical OpenPose index order (0-17). */
export const DIRECTOR_POSE_COCO18_JOINTS = [
  "nose",
  "neck",
  "right-shoulder",
  "right-elbow",
  "right-wrist",
  "left-shoulder",
  "left-elbow",
  "left-wrist",
  "right-hip",
  "right-knee",
  "right-ankle",
  "left-hip",
  "left-knee",
  "left-ankle",
  "right-eye",
  "left-eye",
  "right-ear",
  "left-ear",
] as const;

export type DirectorPoseCoco18Joint = (typeof DIRECTOR_POSE_COCO18_JOINTS)[number];

/**
 * Canonical OpenPose 18-colour wheel. Joint i is drawn with colour i; limb k
 * (see DIRECTOR_POSE_COCO18_LIMBS) is drawn with colour k. Downstream
 * ControlNet-style pose conditioners depend on these exact RGB values.
 */
export const DIRECTOR_POSE_COCO18_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [255, 85, 0],
  [255, 170, 0],
  [255, 255, 0],
  [170, 255, 0],
  [85, 255, 0],
  [0, 255, 0],
  [0, 255, 85],
  [0, 255, 170],
  [0, 255, 255],
  [0, 170, 255],
  [0, 85, 255],
  [0, 0, 255],
  [85, 0, 255],
  [170, 0, 255],
  [255, 0, 255],
  [255, 0, 170],
  [255, 0, 85],
];

/** OpenPose COCO limb pairs as [fromJointIndex, toJointIndex]. */
export const DIRECTOR_POSE_COCO18_LIMBS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [1, 5],
  [2, 3],
  [3, 4],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [1, 11],
  [11, 12],
  [12, 13],
  [1, 0],
  [0, 14],
  [14, 16],
  [0, 15],
  [15, 17],
];

/**
 * Mixamo bone aliases per COCO joint, matched through
 * canonicalizeHumanoidBoneName so any "mixamorig" namespace spelling works.
 * Eyes and ears stay unmapped: Mixamo rigs carry no such bones, and the
 * OpenPose format tolerates absent face joints (their limbs are skipped).
 */
export const DIRECTOR_MIXAMO_COCO18_BONE_ALIASES: Readonly<
  Partial<Record<DirectorPoseCoco18Joint, readonly string[]>>
> = {
  nose: ["Head"],
  neck: ["Neck", "Neck1"],
  "right-shoulder": ["RightArm", "RightShoulder"],
  "right-elbow": ["RightForeArm", "RightLowerArm"],
  "right-wrist": ["RightHand"],
  "left-shoulder": ["LeftArm", "LeftShoulder"],
  "left-elbow": ["LeftForeArm", "LeftLowerArm"],
  "left-wrist": ["LeftHand"],
  "right-hip": ["RightUpLeg", "RightUpperLeg"],
  "right-knee": ["RightLeg", "RightLowerLeg"],
  "right-ankle": ["RightFoot"],
  "left-hip": ["LeftUpLeg", "LeftUpperLeg"],
  "left-knee": ["LeftLeg", "LeftLowerLeg"],
  "left-ankle": ["LeftFoot"],
};

export interface DirectorPoseFigure {
  /** The directorObjectId of the owning character root, or null if untagged. */
  objectId: string | null;
  /** World-space joint positions; absent joints were not resolvable on the rig. */
  joints: Partial<Record<DirectorPoseCoco18Joint, Vector3>>;
}

/** A projected 2D joint position in pixel coordinates (top-left origin). */
export interface DirectorPosePixelPoint {
  x: number;
  y: number;
}

/** Projected figure: entry i corresponds to DIRECTOR_POSE_COCO18_JOINTS[i]. */
export type DirectorPoseFigure2d = Array<DirectorPosePixelPoint | null>;

/** Camera interface for pose joint projection: only matrixWorldInverse and projectionMatrix are needed. */
export interface DirectorPoseProjectionCamera {
  matrixWorldInverse: Matrix4;
  projectionMatrix: Matrix4;
}

export interface DirectorPosePassCaptureInput {
  /** The scene containing skinned character meshes. */
  scene: Object3D;
  /** The camera whose view and projection matrices project joints to pixels. */
  camera: Camera;
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
}

export interface DirectorPosePassCaptureMetadata {
  /** The pass identifier, always "pose". */
  renderPass: "pose";
  /** Raster width in pixels. */
  width: number;
  /** Raster height in pixels. */
  height: number;
  /** Four 8-bit channels per pixel. */
  pixelFormat: "rgba8";
  /** Bits per channel (8 for RGBA8). */
  bitsPerChannel: 8;
  /** Pixel rows are stored top-to-bottom. */
  rowOrder: "top-to-bottom";
  /** Data-space encoding, never color-managed. */
  colorSpace: "data";
  /** Encoding identifier for the OpenPose COCO-18 format. */
  encoding: "openpose-coco18-rgb";
  /** Editor helpers are always excluded from this pass. */
  helpersExcluded: true;
  /** Number of detected skinned character figures in the scene. */
  figureCount: number;
  /** Never present on the pose pass; declared so pass results stay one structural union. */
  objectIdToRgb?: Record<string, [number, number, number]>;
}

/** The RGBA pixel payload and its companion metadata for a pose pass capture. */
export interface DirectorPosePassCaptureResult {
  rgba: Uint8Array;
  metadata: DirectorPosePassCaptureMetadata;
}

function isCaptureVisible(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible || current.userData?.[DIRECTOR_HIDE_FROM_CAPTURE_KEY]) return false;
    current = current.parent;
  }
  return true;
}

function findCharacterRoot(object: Object3D): Object3D | null {
  let current: Object3D | null = object;
  while (current) {
    if (current.userData?.[DIRECTOR_OBJECT_KIND_KEY] === "character") return current;
    current = current.parent;
  }
  return null;
}

function isSkinnedMesh(object: Object3D): object is SkinnedMesh {
  return "isSkinnedMesh" in object && (object as SkinnedMesh).isSkinnedMesh === true;
}

/**
 * Collects one COCO-18 figure per capture-visible skinned character. Bones from
 * every skinned mesh under the same character root merge into a single index;
 * the first bone matching an alias wins, mirroring the runtime rig resolver.
 */
export function collectDirectorPoseFigures(scene: Object3D): DirectorPoseFigure[] {
  const bonesByRoot = new Map<Object3D, Map<string, Bone>>();

  scene.traverse((object) => {
    if (!isSkinnedMesh(object) || !isCaptureVisible(object)) return;
    const root = findCharacterRoot(object);
    if (!root) return;
    let index = bonesByRoot.get(root);
    if (!index) {
      index = new Map<string, Bone>();
      bonesByRoot.set(root, index);
    }
    for (const bone of object.skeleton?.bones ?? []) {
      const canonical = canonicalizeHumanoidBoneName(bone.name);
      if (canonical && !index.has(canonical)) index.set(canonical, bone);
    }
  });

  const figures: DirectorPoseFigure[] = [];
  bonesByRoot.forEach((index, root) => {
    const joints: DirectorPoseFigure["joints"] = {};
    (
      Object.entries(DIRECTOR_MIXAMO_COCO18_BONE_ALIASES) as Array<[DirectorPoseCoco18Joint, readonly string[]]>
    ).forEach(([joint, aliases]) => {
      const bone = aliases.map((alias) => index.get(canonicalizeHumanoidBoneName(alias))).find(Boolean);
      if (bone) joints[joint] = bone.getWorldPosition(new Vector3());
    });
    if (!Object.keys(joints).length) return;
    const objectId = root.userData?.[DIRECTOR_OBJECT_ID_KEY];
    figures.push({ objectId: typeof objectId === "string" && objectId.trim() ? objectId : null, joints });
  });
  return figures;
}

/**
 * Projects one world-space joint into top-to-bottom pixel coordinates. Returns
 * null for joints behind the camera; off-frame joints still return coordinates
 * so limbs that cross the frame edge keep their correct direction when drawn.
 */
export function projectDirectorPoseJoint(
  worldPosition: Vector3,
  camera: DirectorPoseProjectionCamera,
  width: number,
  height: number,
): DirectorPosePixelPoint | null {
  const view = worldPosition.clone().applyMatrix4(camera.matrixWorldInverse);
  if (view.z >= 0) return null;
  const ndc = view.applyMatrix4(camera.projectionMatrix);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
  return { x: (ndc.x + 1) * 0.5 * width, y: (1 - ndc.y) * 0.5 * height };
}

/**
 * Projects every joint of every figure through the camera into pixel coordinates.
 * Off-frame joints still return coordinates so limbs crossing the frame edge
 * keep their correct direction when drawn.
 *
 * @param figures - The world-space pose figures to project.
 * @param camera - The camera whose view and projection matrices define the transform.
 * @param width - Raster width in pixels.
 * @param height - Raster height in pixels.
 * @returns One 2D figure per input figure, with null entries for unresolvable joints.
 */
export function projectDirectorPoseFigures(
  figures: readonly DirectorPoseFigure[],
  camera: DirectorPoseProjectionCamera,
  width: number,
  height: number,
): DirectorPoseFigure2d[] {
  return figures.map((figure) =>
    DIRECTOR_POSE_COCO18_JOINTS.map((joint) => {
      const world = figure.joints[joint];
      return world ? projectDirectorPoseJoint(world, camera, width, height) : null;
    }),
  );
}

/** Stroke width scaled so a 368px OpenPose-reference frame gets ~4px limbs. */
export function getDirectorPoseStrokeWidth(width: number, height: number): number {
  return Math.max(2, Math.round(Math.min(width, height) / 90));
}

/** Minimal 2D surface so drawing stays testable without a real canvas. */
export interface DirectorPoseDrawingContext {
  /** Stroke width in pixels for limb lines and joint dots. */
  lineWidth: number;
  /** Line cap style ("round" for pose drawing). */
  lineCap: string;
  /** Stroke color for limb lines. */
  strokeStyle: string | unknown;
  /** Fill color for joint dots. */
  fillStyle: string | unknown;
  /** Fills a rectangle with the current fillStyle. */
  fillRect(x: number, y: number, width: number, height: number): void;
  /** Starts a new path. */
  beginPath(): void;
  /** Moves the pen to (x, y). */
  moveTo(x: number, y: number): void;
  /** Draws a line to (x, y). */
  lineTo(x: number, y: number): void;
  /** Draws an arc (used for joint dots). */
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  /** Strokes the current path with the current strokeStyle. */
  stroke(): void;
  /** Fills the current path with the current fillStyle. */
  fill(): void;
}

function cssColor([red, green, blue]: readonly [number, number, number]): string {
  return `rgb(${red}, ${green}, ${blue})`;
}

/** Paints the black plate plus OpenPose limbs and joints for every figure. */
export function drawDirectorPoseFigures(
  context: DirectorPoseDrawingContext,
  figures2d: readonly DirectorPoseFigure2d[],
  width: number,
  height: number,
): void {
  const strokeWidth = getDirectorPoseStrokeWidth(width, height);
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);
  context.lineWidth = strokeWidth;
  context.lineCap = "round";

  for (const figure of figures2d) {
    DIRECTOR_POSE_COCO18_LIMBS.forEach(([fromIndex, toIndex], limbIndex) => {
      const from = figure[fromIndex];
      const to = figure[toIndex];
      if (!from || !to) return;
      context.strokeStyle = cssColor(DIRECTOR_POSE_COCO18_COLORS[limbIndex]!);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
    });
    figure.forEach((point, jointIndex) => {
      if (!point) return;
      context.fillStyle = cssColor(DIRECTOR_POSE_COCO18_COLORS[jointIndex]!);
      context.beginPath();
      context.arc(point.x, point.y, strokeWidth, 0, Math.PI * 2);
      context.fill();
    });
  }
}

function createOpaqueBlackRgba(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  return rgba;
}

type PoseCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createPoseCanvasContext(width: number, height: number): PoseCanvasContext {
  if (typeof OffscreenCanvas !== "undefined") {
    const context = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (context) return context;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Browser cannot rasterize the pose render pass.");
  return context;
}

function metadataForPose(width: number, height: number, figureCount: number): DirectorPosePassCaptureMetadata {
  return {
    renderPass: "pose",
    width,
    height,
    pixelFormat: "rgba8",
    bitsPerChannel: 8,
    rowOrder: "top-to-bottom",
    colorSpace: "data",
    encoding: "openpose-coco18-rgb",
    helpersExcluded: true,
    figureCount,
  };
}

/**
 * Captures the OpenPose (COCO-18) skeleton pass: coloured bone lines and joint
 * dots on an opaque black plate, in the same RGBA8 shape as the GPU passes.
 * Scenes without skinned characters yield a plain black frame, never an error.
 */
export function captureDirectorPosePass({
  scene,
  camera,
  width,
  height,
}: DirectorPosePassCaptureInput): DirectorPosePassCaptureResult {
  assertDimension(width, "Render width");
  assertDimension(height, "Render height");

  const figures = collectDirectorPoseFigures(scene);
  if (!figures.length) {
    return { rgba: createOpaqueBlackRgba(width, height), metadata: metadataForPose(width, height, 0) };
  }

  // Camera.updateMatrixWorld also refreshes matrixWorldInverse in three.
  camera.updateMatrixWorld(true);
  const figures2d = projectDirectorPoseFigures(figures, camera, width, height);
  const context = createPoseCanvasContext(width, height);
  drawDirectorPoseFigures(context, figures2d, width, height);
  const image = context.getImageData(0, 0, width, height);
  return { rgba: new Uint8Array(image.data), metadata: metadataForPose(width, height, figures.length) };
}
