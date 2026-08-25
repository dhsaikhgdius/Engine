import { z } from "zod";
import { stableLexicalJson } from "./stableJson";

/**
 * Episode data contract for the synthetic data engine.
 *
 * An episode is one reproducible action-conditioned 4D rollout: rendered video
 * plus a layered action track plus layered captions, all indexed by frame
 * against a single rational-frame-rate timebase. The manifest binds the exact
 * scene revision, seed, renderer, code version and assets that produced the
 * outputs so a released episode stays auditable end to end.
 *
 * Spatial conventions follow the Director stage: positions are meters in a
 * right-handed Y-up world; the camera looks down its local -Z axis.
 */

/** Protocol contract identifier for the episode manifest. */
export const EPISODE_MANIFEST_CONTRACT = "director-episode-manifest-v1" as const;
/** Protocol contract identifier for the episode action track. */
export const EPISODE_ACTION_TRACK_CONTRACT = "director-episode-action-track-v1" as const;
/** Protocol contract identifier for the episode captions document. */
export const EPISODE_CAPTIONS_CONTRACT = "director-episode-captions-v1" as const;

const idSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const finite = z.number().finite();
const vector2 = z.tuple([finite, finite]);
const vector3 = z.tuple([finite, finite, finite]);
const quaternion = z.tuple([finite, finite, finite, finite]);

/** ~12 hours at 24 fps; a single episode is a rollout, not a whole dataset. */
const MAX_FRAME_COUNT = 1_048_576;
const frameIndexSchema = z.number().int().nonnegative().max(MAX_FRAME_COUNT);

// ---------------------------------------------------------------------------
// Timebase
// ---------------------------------------------------------------------------

/** A rational frame rate: numerator / denominator, e.g. 24000/1001 for NTSC. */
export const episodeFrameRateSchema = z.strictObject({
  numerator: z.number().int().positive().max(1_000_000),
  denominator: z.number().int().positive().max(1_000_000),
});

/** SMPTE timecode; ":" before frames means non-drop, ";" means drop-frame (Video Editor convention). */
const SMPTE_TIMECODE_PATTERN = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;

/** The timebase of an episode: frame rate, total frame count, and optional start timecode. */
export const episodeTimebaseSchema = z.strictObject({
  frameRate: episodeFrameRateSchema,
  frameCount: z.number().int().positive().max(MAX_FRAME_COUNT),
  startTimecode: z.string().regex(SMPTE_TIMECODE_PATTERN).optional(),
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * DirectorProject revisions are opaque strings
 * ("director-project-revision:v1:sha256:…") while production StageScene
 * revisions are monotonic non-negative integers; an episode binds whichever
 * document owned the captured scene.
 */
export const episodeSceneRevisionSchema = z.union([z.string().trim().min(1).max(240), z.number().int().nonnegative()]);

/** The renderer configuration used to produce the episode: backend, version, resolution, and color space. */
export const episodeRendererSchema = z.strictObject({
  /** Open backend identifier, e.g. "three-webgl" or "blender-cycles". */
  backendId: z.string().trim().min(1).max(160),
  version: z.string().trim().min(1).max(240),
  resolution: z.strictObject({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }),
  /** Open color space name, e.g. "srgb" or "acescg". */
  colorSpace: z.string().trim().min(1).max(80),
});

/** A reference to an asset used in the episode, identified by id and content hash. */
export const episodeAssetRefSchema = z.strictObject({
  assetId: idSchema,
  sha256: sha256Schema,
  /** SPDX identifier or free-form license note; required before dataset release. */
  license: z.string().trim().min(1).max(240).optional(),
});

/**
 * Provenance metadata for the episode: the code version, configuration hash,
 * and the set of assets used. Asset ids must be unique.
 */
export const episodeProvenanceSchema = z
  .strictObject({
    /** Git commit hash or release version of the generation code. */
    codeVersion: z.string().trim().min(1).max(240),
    /** Fingerprint of the full generation configuration (scenario, sampler, backend settings). */
    configHash: z.string().trim().min(16).max(512),
    assets: z.array(episodeAssetRefSchema).max(4_096).default([]),
  })
  .superRefine((value, context) => {
    // Duplicate asset ids would make provenance ambiguous.
    if (new Set(value.assets.map((asset) => asset.assetId)).size !== value.assets.length) {
      context.addIssue({ code: "custom", path: ["assets"], message: "asset assetIds must be unique" });
    }
  });

/** The kind of artifact in an episode package: video, action track, captions, render pass, or metadata. */
export const episodeArtifactKindSchema = z.enum(["video", "action-track", "captions", "render-pass", "metadata"]);

const episodeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: "path must be a normalized episode-relative path without traversal segments" },
  );

