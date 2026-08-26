import { z } from "zod";
import {
  GAME_SLICE_GENRES,
  gamePlaytestScriptSchema,
  gameSliceAssetSourceSchema,
  gameSliceBriefSchema,
  gameSliceGenreSchema,
  gameSliceRoleKindSchema,
  type GameSliceGenre,
} from "./gameSliceProtocol";

/**
 * Genre demo game-slice recipes — harness data, not skill prose.
 *
 * GameFactory-style stacks teach genres through markdown skill dumps that end
 * in generated UE/Unity/Godot source. Director instead ships each genre demo
 * as a typed recipe an agent can execute through the existing `director_game`
 * loop: copy `brief` into `plan`, bind the hinted roles to live Stage object
 * ids, then run `acceptance_script` through `playtest` (the Gateway host-free
 * kinematic runner fills the trace) until the evaluation is `playable`.
 *
 * Recipes reuse only capabilities/describe vocabulary (genres, verbs, role
 * kinds, asset sources); they never introduce new teaching prose or engine
 * source. Discovery: `capabilities` lists a compact index under
 * `demo_recipes`; `describe` target `demo_recipes` (all) or
 * `demo_recipes.<genre>` (one) returns the full documents.
 */

/** Protocol contract identifier for one demo recipe document. */
export const GAME_DEMO_RECIPE_CONTRACT = "director-game-demo-recipe-v1" as const;

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/**
 * One role the recipe expects the agent to bind. `suggestion` says what kind
 * of Stage object to place or pick (via `director_workbench` observe/catalog),
 * never a hard-coded object id — ids are project-specific.
 */
export const gameDemoRecipeBindHintSchema = z.strictObject({
  role_id: nonEmptyText(80),
  kind: gameSliceRoleKindSchema,
  source: gameSliceAssetSourceSchema,
  suggestion: nonEmptyText(500),
});
export type GameDemoRecipeBindHint = z.infer<typeof gameDemoRecipeBindHintSchema>;

export const gameDemoRecipeSchema = z.strictObject({
  contract: z.literal(GAME_DEMO_RECIPE_CONTRACT),
  recipe_id: z.string().regex(/^demo-[a-z0-9-]{4,60}$/),
  genre: gameSliceGenreSchema,
  summary: nonEmptyText(240),
  /** Plan-ready template: pass verbatim as `{"op":"plan","brief":...}`. */
  brief: gameSliceBriefSchema,
  /** Role ids match the slice `plan` produces for this genre, in role order. */
  bind_hints: z.array(gameDemoRecipeBindHintSchema).min(1).max(16),
  /**
   * Scripted input tape that exercises every default acceptance verb for the
   * genre and scores `playable` under the host-free kinematic runner.
   */
  acceptance_script: gamePlaytestScriptSchema,
});
/** Wire (sparse) shape — recipes are published without materialized input defaults. */
export type GameDemoRecipe = z.input<typeof gameDemoRecipeSchema>;

const PLAYER_HINT: GameDemoRecipe["bind_hints"][number] = {
  role_id: "player",
  kind: "player",
  source: "catalog",
  suggestion:
    "Grounded Stage character (catalog mannequin or a promoted generated_3d hero) the live player session can possess.",
};

const SPAWN_HINT: GameDemoRecipe["bind_hints"][number] = {
  role_id: "spawn",
  kind: "spawn",
  source: "project",
  suggestion: "Small grounded marker object at the intended spawn/respawn point; any existing project object works.",
};

