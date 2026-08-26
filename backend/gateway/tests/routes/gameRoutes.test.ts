import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GamePlaytestTrace } from "../../../../packages/protocol/src/gameSliceProtocol";
import { createDirectorGame, type DirectorGameRuntime } from "../../game/createDirectorGame";
import { handleGameRoute, type GameRouteDependencies } from "../../routes/gameRoutes";

const NOW = "2026-08-26T03:00:00.000Z";
const SLICE_ID = "game-courtyard-01";
const GAME_URL = new URL("http://test/api/tools/director_game");

function request(method = "POST"): IncomingMessage {
  return { method, headers: {} } as IncomingMessage;
}

function response(): ServerResponse {
  return {} as ServerResponse;
}

function groundedTrace(sliceId: string): GamePlaytestTrace {
  return {
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
        camera_clip: false,
        stuck: false,
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
        camera_clip: false,
        stuck: false,
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
        camera_clip: false,
        stuck: false,
      },
    ],
  };
}

describe("director_game routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createGame() {
    const dir = await mkdtemp(join(tmpdir(), "director-game-routes-"));
    tempDirs.push(dir);
    return { game: createDirectorGame(dir, { now: () => NOW }), dir };
  }

  async function call(
    game: DirectorGameRuntime,
    body: unknown,
    overrides: Partial<GameRouteDependencies> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const json = vi.fn();
    const handled = await handleGameRoute(request(), response(), GAME_URL, {
      readBody: vi.fn().mockResolvedValue(body),
      json,
      execute: game.execute,
      ...overrides,
    });
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledTimes(1);
    const [, status, responseBody] = json.mock.calls[0] as [ServerResponse, number, Record<string, unknown>];
    return { status, body: responseBody };
  }

  async function planCourtyard(game: DirectorGameRuntime) {
    const planned = await call(game, {
      input: {
        op: "plan",
        slice_id: SLICE_ID,
        brief: { requirement: "Walk to the stele and interact.", genre: "exploration" },
      },
    });
    expect(planned).toMatchObject({ status: 200, body: { success: true } });
    return planned;
  }

  async function bindCourtyard(game: DirectorGameRuntime) {
    const bound = await call(game, {
      input: {
        op: "bind",
        slice_id: SLICE_ID,
        bindings: [
          { role_id: "player", object_id: "hero-1" },
          { role_id: "spawn", object_id: "spawn-1" },
          { role_id: "objective-1", object_id: "stele-1" },
        ],
      },
    });
    expect(bound).toMatchObject({ status: 200, body: { success: true, result: { bind_complete: true } } });
    return bound;
  }

  it("ignores other tool paths and methods", async () => {
    const { game } = await createGame();
    const json = vi.fn();
    const dependencies = { readBody: vi.fn(), json, execute: game.execute };
    expect(
      await handleGameRoute(request(), response(), new URL("http://test/api/tools/director_dcc"), dependencies),
    ).toBe(false);
    expect(await handleGameRoute(request("GET"), response(), GAME_URL, dependencies)).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("serves capabilities and describe without any slice state", async () => {
    const { game } = await createGame();
    const capabilities = await call(game, { input: { op: "capabilities" } });
    expect(capabilities).toMatchObject({
      status: 200,
      body: { success: true, result: { tool: "director_game", runtime: { default: "stage" } } },
    });
    const described = await call(game, { op: "describe", target: "plan", session_id: "http-test" });
    expect(described).toMatchObject({
      status: 200,
      body: { success: true, result: { target: "plan", kind: "operation" } },
    });
  });

  it("rejects malformed input with the DCC-style path message", async () => {
    const { game } = await createGame();
    const invalid = await call(game, { input: { op: "plan" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/^Invalid director_game input at /);
    const notObject = await call(game, "not an object");
    expect(notObject).toMatchObject({
      status: 400,
      body: { success: false, error: "director_game request body must be a JSON object." },
    });
  });

  it("applies the film-role tool policy before touching the store", async () => {
    const { game } = await createGame();
    const execute = vi.fn();
    const rejected = await call(
      game,
      { input: { op: "capabilities" } },
      { execute, governance: { filmRoleId: "visual-critic" } },
    );
    expect(rejected).toMatchObject({ status: 403, body: { success: false, code: "tool_policy_rejected" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("plans a slice and persists it across gateway restarts", async () => {
    const { game, dir } = await createGame();
    await planCourtyard(game);
    const reloaded = createDirectorGame(dir, { now: () => NOW });
    const observed = await call(reloaded, { input: { op: "observe", slice_id: SLICE_ID } });
    expect(observed).toMatchObject({
      status: 200,
      body: { success: true, result: { slice: { id: SLICE_ID, status: "draft" }, bind_complete: false } },
    });
  });

  it("rejects playtest while the player role is unbound", async () => {
    const { game } = await createGame();
    await planCourtyard(game);
    const unbound = await call(game, {
      input: { op: "playtest", slice_id: SLICE_ID, script: { steps: [{ frames: 10, input: { forward: true } }] } },
    });
    expect(unbound).toMatchObject({ status: 409, body: { success: false, code: "game_player_unbound" } });
    expect(unbound.body.corrective_call).toMatchObject({ op: "bind", slice_id: SLICE_ID });
  });

  it("needs a Stage session when playtest has no trace and no runner is wired", async () => {
    const { game } = await createGame();
    await planCourtyard(game);
    await bindCourtyard(game);
    const needsStage = await call(game, {
      input: { op: "playtest", slice_id: SLICE_ID, script: { steps: [{ frames: 8, input: { forward: true } }] } },
    });
    expect(needsStage).toMatchObject({ status: 409, body: { success: false, code: "game_playtest_needs_stage" } });
    expect(needsStage.body.corrective_call).toMatchObject({ op: "playtest", slice_id: SLICE_ID });
  });

  it("scores a supplied host-free trace and marks the slice playable", async () => {
    const { game, dir } = await createGame();
    await planCourtyard(game);
    await bindCourtyard(game);
    const playtested = await call(game, {
      input: {
        op: "playtest",
        slice_id: SLICE_ID,
        script: { steps: [{ frames: 30, input: { forward: true } }] },
        trace: groundedTrace(SLICE_ID),
      },
    });
    expect(playtested).toMatchObject({
      status: 200,
      body: { success: true, result: { evaluation: { playable: true }, slice: { status: "playable" } } },
    });
    const persisted = await createDirectorGame(dir).store.get(SLICE_ID);
    expect(persisted?.status).toBe("playable");
    expect(persisted?.last_evaluation?.playable).toBe(true);
  });

  it("refuses export before playable, then routes the playable slice through director_dcc", async () => {
    const { game } = await createGame();
    await planCourtyard(game);
    const tooEarly = await call(game, { input: { op: "export_slice", slice_id: SLICE_ID, provider: "godot" } });
    expect(tooEarly).toMatchObject({ status: 409, body: { success: false, code: "game_export_not_playable" } });

    await bindCourtyard(game);
    await call(game, {
      input: {
        op: "playtest",
        slice_id: SLICE_ID,
        script: { steps: [{ frames: 30, input: { forward: true } }] },
        trace: groundedTrace(SLICE_ID),
      },
    });
    const exported = await call(game, { input: { op: "export_slice", slice_id: SLICE_ID, provider: "godot" } });
    expect(exported).toMatchObject({ status: 409, body: { success: false, code: "game_export_via_dcc" } });
    expect(exported.body.result).toMatchObject({
      slice_id: SLICE_ID,
      provider: "godot",
      next: expect.arrayContaining([expect.objectContaining({ tool: "director_dcc" })]),
    });
  });

  it("returns 404 with a corrective plan call for unknown slices", async () => {
    const { game } = await createGame();
    const missing = await call(game, { input: { op: "observe", slice_id: "game-missing-slice-01" } });
    expect(missing).toMatchObject({ status: 404, body: { success: false, code: "game_slice_not_found" } });
    expect(missing.body.corrective_call).toMatchObject({ op: "plan" });
  });
});
