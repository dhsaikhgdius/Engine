import { z } from "zod";
import { emptyFilmRunUsage, filmRunUsageSchema } from "./filmRunUsage";
import {
  FILM_RUN_CAPABILITY_OMISSION_LIMIT,
  FILM_RUN_PHASE_RECEIPT_LIMIT,
  filmRunCapabilityOmissionSchema,
  filmRunErrorCodeSchema,
  filmRunIdSchema,
  filmRunPhaseReceiptSchema,
  filmRunPhaseSchema,
  filmRunProgress,
  filmRunStatusSchema,
  filmTimelineExportReceiptSchema,
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

/** Matches `filmRunSchema`'s scenes bound so probing every claimed scene video stays cheap. */
const FILM_RUN_SCENE_VIDEO_PRESENCE_LIMIT = 64;

/** Live byte presence for one scene's claimed rendered scene video. */
export const filmRunSceneVideoStoragePresenceSchema = z.strictObject({
  sceneIdx: z.number().int().min(0).max(4_096),
  presence: filmRunArtifactStoragePresenceSchema,
});

/** One per-scene rendered-video byte presence verdict. */
export type FilmRunSceneVideoStoragePresence = z.infer<typeof filmRunSceneVideoStoragePresenceSchema>;

/**
 * Per-artifact live byte presence: `null` for artifacts the run never
 * claimed (path is null); `present`/`absent` for claimed paths that were
 * probed at read time. `sceneVideos` carries one verdict per scene with a
 * claimed rendered video — the same claims behind `renderedSceneCount` and
 * the resume/assemble checkpoints — so a wiped scene clip is a typed fact
 * on the receipt instead of a surprise mid-resume.
 */
export const filmRunArtifactsStoragePresenceSchema = z.strictObject({
  finalVideo: filmRunArtifactStoragePresenceSchema.nullable(),
  timeline: filmRunArtifactStoragePresenceSchema.nullable(),
  sceneVideos: z.array(filmRunSceneVideoStoragePresenceSchema).max(FILM_RUN_SCENE_VIDEO_PRESENCE_LIMIT),
});

/** Live byte presence block stamped on film run receipt artifacts. */
export type FilmRunArtifactsStoragePresence = z.infer<typeof filmRunArtifactsStoragePresenceSchema>;

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
    /** Probe verdicts for scenes with a claimed videoPath; scenes missing a verdict become `absent`. */
    sceneVideos?: readonly FilmRunSceneVideoStoragePresence[];
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
    /**
     * Requested optional capabilities the pipeline skipped, with stable
     * codes (`tts_unconfigured`, `anchor_hook_unavailable`,
     * `anchor_resolution_failed`). Always present — empty when nothing was
     * skipped — so a run that diverged from its input is a typed fact on
     * every control surface, not a free-text event.
     */
    capabilityOmissions: z.array(filmRunCapabilityOmissionSchema).max(FILM_RUN_CAPABILITY_OMISSION_LIMIT),
    /** Stable-coded failure; absent while the run carries no error. */
    error: z.strictObject({ code: filmRunErrorCodeSchema, message: z.string().max(4_000) }).optional(),
    artifacts: z.strictObject({
      finalVideoPath: z.string().nullable(),
      timelinePath: z.string().nullable(),
      /**
       * Typed export receipt behind `timelinePath`: planned/exported shot
       * counts plus per-shot omissions with stable codes. Null when no
       * timeline exists or the run predates typed export receipts, so a
       * complete handoff is never invented for legacy documents.
       */
      timelineExport: filmTimelineExportReceiptSchema.nullable(),
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
     * `film-image` / `film-video` / `film-tts`). Always present — zeros when
     * nothing has been metered yet — so Agent/HTTP/UI share one honesty
     * surface with the Trace panel scopes without joining the global usage
     * window.
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
    if (receipt.artifacts.timelineExport !== null && receipt.artifacts.timelinePath === null) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", "timelineExport"],
        message: "timelineExport requires a claimed timelinePath",
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
      // Scene verdicts classify claimed rendered videos only: exactly one
      // verdict per scene counted by renderedSceneCount, no duplicates.
      if (presence.sceneVideos.length !== receipt.renderedSceneCount) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", "storagePresence", "sceneVideos"],
          message: "storagePresence.sceneVideos must carry one verdict per rendered scene (renderedSceneCount)",
        });
      }
      if (new Set(presence.sceneVideos.map((video) => video.sceneIdx)).size !== presence.sceneVideos.length) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", "storagePresence", "sceneVideos"],
          message: "storagePresence.sceneVideos must not repeat a sceneIdx",
        });
      }
    }
  });

/** Normalized receipt of one durable film run. */
export type FilmRunReceipt = z.infer<typeof filmRunReceiptSchema>;

/**
 * One verdict per scene with a claimed rendered video, in scene order.
 * Claimed scenes missing a probe verdict degrade to `absent`, matching the
 * final-video/timeline discipline of never over-claiming bytes.
 */
function projectSceneVideoStoragePresence(
  scenes: FilmRun["scenes"],
  probes: readonly FilmRunSceneVideoStoragePresence[] = [],
): FilmRunSceneVideoStoragePresence[] {
  const verdictBySceneIdx = new Map(probes.map((probe) => [probe.sceneIdx, probe.presence]));
  return scenes
    .filter((scene) => scene.videoPath !== null)
    .map((scene) => ({ sceneIdx: scene.idx, presence: verdictBySceneIdx.get(scene.idx) ?? "absent" }));
}

/**
 * Projects the normalized receipt from a durable film run document. The
 * projection is deterministic: the same run document always produces the
 * same receipt, and its progress comes from the same {@link filmRunProgress}
 * the unified progress adapter uses.
 *
 * Pass {@link ProjectFilmRunReceiptOptions.artifactStoragePresence} from
 * Gateway live reads so agents see whether the claimed final-video, timeline,
 * and per-scene rendered-video bytes still exist instead of trusting the
 * stored paths.
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
    capabilityOmissions: run.capabilityOmissions ?? [],
    ...(error ? { error } : {}),
    artifacts: {
      finalVideoPath: run.finalVideoPath,
      timelinePath: run.timelinePath,
      timelineExport: run.timelineExport,
      ...(options.artifactStoragePresence
        ? {
            storagePresence: {
              finalVideo: run.finalVideoPath === null ? null : (options.artifactStoragePresence.finalVideo ?? "absent"),
              timeline: run.timelinePath === null ? null : (options.artifactStoragePresence.timeline ?? "absent"),
              sceneVideos: projectSceneVideoStoragePresence(run.scenes, options.artifactStoragePresence.sceneVideos),
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
