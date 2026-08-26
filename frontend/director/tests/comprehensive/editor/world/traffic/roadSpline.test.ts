import { describe, expect, it } from "vitest";
import {
  buildRoadMarkings,
  buildRoadRibbon,
  buildRoadSpline,
  roadLaneOffsetM,
  sampleRoadSplineAt,
  type MutableRoadVec3,
  type RoadVec3,
} from "../../../../../src/comprehensive/editor/world/traffic/roadSpline";

const STRAIGHT_POINTS: readonly RoadVec3[] = [
  [0, 0, 0],
  [0, 0, 20],
];

const LOOP_POINTS: readonly RoadVec3[] = [
  [12, 0.05, 8],
  [0, 0.05, 8],
  [-12, 0.05, 8],
  [-12, 0.05, 0],
  [-12, 0.05, -8],
  [0, 0.05, -8],
  [12, 0.05, -8],
  [12, 0.05, 0],
];

const position: MutableRoadVec3 = [0, 0, 0];
const tangent: MutableRoadVec3 = [0, 0, 0];

describe("roadSpline", () => {
  it("measures a straight open road and samples position + tangent at arc length", () => {
    const spline = buildRoadSpline(STRAIGHT_POINTS, false);
    expect(spline.loop).toBe(false);
    expect(spline.totalLengthM).toBeCloseTo(20, 5);
    expect(spline.sampleCount).toBeGreaterThanOrEqual(5);

    sampleRoadSplineAt(spline, 0, position, tangent);
    expect(position[0]).toBeCloseTo(0, 6);
    expect(position[2]).toBeCloseTo(0, 6);
    expect(tangent[2]).toBeCloseTo(1, 6);

    sampleRoadSplineAt(spline, 10, position, tangent);
    expect(position[2]).toBeCloseTo(10, 4);

    // Open roads clamp out-of-range arc lengths instead of wrapping.
    sampleRoadSplineAt(spline, -5, position, tangent);
    expect(position[2]).toBeCloseTo(0, 6);
    sampleRoadSplineAt(spline, 25, position, tangent);
    expect(position[2]).toBeCloseTo(20, 6);
  });

  it("closes loop roads and wraps arc-length sampling around the circuit", () => {
    const spline = buildRoadSpline(LOOP_POINTS, true);
    expect(spline.loop).toBe(true);
    // Rounded rectangle: longer than the straight-line perimeter of the
    // inscribed octagon path but in the same order of magnitude.
    expect(spline.totalLengthM).toBeGreaterThan(70);
    expect(spline.totalLengthM).toBeLessThan(100);

    const start: MutableRoadVec3 = [0, 0, 0];
    const startTangent: MutableRoadVec3 = [0, 0, 0];
    sampleRoadSplineAt(spline, 0, start, startTangent);
    sampleRoadSplineAt(spline, spline.totalLengthM, position, tangent);
    expect(position[0]).toBeCloseTo(start[0], 4);
    expect(position[2]).toBeCloseTo(start[2], 4);

    // Negative arc lengths wrap backwards (timeline scrubbing).
    const wrapped: MutableRoadVec3 = [0, 0, 0];
    sampleRoadSplineAt(spline, -3, wrapped, tangent);
    sampleRoadSplineAt(spline, spline.totalLengthM - 3, position, tangent);
    expect(wrapped[0]).toBeCloseTo(position[0], 6);
    expect(wrapped[2]).toBeCloseTo(position[2], 6);

    // Arc-length parametrization sanity: +1 m of s moves ≈ 1 m of space.
    const a: MutableRoadVec3 = [0, 0, 0];
    const b: MutableRoadVec3 = [0, 0, 0];
    sampleRoadSplineAt(spline, 20, a, tangent);
    sampleRoadSplineAt(spline, 21, b, tangent);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeCloseTo(1, 1);
  });

  it("welds a duplicated last==first control point on loops", () => {
    const welded = buildRoadSpline([...LOOP_POINTS, LOOP_POINTS[0]!], true);
    const plain = buildRoadSpline(LOOP_POINTS, true);
    expect(welded.totalLengthM).toBeCloseTo(plain.totalLengthM, 6);
    expect(welded.sampleCount).toBe(plain.sampleCount);
  });

  it("is deterministic", () => {
    const first = buildRoadSpline(LOOP_POINTS, true);
    const second = buildRoadSpline(LOOP_POINTS, true);
    expect([...first.positions]).toEqual([...second.positions]);
    expect([...first.tangents]).toEqual([...second.tangents]);
    expect([...first.distances]).toEqual([...second.distances]);
  });

  it("caps the lane offset at 2.2 m", () => {
    expect(roadLaneOffsetM(8)).toBeCloseTo(2, 6);
    expect(roadLaneOffsetM(30)).toBeCloseTo(2.2, 6);
    expect(roadLaneOffsetM(2)).toBeCloseTo(0.5, 6);
  });

  it("sweeps a lifted asphalt ribbon of the requested width", () => {
    const spline = buildRoadSpline(STRAIGHT_POINTS, false);
    const ribbon = buildRoadRibbon(spline, 6, 0.02);
    expect(ribbon.sampleCount).toBe(spline.sampleCount);
    // First cross-section: 6 m across, lifted by 0.02 m.
    const across = Math.hypot(
      ribbon.positions[0]! - ribbon.positions[3]!,
      ribbon.positions[1]! - ribbon.positions[4]!,
      ribbon.positions[2]! - ribbon.positions[5]!,
    );
    expect(across).toBeCloseTo(6, 5);
    expect(ribbon.positions[1]).toBeCloseTo(0.02, 6);
    expect([...ribbon.indices.slice(0, 6)]).toEqual([0, 1, 2, 1, 3, 2]);
    expect(ribbon.normals[1]).toBeCloseTo(1, 6);
    expect(ribbon.uvs[0]).toBe(0);
    expect(ribbon.uvs[2]).toBe(1);
  });

  it("generates dashed yellow centre paint and continuous white edge lines", () => {
    const spline = buildRoadSpline(STRAIGHT_POINTS, false);
    const markings = buildRoadMarkings(spline, 6, 0.026);
    expect(markings.centerDashCount).toBe(2);
    expect(markings.edgeLineCount).toBe(2);
    expect(markings.positions.length).toBe(markings.normals.length);
    expect(markings.colors.length).toBe(markings.positions.length);
    expect(markings.indices.length).toBeGreaterThan(0);
    expect([...markings.positions].every(Number.isFinite)).toBe(true);
    expect([...markings.normals].every(Number.isFinite)).toBe(true);

    const centerZ: number[] = [];
    const edgeX: number[] = [];
    for (let vertex = 0; vertex < markings.positions.length / 3; vertex += 1) {
      const blue = markings.colors[vertex * 3 + 2]!;
      expect(markings.positions[vertex * 3 + 1]).toBeCloseTo(0.026, 6);
      if (blue < 0.5) centerZ.push(markings.positions[vertex * 3 + 2]!);
      else edgeX.push(markings.positions[vertex * 3]!);
    }
    expect(Math.max(...centerZ.map((z, index) => (index === 0 ? 0 : z - centerZ[index - 1]!)))).toBeGreaterThan(4);
    expect(Math.min(...edgeX.map(Math.abs))).toBeGreaterThan(2.6);
    expect(Math.max(...edgeX)).toBeLessThan(3);
    expect(Math.min(...edgeX)).toBeGreaterThan(-3);
  });

  it("keeps loop edge paint closed and normals aligned on graded curves", () => {
    const gradedLoop = LOOP_POINTS.map(
      (point, index) => [point[0], point[1] + Math.sin(index) * 1.2, point[2]] as const,
    );
    const spline = buildRoadSpline(gradedLoop, true);
    const markings = buildRoadMarkings(spline, 8, 0.026);
    expect(markings.centerDashCount).toBe(Math.round(spline.totalLengthM / 9));
    expect(markings.edgeLineCount).toBe(2);

    for (let vertex = 0; vertex < markings.normals.length / 3; vertex += 1) {
      const x = markings.normals[vertex * 3]!;
      const y = markings.normals[vertex * 3 + 1]!;
      const z = markings.normals[vertex * 3 + 2]!;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
      expect(y).toBeGreaterThan(0);
    }

    const edgeSamples = Math.max(2, Math.ceil(spline.totalLengthM / 1.25) + 1);
    const verticesPerEdge = edgeSamples * 2;
    const totalVertices = markings.positions.length / 3;
    for (const edgeStart of [totalVertices - verticesPerEdge * 2, totalVertices - verticesPerEdge]) {
      for (let side = 0; side < 2; side += 1) {
        const first = (edgeStart + side) * 3;
        const last = (edgeStart + verticesPerEdge - 2 + side) * 3;
        expect(markings.positions[last]).toBeCloseTo(markings.positions[first]!, 5);
        expect(markings.positions[last + 1]).toBeCloseTo(markings.positions[first + 1]!, 5);
        expect(markings.positions[last + 2]).toBeCloseTo(markings.positions[first + 2]!, 5);
      }
    }
  });

  it("omits edge paint on narrow roads and returns empty paint for a zero-length spline", () => {
    const narrow = buildRoadMarkings(buildRoadSpline(STRAIGHT_POINTS, false), 3, 0.026);
    expect(narrow.centerDashCount).toBeGreaterThan(0);
    expect(narrow.edgeLineCount).toBe(0);

    const degenerate = buildRoadMarkings(
      buildRoadSpline(
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
        false,
      ),
      6,
      0.026,
    );
    expect(degenerate.positions).toHaveLength(0);
    expect(degenerate.indices).toHaveLength(0);
    expect(degenerate.centerDashCount).toBe(0);
    expect(degenerate.edgeLineCount).toBe(0);
  });
});
