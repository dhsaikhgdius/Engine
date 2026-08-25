import { describe, expect, it } from "vitest";
import type { DirectorWorldWaterBody } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import { computeWaterTroughLift } from "../../../../../src/comprehensive/editor/world/water/waterParams";
import {
  RIVER_FRAGMENT_SHADER,
  RIVER_VERTEX_SHADER,
  RIVER_WAVE_TROUGH_FACTOR,
  computeRiverFlowSpeedFactor,
  createRiverSurfaceMaterial,
  riverSurfaceMinY,
  writeRiverFrameUniforms,
} from "../../../../../src/comprehensive/editor/world/river/riverMaterial";

function createRiverBody(): DirectorWorldWaterBody {
  return {
    id: "water_river_1",
    name: "河流",
    surface: { center: [0, 0.1, 0], sizeX: 60, sizeZ: 8, rotationDegrees: 0 },
    waveAmplitude: 0.18,
    waveLengthM: 6,
    flowDirectionDegrees: 0,
    flowSpeedMps: 1.4,
    colorShallow: "#58c4d9",
    colorDeep: "#0a3f5c",
    opacity: 0.85,
    foamIntensity: 0.6,
    visible: true,
    locked: false,
  };
}

function createFrameContext(weather: LivingWorldFrameContext["settings"]["weather"]): LivingWorldFrameContext {
  return {
    worldSeconds: 8,
    frame: 192,
    fps: 24,
    isPlaying: true,
    seed: 7,
    settings: {
      enabled: true,
      seed: 7,
      wind: { directionDegrees: 0, speedMps: 0, gustiness: 0, turbulence: 0 },
      timeOfDay: { mode: "fixed", hours: 12, cycleMinutes: 12, drivesSky: false },
      weather,
    },
    windVector: [0, 0, 0],
    groundHeight: 0,
  };
}

describe("river continuity speed factor", () => {
  it("speeds flow up through narrows and slows it in wide reaches, clamped", () => {
    expect(computeRiverFlowSpeedFactor(1)).toBe(1);
    expect(computeRiverFlowSpeedFactor(0.5)).toBeCloseTo(2, 10);
    expect(computeRiverFlowSpeedFactor(2)).toBeCloseTo(0.55, 10);
    // Clamps: degenerate profile values cannot explode or stall the flow.
    expect(computeRiverFlowSpeedFactor(0.01)).toBe(2.4);
    expect(computeRiverFlowSpeedFactor(8)).toBe(0.55);
    // Deterministic pure function.
    expect(computeRiverFlowSpeedFactor(0.7)).toBe(computeRiverFlowSpeedFactor(0.7));
  });

  it("is mirrored verbatim in both shader stages", () => {
    expect(RIVER_VERTEX_SHADER).toContain("float speedFactor = clamp(1.0 / max(aWidthFactor, 0.1), 0.55, 2.4);");
    expect(RIVER_FRAGMENT_SHADER).toContain("float speedFactor = clamp(1.0 / max(vWidthFactor, 0.1), 0.55, 2.4);");
  });
});

describe("river weather coupling", () => {
  it("keeps clear weather at the authored look", () => {
    const body = createRiverBody();
    body.river = {
      points: [
        [0, 0, 0],
        [0, 0, 30],
      ],
      widthM: 6,
    };
    const material = createRiverSurfaceMaterial(body);
    writeRiverFrameUniforms(
      material,
      body,
      createFrameContext({ preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0 }),
    );
    expect(material.uniforms.uFoamBoost.value).toBe(1);
    expect(material.uniforms.uMurkiness.value).toBe(0);
    expect(material.uniforms.uWidthM.value).toBe(6);
    material.dispose();
  });

  it("murkies the water and boosts foam under a storm", () => {
    const body = createRiverBody();
    body.river = {
      points: [
        [0, 0, 0],
        [0, 0, 30],
      ],
      widthM: 6,
    };
    const material = createRiverSurfaceMaterial(body);
    writeRiverFrameUniforms(
      material,
      body,
      createFrameContext({ preset: "storm", intensity: 1, wetness: 1, cloudCover: 1 }),
    );
    expect(material.uniforms.uFoamBoost.value).toBeCloseTo(1.8, 10);
    expect(material.uniforms.uMurkiness.value).toBeCloseTo(0.95, 10);
    material.dispose();
  });

  it("carries the murk, boost, and metric bank terms in the fragment shader", () => {
    expect(RIVER_FRAGMENT_SHADER).toContain("uniform float uFoamBoost;");
    expect(RIVER_FRAGMENT_SHADER).toContain("uniform float uMurkiness;");
    expect(RIVER_FRAGMENT_SHADER).toContain("uniform float uWidthM;");
    expect(RIVER_FRAGMENT_SHADER).toContain("float bankDistM");
    expect(RIVER_FRAGMENT_SHADER).toContain("float foamGain = clamp(uFoamIntensity * uFoamBoost, 0.0, 1.0);");
    // Rapids ride the vertex-stage signal (downhill descent + curvature + narrows).
    expect(RIVER_VERTEX_SHADER).toContain("attribute float aWidthFactor;");
    expect(RIVER_VERTEX_SHADER).toContain("vRapid");
    expect(RIVER_FRAGMENT_SHADER).toContain("vRapid");
  });
});

