// Stage integration — converts an AssemblyPlan into Director workbench operations.
// Maps the pipeline's generic StageOperations to the concrete Director workbench
// authoring actions (add_object, add_light, add_camera).

import type { AssemblyPlan, StageOperation, SceneObject, CameraPlacement, LightConfig } from "./types";

/**
 * A Director workbench authoring action.
 * This is a simplified subset of the full directorAuthoringActionSchema,
 * covering only the operations the scene pipeline emits.
 */
export interface DirectorAuthoringAction {
  action: string;
  [key: string]: unknown;
}

/**
 * A Director workbench operation that wraps a batch of authoring actions.
 * Matches the `{ op: "author", actions: [...] }` format.
 */
export interface DirectorWorkbenchAuthorOperation {
  op: "author";
  actions: DirectorAuthoringAction[];
}

/**
 * Result of executing a single workbench operation.
 */
export interface WorkbenchExecutionResult {
  success: boolean;
  action: DirectorAuthoringAction;
  result?: unknown;
  error?: string;
}

/**
 * Result of executing a full scene plan.
 */
export interface ScenePlanExecutionResult {
  results: WorkbenchExecutionResult[];
  successCount: number;
  failureCount: number;
  totalMs: number;
}

/**
 * Convert a Vec3 {x, y, z} to the tuple format [x, y, z] used by Director.
 */
function vec3ToTuple(v: { x: number; y: number; z: number }): [number, number, number] {
  return [round3f(v.x), round3f(v.y), round3f(v.z)];
}

