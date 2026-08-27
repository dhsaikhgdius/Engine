import { z } from "zod";
import { emptyFilmRunUsage, filmRunUsageSchema } from "./filmRunUsage";
import { strictOperation } from "./strictProtocolVariant";

/**
 * Film pipeline protocol.
 *
 * Typed artifacts for Director's agentic film production pipeline:
 * planning agents emit these structures, the render coordinator consumes them,
 * and the durable run document tracks phase progress. Media bytes never live
 * here — only workspace-relative paths into the run directory.
 */

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedText = (maximum: number) => z.string().trim().max(maximum);
const shotIndex = z.number().int().min(0).max(4_096);

/** Durable identifier for a film run; carries the `film-` prefix for namespace partitioning. */
export const filmRunIdSchema = z.string().regex(/^film-[a-z0-9-]{8,64}$/i);

/**
 * Frozen public error codes of the film HTTP surface (`/api/film/runs*`).
 * Every non-2xx film route response carries exactly one of these codes;
 * agents may branch on them, so the list only ever grows.
 */
export const FILM_PIPELINE_PUBLIC_ERROR_CODES = [
  "film_pipeline_unconfigured",
  "invalid_request",
  "invalid_run_id",
  "run_not_found",
] as const;
/** One frozen public film HTTP error code. */
export type FilmPipelinePublicErrorCode = (typeof FILM_PIPELINE_PUBLIC_ERROR_CODES)[number];

/**
 * Stable public classification of why a stored film run failed. Persisted on
 * the run document next to the free-text `error` so agents can branch without
 * parsing provider messages.
 */
export const filmRunErrorCodeSchema = z.enum([
  /** The owning gateway process exited while the run was queued or running. */
  "film_run_interrupted",
  /** A hosted LLM/image/video provider call failed. */
  "film_provider_error",
  /** Any other execution failure (planning validation, ffmpeg, filesystem, …). */
  "film_run_error",
]);
/** Stable film run failure classification. */
export type FilmRunErrorCode = z.infer<typeof filmRunErrorCodeSchema>;

/**
 * Classifies one execution failure into the stable public film run error
 * code. Provider transport failures are detected by error name so the
 * protocol package stays free of provider-runtime imports.
 */
export function classifyFilmRunError(error: unknown): FilmRunErrorCode {
  return error instanceof Error && error.name === "ModelDriverHttpError" ? "film_provider_error" : "film_run_error";
}

/**
 * Reported readiness of one optional film pipeline capability. `configured`
 * means the gateway can attempt the capability; runs that request an
 * unconfigured capability stamp a typed {@link filmRunCapabilityOmissionSchema}
 * record instead of silently skipping the work.
 */
export const filmPipelineCapabilityStateSchema = z.strictObject({
  configured: z.boolean(),
  /** Missing-config diagnostic (a reported state, not an error); null when configured. */
  reason: z.string().max(500).nullable(),
});
/** Reported readiness of one optional film pipeline capability. */
export type FilmPipelineCapabilityState = z.infer<typeof filmPipelineCapabilityStateSchema>;

/**
 * Optional film pipeline capabilities reported next to the core `configured`
 * flag. The core pipeline (LLM + image + video) runs without them, so their
 * absence never blocks create/resume — it only changes what a run can honor.
 */
export const filmPipelineCapabilitiesSchema = z.strictObject({
  /** Dialogue TTS dubbing mixed into shot clips (`input.enableAudio`). */
  dialogueAudio: filmPipelineCapabilityStateSchema,
  /** Automatic white-box Stage anchor capture (`input.autoStageAnchors`); a connected workbench tab is still required at render time. */
  stageAnchors: filmPipelineCapabilityStateSchema,
});
/** Reported optional film pipeline capabilities. */
export type FilmPipelineCapabilities = z.infer<typeof filmPipelineCapabilitiesSchema>;

/**
 * Reported configuration state of the film pipeline. An unconfigured
 * pipeline is an explicit reported state on the list surface — existing runs
 * stay readable and cancellable while create/resume/approve are refused.
 */
