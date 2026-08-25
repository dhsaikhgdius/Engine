import { describe, expect, it } from "vitest";
import type { DirectorWorldWaterBody } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import {
  GERSTNER_FORMULATION_MARKER,
  WATER_GERSTNER_WAVE_COUNT,
  createGerstnerWaveSet,
  sumGerstnerAmplitudes,
} from "../../../../../src/comprehensive/editor/world/water/gerstner";
import {
  WATER_FRAGMENT_SHADER,
  WATER_VERTEX_SHADER,
  createWaterSurfaceMaterial,
  createWaterSurfaceUniforms,
  writeGerstnerWaveDirectionUniforms,
  writeGerstnerWaveStaticUniforms,
  writeWaterFrameUniforms,
  type WaterFrameState,
} from "../../../../../src/comprehensive/editor/world/water/waterMaterial";
import {
  WATER_FOAM_CREST_END,
  WATER_FOAM_CREST_START,
  computeWaterTroughLift,
} from "../../../../../src/comprehensive/editor/world/water/waterParams";

function createBody(overrides: Partial<DirectorWorldWaterBody> = {}): DirectorWorldWaterBody {
  return {
    id: "water_lake_1",
    name: "湖面",
    surface: { center: [4, 0.2, -6], sizeX: 40, sizeZ: 28, rotationDegrees: 30 },
    waveAmplitude: 0.5,
    waveLengthM: 10,
    flowDirectionDegrees: 90,
    flowSpeedMps: 1,
    colorShallow: "#58c4d9",
    colorDeep: "#0a3f5c",
    opacity: 0.8,
    foamIntensity: 0.7,
    visible: true,
    locked: false,
    ...overrides,
  };
}

function createContext(overrides: Partial<LivingWorldFrameContext> = {}): LivingWorldFrameContext {
  return {
    worldSeconds: 3.25,
    frame: 78,
    fps: 24,
    isPlaying: false,
    seed: 20_260_813,
    settings: {
      enabled: true,
      seed: 20_260_813,
      wind: { directionDegrees: 45, speedMps: 2.5, gustiness: 0, turbulence: 0 },
      timeOfDay: { mode: "fixed", hours: 12, cycleMinutes: 12, drivesSky: false },
      weather: { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0 },
    },
    windVector: [3, 0, 4],
    groundHeight: 0,
    ...overrides,
  };
}

function createFrameState(): WaterFrameState {
  const body = createBody();
  const context = createContext();
  const waves = createGerstnerWaveSet({
    worldSeed: context.seed,
    bodyId: body.id,
    waveAmplitude: body.waveAmplitude,
    waveLengthM: body.waveLengthM,
    flowSpeedMps: body.flowSpeedMps,
  });
  return { context, body, waves, amplitudeSum: sumGerstnerAmplitudes(waves), occluderHeight: 0 };
}

