import { cloneScene, createStageId } from "@director/stage-protocol";
import { isRecord as isObject } from "@director/protocol/primitives";
import { PROP_CATALOG } from "@director/stage-protocol";
import { parseStageCommandInput, stageCommandOperationNames, type StageCommandOperation } from "./stageCommandSchema";
import stageCommandPresentation from "./stageCommandPresentation.json";
import { STAGE_COMMAND_TOOL_NAMES } from "@director/protocol/agentTools";
import type {
  CameraObject,
  StageItem,
  StageCommandToolName,
  StageObject,
  PrimitiveObject,
  StageScene,
  StageTrack,
  ToolExecution,
  TransformItem,
  Vec3,
} from "@director/stage-protocol";

type JsonObject = Record<string, unknown>;
type RefMap = Map<string, string>;

const stageOperationContract = STAGE_COMMAND_TOOL_NAMES.map(
  (tool) => `${tool}: ${stageCommandOperationNames(tool).join(", ")}`,
).join("; ");
/** Human-readable help string built from the stage operation contract. */
export const STAGE_HELP = stageCommandPresentation.helpTemplate.replace(
  "{{OPERATION_CONTRACT}}",
  stageOperationContract,
);

function ok(scene: StageScene, result: unknown, events?: ToolExecution["events"]): ToolExecution {
  return { scene, success: true, result, events };
}

function fail(scene: StageScene, error: string): ToolExecution {
  return { scene, success: false, error };
}

function nextName(scene: StageScene, kind: StageObject["kind"]): string {
  // Generate a localized label with a sequential count for new objects.
  const count = Object.values(scene.objects).filter((object) => object.kind === kind).length + 1;
  return `${stageCommandPresentation.objectLabels[kind]} ${count}`;
}

function resolveRefs<T extends JsonObject>(operation: T, refs: RefMap): T {
  // Map symbolic refs (e.g. "@1") to the real ids captured from earlier results.
  const idKeys = ["object_id", "camera_id", "track_id", "item_id", "subject_id", "follow_object_id"];
  const resolved: JsonObject = { ...operation };
  const resolve = (value: unknown) => (typeof value === "string" && refs.has(value) ? refs.get(value) : value);
  for (const key of idKeys) if (key in resolved) resolved[key] = resolve(resolved[key]);
  if (Array.isArray(resolved.object_ids)) resolved.object_ids = resolved.object_ids.map(resolve);
  if (typeof resolved.on === "string" && resolved.on !== "ground") resolved.on = resolve(resolved.on);
  return resolved as T;
}

function getObject(scene: StageScene, id: unknown): { id: string; object: StageObject } | null {
  if (typeof id !== "string" || !scene.objects[id]) return null;
  return { id, object: scene.objects[id] };
}

function getTrack(scene: StageScene, id: unknown): StageTrack | null {
  return typeof id === "string" ? (scene.show.tracks.find((track) => track.id === id) ?? null) : null;
}

function addVec3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function itemDuration(item: StageItem): number {
  return item.durationS;
}

function sceneState(scene: StageScene) {
  return {
    record_aspect: scene.recordAspect,
    objects: Object.entries(scene.objects).map(([id, object]) => ({
      id,
      kind: object.kind,
      name: object.name ?? null,
      position: object.position,
      rotation: object.rotation,
      scale: object.scale,
      ...(object.color ? { color: object.color } : {}),
      ...(object.parentId ? { parent_id: object.parentId } : {}),
      ...(object.kind === "prop" ? { prop_key: object.propKey } : {}),
      ...(object.kind === "image" ? { image_reference: true, depth: object.depth } : {}),
      ...(object.kind === "camera"
        ? {
            camera: {
              target_id: object.targetId,
              focal_length_mm: object.focalLengthMm,
              shake: object.shake,
            },
          }
        : {}),
    })),
    show: {
      name: scene.show.name,
      tracks: scene.show.tracks.map((track) => ({
        track_id: track.id,
        object_id: track.characterId,
        object_name: scene.objects[track.characterId]?.name ?? null,
        items: track.items.map((item) => ({
          item_id: item.id,
          kind: item.kind,
          at_s: Math.round(item.startS * 100) / 100,
          duration_s: Math.round(itemDuration(item) * 100) / 100,
          ...("move" in item ? { action: item.move } : {}),
          ...(item.kind === "clip" ? { clip: item.clip } : {}),
        })),
      })),
    },
    prop_categories: [...new Set(PROP_CATALOG.map((prop) => prop.category))],
  };
}

function compactSceneObservation(scene: StageScene) {
  const validation = validateStageScene(scene);
  const cameras = Object.entries(scene.objects)
    .filter(([, object]) => object.kind === "camera")
    .map(([id, object]) => ({
      id,
      name: object.name ?? null,
      position: object.position,
      focal_length_mm: (object as CameraObject).focalLengthMm,
    }));
  return {
    scene_name: scene.show.name,
    record_aspect: scene.recordAspect,
    suggested_camera_id: cameras[0]?.id ?? null,
    cameras,
    objects: Object.entries(scene.objects).map(([id, object]) => ({
      id,
      kind: object.kind,
      name: object.name ?? null,
      ...(object.parentId ? { parent_id: object.parentId } : {}),
    })),
    tracks: scene.show.tracks.map((track) => ({
      track_id: track.id,
      object_id: track.characterId,
      item_count: track.items.length,
      item_kinds: [...new Set(track.items.map((item) => item.kind))],
    })),
    validation,
  };
}

