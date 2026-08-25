/**
 * Procedural low-poly ambient vehicle: one merged BufferGeometry shared by
 * every instance (body box + cabin box + 4 wheel cylinders), following the
 * wildlife placeholder-model pattern. Non-indexed triangle soup with
 * computeVertexNormals gives faceted shading that reads well at ambient
 * distances. Builder is pure: identical calls produce identical buffers.
 *
 * Conventions: forward +Z, up +Y, origin at the ground point under the car
 * center. Footprint ≈ 1.75 m wide × 4.4 m long.
 */

import { BufferAttribute, BufferGeometry } from "three";

/** Vehicle footprint width in metres (body plus wheel clearance). */
export const VEHICLE_WIDTH_M = 1.75;

/** Vehicle footprint length in metres (bumper to bumper). */
export const VEHICLE_LENGTH_M = 4.4;

/** Fixed 8-entry palette; trafficFlow hashes each vehicle to an index. */
export const VEHICLE_COLOR_PALETTE: readonly number[] = [
  0xdfe2e6, // white
  0x2a2d33, // near black
  0x9aa0a8, // silver
  0xa8322c, // red
  0x2f5da8, // blue
  0x31614b, // green
  0xd9a13b, // amber
  0x54427a, // violet
];

const WHEEL_RADIUS_M = 0.32;
const WHEEL_WIDTH_M = 0.24;
const WHEEL_SEGMENTS = 8;
const WHEEL_CENTER_X = VEHICLE_WIDTH_M / 2 - 0.14;
const WHEEL_CENTER_Z = 1.35;

const BODY_WIDTH_M = 1.7;
const BODY_BOTTOM_Y = 0.28;
const BODY_TOP_Y = 0.82;

const CABIN_WIDTH_M = 1.5;
const CABIN_TOP_Y = 1.34;
const CABIN_LENGTH_M = 1.9;
const CABIN_CENTER_Z = -0.25;

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

/** Axis-aligned box (12 triangles) centered at (cx, cy, cz), CCW outward winding. */
function pushBox(target: number[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const x0 = cx - hx;
  const x1 = cx + hx;
  const y0 = cy - hy;
  const y1 = cy + hy;
  const z0 = cz - hz;
  const z1 = cz + hz;
  // +Z face
  pushTriangle(target, x0, y0, z1, x1, y0, z1, x1, y1, z1);
  pushTriangle(target, x0, y0, z1, x1, y1, z1, x0, y1, z1);
  // -Z face
  pushTriangle(target, x1, y0, z0, x0, y0, z0, x0, y1, z0);
  pushTriangle(target, x1, y0, z0, x0, y1, z0, x1, y1, z0);
  // +X face
  pushTriangle(target, x1, y0, z1, x1, y0, z0, x1, y1, z0);
  pushTriangle(target, x1, y0, z1, x1, y1, z0, x1, y1, z1);
  // -X face
  pushTriangle(target, x0, y0, z0, x0, y0, z1, x0, y1, z1);
  pushTriangle(target, x0, y0, z0, x0, y1, z1, x0, y1, z0);
  // +Y face
  pushTriangle(target, x0, y1, z1, x1, y1, z1, x1, y1, z0);
  pushTriangle(target, x0, y1, z1, x1, y1, z0, x0, y1, z0);
  // -Y face
  pushTriangle(target, x0, y0, z0, x1, y0, z0, x1, y0, z1);
  pushTriangle(target, x0, y0, z0, x1, y0, z1, x0, y0, z1);
}

/** Low-poly cylinder whose axis runs along X, centered at (cx, cy, cz). */
function pushWheel(target: number[], cx: number, cy: number, cz: number): void {
  const halfWidth = WHEEL_WIDTH_M / 2;
  const inner = cx - halfWidth;
  const outer = cx + halfWidth;
  for (let segment = 0; segment < WHEEL_SEGMENTS; segment += 1) {
    const angleA = (segment / WHEEL_SEGMENTS) * Math.PI * 2;
    const angleB = ((segment + 1) / WHEEL_SEGMENTS) * Math.PI * 2;
    const ay = cy + Math.cos(angleA) * WHEEL_RADIUS_M;
    const az = cz + Math.sin(angleA) * WHEEL_RADIUS_M;
    const by = cy + Math.cos(angleB) * WHEEL_RADIUS_M;
    const bz = cz + Math.sin(angleB) * WHEEL_RADIUS_M;
    // Rim quad (viewed from outside the tread, +X side first for winding).
    pushTriangle(target, inner, ay, az, outer, ay, az, outer, by, bz);
    pushTriangle(target, inner, ay, az, outer, by, bz, inner, by, bz);
    // Outer cap fan (+X, faces +X).
    pushTriangle(target, outer, cy, cz, outer, ay, az, outer, by, bz);
    // Inner cap fan (-X, faces -X).
    pushTriangle(target, inner, cy, cz, inner, by, bz, inner, ay, az);
  }
}

/**
 * Builds the merged car silhouette. ~232 triangles: cheap enough that a
 * single geometry serves every road's InstancedMesh.
 */
export function buildVehicleGeometry(): BufferGeometry {
  const positions: number[] = [];

  pushBox(
    positions,
    0,
    (BODY_BOTTOM_Y + BODY_TOP_Y) / 2,
    0,
    BODY_WIDTH_M,
    BODY_TOP_Y - BODY_BOTTOM_Y,
    VEHICLE_LENGTH_M,
  );
  pushBox(
    positions,
    0,
    (BODY_TOP_Y + CABIN_TOP_Y) / 2,
    CABIN_CENTER_Z,
    CABIN_WIDTH_M,
    CABIN_TOP_Y - BODY_TOP_Y,
    CABIN_LENGTH_M,
  );
  pushWheel(positions, WHEEL_CENTER_X, WHEEL_RADIUS_M, WHEEL_CENTER_Z);
  pushWheel(positions, -WHEEL_CENTER_X, WHEEL_RADIUS_M, WHEEL_CENTER_Z);
  pushWheel(positions, WHEEL_CENTER_X, WHEEL_RADIUS_M, -WHEEL_CENTER_Z);
  pushWheel(positions, -WHEEL_CENTER_X, WHEEL_RADIUS_M, -WHEEL_CENTER_Z);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = "director-traffic-vehicle";
  return geometry;
}
