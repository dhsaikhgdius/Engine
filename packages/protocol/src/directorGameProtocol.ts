import { z } from "zod";
import directorGameCapabilities from "./directorGameCapabilities.json";
import {
  GAME_SLICE_CONTRACT,
  gameEvaluationReportSchema,
  gamePlaytestScriptSchema,
  gamePlaytestTraceSchema,
  gameSliceBindPatchSchema,
  gameSliceBriefSchema,
  gameSliceControlsSchema,
  gameSliceHudSchema,
  gameSliceIdSchema,
  gameSliceLoopSchema,
  gameSliceSchema,
} from "./gameSliceProtocol";
import { strictOperation } from "./strictProtocolVariant";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/**
 * Public `director_game` mega-op. Compact wire envelopes list `op`; exact
 * fields come from `describe` / `capabilities`. Gateway still validates this
 * full discriminated union.
 */
export const directorGameOperationSchema = z.discriminatedUnion("op", [
  strictOperation("capabilities", {}),
  /** Progressive schema disclosure. No slice state, no Stage tab. */
  strictOperation("describe", { target: nonEmptyText(200) }),
  strictOperation("plan", {
    brief: gameSliceBriefSchema,
    title: nonEmptyText(160).optional(),
    slice_id: gameSliceIdSchema.optional(),
  }),
  strictOperation("observe", {
    slice_id: gameSliceIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  strictOperation("bind", {
    slice_id: gameSliceIdSchema,
    bindings: z.array(gameSliceBindPatchSchema).min(1).max(64),
    project_revision: nonEmptyText(240).optional(),
  }),
  strictOperation("author_loop", {
    slice_id: gameSliceIdSchema,
    loop: gameSliceLoopSchema.partial(),
    controls: gameSliceControlsSchema.partial().optional(),
  }),
  strictOperation("author_hud", {
    slice_id: gameSliceIdSchema,
    hud: gameSliceHudSchema,
  }),
  strictOperation("playtest", {
    slice_id: gameSliceIdSchema,
    script: gamePlaytestScriptSchema,
    project_revision: nonEmptyText(240).optional(),
    /** Host-free path: supply a recorded trace instead of driving the live player. */
    trace: gamePlaytestTraceSchema.optional(),
  }),
  strictOperation("evaluate", {
    slice_id: gameSliceIdSchema,
    trace: gamePlaytestTraceSchema.optional(),
  }),
  /**
   * Hand the bound Stage scene to an engine through `director_dcc`.
   * Requires status `playable`. `stage` is not an export provider.
   */
  strictOperation("export_slice", {
    slice_id: gameSliceIdSchema,
    provider: z.enum(["godot", "unity", "unreal"]),
    formats: z.array(z.enum(["glb", "usda"])).min(1).max(2).optional(),
  }),
]);

export type DirectorGameOperation = z.infer<typeof directorGameOperationSchema>;
export type DirectorGameOperationInput = z.input<typeof directorGameOperationSchema>;

export const directorGameOperationNames = directorGameOperationSchema.options.map(
  (option) => option.shape.op.value,
) as [DirectorGameOperation["op"], ...DirectorGameOperation["op"][]];

export const DIRECTOR_GAME_TOOL_NAME = "director_game" as const;

/** Success envelope: `result` stays untyped here because each op documents its own result shape via describe. */
export const directorGameSuccessEnvelopeSchema = z.strictObject({
  success: z.literal(true),
  result: z.unknown(),
});

/**
 * Rejection envelope. `code` is machine-stable, `error` is the human/agent
 * message, and `corrective_call` is a ready-to-send request that would fix
 * the rejection — the machine treats rejections as a teaching channel, so
 * most rejections include one. `result` may carry partial evidence (for
 * example the typed issues that caused a playtest rejection).
 */
export const directorGameRejectionEnvelopeSchema = z.strictObject({
  success: z.literal(false),
  code: z.string().min(1).max(80),
  error: z.string().min(1).max(2_000),
  corrective_call: z.unknown().optional(),
  result: z.unknown().optional(),
});

export const directorGameEnvelopeSchema = z.discriminatedUnion("success", [
  directorGameSuccessEnvelopeSchema,
  directorGameRejectionEnvelopeSchema,
]);
export type DirectorGameEnvelope = z.infer<typeof directorGameEnvelopeSchema>;

export const directorGameCapabilitiesDocument = directorGameCapabilities;

export const DIRECTOR_GAME_CAPABILITIES_CONTRACT = GAME_SLICE_CONTRACT;