function inspectObject(scene: StageScene, id: string) {
  const found = getObject(scene, id);
  if (!found) return null;
  const { object } = found;
  const details = {
    id,
    kind: object.kind,
    name: object.name ?? null,
    position: object.position,
    rotation: object.rotation,
    scale: object.scale,
    ...(object.color ? { color: object.color } : {}),
    ...(object.parentId ? { parent_id: object.parentId } : {}),
    ...(object.kind === "camera"
      ? {
          target_id: object.targetId,
          focal_length_mm: object.focalLengthMm,
          shake: object.shake,
        }
      : {}),
    ...(object.kind === "humanoid"
      ? {
          animation: object.animation,
          pose: object.pose ?? null,
        }
      : {}),
    ...(object.kind === "prop" ? { prop_key: object.propKey } : {}),
    ...(object.kind === "image"
      ? {
          image_reference: true,
          image_data_length: object.imageDataUrl.length,
          depth: object.depth,
        }
      : {}),
  };
  const children = Object.entries(scene.objects)
    .filter(([, candidate]) => candidate.parentId === id)
    .map(([childId, child]) => ({ id: childId, kind: child.kind, name: child.name ?? null }));
  const parent =
    object.parentId && scene.objects[object.parentId]
      ? {
          id: object.parentId,
          kind: scene.objects[object.parentId].kind,
          name: scene.objects[object.parentId].name ?? null,
        }
      : null;
  const nearby = Object.entries(scene.objects)
    .filter(([candidateId]) => candidateId !== id)
    .map(([candidateId, candidate]) => ({
      id: candidateId,
      kind: candidate.kind,
      name: candidate.name ?? null,
      distance:
        Math.round(
          Math.hypot(
            candidate.position[0] - object.position[0],
            candidate.position[1] - object.position[1],
            candidate.position[2] - object.position[2],
          ) * 1000,
        ) / 1000,
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 5);
  return {
    object: details,
    relationships: { parent, children },
    tracks: scene.show.tracks.filter((track) => track.characterId === id),
    nearby,
  };
}

function critiqueCamera(scene: StageScene, cameraId?: string, subjectId?: string) {
  // Project all scene objects into the camera's frustum and classify
  // whether each is inside, on the edge, or outside the safe frame.
  const resolvedCameraId =
    cameraId ?? Object.entries(scene.objects).find(([, object]) => object.kind === "camera")?.[0];
  const camera = resolvedCameraId ? scene.objects[resolvedCameraId] : undefined;
  if (!resolvedCameraId || !camera || camera.kind !== "camera") {
    return { error: "No valid camera was provided. Use stage_read observe to list camera ids." };
  }
  const target = scene.objects[camera.targetId];
  if (!target) return { error: `Camera ${resolvedCameraId} has no valid aim target.` };
  if (subjectId && !scene.objects[subjectId]) {
    return { error: `No subject with id "${subjectId}" exists. Use stage_read observe to list current ids.` };
  }

  const subtract = (left: Vec3, right: Vec3): Vec3 => [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
  const dot = (left: Vec3, right: Vec3) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  const normalize = (value: Vec3): Vec3 => {
    const length = Math.hypot(...value) || 1;
    return [value[0] / length, value[1] / length, value[2] / length];
  };
  const cross = (left: Vec3, right: Vec3): Vec3 => [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
  const forward = normalize(subtract(target.position, camera.position));
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  const up = normalize(cross(right, forward));
  const aspect = {
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "1:1": 1,
    "4:3": 4 / 3,
    "1.85:1": 1.85,
    "2.39:1": 2.39,
  }[scene.recordAspect];
  const tanHalfHorizontalFov = 36 / (2 * camera.focalLengthMm);
  const tanHalfVerticalFov = tanHalfHorizontalFov / aspect;
  const projectPoint = (point: Vec3) => {
    const offset = subtract(point, camera.position);
    const depth = dot(offset, forward);
    return {
      depth,
      x: depth > 0 ? dot(offset, right) / (depth * tanHalfHorizontalFov) : null,
      y: depth > 0 ? dot(offset, up) / (depth * tanHalfVerticalFov) : null,
    };
  };
  // Every renderable body is projected so occlusion can see potential
  // blockers; the reported object list still narrows to the requested subject.
  const candidates = Object.entries(scene.objects).filter(
    ([, object]) => object.kind !== "camera" && object.kind !== "target" && object.kind !== "group",
  );
  const evaluated = candidates.map(([id, object]) => {
    const dimensions = objectDimensions(object);
    const halfWidth = dimensions[0] / 2;
    const halfDepth = dimensions[2] / 2;
    const corners = ([-halfWidth, halfWidth] as const).flatMap((x) =>
      ([0, dimensions[1]] as const).flatMap((y) =>
        ([-halfDepth, halfDepth] as const).map((z) =>
          projectPoint([object.position[0] + x, object.position[1] + y, object.position[2] + z]),
        ),
      ),
    );
    const visibleCorners = corners.filter((corner) => corner.depth > 0 && corner.x !== null && corner.y !== null);
    const center = projectPoint([object.position[0], object.position[1] + dimensions[1] / 2, object.position[2]]);
    const bounds = visibleCorners.length
      ? {
          min_x: Math.min(...visibleCorners.map((corner) => corner.x as number)),
          max_x: Math.max(...visibleCorners.map((corner) => corner.x as number)),
          min_y: Math.min(...visibleCorners.map((corner) => corner.y as number)),
          max_y: Math.max(...visibleCorners.map((corner) => corner.y as number)),
        }
      : null;
    const nearestDepth = visibleCorners.length
      ? Math.min(...visibleCorners.map((corner) => corner.depth))
      : center.depth;
    const intersectsFrame = Boolean(
      bounds && bounds.max_x >= -1 && bounds.min_x <= 1 && bounds.max_y >= -1 && bounds.min_y <= 1,
    );
    const fullyInsideSafeFrame = Boolean(
      bounds && bounds.min_x >= -0.82 && bounds.max_x <= 0.82 && bounds.min_y >= -0.82 && bounds.max_y <= 0.82,
    );
    const status = !visibleCorners.length
      ? "behind"
      : fullyInsideSafeFrame
        ? "inside"
        : intersectsFrame
          ? "edge"
          : "outside";
    // Fraction of the object's projected rect that lies inside the visible
    // frame: 1 means fully in picture, 0 means entirely out of frame.
    const boundsArea = bounds ? (bounds.max_x - bounds.min_x) * (bounds.max_y - bounds.min_y) : 0;
    const visibleFraction =
      bounds === null
        ? null
        : boundsArea <= 1e-9
          ? (intersectsFrame ? 1 : 0)
          : Math.max(0, Math.min(1, bounds.max_x) - Math.max(-1, bounds.min_x)) *
            Math.max(0, Math.min(1, bounds.max_y) - Math.max(-1, bounds.min_y)) /
            boundsArea;
    return { id, object, center, bounds, nearestDepth, status, visibleFraction };
  });

  // Bounding-rect occlusion: another body blocks this one when its projected
  // rect covers this rect's centre with substantial overlap while sitting
  // nearer to the lens. Rect maths is approximate; treat it as a strong hint.
  const occludersOf = (subject: (typeof evaluated)[number]) => {
    if (!subject.bounds) return [];
    const subjectBounds = subject.bounds;
    const centerX = (subjectBounds.min_x + subjectBounds.max_x) / 2;
    const centerY = (subjectBounds.min_y + subjectBounds.max_y) / 2;
    const subjectArea = Math.max(
      (subjectBounds.max_x - subjectBounds.min_x) * (subjectBounds.max_y - subjectBounds.min_y),
      1e-9,
    );
    return evaluated
      .filter((other) => {
        if (other.id === subject.id || !other.bounds) return false;
        if (other.nearestDepth >= subject.nearestDepth - 0.05) return false;
        const coversCenter =
          other.bounds.min_x <= centerX &&
          other.bounds.max_x >= centerX &&
          other.bounds.min_y <= centerY &&
          other.bounds.max_y >= centerY;
        if (!coversCenter) return false;
        const overlap =
          Math.max(0, Math.min(subjectBounds.max_x, other.bounds.max_x) - Math.max(subjectBounds.min_x, other.bounds.min_x)) *
          Math.max(0, Math.min(subjectBounds.max_y, other.bounds.max_y) - Math.max(subjectBounds.min_y, other.bounds.min_y));
        return overlap / subjectArea >= 0.3;
      })
      .sort((left, right) => left.nearestDepth - right.nearestDepth)
      .slice(0, 6)
      .map((other) => other.id);
  };

  const objects = evaluated
    .filter((entry) => !subjectId || entry.id === subjectId)
    .map((entry) => ({
      id: entry.id,
      kind: entry.object.kind,
      name: entry.object.name ?? null,
      status: entry.status,
      frame:
        entry.center.x === null || entry.center.y === null
          ? null
          : [Math.round(entry.center.x * 1000) / 1000, Math.round(entry.center.y * 1000) / 1000],
      frame_bounds: entry.bounds
        ? {
            min_x: Math.round(entry.bounds.min_x * 1000) / 1000,
            max_x: Math.round(entry.bounds.max_x * 1000) / 1000,
            min_y: Math.round(entry.bounds.min_y * 1000) / 1000,
            max_y: Math.round(entry.bounds.max_y * 1000) / 1000,
          }
        : null,
      depth: Math.round(entry.center.depth * 1000) / 1000,
      visible_fraction: entry.visibleFraction === null ? null : Math.round(entry.visibleFraction * 1000) / 1000,
      occluded_by: occludersOf(entry),
    }));
  const visibleCount = objects.filter((object) => object.status === "inside" || object.status === "edge").length;
  const issues: Array<{ code: string; message: string }> = [];
  const suggestedActions: Array<Record<string, unknown>> = [];
  if (!objects.length)
    issues.push({ code: "no_subjects", message: "No renderable subjects are available for framing." });
  if (objects.length && !visibleCount) {
    issues.push({ code: "subjects_out_of_frame", message: "No evaluated subject is inside the camera frame." });
    suggestedActions.push({ tool: "stage_camera", input: { op: "frame", shot: "wide", object_id: subjectId } });
  } else if (subjectId && objects.some((object) => object.status === "edge")) {
    issues.push({
      code: "subject_clipped",
      message: "The requested subject's full bounding box does not fit inside the camera safe frame.",
    });
    suggestedActions.push({ tool: "stage_camera", input: { op: "frame", shot: "medium", object_id: subjectId } });
  } else if (objects.some((object) => object.status === "edge")) {
    issues.push({
      code: "objects_clipped",
      message: "At least one object's full bounding box is clipped or too close to the frame edge.",
    });
    suggestedActions.push({ tool: "stage_camera", input: { op: "frame", shot: "medium", object_id: subjectId } });
  }
  if (subjectId) {
    const subject = objects.find((object) => object.id === subjectId);
    if (subject?.occluded_by.length) {
      const blockers = subject.occluded_by
        .map((id) => scene.objects[id]?.name ?? id)
        .slice(0, 3)
        .join(", ");
      issues.push({
        code: "subject_occluded",
        message: `${blockers} sits between the camera and the requested subject, blocking its projected frame area.`,
      });
    }
  }
  return {
    camera_id: resolvedCameraId,
    target_id: camera.targetId,
    focal_length_mm: camera.focalLengthMm,
    aspect: scene.recordAspect,
    evaluated_object_count: objects.length,
    visible_object_count: visibleCount,
    objects,
    issues,
    suggested_actions: suggestedActions,
    note: "Frame coordinates are normalized around center [0,0]; approximately [-1,1] is the visible frame. visible_fraction is the share of the projected rect inside the frame; occluded_by lists nearer bodies covering the rect centre (bounding-rect approximation).",
  };
}

function objectDimensions(object: StageObject): Vec3 {
  // Each object kind has a different canonical bounding box.
  // Scale is applied uniformly; abs() prevents negative-scale flips.
  const scale: Vec3 = object.scale.map(Math.abs) as Vec3;
  if (object.kind === "humanoid") return [0.82 * scale[0], 2.44 * scale[1], 0.52 * scale[2]];
  if (object.kind === "image") return [scale[0], 1.5 * scale[1], Math.max(object.depth, 0.02) * scale[2]];
  if (object.kind === "prop") {
    const prop = PROP_CATALOG.find((entry) => entry.key === object.propKey);
    const dimensions = prop?.dimensions ?? [1, 1, 1];
    return [dimensions[0] * scale[0], dimensions[1] * scale[1], dimensions[2] * scale[2]];
  }
  if (object.kind === "torus") return [scale[0], 0.25 * scale[1], scale[2]];
  if (object.kind === "plane") return [scale[0], Math.max(0.02, 0.02 * scale[1]), scale[2]];
  return scale;
}

function objectHeight(object: StageObject): number {
  return objectDimensions(object)[1];
}

function objectBounds(scene: StageScene) {
  // Compute the axis-aligned bounding box of all non-camera, non-target objects.
  const objects = Object.values(scene.objects).filter((object) => object.kind !== "camera" && object.kind !== "target");
  if (!objects.length) return { center: [0, 1, 0] as Vec3, radius: 2 };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const object of objects) {
    const half: Vec3 = [Math.abs(object.scale[0]) * 0.5, objectHeight(object) * 0.5, Math.abs(object.scale[2]) * 0.5];
    const center: Vec3 = [object.position[0], object.position[1] + half[1], object.position[2]];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], center[axis] - half[axis]);
      max[axis] = Math.max(max[axis], center[axis] + half[axis]);
    }
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { center, radius: Math.max(1, Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2])) };
}

