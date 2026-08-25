import { describe, expect, it } from "vitest";
import {
  DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS,
  getDirectorDirectionalClipAvailability,
  getDirectorDirectionalLocomotionClipId,
  sampleDirectorDirectionalBlend,
  type DirectorDirectionalBlendState,
  type DirectorDirectionalBlendWeights,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoDirectionalBlend";

const WALK = { mode: "walk", playbackRate: 1.2, weight: 1 } as const;
const ALL_DIRECTIONS = { forward: true, backward: true, left: true, right: true } as const;

function total(weights: DirectorDirectionalBlendWeights) {
  return DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.reduce((sum, direction) => sum + weights[direction], 0);
}

function expectFiniteState(state: DirectorDirectionalBlendState) {
  DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.forEach((direction) => {
    expect(Number.isFinite(state.intentWeights[direction])).toBe(true);
    expect(Number.isFinite(state.weights[direction])).toBe(true);
  });
  expect(Number.isFinite(state.activity)).toBe(true);
  expect(Number.isFinite(state.playbackRate)).toBe(true);
  expect(Number.isFinite(state.turnLeanDeg)).toBe(true);
}

describe("Mixamo directional Blend Space", () => {
  it("maps both gaits onto the packaged four-direction Mixamo catalog", () => {
    expect(
      DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) =>
        getDirectorDirectionalLocomotionClipId("walk", direction),
      ),
    ).toEqual(["walk", "walk-back", "walk-left", "walk-right"]);
    expect(
      DIRECTOR_DIRECTIONAL_BLEND_DIRECTIONS.map((direction) =>
        getDirectorDirectionalLocomotionClipId("run", direction),
      ),
    ).toEqual(["run", "run-back", "run-left", "run-right"]);
    expect(getDirectorDirectionalClipAvailability("run", (clipId) => clipId !== "run-left")).toEqual({
      forward: true,
      backward: true,
      left: false,
      right: true,
    });
  });

  it("normalizes diagonal local velocity into forward/right weights", () => {
    const result = sampleDirectorDirectionalBlend({
      localVelocityX: 2,
      localVelocityZ: 2,
      angularVelocityRadS: 0,
      locomotion: WALK,
      clipAvailability: ALL_DIRECTIONS,
    });

    expect(result.intentWeights).toEqual({ forward: 0.5, backward: 0, left: 0, right: 0.5 });
    expect(result.weights).toEqual(result.intentWeights);
    expect(total(result.weights)).toBe(1);
    expect(result.activity).toBe(1);
    expect(result.playbackRate).toBe(1.2);
    expect(result.fallback.mode).toBe("native");
  });

  it("uses a deadzone and rejects non-finite input without producing NaN", () => {
    const still = sampleDirectorDirectionalBlend({
      localVelocityX: 0.02,
      localVelocityZ: 0.03,
      angularVelocityRadS: Number.POSITIVE_INFINITY,
      locomotion: { mode: "walk", playbackRate: Number.NaN, weight: Number.NaN },
      clipAvailability: ALL_DIRECTIONS,
    });
    const malformed = sampleDirectorDirectionalBlend({
      localVelocityX: Number.NaN,
      localVelocityZ: Number.NEGATIVE_INFINITY,
      angularVelocityRadS: Number.NaN,
      locomotion: { mode: "run", playbackRate: Number.POSITIVE_INFINITY, weight: 1 },
    });

    expect(still.weights).toEqual({ forward: 0, backward: 0, left: 0, right: 0 });
    expect(still.activity).toBe(0);
    expect(still.playbackRate).toBe(1);
    expectFiniteState(still);
    expectFiniteState(malformed);
  });

  it("smooths direction, cadence, activity, and turn lean toward explicit targets", () => {
    const previous: DirectorDirectionalBlendState = {
      intentWeights: { forward: 1, backward: 0, left: 0, right: 0 },
      weights: { forward: 1, backward: 0, left: 0, right: 0 },
      activity: 0.4,
      playbackRate: 1,
      turnLeanDeg: 0,
    };
    const input = {
      localVelocityX: 3,
      localVelocityZ: 0,
      angularVelocityRadS: Math.PI,
      locomotion: { mode: "run", playbackRate: 1.8, weight: 1 } as const,
      clipAvailability: ALL_DIRECTIONS,
      previous,
      deltaS: 1 / 60,
    };
    const result = sampleDirectorDirectionalBlend(input);
    const repeated = sampleDirectorDirectionalBlend(input);

    expect(result.target.weights.right).toBe(1);
    expect(result.weights.forward).toBeGreaterThan(0);
    expect(result.weights.right).toBeGreaterThan(0);
    expect(total(result.weights)).toBeCloseTo(1, 12);
    expect(result.playbackRate).toBeGreaterThan(1);
    expect(result.playbackRate).toBeLessThan(1.8);
    expect(result.activity).toBeGreaterThan(0.4);
    expect(result.activity).toBeLessThan(1);
    expect(result.turnLeanDeg).toBeGreaterThan(0);
    expect(result.turnLeanDeg).toBeLessThan(result.target.turnLeanDeg);
    expect(repeated).toEqual(result);
  });

  it("prunes imperceptible residual weights so inactive clips stop sampling", () => {
    let previous: DirectorDirectionalBlendState = {
      intentWeights: { forward: 1, backward: 0, left: 0, right: 0 },
      weights: { forward: 1, backward: 0, left: 0, right: 0 },
      activity: 1,
      playbackRate: 1,
      turnLeanDeg: 0,
    };

    for (let frame = 0; frame < 120; frame += 1) {
      previous = sampleDirectorDirectionalBlend({
        localVelocityX: 2,
        localVelocityZ: 0,
        angularVelocityRadS: 0,
        locomotion: WALK,
        clipAvailability: ALL_DIRECTIONS,
        previous,
        deltaS: 1 / 60,
      });
    }

    expect(previous.weights).toEqual({ forward: 0, backward: 0, left: 0, right: 1 });
    expect(previous.intentWeights).toEqual(previous.weights);
  });

  it("degrades backward and strafe intent onto the packaged forward-only clip", () => {
    const result = sampleDirectorDirectionalBlend({
      localVelocityX: 1,
      localVelocityZ: -1,
      angularVelocityRadS: 0,
      locomotion: WALK,
    });

    expect(result.intentWeights).toEqual({ forward: 0, backward: 0.5, left: 0, right: 0.5 });
    expect(result.weights).toEqual({ forward: 1, backward: 0, left: 0, right: 0 });
    expect(result.fallback).toMatchObject({
      mode: "remapped",
      availableDirections: ["forward"],
      missingIntentDirections: ["backward", "right"],
      resolvedDirectionByIntent: {
        forward: "forward",
        backward: "forward",
        left: "forward",
        right: "forward",
      },
    });
  });

  it("returns an explicit unavailable result when a catalog has no directional clips", () => {
    const result = sampleDirectorDirectionalBlend({
      localVelocityX: -1,
      localVelocityZ: 0,
      angularVelocityRadS: 1,
      locomotion: WALK,
      clipAvailability: {},
    });

    expect(result.intentWeights.left).toBe(1);
    expect(result.weights).toEqual({ forward: 0, backward: 0, left: 0, right: 0 });
    expect(result.activity).toBe(0);
    expect(result.fallback.mode).toBe("unavailable");
    expect(result.fallback.resolvedDirectionByIntent.left).toBeNull();
  });

  it("keeps non-gait states out of the ground locomotion Blend Space", () => {
    for (const mode of ["idle", "jump", "fly"] as const) {
      const result = sampleDirectorDirectionalBlend({
        localVelocityX: 3,
        localVelocityZ: 4,
        angularVelocityRadS: 2,
        locomotion: { mode, playbackRate: 2, weight: 1 },
        clipAvailability: ALL_DIRECTIONS,
      });
      expect(result.weights).toEqual({ forward: 0, backward: 0, left: 0, right: 0 });
      expect(result.activity).toBe(0);
      expect(result.playbackRate).toBe(1);
      expect(result.turnLeanDeg).toBe(0);
    }
  });

  it("stays normalized, finite, and deterministic across varied numeric inputs", () => {
    for (let index = 0; index < 512; index += 1) {
      const input = {
        localVelocityX: Math.sin(index * 0.37) * 12,
        localVelocityZ: Math.cos(index * 0.23) * 12,
        angularVelocityRadS: Math.sin(index * 0.11) * Math.PI * 4,
        locomotion: {
          mode: index % 2 ? ("walk" as const) : ("run" as const),
          playbackRate: 0.2 + (index % 30) / 10,
          weight: (index % 11) / 10,
        },
        clipAvailability: index % 3 ? ALL_DIRECTIONS : ({ forward: true } as const),
      };
      const first = sampleDirectorDirectionalBlend(input);
      const second = sampleDirectorDirectionalBlend(input);
      expectFiniteState(first);
      expect(total(first.intentWeights)).toBeCloseTo(1, 10);
      expect(total(first.weights)).toBeCloseTo(1, 10);
      expect(second).toEqual(first);
    }
  });
});