/** A reference to an artifact in the episode package, identified by relative path, kind, hash, and size. */
export const episodeArtifactRefSchema = z.strictObject({
  path: episodeRelativePathSchema,
  kind: episodeArtifactKindSchema,
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
});

/** The result of a single quality gate check: whether it passed and optional detail. */
export const episodeQualityResultSchema = z.strictObject({
  gateId: idSchema,
  passed: z.boolean(),
  detail: z.string().trim().max(4_000).optional(),
});

/**
 * The episode manifest: the root document that binds the scene revision, seed,
 * timebase, renderer, provenance, and artifact list into a single auditable
 * record. Artifact paths and quality gate ids must be unique.
 */
export const episodeManifestSchema = z
  .strictObject({
    contract: z.literal(EPISODE_MANIFEST_CONTRACT),
    id: idSchema,
    datasetId: idSchema.optional(),
    projectId: idSchema,
    sceneRevision: episodeSceneRevisionSchema,
    seed: z.number().int(),
    timebase: episodeTimebaseSchema,
    renderer: episodeRendererSchema,
    provenance: episodeProvenanceSchema,
    artifacts: z.array(episodeArtifactRefSchema).min(1).max(256),
    /** Open-ended quality-gate results; gates are defined by the pipeline, not this contract. */
    quality: z.array(episodeQualityResultSchema).max(256).optional(),
  })
  .superRefine((value, context) => {
    // Duplicate artifact paths would make the package ambiguous.
    if (new Set(value.artifacts.map((artifact) => artifact.path)).size !== value.artifacts.length) {
      context.addIssue({ code: "custom", path: ["artifacts"], message: "artifact paths must be unique" });
    }
    const gateIds = (value.quality ?? []).map((result) => result.gateId);
    if (new Set(gateIds).size !== gateIds.length) {
      context.addIssue({ code: "custom", path: ["quality"], message: "quality gateIds must be unique" });
    }
  });

// ---------------------------------------------------------------------------
// Action track (the "action" of the video-text-action triplet)
// ---------------------------------------------------------------------------

/**
 * Raw control input for the episode: keyboard keys, pointer deltas, and analog
 * axes, stored as per-frame arrays. Keys and axis ids must be unique, and each
 * pressed row must have exactly one flag per key.
 */
export const episodeRawControlSchema = z
  .strictObject({
    /** Key-code dictionary, e.g. KeyboardEvent.code values plus mouse-button aliases. */
    keys: z.array(z.string().trim().min(1).max(64)).max(256),
    /** Column-major per-frame storage: one multi-hot row per frame, row[i] mirrors keys[i]. */
    pressed: z.array(z.array(z.union([z.literal(0), z.literal(1)]))).max(MAX_FRAME_COUNT),
    /** Pointer movement accumulated within each frame, in CSS pixels. */
    pointerDelta: z.array(vector2).max(MAX_FRAME_COUNT).optional(),
    /** Analog axes (sticks, triggers); one sample per frame per axis. */
    axes: z
      .array(
        z.strictObject({
          id: z.string().trim().min(1).max(64),
          values: z.array(finite).max(MAX_FRAME_COUNT),
        }),
      )
      .max(32)
      .optional(),
  })
  .superRefine((value, context) => {
    if (new Set(value.keys).size !== value.keys.length) {
      context.addIssue({ code: "custom", path: ["keys"], message: "keys must be unique" });
    }
    const mismatch = value.pressed.findIndex((row) => row.length !== value.keys.length);
    if (mismatch !== -1) {
      context.addIssue({
        code: "custom",
        path: ["pressed", mismatch],
        message: `pressed[${mismatch}] must have exactly one flag per key (${value.keys.length})`,
      });
    }
    const axisIds = (value.axes ?? []).map((axis) => axis.id);
    if (new Set(axisIds).size !== axisIds.length) {
      context.addIssue({ code: "custom", path: ["axes"], message: "axis ids must be unique" });
    }
  });