/**
 * Validates the scene for rendering readiness, reporting missing cameras,
 * empty timelines, and invalid object scales.
 *
 * @param scene - The stage scene to validate.
 * @returns A readiness report with error/warning issues and summary counts.
 */
export function validateStageScene(scene: StageScene) {
  const renderableObjects = Object.entries(scene.objects).filter(
    ([, object]) => object.kind !== "camera" && object.kind !== "target" && object.kind !== "group",
  );
  const cameras = Object.entries(scene.objects).filter(([, object]) => object.kind === "camera");
  const durationS = scene.show.tracks.reduce(
    (end, track) => Math.max(end, ...track.items.map((item) => item.startS + item.durationS), 0),
    0,
  );
  const issues: Array<{ code: string; severity: "error" | "warning"; message: string }> = [];
  if (!renderableObjects.length) {
    issues.push({ code: "empty_scene", severity: "error", message: "场景中还没有可渲染的白膜对象" });
  }
  if (!cameras.length) {
    issues.push({ code: "missing_camera", severity: "error", message: "场景中还没有可用于渲染的机位" });
  }
  if (!scene.show.tracks.some((track) => track.items.length > 0)) {
    issues.push({ code: "missing_timeline", severity: "warning", message: "时间线还没有动作；视频将使用静态镜头" });
  }
  for (const [id, object] of Object.entries(scene.objects)) {
    if (object.scale.some((value) => !Number.isFinite(value) || Math.abs(value) < 0.0001)) {
      issues.push({ code: "invalid_scale", severity: "error", message: `${object.name ?? id} 的缩放无效` });
    }
    if (object.kind === "camera" && !scene.objects[object.targetId]) {
      issues.push({ code: "missing_camera_target", severity: "error", message: `${object.name ?? id} 缺少镜头目标` });
    }
  }
  return {
    ready: !issues.some((issue) => issue.severity === "error"),
    video_ready: !issues.some((issue) => issue.severity === "error"),
    object_count: renderableObjects.length,
    camera_count: cameras.length,
    duration_s: durationS,
    aspect: scene.recordAspect,
    issues,
  };
}

