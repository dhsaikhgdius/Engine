import { describe, expect, it } from "vitest";
import { describeDirectorGameTarget } from "../src/directorGameDescribe";
import { createDirectorGameState, evaluateGamePlaytest, executeDirectorGame } from "../src/directorGameMachine";
import { directorGameOperationNames, directorGameOperationSchema } from "../src/directorGameProtocol";
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
            verb: "move",
          },
        ],
      }),
    );
    expect(facing.issues.map((issue) => issue.code)).toContain("facing_mismatch");
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
