import { describe, expect, it } from "vitest";
import {
  createDirectorCharacterLocomotionMachineState,
  DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG,
  stepDirectorCharacterLocomotionMachine,
  type DirectorCharacterLocomotionMachineInput,
  type DirectorCharacterLocomotionMachineState,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionStateMachine";

const BASE_INPUT: DirectorCharacterLocomotionMachineInput = {
  frame: 0,
  timestampS: 0,
  speedMps: 0,
  walkSpeedMps: 2,
  runSpeedMps: 4,
  grounded: true,
  verticalSpeedMps: 0,
  jumpRequested: false,
};

function nextInput(overrides: Partial<DirectorCharacterLocomotionMachineInput>) {
  return { ...BASE_INPUT, ...overrides };
}

function emptyState() {
  return {} as DirectorCharacterLocomotionMachineState;
}

describe("Mixamo locomotion state machine", () => {
  it("uses caller-owned buffers and exposes renderer-ready idle output", () => {
    const state = createDirectorCharacterLocomotionMachineState(4, 0.2);
    const output = emptyState();
    const result = stepDirectorCharacterLocomotionMachine(
      state,
      nextInput({ frame: 5, timestampS: 0.25, speedMps: 0.1 }),
      output,
    );

    expect(result).toBe(output);
    expect(result).toMatchObject({
      mode: "idle",
      clipId: "idle",
      loop: "repeat",
      transitionDurationS: 0,
      normalizedSpeed: 0.025,
      lastFrame: 5,
      lastTimestampS: 0.25,
    });

    const inPlace = stepDirectorCharacterLocomotionMachine(
      result,
      nextInput({ frame: 6, timestampS: 0.3, speedMps: 0.1 }),
      result,
    );
    expect(inPlace).toBe(output);
    expect(inPlace.mode).toBe("idle");
  });

  it("applies minimum holds and separate walk/run hysteresis thresholds", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (frame: number, timestampS: number, speedMps: number) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput({ frame, timestampS, speedMps }), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    expect(step(1, 0.05, 1).mode).toBe("idle");
    expect(step(2, 0.13, 1).mode).toBe("walk");
    expect(previous.transitionDurationS).toBe(DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG.gaitTransitionS);

    // Between the walk enter (0.24 m/s) and exit (0.14 m/s) thresholds.
    expect(step(3, 0.3, 0.2).mode).toBe("walk");
    expect(step(4, 0.5, 3.5).mode).toBe("run");
    expect(previous.transitionDurationS).toBe(DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG.runTransitionS);

    // Between the run enter (3.24 m/s) and exit (2.84 m/s) thresholds.
    expect(step(5, 0.7, 3).mode).toBe("run");
    expect(step(6, 0.9, 2.7).mode).toBe("walk");
    expect(step(7, 1.1, 0.1).mode).toBe("idle");
  });

  it("latches takeoff, airborne, and landing instead of reacting to contact jitter", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput(overrides), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    expect(step({ frame: 1, timestampS: 0.01, jumpRequested: true, verticalSpeedMps: 7 }).jumpPhase).toBe("takeoff");
    expect(previous).toMatchObject({ clipId: "jump", loop: "once", mode: "jump", clipStartedFrame: 1 });
    expect(step({ frame: 2, timestampS: 0.05, grounded: false, verticalSpeedMps: 6 }).jumpPhase).toBe("takeoff");
    expect(step({ frame: 3, timestampS: 0.1, grounded: false, verticalSpeedMps: 4 }).jumpPhase).toBe("airborne");

    // A rising contact sample cannot land the actor.
    expect(step({ frame: 4, timestampS: 0.2, grounded: true, verticalSpeedMps: 1 }).jumpPhase).toBe("airborne");
    expect(step({ frame: 5, timestampS: 0.21, grounded: true, verticalSpeedMps: -1 }).jumpPhase).toBe("landing");

    // Landing stays latched even when collision contact flickers off.
    expect(step({ frame: 6, timestampS: 0.27, grounded: false, verticalSpeedMps: -0.2 }).jumpPhase).toBe("landing");
    expect(step({ frame: 7, timestampS: 0.34, grounded: true }).mode).toBe("idle");
  });

  it("buffers an airborne jump request until landing unlocks and restarts the one-shot clip", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput(overrides), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    step({ frame: 1, timestampS: 0.01, jumpRequested: true, verticalSpeedMps: 7 });
    step({ frame: 2, timestampS: 0.1, grounded: false, verticalSpeedMps: 3 });
    expect(step({ frame: 3, timestampS: 0.15, grounded: false, jumpRequested: true }).jumpQueued).toBe(true);
    expect(step({ frame: 4, timestampS: 0.2, grounded: true, verticalSpeedMps: -1 }).jumpPhase).toBe("landing");
    expect(step({ frame: 5, timestampS: 0.33, grounded: true }).jumpPhase).toBe("takeoff");
    expect(previous).toMatchObject({
      mode: "jump",
      jumpQueued: false,
      clipStartedFrame: 5,
      clipStartedAtS: 0.33,
    });
  });

  it("restarts immediately for a motor-confirmed landing-buffer impulse without leaving a phantom queue", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput(overrides), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    step({ frame: 1, timestampS: 0.01, grounded: false, jumpRequested: true, verticalSpeedMps: 7 });
    step({ frame: 2, timestampS: 0.1, grounded: false, verticalSpeedMps: 4 });
    step({ frame: 3, timestampS: 0.5, grounded: true, verticalSpeedMps: -1 });
    expect(previous).toMatchObject({ jumpPhase: "landing", clipStartedFrame: 1 });

    // The motor consumed its landing buffer and has already applied the second
    // upward impulse. This must restart the visual one-shot on the same frame.
    expect(
      step({ frame: 4, timestampS: 0.52, grounded: false, jumpRequested: true, verticalSpeedMps: 7 }),
    ).toMatchObject({
      mode: "jump",
      jumpPhase: "takeoff",
      jumpQueued: false,
      clipStartedFrame: 4,
    });

    step({ frame: 5, timestampS: 0.62, grounded: false, verticalSpeedMps: 4 });
    step({ frame: 6, timestampS: 1.3, grounded: true, verticalSpeedMps: -1 });
    expect(step({ frame: 7, timestampS: 1.45, grounded: true })).toMatchObject({
      mode: "idle",
      jumpPhase: "none",
      jumpQueued: false,
    });
  });

  it("absorbs brief contact losses on step-downs without flashing the jump clip", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput(overrides), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    expect(step({ frame: 1, timestampS: 0.15, speedMps: 1 }).mode).toBe("walk");

    // Two 60 fps frames of lost contact on a step-down seam stay in the gait.
    expect(step({ frame: 2, timestampS: 0.2, speedMps: 1, grounded: false, verticalSpeedMps: -0.5 }).mode).toBe("walk");
    expect(step({ frame: 3, timestampS: 0.216, speedMps: 1, grounded: false, verticalSpeedMps: -0.5 }).mode).toBe(
      "walk",
    );
    expect(step({ frame: 4, timestampS: 0.233, speedMps: 1 })).toMatchObject({ mode: "walk", jumpPhase: "none" });

    // A genuine fall exceeds the grace and still becomes airborne.
    expect(step({ frame: 5, timestampS: 0.3, speedMps: 1, grounded: false, verticalSpeedMps: -2 }).mode).toBe("walk");
    expect(step({ frame: 6, timestampS: 0.35, speedMps: 1, grounded: false, verticalSpeedMps: -3 })).toMatchObject({
      mode: "jump",
      jumpPhase: "airborne",
      transitionDurationS: DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG.jumpTransitionS,
    });

    // A motor-confirmed jump keeps bypassing the grace entirely.
    let fresh = createDirectorCharacterLocomotionMachineState();
    const freshOutput = emptyState();
    stepDirectorCharacterLocomotionMachine(
      fresh,
      nextInput({ frame: 1, timestampS: 0.01, jumpRequested: true, verticalSpeedMps: 7 }),
      freshOutput,
    );
    fresh = freshOutput;
    expect(fresh).toMatchObject({ mode: "jump", jumpPhase: "takeoff" });
  });

  it("resolves takeoff and airborne through sustained rising contact instead of dead-locking", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput(overrides), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    // Jump on a rising lift: contact never breaks and vertical speed stays
    // above the landing threshold, which previously dead-locked takeoff.
    expect(step({ frame: 1, timestampS: 0.01, jumpRequested: true, verticalSpeedMps: 1 }).jumpPhase).toBe("takeoff");
    expect(step({ frame: 2, timestampS: 0.1, verticalSpeedMps: 1 }).jumpPhase).toBe("takeoff");
    expect(step({ frame: 3, timestampS: 0.26, verticalSpeedMps: 1 }).jumpPhase).toBe("landing");
    expect(step({ frame: 4, timestampS: 0.4, verticalSpeedMps: 0.5 })).toMatchObject({
      mode: "idle",
      jumpPhase: "none",
    });

    // Airborne onto a riser that keeps a positive vertical velocity.
    expect(step({ frame: 5, timestampS: 0.6, jumpRequested: true, verticalSpeedMps: 7 }).jumpPhase).toBe("takeoff");
    expect(step({ frame: 6, timestampS: 0.7, grounded: false, verticalSpeedMps: 3 }).jumpPhase).toBe("airborne");
    expect(step({ frame: 7, timestampS: 0.8, verticalSpeedMps: 1 }).jumpPhase).toBe("airborne");
    expect(step({ frame: 8, timestampS: 0.9, verticalSpeedMps: 1 }).jumpPhase).toBe("airborne");
    expect(step({ frame: 9, timestampS: 0.96, verticalSpeedMps: 1 }).jumpPhase).toBe("landing");
  });

  it("settles landing recovery over the regular gait blend instead of the takeoff cut", () => {
    let previous = createDirectorCharacterLocomotionMachineState();
    let output = emptyState();
    const step = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(previous, nextInput(overrides), output);
      const swap = previous;
      previous = output;
      output = swap;
      return previous;
    };

    expect(step({ frame: 1, timestampS: 0.01, jumpRequested: true, verticalSpeedMps: 7 }).transitionDurationS).toBe(
      DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG.jumpTransitionS,
    );
    step({ frame: 2, timestampS: 0.1, grounded: false, verticalSpeedMps: 3 });
    step({ frame: 3, timestampS: 0.5, verticalSpeedMps: -1 });
    expect(step({ frame: 4, timestampS: 0.65, speedMps: 3.6 })).toMatchObject({
      mode: "run",
      jumpPhase: "none",
      transitionDurationS: DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG.runTransitionS,
    });

    let fresh = createDirectorCharacterLocomotionMachineState();
    let freshOutput = emptyState();
    const stepFresh = (overrides: Partial<DirectorCharacterLocomotionMachineInput>) => {
      stepDirectorCharacterLocomotionMachine(fresh, nextInput(overrides), freshOutput);
      const swap = fresh;
      fresh = freshOutput;
      freshOutput = swap;
      return fresh;
    };
    stepFresh({ frame: 1, timestampS: 0.01, jumpRequested: true, verticalSpeedMps: 7 });
    stepFresh({ frame: 2, timestampS: 0.1, grounded: false, verticalSpeedMps: 3 });
    stepFresh({ frame: 3, timestampS: 0.5, verticalSpeedMps: -1 });
    expect(stepFresh({ frame: 4, timestampS: 0.65 })).toMatchObject({
      mode: "idle",
      jumpPhase: "none",
      transitionDurationS: DEFAULT_DIRECTOR_CHARACTER_LOCOMOTION_MACHINE_CONFIG.gaitTransitionS,
    });
  });

  it("is deterministic from frame/timestamp inputs and clamps regressing clocks", () => {
    const first = createDirectorCharacterLocomotionMachineState();
    const second = createDirectorCharacterLocomotionMachineState();
    const firstOutput = emptyState();
    const secondOutput = emptyState();
    const input = nextInput({ frame: 12, timestampS: 0.5, speedMps: 3.6 });

    stepDirectorCharacterLocomotionMachine(first, input, firstOutput);
    stepDirectorCharacterLocomotionMachine(second, input, secondOutput);
    expect(firstOutput).toEqual(secondOutput);
    expect(firstOutput).toMatchObject({ mode: "run", clipId: "run", loop: "repeat", normalizedSpeed: 0.9 });

    stepDirectorCharacterLocomotionMachine(
      firstOutput,
      nextInput({ frame: 8, timestampS: 0.25, speedMps: 3.6 }),
      firstOutput,
    );
    expect(firstOutput.lastFrame).toBe(12);
    expect(firstOutput.lastTimestampS).toBe(0.5);
  });
});