function executeScene(scene: StageScene, operation: StageCommandOperation): ToolExecution {
  switch (operation.op) {
    case "configure": {
      let changed = false;
      if (operation.name !== undefined) {
        scene.show.name = operation.name.slice(0, 120);
        changed = true;
      }
      if (operation.aspect !== undefined) {
        scene.recordAspect = operation.aspect;
        changed = true;
      }
      return changed
        ? ok(scene, { name: scene.show.name, aspect: scene.recordAspect })
        : fail(scene, "configure needs name or aspect");
    }
    case "reset": {
      const name = operation.name ?? "未命名白膜场景";
      const aspect = operation.aspect ?? scene.recordAspect;
      scene.objects = {};
      scene.show = { name: name.slice(0, 120), tracks: [] };
      scene.recordAspect = aspect;
      if (operation.with_camera === true) addCamera(scene, { op: "add", name: "主机位" });
      return ok(scene, {
        reset: true,
        name: scene.show.name,
        aspect: scene.recordAspect,
        camera_created: operation.with_camera === true,
      });
    }
    case "validate":
      return ok(scene, validateStageScene(scene));
    default:
      return fail(scene, "Unsupported stage_scene operation");
  }
}

function executeRead(scene: StageScene, operation: StageCommandOperation): ToolExecution {
  switch (operation.op) {
    case "scene_state":
      return ok(scene, sceneState(scene));
    case "observe":
      return ok(scene, compactSceneObservation(scene));
    case "inspect": {
      const inspection = inspectObject(scene, operation.object_id);
      return inspection
        ? ok(scene, inspection)
        : fail(
            scene,
            `No object with id "${operation.object_id}" exists in the scene. Use stage_read observe to list current ids.`,
          );
    }
    case "critique": {
      const critique = critiqueCamera(scene, operation.camera_id, operation.subject_id);
      return "error" in critique && typeof critique.error === "string"
        ? fail(scene, critique.error)
        : ok(scene, critique);
    }
    case "help":
      return ok(scene, { help: STAGE_HELP });
    case "search_props": {
      const query = operation.query.trim().toLowerCase();
      const category = operation.category ?? null;
      const limit = operation.limit === undefined ? 20 : Math.max(1, Math.floor(operation.limit));
      const props = PROP_CATALOG.filter(
        (prop) =>
          (!category || prop.category === category) &&
          (!query || `${prop.key} ${prop.label} ${prop.category}`.toLowerCase().includes(query)),
      ).slice(0, limit);
      return ok(scene, { props });
    }
    case "look_at_scene": {
      const camera =
        operation.object_id ?? Object.entries(scene.objects).find(([, object]) => object.kind === "camera")?.[0];
      if (!camera) return fail(scene, "No camera in the scene. Add a camera first.");
      return ok(scene, { camera_id: camera, capture_requested: true }, [{ type: "capture", objectId: camera }]);
    }
    default:
      return fail(scene, "Unsupported stage_read operation");
  }
}

