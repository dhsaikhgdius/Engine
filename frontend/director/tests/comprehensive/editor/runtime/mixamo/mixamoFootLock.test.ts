import { describe, expect, it } from "vitest";
import type { DirectorCharacterIkTarget } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  createMixamoFootLockState,
  DEFAULT_MIXAMO_FOOT_LOCK_CONFIG,
  stepMixamoFootLock,
  writeMixamoFootLockOutputToIkTarget,
  type MixamoFootLockConfig,
  type MixamoFootLockFrameInput,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoFootLock";

const TEST_CONFIG: Readonly<MixamoFootLockConfig> = {
  ...DEFAULT_MIXAMO_FOOT_LOCK_CONFIG,
  contactHeightM: 0.05,
  releaseHeightM: 0.12,
  contactVerticalSpeedMps: 0.15,
  releaseVerticalSpeedMps: 0.6,
  contactHorizontalSpeedMps: 0.2,
  releaseHorizontalSpeedMps: 0.8,
  contactDelayS: 0.03,
  releaseDelayS: 0.03,
  maxCorrectionM: 0.15,
  correctionSmoothingHz: 20,
  weightSmoothingHz: 20,
};

function frame({
  left = [0, 0.03, 0],
  right = [0.3, 0.03, 0],
  grounded = true,
  locomotionMode = "walk",
  actionKey = "walk",
  deltaS = 0.01,
}: {
  left?: readonly [number, number, number];
  right?: readonly [number, number, number];
  grounded?: boolean;
  locomotionMode?: string;
  actionKey?: string;
  deltaS?: number;
} = {}): MixamoFootLockFrameInput {
  return {
    deltaS,
    grounded,
    locomotionMode,
    actionKey,
    leftFoot: { positionWorld: left, groundHeightWorld: 0 },
    rightFoot: { positionWorld: right, groundHeightWorld: 0 },
  };
}

function settle(state: ReturnType<typeof createMixamoFootLockState>, input = frame(), count = 8) {
  for (let index = 0; index < count; index += 1) stepMixamoFootLock(state, input, TEST_CONFIG);
}