/** Shared pinhole intrinsics for the whole episode; per-frame intrinsics are a later extension. */
export const episodeCameraIntrinsicsSchema = z
  .strictObject({
    focalLengthMm: finite.positive().max(1_000).optional(),
    /** Vertical field of view (three.js PerspectiveCamera convention). */
    fovDegrees: finite.positive().lt(180).optional(),
    sensorWidthMm: finite.positive().max(1_000).optional(),
    sensorHeightMm: finite.positive().max(1_000).optional(),
    /** Normalized image coordinates, origin top-left; defaults to the image center when absent. */
    principalPoint: z.strictObject({ x: finite, y: finite }).optional(),
  })
  .superRefine((value, context) => {
    // Exactly one of focalLengthMm or fovDegrees must be provided; both or neither is invalid.
    if ((value.focalLengthMm === undefined) === (value.fovDegrees === undefined)) {
      context.addIssue({
        code: "custom",
        message: "exactly one of focalLengthMm or fovDegrees must be provided",
      });
    }
  });

/** Per-frame camera pose: intrinsics plus arrays of world-space positions and unit quaternion rotations. */
export const episodeCameraPoseSchema = z.strictObject({
  intrinsics: episodeCameraIntrinsicsSchema,
  /** World-space camera positions in meters (right-handed Y-up; camera forward is -Z). */
  positions: z.array(vector3).max(MAX_FRAME_COUNT),
  /** Unit quaternions as [x, y, z, w]. */
  rotations: z.array(quaternion).max(MAX_FRAME_COUNT),
});

/** A semantic event at a specific frame, with an open vocabulary type and optional subject/object/payload. */
export const episodeSemanticEventSchema = z.strictObject({
  frame: frameIndexSchema,
  /** Open event vocabulary, e.g. "object-picked" or "camera-cut". */
  type: z.string().trim().min(1).max(160),
  subjectId: idSchema.optional(),
  objectId: idSchema.optional(),
  payload: z.json().optional(),
});

/**
 * The action track document: raw control, camera pose, and semantic events.
 * Must include at least one layer.
 */
export const episodeActionTrackSchema = z
  .strictObject({
    contract: z.literal(EPISODE_ACTION_TRACK_CONTRACT),
    rawControl: episodeRawControlSchema.optional(),
    cameraPose: episodeCameraPoseSchema.optional(),
    /** Sorted by frame ascending; multiple events may share a frame. */
    semanticEvents: z.array(episodeSemanticEventSchema).max(MAX_FRAME_COUNT).optional(),
  })
  .superRefine((value, context) => {
    // An action track with no layers carries no actionable data.
    if (!value.rawControl && !value.cameraPose && !value.semanticEvents) {
      context.addIssue({
        code: "custom",
        message: "an action track must include at least one layer (rawControl, cameraPose or semanticEvents)",
      });
    }
  });

// ---------------------------------------------------------------------------
// Captions (the "text" of the video-text-action triplet)
// ---------------------------------------------------------------------------

/**
 * Caption provenance is a first-class field: synthetic scenes compose captions
 * deterministically from the scene graph, so downstream training can separate
 * verifiable descriptions from VLM- or human-authored ones.
 */
export const episodeCaptionGeneratorSchema = z.strictObject({
  method: z.enum(["deterministic-composed", "vlm-polished", "vlm-generated", "human"]),
  model: z.string().trim().min(1).max(240).optional(),
});

/** Lightweight BCP-47 shape check ("en", "en-US", "zh-Hans-CN"); not a registry validation. */
const languageTagSchema = z
  .string()
  .min(2)
  .max(56)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/);

const captionLayerBaseFields = {
  language: languageTagSchema,
  generator: episodeCaptionGeneratorSchema,
} satisfies z.ZodRawShape;

/** A single text caption layer: language, generator provenance, and the caption text. */
export const episodeCaptionTextLayerSchema = z.strictObject({
  ...captionLayerBaseFields,
  text: z.string().trim().min(1).max(16_000),
});

/** A single entry in a dense caption layer, spanning a frame range [frameStart, frameEnd] inclusive. */
export const episodeDenseCaptionEntrySchema = z.strictObject({
  frameStart: frameIndexSchema,
  /** Inclusive; a single-frame caption has frameStart === frameEnd. */
  frameEnd: frameIndexSchema,
  caption: z.string().trim().min(1).max(4_000),
});

/** A dense caption layer: language, generator provenance, and a time-sorted list of frame-range entries. */
export const episodeDenseCaptionLayerSchema = z.strictObject({
  ...captionLayerBaseFields,
  /** Sorted by frameStart ascending; overlapping windows are allowed. */
  entries: z.array(episodeDenseCaptionEntrySchema).max(100_000),
});

/**
 * The captions document: narrative, static scene description, and dense
 * temporal captions. Must include at least one layer.
 */