function createObject(scene: StageScene, operation: Extract<StageCommandOperation, { op: "create" }>): ToolExecution {
  // Each object kind has a different factory shape with its own defaults
  // and required fields. Validate the kind-specific requirements first.
  const kind = operation.kind;
  const primitiveKinds = ["cube", "sphere", "cylinder", "cone", "plane", "torus", "pyramid"] as const;
  const isPrimitiveKind = (value: typeof kind): value is PrimitiveObject["kind"] =>
    (primitiveKinds as readonly string[]).includes(value);
  const id = createStageId(kind);
  const position: Vec3 = operation.position ?? [0, 0, 0];
  const rotation: Vec3 = operation.rotation ?? [0, 0, 0];
  const scale: Vec3 = operation.scale ?? [1, 1, 1];

  let object: StageObject;
  if (kind === "humanoid") {
    object = {
      kind,
      name: operation.name ?? nextName(scene, kind),
      position,
      rotation,
      scale,
      color: operation.color ?? "#b9872f",
      animation: { clip: "idle", playing: false },
      ...(operation.pose ? { pose: operation.pose } : {}),
    };
  } else if (kind === "image") {
    const imageDataUrl = operation.image_data_url;
    if (!imageDataUrl) return fail(scene, "image kind requires image_data_url");
    object = {
      kind,
      imageDataUrl,
      depth: operation.depth === undefined ? 0.07 : Math.max(0.02, Math.min(0.4, operation.depth)),
      name: operation.name ?? nextName(scene, kind),
      position,
      rotation,
      scale,
    };
  } else if (kind === "prop") {
    const propKey = operation.prop_key;
    const prop = PROP_CATALOG.find((entry) => entry.key === propKey);
    if (!prop)
      return fail(scene, `unknown prop_key "${String(operation.prop_key)}". Use stage_read search_props first.`);
    object = {
      kind,
      propKey: prop.key,
      name: operation.name ?? prop.label,
      position,
      rotation,
      scale,
      color: operation.color ?? prop.color,
    };
  } else if (isPrimitiveKind(kind)) {
    const primitiveKind = kind;
    object = {
      kind: primitiveKind,
      name: operation.name ?? nextName(scene, primitiveKind),
      position,
      rotation,
      scale,
      color: operation.color ?? "#d7dde6",
    };
  } else {
    return fail(scene, `Unsupported object kind "${kind}"`);
  }
  scene.objects[id] = object;
  return ok(scene, { object_id: id, kind: object.kind, name: object.name, position, scale });
}

