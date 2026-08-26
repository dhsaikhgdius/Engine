import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GameEvaluationReport,
  GamePlaytestScript,
  GamePlaytestTrace,
  GameSlice,
} from "../../../../packages/protocol/src/gameSliceProtocol";
import { createDirectorGame } from "../../game/createDirectorGame";

/**
 * Full `director_game` loop against the durable Gateway runtime with NO
 * inline trace and NO browser tab: plan → bind → playtest (host-free default
 * runner) → evaluate → export_slice. This is the structured counterpart to
 * GameFactory-3A's compile-and-video acceptance: every stage of the loop
 * returns a typed receipt that is asserted, not watched.
 */

const NOW = "2026-08-26T06:00:00.000Z";

type PlaytestResult = {
  slice: GameSlice;
  trace: GamePlaytestTrace;
  evaluation: GameEvaluationReport;
};

describe("director_game full loop (host-free, durable store)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createRuntime() {
    const dir = await mkdtemp(join(tmpdir(), "director-game-loop-"));
    tempDirs.push(dir);
    return { runtime: createDirectorGame(dir, { now: () => NOW }), dir };
  }

  async function runFullLoop(options: {
    sliceId: string;
    genre: "racing" | "fps";
    requirement: string;
    bindings: Array<{ role_id: string; object_id: string }>;
    provider: "godot" | "unity" | "unreal";
  }) {
    const { runtime, dir } = await createRuntime();

    const planned = await runtime.execute({
      op: "plan",
      slice_id: options.sliceId,
      brief: { requirement: options.requirement, genre: options.genre },
    });
    expect(planned).toMatchObject({ success: true, result: { slice: { status: "draft" } } });

    const bound = await runtime.execute({
      op: "bind",
      slice_id: options.sliceId,
      bindings: options.bindings,
    });
    expect(bound).toMatchObject({ success: true, result: { bind_complete: true } });

    const observed = await runtime.execute({ op: "observe", slice_id: options.sliceId });
    expect(observed.success).toBe(true);
    if (!observed.success) throw new Error("observe failed");
    const suggested = (observed.result as { suggested_playtest_script: GamePlaytestScript })
      .suggested_playtest_script;
    expect(suggested.steps.length).toBeGreaterThan(0);

    // No trace and no live tab: the Gateway's default host-free kinematic
    // runner must score the suggested tape by itself.
    const playtested = await runtime.execute({
      op: "playtest",
      slice_id: options.sliceId,
      script: suggested,
    });
    expect(playtested.success).toBe(true);
    if (!playtested.success) throw new Error("playtest failed");
    const result = playtested.result as PlaytestResult;
    expect(result.trace.contract).toBe("director-game-playtest-trace-v1");
    expect(result.evaluation.playable, JSON.stringify(result.evaluation.issues)).toBe(true);
    expect(result.slice.status).toBe("playable");
    for (const verb of result.slice.acceptance.operations) {
      expect(result.evaluation.verbs_exercised).toContain(verb);
    }

    const evaluated = await runtime.execute({ op: "evaluate", slice_id: options.sliceId });
    expect(evaluated).toMatchObject({
      success: true,
      result: { evaluation: { contract: "director-game-evaluation-v1", playable: true } },
    });

    // export_slice never emits engine source: it must route to director_dcc.
    const exported = await runtime.execute({
      op: "export_slice",
      slice_id: options.sliceId,
      provider: options.provider,
    });
    expect(exported).toMatchObject({ success: false, code: "game_export_via_dcc" });
    if (exported.success) throw new Error("expected dcc routing rejection");
    expect(exported.result).toMatchObject({
      provider: options.provider,
      next: expect.arrayContaining([expect.objectContaining({ tool: "director_dcc" })]),
    });

    // Durability: a fresh runtime over the same data directory sees the
    // playable receipt without replaying anything.
    const reloaded = createDirectorGame(dir, { now: () => NOW });
    const reobserved = await reloaded.execute({ op: "observe", slice_id: options.sliceId });
    expect(reobserved).toMatchObject({
      success: true,
      result: { slice: { status: "playable" } },
    });

    return result;
  }

  it("closes plan → bind → playtest(no trace) → evaluate → export_slice for racing", async () => {
    const result = await runFullLoop({
      sliceId: "game-loop-racing-01",
      genre: "racing",
      requirement: "Enter the kart, drive one lap, exit at the finish line.",
      bindings: [
        { role_id: "player", object_id: "driver-1" },
        { role_id: "vehicle", object_id: "kart-1" },
        { role_id: "spawn", object_id: "grid-slot-1" },
      ],
      provider: "godot",
    });
    // The racing tape exercised the vehicle in the only legal order.
    const enterFrame = result.trace.samples.find((sample) => sample.verb === "enter_vehicle")?.frame;
    const exitFrame = result.trace.samples.find((sample) => sample.verb === "exit_vehicle")?.frame;
    expect(enterFrame).toBeDefined();
    expect(exitFrame).toBeDefined();
    expect(enterFrame!).toBeLessThan(exitFrame!);
  });

  it("closes plan → bind → playtest(no trace) → evaluate → export_slice for fps", async () => {
    const result = await runFullLoop({
      sliceId: "game-loop-fps-01",
      genre: "fps",
      requirement: "Clear the range with aimed fire and a reload.",
      bindings: [
        { role_id: "player", object_id: "operator-1" },
        { role_id: "enemy-1", object_id: "target-dummy-1" },
        { role_id: "spawn", object_id: "spawn-pad-1" },
      ],
      provider: "unity",
    });
    expect(result.evaluation.verbs_exercised).toEqual(
      expect.arrayContaining(["move", "look", "jump", "sprint", "fire", "reload"]),
    );
  });

  it("keeps a racing slice unexportable when the tape exits the vehicle before entering", async () => {
    const { runtime } = await createRuntime();
    await runtime.execute({
      op: "plan",
      slice_id: "game-loop-racing-02",
      brief: { requirement: "Enter the kart, drive, exit.", genre: "racing" },
    });
    await runtime.execute({
      op: "bind",
      slice_id: "game-loop-racing-02",
      bindings: [
        { role_id: "player", object_id: "driver-1" },
        { role_id: "vehicle", object_id: "kart-1" },
        { role_id: "spawn", object_id: "grid-slot-1" },
      ],
    });
    const playtested = await runtime.execute({
      op: "playtest",
      slice_id: "game-loop-racing-02",
      script: {
        steps: [
          { frames: 4, input: { exit_vehicle: true } },
          { frames: 16, input: { forward: true } },
          { frames: 10, input: { look_right: true } },
          { frames: 4, input: { enter_vehicle: true } },
        ],
      },
    });
    expect(playtested.success).toBe(true);
    if (!playtested.success) throw new Error("playtest failed");
    const result = playtested.result as PlaytestResult;
    expect(result.evaluation.playable).toBe(false);
    expect(result.evaluation.issues.map((issue) => issue.code)).toContain("vehicle_sequence_invalid");
    expect(result.slice.status).toBe("playtested");

    const exported = await runtime.execute({
      op: "export_slice",
      slice_id: "game-loop-racing-02",
      provider: "godot",
    });
    expect(exported).toMatchObject({ success: false, code: "game_export_not_playable" });
  });
});
