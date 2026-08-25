import { z } from "zod";

/**
 * Capture-to-scene reconstruction contract (LiteReality-style pipeline).
 *
 * A capture (posed RGB-D bundle from a scanner app, or a plain RGB video) is
 * staged through the content-addressed media-inputs endpoint and reconstructed
 * by the deterministic `scene.reconstruct` production job. The worker emits a
 * metric report (floor, walls, openings, objects, key views, shell mesh); the
 * gateway composes it into an editable stage plan whose walls are split into
 * passable segments and whose doors carry toggle-transform interactions. The
 * agent loop then authors against the capture: apply → capture → compare →
 * correct, with Player Mode providing first-person exploration.
 */

/** Protocol contract identifier for the capture reconstruction pipeline. */
export const CAPTURE_RECONSTRUCTION_CONTRACT = "director.capture-reconstruction/v1" as const;
/** Production job kind dispatched to the reconstruction worker. */
export const CAPTURE_RECONSTRUCTION_JOB_KIND = "scene.reconstruct" as const;
/** Protocol contract identifier for the capture input bundle. */
export const CAPTURE_BUNDLE_CONTRACT = "director.capture-bundle/v1" as const;

/** Maximum number of wall segments in a reconstruction report. */
export const CAPTURE_RECONSTRUCTION_MAX_WALLS = 64;
/** Maximum number of detected objects in a reconstruction report. */
export const CAPTURE_RECONSTRUCTION_MAX_OBJECTS = 64;
/** Maximum number of key views (camera frames) extracted from a capture. */
export const CAPTURE_RECONSTRUCTION_MAX_KEY_VIEWS = 12;
/** Maximum number of objects allowed in the editable stage plan. */
export const CAPTURE_RECONSTRUCTION_MAX_PLAN_OBJECTS = 320;

const finite = z.number().finite();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const color = z.string().regex(/^#[0-9a-f]{6}$/i, "must be a six-digit hex color");
const metres = (minimum: number, maximum: number) => finite.min(minimum).max(maximum);
const vec3 = (minimum: number, maximum: number) =>
  z.tuple([metres(minimum, maximum), metres(minimum, maximum), metres(minimum, maximum)]);
const vec2 = (minimum: number, maximum: number) => z.tuple([metres(minimum, maximum), metres(minimum, maximum)]);

/** Validates a single safe path segment: no traversal, no separators, not "." or "..". */
const safeFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"), {
    message: "file name must be a single safe path segment",
  });

/** Staged inputs are content-addressed; the id must end in `sha256:<hex>`. */
export const stagedCaptureSourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^(?:[A-Za-z0-9._-]+:)*sha256:[a-f0-9]{64}$/, "sourceMediaId must reference a staged sha256 media input");

/** The kind of capture source: an RGB-D bundle with per-frame depth, or a plain RGB video. */
export const captureSourceKindSchema = z.enum(["rgbd-bundle", "rgb-video"]);

/** Input of the `scene.reconstruct` production job. */
export const captureReconstructionJobInputSchema = z.strictObject({
  sourceMediaId: stagedCaptureSourceIdSchema,
  sourceKind: captureSourceKindSchema,
  fileName: safeFileNameSchema,
  /** Maximum number of key views to extract from the capture. */
  maxKeyViews: z.number().int().min(1).max(CAPTURE_RECONSTRUCTION_MAX_KEY_VIEWS).default(6),
  /** Maximum number of objects to detect in the scene. */
  maxObjects: z.number().int().min(1).max(CAPTURE_RECONSTRUCTION_MAX_OBJECTS).default(24),
  /** Grid resolution for spatial analysis; higher values give finer detail at the cost of performance. */
  gridResolution: z.number().int().min(64).max(512).default(192),
  prompt: z.string().trim().max(2_000).default(""),
});

/** Records which providers supplied each reconstruction signal. */
export const captureReconstructionProvidersSchema = z.strictObject({
  /** Where camera poses came from. `none` marks the degraded RGB-only path. */
  poses: z.enum(["bundle", "estimated", "none"]),
  /** Where per-frame depth came from. */
  depth: z.enum(["sensor", "model", "none"]),
  /** How object labels were assigned. */
  semantics: z.enum(["heuristic", "none"]),
});

/** Quantitative metrics produced by the reconstruction worker. */
export const captureReconstructionMetricsSchema = z.strictObject({
  frameCount: z.number().int().nonnegative(),
  keyViewCount: z.number().int().nonnegative(),
  floorAreaM2: finite.min(0).max(100_000),
  wallCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  /** Share of sampled depth pixels that survived range and validity checks. */
  depthCoverage: finite.min(0).max(1),
});

/** A door or window opening detected along a wall segment. */
export const captureWallOpeningSchema = z.strictObject({
  id: boundedText(120),
  kind: z.enum(["door", "window"]),
  /** Distance of the opening centre from the wall start, along the wall. */
  centerM: metres(0, 1_000),
  widthM: metres(0.2, 8),
  /** Bottom edge above the floor; doors are expected to start at 0. */
  bottomM: metres(0, 4),
  heightM: metres(0.2, 6),
});

