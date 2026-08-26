import { describe, expect, it } from "vitest";
import {
  GAME_SLICE_CONTRACT,
  createGameSliceFromBrief,
  gameSliceBindComplete,
  gameSliceSchema,
  playerRole,
  playerUnboundIssue,
} from "../src/gameSliceProtocol";

describe("gameSliceProtocol", () => {
  it("fills Stage as the default playable runtime and records the default in notes", () => {
    const slice = createGameSliceFromBrief({
      id: "game-explore-room-01",
      now: "2026-08-26T00:00:00.000Z",
      brief: { requirement: "一座可漫游的庭院，玩家走到石碑前互动。", genre: "exploration" },
    });
    expect(slice.contract).toBe(GAME_SLICE_CONTRACT);
    expect(slice.status).toBe("draft");
    expect(slice.brief.engine_target).toBe("stage");
    expect(slice.brief.perspective).toBe("third");
    expect(slice.controls.camera).toBe("third");
    expect(playerRole(slice)?.kind).toBe("player");
    expect(gameSliceBindComplete(slice)).toBe(false);
    expect(slice.notes.some((note) => note.includes("engine_target"))).toBe(true);
    expect(slice.loop.verbs).toEqual(expect.arrayContaining(["move", "interact"]));
  });

  it("defaults FPS to a first-person camera without substituting a different genre", () => {
    const slice = createGameSliceFromBrief({
      id: "game-fps-range-01",
      now: "2026-08-26T00:00:00.000Z",
      brief: { requirement: "Indoor shooting gallery.", genre: "fps", engine_target: "godot" },
    });
    expect(slice.brief.engine_target).toBe("godot");
    expect(slice.brief.perspective).toBe("first");
    expect(slice.loop.verbs).toEqual(expect.arrayContaining(["fire", "reload"]));
    expect(slice.hud.widgets.map((widget) => widget.kind)).toEqual(expect.arrayContaining(["crosshair", "ammo"]));
  });

  it("rejects an unknown genre and an id without the game- prefix", () => {
    expect(() =>
      createGameSliceFromBrief({
        id: "slice-1",
        now: "2026-08-26T00:00:00.000Z",
        brief: { requirement: "anything", genre: "exploration" },
      }),
    ).toThrow(/game-/i);
    expect(
      gameSliceSchema.safeParse({
        ...createGameSliceFromBrief({
          id: "game-valid-id-01",
          now: "2026-08-26T00:00:00.000Z",
          brief: { requirement: "x", genre: "rpg" },
        }),
        brief: { requirement: "x", genre: "platformer" },
      }).success,
    ).toBe(false);
  });

  it("carries a corrective bind call when the player role is unbound", () => {
    const slice = createGameSliceFromBrief({
      id: "game-bind-hint-01",
      now: "2026-08-26T00:00:00.000Z",
      brief: { requirement: "walk", genre: "exploration" },
    });
    const issue = playerUnboundIssue(slice);
    expect(issue.code).toBe("player_unbound");
    expect(issue.corrective_call).toMatchObject({ op: "bind", slice_id: slice.id });
  });
});
