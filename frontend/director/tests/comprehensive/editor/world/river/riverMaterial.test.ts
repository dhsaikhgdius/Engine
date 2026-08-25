import { describe, expect, it } from "vitest";
import type { DirectorWorldWaterBody } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import { evaluateWorldClimate } from "../../../../../src/comprehensive/editor/world/worldClimate";
import { computeWaterTroughLift } from "../../../../../src/comprehensive/editor/world/water/waterParams";
import {
  RIVER_FRAGMENT_SHADER,
  RIVER_VERTEX_SHADER,
  RIVER_WAVE_TROUGH_FACTOR,
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
    const settings = {
      enabled: true,
      seed: 7,
      wind: { directionDegrees: 0, speedMps: 0, gustiness: 0, turbulence: 0 },
      timeOfDay: { mode: "fixed" as const, hours: 12, cycleMinutes: 12, drivesSky: false },
      weather: { preset: "clear" as const, intensity: 0.5, wetness: 0, cloudCover: 0 },
    };
    const context: LivingWorldFrameContext = {
      worldSeconds: 4,
      frame: 96,
      fps: 24,
      isPlaying: false,
      seed: 7,
      settings,
      climate: evaluateWorldClimate(settings, 4),
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
