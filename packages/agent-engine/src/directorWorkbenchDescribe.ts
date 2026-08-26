import { z } from "zod";
import {
  directorAuthorEvidenceProfileSchema,
  directorWorkbenchOperationSchema,
  directorWorkbenchOperationNames,
  DIRECTOR_AUTHORING_ACTION_ALIASES,
  BLENDER_NATIVE_APPLY_HINT,
} from "./directorWorkbenchContract";
import { directorAuthoringActionSchema } from "./directorAuthoring";
import { directorKernelOwnershipSchema } from "./directorKernelOwnership";
import { blenderAgentOperationNames } from "@director/protocol/blenderLiveProtocol";

const blenderTypedApplyOpNames = new Set<string>(blenderAgentOperationNames);

/**
 * Progressive disclosure for the workbench contract: the MCP wire advertises
 * only a compact envelope (the full contract serializes to ~270 KB), so an
 * agent that needs the exact parameter shape of one operation or one author
 * action asks for precisely that slice here. Pure contract reflection — no
 * project state, no browser tab.
 */

/** Largest JSON Schema (serialized bytes) describe embeds before degrading to a field summary. */
const DESCRIBE_SCHEMA_BUDGET_BYTES = 20_000;

const JSON_SCHEMA_OPTIONS = {
  unrepresentable: "any",
  cycles: "ref",
  reused: "inline",
  io: "input",
} as const;

/**
 * The result of describing a single workbench operation or author action.
 *
 * When the target's JSON Schema fits within the describe budget the full
 * schema is embedded; otherwise the result degrades to a field-name
 * summary so the caller can request a narrower slice.
 */
export interface DirectorWorkbenchDescribeResult {
  /** The normalized target identifier, e.g. `"stage_read"` or `"author.add_object"`. */
  target: string;
  /** Whether this describes a top-level operation, author action, or author-level profile. */
  kind: "operation" | "author_action" | "author_profile";
  /** Full JSON Schema of the target; omitted when it exceeds the describe budget. */
  json_schema?: unknown;
  /** Top-level parameter names, returned when the full schema is over budget. */
  fields?: string[];
  /** Valid `author.<action>` targets; returned for the author operation. */
  author_actions?: string[];
  /** JSON Schemas of stable result blocks, keyed by result field name; returned for inspect. */
  result_schemas?: Record<string, unknown>;
  /** Human-readable hint when the result is degraded or non-standard. */
  note?: string;
}

/** All valid author action names derived from the authoring action schema. */
export const directorAuthoringActionNames = directorAuthoringActionSchema.options.map(
  (option) => option.shape.action.value,
);

function serializedJsonSchema(schema: z.ZodType): { json: string; parsed: unknown } {
  const parsed = z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS);
  return { json: JSON.stringify(parsed), parsed };
}

function describeOperation(target: string): DirectorWorkbenchDescribeResult | null {
  const option = directorWorkbenchOperationSchema.options.find((candidate) => candidate.shape.op.value === target);
  if (!option) return null;
  const authorActions = target === "author" ? directorAuthoringActionNames : undefined;
  // The kernel-ownership vocabulary lives on the inspect result, so describe
  // is the single reflective source for both the input and that result block.
  const resultSchemas =
    target === "inspect"
      ? { kernel_ownership: z.toJSONSchema(directorKernelOwnershipSchema, JSON_SCHEMA_OPTIONS) }
      : undefined;
  const serialized = serializedJsonSchema(option);
  if (serialized.json.length <= DESCRIBE_SCHEMA_BUDGET_BYTES) {
    return {
      target,
      kind: "operation",
      json_schema: serialized.parsed,
      ...(authorActions ? { author_actions: authorActions } : {}),
      ...(resultSchemas ? { result_schemas: resultSchemas } : {}),
    };
  }
  // Degrade to a field summary when the full schema is too large
  // for the compact MCP envelope; the caller can then request a
  // narrower author.<action> slice.
  return {
    target,
    kind: "operation",
    fields: Object.keys(option.shape),
    ...(authorActions ? { author_actions: authorActions } : {}),
    note:
      target === "author"
        ? 'The full author schema exceeds the describe budget. Request one action schema with target "author.<action>", e.g. "author.add_object".'
        : "The full schema exceeds the describe budget; fields lists the top-level parameters.",
  };
}

