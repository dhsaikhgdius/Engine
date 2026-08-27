// Scene validator — checks a SceneLayout for correctness and consistency.
//
// Validation never throws and never mutates the layout: every finding is
// returned as a SceneValidationIssue so the pipeline can keep the model's
// work and let the caller decide what is fatal. Severity contract:
// - "error"  = the layout violates a structural invariant (non-positive
//   scale, duplicate ids, impossible room) and assembling it would produce
//   a broken scene.
// - "warning" = the layout is assemblable but suspicious (overlaps, objects
//   outside the room, missing cameras/lights).
// Messages and suggestions are user-facing UI copy in Simplified Chinese,
// the product's source language.

import type { SceneLayout, SceneObject, SceneValidationIssue } from "./types";

/**
 * Validate a scene layout and return issues.
 * Returns an empty array if the layout is valid.
 */
export function validateScene(layout: SceneLayout): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = [];

  checkRoom(layout, issues);
  checkObjects(layout, issues);
  checkOverlaps(layout, issues);
  checkCameras(layout, issues);
  checkLights(layout, issues);

  return issues;
}

/**
 * Validate a single scene object.
 */
export function validateObject(obj: SceneObject, index: number): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = [];

  if (!obj.id || obj.id.trim().length === 0) {
    issues.push({
      level: "error",
      objectId: obj.id,
      message: `物体 #${index} 缺少 id`,
      suggestion: "为每个物体指定唯一的 id",
    });
  }

  if (obj.scale.x <= 0 || obj.scale.y <= 0 || obj.scale.z <= 0) {
    issues.push({
      level: "error",
      objectId: obj.id,
      message: `物体 "${obj.label}" 的缩放值必须大于 0`,
      suggestion: "设置 scale 为 {x:1, y:1, z:1} 或更大的正值",
    });
  }

  // Check for extreme values
  if (Math.abs(obj.position.y) > 100) {
    issues.push({
      level: "warning",
      objectId: obj.id,
      message: `物体 "${obj.label}" 的 Y 位置 ${obj.position.y} 超出正常范围`,
      suggestion: "通常物体在 y=0 到 y=5 之间",
    });
  }

  if (obj.scale.x > 20 || obj.scale.y > 20 || obj.scale.z > 20) {
    issues.push({
      level: "warning",
      objectId: obj.id,
      message: `物体 "${obj.label}" 的缩放值较大 (${obj.scale.x}, ${obj.scale.y}, ${obj.scale.z})`,
      suggestion: "检查是否应该是较小的值",
    });
  }

  return issues;
}

function checkRoom(layout: SceneLayout, issues: SceneValidationIssue[]): void {
  if (layout.room.width <= 0 || layout.room.depth <= 0 || layout.room.height <= 0) {
    issues.push({
      level: "error",
      message: "房间尺寸必须大于 0",
      suggestion: `设置 room 为 { width: 8, depth: 8, height: 3 }`,
    });
    return;
  }

  if (layout.room.width > 1000 || layout.room.depth > 1000 || layout.room.height > 1000) {
    issues.push({
      level: "error",
      message: `房间尺寸过大 (${layout.room.width}×${layout.room.depth}×${layout.room.height})`,
      suggestion: "通常房间在 3-50 米之间",
    });
  }
}

function checkObjects(layout: SceneLayout, issues: SceneValidationIssue[]): void {
  const ids = new Set<string>();
  const parentIds = new Set<string>();

  for (const obj of layout.objects) {
    // Check duplicate ids
    if (ids.has(obj.id)) {
      issues.push({
        level: "error",
        objectId: obj.id,
        message: `重复的物体 id: "${obj.id}"`,
        suggestion: "每个物体需要唯一的 id",
      });
    }
    ids.add(obj.id);

    // Track parent ids
    if (obj.parentId) {
      parentIds.add(obj.parentId);
    }

    // Validate individual object
    const objIssues = validateObject(obj, layout.objects.indexOf(obj));
    issues.push(...objIssues);

    // Check if object is inside the room
    const room = layout.room;
    if (
      obj.position.x < -room.width / 2 ||
      obj.position.x > room.width / 2 ||
      obj.position.z < -room.depth / 2 ||
      obj.position.z > room.depth / 2
    ) {
      issues.push({
        level: "warning",
        objectId: obj.id,
        message: `物体 "${obj.label}" 超出房间范围`,
        suggestion: `位置应在 x:[-${room.width / 2}, ${room.width / 2}], z:[-${room.depth / 2}, ${room.depth / 2}] 范围内`,
      });
    }

    // Check if above floor
    if (obj.position.y < 0) {
      issues.push({
        level: "warning",
        objectId: obj.id,
        message: `物体 "${obj.label}" 在地板下方 (y=${obj.position.y})`,
        suggestion: "将 y 设为 0 或更大值",
      });
    }
  }

  // Check orphaned parent references
  for (const parentId of parentIds) {
    if (!ids.has(parentId)) {
      issues.push({
        level: "warning",
        message: `引用了不存在的父物体 "${parentId}"`,
        suggestion: "移除 parentId 或确保父物体存在",
      });
    }
  }
}

function checkOverlaps(layout: SceneLayout, issues: SceneValidationIssue[]): void {
  const objects = layout.objects;
  // O(n²) axis-aligned footprint check in the XZ plane only: scale is treated
  // as the object's approximate footprint, height is ignored (a lamp above a
  // table is fine), and parent-child pairs are exempt because children are
  // expected to sit inside their parent. Overlap is a warning, not an error —
  // the planner prompt asks for 0.5m spacing, but stacked/intersecting props
  // can be a legitimate artistic choice.
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = objects[i];
      const b = objects[j];
      if (a.parentId === b.id || b.parentId === a.id) continue; // Skip parent-child

      const ax = a.position.x;
      const az = a.position.z;
      const bx = b.position.x;
      const bz = b.position.z;
      const ahw = a.scale.x / 2;
      const adw = a.scale.z / 2;
      const bhw = b.scale.x / 2;
      const bdw = b.scale.z / 2;

      if (
        Math.abs(ax - bx) < ahw + bhw &&
        Math.abs(az - bz) < adw + bdw
      ) {
        issues.push({
          level: "warning",
          objectId: a.id,
          message: `"${a.label}" 与 "${b.label}" 可能重叠`,
          suggestion: `将 "${a.label}" 或 "${b.label}" 移开`,
        });
      }
    }
  }
}

// A scene without cameras is viewable but not directable, hence the warning.
// Camera position is intentionally NOT range-checked: standing outside the
// room looking in is the normal establishing-shot setup.
function checkCameras(layout: SceneLayout, issues: SceneValidationIssue[]): void {
  if (!layout.cameras || layout.cameras.length === 0) {
    issues.push({
      level: "warning",
      message: "场景中没有摄像机",
      suggestion: "添加至少一个摄像机以便查看场景",
    });
    return;
  }

  for (let i = 0; i < layout.cameras.length; i++) {
    const cam = layout.cameras[i];
    // Check if camera is inside the room
    if (
      cam.position.x < -layout.room.width / 2 ||
      cam.position.x > layout.room.width / 2 ||
      cam.position.z < -layout.room.depth / 2 ||
      cam.position.z > layout.room.depth / 2
    ) {
      // Camera outside the room is normal (looking in)
    }
  }
}

function checkLights(layout: SceneLayout, issues: SceneValidationIssue[]): void {
  if (!layout.lights || layout.lights.length === 0) {
    issues.push({
      level: "warning",
      message: "场景中没有灯光",
      suggestion: "添加至少一个环境光以便看到场景",
    });
  }
}