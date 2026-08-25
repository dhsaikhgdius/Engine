/**
 * Procedural low-poly ambient vehicles: one merged BufferGeometry per body
 * type shared by every instance, following the wildlife placeholder-model
 * pattern. Non-indexed triangle soup with computeVertexNormals gives faceted
 * shading that reads well at ambient distances. Builders are pure: identical
 * calls produce identical buffers.
 *
 * Two lofted silhouettes: a sedan (tapered body, raked glasshouse) and an
 * SUV (taller shoulder, boxier glasshouse). Both share the footprint, wheel
 * positions, and light cluster, so the flow model and the emissive lights
 * mesh are body-type agnostic. Per-vertex colors multiply the per-instance
 * palette tint, so the body takes the full instance colour (white vertex
 * colour) while glass, skirt, and wheels stay dark on every paint job
 * instead of being tinted like toy blocks.
 *
 * Conventions: forward +Z, up +Y, origin at the ground point under the car
 * center. Footprint ≈ 1.75 m wide × 4.4 m long.
 */

import { BufferAttribute, BufferGeometry } from "three";

/** Vehicle footprint width in metres (body plus wheel clearance). */
export const VEHICLE_WIDTH_M = 1.75;

/** Vehicle footprint length in metres (bumper to bumper). */
export const VEHICLE_LENGTH_M = 4.4;

/** Cosmetic vehicle silhouettes; order matches trafficFlow bodyTypeIndices. */
export const VEHICLE_BODY_TYPES = ["sedan", "suv"] as const;

/** One of the fixed cosmetic vehicle silhouettes. */
export type VehicleBodyType = (typeof VEHICLE_BODY_TYPES)[number];

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

/** RGB triple used as a per-face vertex colour. */
type VertexColor = readonly [number, number, number];

/** Body panels: white so the per-instance palette tint passes through fully. */
const COLOR_BODY: VertexColor = [1, 1, 1];
/** Cabin glass: dark blue-grey regardless of paint colour. */
const COLOR_GLASS: VertexColor = [0.09, 0.11, 0.14];
/** Chassis skirt and bumpers. */
const COLOR_SKIRT: VertexColor = [0.13, 0.13, 0.14];
/** Tyres. */
const COLOR_WHEEL: VertexColor = [0.07, 0.07, 0.08];

/** Headlight emissive tint (warm white), used by the lights geometry. */
export const VEHICLE_HEADLIGHT_COLOR: VertexColor = [1, 0.94, 0.72];
/** Taillight emissive tint (red), used by the lights geometry. */
export const VEHICLE_TAILLIGHT_COLOR: VertexColor = [1, 0.09, 0.06];

const WHEEL_RADIUS_M = 0.32;
const WHEEL_WIDTH_M = 0.24;
const WHEEL_SEGMENTS = 8;
const WHEEL_CENTER_X = VEHICLE_WIDTH_M / 2 - 0.14;
const WHEEL_CENTER_Z = 1.35;

interface TriangleSoup {
  positions: number[];
  colors: number[];
}

function pushTriangle(
  soup: TriangleSoup,
  color: VertexColor,
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
  soup.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  soup.colors.push(...color, ...color, ...color);
}

/** Axis-aligned box (12 triangles) centered at (cx, cy, cz), CCW outward winding. */
function pushBox(
  soup: TriangleSoup,
  color: VertexColor,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  pushLoftBox(soup, { color }, cx, cz, cy - sy / 2, sx, sz, cx, cz, cy + sy / 2, sx, sz);
}

interface LoftColors {
  side: VertexColor;
  top: VertexColor;
  bottom: VertexColor;
}

/**
 * Lofted box between a bottom rectangle and a top rectangle (both axis
 * aligned, possibly different sizes/centres), CCW outward winding. Tapered
 * lofts produce hood/windshield slopes without extra primitives.
 */