describe("water shader assembly", () => {
  it("embeds the shared Gerstner formulation in the vertex stage", () => {
    expect(WATER_VERTEX_SHADER).toContain(GERSTNER_FORMULATION_MARKER);
    expect(WATER_VERTEX_SHADER).toContain("directorGerstnerEvaluate(anchorWorld.xz, uTime");
    expect(WATER_VERTEX_SHADER).toContain(`uGerstnerWaveA[${WATER_GERSTNER_WAVE_COUNT}]`);
    expect(WATER_VERTEX_SHADER).toContain("uniform float uTroughLift");
    expect(WATER_VERTEX_SHADER).toContain("vec3(0.0, uTroughLift, 0.0)");
  });

  it("mirrors the foam crest constants and converts output color space", () => {
    expect(WATER_FRAGMENT_SHADER).toContain(WATER_FOAM_CREST_START.toFixed(3));
    expect(WATER_FRAGMENT_SHADER).toContain(WATER_FOAM_CREST_END.toFixed(3));
    expect(WATER_FRAGMENT_SHADER).toContain("#include <colorspace_fragment>");
    expect(WATER_FRAGMENT_SHADER).toContain("uDetailScrollA");
    expect(WATER_FRAGMENT_SHADER).toContain("uDetailScrollB");
  });

  it("creates a transparent, non-depth-writing material deterministically", () => {
    const first = createWaterSurfaceMaterial();
    const second = createWaterSurfaceMaterial();
    expect(first.transparent).toBe(true);
    expect(first.depthWrite).toBe(false);
    expect(first.vertexShader).toBe(second.vertexShader);
    expect(first.fragmentShader).toBe(second.fragmentShader);
    expect(first.uniforms.uTime.value).toBe(second.uniforms.uTime.value);
    first.dispose();
    second.dispose();
  });

  it("defaults the environment probe uniforms to the procedural fallback", () => {
    const uniforms = createWaterSurfaceUniforms();
    expect(uniforms.uEnvBlend.value).toBe(0);
    expect(uniforms.uEnvMap.value).toBeNull();
    expect(uniforms.uOcclusionBlend.value).toBe(0);
    const material = createWaterSurfaceMaterial();
    expect(material.uniforms.uEnvBlend.value).toBe(0);
    expect(material.uniforms.uEnvMap.value).toBeNull();
    material.dispose();
  });

  it("blends the environment probe over the procedural sky at a roughness-biased LOD", () => {
    expect(WATER_FRAGMENT_SHADER).toContain("uniform samplerCube uEnvMap;");
    expect(WATER_FRAGMENT_SHADER).toContain("uniform float uEnvBlend;");
    expect(WATER_FRAGMENT_SHADER).toContain("float envLod = 1.0 + uMicroRipple * 2.5 + uRainAgitation * 2.0;");
    expect(WATER_FRAGMENT_SHADER).toContain("textureCubeLodEXT(uEnvMap, reflectDir, envLod)");
    expect(WATER_FRAGMENT_SHADER).toContain("mix(skyColor, envColor, uEnvBlend)");
    expect(WATER_FRAGMENT_SHADER).toContain("mix(bodyColor, reflectionColor, fresnel)");
    expect(WATER_FRAGMENT_SHADER).toContain("uOcclusionMap");
    expect(WATER_FRAGMENT_SHADER).toContain("directorWorldHeightMapUv");
    expect(WATER_FRAGMENT_SHADER).toContain("float shore = rim * shoreBand * inMap * uOcclusionBlend");
  });
});

