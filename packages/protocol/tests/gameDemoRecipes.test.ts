import { describe, expect, it } from "vitest";
import { describeDirectorGameTarget } from "../src/directorGameDescribe";
import { createDirectorGameState, executeDirectorGame } from "../src/directorGameMachine";
import {
  GAME_DEMO_RECIPES,
  gameDemoRecipeIndex,
  gameDemoRecipeSchema,
  getGameDemoRecipe,
} from "../src/gameDemoRecipes";
import { createHostFreePlaytestRunner } from "../src/gamePlaytestHostFree";
import {
  GAME_SLICE_GENRES,
  createGameSliceFromBrief,
  type GameEvaluationReport,
  type GameSlice,
} from "../src/gameSliceProtocol";

const NOW = "2026-08-26T06:00:00.000Z";

describe("gameDemoRecipes", () => {
  it("ships exactly one schema-valid recipe per genre", () => {
    expect(GAME_DEMO_RECIPES.map((recipe) => recipe.genre)).toEqual([...GAME_SLICE_GENRES]);
    for (const recipe of GAME_DEMO_RECIPES) {
      const parsed = gameDemoRecipeSchema.safeParse(recipe);
      expect(parsed.success, `${recipe.recipe_id}: ${JSON.stringify(parsed.error?.issues[0])}`).toBe(true);
    }
  });

  it("keeps bind hints and acceptance verbs aligned with the planner for every genre", () => {
    for (const recipe of GAME_DEMO_RECIPES) {
      const slice = createGameSliceFromBrief({ id: `game-recipe-${recipe.genre}`, brief: recipe.brief, now: NOW });
      // Hints cover exactly the roles plan creates, in role order — an agent
      // can walk the hint list and bind without discovering extra roles.
      expect(
        recipe.bind_hints.map((hint) => hint.role_id),
        recipe.recipe_id,
      ).toEqual(slice.roles.map((role) => role.id));
      for (const hint of recipe.bind_hints) {
        expect(slice.roles.find((role) => role.id === hint.role_id)?.kind, recipe.recipe_id).toBe(hint.kind);
      }
      // The acceptance tape exercises the genre's acceptance operations in order.
      expect(
        recipe.acceptance_script.steps.map((step) => step.expect?.verb),
        recipe.recipe_id,
      ).toEqual(slice.acceptance.operations);
      // Recipes template the Stage-first defaults explicitly; plan adds no fallback notes.
      expect(recipe.brief.engine_target).toBe("stage");
      expect(slice.notes).toEqual([]);
    }
  });

  it("closes plan → bind → host-free playtest → playable for every recipe without an inline trace", async () => {
    for (const recipe of GAME_DEMO_RECIPES) {
      const state = createDirectorGameState();
      const context = { now: NOW, runPlaytest: createHostFreePlaytestRunner() };
      const sliceId = `game-eval-${recipe.genre}-recipe`;

      const planned = await executeDirectorGame(state, { op: "plan", slice_id: sliceId, brief: recipe.brief }, context);
      expect(planned.success, recipe.recipe_id).toBe(true);

      const bound = await executeDirectorGame(
        state,
        {
          op: "bind",
          slice_id: sliceId,
          bindings: recipe.bind_hints.map((hint) => ({
            role_id: hint.role_id,
            object_id: `test-${hint.role_id}`,
            source: hint.source,
          })),
        },
        context,
      );
      expect(bound, recipe.recipe_id).toMatchObject({ success: true, result: { bind_complete: true } });

      const playtested = await executeDirectorGame(
        state,
        { op: "playtest", slice_id: sliceId, script: recipe.acceptance_script },
        context,
      );
      expect(playtested.success, `${recipe.recipe_id}: ${JSON.stringify(playtested)}`).toBe(true);
      if (!playtested.success) throw new Error("playtest failed");
      const result = playtested.result as { evaluation: GameEvaluationReport; slice: GameSlice };
      expect(result.evaluation.playable, `${recipe.recipe_id}: ${JSON.stringify(result.evaluation.issues)}`).toBe(true);
      expect(result.slice.status).toBe("playable");
      for (const verb of result.slice.acceptance.operations) {
        expect(result.evaluation.verbs_exercised, recipe.recipe_id).toContain(verb);
      }
    }
  });

  it("exposes the compact index on capabilities and full documents through describe", async () => {
    const state = createDirectorGameState();
    const capabilities = await executeDirectorGame(state, { op: "capabilities" }, { now: NOW });
    expect(capabilities.success).toBe(true);
    if (!capabilities.success) throw new Error("capabilities failed");
    const index = (capabilities.result as { demo_recipes: ReturnType<typeof gameDemoRecipeIndex> }).demo_recipes;
    expect(index).toEqual(gameDemoRecipeIndex());
    // The index stays compact: no briefs, hints, or tapes on capabilities.
    for (const entry of index) {
      expect(Object.keys(entry).sort()).toEqual(["genre", "recipe_id", "summary"]);
    }

    const all = describeDirectorGameTarget("demo_recipes");
    expect("error" in all).toBe(false);
    if ("error" in all) throw new Error(all.error);
    expect(all.kind).toBe("data");
    expect(all.recipes).toHaveLength(GAME_SLICE_GENRES.length);

    const fps = describeDirectorGameTarget("demo_recipes.fps");
    if ("error" in fps) throw new Error(fps.error);
    expect(fps.recipe?.recipe_id).toBe("demo-fps-target-range");
    expect(getGameDemoRecipe("demo-fps-target-range")?.genre).toBe("fps");

    const unknown = describeDirectorGameTarget("demo_recipes.moba");
    expect("error" in unknown && unknown.error).toContain("demo_recipes.fps");
    const machineUnknown = await executeDirectorGame(
      state,
      { op: "describe", target: "demo_recipes.moba" },
      { now: NOW },
    );
    expect(machineUnknown).toMatchObject({ success: false, code: "unknown_describe_target" });
  });
});
