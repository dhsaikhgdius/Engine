// @vitest-environment node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getGameDemoRecipe } from "../../packages/protocol/src/gameDemoRecipes";
import { gamePlaytestScriptSchema } from "../../packages/protocol/src/gameSliceProtocol";

const tasksDirectory = join(dirname(fileURLToPath(import.meta.url)), "tasks");

/** The `NN-game-demo-*` golden tasks replay every published genre demo recipe verbatim. */
const RECIPE_TASKS = [
  { file: "16-game-demo-fps-recipe-hostfree.json", genre: "fps" },
  { file: "17-game-demo-racing-recipe-hostfree.json", genre: "racing" },
  { file: "18-game-demo-rpg-recipe-hostfree.json", genre: "rpg" },
  { file: "19-game-demo-exploration-recipe-hostfree.json", genre: "exploration" },
  { file: "20-game-demo-fighting-recipe-hostfree.json", genre: "fighting" },
] as const;

type TaskStep = {
  label: string;
  input: { op: string; brief?: unknown; script?: unknown; trace?: unknown };
  expect: { result_equals?: Record<string, unknown> };
};

describe("game demo recipe golden tasks", () => {
  for (const { file, genre } of RECIPE_TASKS) {
    it(`${file} replays the ${genre} recipe host-free without an inline trace`, async () => {
      const recipe = getGameDemoRecipe(genre);
      expect(recipe).toBeDefined();
      if (!recipe) throw new Error(`no ${genre} recipe`);
      const task = JSON.parse(await readFile(join(tasksDirectory, file), "utf8")) as { steps: TaskStep[] };

      const plan = task.steps.find((step) => step.input.op === "plan");
      expect(plan, "plan step").toBeDefined();
      // The task brief is the recipe brief template, copied verbatim.
      expect(plan?.input.brief).toEqual(recipe.brief);

      const playtest = task.steps.find((step) => step.input.op === "playtest");
      expect(playtest, "playtest step").toBeDefined();
      // Host-free: the gateway kinematic runner supplies the trace.
      expect(playtest?.input.trace).toBeUndefined();
      // The tape is the recipe acceptance script (normalized through the schema).
      expect(gamePlaytestScriptSchema.parse(playtest?.input.script)).toEqual(
        gamePlaytestScriptSchema.parse(recipe.acceptance_script),
      );
      // The receipt is asserted literally, not just non-null.
      expect(playtest?.expect.result_equals?.["result.evaluation.playable"]).toBe(true);
      expect(playtest?.expect.result_equals?.["result.slice.status"]).toBe("playable");
    });
  }
});