// Millimetre precision is plenty for blocking; rounding keeps LLM-derived
// float noise out of persisted scenes and produces stable diffs.
function round3f(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Map a SceneObjectKind to the Director object kind.
 * Director supports: "character", "scene", "prop", "panorama".
 *
 * Architectural kinds collapse into "scene" (set geometry), everything else
 * into "prop"; the pipeline's finer-grained kinds only exist to inform
 * geometry choice and assembly ordering, not the Director object model.
 */
function mapObjectKind(kind: SceneObject["kind"]): string {
  switch (kind) {
    case "floor":
    case "wall":
    case "ceiling":
    case "door":
    case "window":
      return "scene";
    case "furniture":
    case "prop":
    case "custom":
      return "prop";
    case "character":
      return "character";
    case "light":
    case "camera":
      return "prop";
    default:
      return "prop";
  }
}

/**
 * Map a SceneObjectKind to the best geometry primitive.
 * Director supports: box, sphere, cylinder, torus, cone, pyramid.
 *
 * White-box intent: everything defaults to a box silhouette scaled by the
 * layout's metric dimensions — readable massing for blocking, not final
 * geometry. Real assets replace these via the catalog / Blender / generated-3D
 * promotion paths.
 */
function mapGeometry(kind: SceneObject["kind"]): string {
  switch (kind) {
    case "floor":
    case "wall":
    case "ceiling":
    case "door":
    case "window":
    case "furniture":
      return "box";
    case "light":
      return "cylinder";
    case "character":
      return "box";
    default:
      return "box";
  }
}

/**
 * Convert a StageOperation to a Director authoring action.
 *
 * Returns null for operations with no workbench equivalent (setRoom: the
 * room is implied by the floor/wall objects rather than a standalone call);
 * callers must skip nulls instead of treating them as failures. `force: true`
 * on destructive actions because the pipeline owns the objects it created and
 * should not be blocked by interactive confirmation policies.
 */
function stageOperationToAuthoringAction(op: StageOperation): DirectorAuthoringAction | null {
  switch (op.op) {
    case "addObject":
      return objectToAuthoringAction(op.object);
    case "addCamera":
      return cameraToAuthoringAction(op.camera);
    case "addLight":
      return lightToAuthoringAction(op.light);
    case "setAmbientLight":
      return ambientLightToAuthoringAction(op.color, op.intensity);
    case "setRoom":
      // Room dimensions are applied as a floor plane; skip if no object
      return null;
    case "removeObject":
      return {
        action: "delete_objects",
        object_ids: [op.objectId],
        force: true,
      };
    case "updateObject":
      return {
        action: "update_object",
        object_id: op.objectId,
        patch: {
          ...(op.changes.position ? { position: vec3ToTuple(op.changes.position) } : {}),
          ...(op.changes.rotation ? { rotation: vec3ToTuple(op.changes.rotation) } : {}),
          ...(op.changes.scale ? { scale: vec3ToTuple(op.changes.scale) } : {}),
          ...(op.changes.color ? { color: op.changes.color } : {}),
        },
        force: true,
      };
    default:
      return null;
  }
}

function objectToAuthoringAction(obj: SceneObject): DirectorAuthoringAction {
  const action: DirectorAuthoringAction = {
    action: "add_object",
    id: obj.id,
    name: obj.label,
    kind: mapObjectKind(obj.kind),
    geometry_type: mapGeometry(obj.kind),
    transform: {
      position: vec3ToTuple(obj.position),
      rotation: vec3ToTuple(obj.rotation),
      scale: vec3ToTuple(obj.scale),
    },
  };

  if (obj.color) {
    action.color = obj.color;
  }
  if (obj.parentId) {
    action.parent_id = obj.parentId;
  }

  return action;
}

function cameraToAuthoringAction(cam: CameraPlacement): DirectorAuthoringAction {
  const action: DirectorAuthoringAction = {
    action: "add_camera",
    id: cam.label ?? "camera",
    name: cam.label ?? "摄像机",
    position: vec3ToTuple(cam.position),
    target: vec3ToTuple(cam.target),
  };

  if (cam.focalLengthMm) {
    action.focal_length_mm = cam.focalLengthMm;
  }

  return action;
}

function lightToAuthoringAction(light: LightConfig): DirectorAuthoringAction {
  const id = `light-${light.type}-${Date.now()}`;
  const action: DirectorAuthoringAction = {
    action: "add_light",
    light: {
      id,
      name: `${light.type}-light`,
      type: light.type,
      visible: true,
      locked: false,
      color: light.color ?? "#ffffff",
      intensity: light.intensity ?? 1.0,
      ...(light.position ? { position: vec3ToTuple(light.position) } : {}),
      ...(light.direction ? { target: vec3ToTuple(light.direction) } : {}),
    },
  };

  return action;
}

function ambientLightToAuthoringAction(color: string, intensity: number): DirectorAuthoringAction {
  return {
    action: "add_light",
    light: {
      id: `ambient-light-${Date.now()}`,
      name: "ambient",
      type: "ambient",
      visible: true,
      locked: false,
      color,
      intensity,
    },
  };
}

/**
 * Convert an AssemblyPlan into Director workbench author operations.
 * Each operation becomes a batch of authoring actions.
 *
 * Objects are batched together (up to 128 per author call, matching the
 * Director workbench limit) for efficiency. Cameras and lights are
 * kept in separate author calls for clarity.
 *
 * @returns Array of { op: "author", actions: [...] } operations
 */
export function applySceneToStage(plan: AssemblyPlan): DirectorWorkbenchAuthorOperation[] {
  const operations: DirectorWorkbenchAuthorOperation[] = [];
  const objectActions: DirectorAuthoringAction[] = [];
  const cameraActions: DirectorAuthoringAction[] = [];
  const lightActions: DirectorAuthoringAction[] = [];

  for (const op of plan.operations) {
    const action = stageOperationToAuthoringAction(op);
    if (!action) continue;

    if (action.action === "add_object" || action.action === "update_object" || action.action === "delete_objects") {
      objectActions.push(action);
    } else if (action.action === "add_camera") {
      cameraActions.push(action);
    } else if (action.action === "add_light") {
      lightActions.push(action);
    }
  }

  // Batch objects in chunks of 128 (Director workbench limit)
  const BATCH_SIZE = 128;
  for (let i = 0; i < objectActions.length; i += BATCH_SIZE) {
    operations.push({
      op: "author",
      actions: objectActions.slice(i, i + BATCH_SIZE),
    });
  }

  // Cameras and lights in separate batches
  if (cameraActions.length > 0) {
    operations.push({ op: "author", actions: cameraActions });
  }
  if (lightActions.length > 0) {
    operations.push({ op: "author", actions: lightActions });
  }

  return operations;
}

/**
 * Execute a scene plan against a workbench executor function.
 *
 * Failure granularity is the batch: when the executor throws, every action in
 * that batch is recorded as failed with the same error, but execution
 * continues with the remaining batches. Partial scenes are intentionally
 * possible — the per-action results let the caller report or retry exactly
 * what is missing instead of rolling everything back.
 *
 * @param plan - The assembly plan to execute
 * @param executor - Function that takes a workbench operation and returns a result
 * @returns Execution results with success/failure counts
 */
export async function executeScenePlan(
  plan: AssemblyPlan,
  executor: (operation: DirectorWorkbenchAuthorOperation) => Promise<unknown>,
): Promise<ScenePlanExecutionResult> {
  const startTime = Date.now();
  const operations = applySceneToStage(plan);
  const results: WorkbenchExecutionResult[] = [];

  for (const operation of operations) {
    try {
      const result = await executor(operation);
      for (const action of operation.actions) {
        results.push({
          success: true,
          action,
          result,
        });
      }
    } catch (error) {
      for (const action of operation.actions) {
        results.push({
          success: false,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  return {
    results,
    successCount,
    failureCount,
    totalMs: Date.now() - startTime,
  };
}

/**
 * Generate a human-readable summary of the workbench operations.
 */
export function summarizeWorkbenchOperations(operations: DirectorWorkbenchAuthorOperation[]): string {
  const counts: Record<string, number> = {};
  for (const op of operations) {
    for (const action of op.actions) {
      counts[action.action] = (counts[action.action] ?? 0) + 1;
    }
  }

  const labelMap: Record<string, string> = {
    add_object: "创建物体",
    add_camera: "创建摄像机",
    add_light: "创建灯光",
    update_object: "更新物体",
    delete_objects: "删除物体",
  };

  return Object.entries(counts)
    .map(([action, count]) => `${labelMap[action] ?? action}: ${count}`)
    .join("，");
}