/**
 * Genre playtest script fixtures and bind helpers for host-free acceptance.
 * Vocabulary stays in capabilities/describe; these helpers only build tapes
 * that exercise each genre's default `acceptance.operations`.
 */

import {
  createGameSliceFromBrief,
  gamePlaytestScriptSchema,
  type GamePlaytestScript,
  type GamePlaytestScriptInput,
  type GamePlaytestStepInput,
  type GameSlice,
  type GameSliceGenre,
  type GameSliceVerb,
} from "./gameSliceProtocol";

/** Deterministic object ids for test/bind-complete slices. */
export function bindSliceRolesForTest(slice: GameSlice, prefix = "obj"): GameSlice {
  return {
    ...slice,
    status: "bound",
    roles: slice.roles.map((role, index) => ({
      ...role,
      object_id: role.object_id ?? `${prefix}-${role.id}-${index + 1}`,
    })),
  };
}

/** Map one acceptance verb onto a short held-input step. */
export function playtestStepForVerb(verb: GameSliceVerb): GamePlaytestStepInput {
  switch (verb) {
    case "move":
      return { frames: 16, input: { forward: true }, expect: { verb: "move" } };
    case "look":
      return { frames: 10, input: { look_right: true }, expect: { verb: "look" } };
    case "jump":
      return { frames: 8, input: { jump: true }, expect: { verb: "jump" } };
    case "sprint":
      return { frames: 12, input: { forward: true, sprint: true }, expect: { verb: "sprint" } };
    case "dash":
      return { frames: 8, input: { forward: true, dash: true }, expect: { verb: "dash" } };
    case "crouch":
      return { frames: 8, input: { crouch: true }, expect: { verb: "crouch" } };
    case "interact":
      return { frames: 6, input: { interact: true }, expect: { verb: "interact" } };
    case "fire":
      return { frames: 6, input: { fire: true }, expect: { verb: "fire" } };
    case "attack":
      return { frames: 6, input: { fire: true }, expect: { verb: "attack" } };
    case "reload":
      return { frames: 6, input: { fire: true }, expect: { verb: "reload" } };
    case "enter_vehicle":
      return { frames: 4, input: { enter_vehicle: true }, expect: { verb: "enter_vehicle" } };
    case "exit_vehicle":
      return { frames: 4, input: { exit_vehicle: true }, expect: { verb: "exit_vehicle" } };
    case "pause":
      return { frames: 4, input: { pause: true }, expect: { verb: "pause" } };
  }
}

/**
 * Build a scripted tape that exercises every verb in `operations` (in order).
 * Used by observe suggestions and genre fixtures.
 */
export function suggestedPlaytestScriptForVerbs(
  operations: readonly GameSliceVerb[],
): GamePlaytestScript {
  const steps = operations.map((verb) => playtestStepForVerb(verb));
  return gamePlaytestScriptSchema.parse({ steps });
}

/** Suggested tape from a slice's acceptance operations. */
export function suggestedPlaytestScriptForSlice(slice: GameSlice): GamePlaytestScript {
  return suggestedPlaytestScriptForVerbs(slice.acceptance.operations);
}

const GENRE_REQUIREMENTS: Record<GameSliceGenre, string> = {
  exploration: "Walk to the objective and interact.",
  fps: "Clear the range with aimed fire and a reload.",
  racing: "Enter the vehicle, drive the circuit, then exit.",
  fighting: "Close distance and land an attack.",
  rpg: "Reach the NPC, interact, then defeat the dummy.",
};

/**
 * Create a bind-complete slice for a genre plus a host-free script that should
 * score `playable` under default acceptance checks.
 */
export function createGenrePlaytestFixture(
  genre: GameSliceGenre,
  options: { sliceId?: string; now?: string } = {},
): { slice: GameSlice; script: GamePlaytestScriptInput } {
  const now = options.now ?? "2026-08-26T05:30:00.000Z";
  const id = options.sliceId ?? `game-fixture-${genre}`;
  const draft = createGameSliceFromBrief({
    id,
    brief: { requirement: GENRE_REQUIREMENTS[genre], genre },
    now,
  });
  const slice = bindSliceRolesForTest(draft);
  return { slice, script: suggestedPlaytestScriptForSlice(slice) };
}

export const GAME_SLICE_GENRES = [
  "exploration",
  "fps",
  "racing",
  "fighting",
  "rpg",
] as const satisfies readonly GameSliceGenre[];
