import {
  captureReconstructionPlanSchema,
  type CaptureDetectedObject,
  type CaptureKeyView,
  type CapturePlanObject,
  type CaptureReconstructionPlan,
  type CaptureReconstructionReport,
  type CaptureWall,
  type CaptureWallOpening,
} from "../../../packages/protocol/src/captureReconstructionProtocol";

/**
 * Composes the worker's metric report into an editable, walkable stage plan.
 *
 * Everything here is deterministic geometry work: walls are split into
 * passable segments around door and window openings, door leaves become
 * proximity-toggle interactables that swing 90° around their hinge, and every
 * key capture view becomes a stage camera bound to its keyframe artifact so
 * the authoring loop can render-and-compare from the exact capture poses.
 */

export type ComposeCapturePlanOptions = {
  jobId: string;
  planId: string;
  createdAt: string;
  source: { kind: CaptureReconstructionReport["sourceKind"]; fileName: string; sha256: string };
  prompt: string;
  /** Production-job artifact id for each key view id. */
  keyViewArtifactIds: Record<string, string>;
  /** Artifact id of the fused shell mesh, when the worker produced one. */
  meshArtifactId: string | null;
  meshSizeM?: [number, number, number];
};

const WALL_MATERIAL = { metalness: 0, roughness: 0.92, emissiveColor: "#000000", emissiveIntensity: 0, opacity: 1 };
const FLOOR_THICKNESS_M = 0.1;
const DOOR_LEAF_THICKNESS_M = 0.05;
const MIN_SEGMENT_M = 0.05;

const ITEM_LABEL_NAMES: Record<string, string> = {
  table: "桌状物体",
  seat: "座椅状物体",
  storage: "柜状物体",
  bed: "床状物体",
  object: "扫描物体",
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function roundVec3(value: [number, number, number]): [number, number, number] {
  return [round(value[0]), round(value[1]), round(value[2])];
}

type Interval = { from: number; to: number; bottomM: number; topM: number };

/**
 * Splits one wall into solid vertical slabs around its openings. Full-height
 * pieces fill the spans between openings; a door contributes a lintel above
 * its clearance and a window additionally keeps its sill below.
 */
export function segmentWall(wall: CaptureWall): Interval[] {
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  if (length < MIN_SEGMENT_M) return [];
  const openings = [...wall.openings]
    .map((opening) => ({
      ...opening,
      from: clamp(opening.centerM - opening.widthM / 2, 0, length),
      to: clamp(opening.centerM + opening.widthM / 2, 0, length),
      topM: Math.min(opening.bottomM + opening.heightM, wall.heightM),
    }))
    .filter((opening) => opening.to - opening.from >= MIN_SEGMENT_M)
    .sort((left, right) => left.from - right.from);

  const segments: Interval[] = [];
  let cursor = 0;
  for (const opening of openings) {
    const start = Math.max(cursor, opening.from);
    if (start - cursor >= MIN_SEGMENT_M) {
      segments.push({ from: cursor, to: start, bottomM: 0, topM: wall.heightM });
    }
    if (wall.heightM - opening.topM >= MIN_SEGMENT_M) {
      segments.push({ from: opening.from, to: opening.to, bottomM: opening.topM, topM: wall.heightM });
    }
    if (opening.kind === "window" && opening.bottomM >= MIN_SEGMENT_M) {
      segments.push({ from: opening.from, to: opening.to, bottomM: 0, topM: opening.bottomM });
    }
    cursor = Math.max(cursor, opening.to);
  }
  if (length - cursor >= MIN_SEGMENT_M) {
    segments.push({ from: cursor, to: length, bottomM: 0, topM: wall.heightM });
  }
  return segments;
}

function wallFrame(wall: CaptureWall) {
  const dx = wall.end[0] - wall.start[0];
  const dz = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dz);
  const direction: [number, number] = length > 0 ? [dx / length, dz / length] : [1, 0];
  // Three.js Y-up: rotating a box by rotY maps local +X to (cos, 0, -sin).
  const rotationY = Math.atan2(-direction[1], direction[0]);
  const pointAt = (alongM: number): [number, number] => [
    wall.start[0] + direction[0] * alongM,
    wall.start[1] + direction[1] * alongM,
  ];
  return { direction, rotationY, length, pointAt };
}

function planMaterial(baseColor: string, overrides: Partial<typeof WALL_MATERIAL> = {}) {
  return { baseColor, ...WALL_MATERIAL, ...overrides };
}

