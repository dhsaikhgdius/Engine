import { describe, expect, it } from "vitest";
import { evaluateGamePlaytest } from "@director/protocol/director-game-machine";
import { runHostFreeGamePlaytest } from "@director/protocol/game-playtest-host-free";
import { suggestedPlaytestScriptForSlice } from "@director/protocol/game-playtest-fixtures";
import {
  createGameSliceFromBrief,
  gamePlaytestInputSchema,
  gamePlaytestTraceSchema,
  type GamePlaytestScriptInput,
} from "@director/protocol/game-slice";
import {
  GAME_PLAYTEST_REPLAY_SLICE_ID,
  mapGamePlaytestInputToPlayerInput,
  mapGamePlaytestInputToVehicleDriveInput,
  replayGamePlaytestScript,
  resolveGamePlaytestSessionVerb,
} from "../../../../src/comprehensive/editor/player/gamePlaytestReplay";
import type { PlayerObstacle } from "../../../../src/comprehensive/editor/player/playerLocomotion";

const DT = 1 / 30;

function script(steps: GamePlaytestScriptInput["steps"]): GamePlaytestScriptInput {
  return { dt: DT, steps };
}

/** A slice with a bound player role so the evaluator scores the tape itself. */
function boundSlice() {
  const slice = createGameSliceFromBrief({
    id: "game-playtest-replay",
    brief: { requirement: "Walk to the stele and inspect it.", genre: "exploration" },
    now: "2026-08-26T00:00:00.000Z",
  });
  slice.roles = slice.roles.map((role) => ({ ...role, object_id: `stage-${role.id}` }));
  return slice;
}

describe("mapGamePlaytestInputToPlayerInput", () => {
  it("maps held locomotion, look, and analog axes onto the Stage PlayerInput contract", () => {
    const input = gamePlaytestInputSchema.parse({
      forward: true,
      sprint: true,
      jump: true,
      look_right: true,
      look_up: true,
      move_forward_axis: 0.5,
      move_right_axis: -0.25,
    });
    const mapped = mapGamePlaytestInputToPlayerInput(input, false);
    expect(mapped).toMatchObject({
      forward: true,
      sprint: true,
      jump: true,
      jumpPressed: true,
      lookRight: true,
      lookUp: true,
      moveForwardAxis: 0.5,
      moveRightAxis: -0.25,
    });
    // A continued hold is not a fresh key edge.
    expect(mapGamePlaytestInputToPlayerInput(input, true).jumpPressed).toBe(false);
  });

  it("keeps session verbs out of the locomotion input and resolves them separately", () => {
    const input = gamePlaytestInputSchema.parse({ interact: true, fire: true });
    const mapped = mapGamePlaytestInputToPlayerInput(input);
    expect(Object.values(mapped).some((value) => value === true)).toBe(false);
    expect(resolveGamePlaytestSessionVerb(input)).toBe("interact");
    expect(resolveGamePlaytestSessionVerb(gamePlaytestInputSchema.parse({ fire: true }))).toBe("fire");
    expect(resolveGamePlaytestSessionVerb(gamePlaytestInputSchema.parse({ forward: true }))).toBeUndefined();
  });

  it("maps a seated tape onto the vehicle drive contract", () => {
    expect(
      mapGamePlaytestInputToVehicleDriveInput(
        gamePlaytestInputSchema.parse({ forward: true, right: true, jump: true }),
      ),
    ).toEqual({ forward: true, backward: false, left: false, right: true, handbrake: true });
    expect(
      mapGamePlaytestInputToVehicleDriveInput(
        gamePlaytestInputSchema.parse({ move_forward_axis: -0.8, move_right_axis: -0.6 }),
      ),
    ).toMatchObject({ backward: true, left: true });
  });
});

