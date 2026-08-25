/**
 * Pure Catmull-Rom road centerline sampling for ambient traffic.
 *
 * Mirrors the river ribbon approach (adaptive per-span tessellation into a
 * cumulative arc-length table) but is traffic-owned: roads need closed-loop
 * control polygons, arc-length lookup at arbitrary `s`, and signed lane
 * offsets, none of which the river exposes. All functions are deterministic
 * and allocation-free at query time so the layer can sample every vehicle
 * every frame without garbage.
 */

/** Immutable 3D vector used as a road control-point input. */
export type RoadVec3 = readonly [number, number, number];

/** Mutable 3D vector for zero-allocation output writes. */
export type MutableRoadVec3 = [number, number, number];

export interface RoadSpline {
  /** Dense samples, xyz triplets, ordered by arc length. */
  positions: Float64Array;
  /** Normalized tangents, xyz triplets, aligned with `positions`. */
  tangents: Float64Array;
  /** Cumulative arc length per sample; starts at 0, ends at `totalLengthM`. */
  distances: Float64Array;
  /** Number of sample points along the spline. */
  sampleCount: number;
  /** Total arc length of the centreline in metres. */
  totalLengthM: number;
  /** Whether the spline is closed (end wraps to start). */
  loop: boolean;
}

export interface RoadRibbon {
  /** Per-vertex positions, xyz triplets, 2 vertices per sample (left/right). */
  positions: Float32Array;
  /** Per-vertex surface normals for flat-shaded asphalt. */
  normals: Float32Array;
  /** Per-vertex UVs; U crosses the road (0=left, 1=right), V is scaled arc length. */
  uvs: Float32Array;
  /** Triangle indices forming a quad strip between consecutive samples. */
  indices: Uint32Array;
  /** Number of centerline samples used to generate the ribbon. */
  sampleCount: number;
}

const MIN_SEGMENTS_PER_SPAN = 4;
const MAX_SEGMENTS_PER_SPAN = 32;
/** Target metres between samples; small enough that vehicles glide smoothly. */
const TARGET_SAMPLE_SPACING_M = 1.5;
/** First and last control points closer than this collapse when looping. */
const LOOP_WELD_EPSILON_M = 1e-6;