function wallObjects(wall: CaptureWall, wallIndex: number): CapturePlanObject[] {
  const frame = wallFrame(wall);
  const objects: CapturePlanObject[] = [];
  segmentWall(wall).forEach((segment, segmentIndex) => {
    const mid = frame.pointAt((segment.from + segment.to) / 2);
    objects.push({
      id: `capture-wall-${String(wallIndex + 1).padStart(2, "0")}-${String(segmentIndex + 1).padStart(2, "0")}`,
      enabled: true,
      name: `墙体 ${wallIndex + 1}-${segmentIndex + 1}`,
      role: "wall",
      geometryType: "box",
      transform: {
        position: roundVec3([mid[0], segment.bottomM, mid[1]]),
        rotation: [0, round(frame.rotationY), 0],
        scale: roundVec3([
          Math.max(segment.to - segment.from, MIN_SEGMENT_M),
          Math.max(segment.topM - segment.bottomM, MIN_SEGMENT_M),
          wall.thicknessM,
        ]),
      },
      material: planMaterial(wall.color),
      confidence: 0.75,
      rationale: `从占据栅格提取的墙段（${wall.id}）。`,
    });
  });
  return objects;
}

/** A door leaf that swings 90° around its start-side hinge in Player Mode. */
function doorLeafObject(
  wall: CaptureWall,
  opening: CaptureWallOpening & { kind: "door" },
  doorIndex: number,
): CapturePlanObject {
  const frame = wallFrame(wall);
  const closedCenter = frame.pointAt(opening.centerM);
  const hinge = frame.pointAt(opening.centerM - opening.widthM / 2);
  const openRotationY = frame.rotationY + Math.PI / 2;
  const openDirection: [number, number] = [Math.cos(openRotationY), -Math.sin(openRotationY)];
  const openCenter: [number, number] = [
    hinge[0] + (openDirection[0] * opening.widthM) / 2,
    hinge[1] + (openDirection[1] * opening.widthM) / 2,
  ];
  const scale = roundVec3([opening.widthM, opening.heightM, DOOR_LEAF_THICKNESS_M]);
  const closedTransform = {
    position: roundVec3([closedCenter[0], opening.bottomM, closedCenter[1]]),
    rotation: [0, round(frame.rotationY), 0] as [number, number, number],
    scale,
  };
  return {
    id: `capture-door-${String(doorIndex + 1).padStart(2, "0")}`,
    enabled: true,
    name: `门 ${doorIndex + 1}`,
    role: "door",
    geometryType: "box",
    transform: closedTransform,
    material: planMaterial("#7a5c3e", { roughness: 0.7 }),
    interaction: {
      prompt: "开门 / 关门",
      radiusM: 2,
      closedTransform,
      openTransform: {
        position: roundVec3([openCenter[0], opening.bottomM, openCenter[1]]),
        rotation: [0, round(openRotationY), 0],
        scale,
      },
    },
    confidence: 0.7,
    rationale: `在 ${wall.id} 上检测到宽 ${opening.widthM.toFixed(2)}m 的门洞。`,
  };
}

function windowPaneObject(
  wall: CaptureWall,
  opening: CaptureWallOpening & { kind: "window" },
  windowIndex: number,
): CapturePlanObject {
  const frame = wallFrame(wall);
  const center = frame.pointAt(opening.centerM);
  return {
    id: `capture-window-${String(windowIndex + 1).padStart(2, "0")}`,
    enabled: true,
    name: `窗 ${windowIndex + 1}`,
    role: "window",
    geometryType: "box",
    transform: {
      position: roundVec3([center[0], opening.bottomM, center[1]]),
      rotation: [0, round(frame.rotationY), 0],
      scale: roundVec3([opening.widthM, opening.heightM, 0.04]),
    },
    material: planMaterial("#9fc4d8", { roughness: 0.1, metalness: 0.1, opacity: 0.3 }),
    confidence: 0.6,
    rationale: `在 ${wall.id} 上检测到离地 ${opening.bottomM.toFixed(2)}m 的窗洞。`,
  };
}

