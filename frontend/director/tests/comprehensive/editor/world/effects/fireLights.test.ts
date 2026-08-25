import { describe, expect, it } from "vitest";
import type { DirectorWorldEffect } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { ResolvedWorldEffect } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import {
  FIRE_LIGHT_BASE_INTENSITY,
  FIRE_LIGHT_FLICKER_MAX,
  FIRE_LIGHT_FLICKER_MIN,
  FIRE_LIGHT_MAX_DISTANCE,
  FIRE_LIGHT_MIN_BURN_DIM,
  FIRE_LIGHT_MIN_DISTANCE,
  FIRE_SHADOW_BIAS,
  FIRE_SHADOW_CAMERA_NEAR,
  FIRE_SHADOW_MAP_SIZE,
  MAX_FIRE_LIGHTS,
  computeFireLightState,
  selectFireLightEffects,
  selectShadowCastingFireId,
} from "../../../../../src/comprehensive/editor/world/effects/fireLights";

const WORLD_SEED = 20_260_813;

function createEffect(overrides: Partial<DirectorWorldEffect> = {}): DirectorWorldEffect {
  return {
    id: "fx_fire_1",
    name: "篝火火焰",
    kind: "fire",
    anchor: { objectId: null, position: [0, 0, 0] },
    shape: { type: "point" },
    intensity: 1,
    sizeScale: 1,
    speedScale: 1,
    windInfluence: 0.5,
    seedOffset: 0,
    visible: true,
    locked: false,
    createdAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

function resolved(overrides: Partial<DirectorWorldEffect> = {}): ResolvedWorldEffect {
  return { effect: createEffect(overrides), origin: [0, 0, 0] };
}

describe("fire light selection", () => {
  it("caps the selection at the light budget and prefers higher intensity", () => {
    const fires = Array.from({ length: 12 }, (_, index) =>
      resolved({ id: `fx_fire_${String(index).padStart(2, "0")}`, intensity: 0.25 + index * 0.2 }),
    );
    const selected = selectFireLightEffects(fires);
    expect(selected).toHaveLength(MAX_FIRE_LIGHTS);
    const intensities = selected.map((entry) => entry.effect.intensity);
    expect(intensities).toEqual([...intensities].sort((a, b) => b - a));
    // The four weakest fires are the ones dropped.
    expect(intensities.every((value) => value > 0.25 + 3 * 0.2)).toBe(true);
  });

  it("breaks intensity ties by id for a stable order", () => {
    const fires = [
      resolved({ id: "fx_fire_c", intensity: 1 }),
      resolved({ id: "fx_fire_a", intensity: 1 }),
      resolved({ id: "fx_fire_b", intensity: 1 }),
    ];
    const ids = selectFireLightEffects(fires).map((entry) => entry.effect.id);
    expect(ids).toEqual(["fx_fire_a", "fx_fire_b", "fx_fire_c"]);
    // Input order must not matter.
    const shuffledIds = selectFireLightEffects([fires[2], fires[0], fires[1]]).map((entry) => entry.effect.id);
    expect(shuffledIds).toEqual(ids);
  });

  it("ignores non-fire kinds and disabled fires", () => {
    const entries = [
      resolved({ id: "fx_smoke", kind: "smoke", intensity: 3 }),
      resolved({ id: "fx_fire_off", intensity: 0 }),
      resolved({ id: "fx_fire_on", intensity: 0.5 }),
    ];
    const ids = selectFireLightEffects(entries).map((entry) => entry.effect.id);
    expect(ids).toEqual(["fx_fire_on"]);
  });

  it("honors a custom budget", () => {
    const fires = Array.from({ length: 5 }, (_, index) => resolved({ id: `fx_fire_${index}`, intensity: 1 + index }));
    expect(selectFireLightEffects(fires, 2)).toHaveLength(2);
    expect(selectFireLightEffects(fires, 0)).toHaveLength(0);
  });
});

describe("fire shadow budget", () => {
  it("selects exactly the single highest-intensity fire", () => {
    const fires = [
      resolved({ id: "fx_fire_a", intensity: 0.4 }),
      resolved({ id: "fx_fire_b", intensity: 1.6 }),
      resolved({ id: "fx_fire_c", intensity: 0.9 }),
    ];
    expect(selectShadowCastingFireId(fires)).toBe("fx_fire_b");
    // Must agree with the head of the light-budget ordering.
    expect(selectShadowCastingFireId(fires)).toBe(selectFireLightEffects(fires)[0].effect.id);
  });

  it("is stable across input order and breaks intensity ties by id", () => {
    const fires = [
      resolved({ id: "fx_fire_c", intensity: 1 }),
      resolved({ id: "fx_fire_a", intensity: 1 }),
      resolved({ id: "fx_fire_b", intensity: 1 }),
    ];
    expect(selectShadowCastingFireId(fires)).toBe("fx_fire_a");
    expect(selectShadowCastingFireId([fires[2], fires[0], fires[1]])).toBe("fx_fire_a");
  });

  it("returns null when no fire qualifies", () => {
    expect(selectShadowCastingFireId([])).toBeNull();
    expect(selectShadowCastingFireId([resolved({ id: "fx_smoke", kind: "smoke", intensity: 2 })])).toBeNull();
    expect(selectShadowCastingFireId([resolved({ id: "fx_fire_off", intensity: 0 })])).toBeNull();
  });

  it("keeps the shadow camera inside the light falloff with a negative bias", () => {
    expect(FIRE_SHADOW_MAP_SIZE).toBe(512);
    expect(FIRE_SHADOW_CAMERA_NEAR).toBeGreaterThan(0);
    expect(FIRE_SHADOW_CAMERA_NEAR).toBeLessThan(FIRE_LIGHT_MIN_DISTANCE);
    expect(FIRE_SHADOW_BIAS).toBeLessThan(0);
  });
});

describe("fire light flicker", () => {
  it("is a pure function of (effect, worldSeed, worldSeconds)", () => {
    const effect = createEffect();
    expect(computeFireLightState(effect, WORLD_SEED, 12.5)).toEqual(computeFireLightState(effect, WORLD_SEED, 12.5));
    expect(computeFireLightState(effect, WORLD_SEED, 12.5)).not.toEqual(
      computeFireLightState(effect, WORLD_SEED, 12.6),
    );
  });

  it("keeps the flicker inside its authored band", () => {
    const effect = createEffect();
    for (let step = 0; step < 200; step += 1) {
      const state = computeFireLightState(effect, WORLD_SEED, step * 0.137);
      expect(state.flicker).toBeGreaterThanOrEqual(0.56);
      expect(state.flicker).toBeLessThanOrEqual(1.0);
      expect(state.intensity).toBeGreaterThan(0);
    }
  });

  it("decorrelates flicker phases across effects", () => {
    const first = createEffect({ id: "fx_fire_1" });
    const second = createEffect({ id: "fx_fire_2" });
    const samples = Array.from({ length: 20 }, (_, index) => index * 0.31);
    const identical = samples.every(
      (time) =>
        computeFireLightState(first, WORLD_SEED, time).flicker ===
        computeFireLightState(second, WORLD_SEED, time).flicker,
    );
    expect(identical).toBe(false);
  });

  it("scales distance with sizeScale and intensity inside the [8, 15] clamp", () => {
    // 6 x 2 x 1.5 = 18 clamps to the 15 m perf ceiling.
    expect(computeFireLightState(createEffect({ sizeScale: 2, intensity: 1.5 }), WORLD_SEED, 0).distance).toBe(15);
    // 6 x 1.2 x 1.5 = 10.8 sits inside the clamp untouched.
    expect(computeFireLightState(createEffect({ sizeScale: 1.2, intensity: 1.5 }), WORLD_SEED, 0).distance).toBeCloseTo(
      10.8,
      10,
    );
    // Tiny embers keep a usable 8 m floor.
    expect(computeFireLightState(createEffect({ sizeScale: 0.1, intensity: 0.1 }), WORLD_SEED, 0).distance).toBe(8);
  });
});

describe("fire light environment coupling", () => {
  it("defaults to the calm dry state so legacy call sites are unchanged", () => {
    const effect = createEffect();
    for (const time of [0, 3.7, 12.5]) {
      expect(computeFireLightState(effect, WORLD_SEED, time)).toEqual(
        computeFireLightState(effect, WORLD_SEED, time, {}),
      );
      expect(computeFireLightState(effect, WORLD_SEED, time)).toEqual(
        computeFireLightState(effect, WORLD_SEED, time, { burnFactor: 1, windSpeedMps: 0 }),
      );
    }
  });

  it("dims the light with the burn factor down to the residual floor", () => {
    const effect = createEffect();
    const dry = computeFireLightState(effect, WORLD_SEED, 5);
    const damp = computeFireLightState(effect, WORLD_SEED, 5, { burnFactor: 0.5 });
    const soaked = computeFireLightState(effect, WORLD_SEED, 5, { burnFactor: 0 });
    expect(damp.intensity).toBeLessThan(dry.intensity);
    expect(soaked.intensity).toBeLessThan(damp.intensity);
    expect(soaked.intensity).toBeCloseTo(dry.intensity * FIRE_LIGHT_MIN_BURN_DIM, 10);
    // Burn never touches the flicker signal itself — only the amplitude.
    expect(soaked.flicker).toBe(dry.flicker);
  });

  it("deepens the flicker with wind while staying inside the hard clamp", () => {
    const effect = createEffect({ windInfluence: 1 });
    let calmMin = Number.POSITIVE_INFINITY;
    let calmMax = Number.NEGATIVE_INFINITY;
    let windyMin = Number.POSITIVE_INFINITY;
    let windyMax = Number.NEGATIVE_INFINITY;
    for (let step = 0; step < 400; step += 1) {
      const time = step * 0.083;
      const calm = computeFireLightState(effect, WORLD_SEED, time).flicker;
      const windy = computeFireLightState(effect, WORLD_SEED, time, { windSpeedMps: 12 }).flicker;
      calmMin = Math.min(calmMin, calm);
      calmMax = Math.max(calmMax, calm);
      windyMin = Math.min(windyMin, windy);
      windyMax = Math.max(windyMax, windy);
      expect(windy).toBeGreaterThanOrEqual(FIRE_LIGHT_FLICKER_MIN);
      expect(windy).toBeLessThanOrEqual(FIRE_LIGHT_FLICKER_MAX);
    }
    // Wind widens the gutter band on both sides.
    expect(windyMin).toBeLessThan(calmMin);
    expect(windyMax).toBeGreaterThan(calmMax);
  });

  it("shields sheltered fires (windInfluence 0) from wind guttering", () => {
    const sheltered = createEffect({ windInfluence: 0 });
    for (const time of [0.4, 2.9, 7.3]) {
      expect(computeFireLightState(sheltered, WORLD_SEED, time, { windSpeedMps: 20 }).flicker).toBe(
        computeFireLightState(sheltered, WORLD_SEED, time).flicker,
      );
    }
  });

  it("stays a pure function of its full input tuple", () => {
    const effect = createEffect();
    const environment = { burnFactor: 0.4, windSpeedMps: 8 };
    expect(computeFireLightState(effect, WORLD_SEED, 9.1, environment)).toEqual(
      computeFireLightState(effect, WORLD_SEED, 9.1, { ...environment }),
    );
  });
});