describe("river material environment probe", () => {
  it("defaults the environment probe uniforms to the procedural fallback", () => {
    const material = createRiverSurfaceMaterial(createRiverBody());
    expect(material.uniforms.uEnvBlend.value).toBe(0);
    expect(material.uniforms.uEnvMap.value).toBeNull();
    material.dispose();
  });

  it("provides the built-in fog uniforms required by ShaderMaterial", () => {
    const material = createRiverSurfaceMaterial(createRiverBody());
    expect(material.uniforms.fogColor).toBeDefined();
    expect(material.uniforms.fogNear).toBeDefined();
    expect(material.uniforms.fogFar).toBeDefined();
    expect(material.uniforms.fogDensity).toBeDefined();
    material.dispose();
  });

  it("blends the environment probe over the procedural sky at a roughness-biased LOD", () => {
    expect(RIVER_FRAGMENT_SHADER).toContain("uniform samplerCube uEnvMap;");
    expect(RIVER_FRAGMENT_SHADER).toContain("uniform float uEnvBlend;");
    expect(RIVER_FRAGMENT_SHADER).toContain("float envLod = 1.0 + uWindRoughness * 2.5 + uRainAgitation * 2.0;");
    expect(RIVER_FRAGMENT_SHADER).toContain("textureCubeLodEXT(uEnvMap, reflected, envLod)");
    expect(RIVER_FRAGMENT_SHADER).toContain("mix(sky, envColor, uEnvBlend)");
  });

  it("assembles shader sources deterministically", () => {
    const first = createRiverSurfaceMaterial(createRiverBody());
    const second = createRiverSurfaceMaterial(createRiverBody());
    expect(first.transparent).toBe(true);
    expect(first.depthWrite).toBe(false);
    expect(first.vertexShader).toBe(second.vertexShader);
    expect(first.fragmentShader).toBe(second.fragmentShader);
    expect(first.uniforms.uEnvBlend.value).toBe(second.uniforms.uEnvBlend.value);
    first.dispose();
    second.dispose();
  });

  it("lifts river troughs that would otherwise sink under the ground plane", () => {
    expect(RIVER_VERTEX_SHADER).toContain("uniform float uTroughLift");
    expect(RIVER_VERTEX_SHADER).toContain("displaced.y += wave + uTroughLift");
    const body = createRiverBody();
    body.river = {
      points: [
        [0, 0.04, 0],
        [12, 0.08, 4],
        [24, 0.02, 8],
      ],
      widthM: 6,
    };
    expect(riverSurfaceMinY(body)).toBeCloseTo(0.02, 10);
    const context: LivingWorldFrameContext = {
      worldSeconds: 4,
      frame: 96,
      fps: 24,
      isPlaying: false,
      seed: 7,
      settings: {
        enabled: true,
        seed: 7,
        wind: { directionDegrees: 0, speedMps: 0, gustiness: 0, turbulence: 0 },
        timeOfDay: { mode: "fixed", hours: 12, cycleMinutes: 12, drivesSky: false },
        weather: { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0 },
      },
      windVector: [0, 0, 0],
      groundHeight: 0,
    };
    const material = createRiverSurfaceMaterial(body);
    writeRiverFrameUniforms(material, body, context);
    expect(material.uniforms.uTroughLift.value).toBeCloseTo(
      computeWaterTroughLift(0.02, body.waveAmplitude * RIVER_WAVE_TROUGH_FACTOR, 0),
      10,
    );
    expect(material.uniforms.uTroughLift.value).toBeGreaterThan(0);
    material.dispose();
  });
});
