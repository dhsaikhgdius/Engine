import { describe, expect, it } from "vitest";
import {
  GERSTNER_FORMULATION_MARKER,
  GERSTNER_GRAVITY_MPS2,
  GERSTNER_SHARED_GLSL,
  WATER_GERSTNER_WAVE_COUNT,
  createGerstnerWaveSet,
  evaluateGerstnerSurface,
  evaluateGerstnerSurfaceInto,
  getGerstnerWaveDirectionRadians,
  sumGerstnerAmplitudes,
  type GerstnerSurfaceParams,
  type GerstnerWave,
  type GerstnerWaveSetInput,
} from "../../../../../src/comprehensive/editor/world/water/gerstner";

const BASE_INPUT: GerstnerWaveSetInput = {
  worldSeed: 20_260_813,
  bodyId: "water_lake_1",
  waveAmplitude: 0.8,
  waveLengthM: 12,
  flowSpeedMps: 1.5,
};

function createParams(overrides: Partial<GerstnerSurfaceParams> = {}): GerstnerSurfaceParams {
  return {
    waves: createGerstnerWaveSet(BASE_INPUT),
    baseDirectionRadians: (45 * Math.PI) / 180,
    amplitudeScale: 1,
    steepnessScale: 1,
    ...overrides,
  };
}

describe("gerstner wave set derivation", () => {
  it("is deterministic for identical inputs", () => {
    expect(createGerstnerWaveSet(BASE_INPUT)).toEqual(createGerstnerWaveSet(BASE_INPUT));
  });

  it("derives different wave direction sets for different body ids", () => {
    const lake = createGerstnerWaveSet(BASE_INPUT);
    const river = createGerstnerWaveSet({ ...BASE_INPUT, bodyId: "water_river_2" });
    const lakeOffsets = lake.map((wave) => wave.directionOffsetRadians);
    const riverOffsets = river.map((wave) => wave.directionOffsetRadians);
    expect(lakeOffsets).not.toEqual(riverOffsets);
  });

  it("keeps every wave travelling within 90° of the base flow direction", () => {
    const waves = createGerstnerWaveSet(BASE_INPUT);
    expect(waves).toHaveLength(WATER_GERSTNER_WAVE_COUNT);
    waves.forEach((wave) => {
      expect(Math.abs(getGerstnerWaveDirectionRadians(0, wave))).toBeLessThan(Math.PI / 2);
    });
  });

  it("normalizes amplitudes so their sum equals the authored amplitude", () => {
    const waves = createGerstnerWaveSet(BASE_INPUT);
    expect(sumGerstnerAmplitudes(waves)).toBeCloseTo(BASE_INPUT.waveAmplitude, 10);
  });

  it("keeps still bodies undulating through the dispersion term", () => {
    const still = createGerstnerWaveSet({ ...BASE_INPUT, flowSpeedMps: 0 });
    still.forEach((wave) => {
      expect(wave.angularFrequency).toBeCloseTo(Math.sqrt(GERSTNER_GRAVITY_MPS2 * wave.waveNumber), 10);
      expect(wave.angularFrequency).toBeGreaterThan(0);
    });
  });
});