export const filmPipelineAvailabilitySchema = z.strictObject({
  /** True when the planning LLM plus image and video providers are configured. */
  configured: z.boolean(),
  /** Missing-config diagnostic (a reported state, not an error); null when configured. */
  reason: z.string().max(500).nullable(),
  /** Optional-capability readiness so agents learn before create whether enableAudio/autoStageAnchors can be honored. */
  capabilities: filmPipelineCapabilitiesSchema,
});
/** Reported film pipeline configuration state. */
export type FilmPipelineAvailability = z.infer<typeof filmPipelineAvailabilitySchema>;

// ---------------------------------------------------------------------------
// Planning artifacts
// ---------------------------------------------------------------------------

/** A named character with physical traits split into static (rarely-changing) and dynamic (scene-variable) layers. */
export const filmCharacterSchema = z.strictObject({
  idx: shotIndex,
  /** Stable identifier used inside descriptions, e.g. "Alice" or "老渔夫". */
  name: nonEmptyText(240),
  /** Off-screen voices are never sent to the portrait generator. */
  isVisible: z.boolean(),
  /** Facial features, body shape and other rarely-changing traits. */
  staticFeatures: boundedText(4_000).default(""),
  /** Clothing, accessories and other scene-variable traits. */
  dynamicFeatures: boundedText(4_000).nullable().default(null),
});

/** A single camera setup's visual and audio description, shared by one or more shots. */
export const shotBriefSchema = z.strictObject({
  idx: shotIndex,
  /** Shots sharing one physical camera setup share a camIdx. */
  camIdx: shotIndex,
  visualDesc: nonEmptyText(8_000),
  audioDesc: boundedText(4_000).default(""),
});

/** How much the generated frames may deviate from the source desc; drives variation-seed strategy. */
export const shotVariationSchema = z.enum(["small", "medium", "large"]);

/** A fully-specified shot with first-frame, last-frame, and motion descriptions consumed by the render coordinator. */
export const shotSpecSchema = z.strictObject({
  idx: shotIndex,
  camIdx: shotIndex,
  visualDesc: nonEmptyText(8_000),
  /** medium/large shots additionally require a generated last frame. */
  variationType: shotVariationSchema,
  variationReason: boundedText(4_000).default(""),
  /** First-frame still description; a pure snapshot without ongoing motion. */
  ffDesc: nonEmptyText(8_000),
  ffVisCharIdxs: z.array(shotIndex).max(64).default([]),
  lfDesc: boundedText(8_000).default(""),
  lfVisCharIdxs: z.array(shotIndex).max(64).default([]),
  /** Camera and subject motion connecting first and last frame, plus dialogue. */
  motionDesc: nonEmptyText(8_000),
  audioDesc: boundedText(4_000).default(""),
});

/**
 * Camera dependency tree. A child camera derives its first frame from a
 * parent shot so that environment and spatial layout remain consistent
 * across camera angles within one scene.
 */
export const cameraPlanNodeSchema = z.strictObject({
  idx: shotIndex,
  activeShotIdxs: z.array(shotIndex).min(1).max(512),
  parentCamIdx: shotIndex.nullable().default(null),
  parentShotIdx: shotIndex.nullable().default(null),
  reason: boundedText(4_000).nullable().default(null),
  isParentFullyCoversChild: z.boolean().nullable().default(null),
  missingInfo: boundedText(4_000).nullable().default(null),
});

/** Which canonical view of a character is captured in a portrait entry. */
export const portraitViewSchema = z.enum(["front", "side", "back"]);

/** One generated portrait image together with the prompt-level description that produced it. */
export const portraitEntrySchema = z.strictObject({
  path: nonEmptyText(2_048),
  description: nonEmptyText(2_000),
});

/** Three canonical views (front, side, back) of one character for consistent rendering. */
export const characterPortraitsSchema = z.strictObject({
  front: portraitEntrySchema,
  side: portraitEntrySchema,
  back: portraitEntrySchema,
});

/** Keyed by character name. Persisted next to the generated portrait files. */
export const portraitRegistrySchema = z.record(z.string(), characterPortraitsSchema);

// ---------------------------------------------------------------------------
// White-box grounding
// ---------------------------------------------------------------------------

