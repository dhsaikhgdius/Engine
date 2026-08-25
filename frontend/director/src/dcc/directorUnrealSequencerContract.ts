import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../comprehensive/editor/schema/directorProjectRevision";
import { directorDccCanonicalReturnCoordinateSystemSchema } from "./directorDccReturnContract";
import { directorDccTransformSchema } from "./directorDccSharedContract";

/**
 * Contract identifier for the Unreal Sequencer bake sidecar the Gateway writes
 * next to a headless Unreal job. The sidecar carries time-sampled canonical
 * Director-space transforms (plus camera optics) so the Unreal connector can
 * key LevelSequence tracks without re-implementing Director's animation
 * evaluators (easing curves, trajectories, camera path/follow actions).
 */
export const DIRECTOR_UNREAL_SEQUENCER_BAKE_CONTRACT = "director-unreal-sequencer-bake-v1" as const;

const nonEmpty = z.string().trim().min(1);

/** SMPTE timecode string, `HH:MM:SS:FF` (non-drop) or `HH:MM:SS;FF` (drop-frame). */
export const directorUnrealTimecodeSchema = z.string().regex(/^\d{2}:\d{2}:\d{2}[:;]\d{2}$/);

/** A rational frame rate (for example 24000/1001 for 23.976 fps). */
export const directorUnrealRationalRateSchema = z.strictObject({
  numerator: z.number().int().positive().max(1_000_000),
  denominator: z.number().int().positive().max(1_000_000),
});

/** Rational frame rate carried by the Sequencer bake. */
export type DirectorUnrealRationalRate = z.infer<typeof directorUnrealRationalRateSchema>;

/**
 * The timebase the connector must apply to the LevelSequence: rational display
 * rate, drop-frame flag, and the SMPTE timecode assigned to Director frame 0.
 */
export const directorUnrealSequencerTimebaseSchema = z.strictObject({
  rate: directorUnrealRationalRateSchema,
  dropFrame: z.boolean(),
  startTimecode: directorUnrealTimecodeSchema,
});

/** Sequencer timebase (rational rate + drop frame + start timecode). */
export type DirectorUnrealSequencerTimebase = z.infer<typeof directorUnrealSequencerTimebaseSchema>;

/** One baked transform sample: a Director timeline frame plus a canonical-space world transform. */
export const directorUnrealTransformSampleSchema = z.strictObject({
  frame: z.number().int().min(-1_000_000).max(75_000_000_000),
  transform: directorDccTransformSchema,
});

/** A baked transform sample at one Director timeline frame. */
export type DirectorUnrealTransformSample = z.infer<typeof directorUnrealTransformSampleSchema>;

/** One baked camera optics sample: focal length in millimetres at a Director timeline frame. */
export const directorUnrealFocalLengthSampleSchema = z.strictObject({
  frame: z.number().int().min(-1_000_000).max(75_000_000_000),
  focalLengthMm: z.number().finite().positive().max(10_000),
});

/** A baked camera focal-length sample at one Director timeline frame. */
export type DirectorUnrealFocalLengthSample = z.infer<typeof directorUnrealFocalLengthSampleSchema>;

function strictlyIncreasingFrames(samples: ReadonlyArray<{ frame: number }>) {
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]!.frame <= samples[index - 1]!.frame) return index;
  }
  return -1;
}

/**
 * One baked entity track. Transforms are Director canonical-space world
 * transforms (right-handed, Y-up, metres); the connector converts them to
 * Unreal space with the pinned `director_space` basis change at key time.
 */
export const directorUnrealBakedEntitySchema = z
  .strictObject({
    directorId: nonEmpty.max(200),
    entityType: z.enum(["object", "camera"]),
    name: z.string().max(240),
    transformSamples: z.array(directorUnrealTransformSampleSchema).min(1).max(100_000),
    /** Camera-only: per-frame focal length derived from Director's vertical fov keys. */
    focalLengthSamples: z.array(directorUnrealFocalLengthSampleSchema).max(100_000).optional(),
    /** Camera-only: physical filmback the focal lengths were derived against. */
    filmback: z
      .strictObject({
        sensorWidthMm: z.number().finite().positive().max(1_000),
        sensorHeightMm: z.number().finite().positive().max(1_000),
      })
      .optional(),
    /** Channels present in the source animation that the bake could not carry (warn-and-omit). */
    omittedChannels: z.array(z.enum(["pose_values", "motion_blocks", "character_rig"])).max(8).optional(),
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
    const badFocalIndex = strictlyIncreasingFrames(entity.focalLengthSamples ?? []);
    if (badFocalIndex >= 0) {
      context.addIssue({
        code: "custom",
        path: ["focalLengthSamples", badFocalIndex, "frame"],
        message: "focal length sample frames must be strictly increasing",
      });
    }
    if (entity.entityType !== "camera" && (entity.focalLengthSamples?.length || entity.filmback)) {
      context.addIssue({
        code: "custom",
        path: ["entityType"],
        message: "focal length samples and filmback are camera-only channels",
      });
    }
  });

/** One baked entity track (object or camera). */
export type DirectorUnrealBakedEntity = z.infer<typeof directorUnrealBakedEntitySchema>;

/**
 * The Unreal Sequencer bake sidecar. Written by the Gateway into the private
 * job directory, hash-pinned through the `--animation-sha256` argument, and
 * validated again by the connector before any track is keyed.
 */
export const directorUnrealSequencerBakeSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_UNREAL_SEQUENCER_BAKE_CONTRACT),
    schemaVersion: z.literal(1),
    packageId: z.string().uuid(),
    provider: z.literal("unreal"),
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    /** Transforms are canonical Director-space; the connector owns the basis change. */
    coordinateSystem: directorDccCanonicalReturnCoordinateSystemSchema,
    timebase: directorUnrealSequencerTimebaseSchema,
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
    entities: z.array(directorUnrealBakedEntitySchema).max(2_048),
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
  });

/** A validated Unreal Sequencer bake sidecar. */
export type DirectorUnrealSequencerBake = z.infer<typeof directorUnrealSequencerBakeSchema>;

const rationalRateStringSchema = z.string().regex(/^[1-9]\d{0,6}\/[1-9]\d{0,6}$/);

/**
 * The Sequencer receipt the Unreal connector embeds in its engine report after
 * building the LevelSequence. All values are read back from the sequence asset
 * so the receipt proves what was authored, not what was requested.
 */
export const directorUnrealSequencerReceiptSchema = z.strictObject({
  /** Content path of the LevelSequence asset (for example `/Game/Director/Sequences/...`). */
  sequencePath: nonEmpty.max(1_024),
  /** Rational display rate applied to the sequence, e.g. `24000/1001`. */
  displayRate: rationalRateStringSchema,
  /** Rational tick resolution applied to the sequence, e.g. `24000/1`. */
  tickResolution: rationalRateStringSchema,
  dropFrame: z.boolean(),
  startTimecode: directorUnrealTimecodeSchema,
  /** The start timecode converted to a frame offset at the display rate. */
  startFrameOffset: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  playbackStart: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  playbackEnd: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  cameraCutCount: z.number().int().nonnegative().max(100_000),
  transformTrackCount: z.number().int().nonnegative().max(100_000),
  focalLengthTrackCount: z.number().int().nonnegative().max(100_000),
  bakedKeyCount: z.number().int().nonnegative().max(100_000_000),
});

/** A validated Unreal Sequencer receipt embedded in the engine report. */
export type DirectorUnrealSequencerReceipt = z.infer<typeof directorUnrealSequencerReceiptSchema>;
