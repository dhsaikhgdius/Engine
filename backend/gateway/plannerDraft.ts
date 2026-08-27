import { z } from "zod";

/**
 * Decoding and retry-coaching helpers for planner CLI output. The planner
 * CLIs emit transport envelopes (Claude wraps the plan in structured_output
 * or a stringified `result`; the strict CLI carries per-operation
 * `input_json` strings) that must be unwrapped here before the unified plan
 * validator runs, so the validator only ever sees the logical plan shape.
 */

const plannerOperationEnvelopeSchema = z.looseObject({
  input_json: z.string(),
});

const plannerDraftEnvelopeSchema = z.looseObject({
  operations: z.array(plannerOperationEnvelopeSchema),
});

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** Prompt-side contract for the per-operation `input_json` field. */
export const DIRECTOR_WORKBENCH_INPUT_JSON_DESCRIPTION = [
  "A compact JSON object containing exactly one public tool input and an op field.",
  "For director_workbench author, actions must be non-empty.",
  'set_scene is optional and is never a create-scene marker; when present it MUST contain a non-empty patch object, for example {"action":"set_scene","patch":{"backgroundColor":"#182033","showGround":true}}.',
  "If no global scene setting changes, omit set_scene entirely.",
  "Omit expected_revision, expected_snapshot_fingerprint, expected_collaboration_fingerprint, and idempotency_key; the gateway injects fresh concurrency guards when the plan is applied.",
].join(" ");

/**
 * Turn a strict validation failure into a concrete second-attempt instruction.
 * Models otherwise tend to reproduce the same malformed action because the
 * generic Zod error does not explain whether a field should be added or the
 * action should be removed.
 */
export function createPlannerRetryMessage(request: string, error: string) {
  const setScenePatchFailure = /actions\.\d+\.patch|set_scene[^\n]*patch/i.test(error);
  const missingActionField = error.match(/actions\.(\d+)\.([a-z_]+) is missing/i);
  const correction = setScenePatchFailure
    ? [
        "Targeted fix: set_scene is not a create-scene or start-building marker.",
        'Use it only when you actually change background, ground, scene transform, or timeline, and write {"action":"set_scene","patch":{at least one supported field}}.',
        "If the original task does not change those global settings, delete the set_scene action entirely; do not emit set_scene with only an action and no patch.",
      ].join(" ")
    : missingActionField
      ? `Targeted fix: actions.${missingActionField[1]}.${missingActionField[2]} is required. Supply the correct stable ID or required value for that action type; if the action is duplicate or has no effect, delete it entirely. Do not use null, empty strings, or guessed placeholders.`
      : "Correct field types, enums, required fields, and unsupported extra fields against the public tool contract, item by item.";
  return [
    request,
    "",
    `The previous plan failed strict validation: ${error}.`,
    correction,
    "Regenerate the complete plan. Fix only JSON and tool fields, keep the original task scope, and do not explain.",
  ].join("\n");
}

/** Decode Claude's transport envelope before the unified plan validator runs. */
export function decodeClaudePlannerOutput(output: string): unknown {
  const parsed: unknown = JSON.parse(output);
  const envelope = jsonObjectSchema.safeParse(parsed);
  if (!envelope.success) return parsed;
  const structuredOutput = jsonObjectSchema.safeParse(envelope.data.structured_output);
  if (structuredOutput.success) return structuredOutput.data;
  if (typeof envelope.data.result === "string") return JSON.parse(envelope.data.result);
  return parsed;
}

/** Decode the strict CLI envelope without leaking its transport-only field. */
export function decodePlannerDraft(value: unknown): unknown {
  const parsedDraft = plannerDraftEnvelopeSchema.safeParse(value);
  if (!parsedDraft.success) throw new Error("Plan has no operations array");
  const draft = parsedDraft.data;
  return {
    summary: draft.summary,
    ...(typeof draft.suggested_next === "string" ? { suggested_next: draft.suggested_next } : {}),
    operations: draft.operations.map((value, index) => {
      let input: unknown;
      try {
        input = JSON.parse(value.input_json);
      } catch {
        throw new Error(`Step ${index + 1} input_json is not valid JSON`);
      }
      if (!jsonObjectSchema.safeParse(input).success) throw new Error(`Step ${index + 1} input_json is not an object`);
      return { tool: value.tool, summary: value.summary, input };
    }),
  };
}