function executeObject(scene: StageScene, operation: StageCommandOperation): ToolExecution {
  switch (operation.op) {
    case "create":
      return createObject(scene, operation);
    case "transform": {
      const found = getObject(scene, operation.object_id);
      if (!found) return fail(scene, `No object with id "${String(operation.object_id)}" exists in the scene`);
      let changed = false;
      for (const field of ["position", "rotation", "scale"] as const) {
        if (operation[field] === undefined) continue;
        found.object[field] = operation[field];
        changed = true;
      }
      if (operation.pose !== undefined && found.object.kind === "humanoid") {
        found.object.pose = operation.pose;
        changed = true;
      }
      return changed
        ? ok(scene, { object_id: found.id, position: found.object.position })
        : fail(scene, "transform needs position, rotation, scale, or pose");
    }
    case "translate": {
      const found = getObject(scene, operation.object_id);
      if (!found) return fail(scene, `No object with id "${String(operation.object_id)}" exists in the scene`);
      const delta = operation.delta;
      found.object.position = addVec3(found.object.position, delta);
      return ok(scene, { object_id: found.id, position: found.object.position });
    }
    case "update": {
      const found = getObject(scene, operation.object_id);
      if (!found) return fail(scene, `No object with id "${String(operation.object_id)}" exists in the scene`);
      const name = operation.name;
      const color = operation.color;
      if (name !== undefined) found.object.name = name;
      if (color !== undefined) found.object.color = color;
      return ok(scene, { object_id: found.id, name: found.object.name ?? null, color: found.object.color ?? null });
    }
    case "delete": {
      const ids = operation.object_ids;
      const missing = ids.filter((id) => !scene.objects[id]);
      if (missing.length) return fail(scene, `No object(s) with id: ${missing.join(", ")}`);
      const deleted = new Set<string>();
      for (const id of ids) {
        const object = scene.objects[id];
        deleted.add(id);
        if (object.kind === "camera") deleted.add(object.targetId);
        for (const [childId, child] of Object.entries(scene.objects)) if (child.parentId === id) deleted.add(childId);
      }
      for (const id of deleted) delete scene.objects[id];
      scene.show.tracks = scene.show.tracks.filter((track) => !deleted.has(track.characterId));
      return ok(scene, { deleted_ids: [...deleted] });
    }
    case "group": {
      const ids = operation.object_ids;
      const missing = ids.filter((id) => !scene.objects[id]);
      if (missing.length) return fail(scene, `No object(s) with id: ${missing.join(", ")}`);
      const groupId = createStageId("group");
      const sum = ids.reduce<Vec3>((total, id) => addVec3(total, scene.objects[id].position), [0, 0, 0]);
      const center: Vec3 = [sum[0] / ids.length, sum[1] / ids.length, sum[2] / ids.length];
      scene.objects[groupId] = {
        kind: "group",
        name: nextName(scene, "group"),
        position: center,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      };
      for (const id of ids) scene.objects[id].parentId = groupId;
      return ok(scene, { group_id: groupId, grouped_ids: ids });
    }
    case "place": {
      const found = getObject(scene, operation.object_id);
      if (!found) return fail(scene, `No object with id "${String(operation.object_id)}" exists in the scene`);
      const on = operation.on;
      if (on === "ground") found.object.position = [found.object.position[0], 0, found.object.position[2]];
      else {
        const target = getObject(scene, on);
        if (!target) return fail(scene, `No object with id "${on}" exists in the scene`);
        found.object.position = [
          found.object.position[0],
          target.object.position[1] + objectHeight(target.object),
          found.object.position[2],
        ];
      }
      return ok(scene, { object_id: found.id, position: found.object.position });
    }
    default:
      return fail(scene, "Unsupported stage_object operation");
  }
}

