import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../../../frontend/director/src/comprehensive/editor/schema/directorProjectRevision";
import { directorDccCanonicalReturnCoordinateSystemSchema } from "./directorDccReturnContract";
import { directorDccTransformSchema } from "./directorDccSharedContract";

/**
 * Contract identifier for the Godot animation bake sidecar the Gateway writes
 * next to a headless Godot job. The sidecar carries time-sampled canonical
 * Director-space transforms (plus camera vertical fov) so the Godot connector
 * can key AnimationPlayer/AnimationLibrary tracks on `director_id` nodes
 * without re-implementing Director's animation evaluators (easing curves,
 * trajectories, camera path/follow actions).
 */
export const DIRECTOR_GODOT_ANIMATION_BAKE_CONTRACT = "director-godot-animation-bake-v1" as const;

const nonEmpty = z.string().trim().min(1);

/** A rational frame rate (for example 24000/1001 for 23.976 fps). */
export const directorGodotRationalRateSchema = z.strictObject({
  numerator: z.number().int().positive().max(1_000_000),
  denominator: z.number().int().positive().max(1_000_000),
});

/** Rational frame rate carried by the Godot animation bake. */
export type DirectorGodotRationalRate = z.infer<typeof directorGodotRationalRateSchema>;

/** SMPTE timecode string, `HH:MM:SS:FF` (non-drop) or `HH:MM:SS;FF` (drop-frame). */
export const directorGodotTimecodeSchema = z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/);

/**
 * The rational timebase the connector must apply when converting Director
 * frames to Godot animation key times. Godot animations address time in float
 * seconds; the connector derives `seconds = frame * denominator / numerator`
 * from the rational rate instead of trusting a pre-rounded fps float.
 */
export const directorGodotAnimationTimebaseSchema = z.strictObject({
  rate: directorGodotRationalRateSchema,
  dropFrame: z.boolean(),
  startTimecode: directorGodotTimecodeSchema,
});

/** Godot animation timebase (rational rate + drop frame + start timecode). */
export type DirectorGodotAnimationTimebase = z.infer<typeof directorGodotAnimationTimebaseSchema>;

/** One baked transform sample: a Director timeline frame plus a canonical-space world transform. */
export const directorGodotTransformSampleSchema = z.strictObject({
  frame: z.number().int().min(-1_000_000).max(75_000_000_000),
  transform: directorDccTransformSchema,
});

/** A baked transform sample at one Director timeline frame. */
export type DirectorGodotTransformSample = z.infer<typeof directorGodotTransformSampleSchema>;

/**
 * One baked camera optics sample: vertical field of view in degrees at a
 * Director timeline frame. Godot's `Camera3D.fov` is a vertical angle in
 * degrees (with the default `KEEP_HEIGHT` aspect mode), matching Director's
 * own vertical-fov convention, so no filmback conversion is required.
 */
export const directorGodotFovSampleSchema = z.strictObject({
  frame: z.number().int().min(-1_000_000).max(75_000_000_000),
  fovDeg: z.number().finite().gt(0).lt(180),
});

/** A baked camera vertical-fov sample at one Director timeline frame. */
export type DirectorGodotFovSample = z.infer<typeof directorGodotFovSampleSchema>;

function strictlyIncreasingFrames(samples: ReadonlyArray<{ frame: number }>) {
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]!.frame <= samples[index - 1]!.frame) return index;
  }
  return -1;
}

/**
 * One Director storyboard shot range the connector maps onto a discrete
 * `Camera3D.current` camera-cut key inside the Director timeline animation.
 * The Gateway clamps ranges into the bake playback window and sorts them by
 * `frameStart`; shots without a usable camera binding still travel (with
 * `cameraDirectorId: null`) so the connector can warn-and-omit them with a
 * structured code instead of silently dropping editorial data.
 */
export const directorGodotShotRangeSchema = z
  .strictObject({
    shotId: nonEmpty.max(200),
    title: z.string().max(240),
    /** Director camera id bound to the shot, or null when the shot has no camera. */
    cameraDirectorId: nonEmpty.max(200).nullable(),
    frameStart: z.number().int().min(-1_000_000).max(75_000_000_000),
    frameEnd: z.number().int().min(-1_000_000).max(75_000_000_000),
  })
  .refine((shot) => shot.frameEnd >= shot.frameStart, {
    message: "frameEnd must be at or after frameStart",
    path: ["frameEnd"],
  });

/** One baked storyboard shot range. */
export type DirectorGodotShotRange = z.infer<typeof directorGodotShotRangeSchema>;

/**
 * Structured detail about animation channels the bake could not carry.
 * Control and clip lists are capped samples; the counts are authoritative.
 */
