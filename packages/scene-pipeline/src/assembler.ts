// Scene assembler — converts a SceneLayout into an ordered sequence
// of Stage operations that a Director agent can execute.

import type { SceneLayout, AssemblyPlan, StageOperation, Vec3 } from "./types";

/**
 * Convert a scene layout into an assembly plan.
 * Operations are ordered for correct construction:
 * 1. Room dimensions first
 * 2. Structural elements (floor, walls, ceiling)
 * 3. Furniture and props
 * 4. Lighting
 * 5. Cameras last
 */
export function assembleScene(layout: SceneLayout): AssemblyPlan {
  const operations: StageOperation[] = [];

  // 1. Set room dimensions
  operations.push({
    op: "setRoom",
    width: layout.room.width,
    depth: layout.room.depth,
    height: layout.room.height,
  });

  // 2. Sort objects by dependency order
  const sorted = sortObjectsByDependency(layout.objects);

  // 3. Add objects
  for (const obj of sorted) {
    operations.push({
      op: "addObject",
      object: obj,
    });
  }

  // 4. Add lights
  if (layout.lights) {
    for (const light of layout.lights) {
      if (light.type === "ambient") {
        operations.push({
          op: "setAmbientLight",
          color: light.color ?? "#ffffff",
          intensity: light.intensity ?? 0.5,
        });
      } else {
        operations.push({ op: "addLight", light });
      }
    }
  }

  // 5. Add cameras
  if (layout.cameras) {
    for (const camera of layout.cameras) {
      operations.push({ op: "addCamera", camera });
    }
  }

  return {
    operations,
    estimatedCost: estimateCost(operations),
  };
}

/**
 * Sort objects by dependency: children after parents, structural before decorative.
 */
function sortObjectsByDependency(objects: SceneLayout["objects"]): SceneLayout["objects"] {
  const structural = objects.filter((o) =>
    ["floor", "wall", "ceiling", "door", "window"].includes(o.kind),
  );
  const furniture = objects.filter((o) => o.kind === "furniture");
  const lights = objects.filter((o) => o.kind === "light");
  const props = objects.filter((o) => o.kind === "prop");
  const other = objects.filter(
    (o) => !["floor", "wall", "ceiling", "door", "window", "furniture", "light", "prop"].includes(o.kind),
  );

  const withParent = (list: SceneLayout["objects"]) => {
    const result: SceneLayout["objects"] = [];
    const remaining = [...list];
    const placed = new Set<string>();

    // Keep trying until all are placed or no progress
    let progress = true;
    while (remaining.length > 0 && progress) {
      progress = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const obj = remaining[i];
        if (!obj.parentId || placed.has(obj.parentId)) {
          result.push(obj);
          placed.add(obj.id);
          remaining.splice(i, 1);
          progress = true;
        }
      }
    }
    // Any remaining (orphaned) go at the end
    result.push(...remaining);
    return result;
  };

  return [...structural, ...withParent(furniture), ...withParent(lights), ...withParent(props), ...withParent(other)];
}

/**
 * Estimate the cost of an assembly plan (for logging).
 * Rough estimate: 1 cost unit per 10 operations.
 */
function estimateCost(operations: StageOperation[]): number {
  return Math.ceil(operations.length / 10);
}

/**
 * Generate a human-readable summary of the assembly plan.
 */
export function summarizePlan(plan: AssemblyPlan): string {
  const counts: Record<string, number> = {};
  for (const op of plan.operations) {
    counts[op.op] = (counts[op.op] ?? 0) + 1;
  }

  const parts: string[] = [];
  const labelMap: Record<string, string> = {
    setRoom: "设置房间",
    addObject: "添加物体",
    removeObject: "移除物体",
    updateObject: "更新物体",
    addCamera: "添加摄像机",
    addLight: "添加灯光",
    setAmbientLight: "设置环境光",
  };

  for (const [op, count] of Object.entries(counts)) {
    parts.push(`${labelMap[op] ?? op}: ${count}`);
  }

  return parts.join("，");
}

/**
 * Calculate the bounding box of all objects in the layout.
 */
export function computeBounds(layout: SceneLayout): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const obj of layout.objects) {
    const halfScale = { x: obj.scale.x / 2, y: obj.scale.y / 2, z: obj.scale.z / 2 };
    min.x = Math.min(min.x, obj.position.x - halfScale.x);
    min.y = Math.min(min.y, obj.position.y - halfScale.y);
    min.z = Math.min(min.z, obj.position.z - halfScale.z);
    max.x = Math.max(max.x, obj.position.x + halfScale.x);
    max.y = Math.max(max.y, obj.position.y + halfScale.y);
    max.z = Math.max(max.z, obj.position.z + halfScale.z);
  }

  return { min, max };
}