function pushLoftBox(
  soup: TriangleSoup,
  colors: LoftColors | { color: VertexColor },
  bottomCx: number,
  bottomCz: number,
  bottomY: number,
  bottomSx: number,
  bottomSz: number,
  topCx: number,
  topCz: number,
  topY: number,
  topSx: number,
  topSz: number,
): void {
  const side = "color" in colors ? colors.color : colors.side;
  const top = "color" in colors ? colors.color : colors.top;
  const bottom = "color" in colors ? colors.color : colors.bottom;
  const x0b = bottomCx - bottomSx / 2;
  const x1b = bottomCx + bottomSx / 2;
  const z0b = bottomCz - bottomSz / 2;
  const z1b = bottomCz + bottomSz / 2;
  const x0t = topCx - topSx / 2;
  const x1t = topCx + topSx / 2;
  const z0t = topCz - topSz / 2;
  const z1t = topCz + topSz / 2;
  // +Z face
  pushTriangle(soup, side, x0b, bottomY, z1b, x1b, bottomY, z1b, x1t, topY, z1t);
  pushTriangle(soup, side, x0b, bottomY, z1b, x1t, topY, z1t, x0t, topY, z1t);
  // -Z face
  pushTriangle(soup, side, x1b, bottomY, z0b, x0b, bottomY, z0b, x0t, topY, z0t);
  pushTriangle(soup, side, x1b, bottomY, z0b, x0t, topY, z0t, x1t, topY, z0t);
  // +X face
  pushTriangle(soup, side, x1b, bottomY, z1b, x1b, bottomY, z0b, x1t, topY, z0t);
  pushTriangle(soup, side, x1b, bottomY, z1b, x1t, topY, z0t, x1t, topY, z1t);
  // -X face
  pushTriangle(soup, side, x0b, bottomY, z0b, x0b, bottomY, z1b, x0t, topY, z1t);
  pushTriangle(soup, side, x0b, bottomY, z0b, x0t, topY, z1t, x0t, topY, z0t);
  // +Y face
  pushTriangle(soup, top, x0t, topY, z1t, x1t, topY, z1t, x1t, topY, z0t);
  pushTriangle(soup, top, x0t, topY, z1t, x1t, topY, z0t, x0t, topY, z0t);
  // -Y face
  pushTriangle(soup, bottom, x0b, bottomY, z0b, x1b, bottomY, z0b, x1b, bottomY, z1b);
  pushTriangle(soup, bottom, x0b, bottomY, z0b, x1b, bottomY, z1b, x0b, bottomY, z1b);
}

/** Low-poly cylinder whose axis runs along X, centered at (cx, cy, cz). */
function pushWheel(soup: TriangleSoup, cx: number, cy: number, cz: number): void {
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
    pushTriangle(soup, COLOR_WHEEL, inner, ay, az, outer, ay, az, outer, by, bz);
    pushTriangle(soup, COLOR_WHEEL, inner, ay, az, outer, by, bz, inner, by, bz);
    // Outer cap fan (+X, faces +X).
    pushTriangle(soup, COLOR_WHEEL, outer, cy, cz, outer, ay, az, outer, by, bz);
    // Inner cap fan (-X, faces -X).
    pushTriangle(soup, COLOR_WHEEL, inner, cy, cz, inner, by, bz, inner, ay, az);
  }
}

function soupToGeometry(soup: TriangleSoup, name: string): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(soup.positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(soup.colors), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = name;
  return geometry;
}

/** Skirt, wheels, and glass/roof loft shared by every body type. */
interface BodyProfile {
  /** Shoulder-line height where the body loft ends and glass begins. */
  shoulderY: number;
  /** Body top-rectangle centre Z shift (negative = trunk bias). */
  shoulderCz: number;
  /** Body top-rectangle size (taper). */
  shoulderSx: number;
  shoulderSz: number;
  /** Glasshouse bottom rectangle. */
  cabinBottomCz: number;
  cabinBottomSx: number;
  cabinBottomSz: number;
  /** Glasshouse top rectangle (rake). */
  cabinTopCz: number;
  cabinTopY: number;
  cabinTopSx: number;
  cabinTopSz: number;
}

