import { describe, expect, it } from "vitest";
import { describeDirectorGameTarget } from "../src/directorGameDescribe";
import { createDirectorGameState, evaluateGamePlaytest, executeDirectorGame } from "../src/directorGameMachine";
import { directorGameOperationNames, directorGameOperationSchema } from "../src/directorGameProtocol";
import { runHostFreeGamePlaytest } from "../src/gamePlaytestHostFree";
import {
  createGameSliceFromBrief,
  gamePlaytestTraceSchema,
  type GamePlaytestTrace,
  type GamePlaytestTraceInput,
  type GameSlice,
} from "../src/gameSliceProtocol";

const NOW = "2026-08-26T03:00:00.000Z";

async function planExploration() {
  const state = createDirectorGameState();
  const planned = await executeDirectorGame(
    state,
    {
      op: "plan",
      slice_id: "game-courtyard-01",
      brief: { requirement: "Walk to the stele and interact.", genre: "exploration" },
    },
    { now: NOW, createId: () => "game-courtyard-01" },
  );
  expect(planned.success).toBe(true);
  if (!planned.success) throw new Error("plan failed");
  return { state, slice: (planned.result as { slice: GameSlice }).slice };
}

function groundedTrace(sliceId: string, overrides: Partial<GamePlaytestTraceInput> = {}): GamePlaytestTrace {
  // Parse the wire shape so schema defaults (flying, camera_clip, stuck)
  // fill in exactly like a trace arriving over the tool boundary.
  return gamePlaytestTraceSchema.parse({
    contract: "director-game-playtest-trace-v1",
    slice_id: sliceId,
    dt: 1 / 30,
    verbs_exercised: ["move", "look", "jump", "interact"],
    samples: [
      {
        frame: 0,
        time_s: 0,
        position: [0, 0, 0],
        yaw: 0,
        velocity: [0, 0, 1.2],
        on_ground: true,
        flying: false,
        camera_clip: false,
        stuck: false,
        verb: "move",
      },
      {
        frame: 15,
        time_s: 0.5,
        position: [0, 0, 0.6],
        yaw: 0,
        velocity: [0, 0, 1.2],
        on_ground: true,
        flying: false,
        camera_clip: false,
        stuck: false,
        verb: "jump",
      },
      {
        frame: 30,
        time_s: 1,
        position: [0, 0, 1.2],
        yaw: 0,
        velocity: [0, 0, 0],
        on_ground: true,
        flying: false,
        camera_clip: false,
        stuck: false,
        verb: "interact",
        interaction_object_id: "stele-1",
      },
    ],
    ...overrides,
  });
}