function addCamera(scene: StageScene, operation: Extract<StageCommandOperation, { op: "add" }>): ToolExecution {
  // A camera is always paired with a target object; both are created atomically.
  const targetId = createStageId("target");
  const cameraId = createStageId("camera");
  scene.objects[targetId] = {
    kind: "target",
    name: "目标",
    position: [0, 1.4, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  scene.objects[cameraId] = {
    kind: "camera",
    name: operation.name ?? nextName(scene, "camera"),
    position: [3, 2, 5],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    targetId,
    focalLengthMm: 35,
    shake: "off",
  };
  const trackId = createStageId("track");
  scene.show.tracks.push({ id: trackId, characterId: cameraId, items: [] });
  return ok(scene, { camera_id: cameraId, target_id: targetId, track_id: trackId, name: scene.objects[cameraId].name });
}

function executeCamera(scene: StageScene, operation: StageCommandOperation): ToolExecution {
  switch (operation.op) {
    case "add":
      return addCamera(scene, operation);
    case "set_shot": {
      const found = getObject(scene, operation.object_id);
      if (!found || found.object.kind !== "camera")
        return fail(scene, `Object ${String(operation.object_id)} is not a camera`);
      const camera = found.object;
      let changed = false;
      if (operation.focal_length_mm !== undefined) {
        camera.focalLengthMm = Math.min(200, Math.max(12, operation.focal_length_mm));
        changed = true;
      }
      if (operation.shake !== undefined) {
        camera.shake = operation.shake;
        changed = true;
      }
      return changed
        ? ok(scene, { object_id: found.id, focal_length_mm: camera.focalLengthMm, shake: camera.shake })
        : fail(scene, "set_shot needs focal_length_mm or shake");
    }
    case "set_target": {
      const found = getObject(scene, operation.object_id);
      if (!found || found.object.kind !== "camera")
        return fail(scene, `Object ${String(operation.object_id)} is not a camera`);
      const target = scene.objects[found.object.targetId];
      if (!target) return fail(scene, `Camera ${found.id} has no aim target`);
      target.position = operation.position;
      return ok(scene, { camera_id: found.id, target_id: found.object.targetId, position: target.position });
    }
    case "frame": {
      const cameraId =
        operation.object_id ?? Object.entries(scene.objects).find(([, object]) => object.kind === "camera")?.[0];
      const found = getObject(scene, cameraId);
      if (!found || found.object.kind !== "camera") return fail(scene, "No camera in the scene");
      const shot = operation.shot;
      const { center, radius } = objectBounds(scene);
      const multiplier = shot === "wide" ? 3.4 : shot === "medium" ? 2.2 : 1.35;
      found.object.position = [
        center[0] + radius * multiplier * 0.35,
        center[1] + radius * 0.55,
        center[2] + radius * multiplier,
      ];
      const target = scene.objects[found.object.targetId];
      if (target) target.position = center;
      return ok(scene, { camera_id: found.id, shot, position: found.object.position, target: center }, [
        { type: "focus", objectId: found.id },
      ]);
    }
    default:
      return fail(scene, "Unsupported stage_camera operation");
  }
}

function nextTrackStart(track: StageTrack): number {
  return track.items.reduce((end, item) => Math.max(end, item.startS + item.durationS), 0);
}

function cameraAction(
  operation: Extract<StageCommandOperation, { op: "add_camera_action" | "set_camera_action" }>,
  startS: number,
): StageItem {
  // Map camera action names to the concrete item kinds the timeline expects.
  const action = operation.action;
  const id = createStageId("item");
  const durationS = operation.duration_s === undefined ? 5 : Math.max(0.1, operation.duration_s);
  const isMoveAction = (value: typeof action): value is "orbit" | "dolly" | "truck" | "crane" | "pan" =>
    ["orbit", "dolly", "truck", "crane", "pan"].includes(value);
  if (isMoveAction(action)) {
    return {
      id,
      kind: "cam-move",
      startS,
      durationS,
      move: action,
      subjectId: operation.subject_id ?? null,
      direction: operation.direction === "cw" ? "cw" : "ccw",
      angleDeg: operation.angle_deg === undefined ? (action === "orbit" ? 360 : 0) : operation.angle_deg,
      heightDeltaUnits: operation.height_delta === undefined ? 0 : operation.height_delta,
      distanceScale: operation.distance_scale === undefined ? 1 : operation.distance_scale,
    };
  }
  if (action === "still") return { id, kind: "cam-still", startS, durationS };
  if (action === "follow") return { id, kind: "cam-follow", startS, durationS, objectId: operation.object_id ?? null };
  if (action === "manual" || action === "transform")
    return { id, kind: action === "manual" ? "cam-manual" : "cam-transform", startS, durationS };
  return { id, kind: "cam-still", startS, durationS };
}

function executeShow(scene: StageScene, operation: StageCommandOperation): ToolExecution {
  switch (operation.op) {
    case "add_track": {
      const found = getObject(scene, operation.object_id);
      if (!found) return fail(scene, `No object with id "${String(operation.object_id)}" exists in the scene`);
      const existing = scene.show.tracks.find((track) => track.characterId === found.id);
      if (existing) return ok(scene, { track_id: existing.id, object_id: found.id, existing: true });
      const id = createStageId("track");
      scene.show.tracks.push({ id, characterId: found.id, items: [] });
      return ok(scene, { track_id: id, object_id: found.id });
    }
    case "add_transform_item": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      const id = createStageId("item");
      track.items.push({ id, kind: "transform", startS: nextTrackStart(track), durationS: 5, keys: [] });
      return ok(scene, { item_id: id, track_id: track.id });
    }
    case "add_keyframe": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      const item = track.items.find(
        (entry): entry is TransformItem => entry.id === operation.item_id && entry.kind === "transform",
      );
      if (!item) return fail(scene, `No transform item with id "${String(operation.item_id)}" on track ${track.id}`);
      const timeS = operation.time_s;
      item.keys = [
        ...item.keys.filter((key) => key.tS !== timeS),
        {
          tS: timeS,
          position: operation.position,
          rotation: operation.rotation,
          scale: operation.scale,
        },
      ].sort((a, b) => a.tS - b.tS);
      item.durationS = Math.max(item.durationS, timeS);
      return ok(scene, { item_id: item.id, time_s: timeS });
    }
    case "add_clip": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      const object = scene.objects[track.characterId];
      if (object?.kind !== "humanoid")
        return fail(scene, "Clips are humanoid-only. Use a transform item for this object.");
      const id = createStageId("item");
      const durationS = operation.duration_s === undefined ? 3 : Math.max(0.1, operation.duration_s);
      track.items.push({
        id,
        kind: "clip",
        startS: nextTrackStart(track),
        durationS,
        clip: operation.clip,
        loop: operation.loop,
      });
      return ok(scene, { item_id: id, track_id: track.id, clip: operation.clip });
    }
    case "add_camera_action": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      if (scene.objects[track.characterId]?.kind !== "camera")
        return fail(scene, "Camera actions require a camera track");
      const item = cameraAction(operation, nextTrackStart(track));
      track.items.push(item);
      return ok(scene, { item_id: item.id, track_id: track.id, action: operation.action });
    }
    case "set_camera_action": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      const index = track.items.findIndex((item) => item.id === operation.item_id);
      if (index < 0) return fail(scene, `No item with id "${String(operation.item_id)}" on track ${track.id}`);
      const old = track.items[index];
      const item = cameraAction(operation, old.startS);
      item.id = old.id;
      track.items[index] = item;
      return ok(scene, { item_id: item.id, track_id: track.id, action: operation.action });
    }
    case "add_path": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      if (scene.objects[track.characterId]?.kind !== "humanoid")
        return fail(scene, "Paths are humanoid-only. Use transform keyframes for this object.");
      const speed = operation.speed_units_per_s === undefined ? 1.4 : Math.max(0.1, operation.speed_units_per_s);
      const points = operation.points;
      const distance = points
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1], point[2] - points[index][2]),
          0,
        );
      const id = createStageId("item");
      const gait = (operation.gait as "walk" | "jog" | "sprint" | undefined) ?? "walk";
      track.items.push({
        id,
        kind: "path",
        startS: nextTrackStart(track),
        durationS: Math.max(0.1, distance / speed),
        points,
        speedUnitsPerS: speed,
        gait,
      });
      return ok(scene, { item_id: id, point_count: points.length, gait });
    }
    case "remove_item": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      if (!track.items.some((item) => item.id === operation.item_id))
        return fail(scene, `No item with id "${String(operation.item_id)}" on track ${track.id}`);
      track.items = track.items.filter((item) => item.id !== operation.item_id);
      return ok(scene, { removed_item: operation.item_id, track_id: track.id });
    }
    case "remove_track": {
      const track = getTrack(scene, operation.track_id);
      if (!track) return fail(scene, `No track with id "${String(operation.track_id)}" on the show`);
      scene.show.tracks = scene.show.tracks.filter((entry) => entry.id !== track.id);
      return ok(scene, { removed_track: track.id });
    }
    case "play":
      return ok(scene, { playing: true }, [{ type: "play" }]);
    default:
      return fail(scene, "Unsupported stage_show operation");
  }
}