export const GAME_DEMO_RECIPES: readonly GameDemoRecipe[] = [
  {
    contract: GAME_DEMO_RECIPE_CONTRACT,
    recipe_id: "demo-exploration-stele-walk",
    genre: "exploration",
    summary: "Walk the courtyard, hop the low step, and interact with the stone stele.",
    brief: {
      requirement: "Walk across the courtyard, hop over the low stone step, and interact with the stele to read it.",
      genre: "exploration",
      perspective: "third",
      engine_target: "stage",
      style: "white-box clay (metric, untextured silhouettes)",
    },
    bind_hints: [
      PLAYER_HINT,
      SPAWN_HINT,
      {
        role_id: "objective-1",
        kind: "objective",
        source: "catalog",
        suggestion: "Interactable stele/terminal prop placed within walking distance of the spawn marker.",
      },
    ],
    acceptance_script: {
      steps: [
        { frames: 16, input: { forward: true }, expect: { verb: "move" } },
        { frames: 10, input: { look_right: true }, expect: { verb: "look" } },
        { frames: 8, input: { jump: true }, expect: { verb: "jump" } },
        { frames: 6, input: { interact: true }, expect: { verb: "interact" } },
      ],
    },
  },
  {
    contract: GAME_DEMO_RECIPE_CONTRACT,
    recipe_id: "demo-fps-target-range",
    genre: "fps",
    summary: "Sprint between cover on a target range, fire at a dummy target, and reload once.",
    brief: {
      requirement:
        "Clear a small target range: sprint between two cover blocks, fire at the dummy target, and reload once without leaving the range floor.",
      genre: "fps",
      perspective: "first",
      engine_target: "stage",
      style: "white-box clay (metric, untextured silhouettes)",
    },
    bind_hints: [
      PLAYER_HINT,
      {
        role_id: "enemy-1",
        kind: "enemy",
        source: "catalog",
        suggestion: "Target dummy character placed 5-10 m downrange of the spawn marker, facing the player.",
      },
      SPAWN_HINT,
    ],
    acceptance_script: {
      steps: [
        { frames: 16, input: { forward: true }, expect: { verb: "move" } },
        { frames: 10, input: { look_right: true }, expect: { verb: "look" } },
        { frames: 8, input: { jump: true }, expect: { verb: "jump" } },
        { frames: 12, input: { forward: true, sprint: true }, expect: { verb: "sprint" } },
        { frames: 6, input: { fire: true }, expect: { verb: "fire" } },
        { frames: 6, input: { fire: true }, expect: { verb: "reload" } },
      ],
    },
  },
  {
    contract: GAME_DEMO_RECIPE_CONTRACT,
    recipe_id: "demo-racing-circuit-lap",
    genre: "racing",
    summary: "Enter the parked kart, drive a short gated circuit, and exit at the finish line.",
    brief: {
      requirement:
        "Enter the parked kart, drive one lap around a short circuit marked by corner gates, then exit the vehicle at the finish line.",
      genre: "racing",
      perspective: "third",
      engine_target: "stage",
      style: "white-box clay (metric, untextured silhouettes)",
    },
    bind_hints: [
      PLAYER_HINT,
      {
        role_id: "vehicle",
        kind: "vehicle",
        source: "catalog",
        suggestion: "Drivable vehicle mesh (kart/car) parked beside the spawn marker; the player enters it with enter_vehicle.",
      },
      SPAWN_HINT,
    ],
    acceptance_script: {
      steps: [
        { frames: 16, input: { forward: true }, expect: { verb: "move" } },
        { frames: 10, input: { look_right: true }, expect: { verb: "look" } },
        { frames: 4, input: { enter_vehicle: true }, expect: { verb: "enter_vehicle" } },
        { frames: 4, input: { exit_vehicle: true }, expect: { verb: "exit_vehicle" } },
      ],
    },
  },
  {
    contract: GAME_DEMO_RECIPE_CONTRACT,
    recipe_id: "demo-fighting-duel-circle",
    genre: "fighting",
    summary: "Close the distance in the duel circle, dash through guard, and land an attack.",
    brief: {
      requirement:
        "Close the distance across the duel circle, dash through the opponent's guard, and land one attack on the training opponent.",
      genre: "fighting",
      perspective: "third",
      engine_target: "stage",
      style: "white-box clay (metric, untextured silhouettes)",
    },
    bind_hints: [
      PLAYER_HINT,
      {
        role_id: "enemy-1",
        kind: "enemy",
        source: "catalog",
        suggestion: "Opposing character placed a few meters across the duel circle from the spawn marker.",
      },
      SPAWN_HINT,
    ],
    acceptance_script: {
      steps: [
        { frames: 16, input: { forward: true }, expect: { verb: "move" } },
        { frames: 10, input: { look_right: true }, expect: { verb: "look" } },
        { frames: 8, input: { jump: true }, expect: { verb: "jump" } },
        { frames: 6, input: { fire: true }, expect: { verb: "attack" } },
        { frames: 8, input: { forward: true, dash: true }, expect: { verb: "dash" } },
      ],
    },
  },
  {
    contract: GAME_DEMO_RECIPE_CONTRACT,
    recipe_id: "demo-rpg-courtyard-quest",
    genre: "rpg",
    summary: "Reach the quest giver, interact to accept the task, then defeat the training dummy.",
    brief: {
      requirement:
        "Walk to the quest giver by the well, interact to accept the task, then defeat the training dummy behind the well.",
      genre: "rpg",
      perspective: "third",
      engine_target: "stage",
      style: "white-box clay (metric, untextured silhouettes)",
    },
    bind_hints: [
      PLAYER_HINT,
      {
        role_id: "enemy-1",
        kind: "enemy",
        source: "catalog",
        suggestion: "Training dummy character placed behind the objective, reachable after the interact.",
      },
      SPAWN_HINT,
      {
        role_id: "objective-1",
        kind: "objective",
        source: "catalog",
        suggestion: "Quest-giver NPC or interactable prop within walking distance of the spawn marker.",
      },
    ],
    acceptance_script: {
      steps: [
        { frames: 16, input: { forward: true }, expect: { verb: "move" } },
        { frames: 10, input: { look_right: true }, expect: { verb: "look" } },
        { frames: 8, input: { jump: true }, expect: { verb: "jump" } },
        { frames: 6, input: { interact: true }, expect: { verb: "interact" } },
        { frames: 6, input: { fire: true }, expect: { verb: "attack" } },
      ],
    },
  },
];

/** Compact `capabilities` index entry: enough to pick a recipe, nothing more. */
export type GameDemoRecipeIndexEntry = {
  recipe_id: string;
  genre: GameSliceGenre;
  summary: string;
};

/** Compact index for the `capabilities` result (one entry per genre). */
export function gameDemoRecipeIndex(): GameDemoRecipeIndexEntry[] {
  return GAME_DEMO_RECIPES.map(({ recipe_id, genre, summary }) => ({ recipe_id, genre, summary }));
}

/** Look one recipe up by genre or recipe id. */
export function getGameDemoRecipe(genreOrRecipeId: string): GameDemoRecipe | undefined {
  const key = genreOrRecipeId.trim();
  return GAME_DEMO_RECIPES.find((recipe) => recipe.genre === key || recipe.recipe_id === key);
}

/** Valid `describe` suffixes for `demo_recipes.<...>`, used in rejection messages. */
export function gameDemoRecipeDescribeTargets(): string[] {
  return GAME_SLICE_GENRES.map((genre) => `demo_recipes.${genre}`);
}