describe("evaluateGerstnerSurface", () => {
  it("returns identical outputs for identical inputs", () => {
    const params = createParams();
    expect(evaluateGerstnerSurface(params, 3.7, -8.2, 12.34)).toEqual(
      evaluateGerstnerSurface(params, 3.7, -8.2, 12.34),
    );
  });

  it("produces unit-length normals even at wind-scaled extremes", () => {
    const params = createParams({ amplitudeScale: 1.6, steepnessScale: 1.45 });
    for (let sample = 0; sample < 60; sample += 1) {
      const x = (sample % 6) * 2.13 - 5;
      const z = Math.floor(sample / 6) * 1.71 - 7;
      const t = sample * 0.37;
      const { normalX, normalY, normalZ } = evaluateGerstnerSurface(params, x, z, t);
      expect(Math.abs(Math.hypot(normalX, normalY, normalZ) - 1)).toBeLessThanOrEqual(1e-6);
    }
  });

  it("bounds displacement magnitude by the scaled sum of amplitudes", () => {
    const params = createParams({ amplitudeScale: 1.6, steepnessScale: 1.45 });
    const bound = sumGerstnerAmplitudes(params.waves) * params.amplitudeScale + 1e-9;
    for (let sample = 0; sample < 80; sample += 1) {
      const x = (sample % 8) * 3.31 - 12;
      const z = Math.floor(sample / 8) * 2.47 - 9;
      const t = sample * 0.29;
      const { offsetX, offsetY, offsetZ } = evaluateGerstnerSurface(params, x, z, t);
      expect(Math.hypot(offsetX, offsetY, offsetZ)).toBeLessThanOrEqual(bound);
    }
  });

  it("yields a flat surface with an up normal at zero amplitude", () => {
    const params = createParams({ waves: createGerstnerWaveSet({ ...BASE_INPUT, waveAmplitude: 0 }) });
    const sample = evaluateGerstnerSurface(params, 4.2, -1.7, 9.9);
    expect(sample.offsetX).toBe(0);
    expect(sample.offsetY).toBe(0);
    expect(sample.offsetZ).toBe(0);
    expect(sample.normalX).toBeCloseTo(0, 12);
    expect(sample.normalY).toBeCloseTo(1, 12);
    expect(sample.normalZ).toBeCloseTo(0, 12);
  });

  it("advances the wave pattern along the flow direction as t grows", () => {
    // A single synthetic wave isolates the advection check: the whole field
    // at t + Δt must equal the field at t shifted by phaseSpeed·Δt along the
    // travel direction (φ is invariant under x → x + cΔt, t → t + Δt).
    const waveNumber = (2 * Math.PI) / 10;
    const wave: GerstnerWave = {
      directionOffsetRadians: 0,
      wavelengthM: 10,
      waveNumber,
      amplitudeM: 0.5,
      steepness: 0.7,
      steepnessLimit: 1,
      angularFrequency: Math.sqrt(GERSTNER_GRAVITY_MPS2 * waveNumber) + waveNumber * 2,
      phaseOffsetRadians: 1.23,
    };
    const baseDirectionRadians = (30 * Math.PI) / 180;
    const params: GerstnerSurfaceParams = { waves: [wave], baseDirectionRadians, amplitudeScale: 1, steepnessScale: 1 };

    const phaseSpeed = wave.angularFrequency / wave.waveNumber;
    expect(phaseSpeed).toBeGreaterThan(0);

    const deltaT = 0.37;
    const shiftX = Math.sin(baseDirectionRadians) * phaseSpeed * deltaT;
    const shiftZ = Math.cos(baseDirectionRadians) * phaseSpeed * deltaT;
    for (const [x, z, t] of [
      [0, 0, 0],
      [2.5, -1.5, 3.1],
      [-4.2, 6.6, 8.8],
    ]) {
      const before = evaluateGerstnerSurface(params, x, z, t);
      const after = evaluateGerstnerSurface(params, x + shiftX, z + shiftZ, t + deltaT);
      expect(after.offsetX).toBeCloseTo(before.offsetX, 9);
      expect(after.offsetY).toBeCloseTo(before.offsetY, 9);
      expect(after.offsetZ).toBeCloseTo(before.offsetZ, 9);
    }

    // Every wave of a derived set also moves forward (positive phase speed,
    // direction within the forward half-plane), so the summed pattern drifts
    // monotonically downstream.
    createGerstnerWaveSet(BASE_INPUT).forEach((setWave) => {
      expect(setWave.angularFrequency / setWave.waveNumber).toBeGreaterThan(0);
      expect(Math.cos(setWave.directionOffsetRadians)).toBeGreaterThan(0);
    });
  });

  it("writes into a reusable sample object without reallocating", () => {
    const params = createParams();
    const target = { offsetX: 0, offsetY: 0, offsetZ: 0, normalX: 0, normalY: 1, normalZ: 0 };
    const returned = evaluateGerstnerSurfaceInto(target, params, 1, 2, 3);
    expect(returned).toBe(target);
    expect(returned).toEqual(evaluateGerstnerSurface(params, 1, 2, 3));
  });
});

describe("shared GLSL formulation", () => {
  it("carries the pairing marker and mirrored entry point", () => {
    expect(GERSTNER_SHARED_GLSL).toContain(GERSTNER_FORMULATION_MARKER);
    expect(GERSTNER_SHARED_GLSL).toContain("directorGerstnerEvaluate");
    expect(GERSTNER_SHARED_GLSL).toContain(`uGerstnerWaveA[${WATER_GERSTNER_WAVE_COUNT}]`);
    expect(GERSTNER_SHARED_GLSL).toContain(`uGerstnerWaveB[${WATER_GERSTNER_WAVE_COUNT}]`);
  });

  it("is a stable string across accesses (deterministic shader assembly)", () => {
    expect(GERSTNER_SHARED_GLSL).toBe(GERSTNER_SHARED_GLSL);
    expect(GERSTNER_SHARED_GLSL.length).toBeGreaterThan(0);
  });
});
