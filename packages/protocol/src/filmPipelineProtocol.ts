import { z } from "zod";
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
  approvedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  /** Bounded progress log; oldest entries are dropped past 200. */
  events: z.array(filmRunEventSchema).max(200).default([]),
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
