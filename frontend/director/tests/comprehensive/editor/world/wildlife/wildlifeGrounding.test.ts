import { describe, expect, it } from "vitest";
import {
  lerp,
  lerpAngle,
  resolveWildlifeGroundY,
  sampleWildlifeGroundPose,
  WILDLIFE_MAX_SLOPE_TILT_RAD,
  wildlifeSlopePitchRad,
  wildlifeTerrainLift,
  type WildlifeGroundPose,
} from "../../../../../src/comprehensive/editor/world/wildlife/wildlifeGrounding";

const TWO_PI = Math.PI * 2;

describe("render interpolation helpers", () => {
  it("lerps linearly and blends headings along the shortest arc", () => {
    expect(lerp(2, 6, 0.25)).toBe(3);
    // 0.1 rad to (2π - 0.1) rad crosses zero, not the long way around.
    expect(lerpAngle(0.1, TWO_PI - 0.1, 0.5)).toBeCloseTo(0, 10);
    expect(lerpAngle(TWO_PI - 0.1, 0.1, 0.5)).toBeCloseTo(TWO_PI, 10);
    expect(lerpAngle(1, 2, 0.5)).toBeCloseTo(1.5, 10);
  });
});

describe("ground snap", () => {
  it("uses the sampled terrain height and falls back to the flat plane on null", () => {
    expect(resolveWildlifeGroundY(3.25, 0.5)).toBe(3.25);
    expect(resolveWildlifeGroundY(null, 0.5)).toBe(0.5);
    expect(resolveWildlifeGroundY(Number.NaN, 0.5)).toBe(0.5);
  });

  it("lifts low flocks by relief relative to the reference height", () => {
    expect(wildlifeTerrainLift(4, 1)).toBe(3);
    expect(wildlifeTerrainLift(-2, 1)).toBe(-3);
    expect(wildlifeTerrainLift(null, 1)).toBe(0);
  });
});

describe("slope tilt", () => {
  it("is level on flat ground and noses up ascending terrain", () => {
    expect(wildlifeSlopePitchRad(2, 2, 1.2)).toBe(0);
    // Ahead higher than behind => nose up => negative X pitch (YXZ frame).
    expect(wildlifeSlopePitchRad(0, 0.2, 1.2)).toBeLessThan(0);
    expect(wildlifeSlopePitchRad(0.2, 0, 1.2)).toBeGreaterThan(0);
    expect(wildlifeSlopePitchRad(0, 0.2, 1.2)).toBeCloseTo(-Math.atan2(0.2, 1.2), 10);
  });

  it("clamps to ±25° on cliffs and ignores non-finite samples", () => {
    expect(wildlifeSlopePitchRad(0, 100, 1.2)).toBe(-WILDLIFE_MAX_SLOPE_TILT_RAD);
    expect(wildlifeSlopePitchRad(100, 0, 1.2)).toBe(WILDLIFE_MAX_SLOPE_TILT_RAD);
    expect(wildlifeSlopePitchRad(Number.NaN, 1, 1.2)).toBe(0);
    expect(wildlifeSlopePitchRad(1, Number.POSITIVE_INFINITY, 1.2)).toBe(0);
  });
});

describe("sampleWildlifeGroundPose", () => {
  const pose: WildlifeGroundPose = { groundY: 0, slopePitchRad: 0 };

  it("samples centre plus a fore/aft pair along the heading", () => {
    // Terrain rising along +X: h = x. Heading +X is yaw π/2 (forward +Z at 0).
    const ramp = (x: number) => x;
    sampleWildlifeGroundPose(ramp, 2, 7, Math.PI / 2, 0, 0.6, pose);
    expect(pose.groundY).toBeCloseTo(2, 10);
    // Slope 45° exceeds the clamp.
    expect(pose.slopePitchRad).toBeCloseTo(-WILDLIFE_MAX_SLOPE_TILT_RAD, 10);

    // Same ramp walked along +Z is flat.
    sampleWildlifeGroundPose(ramp, 2, 7, 0, 0, 0.6, pose);
    expect(pose.slopePitchRad).toBeCloseTo(0, 10);
  });

  it("falls back to the flat plane when sampling misses", () => {
    const never = () => null;
    sampleWildlifeGroundPose(never, 4, -3, 1.2, 0.75, 0.6, pose);
    expect(pose.groundY).toBe(0.75);
    expect(pose.slopePitchRad).toBe(0);
  });

  it("treats missing fore/aft samples as level rather than a cliff", () => {
    // Centre hits at 5; probes off the mesh edge return null.
    const centreOnly = (x: number, z: number) => (x === 2 && z === 7 ? 5 : null);
    sampleWildlifeGroundPose(centreOnly, 2, 7, Math.PI / 4, 0, 0.6, pose);
    expect(pose.groundY).toBe(5);
    expect(pose.slopePitchRad).toBe(0);
  });
});