const BODY_PROFILES: Record<VehicleBodyType, BodyProfile> = {
  // Low shoulder, strong hood/trunk taper, fast windshield rake.
  sedan: {
    shoulderY: 0.82,
    shoulderCz: 0.05,
    shoulderSx: 1.6,
    shoulderSz: 3.96,
    cabinBottomCz: -0.18,
    cabinBottomSx: 1.5,
    cabinBottomSz: 2.5,
    cabinTopCz: -0.3,
    cabinTopY: 1.34,
    cabinTopSx: 1.28,
    cabinTopSz: 1.45,
  },
  // Tall shoulder, mild taper, long upright glasshouse over the rear axle.
  suv: {
    shoulderY: 0.98,
    shoulderCz: 0.02,
    shoulderSx: 1.66,
    shoulderSz: 4.08,
    cabinBottomCz: -0.32,
    cabinBottomSx: 1.56,
    cabinBottomSz: 2.9,
    cabinTopCz: -0.44,
    cabinTopY: 1.62,
    cabinTopSx: 1.38,
    cabinTopSz: 2.35,
  },
};

/**
 * Builds the merged silhouette for one body type with per-vertex colours.
 * Cheap enough (~300 triangles) that one geometry per body type serves every
 * road's InstancedMesh. Defaults to the sedan.
 */
export function buildVehicleGeometry(bodyType: VehicleBodyType = "sedan"): BufferGeometry {
  const soup: TriangleSoup = { positions: [], colors: [] };
  const profile = BODY_PROFILES[bodyType];

  // Dark chassis skirt doubles as bumpers so the paint never reaches the ground.
  pushLoftBox(
    soup,
    { side: COLOR_SKIRT, top: COLOR_SKIRT, bottom: COLOR_SKIRT },
    0,
    0,
    0.18,
    VEHICLE_WIDTH_M - 0.01,
    VEHICLE_LENGTH_M,
    0,
    0,
    0.34,
    VEHICLE_WIDTH_M - 0.03,
    VEHICLE_LENGTH_M - 0.06,
  );
  // Body: tapers inward and shortens toward the shoulder line (hood + trunk).
  pushLoftBox(
    soup,
    { side: COLOR_BODY, top: COLOR_BODY, bottom: COLOR_SKIRT },
    0,
    0,
    0.34,
    1.72,
    VEHICLE_LENGTH_M - 0.1,
    0,
    profile.shoulderCz,
    profile.shoulderY,
    profile.shoulderSx,
    profile.shoulderSz,
  );
  // Glasshouse cabin: windshield/backlight rake via the loft taper.
  // Sides are glass; the roof panel takes the body paint.
  pushLoftBox(
    soup,
    { side: COLOR_GLASS, top: COLOR_BODY, bottom: COLOR_GLASS },
    0,
    profile.cabinBottomCz,
    profile.shoulderY,
    profile.cabinBottomSx,
    profile.cabinBottomSz,
    0,
    profile.cabinTopCz,
    profile.cabinTopY,
    profile.cabinTopSx,
    profile.cabinTopSz,
  );
  pushWheel(soup, WHEEL_CENTER_X, WHEEL_RADIUS_M, WHEEL_CENTER_Z);
  pushWheel(soup, -WHEEL_CENTER_X, WHEEL_RADIUS_M, WHEEL_CENTER_Z);
  pushWheel(soup, WHEEL_CENTER_X, WHEEL_RADIUS_M, -WHEEL_CENTER_Z);
  pushWheel(soup, -WHEEL_CENTER_X, WHEEL_RADIUS_M, -WHEEL_CENTER_Z);

  return soupToGeometry(soup, `director-traffic-vehicle-${bodyType}`);
}

/**
 * Builds the emissive light clusters (two warm-white headlights at +Z, two
 * red taillights at -Z) in the same local frame as the vehicle body, so both
 * InstancedMeshes can share one instanceMatrix attribute. Rendered with a
 * vertex-coloured additive material whose opacity follows the headlight
 * factor (see trafficEnvironment).
 */
export function buildVehicleLightsGeometry(): BufferGeometry {
  const soup: TriangleSoup = { positions: [], colors: [] };
  const frontZ = VEHICLE_LENGTH_M / 2 - 0.03;
  const rearZ = -VEHICLE_LENGTH_M / 2 + 0.03;
  for (const sideSign of [1, -1] as const) {
    pushBox(soup, VEHICLE_HEADLIGHT_COLOR, sideSign * 0.52, 0.6, frontZ, 0.3, 0.13, 0.08);
    pushBox(soup, VEHICLE_TAILLIGHT_COLOR, sideSign * 0.52, 0.64, rearZ, 0.26, 0.11, 0.06);
  }
  return soupToGeometry(soup, "director-traffic-vehicle-lights");
}
