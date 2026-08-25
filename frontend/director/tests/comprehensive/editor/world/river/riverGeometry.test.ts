import { describe, expect, it } from "vitest";
import {
  createDefaultDirectorWorldSettings,
  type DirectorWorldRiver,
  type DirectorWorldWaterBody,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import { buildRiverRibbonData } from "../../../../../src/comprehensive/editor/world/river/riverGeometry";
import {
  RIVER_FRAGMENT_SHADER,
  RIVER_VERTEX_SHADER,
  createRiverSurfaceMaterial,
  writeRiverFrameUniforms,
} from "../../../../../src/comprehensive/editor/world/river/riverMaterial";

const STRAIGHT_RIVER: DirectorWorldRiver = {
  points: [
    [0, 0, 0],
    [0, 0, 10],
  ],
  widthM: 4,
};

function vertexDistance(data: ReturnType<typeof buildRiverRibbonData>, left: number, right: number) {
  const offsetA = left * 3;
  const offsetB = right * 3;
  return Math.hypot(
    data.positions[offsetA]! - data.positions[offsetB]!,
    data.positions[offsetA + 1]! - data.positions[offsetB + 1]!,
    data.positions[offsetA + 2]! - data.positions[offsetB + 2]!,
  );
}

describe("river ribbon geometry", () => {
  it("sweeps a correctly wound, metre-scaled ribbon along a straight channel", () => {
    const data = buildRiverRibbonData(STRAIGHT_RIVER);
    expect(data.sampleCount).toBeGreaterThanOrEqual(5);
    expect(data.totalLengthM).toBeCloseTo(10, 5);
    expect(vertexDistance(data, 0, 1)).toBeCloseTo(4, 5);
    expect([...data.indices.slice(0, 6)]).toEqual([0, 1, 2, 1, 3, 2]);
    expect(data.normals[1]).toBeCloseTo(1, 6);
    expect(data.uvs[0]).toBe(0);
    expect(data.uvs[2]).toBe(1);
  });

  it("is deterministic and produces curvature/slope signals for rapids", () => {
    const river: DirectorWorldRiver = {
      points: [
        [-8, 2, -6],
        [-2, 1.2, 0],
        [4, 0.5, 2],
        [9, 0, 9],
      ],
      widthM: 5,
    };
    const first = buildRiverRibbonData(river);
    const second = buildRiverRibbonData(river);
    expect([...first.positions]).toEqual([...second.positions]);
    expect([...first.indices]).toEqual([...second.indices]);
    expect([...first.widthFactors]).toEqual([...second.widthFactors]);
    expect(Math.max(...first.curvatures)).toBeGreaterThan(0);
    expect(Math.max(...first.slopes)).toBeGreaterThan(0);
    expect([...first.positions].every(Number.isFinite)).toBe(true);
  });

  it("marks only downhill stretches as rapids (descent-only slope)", () => {
    // Same centerline geometry, opposite vertical trends.
    const downhill = buildRiverRibbonData({
      points: [
        [0, 3, 0],
        [0, 1.5, 12],
        [0, 0, 24],
      ],
      widthM: 4,
    });
    const uphill = buildRiverRibbonData({
      points: [
        [0, 0, 0],
        [0, 1.5, 12],
        [0, 3, 24],
      ],
      widthM: 4,
    });
    expect(Math.max(...downhill.slopes)).toBeGreaterThan(0.05);
    // Water does not churn white while climbing: ascent must read 0.
    expect(Math.max(...uphill.slopes)).toBe(0);
    // Flat water has no rapids at all.
    const flat = buildRiverRibbonData(STRAIGHT_RIVER);
    expect(Math.max(...flat.slopes)).toBe(0);
  });

  it("interpolates width profiles from source to mouth", () => {
    const data = buildRiverRibbonData({ ...STRAIGHT_RIVER, widthProfile: [0.5, 1.5] });
    const lastLeft = (data.sampleCount - 1) * 2;
    expect(vertexDistance(data, 0, 1)).toBeCloseTo(2, 5);
    expect(vertexDistance(data, lastLeft, lastLeft + 1)).toBeCloseTo(6, 5);
  });

  it("carries per-vertex width factors for the continuity speed-up", () => {
    // No profile: every factor is exactly 1 (legacy rivers keep their speed).
    const uniform = buildRiverRibbonData(STRAIGHT_RIVER);
    expect(uniform.widthFactors).toHaveLength(uniform.sampleCount * 2);
    expect([...uniform.widthFactors].every((factor) => factor === 1)).toBe(true);

    // Profile [0.5, 1.5]: source vertices carry 0.5, mouth vertices 1.5, and
    // both ribbon sides of a sample share the same factor.
    const shaped = buildRiverRibbonData({ ...STRAIGHT_RIVER, widthProfile: [0.5, 1.5] });
    expect(shaped.widthFactors[0]).toBeCloseTo(0.5, 5);
    expect(shaped.widthFactors[1]).toBeCloseTo(0.5, 5);
    const lastLeft = (shaped.sampleCount - 1) * 2;
    expect(shaped.widthFactors[lastLeft]).toBeCloseTo(1.5, 5);
    expect(shaped.widthFactors[lastLeft + 1]).toBeCloseTo(1.5, 5);
  });
});

describe("river surface shader", () => {
  it("aligns flow to spline tangents and carries bank/rapid foam plus fog", () => {
    expect(RIVER_VERTEX_SHADER).toContain("aFlowTangent");
    expect(RIVER_FRAGMENT_SHADER).toContain("bankFoam");
    expect(RIVER_FRAGMENT_SHADER).toContain("rapidFoam");
    expect(RIVER_FRAGMENT_SHADER).toContain("#include <fog_fragment>");
  });

  it("writes deterministic weather and time uniforms", () => {
    const body: DirectorWorldWaterBody = {
      id: "river-test",
      name: "Test river",
      surface: { center: [0, 0, 0], sizeX: 10, sizeZ: 10, rotationDegrees: 0 },
      river: STRAIGHT_RIVER,
      waveAmplitude: 0.08,
      waveLengthM: 4,
      flowDirectionDegrees: 0,
      flowSpeedMps: 1.4,
      colorShallow: "#5db3c9",
      colorDeep: "#123c52",
      opacity: 0.9,
      foamIntensity: 0.7,
      visible: true,
      locked: false,
    };
    const settings = createDefaultDirectorWorldSettings();
    settings.weather = { preset: "storm", intensity: 0.8, wetness: 1, cloudCover: 0.9 };
    const context: LivingWorldFrameContext = {
      worldSeconds: 12,
      frame: 288,
      fps: 24,
      isPlaying: true,
      seed: 42,
      settings,
      windVector: [6, 0, 0],
      groundHeight: 0,
    };
    const material = createRiverSurfaceMaterial(body);
    writeRiverFrameUniforms(material, body, context);
    expect(material.uniforms.uTime.value).toBe(12);
    expect(material.uniforms.uFlowSpeed.value).toBe(1.4);
    expect(material.uniforms.uRainAgitation.value).toBeCloseTo(0.8);
    expect(material.uniforms.uWindRoughness.value).toBeCloseTo(6 / 9);
    const phase = material.uniforms.uPhase.value;
    writeRiverFrameUniforms(material, body, context);
    expect(material.uniforms.uPhase.value).toBe(phase);
    material.dispose();
  });
});
