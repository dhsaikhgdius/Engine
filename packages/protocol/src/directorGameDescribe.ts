import { z } from "zod";
import { directorGameOperationNames, directorGameOperationSchema } from "./directorGameProtocol";
import {
  GAME_DEMO_RECIPES,
  gameDemoRecipeDescribeTargets,
  getGameDemoRecipe,
  type GameDemoRecipe,
} from "./gameDemoRecipes";
import { gameSliceBindPatchSchema, gameSliceBriefSchema, gameSliceHudSchema } from "./gameSliceProtocol";

/**
 * Serialized JSON Schema size cap for one describe reply. Oversized schemas
 * degrade to a field-name list instead of flooding the agent's context — a
 * describe answer that costs more tokens than it saves defeats progressive
 * disclosure.
 */
const DESCRIBE_SCHEMA_BUDGET_BYTES = 20_000;

const JSON_SCHEMA_OPTIONS = {
  unrepresentable: "any",
  cycles: "ref",
  reused: "inline",
  io: "input",
} as const;

/** Result of describing one `director_game` operation or data target. */
export interface DirectorGameDescribeResult {
  target: string;
  kind: "operation" | "data";
  json_schema?: unknown;
  fields?: string[];
  /** Full demo recipe documents for the `demo_recipes` data target. */
  recipes?: GameDemoRecipe[];
  /** One demo recipe for a `demo_recipes.<genre>` data target. */
  recipe?: GameDemoRecipe;
  note?: string;
}

function serializedJsonSchema(schema: z.ZodType): { json: string; parsed: unknown } {
  const parsed = z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS);
  return { json: JSON.stringify(parsed), parsed };
}

const EXTRA_TARGETS: Record<string, z.ZodType> = {
  "plan.brief": gameSliceBriefSchema,
  "bind.bindings": z.array(gameSliceBindPatchSchema).min(1).max(64),
  "author_hud.hud": gameSliceHudSchema,
};

/**
 * Progressive disclosure for `director_game`. Pure contract reflection — no
 * slice store and no Stage tab. Unknown targets return a rejection payload
 * listing valid operations rather than throwing.
 */
export function describeDirectorGameTarget(target: string): DirectorGameDescribeResult | { error: string } {
  const normalized = target.trim();
  if (normalized === "demo_recipes") {
    return {
      target: normalized,
      kind: "data",
      recipes: [...GAME_DEMO_RECIPES],
      note: "Copy a recipe brief into plan, bind the hinted roles to Stage object ids, then playtest with acceptance_script (the host-free runner fills the trace).",
    };
  }
  if (normalized.startsWith("demo_recipes.")) {
    const recipe = getGameDemoRecipe(normalized.slice("demo_recipes.".length));
    if (recipe) return { target: normalized, kind: "data", recipe };
    return {
      error: `Unknown demo recipe "${target}". Valid targets: demo_recipes, ${gameDemoRecipeDescribeTargets().join(", ")}.`,
    };
  }
  const extra = EXTRA_TARGETS[normalized];
  if (extra) {
    const serialized = serializedJsonSchema(extra);
    if (serialized.json.length <= DESCRIBE_SCHEMA_BUDGET_BYTES) {
      return { target: normalized, kind: "operation", json_schema: serialized.parsed };
    }
    return {
      target: normalized,
      kind: "operation",
      fields: Object.keys(
        ((serialized.parsed as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>,
      ),
      note: "Schema exceeded the describe budget; fields listed instead.",
    };
  }
  const option = directorGameOperationSchema.options.find((candidate) => candidate.shape.op.value === normalized);
  if (!option) {
    return {
      error: `Unknown describe target "${target}". Valid operations: ${directorGameOperationNames.join(", ")}. Nested slices: ${Object.keys(EXTRA_TARGETS).join(", ")}. Data: demo_recipes, demo_recipes.<genre>.`,
    };
  }
  const serialized = serializedJsonSchema(option);
  if (serialized.json.length <= DESCRIBE_SCHEMA_BUDGET_BYTES) {
    return { target: normalized, kind: "operation", json_schema: serialized.parsed };
  }
  return {
    target: normalized,
    kind: "operation",
    fields: Object.keys(
      ((serialized.parsed as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>,
    ),
    note: "Schema exceeded the describe budget; fields listed instead.",
  };
}