describe("director_game machine", () => {
  it("exposes capabilities and describe without slice state", async () => {
    const state = createDirectorGameState();
    const capabilities = await executeDirectorGame(state, { op: "capabilities" }, { now: NOW });
    expect(capabilities).toMatchObject({
      success: true,
      result: { tool: "director_game", runtime: { default: "stage" } },
    });
    const described = await executeDirectorGame(state, { op: "describe", target: "plan" }, { now: NOW });
    expect(described.success).toBe(true);
    expect(described).toMatchObject({ result: { target: "plan", kind: "operation" } });
    const unknown = describeDirectorGameTarget("gen_mechanic");
    expect("error" in unknown).toBe(true);
  });

  it("lists every public op on the discriminated union", () => {
    expect(directorGameOperationNames).toEqual([
      "capabilities",
      "describe",
      "plan",
      "observe",
      "bind",
      "author_loop",
      "author_hud",
      "playtest",
      "evaluate",
      "export_slice",
    ]);
    expect(directorGameOperationSchema.safeParse({ op: "plan" }).success).toBe(false);
    expect(
      directorGameOperationSchema.safeParse({
        op: "plan",
        brief: { requirement: "race", genre: "racing" },
      }).success,
    ).toBe(true);
  });

  it("rejects playtest until the player role is bound, then scores a host-free tape", async () => {
    const { state, slice } = await planExploration();
    const unbound = await executeDirectorGame(
      state,
      { op: "playtest", slice_id: slice.id, script: { steps: [{ frames: 10, input: { forward: true } }] } },
      { now: NOW },
    );
    expect(unbound.success).toBe(false);
    expect(unbound).toMatchObject({ code: "game_player_unbound" });

    const bound = await executeDirectorGame(
      state,
      {
        op: "bind",
        slice_id: slice.id,
        bindings: [
          { role_id: "player", object_id: "hero-1" },
          { role_id: "spawn", object_id: "spawn-1" },
          { role_id: "objective-1", object_id: "stele-1" },
        ],
      },
      { now: NOW },
    );
    expect(bound).toMatchObject({ success: true, result: { bind_complete: true } });

    const playtested = await executeDirectorGame(
      state,
      {
        op: "playtest",
        slice_id: slice.id,
        script: { steps: [{ frames: 30, input: { forward: true } }] },
        trace: groundedTrace(slice.id),
      },
      { now: NOW },
    );
    expect(playtested.success).toBe(true);
    expect(playtested).toMatchObject({
      result: { evaluation: { playable: true }, slice: { status: "playable" } },
    });
  });

  it("fails playability when the actor falls through the floor or faces the wrong way", () => {
    const slice = createGameSliceFromBrief({
      id: "game-trace-fail-01",
      now: NOW,
      brief: { requirement: "walk", genre: "exploration" },
    });
    slice.roles[0] = { ...slice.roles[0]!, object_id: "hero-1" };

    const floor = evaluateGamePlaytest(
      slice,
      groundedTrace(slice.id, {
        verbs_exercised: ["move", "look", "jump", "interact"],
        samples: [
          {
            frame: 0,
            time_s: 0,
            position: [0, -4, 0],
            yaw: 0,
            velocity: [0, -9, 0],
            on_ground: false,
            flying: false,
            camera_clip: false,
            stuck: false,
          },
        ],
      }),
    );
    expect(floor.playable).toBe(false);
    expect(floor.issues.map((issue) => issue.code)).toContain("fell_through_floor");

    const facing = evaluateGamePlaytest(
      slice,
      groundedTrace(slice.id, {
        samples: [
          {
            frame: 0,
            time_s: 0,
            position: [0, 0, 0],
            yaw: 0,
            velocity: [1.5, 0, 0],
            on_ground: true,
            flying: false,
            camera_clip: false,
            stuck: false,
            verb: "move",
          },
        ],
      }),
    );
    expect(facing.issues.map((issue) => issue.code)).toContain("facing_mismatch");
  });

  it("fails interaction_in_range when interact samples never carry an in-range candidate", () => {
    const slice = createGameSliceFromBrief({
      id: "game-interact-range-01",
      now: NOW,
      brief: { requirement: "Reach the stele and interact.", genre: "exploration" },
    });
    slice.roles = slice.roles.map((role) => ({ ...role, object_id: `stage-${role.id}` }));

    const report = evaluateGamePlaytest(
      slice,
      groundedTrace(slice.id, {
        samples: [
          {
            frame: 0,
            time_s: 0,
            position: [0, 0, 0],
            yaw: 0,
            velocity: [0, 0, 1.2],
            on_ground: true,
            verb: "move",
          },
          // Interact pressed with nothing in range: no interaction_object_id.
          {
            frame: 1,
            time_s: 1 / 30,
            position: [0, 0, 1.2],
            yaw: 0,
            velocity: [0, 0, 0],
            on_ground: true,
            verb: "interact",
          },
        ],
      }),
    );
    expect(report.playable).toBe(false);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain("interaction_out_of_range");
    expect(codes).toContain("objective_unreachable");
    expect(report.checks.find((check) => check.check === "interaction_in_range")?.passed).toBe(false);
    expect(report.checks.find((check) => check.check === "objective_reachable")?.passed).toBe(false);
  });

  it("routes objective_unreachable to a bind corrective call when the objective role is unbound", () => {
    const slice = createGameSliceFromBrief({
      id: "game-objective-unbound-01",
      now: NOW,
      brief: { requirement: "Reach the stele and interact.", genre: "exploration" },
    });
    slice.roles = slice.roles.map((role) => (role.kind === "player" ? { ...role, object_id: "hero-1" } : role));

    const report = evaluateGamePlaytest(slice, groundedTrace(slice.id));
    const issue = report.issues.find((candidate) => candidate.code === "objective_unreachable");
    expect(issue).toBeDefined();
    expect(issue?.role_id).toBe("objective-1");
    expect(issue?.corrective_call).toMatchObject({ op: "bind", slice_id: slice.id });
  });

  it("rejects a racing tape that exits the vehicle before entering it", () => {
    const slice = createGameSliceFromBrief({
      id: "game-vehicle-order-01",
      now: NOW,
      brief: { requirement: "Enter the kart, drive, exit.", genre: "racing" },
    });
    slice.roles = slice.roles.map((role) => ({ ...role, object_id: `stage-${role.id}` }));

    const backwards = evaluateGamePlaytest(
      slice,
      runHostFreeGamePlaytest({
        slice,
        script: {
          steps: [
            { frames: 4, input: { exit_vehicle: true } },
            { frames: 20, input: { forward: true } },
            { frames: 10, input: { look_right: true } },
            { frames: 4, input: { enter_vehicle: true } },
          ],
        },
      }),
    );
    expect(backwards.playable).toBe(false);
    const issue = backwards.issues.find((candidate) => candidate.code === "vehicle_sequence_invalid");
    expect(issue).toBeDefined();
    expect(issue?.role_id).toBe("vehicle");
    expect(issue?.object_id).toBe("stage-vehicle");
    expect(backwards.checks.find((check) => check.check === "verb_exercised")?.passed).toBe(false);

    const ordered = evaluateGamePlaytest(
      slice,
      runHostFreeGamePlaytest({
        slice,
        script: {
          steps: [
            { frames: 10, input: { look_right: true } },
            { frames: 4, input: { enter_vehicle: true } },
            { frames: 20, input: { forward: true } },
            { frames: 4, input: { exit_vehicle: true } },
          ],
        },
      }),
    );
    expect(ordered.issues.map((candidate) => candidate.code)).not.toContain("vehicle_sequence_invalid");
    expect(ordered.playable).toBe(true);
  });

  it("rejects any tape that exits a vehicle it never entered", () => {
    const slice = createGameSliceFromBrief({
      id: "game-vehicle-noenter-01",
      now: NOW,
      brief: { requirement: "Enter the kart, drive, exit.", genre: "racing" },
    });
    slice.roles = slice.roles.map((role) => ({ ...role, object_id: `stage-${role.id}` }));

    const report = evaluateGamePlaytest(
      slice,
      runHostFreeGamePlaytest({
        slice,
        script: {
          steps: [
            { frames: 20, input: { forward: true } },
            { frames: 10, input: { look_right: true } },
            { frames: 4, input: { exit_vehicle: true } },
          ],
        },
      }),
    );
    expect(report.playable).toBe(false);
    expect(report.issues.map((candidate) => candidate.code)).toContain("vehicle_sequence_invalid");
  });

  it("refuses engine export until the slice is playable, then routes through director_dcc", async () => {
    const { state, slice } = await planExploration();
    const tooEarly = await executeDirectorGame(
      state,
      { op: "export_slice", slice_id: slice.id, provider: "godot" },
      { now: NOW },
    );
    expect(tooEarly).toMatchObject({ success: false, code: "game_export_not_playable" });

    await executeDirectorGame(
      state,
      {
        op: "bind",
        slice_id: slice.id,
        bindings: [
          { role_id: "player", object_id: "hero-1" },
          { role_id: "spawn", object_id: "spawn-1" },
          { role_id: "objective-1", object_id: "stele-1" },
        ],
      },
      { now: NOW },
    );
    await executeDirectorGame(
      state,
      {
        op: "playtest",
        slice_id: slice.id,
        script: { steps: [{ frames: 8, input: { forward: true } }] },
        trace: groundedTrace(slice.id),
      },
      { now: NOW },
    );
    const exported = await executeDirectorGame(
      state,
      { op: "export_slice", slice_id: slice.id, provider: "godot" },
      { now: NOW },
    );
    expect(exported).toMatchObject({ success: false, code: "game_export_via_dcc" });
    if (exported.success) throw new Error("expected dcc routing rejection");
    expect(exported.result).toMatchObject({
      next: expect.arrayContaining([expect.objectContaining({ tool: "director_dcc" })]),
    });
  });

  it("restamps caller-supplied traces to inline so live provenance cannot be forged", async () => {
    const { state, slice } = await planExploration();
    await executeDirectorGame(
      state,
      {
        op: "bind",
        slice_id: slice.id,
        bindings: [
          { role_id: "player", object_id: "hero-1" },
          { role_id: "spawn", object_id: "spawn-1" },
          { role_id: "objective-1", object_id: "stele-1" },
        ],
      },
      { now: NOW },
    );
    const playtested = await executeDirectorGame(
      state,
      {
        op: "playtest",
        slice_id: slice.id,
        script: { steps: [{ frames: 8, input: { forward: true } }] },
        // The wire accepts a source field, but a forged live claim must not
        // survive the machine: inline submissions always evaluate as inline.
        trace: groundedTrace(slice.id, { source: "live_stage" }),
      },
      { now: NOW },
    );
    expect(playtested.success).toBe(true);
    expect(playtested).toMatchObject({
      result: {
        trace: { source: "inline" },
        evaluation: { trace_source: "inline" },
      },
    });

    const evaluated = await executeDirectorGame(
      state,
      { op: "evaluate", slice_id: slice.id, trace: groundedTrace(slice.id, { source: "live_stage" }) },
      { now: NOW },
    );
    expect(evaluated.success).toBe(true);
    expect(evaluated).toMatchObject({ result: { evaluation: { trace_source: "inline" } } });
  });

  it("stamps host-free kinematic traces with host_free provenance", () => {
    const slice = createGameSliceFromBrief({
      id: "game-hostfree-source-01",
      now: NOW,
      brief: { requirement: "walk", genre: "exploration" },
    });
    slice.roles = slice.roles.map((role) => ({ ...role, object_id: `stage-${role.id}` }));
    const trace = runHostFreeGamePlaytest({
      slice,
      script: { steps: [{ frames: 8, input: { forward: true } }] },
    });
    expect(trace.source).toBe("host_free");
    const report = evaluateGamePlaytest(slice, trace);
    expect(report.trace_source).toBe("host_free");
  });

  it("needs a Stage session when playtest has no trace and no runner", async () => {
    const { state, slice } = await planExploration();
    await executeDirectorGame(
      state,
      { op: "bind", slice_id: slice.id, bindings: [{ role_id: "player", object_id: "hero-1" }] },
      { now: NOW },
    );
    const needsStage = await executeDirectorGame(
      state,
      { op: "playtest", slice_id: slice.id, script: { steps: [{ frames: 8, input: { forward: true } }] } },
      { now: NOW },
    );
    expect(needsStage).toMatchObject({ success: false, code: "game_playtest_needs_stage" });
  });
});