export const episodeCaptionsSchema = z
  .strictObject({
    contract: z.literal(EPISODE_CAPTIONS_CONTRACT),
    /** Full narration interleaving environment, camera motion and temporal progression. */
    narrative: episodeCaptionTextLayerSchema.optional(),
    /** Static environment and aesthetics only — deliberately motion-free so scene description decouples from action control. */
    sceneStatic: episodeCaptionTextLayerSchema.optional(),
    denseTemporal: episodeDenseCaptionLayerSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.narrative && !value.sceneStatic && !value.denseTemporal) {
      context.addIssue({
        code: "custom",
        message: "captions must include at least one layer (narrative, sceneStatic or denseTemporal)",
      });
    }
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

/** A rational frame rate: numerator / denominator. */
export type EpisodeFrameRate = z.infer<typeof episodeFrameRateSchema>;
/** The timebase of an episode: frame rate, frame count, and optional start timecode. */
export type EpisodeTimebase = z.infer<typeof episodeTimebaseSchema>;
/** A scene revision: either an opaque string or a monotonic integer. */
export type EpisodeSceneRevision = z.infer<typeof episodeSceneRevisionSchema>;
/** The renderer configuration used to produce the episode. */
export type EpisodeRenderer = z.infer<typeof episodeRendererSchema>;
/** A reference to an asset used in the episode. */
export type EpisodeAssetRef = z.infer<typeof episodeAssetRefSchema>;
/** Provenance metadata for the episode. */
export type EpisodeProvenance = z.infer<typeof episodeProvenanceSchema>;
/** The kind of artifact in an episode package. */
export type EpisodeArtifactKind = z.infer<typeof episodeArtifactKindSchema>;
/** A reference to an artifact in the episode package. */
export type EpisodeArtifactRef = z.infer<typeof episodeArtifactRefSchema>;
/** The result of a single quality gate check. */
export type EpisodeQualityResult = z.infer<typeof episodeQualityResultSchema>;
/** The episode manifest: the root document binding all episode metadata. */
export type EpisodeManifest = z.output<typeof episodeManifestSchema>;
/** Pre-parse manifest shape: fields with defaults may be omitted by callers. */
export type EpisodeManifestInput = z.input<typeof episodeManifestSchema>;
/** Raw control input for the episode: keys, pointer deltas, and analog axes. */
export type EpisodeRawControl = z.infer<typeof episodeRawControlSchema>;
/** Shared pinhole camera intrinsics for the episode. */
export type EpisodeCameraIntrinsics = z.infer<typeof episodeCameraIntrinsicsSchema>;
/** Per-frame camera pose: intrinsics plus position and rotation arrays. */
export type EpisodeCameraPose = z.infer<typeof episodeCameraPoseSchema>;
/** A semantic event at a specific frame. */
export type EpisodeSemanticEvent = z.infer<typeof episodeSemanticEventSchema>;
/** The action track document: raw control, camera pose, and semantic events. */
export type EpisodeActionTrack = z.infer<typeof episodeActionTrackSchema>;
/** Caption generator provenance: method and optional model. */
export type EpisodeCaptionGenerator = z.infer<typeof episodeCaptionGeneratorSchema>;
/** A single text caption layer. */
export type EpisodeCaptionTextLayer = z.infer<typeof episodeCaptionTextLayerSchema>;
/** A single entry in a dense caption layer. */
export type EpisodeDenseCaptionEntry = z.infer<typeof episodeDenseCaptionEntrySchema>;
/** A dense caption layer with time-sorted frame-range entries. */
export type EpisodeDenseCaptionLayer = z.infer<typeof episodeDenseCaptionLayerSchema>;
/** The captions document: narrative, static scene, and dense temporal layers. */
export type EpisodeCaptions = z.infer<typeof episodeCaptionsSchema>;

// ---------------------------------------------------------------------------
// Production job: pair a staged video with the action/caption documents
// ---------------------------------------------------------------------------

/** Production job kind for packaging an episode from staged video and documents. */
export const EPISODE_PACKAGE_JOB_KIND = "episode.package" as const;

/** Expected filename for the rendered video in an episode package. */
export const EPISODE_PACKAGE_VIDEO_FILE = "rgb.mp4";
/** Expected filename for the action track document in an episode package. */
export const EPISODE_PACKAGE_ACTION_TRACK_FILE = "action-track.json";
/** Expected filename for the captions document in an episode package. */
export const EPISODE_PACKAGE_CAPTIONS_FILE = "captions.json";
/** Expected filename for the manifest in an episode package. */
export const EPISODE_PACKAGE_MANIFEST_FILE = "manifest.json";
/** Expected filename for the raw session record in an episode package. */
export const EPISODE_PACKAGE_SESSION_RECORD_FILE = "session-record.json";

/** Staged MP4 id, same addressing as media.transcode (`media-input:sha256:<hex>`). */
export const episodePackageSourceMediaIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^(?:[A-Za-z0-9._-]+:)*sha256:[a-f0-9]{64}$/, "sourceVideoMediaId must reference a staged sha256 media input");