function executeSingle(scene: StageScene, tool: StageCommandToolName, operation: StageCommandOperation): ToolExecution {
  // Route to the correct sub-engine based on the tool name.
  if (tool === "stage_read") return executeRead(scene, operation);
  if (tool === "stage_scene") return executeScene(scene, operation);
  if (tool === "stage_object") return executeObject(scene, operation);
  if (tool === "stage_camera") return executeCamera(scene, operation);
  return executeShow(scene, operation);
}

const REF_RESULT_KEYS: Partial<Record<StageCommandToolName, Record<string, string>>> = {
  stage_object: { create: "object_id", group: "group_id" },
  stage_camera: { add: "camera_id" },
  stage_show: {
    add_track: "track_id",
    add_transform_item: "item_id",
    add_clip: "item_id",
    add_camera_action: "item_id",
    add_path: "item_id",
  },
};

function captureRef(tool: StageCommandToolName, operation: StageCommandOperation, result: unknown, refs: RefMap) {
  // When an operation declares a ref alias, capture the real id from the
  // result so subsequent operations can resolve it.
  const alias = operation.ref;
  const resultKey = REF_RESULT_KEYS[tool]?.[String(operation.op)];
  if (!alias || !resultKey || !isObject(result) || typeof result[resultKey] !== "string") return;
  refs.set(alias, result[resultKey]);
}

/**
 * Executes one or more stage tool operations against a cloned scene.
 *
 * Parses the tool input (single operation or batch), resolves symbolic refs,
 * executes each operation sequentially, and either returns the batch result
 * or rolls back on failure when the batch flag is set.
 *
 * @param sourceScene - The scene to operate on (cloned before mutation).
 * @param tool - The stage tool to invoke (stage_read, stage_object, etc.).
 * @param input - The raw operation input, either a single operation or { ops: [...] }.
 * @param refs - Optional ref map for cross-operation id resolution.
 * @returns The execution result with the mutated scene, success flag, and optional events.
 */
export function executeStageTool(
  sourceScene: StageScene,
  tool: StageCommandToolName,
  input: unknown,
  refs: RefMap = new Map(),
): ToolExecution {
  const parsedInput = parseStageCommandInput(tool, input);
  if (!parsedInput.success) return fail(cloneScene(sourceScene), parsedInput.error);
  let scene = cloneScene(sourceScene);
  const { operations } = parsedInput;
  const originalRefs = new Map(refs);
  const rollbackRefs = () => {
    refs.clear();
    originalRefs.forEach((value, key) => refs.set(key, value));
  };
  const results: unknown[] = [];
  const events: NonNullable<ToolExecution["events"]> = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = resolveRefs(operations[index], refs);
    const execution = executeSingle(scene, tool, operation);
    scene = execution.scene;
    if (!execution.success) {
      if (parsedInput.batch) {
        rollbackRefs();
        return fail(
          cloneScene(sourceScene),
          `Atomic batch failed at ops[${index}]: ${execution.error ?? "unknown error"}`,
        );
      }
      return execution;
    }
    captureRef(tool, operation, execution.result, refs);
    results.push({
      ...(operation.ref ? { ref: operation.ref } : {}),
      ...(isObject(execution.result) ? execution.result : { value: execution.result }),
    });
    if (execution.events) events.push(...execution.events);
  }
  return parsedInput.batch ? ok(scene, { results }, events) : ok(scene, results[0], events);
}