/** A wall segment detected in the reconstruction, with optional openings. */
export const captureWallSchema = z.strictObject({
  id: boundedText(120),
  /** Start point of the wall in plan space (x, z), metres. */
  start: vec2(-1_000, 1_000),
  /** End point of the wall in plan space (x, z), metres. */
  end: vec2(-1_000, 1_000),
  heightM: metres(0.5, 12),
  thicknessM: metres(0.02, 1),
  color,
  openings: z.array(captureWallOpeningSchema).max(8),
});

/** An object detected in the scene, positioned on the floor or with unknown support. */
export const captureDetectedObjectSchema = z.strictObject({
  id: boundedText(120),
  label: boundedText(120),
  /** Floor-pivot position (bottom centre) in plan space, Y up, metres. */
  position: vec3(-1_000, 1_000),
  rotationYDeg: finite.min(-360).max(360),
  /** Width / height / depth in metres. */
  size: z.tuple([metres(0.02, 30), metres(0.02, 30), metres(0.02, 30)]),
  color,
  /** Detection confidence; higher values indicate more reliable detections. */
  confidence: finite.min(0).max(1),
  support: z.enum(["floor", "unknown"]),
});

/** A key view extracted from the capture: a representative camera frame with pose. */
export const captureKeyViewSchema = z.strictObject({
  id: boundedText(120),
  fileName: safeFileNameSchema,
  /** Camera position in plan space, Y up, metres. */
  position: vec3(-1_000, 1_000),
  target: vec3(-1_000, 1_000),
  fovYDeg: finite.min(20).max(120),
  width: z.number().int().min(16).max(8_192),
  height: z.number().int().min(16).max(8_192),
});

/** recon.json written by the Python worker; the plan space is Y-up metres. */
export const captureReconstructionReportSchema = z.strictObject({
  contract: z.literal(CAPTURE_RECONSTRUCTION_CONTRACT),
  status: z.enum(["ready", "degraded"]),
  sourceKind: captureSourceKindSchema,
  providers: captureReconstructionProvidersSchema,
  warnings: z.array(boundedText(400)).max(24),
  metrics: captureReconstructionMetricsSchema,
  floor: z
    .strictObject({
      /** Counter-clockwise polygon on the ground plane (x, z), metres. */
      polygon: z.array(vec2(-1_000, 1_000)).min(3).max(64),
    })
    .nullable(),
  walls: z.array(captureWallSchema).max(CAPTURE_RECONSTRUCTION_MAX_WALLS),
  objects: z.array(captureDetectedObjectSchema).max(CAPTURE_RECONSTRUCTION_MAX_OBJECTS),
  keyViews: z.array(captureKeyViewSchema).max(CAPTURE_RECONSTRUCTION_MAX_KEY_VIEWS),
  mesh: z
    .strictObject({
      fileName: safeFileNameSchema,
      vertexCount: z.number().int().nonnegative(),
      faceCount: z.number().int().nonnegative(),
    })
    .nullable(),
});

/** PBR material parameters for a plan object in the editable stage. */
export const capturePlanMaterialSchema = z.strictObject({
  baseColor: color,
  metalness: finite.min(0).max(1),
  roughness: finite.min(0).max(1),
  emissiveColor: color,
  emissiveIntensity: finite.min(0).max(20),
  opacity: finite.min(0.05).max(1),
});

/** Position, rotation (Euler radians), and scale for a plan object. */
const capturePlanTransformSchema = z.strictObject({
  position: vec3(-1_000, 1_000),
  rotation: vec3(-Math.PI * 2, Math.PI * 2),
  scale: z.tuple([metres(0.01, 1_000), metres(0.01, 1_000), metres(0.01, 1_000)]),
});

/** A toggle interaction on a door: the object switches between closed and open transforms. */
export const capturePlanInteractionSchema = z.strictObject({
  prompt: boundedText(120),
  radiusM: metres(0.25, 20),
  closedTransform: capturePlanTransformSchema,
  openTransform: capturePlanTransformSchema,
});

/** The role a plan object plays in the reconstructed scene. */
export const capturePlanObjectRoleSchema = z.enum(["floor", "wall", "door", "window", "item", "shell"]);

/** An editable object in the reconstruction stage plan. */
export const capturePlanObjectSchema = z.strictObject({
  id: boundedText(200),
  enabled: z.boolean(),
  name: boundedText(120),
  role: capturePlanObjectRoleSchema,
  geometryType: z.enum(["box", "sphere", "cylinder", "torus", "cone", "pyramid"]),
  transform: capturePlanTransformSchema,
  material: capturePlanMaterialSchema,
  interaction: capturePlanInteractionSchema.optional(),
  confidence: finite.min(0).max(1),
  rationale: boundedText(400),
});

