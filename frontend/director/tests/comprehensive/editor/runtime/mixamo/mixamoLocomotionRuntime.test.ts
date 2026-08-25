import { Group } from "three";
import { describe, expect, it } from "vitest";
import {
  advanceDirectorCharacterLocomotionClock,
  clearDirectorCharacterLocomotionRuntimeState,
  createDirectorLocomotionRigBlendRuntime,
  DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
  DIRECTOR_CHARACTER_GAIT_BASE_PLAYBACK_RATE,
  getDirectorCharacterLocomotionClipId,
  parseDirectorCharacterLocomotionRuntimeState,
  readDirectorCharacterLocomotionRuntimeState,
  resolveDirectorCharacterLocomotionTransitionDurationS,
  resolveDirectorLocomotionRigLayers,
  sampleDirectorCharacterLocomotionBlend,
  sampleDirectorCharacterLocomotionRigOwnership,
  sampleDirectorCharacterLocomotionTime,
  updateDirectorLocomotionRigBlendRuntime,
  writeDirectorCharacterLocomotionRuntimeState,
} from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime";

describe("Mixamo locomotion runtime contract", () => {
  it("publishes a clamped ephemeral state outside userData and resolves it from descendants", () => {
    const owner = new Group();
    const characterRuntime = new Group();
    owner.userData = { directorObjectId: "character-1" };
    owner.add(characterRuntime);

    writeDirectorCharacterLocomotionRuntimeState(owner, { mode: "run", timeS: 1.25, weight: 4 });

    expect(readDirectorCharacterLocomotionRuntimeState(characterRuntime)).toEqual({
      version: 1,
      mode: "run",
      timeS: 1.25,
      speedMps: 0,
      normalizedPhase: 0,
      playbackRate: 1,
      weight: 1,
      localVelocityX: 0,
      localVelocityZ: 0,
      angularVelocityRadS: 0,
      verticalVelocityMps: 0,
      grounded: false,
      jumpPhase: "none",
      crouching: false,
      transitionDurationS: DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
      clipStartedFrame: 0,
    });
    expect(owner.userData).toEqual({ directorObjectId: "character-1" });

    // Simulate R3F replacing the declarative userData prop during an unrelated
    // React render. The frame-local locomotion contract must remain intact.
    owner.userData = { directorObjectId: "character-1", directorObjectKind: "character" };
    expect(readDirectorCharacterLocomotionRuntimeState(characterRuntime)?.mode).toBe("run");

    clearDirectorCharacterLocomotionRuntimeState(owner);
    expect(readDirectorCharacterLocomotionRuntimeState(characterRuntime)).toBeNull();
  });

  it("rejects malformed userData and maps runtime modes to packaged clips deterministically", () => {
    expect(
      parseDirectorCharacterLocomotionRuntimeState({ version: 1, mode: "teleport", timeS: 0, weight: 1 }),
    ).toBeNull();
    expect(parseDirectorCharacterLocomotionRuntimeState({ version: 1, mode: "walk", timeS: -1, weight: 1 })).toBeNull();
    expect(getDirectorCharacterLocomotionClipId("walk")).toBe("walk");
    expect(getDirectorCharacterLocomotionClipId("fly")).toBe("idle");
  });

  it("loops continuous locomotion but clamps the one-shot jump", () => {
    const run = { version: 1, mode: "run", timeS: 2.75, weight: 1 } as const;
    const jump = { ...run, mode: "jump" } as const;
    expect(sampleDirectorCharacterLocomotionTime(run, 1)).toBeCloseTo(0.75);
    expect(sampleDirectorCharacterLocomotionTime(jump, 1)).toBe(1);
  });

  it("uses a bounded 160 ms smooth crossfade for locomotion transitions", () => {
    expect(DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S).toBe(0.16);
    expect(sampleDirectorCharacterLocomotionBlend(-1)).toBe(0);
    expect(sampleDirectorCharacterLocomotionBlend(0)).toBe(0);
    expect(sampleDirectorCharacterLocomotionBlend(0.08)).toBeCloseTo(0.5);
    expect(sampleDirectorCharacterLocomotionBlend(0.16)).toBe(1);
    expect(sampleDirectorCharacterLocomotionBlend(2)).toBe(1);
    expect(sampleDirectorCharacterLocomotionBlend(0.01, 0)).toBe(1);
  });

  it("floors bookkeeping zero transitions to the default crossfade but keeps authored ones", () => {
    // A freshly created machine state (roam entry, emote end, fly landing)
    // publishes 0; rendering that literally produced a one-frame hard cut.
    expect(resolveDirectorCharacterLocomotionTransitionDurationS(0)).toBe(DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S);
    expect(resolveDirectorCharacterLocomotionTransitionDurationS(-1)).toBe(DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S);
    expect(resolveDirectorCharacterLocomotionTransitionDurationS(Number.NaN)).toBe(
      DIRECTOR_CHARACTER_LOCOMOTION_CROSSFADE_S,
    );
    expect(resolveDirectorCharacterLocomotionTransitionDurationS(0.1)).toBe(0.1);
    expect(resolveDirectorCharacterLocomotionTransitionDurationS(0.4)).toBe(0.4);
    expect(resolveDirectorCharacterLocomotionTransitionDurationS(2.5)).toBe(1);
  });

  it("keeps upper-body controls and hand IK while locomotion owns pelvis, legs, and feet", () => {
    const leftHand = {
      target: [0.4, 1.2, 0.2] as [number, number, number],
      pole: [0.7, 1, 0] as [number, number, number],
      weight: 0.8,
      reachClamp: 0.95,
    };
    const leftFoot = {
      target: [0.2, 0, 0.1] as [number, number, number],
      pole: [0.3, 0.5, 0] as [number, number, number],
      weight: 1,
      reachClamp: 0.98,
    };
    const result = resolveDirectorLocomotionRigLayers(
      {
        "body.yaw": 20,
        "torso.yaw": 15,
        "head.pitch": -8,
        "leftShoulder.pitch": 35,
        "leftHip.pitch": 42,
        "rightKnee.bend": 68,
        "leftFoot.roll": 10,
      },
      { leftHand, leftFoot },
    );

    expect(result.controls).toEqual({
      "torso.yaw": 15,
      "head.pitch": -8,
      "leftShoulder.pitch": 35,
    });
    expect(result.ik).toEqual({ leftHand });
  });

  it("smoothly hands non-neutral hips and knees to and from runtime at transition midpoints", () => {
    const controls = {
      "body.offsetY": 0.24,
      "torso.yaw": 15,
      "leftHip.pitch": 42,
      "rightKnee.bend": 68,
    };
    const original = { ...controls };
    const runtime = createDirectorLocomotionRigBlendRuntime();
    const midpoint = sampleDirectorCharacterLocomotionBlend(0.08, 0.16);
    const enterOwnership = sampleDirectorCharacterLocomotionRigOwnership({
      phase: "enter",
      alpha: midpoint,
      runtimeWeight: 1,
      fromWeight: 0,
      runtimeActive: true,
    });
    const entering = updateDirectorLocomotionRigBlendRuntime(runtime, controls, undefined, enterOwnership);

    expect(enterOwnership).toBeCloseTo(0.5);
    expect(entering.controls).toMatchObject({
      "body.offsetY": 0.12,
      "torso.yaw": 15,
      "leftHip.pitch": 21,
      "rightKnee.bend": 34,
    });

    const exitOwnership = sampleDirectorCharacterLocomotionRigOwnership({
      phase: "exit",
      alpha: midpoint,
      runtimeWeight: 0,
      fromWeight: 1,
      runtimeActive: false,
    });
    const exiting = updateDirectorLocomotionRigBlendRuntime(runtime, controls, undefined, exitOwnership);

    expect(exitOwnership).toBeCloseTo(0.5);
    expect(exiting).toBe(entering);
    expect(exiting.controls).toMatchObject({
      "body.offsetY": 0.12,
      "torso.yaw": 15,
      "leftHip.pitch": 21,
      "rightKnee.bend": 34,
    });
    expect(controls).toEqual(original);
  });

  it("keeps normalized foot phase across walk/run and calibrates cadence to packaged stride", () => {
    const idle = {
      mode: "idle",
      timeS: 0,
      speedMps: 0,
      normalizedPhase: 0,
      playbackRate: 1,
    } as const;
    const walkStart = advanceDirectorCharacterLocomotionClock({
      previous: idle,
      mode: "walk",
      deltaS: 1 / 60,
      speedMps: 1.7,
      walkSpeedMps: 1.7,
      runSpeedMps: 3.3,
    });
    const walking = advanceDirectorCharacterLocomotionClock({
      previous: walkStart,
      mode: "walk",
      deltaS: 0.5,
      speedMps: 1.7,
      walkSpeedMps: 1.7,
      runSpeedMps: 3.3,
    });
    const running = advanceDirectorCharacterLocomotionClock({
      previous: walking,
      mode: "run",
      deltaS: 1 / 60,
      speedMps: 3.3,
      walkSpeedMps: 1.7,
      runSpeedMps: 3.3,
    });

    expect(walking.timeS).toBeCloseTo(0.1 * DIRECTOR_CHARACTER_GAIT_BASE_PLAYBACK_RATE.walk);
    expect(running.normalizedPhase).toBeCloseTo(walking.normalizedPhase, 6);
    expect(running.playbackRate).toBeCloseTo(DIRECTOR_CHARACTER_GAIT_BASE_PLAYBACK_RATE.run);
    expect(walking.playbackRate).toBeGreaterThan(running.playbackRate);
  });

  it("publishes directional and jump diagnostics and restarts an explicitly queued one-shot", () => {
    const owner = new Group();
    writeDirectorCharacterLocomotionRuntimeState(owner, {
      mode: "jump",
      timeS: 0.42,
      speedMps: 2.1,
      normalizedPhase: 0.3,
      playbackRate: 2.65,
      weight: 1,
      localVelocityX: -0.7,
      localVelocityZ: 1.9,
      angularVelocityRadS: 0.8,
      verticalVelocityMps: 5.2,
      grounded: false,
      jumpPhase: "airborne",
      transitionDurationS: 0.1,
      clipStartedFrame: 42,
    });

    expect(readDirectorCharacterLocomotionRuntimeState(owner)).toMatchObject({
      mode: "jump",
      localVelocityX: -0.7,
      localVelocityZ: 1.9,
      angularVelocityRadS: 0.8,
      verticalVelocityMps: 5.2,
      grounded: false,
      jumpPhase: "airborne",
      transitionDurationS: 0.1,
      clipStartedFrame: 42,
    });

    const restarted = advanceDirectorCharacterLocomotionClock({
      previous: {
        mode: "jump",
        timeS: 0.42,
        speedMps: 2.1,
        normalizedPhase: 0.3,
        playbackRate: 2.65,
      },
      mode: "jump",
      deltaS: 1 / 60,
      speedMps: 2.1,
      walkSpeedMps: 1.7,
      runSpeedMps: 3.3,
      restartClip: true,
    });
    expect(restarted.timeS).toBe(0);
    expect(restarted.normalizedPhase).toBe(0);
    expect(restarted.playbackRate).toBe(2.65);
  });

  it("defaults crouching to false for legacy writers and round-trips the flag", () => {
    const owner = new Group();

    // Writers that predate the crouch field keep their exact previous shape.
    writeDirectorCharacterLocomotionRuntimeState(owner, { mode: "walk", timeS: 0, weight: 1, grounded: true });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.crouching).toBe(false);

    writeDirectorCharacterLocomotionRuntimeState(owner, {
      mode: "walk",
      timeS: 0.1,
      weight: 1,
      grounded: true,
      crouching: true,
    });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.crouching).toBe(true);

    // Omitting the flag again releases the crouch instead of leaking it.
    writeDirectorCharacterLocomotionRuntimeState(owner, { mode: "walk", timeS: 0.2, weight: 1, grounded: true });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.crouching).toBe(false);

    expect(
      parseDirectorCharacterLocomotionRuntimeState({ version: 1, mode: "walk", timeS: 0, weight: 1 })?.crouching,
    ).toBe(false);
    expect(
      parseDirectorCharacterLocomotionRuntimeState({
        version: 1,
        mode: "walk",
        timeS: 0,
        weight: 1,
        crouching: true,
      })?.crouching,
    ).toBe(true);
    // Non-boolean junk coerces to false instead of failing the whole parse.
    expect(
      parseDirectorCharacterLocomotionRuntimeState({
        version: 1,
        mode: "walk",
        timeS: 0,
        weight: 1,
        crouching: "yes",
      })?.crouching,
    ).toBe(false);
  });

  it("keeps gaze fields optional for legacy writers and wraps/clamps published angles", () => {
    const owner = new Group();

    // Writers that predate head look keep their exact previous shape.
    writeDirectorCharacterLocomotionRuntimeState(owner, { mode: "walk", timeS: 0, weight: 1, grounded: true });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.lookYawRad).toBeUndefined();
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.lookPitchRad).toBeUndefined();

    // Published gaze round-trips; yaw wraps into [-PI, PI], pitch clamps to +/-PI/2.
    writeDirectorCharacterLocomotionRuntimeState(owner, {
      mode: "walk",
      timeS: 0.1,
      weight: 1,
      grounded: true,
      lookYawRad: 2.5 * Math.PI,
      lookPitchRad: -2,
    });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.lookYawRad).toBeCloseTo(Math.PI / 2, 6);
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.lookPitchRad).toBeCloseTo(-Math.PI / 2, 6);

    // Omitting the fields again disables the layer instead of leaking stale gaze.
    writeDirectorCharacterLocomotionRuntimeState(owner, { mode: "walk", timeS: 0.2, weight: 1, grounded: true });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.lookYawRad).toBeUndefined();
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.lookPitchRad).toBeUndefined();

    // Parse: absent fields stay absent, junk disables per-field, numbers normalize.
    const legacy = parseDirectorCharacterLocomotionRuntimeState({ version: 1, mode: "walk", timeS: 0, weight: 1 });
    expect(legacy?.lookYawRad).toBeUndefined();
    expect(legacy?.lookPitchRad).toBeUndefined();
    const junk = parseDirectorCharacterLocomotionRuntimeState({
      version: 1,
      mode: "walk",
      timeS: 0,
      weight: 1,
      lookYawRad: "left",
      lookPitchRad: Number.POSITIVE_INFINITY,
    });
    expect(junk).not.toBeNull();
    expect(junk?.lookYawRad).toBeUndefined();
    expect(junk?.lookPitchRad).toBeUndefined();
    const parsed = parseDirectorCharacterLocomotionRuntimeState({
      version: 1,
      mode: "idle",
      timeS: 0,
      weight: 1,
      lookYawRad: -3 * Math.PI,
      lookPitchRad: 0.4,
    });
    expect(Math.abs(parsed?.lookYawRad ?? 0)).toBeCloseTo(Math.PI, 6);
    expect(parsed?.lookPitchRad).toBeCloseTo(0.4, 6);
  });

  it("publishes emote playback with its clip id and clamps the sampled time", () => {
    const owner = new Group();
    writeDirectorCharacterLocomotionRuntimeState(owner, {
      mode: "emote",
      timeS: 0.4,
      weight: 1,
      grounded: true,
      emoteClipId: "wave",
    });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)).toMatchObject({
      mode: "emote",
      timeS: 0.4,
      emoteClipId: "wave",
    });

    // Leaving the emote clears the clip so a later gait write cannot leak it.
    writeDirectorCharacterLocomotionRuntimeState(owner, { mode: "walk", timeS: 0.1, weight: 1, grounded: true });
    expect(readDirectorCharacterLocomotionRuntimeState(owner)?.emoteClipId).toBeUndefined();

    expect(getDirectorCharacterLocomotionClipId("emote")).toBe("idle");
    expect(sampleDirectorCharacterLocomotionTime({ mode: "emote", timeS: 2.5 }, 1)).toBe(1);
    expect(
      parseDirectorCharacterLocomotionRuntimeState({
        version: 1,
        mode: "emote",
        timeS: 0.2,
        weight: 1,
        emoteClipId: "clap",
      }),
    ).toMatchObject({ mode: "emote", emoteClipId: "clap" });
  });
});