/**
 * A clean capture of the Director 3D stage (white-box) bound to one shot. The
 * render coordinator injects it as a spatial reference so generated frames
 * inherit the staged composition, blocking and camera geometry.
 */
export const stageReferenceSchema = z.strictObject({
  sceneIdx: shotIndex,
  shotIdx: shotIndex,
  imagePath: nonEmptyText(2_048),
  note: boundedText(2_000).default(
    "White-box stage capture: composition, camera angle and spatial blocking are authoritative. Replace mannequin characters and untextured geometry with the final styled characters and environment while preserving the layout.",
  ),
});

/** A user-provided identity reference that replaces generated portraits. */
export const characterReferenceSchema = z.strictObject({
  name: nonEmptyText(240),
  view: portraitViewSchema.default("front"),
  imagePath: nonEmptyText(2_048),
  note: boundedText(2_000).default(""),
});

// ---------------------------------------------------------------------------
// Timeline export receipt
// ---------------------------------------------------------------------------

/** Bounded window of typed omit records on one timeline export receipt; the count stays exact past it. */
export const FILM_TIMELINE_OMITTED_SHOT_LIMIT = 512;

/** Stable classification of why one planned shot is absent from the exported OTIO timeline. */
export const filmTimelineOmittedShotCodeSchema = z.enum([
  /** The shot's rendered clip bytes were missing from the run directory at export time. */
  "clip_missing",
]);

/** One planned shot omitted from the exported OTIO timeline (agents read this instead of scraping events). */
export const filmTimelineOmittedShotSchema = z.strictObject({
  sceneIdx: shotIndex,
  shotIdx: shotIndex,
  code: filmTimelineOmittedShotCodeSchema,
  reason: nonEmptyText(600),
});

/**
 * Durable receipt of one OTIO timeline export, written next to
 * `timelinePath` when the export succeeds. A partial editorial handoff is a
 * typed, durable fact instead of a silent skip: every planned shot either
 * became a timeline clip or appears in `omittedShots` with a stable code.
 */
export const filmTimelineExportReceiptSchema = z
  .strictObject({
    /** Planned shots visited at export time. */
    shotCount: z.number().int().positive().max(100_000),
    /** Planned shots that became timeline clips; the export fails instead of writing an empty timeline. */
    clipCount: z.number().int().positive().max(100_000),
    /** Exact number of planned shots absent from the timeline. */
    omittedShotCount: z.number().int().nonnegative().max(100_000),
    /** Typed omit records, bounded to {@link FILM_TIMELINE_OMITTED_SHOT_LIMIT}. */
    omittedShots: z.array(filmTimelineOmittedShotSchema).max(FILM_TIMELINE_OMITTED_SHOT_LIMIT),
  })
  .superRefine((receipt, context) => {
    if (receipt.clipCount + receipt.omittedShotCount !== receipt.shotCount) {
      context.addIssue({
        code: "custom",
        path: ["shotCount"],
        message: "clipCount plus omittedShotCount must equal shotCount",
      });
    }
    if (receipt.omittedShots.length !== Math.min(receipt.omittedShotCount, FILM_TIMELINE_OMITTED_SHOT_LIMIT)) {
      context.addIssue({
        code: "custom",
        path: ["omittedShots"],
        message: "omittedShots must carry min(omittedShotCount, FILM_TIMELINE_OMITTED_SHOT_LIMIT) records",
      });
    }
  });

/** Stable timeline-export omission classification. */
export type FilmTimelineOmittedShotCode = z.infer<typeof filmTimelineOmittedShotCodeSchema>;
/** One typed timeline-export omission record. */
export type FilmTimelineOmittedShot = z.infer<typeof filmTimelineOmittedShotSchema>;
/** Durable receipt of one OTIO timeline export. */
export type FilmTimelineExportReceipt = z.infer<typeof filmTimelineExportReceiptSchema>;

// ---------------------------------------------------------------------------
// Capability omissions
// ---------------------------------------------------------------------------

/** Bounded window of typed capability-omission records on one run document. */
export const FILM_RUN_CAPABILITY_OMISSION_LIMIT = 128;

