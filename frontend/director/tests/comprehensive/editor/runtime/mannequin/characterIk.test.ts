import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { BODY_TYPE_OPTIONS } from "../../../../../src/comprehensive/editor/runtime/mannequin/bodyTypes";
import {
  createTwoBoneIkRuntime,
  getCharacterIkChainGeometry,
  getDefaultCharacterIkTarget,
  solveCharacterIkRotations,
  solveTwoBoneIk,
  solveTwoBoneIkInto,
  type CharacterIkVector,
} from "../../../../../src/comprehensive/editor/runtime/mannequin/characterIk";

function distance(left: CharacterIkVector, right: CharacterIkVector) {
  return new Vector3(...left).distanceTo(new Vector3(...right));
}

describe("analytic character IK", () => {
  it("reaches a valid target while preserving both bone lengths", () => {
    const solution = solveTwoBoneIk({
      root: [0, 0, 0],
      target: [1, -1, 0],
      pole: [0, 0, 1],
      upperLength: 1,
      lowerLength: 1,
    });

    expect(solution.reachable).toBe(true);
    expect(solution.clamped).toBe(false);
    expect(solution.end).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(distance(solution.end, [1, -1, 0])).toBeLessThan(1e-5);
    expect(distance(solution.root, solution.middle)).toBeCloseTo(1, 6);
    expect(distance(solution.middle, solution.end)).toBeCloseTo(1, 6);
    expect(solution.middle[2]).toBeGreaterThan(0);
  });

  it("uses the pole to choose a deterministic bend side", () => {
    const positive = solveTwoBoneIk({
      root: [0, 0, 0],
      target: [0, -1, 0],
      pole: [0, 0, 1],
      upperLength: 1,
      lowerLength: 1,
    });
    const negative = solveTwoBoneIk({
      root: [0, 0, 0],
      target: [0, -1, 0],
      pole: [0, 0, -1],
      upperLength: 1,
      lowerLength: 1,
    });

    expect(positive.middle[2]).toBeGreaterThan(0);
    expect(negative.middle[2]).toBeLessThan(0);
  });

  it("clamps unreachable targets instead of stretching the chain", () => {
    const solution = solveTwoBoneIk({
      root: [0, 0, 0],
      target: [10, 0, 0],
      pole: [0, 0, 1],
      upperLength: 1,
      lowerLength: 1,
      reachClamp: 0.75,
    });

    expect(solution.reachable).toBe(false);
    expect(solution.clamped).toBe(true);
    expect(solution.distance).toBeCloseTo(1.5, 5);
    expect(distance(solution.root, solution.middle)).toBeCloseTo(1, 6);
    expect(distance(solution.middle, solution.end)).toBeCloseTo(1, 6);
  });

  it("stays finite and repeatable for coincident targets and poles", () => {
    const input = {
      root: [0, 0, 0] as CharacterIkVector,
      target: [0, 0, 0] as CharacterIkVector,
      pole: [0, 0, 0] as CharacterIkVector,
      upperLength: 0.6,
      lowerLength: 0.4,
    };
    const first = solveTwoBoneIk(input);
    const second = solveTwoBoneIk(input);

    expect(first).toEqual(second);
    expect([...first.middle, ...first.end, first.distance].every(Number.isFinite)).toBe(true);
    expect(distance(first.root, first.middle)).toBeCloseTo(0.6, 6);
    expect(distance(first.middle, first.end)).toBeCloseTo(0.4, 6);
  });

  it("updates one stable runtime solution without replacing its vectors", () => {
    const runtime = createTwoBoneIkRuntime();
    const first = solveTwoBoneIkInto(
      {
        root: [0, 0, 0],
        target: [1, -1, 0],
        pole: [0, 0, 1],
        upperLength: 1,
        lowerLength: 1,
      },
      runtime,
    );
    const middle = first.middle;
    const end = first.end;
    const second = solveTwoBoneIkInto(
      {
        root: [0, 0, 0],
        target: [-1, -1, 0],
        pole: [0, 0, -1],
        upperLength: 1,
        lowerLength: 1,
      },
      runtime,
    );

    expect(second).toBe(first);
    expect(second.middle).toBe(middle);
    expect(second.end).toBe(end);
    expect(distance(second.end, [-1, -1, 0])).toBeLessThan(1e-5);
    expect(second.middle[2]).toBeLessThan(0);
  });

  it("preserves the authored pose exactly at zero IK weight", () => {
    const upperBase: CharacterIkVector = [0.2, -0.1, 0.4];
    const lowerBase: CharacterIkVector = [-0.3, 0, 0];
    const resolved = solveCharacterIkRotations({
      chain: { root: [0, 1, 0], upperRestVector: [0, -0.5, 0], lowerRestVector: [0, -0.5, 0] },
      effector: { target: [1, 1, 0], pole: [0, 1, 1], weight: 0, reachClamp: 1 },
      upperBaseRotation: upperBase,
      lowerBaseRotation: lowerBase,
    });

    expect(resolved.upperRotation).toEqual(upperBase);
    expect(resolved.lowerRotation).toEqual(lowerBase);
  });

  it("provides valid rest goals for every body type and effector", () => {
    BODY_TYPE_OPTIONS.forEach(({ bodyType }) => {
      (["leftHand", "rightHand", "leftFoot", "rightFoot"] as const).forEach((effector) => {
        const chain = getCharacterIkChainGeometry(bodyType, effector);
        const target = getDefaultCharacterIkTarget(bodyType, effector);
        const resolved = solveCharacterIkRotations({
          chain,
          effector: target,
          upperBaseRotation: [0, 0, 0],
          lowerBaseRotation: [0, 0, 0],
        });
        expect([...resolved.upperRotation, ...resolved.lowerRotation].every(Number.isFinite)).toBe(true);
        expect(resolved.solution.reachable).toBe(true);
      });
    });
  });
});
