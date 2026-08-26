import { z } from "zod";
import {
  FILM_RUN_PHASE_RECEIPT_LIMIT,
  filmRunErrorCodeSchema,
  filmRunIdSchema,
  filmRunPhaseReceiptSchema,
  filmRunPhaseSchema,
  filmRunProgress,
  filmRunStatusSchema,
  filmWorkflowSchema,
  type FilmRun,
  type FilmRunStatus,
} from "./filmPipelineProtocol";

/**
 * Contract tag stamped on every normalized film run receipt. The receipt is
 * the uniform projection of a durable film run that Agent, HTTP, and UI
 * surfaces share — the film-pipeline sibling of
 * `director-production-job-receipt-v1`, so long-running film runs report
 * identity, lifecycle, progress, phase history, artifacts, and errors with
 * the same discipline as durable production jobs.
 */
export const FILM_RUN_RECEIPT_CONTRACT = "director-film-run-receipt-v1" as const;

const TERMINAL: ReadonlySet<FilmRunStatus> = new Set(["completed", "failed", "cancelled"]);

/**
 * Whether a film run status is terminal (no further transitions without an
 * explicit resume).
 */
export function isTerminalFilmRunStatus(status: FilmRunStatus) {
  return TERMINAL.has(status);
}

/**
 * Normalized receipt for one durable film run. Purely a projection of
 * {@link FilmRun}: it never carries state of its own and is safe to
 * recompute at any time.
 */
export const filmRunReceiptSchema = z
  .strictObject({
    contract: z.literal(FILM_RUN_RECEIPT_CONTRACT),
    runId: filmRunIdSchema,
    workflow: filmWorkflowSchema,
    status: filmRunStatusSchema,
    phase: filmRunPhaseSchema,
    /** True exactly when status is completed, failed, or cancelled. */
    terminal: z.boolean(),
    /** Fraction of completed phases in [0, 1]; null when the phase is unknown. */
    progress: z.number().min(0).max(1).nullable(),
    sceneCount: z.number().int().nonnegative(),
    /** Scenes that already produced a rendered scene video. */
    renderedSceneCount: z.number().int().nonnegative(),
    /** Total rendered clips across all scenes. */
    clipCount: z.number().int().nonnegative(),
    portraitsReady: z.boolean(),
    /** True while the run sits at the review gate without an approval. */
    awaitingApproval: z.boolean(),
    /** Durable per-phase execution receipts, oldest first. */
    phaseReceipts: z.array(filmRunPhaseReceiptSchema).max(FILM_RUN_PHASE_RECEIPT_LIMIT),
    /** Stable-coded failure; absent while the run carries no error. */
    error: z.strictObject({ code: filmRunErrorCodeSchema, message: z.string().max(4_000) }).optional(),
    artifacts: z.strictObject({
      finalVideoPath: z.string().nullable(),
      timelinePath: z.string().nullable(),
    }),
    timestamps: z.strictObject({
      createdAt: z.string(),
      updatedAt: z.string(),
      approvedAt: z.string().optional(),
    }),
  })
  .superRefine((receipt, context) => {
    if (receipt.terminal !== isTerminalFilmRunStatus(receipt.status)) {
      context.addIssue({
        code: "custom",
        path: ["terminal"],
        message: "terminal must match whether the status is completed, failed, or cancelled",
      });
    }
    if (receipt.renderedSceneCount > receipt.sceneCount) {
      context.addIssue({
        code: "custom",
        path: ["renderedSceneCount"],
        message: "renderedSceneCount cannot exceed sceneCount",
      });
    }
  });

/** Normalized receipt of one durable film run. */
export type FilmRunReceipt = z.infer<typeof filmRunReceiptSchema>;

/**
 * Projects the normalized receipt from a durable film run document. The
 * projection is deterministic: the same run document always produces the
 * same receipt, and its progress comes from the same {@link filmRunProgress}
 * the unified progress adapter uses.
 *
 * @param run - The durable film run document.
 * @returns The validated normalized receipt.
 */
export function projectFilmRunReceipt(run: FilmRun): FilmRunReceipt {
  const error =
    run.error === null ? undefined : { code: run.errorCode ?? ("film_run_error" as const), message: run.error };
  return filmRunReceiptSchema.parse({
    contract: FILM_RUN_RECEIPT_CONTRACT,
    runId: run.id,
    workflow: run.workflow,
    status: run.status,
    phase: run.phase,
    terminal: isTerminalFilmRunStatus(run.status),
    progress: filmRunProgress(run),
    sceneCount: run.scenes.length,
    renderedSceneCount: run.scenes.filter((scene) => scene.videoPath !== null).length,
    clipCount: run.scenes.reduce((total, scene) => total + scene.clipCount, 0),
    portraitsReady: run.portraitsReady,
    awaitingApproval: run.status === "waiting_approval" && !run.approvedAt,
    phaseReceipts: run.phaseReceipts,
    ...(error ? { error } : {}),
    artifacts: { finalVideoPath: run.finalVideoPath, timelinePath: run.timelinePath },
    timestamps: {
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.approvedAt ? { approvedAt: run.approvedAt } : {}),
    },
  });
}