/** Optional capability a film run requested via its input. */
export const filmRunCapabilitySchema = z.enum(["dialogue_audio", "stage_anchors"]);

/** Stable classification of why a requested optional capability was skipped. */
export const filmRunCapabilityOmissionCodeSchema = z.enum([
  /** `input.enableAudio` was true but no TTS provider is configured; clips rendered without dialogue dubbing. */
  "tts_unconfigured",
  /** `input.autoStageAnchors` was true but the gateway has no workbench execution channel; scenes rendered without white-box grounding. */
  "anchor_hook_unavailable",
  /** Stage anchor resolution failed for one scene; that scene rendered without white-box grounding. */
  "anchor_resolution_failed",
]);

/** Which capability each omission code belongs to; the schema rejects mismatched pairs. */
export const FILM_RUN_CAPABILITY_FOR_OMISSION_CODE: Record<
  z.infer<typeof filmRunCapabilityOmissionCodeSchema>,
  z.infer<typeof filmRunCapabilitySchema>
> = {
  tts_unconfigured: "dialogue_audio",
  anchor_hook_unavailable: "stage_anchors",
  anchor_resolution_failed: "stage_anchors",
};

/** Omission codes scoped to one scene; every other code is run-level (sceneIdx null). */
const SCENE_SCOPED_OMISSION_CODES = new Set<z.infer<typeof filmRunCapabilityOmissionCodeSchema>>([
  "anchor_resolution_failed",
]);

/**
 * One requested-but-skipped optional capability, stamped durably on the run
 * the moment the pipeline decides to proceed without it. Agents read these
 * instead of scraping free-text events: a completed run with
 * `enableAudio: true` and no dialogue dubbing is a typed fact, not a
 * silent divergence from the request.
 */
export const filmRunCapabilityOmissionSchema = z
  .strictObject({
    capability: filmRunCapabilitySchema,
    code: filmRunCapabilityOmissionCodeSchema,
    /** Scene the omission applies to; null for run-level omissions. */
    sceneIdx: shotIndex.nullable().default(null),
    reason: nonEmptyText(600),
    /** When the pipeline decided to proceed without the capability. */
    at: z.string(),
  })
  .superRefine((omission, context) => {
    if (FILM_RUN_CAPABILITY_FOR_OMISSION_CODE[omission.code] !== omission.capability) {
      context.addIssue({
        code: "custom",
        path: ["capability"],
        message: `code ${omission.code} belongs to capability ${FILM_RUN_CAPABILITY_FOR_OMISSION_CODE[omission.code]}`,
      });
    }
    if (SCENE_SCOPED_OMISSION_CODES.has(omission.code) !== (omission.sceneIdx !== null)) {
      context.addIssue({
        code: "custom",
        path: ["sceneIdx"],
        message: `code ${omission.code} must carry sceneIdx ${
          SCENE_SCOPED_OMISSION_CODES.has(omission.code) ? "for the affected scene" : "null (run-level)"
        }`,
      });
    }
  });

/** Optional capability requested by a film run. */
export type FilmRunCapability = z.infer<typeof filmRunCapabilitySchema>;
/** Stable capability-omission classification. */
export type FilmRunCapabilityOmissionCode = z.infer<typeof filmRunCapabilityOmissionCodeSchema>;
/** One typed capability-omission record. */
export type FilmRunCapabilityOmission = z.infer<typeof filmRunCapabilityOmissionSchema>;

/**
 * Appends one capability omission, keeping the list idempotent across
 * resumes: a record with the same code and sceneIdx already present wins
 * (the first decision keeps its timestamp), and the window stays bounded to
 * {@link FILM_RUN_CAPABILITY_OMISSION_LIMIT}.
 */
export function appendFilmRunCapabilityOmission(
  existing: readonly FilmRunCapabilityOmission[],
  omission: FilmRunCapabilityOmission,
): FilmRunCapabilityOmission[] {
  const duplicate = existing.some(
    (candidate) => candidate.code === omission.code && candidate.sceneIdx === omission.sceneIdx,
  );
  if (duplicate) return [...existing];
  return [...existing, filmRunCapabilityOmissionSchema.parse(omission)].slice(-FILM_RUN_CAPABILITY_OMISSION_LIMIT);
}

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

