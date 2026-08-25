import { describe, expect, it } from "vitest";
import {
  Bone,
  BufferGeometry,
  Group,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from "three";
import {
  DIRECTOR_MIXAMO_COCO18_BONE_ALIASES,
  DIRECTOR_POSE_COCO18_COLORS,
  DIRECTOR_POSE_COCO18_JOINTS,
  DIRECTOR_POSE_COCO18_LIMBS,
  captureDirectorPosePass,
  collectDirectorPoseFigures,
  drawDirectorPoseFigures,
  getDirectorPoseStrokeWidth,
  projectDirectorPoseFigures,
  projectDirectorPoseJoint,
  type DirectorPoseDrawingContext,
  type DirectorPoseFigure2d,
} from "../../../../src/comprehensive/editor/render/posePassCapture";

const MIXAMO_BONE_POSITIONS: Record<string, [number, number, number]> = {
  Hips: [0, 1, 0],
  Spine: [0, 1.2, 0],
  Neck: [0, 1.5, 0],
  Head: [0, 1.7, 0],
  LeftArm: [0.2, 1.45, 0],
  LeftForeArm: [0.45, 1.2, 0],
  LeftHand: [0.65, 1, 0],
  RightArm: [-0.2, 1.45, 0],
  RightForeArm: [-0.45, 1.2, 0],
  RightHand: [-0.65, 1, 0],
  LeftUpLeg: [0.1, 0.9, 0],
  LeftLeg: [0.1, 0.5, 0],
  LeftFoot: [0.1, 0.05, 0],
  RightUpLeg: [-0.1, 0.9, 0],
  RightLeg: [-0.1, 0.5, 0],
  RightFoot: [-0.1, 0.05, 0],
};

function createMixamoCharacter(
  objectId: string,
  { namePrefix = "mixamorig:", omitBones = [] as string[] } = {},
): Group {
  const root = new Group();
  root.userData.directorObjectKind = "character";
  root.userData.directorObjectId = objectId;

  const bones = Object.entries(MIXAMO_BONE_POSITIONS)
    .filter(([name]) => !omitBones.includes(name))
    .map(([name, position]) => {
      const bone = new Bone();
      bone.name = `${namePrefix}${name}`;
      bone.position.fromArray(position);
      return bone;
    });
  bones.forEach((bone) => root.add(bone));
  root.updateMatrixWorld(true);

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.bind(new Skeleton(bones));
  root.add(mesh);
  return root;
}

function createLookDownZCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe("collectDirectorPoseFigures", () => {
  it("maps namespaced Mixamo bones onto COCO-18 joints in world space", () => {
    const scene = new Scene();
    const character = createMixamoCharacter("char-1");
    character.position.set(2, 0, -3);
    scene.add(character);
    scene.updateMatrixWorld(true);

    const figures = collectDirectorPoseFigures(scene);
    expect(figures).toHaveLength(1);
    const figure = figures[0]!;
    expect(figure.objectId).toBe("char-1");
    expect(figure.joints.neck).toEqual(new Vector3(2, 1.5, -3));
    expect(figure.joints.nose).toEqual(new Vector3(2, 1.7, -3));
    expect(figure.joints["left-shoulder"]).toEqual(new Vector3(2.2, 1.45, -3));
    expect(figure.joints["right-ankle"]).toEqual(new Vector3(1.9, 0.05, -3));
    expect(figure.joints["left-eye"]).toBeUndefined();
    expect(figure.joints["right-ear"]).toBeUndefined();
  });

  it("resolves bones regardless of the mixamorig namespace spelling", () => {
    const scene = new Scene();
    scene.add(createMixamoCharacter("char-plain", { namePrefix: "" }));
    scene.add(createMixamoCharacter("char-underscore", { namePrefix: "mixamorig1_" }));
    scene.updateMatrixWorld(true);

    const figures = collectDirectorPoseFigures(scene);
    expect(figures).toHaveLength(2);
    for (const figure of figures) {
      expect(figure.joints.neck).toBeDefined();
      expect(figure.joints["left-wrist"]).toBeDefined();
    }
  });

  it("skips joints whose bones are missing instead of failing", () => {
    const scene = new Scene();
    scene.add(createMixamoCharacter("char-armless", { omitBones: ["LeftForeArm", "LeftHand"] }));
    scene.updateMatrixWorld(true);

    const figure = collectDirectorPoseFigures(scene)[0]!;
    expect(figure.joints["left-elbow"]).toBeUndefined();
    expect(figure.joints["left-wrist"]).toBeUndefined();
    expect(figure.joints["left-shoulder"]).toBeDefined();
    expect(figure.joints["right-wrist"]).toBeDefined();
  });

  it("ignores hidden characters and non-character skinned meshes", () => {
    const scene = new Scene();
    const hidden = createMixamoCharacter("char-hidden");
    hidden.visible = false;
    scene.add(hidden);

    const untagged = createMixamoCharacter("char-untagged");
    delete untagged.userData.directorObjectKind;
    scene.add(untagged);
    scene.updateMatrixWorld(true);

    expect(collectDirectorPoseFigures(scene)).toHaveLength(0);
  });
});

describe("projectDirectorPoseJoint", () => {
  it("projects world positions to top-to-bottom pixel coordinates", () => {
    const camera = createLookDownZCamera();

    const center = projectDirectorPoseJoint(new Vector3(0, 0, -10), camera, 100, 100);
    expect(center?.x).toBeCloseTo(50, 5);
    expect(center?.y).toBeCloseTo(50, 5);

    // fov 90 with aspect 1: x = z-distance lands exactly on the right frame edge.
    const rightEdge = projectDirectorPoseJoint(new Vector3(10, 0, -10), camera, 100, 100);
    expect(rightEdge?.x).toBeCloseTo(100, 5);
    expect(rightEdge?.y).toBeCloseTo(50, 5);

    // +y in world space is up, which is pixel row 0.
    const topEdge = projectDirectorPoseJoint(new Vector3(0, 10, -10), camera, 200, 100);
    expect(topEdge?.x).toBeCloseTo(100, 5);
    expect(topEdge?.y).toBeCloseTo(0, 5);
  });

  it("returns null for joints behind the camera", () => {
    const camera = createLookDownZCamera();
    expect(projectDirectorPoseJoint(new Vector3(0, 0, 10), camera, 100, 100)).toBeNull();
  });

  it("projects whole figures with nulls for unmapped joints", () => {
    const camera = createLookDownZCamera();
    const figures2d = projectDirectorPoseFigures(
      [{ objectId: "char-1", joints: { neck: new Vector3(0, 0, -10) } }],
      camera,
      100,
      100,
    );
    expect(figures2d).toHaveLength(1);
    expect(figures2d[0]).toHaveLength(DIRECTOR_POSE_COCO18_JOINTS.length);
    expect(figures2d[0]![DIRECTOR_POSE_COCO18_JOINTS.indexOf("neck")]).toEqual({ x: 50, y: 50 });
    expect(figures2d[0]![DIRECTOR_POSE_COCO18_JOINTS.indexOf("nose")]).toBeNull();
  });
});

describe("captureDirectorPosePass", () => {
  it("returns an opaque black frame with normal metadata when no character exists", () => {
    const scene = new Scene();
    const result = captureDirectorPosePass({ scene, camera: createLookDownZCamera(), width: 8, height: 4 });

    expect(result.rgba).toHaveLength(8 * 4 * 4);
    for (let offset = 0; offset < result.rgba.length; offset += 4) {
      expect(result.rgba[offset]).toBe(0);
      expect(result.rgba[offset + 1]).toBe(0);
      expect(result.rgba[offset + 2]).toBe(0);
      expect(result.rgba[offset + 3]).toBe(255);
    }
    expect(result.metadata).toEqual({
      renderPass: "pose",
      width: 8,
      height: 4,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "data",
      encoding: "openpose-coco18-rgb",
      helpersExcluded: true,
      figureCount: 0,
    });
  });

  it("rejects invalid raster dimensions", () => {
    const scene = new Scene();
    const camera = createLookDownZCamera();
    expect(() => captureDirectorPosePass({ scene, camera, width: 0, height: 4 })).toThrow("Render width");
  });
});

describe("OpenPose COCO-18 tables", () => {
  it("keeps the canonical joint order, colour wheel, and limb pairs stable", () => {
    expect(DIRECTOR_POSE_COCO18_JOINTS).toEqual([
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
    ]);
    expect(DIRECTOR_POSE_COCO18_COLORS).toEqual([
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
    ]);
    expect(DIRECTOR_POSE_COCO18_LIMBS).toEqual([
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
    ]);
    // Every limb endpoint must be a valid joint index.
    for (const [from, to] of DIRECTOR_POSE_COCO18_LIMBS) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThan(DIRECTOR_POSE_COCO18_JOINTS.length);
    }
    // Eyes and ears are intentionally unmapped on Mixamo rigs.
    expect(Object.keys(DIRECTOR_MIXAMO_COCO18_BONE_ALIASES)).toHaveLength(14);
  });
});