/**
 * Input of the `episode.package` production job. Conversion (SessionRecord →
 * action track) and caption composition happen before enqueue; this job binds
 * those documents to a content-addressed video and writes the hashed package.
 */
export const episodePackageJobInputSchema = z.strictObject({
  episodeId: idSchema,
  projectId: idSchema,
  datasetId: idSchema.optional(),
  sceneRevision: episodeSceneRevisionSchema,
  seed: z.number().int(),
  sourceVideoMediaId: episodePackageSourceMediaIdSchema,
  timebase: episodeTimebaseSchema,
  renderer: episodeRendererSchema,
  provenance: episodeProvenanceSchema,
  actionTrack: episodeActionTrackSchema,
  captions: episodeCaptionsSchema,
  /** Optional raw session log, stored as a provenance artifact (not training input). */
  sessionRecord: z.json().optional(),
  quality: z.array(episodeQualityResultSchema).max(256).optional(),
});

/** The parsed (output) shape of the episode package job input. */
export type EpisodePackageJobInput = z.output<typeof episodePackageJobInputSchema>;
/** The pre-parse (input) shape of the episode package job input, with optional defaults. */
export type EpisodePackageJobInputDraft = z.input<typeof episodePackageJobInputSchema>;

/**
 * Extracts the sha256 hex digest from a content-addressed source media id.
 *
 * @param sourceVideoMediaId - A staged media id ending in `sha256:<hex>`.
 * @returns The 64-character lowercase hex digest.
 * @throws When the id does not end in a valid sha256 suffix.
 */