/** Which top-level production workflow drives the run: idea-to-film or script-to-film. */
export const filmWorkflowSchema = z.enum(["idea-to-film", "script-to-film"]);

/** Lifecycle states of a film run across the pipeline state machine. */
export const filmRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

/** Ordered phases of a film run; the render coordinator advances through them sequentially. */
export const filmRunPhaseSchema = z.enum([
  "develop-story",
  "extract-characters",
  "write-scenes",
  "plan-scenes",
  "await-approval",
  "render",
  "assemble",
  "completed",
]);

/** Per-scene state within a film run: script, storyboard, shot specs, camera plan, and rendered artifacts. */
export const filmSceneStateSchema = z.strictObject({
  idx: shotIndex,
  script: nonEmptyText(64_000),
  storyboard: z.array(shotBriefSchema).max(512).nullable().default(null),
  shotSpecs: z.array(shotSpecSchema).max(512).nullable().default(null),
  cameraPlan: z.array(cameraPlanNodeSchema).max(512).nullable().default(null),
  /** White-box captures resolved automatically from the live Stage, persisted for resume. */
  stageAnchors: z.array(stageReferenceSchema).max(512).default([]),
  clipCount: z.number().int().nonnegative().default(0),
  videoPath: z.string().nullable().default(null),
});

/** User-provided inputs for a film run: idea, script, style, aspect ratio, and production controls. */
export const filmRunInputSchema = z
  .strictObject({
    idea: nonEmptyText(16_000).optional(),
    script: nonEmptyText(120_000).optional(),
    /** Pre-split scene scripts skip scene segmentation entirely. */
    sceneScripts: z.array(nonEmptyText(64_000)).min(1).max(64).optional(),
    userRequirement: boundedText(8_000).default(""),
    style: nonEmptyText(500).default("cinematic, photorealistic film still, motivated lighting"),
    aspectRatio: z.enum(["16:9", "9:16", "2.39:1", "1:1"]).default("16:9"),
    /** Pause after planning so a human or agent can review artifacts. */
    reviewGate: z.boolean().default(false),
    maxShotsPerScene: z.number().int().min(1).max(60).nullable().default(null),
    clipDurationSec: z.number().int().min(2).max(16).nullable().default(null),
    stageReferences: z.array(stageReferenceSchema).max(512).default([]),
    characterReferences: z.array(characterReferenceSchema).max(128).default([]),
    /** Capture white-box anchors per shot from the connected Stage before rendering. */
    autoStageAnchors: z.boolean().default(false),
    /** Synthesize dialogue audio and mix it into shot clips when TTS is configured. */
    enableAudio: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    if (!value.idea && !value.script && !value.sceneScripts) {
      context.addIssue({ code: "custom", message: "one of idea, script or sceneScripts is required" });
    }
  });

/** A timestamped progress event in the film run's bounded log. */
export const filmRunEventSchema = z.strictObject({
  at: z.string(),
  stage: nonEmptyText(120),
  message: nonEmptyText(2_000),
});

/**
 * Durable receipt for one entry into a pipeline phase: when work in that
 * phase started and, once the run moved on (or terminated), when it ended.
 * A resumed run opens a fresh receipt for the phase it re-enters, so the
 * receipts read as the actual wall-clock history of the run.
 */
export const filmRunPhaseReceiptSchema = z.strictObject({
  phase: filmRunPhaseSchema,
  startedAt: z.string(),
  /** Null while the run is still inside the phase. */
  finishedAt: z.string().nullable().default(null),
});
/** One durable phase receipt. */
export type FilmRunPhaseReceipt = z.infer<typeof filmRunPhaseReceiptSchema>;

/** Bounded phase-receipt window; oldest receipts are dropped past this. */
export const FILM_RUN_PHASE_RECEIPT_LIMIT = 64;

/**
 * Closes every open phase receipt at the given timestamp. Idempotent:
 * receipts that already carry a `finishedAt` are returned unchanged.
 */