export const directorGodotOmittedChannelDetailSchema = z.strictObject({
  /** Total distinct rig pose control names present in authored keyframes. */
  poseControlCount: z.number().int().nonnegative().max(100_000),
  /** Sorted sample of omitted pose control names (capped at 32). */
  poseControls: z.array(nonEmpty.max(160)).max(32),
  /** Total character motion clips authored on the entity. */
  motionClipCount: z.number().int().nonnegative().max(100_000),
  /** Sample of omitted motion clip ranges (capped at 32). */
  motionClips: z
    .array(
      z.strictObject({
        id: nonEmpty.max(120),
        frameStart: z.number().int().min(-1_000_000).max(1_000_000),
        frameEnd: z.number().int().min(-1_000_000).max(1_000_000),
      }),
    )
    .max(32),
});

/** Structured warn-and-omit detail for one baked entity. */
export type DirectorGodotOmittedChannelDetail = z.infer<typeof directorGodotOmittedChannelDetailSchema>;

/**
 * One baked entity track. Transforms are Director canonical-space world
 * transforms (right-handed, Y-up, metres, camera forward -Z); Godot's basis
 * is identical, so the connector applies them through `director_space.gd`
 * without a numeric basis change.
 */
export const directorGodotBakedEntitySchema = z
  .strictObject({
    directorId: nonEmpty.max(200),
    entityType: z.enum(["object", "camera"]),
    name: z.string().max(240),
    transformSamples: z.array(directorGodotTransformSampleSchema).min(1).max(100_000),
    /** Camera-only: per-frame vertical fov keys for the Godot `Camera3D.fov` property track. */
    fovSamples: z.array(directorGodotFovSampleSchema).max(100_000).optional(),
    /** Channels present in the source animation that the bake could not carry (warn-and-omit). */
    omittedChannels: z
      .array(z.enum(["pose_values", "motion_blocks", "character_rig"]))
      .max(8)
      .optional(),
    /** Structured detail (control names, clip ranges) behind `omittedChannels`. */
    omittedDetail: directorGodotOmittedChannelDetailSchema.optional(),
    warnings: z.array(z.string().max(2_000)).max(200),
  })
  .superRefine((entity, context) => {
    const badTransformIndex = strictlyIncreasingFrames(entity.transformSamples);
    if (badTransformIndex >= 0) {
      context.addIssue({
        code: "custom",
        path: ["transformSamples", badTransformIndex, "frame"],
        message: "transform sample frames must be strictly increasing",
      });
    }
    const badFovIndex = strictlyIncreasingFrames(entity.fovSamples ?? []);
    if (badFovIndex >= 0) {
      context.addIssue({
        code: "custom",
        path: ["fovSamples", badFovIndex, "frame"],
        message: "fov sample frames must be strictly increasing",
      });
    }
    if (entity.entityType !== "camera" && entity.fovSamples?.length) {
      context.addIssue({
        code: "custom",
        path: ["entityType"],
        message: "fov samples are a camera-only channel",
      });
    }
  });

/** One baked entity track (object or camera). */
export type DirectorGodotBakedEntity = z.infer<typeof directorGodotBakedEntitySchema>;

/**
 * The Godot animation bake sidecar. Written by the Gateway into the private
 * job directory, hash-pinned through the `--animation-sha256` argument, and
 * verified again by the connector before any track is keyed.
 */
export const directorGodotAnimationBakeSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_GODOT_ANIMATION_BAKE_CONTRACT),
    schemaVersion: z.literal(1),
    packageId: z.string().uuid(),
    provider: z.literal("godot"),
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    /** Transforms are canonical Director-space; Godot's basis is the identity map. */
    coordinateSystem: directorDccCanonicalReturnCoordinateSystemSchema,
    timebase: directorGodotAnimationTimebaseSchema,
    playback: z
      .strictObject({
        frameStart: z.number().int().min(-1_000_000).max(75_000_000_000),
        frameEnd: z.number().int().min(-1_000_000).max(75_000_000_000),
      })
      .refine((playback) => playback.frameEnd >= playback.frameStart, {
        message: "frameEnd must be at or after frameStart",
        path: ["frameEnd"],
      }),
    /** Sampling stride in frames; 1 unless the sample budget forced downsampling. */
    frameStride: z.number().int().positive().max(1_000),
    entities: z.array(directorGodotBakedEntitySchema).max(2_048),
    /**
     * Storyboard shot ranges clamped into the playback window and sorted by
     * `frameStart`, for the connector's `Camera3D.current` camera-cut track.
     */
    shots: z.array(directorGodotShotRangeSchema).max(512).optional(),
    warnings: z.array(z.string().max(2_000)).max(2_000),
  })
  .superRefine((bake, context) => {
    const seen = new Set<string>();
    bake.entities.forEach((entity, index) => {
      if (seen.has(entity.directorId)) {
        context.addIssue({
          code: "custom",
          path: ["entities", index, "directorId"],
          message: `duplicate baked entity ${entity.directorId}`,
        });
      }
      seen.add(entity.directorId);
    });
    const seenShots = new Set<string>();
    (bake.shots ?? []).forEach((shot, index) => {
      if (seenShots.has(shot.shotId)) {
        context.addIssue({
          code: "custom",
          path: ["shots", index, "shotId"],
          message: `duplicate shot ${shot.shotId}`,
        });
      }
      seenShots.add(shot.shotId);
      const previous = bake.shots![index - 1];
      if (previous && shot.frameStart < previous.frameStart) {
        context.addIssue({
          code: "custom",
          path: ["shots", index, "frameStart"],
          message: "shots must be sorted by frameStart",
        });
      }
    });
  });