/** A camera placed in the stage plan, anchored to a capture keyframe. */
export const capturePlanCameraSchema = z.strictObject({
  id: boundedText(200),
  viewId: boundedText(120),
  name: boundedText(120),
  position: vec3(-1_000, 1_000),
  target: vec3(-1_000, 1_000),
  fovYDeg: finite.min(20).max(120),
  width: z.number().int().min(16).max(8_192),
  height: z.number().int().min(16).max(8_192),
  /** Production-job artifact id of the matching capture keyframe. */
  keyframeArtifactId: boundedText(240),
});

/**
 * The editable reconstruction plan produced by the gateway from the worker's
 * recon.json. It contains objects, cameras, an optional shell mesh, and
 * application metadata for tracking which plan objects were applied to the stage.
 */
export const captureReconstructionPlanSchema = z.strictObject({
  version: z.literal(1),
  id: boundedText(200),
  jobId: boundedText(240),
  createdAt: z.string().datetime({ offset: true }),
  status: z.enum(["draft", "applied"]),
  source: z.strictObject({
    kind: captureSourceKindSchema,
    fileName: safeFileNameSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  analysis: z.strictObject({
    status: z.enum(["ready", "degraded"]),
    providers: captureReconstructionProvidersSchema,
    warnings: z.array(boundedText(400)).max(24),
    metrics: captureReconstructionMetricsSchema,
    prompt: z.string().trim().max(2_000),
  }),
  objects: z.array(capturePlanObjectSchema).min(1).max(CAPTURE_RECONSTRUCTION_MAX_PLAN_OBJECTS),
  cameras: z.array(capturePlanCameraSchema).max(CAPTURE_RECONSTRUCTION_MAX_KEY_VIEWS),
  shell: z
    .strictObject({
      artifactId: boundedText(240),
      fileName: safeFileNameSchema,
      sizeM: vec3(0.01, 1_000),
    })
    .nullable(),
  application: z
    .strictObject({
      appliedAt: z.string().datetime({ offset: true }),
      objectIds: z.array(boundedText(200)).max(CAPTURE_RECONSTRUCTION_MAX_PLAN_OBJECTS),
      cameraIds: z.array(boundedText(200)).max(CAPTURE_RECONSTRUCTION_MAX_KEY_VIEWS),
      shellObjectId: boundedText(200).nullable(),
    })
    .optional(),
});

/** Response envelope wrapping the reconstruction plan. */
export const captureReconstructionPlanResponseSchema = z.strictObject({
  plan: captureReconstructionPlanSchema,
});

/** Similarity between a stage render and the matching capture keyframe. */
export const captureCompareScoreSchema = z.strictObject({
  /** Mean structural similarity over the luminance grid, -1..1. */
  ssim: finite.min(-1).max(1),
  /** 1 - mean absolute luminance difference, 0..1. */
  luminanceSimilarity: finite.min(0).max(1),
  /** Edge-density agreement, 0..1. */
  edgeSimilarity: finite.min(0).max(1),
  /** Weighted blend of the components, 0..1; the authoring-loop target. */
  composite: finite.min(0).max(1),
});

/** The result of comparing a stage render against a capture keyframe. */
export const captureCompareResultSchema = z.strictObject({
  viewId: boundedText(120),
  cameraId: boundedText(200),
  score: captureCompareScoreSchema,
  grid: z.strictObject({
    rows: z.number().int().min(1).max(16),
    cols: z.number().int().min(1).max(16),
    /** Worst cells first; each names a region that disagrees with the capture. */
    worst: z
      .array(
        z.strictObject({
          row: z.number().int().min(0).max(15),
          col: z.number().int().min(0).max(15),
          ssim: finite.min(-1).max(1),
        }),
      )
      .max(8),
  }),
  capturedAt: z.string().datetime({ offset: true }),
});

/** The kind of capture source: RGB-D bundle or plain RGB video. */
export type CaptureSourceKind = z.infer<typeof captureSourceKindSchema>;
/** Input parameters for the scene.reconstruct production job. */
export type CaptureReconstructionJobInput = z.infer<typeof captureReconstructionJobInputSchema>;
/** The reconstruction report emitted by the Python worker. */
export type CaptureReconstructionReport = z.infer<typeof captureReconstructionReportSchema>;
/** A wall segment detected in the reconstruction. */
export type CaptureWall = z.infer<typeof captureWallSchema>;
/** A door or window opening detected along a wall. */
export type CaptureWallOpening = z.infer<typeof captureWallOpeningSchema>;
/** An object detected in the scene. */
export type CaptureDetectedObject = z.infer<typeof captureDetectedObjectSchema>;
/** A key view extracted from the capture. */
export type CaptureKeyView = z.infer<typeof captureKeyViewSchema>;
/** An editable object in the reconstruction stage plan. */
export type CapturePlanObject = z.infer<typeof capturePlanObjectSchema>;
/** A camera placed in the stage plan, anchored to a capture keyframe. */
export type CapturePlanCamera = z.infer<typeof capturePlanCameraSchema>;
/** The editable reconstruction plan produced by the gateway. */
export type CaptureReconstructionPlan = z.infer<typeof captureReconstructionPlanSchema>;
/** The result of comparing a stage render against a capture keyframe. */
export type CaptureCompareResult = z.infer<typeof captureCompareResultSchema>;