describe("Mixamo foot lock", () => {
  it("uses the prepared X Bot foot-height band for default contact hysteresis", () => {
    expect(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHeightM).toBe(0.14);
    expect(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseHeightM).toBe(0.22);
    expect(DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.releaseHeightM).toBeGreaterThan(
      DEFAULT_MIXAMO_FOOT_LOCK_CONFIG.contactHeightM,
    );
  });

  it("locks left and right feet independently from height and velocity contacts", () => {
    const state = createMixamoFootLockState();
    const output = state.output;
    const leftTarget = output.leftFoot.targetWorld;
    let movingRightX = 0.3;

    for (let index = 0; index < 8; index += 1) {
      movingRightX += 0.02;
      expect(stepMixamoFootLock(state, frame({ right: [movingRightX, 0.03, 0] }), TEST_CONFIG)).toBe(output);
    }

    expect(output.leftFoot.locked).toBe(true);
    expect(output.rightFoot.locked).toBe(false);
    expect(output.leftFoot.targetWorld).toBe(leftTarget);
    expect(output.rightFoot.horizontalVelocityMps).toBeGreaterThan(TEST_CONFIG.contactHorizontalSpeedMps);

    settle(state, frame({ right: [movingRightX, 0.03, 0] }));
    expect(output.leftFoot.locked).toBe(true);
    expect(output.rightFoot.locked).toBe(true);
  });

  it("uses separate acquire/release thresholds and release delay hysteresis", () => {
    const state = createMixamoFootLockState();
    const heightOnlyConfig = { ...TEST_CONFIG, releaseVerticalSpeedMps: 10 };
    settle(state);
    expect(state.leftFoot.locked).toBe(true);

    stepMixamoFootLock(state, frame({ left: [0, 0.08, 0] }), heightOnlyConfig);
    expect(state.leftFoot.locked).toBe(true);

    stepMixamoFootLock(state, frame({ left: [0, 0.15, 0] }), heightOnlyConfig);
    expect(state.leftFoot.locked).toBe(true);
    stepMixamoFootLock(state, frame({ left: [0, 0.15, 0] }), heightOnlyConfig);
    expect(state.leftFoot.locked).toBe(true);
    stepMixamoFootLock(state, frame({ left: [0, 0.15, 0] }), heightOnlyConfig);
    expect(state.leftFoot.locked).toBe(false);
    expect(state.rightFoot.locked).toBe(true);
  });

  it("rejects fast vertical contacts and releases a planted foot on sustained lift speed", () => {
    const state = createMixamoFootLockState();
    for (let index = 0; index < 8; index += 1) {
      stepMixamoFootLock(state, frame({ left: [0, index % 2 === 0 ? 0.03 : 0.04, 0] }), TEST_CONFIG);
    }
    expect(state.leftFoot.locked).toBe(false);

    settle(state, frame({ left: [0, 0.03, 0] }));
    expect(state.leftFoot.locked).toBe(true);

    stepMixamoFootLock(state, frame({ left: [0, 0.04, 0] }), TEST_CONFIG);
    stepMixamoFootLock(state, frame({ left: [0, 0.05, 0] }), TEST_CONFIG);
    stepMixamoFootLock(state, frame({ left: [0, 0.06, 0] }), TEST_CONFIG);
    expect(state.leftFoot.locked).toBe(false);
    expect(state.output.leftFoot.verticalVelocityMps).toBeGreaterThan(TEST_CONFIG.releaseVerticalSpeedMps);
  });

  it("forces both locks and weights off for physical airborne, jump, and fly frames", () => {
    const state = createMixamoFootLockState();
    settle(state);
    expect(state.output.leftFoot.weight).toBeGreaterThan(0);
    expect(state.output.rightFoot.weight).toBeGreaterThan(0);

    stepMixamoFootLock(state, frame({ grounded: false }), TEST_CONFIG);
    expect(state.output.leftFoot).toMatchObject({ locked: false, weight: 0 });
    expect(state.output.rightFoot).toMatchObject({ locked: false, weight: 0 });

    settle(state);
    stepMixamoFootLock(state, frame({ locomotionMode: "jump" }), TEST_CONFIG);
    expect(state.output.leftFoot.weight).toBe(0);
    expect(state.output.rightFoot.weight).toBe(0);

    settle(state);
    stepMixamoFootLock(state, frame({ locomotionMode: "fly" }), TEST_CONFIG);
    expect(state.output.leftFoot.weight).toBe(0);
    expect(state.output.rightFoot.weight).toBe(0);
  });

  it("suppresses transition velocity spikes and bounds the IK correction after an action switch", () => {
    const state = createMixamoFootLockState();
    settle(state, frame({ actionKey: "walk" }), 30);
    const previousWeight = state.output.leftFoot.weight;

    stepMixamoFootLock(state, frame({ left: [1, 0.03, 0], actionKey: "run", locomotionMode: "run" }), TEST_CONFIG);

    expect(state.leftFoot.locked).toBe(true);
    expect(state.output.leftFoot.horizontalVelocityMps).toBe(0);
    expect(Math.abs(state.output.leftFoot.targetWorld[0] - 1)).toBeLessThanOrEqual(TEST_CONFIG.maxCorrectionM);
    expect(Math.abs(state.output.leftFoot.weight - previousWeight)).toBeLessThan(0.001);

    settle(state, frame({ left: [1, 0.03, 0], actionKey: "run", locomotionMode: "run" }), 4);
    expect(state.leftFoot.locked).toBe(false);
    expect(Math.abs(state.output.leftFoot.targetWorld[0] - 1)).toBeLessThanOrEqual(TEST_CONFIG.maxCorrectionM);
  });

  it("is deterministic and reuses output objects and target tuples across frames", () => {
    const first = createMixamoFootLockState();
    const second = createMixamoFootLockState();
    const firstOutput = first.output;
    const firstLeftTarget = first.output.leftFoot.targetWorld;
    const sequence = [
      frame(),
      frame({ left: [0.001, 0.031, 0] }),
      frame({ left: [0.002, 0.03, 0] }),
      frame({ left: [0.003, 0.03, 0] }),
      frame({ left: [0.003, 0.08, 0] }),
    ];

    sequence.forEach((input) => {
      expect(stepMixamoFootLock(first, input, TEST_CONFIG)).toBe(firstOutput);
      stepMixamoFootLock(second, input, TEST_CONFIG);
    });

    expect(first.output.leftFoot.targetWorld).toBe(firstLeftTarget);
    expect(first.output).toEqual(second.output);
    expect(first.leftFoot.lockPositionWorld).toEqual(second.leftFoot.lockPositionWorld);
  });

  it("writes a world target and weight into reusable Director-local foot IK state", () => {
    const state = createMixamoFootLockState();
    state.output.leftFoot.targetWorld[0] = 2;
    state.output.leftFoot.targetWorld[1] = 3;
    state.output.leftFoot.targetWorld[2] = 4;
    state.output.leftFoot.weight = 0.75;
    const ikTarget: DirectorCharacterIkTarget = {
      target: [0, 0, 0],
      pole: [0, 0.5, 1],
      weight: 0,
      reachClamp: 0.92,
    };
    const worldToDirectorLocal = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, -2, -3, 1];

    expect(writeMixamoFootLockOutputToIkTarget(state.output.leftFoot, worldToDirectorLocal, ikTarget)).toBe(ikTarget);
    expect(ikTarget).toEqual({
      target: [1, 1, 1],
      pole: [0, 0.5, 1],
      weight: 0.75,
      reachClamp: 0.92,
    });
  });
});
