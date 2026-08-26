import { describe, expect, it } from "vitest";
import {
  createHostFreePlaytestRunner,
  runHostFreeGamePlaytest,
} from "../src/gamePlaytestHostFree";
import { createDirectorGameState, evaluateGamePlaytest, executeDirectorGame } from "../src/directorGameMachine";
import {
  createGameSliceFromBrief,
  type GameSlice,
} from "../src/gameSliceProtocol";

const NOW = "2026-08-26T04:00:00.000Z";

function boundExploration(): GameSlice {
  const slice = createGameSliceFromBrief({
    id: "game-hostfree-01",
    brief: { requirement: "Walk to the stele and interact.", genre: "exploration" },
    now: NOW,
  });
  return {
    ...slice,
    status: "bound",
    roles: slice.roles.map((role) => {
      if (role.id === "player") return { ...role, object_id: "hero-1" };
      if (role.id === "spawn") return { ...role, object_id: "spawn-1" };
      if (role.id === "objective-1") return { ...role, object_id: "stele-1" };
      return role;
    }),
  };
}

describe("gamePlaytestHostFree", () => {
  it("emits a grounded move tape that advances along facing", () => {
    const slice = boundExploration();
    const trace = runHostFreeGamePlaytest({
      slice,
      script: { steps: [{ frames: 30, input: { forward: true } }] },
    });
    expect(trace.contract).toBe("director-game-playtest-trace-v1");
    expect(trace.samples).toHaveLength(30);
    expect(trace.samples.every((sample) => sample.on_ground)).toBe(true);
    expect(trace.samples.at(-1)!.position[2]).toBeGreaterThan(0.5);
    expect(trace.verbs_exercised).toContain("move");
  });

  it("scores playable when the tape exercises exploration acceptance verbs", () => {
    const slice = boundExploration();
    const trace = runHostFreeGamePlaytest({
      slice,
      script: {
        steps: [
          { frames: 20, input: { forward: true } },
          { frames: 10, input: { look_right: true } },
          { frames: 8, input: { jump: true } },
          { frames: 6, input: { interact: true } },
        ],
      },
    });
    const report = evaluateGamePlaytest(slice, trace);
    expect(report.playable).toBe(true);
    expect(report.verbs_exercised).toEqual(expect.arrayContaining(["move", "look", "jump", "interact"]));
  });

  it("wires as a director_game runPlaytest default path", async () => {
    const state = createDirectorGameState();
    const planned = await executeDirectorGame(
      state,
      {
        op: "plan",
        slice_id: "game-hostfree-01",
        brief: { requirement: "Walk to the stele and interact.", genre: "exploration" },
      },
      { now: NOW },
    );
    expect(planned.success).toBe(true);
    await executeDirectorGame(
      state,
      {
        op: "bind",
        slice_id: "game-hostfree-01",
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
        slice_id: "game-hostfree-01",
        script: {
          steps: [
            { frames: 20, input: { forward: true } },
            { frames: 10, input: { look_right: true } },
            { frames: 8, input: { jump: true } },
            { frames: 6, input: { interact: true } },
          ],
        },
      },
      { now: NOW, runPlaytest: createHostFreePlaytestRunner() },
    );
    expect(playtested.success).toBe(true);
    if (!playtested.success) throw new Error("playtest failed");
    const result = playtested.result as { evaluation: { playable: boolean }; slice: { status: string } };
    expect(result.evaluation.playable).toBe(true);
    expect(result.slice.status).toBe("playable");
  });
});