describe("drawDirectorPoseFigures", () => {
  function createRecordingContext() {
    const operations: string[] = [];
    const context: DirectorPoseDrawingContext = {
      lineWidth: 0,
      lineCap: "",
      strokeStyle: "",
      fillStyle: "",
      fillRect: (x, y, width, height) => operations.push(`fillRect(${x},${y},${width},${height}) ${context.fillStyle}`),
      beginPath: () => {},
      moveTo: (x, y) => operations.push(`moveTo(${x},${y})`),
      lineTo: (x, y) => operations.push(`lineTo(${x},${y})`),
      arc: (x, y, radius) => operations.push(`arc(${x},${y},${radius})`),
      stroke: () => operations.push(`stroke ${context.strokeStyle}`),
      fill: () => operations.push(`fill ${context.fillStyle}`),
    };
    return { context, operations };
  }

  it("paints the black plate, then OpenPose-coloured limbs and joints", () => {
    const { context, operations } = createRecordingContext();
    const figure: DirectorPoseFigure2d = DIRECTOR_POSE_COCO18_JOINTS.map(() => null);
    figure[1] = { x: 10, y: 10 }; // neck
    figure[2] = { x: 20, y: 30 }; // right shoulder

    drawDirectorPoseFigures(context, [figure], 100, 100);

    // Limb 0 is [neck, right-shoulder] and uses colour 0; joints use colours 1 and 2.
    expect(operations).toEqual([
      "fillRect(0,0,100,100) #000000",
      "moveTo(10,10)",
      "lineTo(20,30)",
      "stroke rgb(255, 0, 0)",
      "arc(10,10,2)",
      "fill rgb(255, 85, 0)",
      "arc(20,30,2)",
      "fill rgb(255, 170, 0)",
    ]);
    expect(context.lineWidth).toBe(getDirectorPoseStrokeWidth(100, 100));
    expect(context.lineCap).toBe("round");
  });

  it("scales stroke width with resolution", () => {
    expect(getDirectorPoseStrokeWidth(100, 100)).toBe(2);
    expect(getDirectorPoseStrokeWidth(368, 368)).toBe(4);
    expect(getDirectorPoseStrokeWidth(1920, 1080)).toBe(12);
  });
});