/** Two lanes sit at ±laneOffset around the centerline. */
export function roadLaneOffsetM(widthM: number): number {
  return Math.min(widthM / 4, 2.2);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function catmullRomAxis(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function catmullRomDerivativeAxis(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  return 0.5 * (-p0 + p2 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2);
}

/**
 * Builds the arc-length table for a road centerline.
 *
 * Loop roads wrap the control polygon (neighbor indices mod N) so the curve
 * closes C1-continuously; a duplicated last==first control point is welded
 * away first to avoid a degenerate zero-length span. Open roads clamp end
 * neighbors like the river does. The final sample of a loop sits at the
 * geometric start so `distances` always spans [0, totalLengthM] inclusive.
 */
export function buildRoadSpline(points: readonly RoadVec3[], loop: boolean): RoadSpline {
  let controls = points;
  if (loop && points.length > 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const weld = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < LOOP_WELD_EPSILON_M;
    if (weld) controls = points.slice(0, -1);
  }
  const pointCount = controls.length;
  const closed = loop && pointCount > 2;
  const spanCount = closed ? pointCount : pointCount - 1;

  const spanSegments: number[] = [];
  let totalSamples = 1;
  for (let span = 0; span < spanCount; span += 1) {
    const a = controls[span]!;
    const b = controls[(span + 1) % pointCount]!;
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const segments = clamp(Math.ceil(chord / TARGET_SAMPLE_SPACING_M), MIN_SEGMENTS_PER_SPAN, MAX_SEGMENTS_PER_SPAN);
    spanSegments.push(segments);
    totalSamples += segments;
  }

  const positions = new Float64Array(totalSamples * 3);
  const tangents = new Float64Array(totalSamples * 3);
  const distances = new Float64Array(totalSamples);

  let cursor = 0;
  let travelled = 0;
  let previousTangentX = 0;
  let previousTangentY = 0;
  let previousTangentZ = 1;

  for (let span = 0; span < spanCount; span += 1) {
    const i0 = closed ? (span - 1 + pointCount) % pointCount : Math.max(0, span - 1);
    const i1 = span;
    const i2 = (span + 1) % pointCount;
    const i3 = closed ? (span + 2) % pointCount : Math.min(pointCount - 1, span + 2);
    const p0 = controls[i0]!;
    const p1 = controls[i1]!;
    const p2 = controls[i2]!;
    const p3 = controls[i3]!;
    const segments = spanSegments[span]!;
    const startStep = span === 0 ? 0 : 1;
    for (let step = startStep; step <= segments; step += 1) {
      const t = step / segments;
      const x = catmullRomAxis(p0[0], p1[0], p2[0], p3[0], t);
      const y = catmullRomAxis(p0[1], p1[1], p2[1], p3[1], t);
      const z = catmullRomAxis(p0[2], p1[2], p2[2], p3[2], t);
      let tangentX = catmullRomDerivativeAxis(p0[0], p1[0], p2[0], p3[0], t);
      let tangentY = catmullRomDerivativeAxis(p0[1], p1[1], p2[1], p3[1], t);
      let tangentZ = catmullRomDerivativeAxis(p0[2], p1[2], p2[2], p3[2], t);
      const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
      if (tangentLength > 1e-7) {
        tangentX /= tangentLength;
        tangentY /= tangentLength;
        tangentZ /= tangentLength;
      } else {
        tangentX = previousTangentX;
        tangentY = previousTangentY;
        tangentZ = previousTangentZ;
      }
      previousTangentX = tangentX;
      previousTangentY = tangentY;
      previousTangentZ = tangentZ;

      if (cursor > 0) {
        const prev = (cursor - 1) * 3;
        travelled += Math.hypot(x - positions[prev]!, y - positions[prev + 1]!, z - positions[prev + 2]!);
      }
      const base = cursor * 3;
      positions[base] = x;
      positions[base + 1] = y;
      positions[base + 2] = z;
      tangents[base] = tangentX;
      tangents[base + 1] = tangentY;
      tangents[base + 2] = tangentZ;
      distances[cursor] = travelled;
      cursor += 1;
    }
  }

  return {
    positions,
    tangents,
    distances,
    sampleCount: totalSamples,
    totalLengthM: travelled,
    loop: closed,
  };
}

/**
 * Position + normalized tangent at arc length `s`, written into `outPosition`
 * and `outTangent` (no allocation). Loop roads wrap `s`; open roads clamp.
 */
export function sampleRoadSplineAt(
  spline: RoadSpline,
  s: number,
  outPosition: MutableRoadVec3,
  outTangent: MutableRoadVec3,
): void {
  const { positions, tangents, distances, sampleCount, totalLengthM } = spline;
  if (sampleCount === 0) {
    outPosition[0] = 0;
    outPosition[1] = 0;
    outPosition[2] = 0;
    outTangent[0] = 0;
    outTangent[1] = 0;
    outTangent[2] = 1;
    return;
  }
  let target = s;
  if (totalLengthM <= 1e-9) {
    target = 0;
  } else if (spline.loop) {
    target = ((s % totalLengthM) + totalLengthM) % totalLengthM;
  } else {
    target = clamp(s, 0, totalLengthM);
  }

  // Binary search: greatest index with distances[index] <= target.
  let low = 0;
  let high = sampleCount - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (distances[mid]! <= target) low = mid;
    else high = mid - 1;
  }
  const index = Math.min(low, sampleCount - 2);
  const next = Math.min(index + 1, sampleCount - 1);
  const segmentLength = distances[next]! - distances[index]!;
  const alpha = segmentLength > 1e-9 ? (target - distances[index]!) / segmentLength : 0;

  const a = index * 3;
  const b = next * 3;
  outPosition[0] = positions[a]! + (positions[b]! - positions[a]!) * alpha;
  outPosition[1] = positions[a + 1]! + (positions[b + 1]! - positions[a + 1]!) * alpha;
  outPosition[2] = positions[a + 2]! + (positions[b + 2]! - positions[a + 2]!) * alpha;

  let tangentX = tangents[a]! + (tangents[b]! - tangents[a]!) * alpha;
  let tangentY = tangents[a + 1]! + (tangents[b + 1]! - tangents[a + 1]!) * alpha;
  let tangentZ = tangents[a + 2]! + (tangents[b + 2]! - tangents[a + 2]!) * alpha;
  const length = Math.hypot(tangentX, tangentY, tangentZ);
  if (length > 1e-7) {
    tangentX /= length;
    tangentY /= length;
    tangentZ /= length;
  } else {
    tangentX = tangents[a]!;
    tangentY = tangents[a + 1]!;
    tangentZ = tangents[a + 2]!;
  }
  outTangent[0] = tangentX;
  outTangent[1] = tangentY;
  outTangent[2] = tangentZ;
}

/**
 * Flat asphalt ribbon swept along the spline, lifted by `liftM` against
 * z-fighting with the terrain. UV.x crosses the road (0..1), UV.y is arc
 * length in road-width units so any texture keeps a stable metre scale.
 */
export function buildRoadRibbon(spline: RoadSpline, widthM: number, liftM: number): RoadRibbon {
  const { positions, tangents, sampleCount, distances } = spline;
  const ribbonPositions = new Float32Array(sampleCount * 2 * 3);
  const ribbonNormals = new Float32Array(sampleCount * 2 * 3);
  const ribbonUvs = new Float32Array(sampleCount * 2 * 2);
  const halfWidth = widthM / 2;
  const uvScale = Math.max(widthM, 0.5);

  let lateralX = 1;
  let lateralZ = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const base = sample * 3;
    const tangentX = tangents[base]!;
    const tangentY = tangents[base + 1]!;
    const tangentZ = tangents[base + 2]!;
    const horizontal = Math.hypot(tangentX, tangentZ);
    if (horizontal > 1e-7) {
      lateralX = tangentZ / horizontal;
      lateralZ = -tangentX / horizontal;
    }
    // Surface normal perpendicular to the tangent, leaning with the slope.
    let normalX = -tangentY * tangentX;
    let normalY = tangentX * tangentX + tangentZ * tangentZ;
    let normalZ = -tangentY * tangentZ;
    const normalLength = Math.hypot(normalX, normalY, normalZ);
    if (normalLength > 1e-7) {
      normalX /= normalLength;
      normalY /= normalLength;
      normalZ /= normalLength;
    } else {
      normalX = 0;
      normalY = 1;
      normalZ = 0;
    }
    for (let side = 0; side < 2; side += 1) {
      const sign = side === 0 ? 1 : -1;
      const vertex = sample * 2 + side;
      ribbonPositions[vertex * 3] = positions[base]! + lateralX * halfWidth * sign;
      ribbonPositions[vertex * 3 + 1] = positions[base + 1]! + liftM;
      ribbonPositions[vertex * 3 + 2] = positions[base + 2]! + lateralZ * halfWidth * sign;
      ribbonNormals[vertex * 3] = normalX;
      ribbonNormals[vertex * 3 + 1] = normalY;
      ribbonNormals[vertex * 3 + 2] = normalZ;
      ribbonUvs[vertex * 2] = side;
      ribbonUvs[vertex * 2 + 1] = distances[sample]! / uvScale;
    }
  }

  const indices = new Uint32Array(Math.max(0, sampleCount - 1) * 6);
  for (let sample = 0; sample < sampleCount - 1; sample += 1) {
    const left = sample * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.set([left, right, nextLeft, right, nextRight, nextLeft], sample * 6);
  }

  return {
    positions: ribbonPositions,
    normals: ribbonNormals,
    uvs: ribbonUvs,
    indices,
    sampleCount,
  };
}