/** A validated Godot animation bake sidecar. */
export type DirectorGodotAnimationBake = z.infer<typeof directorGodotAnimationBakeSchema>;

const rationalRateStringSchema = z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/);

/**
 * The Godot import receipt the connector embeds in its engine report. All
 * values are read back from the saved scene and authored animation resources,
 * so the receipt proves what was built, not what was requested.
 */
export const directorGodotImportReceiptSchema = z.strictObject({
  /** `res://` path of the AnimationPlayer's owning scene, when animation was keyed. */
  animationPlayerPath: z.string().trim().min(1).max(1_024).nullable(),
  /** Name of the AnimationLibrary that holds the Director timeline animation. */
  animationLibrary: z.string().trim().max(120).nullable(),
  /** Rational display rate applied when converting frames to seconds, e.g. `24000/1001`. */
  displayRate: rationalRateStringSchema.nullable(),
  /** Total animation keys written across all tracks. */
  bakedKeyCount: z.number().int().nonnegative().max(100_000_000),
  /** Number of transform (position/rotation/scale) track triples keyed on director_id nodes. */
  transformTrackCount: z.number().int().nonnegative().max(100_000),
  /** Number of camera fov property tracks keyed. */
  fovTrackCount: z.number().int().nonnegative().max(100_000),
  /** Discrete `Camera3D.current` camera-cut value tracks keyed from storyboard shots. */
  shotCutTrackCount: z.number().int().nonnegative().max(100_000),
  /** Storyboard shots that produced a camera-cut key (unmappable shots warn-and-omit). */
  mappedShotCount: z.number().int().nonnegative().max(100_000),
  /** glTF payload animations preserved from GLB assets (AnimationPlayer count). */
  payloadAnimationPlayerCount: z.number().int().nonnegative().max(100_000),
  /** Skinned payloads whose Skeleton3D was found, tagged, and left in bind pose. */
  importedSkeletonCount: z.number().int().nonnegative().max(100_000),
  /** Lights imported as OmniLight3D/SpotLight3D/DirectionalLight3D nodes. */
  importedLightCount: z.number().int().nonnegative().max(100_000),
  /** Whether an ambient/hemisphere light was baked into a WorldEnvironment ambient term. */
  worldEnvironmentAmbient: z.boolean(),
  /**
   * WorldEnvironment nodes counted by re-scanning the built scene (readback,
   * not the import loop's intent). At most one is ever built per import.
   */
  worldEnvironmentCount: z.number().int().nonnegative().max(100),
  /** Lights omitted with a structured warn-and-omit code (rect-area, duplicate ambient, …). */
  omittedLightCount: z.number().int().nonnegative().max(100_000),
  /** Director PBR materials applied to imported payload meshes. */
  appliedMaterialCount: z.number().int().nonnegative().max(100_000),
  /** Payload textures externalized to hashed `res://director/textures/` resources. */
  externalizedTextureCount: z.number().int().nonnegative().max(100_000),
});

/** A validated Godot import receipt embedded in the engine report. */
export type DirectorGodotImportReceipt = z.infer<typeof directorGodotImportReceiptSchema>;

/**
 * The health JSON line the fixed Godot headless entry prints in `--mode
 * health`. The Gateway parses and validates this line as the last step of the
 * Godot readiness probe: `nativeReady` requires connector source, a Godot 4
 * executable, the configured project with the enabled addon, and this health
 * JSON to all check out.
 */
export const directorGodotConnectorHealthSchema = z.strictObject({
  ok: z.literal(true),
  provider: z.literal("godot"),
  hostVersion: z.string().trim().min(1).max(200),
  connectorVersion: nonEmpty.max(60),
});

/** A validated Godot connector health line. */
export type DirectorGodotConnectorHealth = z.infer<typeof directorGodotConnectorHealthSchema>;