export function closeFilmRunPhaseReceipts(receipts: readonly FilmRunPhaseReceipt[], at: string): FilmRunPhaseReceipt[] {
  return receipts.map((receipt) => (receipt.finishedAt === null ? { ...receipt, finishedAt: at } : receipt));
}

/**
 * Opens a receipt for a newly entered phase, closing any receipt still open
 * and keeping the window bounded to {@link FILM_RUN_PHASE_RECEIPT_LIMIT}.
 */
export function openFilmRunPhaseReceipt(
  receipts: readonly FilmRunPhaseReceipt[],
  phase: FilmRunPhase,
  at: string,
): FilmRunPhaseReceipt[] {
  return [...closeFilmRunPhaseReceipts(receipts, at), { phase, startedAt: at, finishedAt: null }].slice(
    -FILM_RUN_PHASE_RECEIPT_LIMIT,
  );
}

/** The durable run document: immutable identity, current state, input, and all phase artifacts. */
export const filmRunSchema = z.strictObject({
  version: z.literal(1),
  id: filmRunIdSchema,
  workflow: filmWorkflowSchema,
  status: filmRunStatusSchema,
  phase: filmRunPhaseSchema,
  input: filmRunInputSchema,
  story: z.string().nullable().default(null),
  characters: z.array(filmCharacterSchema).max(128).nullable().default(null),
  scenes: z.array(filmSceneStateSchema).max(64).default([]),
  portraitsReady: z.boolean().default(false),
  finalVideoPath: z.string().nullable().default(null),
  /** OTIO timeline exported after assembly for Video Editor / NLE handoff. */
  timelinePath: z.string().nullable().default(null),
  /**
   * Typed receipt of the OTIO timeline export stamped together with
   * `timelinePath`. Null when no timeline was exported yet or the run
   * predates typed export receipts — never invented for legacy documents.
   */
  timelineExport: filmTimelineExportReceiptSchema.nullable().default(null),
  /**
   * Requested optional capabilities the pipeline decided to skip, stamped
   * with stable codes when the decision happens. Empty for runs that never
   * skipped anything and for documents that predate typed omissions.
   */
  capabilityOmissions: z.array(filmRunCapabilityOmissionSchema).max(FILM_RUN_CAPABILITY_OMISSION_LIMIT).default([]),
  approvedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /** Stable classification of `error`; null when the run carries no error. */
  errorCode: filmRunErrorCodeSchema.nullable().default(null),
  /** Bounded progress log; oldest entries are dropped past 200. */
  events: z.array(filmRunEventSchema).max(200).default([]),
  /** Durable per-phase execution receipts, oldest first; bounded window. */
  phaseReceipts: z.array(filmRunPhaseReceiptSchema).max(FILM_RUN_PHASE_RECEIPT_LIMIT).default([]),
  /**
   * Per-scope model/media usage rollup for this run. Defaults to zeros so
   * documents written before metering still parse; the receipt always projects
   * this field.
   */
  usage: filmRunUsageSchema.default(() => emptyFilmRunUsage()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Request shape for creating a new film run; workflow defaults to idea-to-film. */
export const createFilmRunRequestSchema = z.strictObject({
  workflow: filmWorkflowSchema.default("idea-to-film"),
  input: filmRunInputSchema,
});

/** Agent-facing operation surface (MCP tool `director_film` and HTTP callers). */
export const filmPipelineOperationSchema = z.discriminatedUnion("op", [
  strictOperation("create", {
    workflow: filmWorkflowSchema.default("idea-to-film"),
    input: filmRunInputSchema,
  }),
  strictOperation("list", { limit: z.number().int().min(1).max(200).optional() }),
  strictOperation("status", { id: filmRunIdSchema }),
  strictOperation("resume", { id: filmRunIdSchema }),
  strictOperation("cancel", { id: filmRunIdSchema }),
  strictOperation("approve", { id: filmRunIdSchema }),
]);

/** Agent/MCP operation surface for film pipeline management. */
export type FilmPipelineOperation = z.infer<typeof filmPipelineOperationSchema>;

/** A named character with static and dynamic physical traits. */
export type FilmCharacter = z.infer<typeof filmCharacterSchema>;
/** A single camera setup description shared across shots. */
export type ShotBrief = z.infer<typeof shotBriefSchema>;
/** Variation magnitude for generated shot frames. */
export type ShotVariation = z.infer<typeof shotVariationSchema>;
/** A fully-specified shot with frame descriptions, motion, and character mappings. */
export type ShotSpec = z.infer<typeof shotSpecSchema>;
/** A node in the camera dependency tree, linking child cameras to parent shots. */
export type CameraPlanNode = z.infer<typeof cameraPlanNodeSchema>;
/** Canonical character view angle for portrait generation. */
export type PortraitView = z.infer<typeof portraitViewSchema>;
/** One generated portrait image with its prompt-level description. */
export type PortraitEntry = z.infer<typeof portraitEntrySchema>;
/** Three canonical views of one character for consistent rendering. */
export type CharacterPortraits = z.infer<typeof characterPortraitsSchema>;
/** Map of character names to their portrait sets. */
export type PortraitRegistry = z.infer<typeof portraitRegistrySchema>;
/** A white-box stage capture bound to one shot for spatial grounding. */
export type StageReference = z.infer<typeof stageReferenceSchema>;
/** A user-provided identity reference image replacing generated portraits. */
export type CharacterReference = z.infer<typeof characterReferenceSchema>;
/** Top-level production workflow driving the film run. */
export type FilmWorkflow = z.infer<typeof filmWorkflowSchema>;
/** Lifecycle status of a film run. */
export type FilmRunStatus = z.infer<typeof filmRunStatusSchema>;
/** Ordered phase within a film run. */
export type FilmRunPhase = z.infer<typeof filmRunPhaseSchema>;
/** Per-scene state: script, storyboard, shot specs, camera plan, and rendered artifacts. */
export type FilmSceneState = z.infer<typeof filmSceneStateSchema>;
/** User-provided inputs for creating a film run. */
export type FilmRunInput = z.infer<typeof filmRunInputSchema>;
/** The durable film run document with all phase artifacts. */
export type FilmRun = z.infer<typeof filmRunSchema>;
/** Validated request for creating a new film run. */
export type CreateFilmRunRequest = z.infer<typeof createFilmRunRequestSchema>;
/** Pre-parse request shape: optional fields may be omitted by callers. */
export type CreateFilmRunRequestInput = z.input<typeof createFilmRunRequestSchema>;

/** Durable scene fields used to refine progress inside long film phases. */
type FilmRunProgressScene = Pick<FilmSceneState, "storyboard" | "shotSpecs" | "cameraPlan" | "videoPath">;

/** Long-running film phases that advance per durable scene completion. */
export type FilmRunIntraPhaseSceneProgressPhase = Extract<FilmRunPhase, "plan-scenes" | "render">;

/** Per-scene completion counts inside plan-scenes or render. */
export type FilmRunIntraPhaseSceneProgress = {
  phase: FilmRunIntraPhaseSceneProgressPhase;
  completed: number;
  total: number;
};

/**
 * Whether one scene has finished the plan-scenes artifacts (storyboard,
 * shot specs, and camera plan). Missing any of the three keeps the scene
 * incomplete so progress never claims planning finished early.
 */
function scenePlanComplete(scene: FilmRunProgressScene): boolean {
  return scene.storyboard !== null && scene.shotSpecs !== null && scene.cameraPlan !== null;
}

/**
 * Intra-phase fraction in [0, 1] from durable scene state. Returns 0 when
 * there are no scenes yet (stay at the phase floor) so progress never invents
 * completion from an empty array.
 */
function scenePhaseFraction(
  scenes: readonly FilmRunProgressScene[],
  isComplete: (scene: FilmRunProgressScene) => boolean,
): number {
  if (scenes.length === 0) return 0;
  return scenes.filter(isComplete).length / scenes.length;
}

/**
 * Fractional completion of a film run in [0, 1], or null when the phase is
 * unknown. Phases advance sequentially; inside `plan-scenes` and `render` the
 * fraction also advances with durable per-scene completion already persisted
 * on the run (planned artifacts / rendered `videoPath`). This one function
 * backs both the unified progress adapter and the film run receipt so the
 * two surfaces can never diverge. It is not a wall-clock ETA.
 */
export function filmRunProgress(
  run: Pick<FilmRun, "phase"> & { scenes?: readonly FilmRunProgressScene[] },
): number | null {
  const phases = filmRunPhaseSchema.options;
  const index = phases.indexOf(run.phase);
  if (index < 0) return null;
  const last = phases.length - 1;
  if (index >= last) return 1;
  const floor = index / last;
  const span = 1 / last;
  const scenes = run.scenes ?? [];
  if (run.phase === "plan-scenes") {
    return floor + span * scenePhaseFraction(scenes, scenePlanComplete);
  }
  if (run.phase === "render") {
    return floor + span * scenePhaseFraction(scenes, (scene) => scene.videoPath !== null);
  }
  return floor;
}

/**
 * Per-scene completion counts for the current long-running film phase.
 * Returns null outside plan-scenes/render or when no scenes exist yet —
 * the same guard {@link filmRunProgress} uses before inventing intra-phase
 * completion from an empty array.
 */
export function filmRunIntraPhaseSceneProgress(
  run: Pick<FilmRun, "phase"> & { scenes?: readonly FilmRunProgressScene[] },
): FilmRunIntraPhaseSceneProgress | null {
  if (run.phase !== "plan-scenes" && run.phase !== "render") return null;
  const scenes = run.scenes ?? [];
  if (scenes.length === 0) return null;
  const isComplete =
    run.phase === "plan-scenes" ? scenePlanComplete : (scene: FilmRunProgressScene) => scene.videoPath !== null;
  return {
    phase: run.phase,
    completed: scenes.filter(isComplete).length,
    total: scenes.length,
  };
}

/** Groups shots into cameras by camIdx, preserving shot order. */
export function groupShotsIntoCameras(shotSpecs: readonly ShotSpec[]): CameraPlanNode[] {
  const camerasByIdx = new Map<number, CameraPlanNode>();
  for (const spec of shotSpecs) {
    let camera = camerasByIdx.get(spec.camIdx);
    if (!camera) {
      camera = cameraPlanNodeSchema.parse({ idx: spec.camIdx, activeShotIdxs: [spec.idx] });
      camerasByIdx.set(spec.camIdx, camera);
    } else {
      camera.activeShotIdxs.push(spec.idx);
    }
  }
  return [...camerasByIdx.values()];
}

/**
 * Validates parent links coming back from the camera-tree planner: indices
 * must exist, no self-parenting, and the parent chain must be acyclic.
 */
export function validateCameraPlan(cameras: readonly CameraPlanNode[], shotSpecs: readonly ShotSpec[]) {
  const validCameraIdxs = new Set(cameras.map((camera) => camera.idx));
  const validShotIdxs = new Set(shotSpecs.map((spec) => spec.idx));
  const parentByCamera = new Map<number, number | null>();
  for (const camera of cameras) {
    if (camera.parentCamIdx !== null && !validCameraIdxs.has(camera.parentCamIdx)) {
      throw new Error(`Camera ${camera.idx} has invalid parent camera ${camera.parentCamIdx}`);
    }
    if (camera.parentCamIdx === camera.idx) {
      throw new Error(`Camera ${camera.idx} cannot be its own parent`);
    }
    if (camera.parentShotIdx !== null && !validShotIdxs.has(camera.parentShotIdx)) {
      throw new Error(`Camera ${camera.idx} has invalid parent shot ${camera.parentShotIdx}`);
    }
    parentByCamera.set(camera.idx, camera.parentCamIdx);
  }
  for (const camera of cameras) {
    const seen = new Set<number>();
    let current: number | null | undefined = camera.idx;
    while (current !== null && current !== undefined) {
      const parent: number | null | undefined = parentByCamera.get(current);
      if (parent === null || parent === undefined) break;
      if (seen.has(parent)) throw new Error(`Camera tree contains a cycle involving camera ${camera.idx}`);
      seen.add(parent);
      current = parent;
    }
  }
}
