import { z } from "zod";
import { emptyFilmRunUsage, filmRunUsageSchema } from "./filmRunUsage";
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
 * Live byte presence for one claimed film run artifact path. The durable run
 * document never stores this — it is projected at read time so disk cleanup,
 * `.runtime` wipes, or manual deletion can age bytes out while the run's
 * path claim and phase-receipt evidence remain (mirrors production job
 * receipt `storagePresence`).
 */
export const filmRunArtifactStoragePresenceSchema = z.enum(["present", "absent"]);

/** Live artifact byte presence on a film run receipt. */
export type FilmRunArtifactStoragePresence = z.infer<typeof filmRunArtifactStoragePresenceSchema>;

/**
 * Per-artifact live byte presence: `null` for artifacts the run never
 * claimed (path is null); `present`/`absent` for claimed paths that were
 * probed at read time.
 */
export const filmRunArtifactsStoragePresenceSchema = z.strictObject({
  finalVideo: filmRunArtifactStoragePresenceSchema.nullable(),
  timeline: filmRunArtifactStoragePresenceSchema.nullable(),
});

/** Options for {@link projectFilmRunReceipt}. */
export type ProjectFilmRunReceiptOptions = {
  /**
   * Live byte presence for the run's claimed artifact paths. When provided,
   * the receipt stamps `artifacts.storagePresence`; artifacts whose path is
   * null are normalized to null presence and missing probe keys become
   * `absent`, matching the production job receipt discipline.
   */
  artifactStoragePresence?: {
    finalVideo?: FilmRunArtifactStoragePresence;
    timeline?: FilmRunArtifactStoragePresence;
  };
};

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
    /** Phase floor plus durable per-scene completion inside plan-scenes/render; null when the phase is unknown. */
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
      /** Live byte presence probed at read time; omitted on pure projections. */
      storagePresence: filmRunArtifactsStoragePresenceSchema.optional(),
    }),
    timestamps: z.strictObject({
      createdAt: z.string(),
      updatedAt: z.string(),
      approvedAt: z.string().optional(),
    }),
    /**
     * Durable per-scope model/media usage for this run (`film-llm` /
     * `film-image` / `film-video`). Always present — zeros when nothing has
     * been metered yet — so Agent/HTTP/UI share one honesty surface with the
     * Trace panel scopes without joining the global usage window.
     */
    usage: filmRunUsageSchema,
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
    const presence = receipt.artifacts.storagePresence;
    if (presence) {
      // Presence classifies claimed paths only: a null path has nothing to
      // probe, and a claimed path must carry a probe verdict.
      if ((presence.finalVideo === null) !== (receipt.artifacts.finalVideoPath === null)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", "storagePresence", "finalVideo"],
          message: "storagePresence.finalVideo must be null exactly when finalVideoPath is null",
        });
      }
      if ((presence.timeline === null) !== (receipt.artifacts.timelinePath === null)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", "storagePresence", "timeline"],
          message: "storagePresence.timeline must be null exactly when timelinePath is null",
        });
      }
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
 * Pass {@link ProjectFilmRunReceiptOptions.artifactStoragePresence} from
 * Gateway live reads so agents see whether the claimed final-video/timeline
 * bytes still exist instead of trusting the stored paths.
 *
 * @param run - The durable film run document.
 * @param options - Optional live byte-presence probe results.
 * @returns The validated normalized receipt.
 */
export function projectFilmRunReceipt(run: FilmRun, options: ProjectFilmRunReceiptOptions = {}): FilmRunReceipt {
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
    artifacts: {
      finalVideoPath: run.finalVideoPath,
      timelinePath: run.timelinePath,
      ...(options.artifactStoragePresence
        ? {
            storagePresence: {
              finalVideo: run.finalVideoPath === null ? null : (options.artifactStoragePresence.finalVideo ?? "absent"),
              timeline: run.timelinePath === null ? null : (options.artifactStoragePresence.timeline ?? "absent"),
            },
          }
        : {}),
    },
    timestamps: {
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.approvedAt ? { approvedAt: run.approvedAt } : {}),
    },
    usage: run.usage ?? emptyFilmRunUsage(),
  });
}
