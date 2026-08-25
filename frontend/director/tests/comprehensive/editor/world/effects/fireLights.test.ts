import { describe, expect, it } from "vitest";
import type { DirectorWorldEffect } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { ResolvedWorldEffect } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import {
  FIRE_LIGHT_BASE_INTENSITY,
  FIRE_LIGHT_MAX_DISTANCE,
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
