import { z } from "zod";
import { directorDccEngineIdSchema } from "./directorDccEngineSpace";

/**
 * Local engine process operations: opening the configured engine project in
 * its editor GUI, and running the project with bounded debug-output capture.
 *
 * These are trusted-local conveniences in the spirit of the community
 * godot-mcp / unity-mcp servers, folded into Director's typed surface: the
 * gateway only ever spawns the discovered engine executable against the
 * configured project with a fixed argument vector — never a request-supplied
 * script — and captured output is a bounded tail, never an unbounded log.
 */

const nonEmpty = z.string().trim().min(1);

/** Contract identifier for one engine editor GUI launch receipt. */
export const DIRECTOR_DCC_ENGINE_EDITOR_LAUNCH_CONTRACT = "director-dcc-engine-editor-launch-v1" as const;

/** Receipt for a detached engine editor launch (fire-and-forget GUI process). */
export const directorDccEngineEditorLaunchSchema = z.strictObject({
  contract: z.literal(DIRECTOR_DCC_ENGINE_EDITOR_LAUNCH_CONTRACT),
  provider: directorDccEngineIdSchema,
  executable: nonEmpty.max(1_024),
  projectPath: nonEmpty.max(1_024),
  pid: z.number().int().positive(),
  launchedAtMs: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(2_000)).max(32),
});

/** A validated engine editor launch receipt. */
export type DirectorDccEngineEditorLaunch = z.infer<typeof directorDccEngineEditorLaunchSchema>;

/** Contract identifier for one engine project run status. */
export const DIRECTOR_DCC_ENGINE_RUN_CONTRACT = "director-dcc-engine-run-v1" as const;

/** Lifecycle state of an engine project run. */
export const directorDccEngineRunStateSchema = z.enum(["running", "exited", "stopped", "failed"]);

/** A validated engine run state. */
export type DirectorDccEngineRunState = z.infer<typeof directorDccEngineRunStateSchema>;

/** Byte budget for the captured stdout/stderr tail of one run. */
export const DIRECTOR_DCC_ENGINE_RUN_MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * A `res://` scene path inside the configured Godot project. Rejects parent
 * segments and backslashes so a run can never address files outside the
 * project the gateway was configured with.
 */
export const directorDccGodotRunSceneSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^res:\/\/[^\\]+$/, "scene must be a res:// path inside the project")
  .refine(
    (value) =>
      value
        .slice("res://".length)
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: "scene path cannot contain empty, dot, or parent segments" },
  );

/**
 * One engine project run: identity, fixed spawn facts, lifecycle state, and
 * the bounded tail of interleaved stdout/stderr. `output` is deliberately a
 * tail with an explicit truncation flag — the full log never crosses the wire.
 */
export const directorDccEngineRunStatusSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_DCC_ENGINE_RUN_CONTRACT),
    provider: directorDccEngineIdSchema,
    runId: nonEmpty.max(120),
    executable: nonEmpty.max(1_024),
    projectPath: nonEmpty.max(1_024),
    scene: z.string().max(1_024).nullable(),
    headless: z.boolean(),
    pid: z.number().int().positive().nullable(),
    state: directorDccEngineRunStateSchema,
    exitCode: z.number().int().nullable(),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative().nullable(),
    output: z.string().max(DIRECTOR_DCC_ENGINE_RUN_MAX_OUTPUT_BYTES + 256),
    outputTruncated: z.boolean(),
  })
  .superRefine((status, context) => {
    if (status.state === "running" && status.endedAtMs !== null) {
      context.addIssue({ code: "custom", path: ["endedAtMs"], message: "running runs cannot carry an end time" });
    }
    if (status.state !== "running" && status.endedAtMs === null) {
      context.addIssue({ code: "custom", path: ["endedAtMs"], message: "finished runs must carry an end time" });
    }
  });

/** A validated engine project run status. */
export type DirectorDccEngineRunStatus = z.infer<typeof directorDccEngineRunStatusSchema>;

/** Machine-readable error codes for the engine run surface. */
export const directorDccEngineRunErrorCodeSchema = z.enum([
  "engine_run_not_ready",
  "engine_run_unsupported",
  "engine_run_active",
  "engine_run_unknown",
  "engine_run_invalid",
  "engine_run_failed",
]);

/** A validated engine run error code. */
export type DirectorDccEngineRunErrorCode = z.infer<typeof directorDccEngineRunErrorCodeSchema>;