export function parseEpisodePackageSourceSha256(sourceVideoMediaId: string): string {
  const match = sourceVideoMediaId.match(/sha256:([a-f0-9]{64})$/);
  if (!match) {
    throw new Error(`sourceVideoMediaId does not end in sha256:<hex>: ${sourceVideoMediaId.slice(0, 80)}`);
  }
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Cross-document integrity
// ---------------------------------------------------------------------------

/** Codes for cross-document integrity issues detected during validation. */
export type EpisodeIntegrityIssueCode =
  | "timebase-invalid"
  | "frame-array-length"
  | "event-frame-out-of-bounds"
  | "event-order"
  | "caption-range-inverted"
  | "caption-range-out-of-bounds"
  | "caption-order"
  | "quaternion-not-normalized";

/** A single cross-document integrity issue with a code, path, and message. */
export interface EpisodeIntegrityIssue {
  readonly code: EpisodeIntegrityIssueCode;
  /** Rooted at the offending document: "manifest", "actionTrack" or "captions". */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** Absolute tolerance on |q| - 1; generous enough for float32 round-trips. */
export const EPISODE_QUATERNION_NORM_TOLERANCE = 1e-3;

/**
 * Cross-field and cross-document invariants that the per-document Zod schemas
 * cannot express: per-frame arrays must match the manifest frame count, events
 * and dense captions must stay inside the frame range and sorted, and camera
 * rotations must be unit quaternions. The timebase itself is re-checked so the
 * function also guards hand-assembled (unparsed) values.
 *
 * @param manifest - The parsed episode manifest.
 * @param actionTrack - Optional action track to validate against the manifest.
 * @param captions - Optional captions document to validate against the manifest.
 * @returns An array of integrity issues; empty when all invariants hold.
 */
export function validateEpisodeIntegrity(
  manifest: EpisodeManifest,
  actionTrack?: EpisodeActionTrack,
  captions?: EpisodeCaptions,
): EpisodeIntegrityIssue[] {
  const issues: EpisodeIntegrityIssue[] = [];
  const { frameRate, frameCount } = manifest.timebase;
  if (!Number.isSafeInteger(frameRate.numerator) || frameRate.numerator <= 0) {
    issues.push({
      code: "timebase-invalid",
      path: ["manifest", "timebase", "frameRate", "numerator"],
      message: "frame rate numerator must be a positive integer",
    });
  }
  if (!Number.isSafeInteger(frameRate.denominator) || frameRate.denominator <= 0) {
    issues.push({
      code: "timebase-invalid",
      path: ["manifest", "timebase", "frameRate", "denominator"],
      message: "frame rate denominator must be a positive integer",
    });
  }
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    issues.push({
      code: "timebase-invalid",
      path: ["manifest", "timebase", "frameCount"],
      message: "frameCount must be a positive integer",
    });
    // Frame-indexed checks would only cascade noise without a usable frame count.
    return issues;
  }

  const requireFrameLength = (actual: number, path: readonly (string | number)[]): void => {
    if (actual !== frameCount) {
      issues.push({
        code: "frame-array-length",
        path,
        message: `expected ${frameCount} per-frame entries, found ${actual}`,
      });
    }
  };

  if (actionTrack?.rawControl) {
    const { pressed, pointerDelta, axes } = actionTrack.rawControl;
    requireFrameLength(pressed.length, ["actionTrack", "rawControl", "pressed"]);
    if (pointerDelta) {
      requireFrameLength(pointerDelta.length, ["actionTrack", "rawControl", "pointerDelta"]);
    }
    for (const [index, axis] of (axes ?? []).entries()) {
      requireFrameLength(axis.values.length, ["actionTrack", "rawControl", "axes", index, "values"]);
    }
  }

  if (actionTrack?.cameraPose) {
    const { positions, rotations } = actionTrack.cameraPose;
    requireFrameLength(positions.length, ["actionTrack", "cameraPose", "positions"]);
    requireFrameLength(rotations.length, ["actionTrack", "cameraPose", "rotations"]);
    for (const [index, rotation] of rotations.entries()) {
      const norm = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
      if (!(Math.abs(norm - 1) <= EPISODE_QUATERNION_NORM_TOLERANCE)) {
        issues.push({
          code: "quaternion-not-normalized",
          path: ["actionTrack", "cameraPose", "rotations", index],
          message: `quaternion norm ${norm} is outside the unit tolerance ${EPISODE_QUATERNION_NORM_TOLERANCE}`,
        });
      }
    }
  }

  const events = actionTrack?.semanticEvents ?? [];
  for (const [index, event] of events.entries()) {
    if (!Number.isSafeInteger(event.frame) || event.frame < 0 || event.frame >= frameCount) {
      issues.push({
        code: "event-frame-out-of-bounds",
        path: ["actionTrack", "semanticEvents", index, "frame"],
        message: `event frame ${event.frame} must be within [0, ${frameCount})`,
      });
    }
    const previous = events[index - 1];
    if (previous && event.frame < previous.frame) {
      issues.push({
        code: "event-order",
        path: ["actionTrack", "semanticEvents", index, "frame"],
        message: "semantic events must be sorted by frame ascending (same-frame events allowed)",
      });
    }
  }

  const entries = captions?.denseTemporal?.entries ?? [];
  for (const [index, entry] of entries.entries()) {
    if (entry.frameStart > entry.frameEnd) {
      issues.push({
        code: "caption-range-inverted",
        path: ["captions", "denseTemporal", "entries", index],
        message: `frameStart ${entry.frameStart} must not exceed frameEnd ${entry.frameEnd}`,
      });
    }
    for (const bound of ["frameStart", "frameEnd"] as const) {
      const frame = entry[bound];
      if (!Number.isSafeInteger(frame) || frame < 0 || frame >= frameCount) {
        issues.push({
          code: "caption-range-out-of-bounds",
          path: ["captions", "denseTemporal", "entries", index, bound],
          message: `${bound} ${frame} must be within [0, ${frameCount})`,
        });
      }
    }
    const previous = entries[index - 1];
    if (previous && entry.frameStart < previous.frameStart) {
      issues.push({
        code: "caption-order",
        path: ["captions", "denseTemporal", "entries", index, "frameStart"],
        message: "dense caption entries must be sorted by frameStart ascending",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Canonical manifest bytes for hashing. Parsing first applies schema defaults
 * so equivalent inputs canonicalize identically; code-point key ordering keeps
 * the result portable across runtimes. Computing the actual sha256 is the
 * caller's job — this package stays runtime-neutral.
 *
 * @param manifest - The episode manifest input (may omit defaulted fields).
 * @returns A stable JSON string suitable for hashing.
 */
export function canonicalEpisodeJson(manifest: EpisodeManifestInput): string {
  return stableLexicalJson(episodeManifestSchema.parse(manifest));
}