function describeAuthorAction(action: string): DirectorWorkbenchDescribeResult | null {
  const canonical = DIRECTOR_AUTHORING_ACTION_ALIASES[action] ?? action;
  const option = directorAuthoringActionSchema.options.find((candidate) => candidate.shape.action.value === canonical);
  if (!option) return null;
  const target = `author.${canonical}`;
  const aliasNote =
    canonical !== action
      ? `"${action}" is an alias of ${canonical}. Deletion uses object_ids, light_ids, or camera_ids.`
      : undefined;
  const serialized = serializedJsonSchema(option);
  if (serialized.json.length <= DESCRIBE_SCHEMA_BUDGET_BYTES) {
    return {
      target,
      kind: "author_action",
      json_schema: serialized.parsed,
      ...(aliasNote ? { note: aliasNote } : {}),
    };
  }
  return {
    target,
    kind: "author_action",
    fields: Object.keys(option.shape),
    note: aliasNote ?? "The full schema exceeds the describe budget; fields lists the top-level parameters.",
  };
}

function describeAuthorEvidence(): DirectorWorkbenchDescribeResult {
  return {
    target: "author.evidence",
    kind: "author_profile",
    json_schema: serializedJsonSchema(directorAuthorEvidenceProfileSchema).parsed,
    note: "Use this object as the top-level evidence field of an author request. An empty object selects the defaults.",
  };
}

/**
 * Resolves a target string to either a top-level operation or an author
 * action description.
 *
 * Targets of the form `"author.<action>"` are routed to the author-action
 * sub-schema, with `author.evidence` exposing the author-level capture profile.
 * Bare operation names are looked up in the full workbench contract. Other
 * dotted names are rejected.
 *
 * @param rawTarget - The raw target string from the MCP `describe` operation.
 * @returns A success result with the description, or an error message with
 *   hints for valid targets.
 */
export function describeDirectorWorkbenchTarget(
  rawTarget: string,
): { success: true; result: DirectorWorkbenchDescribeResult } | { success: false; error: string } {
  const target = rawTarget.trim();
  if (target === "apply" || target.startsWith("apply.")) {
    const slice = target === "apply" ? "apply" : target.slice("apply.".length) || "create_primitive";
    return {
      success: false,
      error: `Unknown describe target "${target}". ${BLENDER_NATIVE_APPLY_HINT} Try blender_native {"op":"describe","target":"${slice}"}.`,
    };
  }
  if (target === "author.evidence") return { success: true, result: describeAuthorEvidence() };
  if (target === "game_playtest") {
    return {
      success: false,
      error:
        'game_playtest is an internal Gateway→Stage transport, not a public director_workbench op. Use director_game {"op":"playtest"} (capabilities/describe on director_game).',
    };
  }
  if (target.startsWith("author.")) {
    const described = describeAuthorAction(target.slice("author.".length));
    if (described) return { success: true, result: described };
    return {
      success: false,
      error: `Unknown author action "${target}". List valid actions with {"op":"describe","target":"author"}.`,
    };
  }
  const described = target.includes(".") ? null : describeOperation(target);
  if (described) return { success: true, result: described };
  if (!target.includes(".") && blenderTypedApplyOpNames.has(target)) {
    return {
      success: false,
      error: `Unknown describe target "${target}". ${BLENDER_NATIVE_APPLY_HINT} Try blender_native {"op":"describe","target":"${target}"}.`,
    };
  }
  return {
    success: false,
    error: `Unknown describe target "${target}". Valid operations: ${directorWorkbenchOperationNames.join(
      ", ",
    )}. Author actions use "author.<action>"; list them with {"op":"describe","target":"author"}.`,
  };
}