function floorObject(report: CaptureReconstructionReport): CapturePlanObject | null {
  if (!report.floor) return null;
  const xs = report.floor.polygon.map((point) => point[0]);
  const zs = report.floor.polygon.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return {
    id: "capture-floor",
    enabled: true,
    name: "地板",
    role: "floor",
    geometryType: "box",
    transform: {
      position: roundVec3([(minX + maxX) / 2, -FLOOR_THICKNESS_M, (minZ + maxZ) / 2]),
      rotation: [0, 0, 0],
      scale: roundVec3([Math.max(maxX - minX, 0.5), FLOOR_THICKNESS_M, Math.max(maxZ - minZ, 0.5)]),
    },
    material: planMaterial("#b8b0a4", { roughness: 0.85 }),
    confidence: 0.8,
    rationale: `重建地面 ${report.metrics.floorAreaM2.toFixed(1)}㎡，顶面对齐 y=0。`,
  };
}

function itemObject(item: CaptureDetectedObject, itemIndex: number): CapturePlanObject {
  const displayName = ITEM_LABEL_NAMES[item.label] ?? item.label;
  return {
    id: `capture-item-${String(itemIndex + 1).padStart(2, "0")}`,
    enabled: true,
    name: `${displayName} ${itemIndex + 1}`,
    role: "item",
    geometryType: "box",
    transform: {
      position: roundVec3(item.position),
      rotation: [0, round((item.rotationYDeg * Math.PI) / 180), 0],
      scale: roundVec3(item.size),
    },
    material: planMaterial(item.color, { roughness: 0.8 }),
    confidence: item.confidence,
    rationale: `占据聚类得到的${displayName}，置信度 ${(item.confidence * 100).toFixed(0)}%。代理块可由 agent 循环替换为更贴合的资产。`,
  };
}

/** Degraded RGB-only captures get an honest editable scaffold, not a claim. */
function scaffoldObjects(): CapturePlanObject[] {
  return [
    {
      id: "capture-floor",
      enabled: true,
      name: "地板（脚手架）",
      role: "floor",
      geometryType: "box",
      transform: {
        position: [0, -FLOOR_THICKNESS_M, 0],
        rotation: [0, 0, 0],
        scale: [8, FLOOR_THICKNESS_M, 6],
      },
      material: planMaterial("#b8b0a4", { roughness: 0.85 }),
      confidence: 0.1,
      rationale: "纯 RGB 输入无法确定性恢复度量布局；此为可编辑脚手架，请依据关键帧证据授权真实布局。",
    },
  ];
}

function cameraEntries(keyViews: CaptureKeyView[], keyViewArtifactIds: Record<string, string>) {
  return keyViews.flatMap((view, index) => {
    const artifactId = keyViewArtifactIds[view.id];
    if (!artifactId) return [];
    return [
      {
        id: `capture-view-camera-${String(index + 1).padStart(2, "0")}`,
        viewId: view.id,
        name: `采集视角 ${index + 1}`,
        position: roundVec3(view.position),
        target: roundVec3(view.target),
        fovYDeg: round(view.fovYDeg),
        width: view.width,
        height: view.height,
        keyframeArtifactId: artifactId,
      },
    ];
  });
}

export function composeCaptureReconstructionPlan(
  report: CaptureReconstructionReport,
  options: ComposeCapturePlanOptions,
): CaptureReconstructionPlan {
  const objects: CapturePlanObject[] = [];
  const floor = floorObject(report);
  if (floor) objects.push(floor);
  report.walls.forEach((wall, wallIndex) => objects.push(...wallObjects(wall, wallIndex)));
  let doorIndex = 0;
  let windowIndex = 0;
  for (const wall of report.walls) {
    for (const opening of wall.openings) {
      if (opening.kind === "door") {
        objects.push(doorLeafObject(wall, { ...opening, kind: "door" }, doorIndex));
        doorIndex += 1;
      } else {
        objects.push(windowPaneObject(wall, { ...opening, kind: "window" }, windowIndex));
        windowIndex += 1;
      }
    }
  }
  report.objects.forEach((item, itemIndex) => objects.push(itemObject(item, itemIndex)));
  if (!objects.length) objects.push(...scaffoldObjects());

  return captureReconstructionPlanSchema.parse({
    version: 1,
    id: options.planId,
    jobId: options.jobId,
    createdAt: options.createdAt,
    status: "draft",
    source: options.source,
    analysis: {
      status: report.status,
      providers: report.providers,
      warnings: report.warnings,
      metrics: report.metrics,
      prompt: options.prompt,
    },
    objects,
    cameras: cameraEntries(report.keyViews, options.keyViewArtifactIds),
    shell:
      report.mesh && options.meshArtifactId
        ? {
            artifactId: options.meshArtifactId,
            fileName: report.mesh.fileName,
            sizeM: options.meshSizeM ?? [1, 1, 1],
          }
        : null,
  });
}