describe("water uniform writers", () => {
  it("packs static wave halves and per-frame unit directions", () => {
    const uniforms = createWaterSurfaceUniforms();
    const { waves } = createFrameState();
    writeGerstnerWaveStaticUniforms(uniforms, waves);
    writeGerstnerWaveDirectionUniforms(uniforms, waves, Math.PI / 3);
    for (let index = 0; index < WATER_GERSTNER_WAVE_COUNT; index += 1) {
      const wave = waves[index];
      const packedA = uniforms.uGerstnerWaveA.value[index];
      const packedB = uniforms.uGerstnerWaveB.value[index];
      expect(packedA.z).toBe(wave.waveNumber);
      expect(packedA.w).toBe(wave.angularFrequency);
      expect(packedB.x).toBe(wave.amplitudeM);
      expect(packedB.w).toBe(wave.phaseOffsetRadians);
      expect(Math.hypot(packedA.x, packedA.y)).toBeCloseTo(1, 10);
    }
  });

  it("writes the full frame state as pure uniform values", () => {
    const uniforms = createWaterSurfaceUniforms();
    const frame = createFrameState();
    writeWaterFrameUniforms(uniforms, frame);

    expect(uniforms.uTime.value).toBe(frame.context.worldSeconds);
    expect(uniforms.uOpacity.value).toBe(frame.body.opacity);
    expect(uniforms.uFoamIntensity.value).toBe(frame.body.foamIntensity);
    // |wind| = 5 m/s → amplitude ×1.2, choppiness ×1.15 (clamped contract).
    expect(uniforms.uGerstnerAmplitudeScale.value).toBeCloseTo(1.2, 10);
    expect(uniforms.uGerstnerSteepnessScale.value).toBeCloseTo(1.15, 10);
    // Fixed noon, clear sky → full specular pointing upward.
    expect(uniforms.uSunIntensity.value).toBeCloseTo(1, 6);
    expect(uniforms.uSunDirection.value.y).toBeGreaterThan(0.8);
    expect(uniforms.uFlowDirection.value.length()).toBeCloseTo(1, 10);
    // Detail layers scroll at different rates along the same flow direction.
    expect(uniforms.uTroughLift.value).toBeCloseTo(
      computeWaterTroughLift(
        frame.body.surface.center[1],
        frame.amplitudeSum * uniforms.uGerstnerAmplitudeScale.value,
        frame.context.groundHeight,
      ),
      10,
    );
    expect(uniforms.uDetailScrollB.value.length()).toBeGreaterThan(uniforms.uDetailScrollA.value.length());
    const crossAlignment =
      uniforms.uDetailScrollA.value.x * uniforms.uDetailScrollB.value.y -
      uniforms.uDetailScrollA.value.y * uniforms.uDetailScrollB.value.x;
    expect(crossAlignment).toBeCloseTo(0, 10);
  });

  it("is deterministic across repeated writes", () => {
    const first = createWaterSurfaceUniforms();
    const second = createWaterSurfaceUniforms();
    const frame = createFrameState();
    writeWaterFrameUniforms(first, frame);
    writeWaterFrameUniforms(second, frame);
    expect(first.uTime.value).toBe(second.uTime.value);
    expect(first.uSunIntensity.value).toBe(second.uSunIntensity.value);
    expect(first.uSunDirection.value.toArray()).toEqual(second.uSunDirection.value.toArray());
    expect(first.uFlowDirection.value.toArray()).toEqual(second.uFlowDirection.value.toArray());
    expect(first.uGerstnerWaveA.value.map((packed) => packed.toArray())).toEqual(
      second.uGerstnerWaveA.value.map((packed) => packed.toArray()),
    );
  });

  it("keeps night-time specular dim but non-zero (moon glint)", () => {
    const uniforms = createWaterSurfaceUniforms();
    const frame = createFrameState();
    frame.context = createContext({
      settings: {
        ...createContext().settings,
        timeOfDay: { mode: "fixed", hours: 0, cycleMinutes: 12, drivesSky: false },
      },
    });
    writeWaterFrameUniforms(uniforms, frame);
    expect(uniforms.uSunIntensity.value).toBeGreaterThan(0);
    expect(uniforms.uSunIntensity.value).toBeLessThanOrEqual(0.05);
  });

  it("lifts a pond whose troughs would otherwise sink under the ground plane", () => {
    const uniforms = createWaterSurfaceUniforms();
    const body = createBody({
      surface: { center: [4, 0.05, -6], sizeX: 12, sizeZ: 8, rotationDegrees: 0 },
      waveAmplitude: 0.08,
    });
    const context = createContext({ groundHeight: 0 });
    const waves = createGerstnerWaveSet({
      worldSeed: context.seed,
      bodyId: body.id,
      waveAmplitude: body.waveAmplitude,
      waveLengthM: body.waveLengthM,
      flowSpeedMps: body.flowSpeedMps,
    });
    const frame: WaterFrameState = {
      context,
      body,
      waves,
      amplitudeSum: sumGerstnerAmplitudes(waves),
      occluderHeight: 0,
    };
    writeWaterFrameUniforms(uniforms, frame);
    const effectiveAmplitude = frame.amplitudeSum * uniforms.uGerstnerAmplitudeScale.value;
    expect(uniforms.uTroughLift.value).toBeGreaterThan(0);
    expect(body.surface.center[1] - effectiveAmplitude + uniforms.uTroughLift.value).toBeGreaterThanOrEqual(
      context.groundHeight,
    );
  });

  it("lifts past one amplitude when a sampled occluder is taller than the pond mean", () => {
    const uniforms = createWaterSurfaceUniforms();
    const body = createBody({
      surface: { center: [4, 0.05, -6], sizeX: 12, sizeZ: 8, rotationDegrees: 0 },
      waveAmplitude: 0.08,
    });
    const context = createContext({ groundHeight: 0 });
    const waves = createGerstnerWaveSet({
      worldSeed: context.seed,
      bodyId: body.id,
      waveAmplitude: body.waveAmplitude,
      waveLengthM: body.waveLengthM,
      flowSpeedMps: body.flowSpeedMps,
    });
    const frame: WaterFrameState = {
      context,
      body,
      waves,
      amplitudeSum: sumGerstnerAmplitudes(waves),
      occluderHeight: 0.08,
    };
    writeWaterFrameUniforms(uniforms, frame);
    const effectiveAmplitude = frame.amplitudeSum * uniforms.uGerstnerAmplitudeScale.value;
    expect(uniforms.uTroughLift.value).toBeGreaterThan(effectiveAmplitude);
    expect(body.surface.center[1] - effectiveAmplitude + uniforms.uTroughLift.value).toBeGreaterThan(0.08);
  });
});