describe("replayGamePlaytestScript", () => {
  it("walks forward on the ground plane, stays on_ground, and exercises move", () => {
    const trace = replayGamePlaytestScript({
      script: script([{ frames: 45, input: { forward: true } }]),
    });

    expect(trace.contract).toBe("director-game-playtest-trace-v1");
    expect(trace.slice_id).toBe(GAME_PLAYTEST_REPLAY_SLICE_ID);
    expect(trace.samples).toHaveLength(45);
    expect(trace.samples.every((sample) => sample.on_ground && !sample.flying)).toBe(true);
    expect(trace.samples.every((sample) => !sample.stuck)).toBe(true);
    expect(trace.verbs_exercised).toContain("move");
    const last = trace.samples.at(-1)!;
    // +Z is forward at yaw zero; the tape actually covered ground.
    expect(last.position[2]).toBeGreaterThan(1);
    expect(Math.hypot(last.velocity![0], last.velocity![2])).toBeGreaterThan(0.5);
  });

  it("jumps while grounded, records the jump verb, and lands again", () => {
    const trace = replayGamePlaytestScript({
      script: script([
        { frames: 10, input: { forward: true } },
        { frames: 30, input: { forward: true, jump: true } },
      ]),
    });

    const jumpSamples = trace.samples.filter((sample) => sample.verb === "jump");
    expect(jumpSamples.length).toBeGreaterThan(3);
    expect(trace.verbs_exercised).toContain("jump");
    // The arc genuinely left the floor...
    expect(Math.max(...trace.samples.map((sample) => sample.position[1]))).toBeGreaterThan(0.5);
    // ...but a recoverable jump is not a fall-through: every sample keeps the
    // on_ground playability contract and the tape ends back on the floor.
    expect(trace.samples.every((sample) => sample.on_ground)).toBe(true);
    const last = trace.samples.at(-1)!;
    expect(last.position[1]).toBeCloseTo(0, 5);
    expect(last.verb).toBe("move");
  });

  it("marks stuck when a held move input is pinned against a box obstacle", () => {
    const wall: PlayerObstacle = {
      id: "wall",
      position: [0, 0, 1.2],
      radius: 3,
      shape: "box",
      halfExtents: [3, 0.3],
      halfHeight: 1,
    };
    const trace = replayGamePlaytestScript({
      script: script([{ frames: 75, input: { forward: true } }]),
      obstacles: [wall],
    });

    const stuckSamples = trace.samples.filter((sample) => sample.stuck);
    expect(stuckSamples.length).toBeGreaterThan(10);
    expect(trace.samples.at(-1)!.stuck).toBe(true);
    // The wall stops the actor short of its front face.
    expect(trace.samples.at(-1)!.position[2]).toBeLessThan(0.95);
    // Early acceleration frames are honest: not stuck from frame zero.
    expect(trace.samples[0]!.stuck).toBe(false);

    const report = evaluateGamePlaytest(boundSlice(), trace);
    expect(report.playable).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("stuck");
    expect(report.checks.find((check) => check.check === "no_stuck")?.passed).toBe(false);
  });

  it("parses with gamePlaytestTraceSchema and scores through evaluateGamePlaytest", () => {
    const trace = replayGamePlaytestScript({
      script: script([
        { frames: 20, input: { forward: true } },
        { frames: 10, input: { look_right: true } },
        { frames: 20, input: { forward: true, jump: true } },
        { frames: 10, input: { interact: true } },
      ]),
      sliceId: "game-playtest-replay",
      // The bound objective sits on the walked path, in interaction range.
      interactables: [{ id: "stage-objective-1", position: [0, 0, 1], radiusM: 6 }],
    });

    const parsed = gamePlaytestTraceSchema.safeParse(trace);
    expect(parsed.success).toBe(true);
    expect(trace.verbs_exercised).toEqual(expect.arrayContaining(["move", "look", "jump", "interact"]));
    // The nearest in-range interactable is stamped on samples, exactly like
    // the live controller's nearest-interaction probe.
    expect(trace.samples.some((sample) => sample.interaction_object_id === "stage-objective-1")).toBe(true);

    const report = evaluateGamePlaytest(boundSlice(), trace);
    expect(report.contract).toBe("director-game-evaluation-v1");
    // Exploration acceptance (move/look/jump/interact plus interaction range
    // and objective reach) is fully exercised by the tape.
    expect(report.playable).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.checks.map((check) => check.check)).toEqual(
      expect.arrayContaining(["interaction_in_range", "objective_reachable"]),
    );
  });

  it("fails interaction range and objective reach when interacting far from every interactable", () => {
    const trace = replayGamePlaytestScript({
      script: script([
        { frames: 20, input: { forward: true } },
        { frames: 10, input: { look_right: true } },
        { frames: 20, input: { forward: true, jump: true } },
        { frames: 10, input: { interact: true } },
      ]),
      sliceId: "game-playtest-replay",
      // The objective exists but is far outside interaction range.
      interactables: [{ id: "stage-objective-1", position: [40, 0, 40], radiusM: 2.5 }],
    });

    expect(trace.samples.every((sample) => sample.interaction_object_id === undefined)).toBe(true);

    const report = evaluateGamePlaytest(boundSlice(), trace);
    expect(report.playable).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["interaction_out_of_range", "objective_unreachable"]),
    );
    expect(report.checks.find((check) => check.check === "interaction_in_range")?.passed).toBe(false);
    expect(report.checks.find((check) => check.check === "objective_reachable")?.passed).toBe(false);
  });

  it("integrates look yaw at exactly the shared protocol host-free rate", () => {
    const tape = script([{ frames: 24, input: { look_right: true } }]);
    const replayed = replayGamePlaytestScript({ script: tape });
    const hostFree = runHostFreeGamePlaytest({
      slice: { id: "game-playtest-replay", roles: boundSlice().roles },
      script: tape,
    });

    // Both runners import GAME_PLAYTEST_LOOK_YAW_RAD_S from the protocol, so
    // a pure look tape must land on the same yaw in vitest and on the Gateway.
    expect(replayed.samples.at(-1)!.yaw).toBeCloseTo(hostFree.samples.at(-1)!.yaw, 10);
  });

  it("keeps parity with the Gateway kinematic runner for the canonical exploration tape", () => {
    const slice = boundSlice();
    const tape = suggestedPlaytestScriptForSlice(slice);

    // Stage-locomotion-model replay (the live driver's semantics) with the
    // bound objective in interaction range, exactly like the live probe.
    const replayed = replayGamePlaytestScript({
      script: tape,
      sliceId: slice.id,
      interactables: [{ id: "stage-objective-1", position: [0, 0, 1], radiusM: 6 }],
    });
    // Gateway kinematic runner for the identical tape, no tab at all.
    const hostFree = runHostFreeGamePlaytest({ slice, script: tape });

    // The same canonical tape satisfies evaluate on both drivers: one tape,
    // one meaning, two runtimes.
    const replayedReport = evaluateGamePlaytest(slice, replayed);
    const hostFreeReport = evaluateGamePlaytest(slice, hostFree);
    expect(replayedReport.playable, JSON.stringify(replayedReport.issues)).toBe(true);
    expect(hostFreeReport.playable, JSON.stringify(hostFreeReport.issues)).toBe(true);
    expect(replayedReport.checks).toEqual(hostFreeReport.checks);
    expect([...replayedReport.verbs_exercised].sort()).toEqual([...hostFreeReport.verbs_exercised].sort());

    // Both stamp honest host-free provenance: neither ran in a live tab.
    expect(replayed.source).toBe("host_free");
    expect(hostFree.source).toBe("host_free");
    expect(replayedReport.trace_source).toBe("host_free");
    expect(hostFreeReport.trace_source).toBe("host_free");
  });

  it("keeps honest yaw during a strafe so the evaluator can flag facing_mismatch", () => {
    const trace = replayGamePlaytestScript({
      script: script([{ frames: 30, input: { right: true } }]),
    });

    const last = trace.samples.at(-1)!;
    // The replay never rewrites yaw to match the motion heading.
    expect(last.yaw).toBeCloseTo(0, 5);
    expect(Math.abs(last.velocity![0])).toBeGreaterThan(0.5);

    const report = evaluateGamePlaytest(boundSlice(), trace);
    expect(report.issues.map((issue) => issue.code)).toContain("facing_mismatch");
    expect(report.checks.find((check) => check.check === "facing_matches_move")?.passed).toBe(false);
  });

  it("reports a genuine fall-through once the actor drops below every support", () => {
    const platform: PlayerObstacle = {
      id: "platform",
      position: [0, 0, 0],
      radius: 1,
      shape: "box",
      halfExtents: [1, 1],
      halfHeight: 0.1,
    };
    const trace = replayGamePlaytestScript({
      script: script([{ frames: 90, input: { forward: true } }]),
      obstacles: [platform],
      groundEnabled: false,
      initialState: {
        position: [0, 0.2, 0],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        flying: false,
        onGround: true,
        jumpHeld: false,
        coyoteTimeRemaining: 0,
        jumpBufferTimeRemaining: 0,
      },
    });

    const fellSamples = trace.samples.filter((sample) => !sample.on_ground && !sample.flying);
    expect(fellSamples.length).toBeGreaterThan(0);
    expect(trace.samples.at(-1)!.position[1]).toBeLessThan(0);

    const report = evaluateGamePlaytest(boundSlice(), trace);
    expect(report.issues.map((issue) => issue.code)).toContain("fell_through_floor");
    expect(report.checks.find((check) => check.check === "on_ground")?.passed).toBe(false);
  });

  it("integrates look steps into yaw at the live keyboard look rate", () => {
    const trace = replayGamePlaytestScript({
      script: script([{ frames: 30, input: { look_right: true } }]),
    });

    const last = trace.samples.at(-1)!;
    // Look-right decreases yaw, matching the live controller's sign.
    expect(last.yaw).toBeLessThan(-1);
    expect(trace.verbs_exercised).toContain("look");
  });

  it("rejects a tape that would exceed the trace sample budget", () => {
    const oversized = {
      dt: DT,
      steps: Array.from({ length: 200 }, () => ({ frames: 10_000, input: { forward: true } })),
    };
    expect(() => replayGamePlaytestScript({ script: oversized })).toThrow(/trace budget/);
  });
});
