import { z } from "zod";
import { BLENDER_LIVE_CONTRACT } from "./blenderLiveProtocol";

/**
 * Blender live-link: a bounded, preview-only delta feed from the Blender
 * native live kernel to Director clients.
 *
 * Live-link frames are NEVER authoritative. They carry viewport-preview
 * deltas (object/camera/light transforms, camera lens, light energy) so a
 * Director client can mirror an in-progress Blender edit without waiting for
 * a full snapshot download. Committing state into Director always goes
 * through the reviewed return/import path (`director-dcc-return-v1`) or the
 * revision-guarded live command batches. Dropping the link, evicting frames,
 * or restarting Blender therefore leaves the last committed Director revision
 * intact by construction.
 *
 * Replay protection: every frame carries a per-scene-epoch monotonic sequence
 * number. Consumers keep an `(sceneEpoch, seq)` cursor; duplicate or reordered
 * frames (seq <= cursor) are dropped, a sequence gap or epoch change forces a
 * full resync from the authoritative snapshot before applying further deltas.
 */
export const BLENDER_LIVE_LINK_MAX_UPDATES_PER_FRAME = 512;

const finite = z.number().finite();
const identifier = z.string().trim().min(1).max(160);
const vec3 = z.tuple([finite, finite, finite]);
const sceneEpoch = z.string().uuid();
const sequence = z.number().int().nonnegative();

/** A transform-only preview update for one Blender object. */
export const blenderLiveLinkObjectUpdateSchema = z.strictObject({
  id: identifier,
  directorId: identifier.nullable().optional(),
  position: vec3,
  rotation: vec3,
  scale: vec3,
});

/** A preview update for one Blender camera (transform plus lens). */
export const blenderLiveLinkCameraUpdateSchema = z.strictObject({
  id: identifier,
  position: vec3,
  rotation: vec3,
  focalLengthMm: finite.positive(),
  active: z.boolean(),
});

/** A preview update for one Blender light (transform plus color/energy). */
export const blenderLiveLinkLightUpdateSchema = z.strictObject({
  id: identifier,
  position: vec3,
  rotation: vec3,
  color: vec3,
  energy: finite.nonnegative(),
});

/**
 * One live-link delta frame.
 *
 * `kind: "transform"` frames carry per-entity preview updates that can be
 * applied in order on top of the last synced snapshot. `kind: "structure"`
 * frames signal that something beyond bare transforms changed (created or
 * deleted datablocks, mesh/material edits, renames, or an oversized delta);
 * consumers must refetch the authoritative snapshot instead of patching.
 */
export const blenderLiveLinkFrameSchema = z
  .strictObject({
    seq: sequence,
    kind: z.enum(["transform", "structure"]),
    revision: z.number().int().nonnegative(),
    contentRevision: z.number().int().nonnegative().optional(),
    frame: z.number().int(),
    objects: z.array(blenderLiveLinkObjectUpdateSchema).max(BLENDER_LIVE_LINK_MAX_UPDATES_PER_FRAME),
    cameras: z.array(blenderLiveLinkCameraUpdateSchema).max(BLENDER_LIVE_LINK_MAX_UPDATES_PER_FRAME),
    lights: z.array(blenderLiveLinkLightUpdateSchema).max(BLENDER_LIVE_LINK_MAX_UPDATES_PER_FRAME),
  })
  .superRefine((frame, context) => {
    if (frame.kind === "structure" && (frame.objects.length || frame.cameras.length || frame.lights.length)) {
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "structure frames must not carry entity updates; consumers refetch the snapshot",
      });
    }
  });

/**
 * Poll response from `GET /v1/live-link`.
 *
 * `kind: "frames"` returns the contiguous frames after the requested cursor.
 * `kind: "resync"` tells the consumer its cursor cannot be served (first
 * contact, scene epoch changed, or buffered history was evicted); the
 * consumer must reload the authoritative snapshot, adopt `(sceneEpoch, seq)`
 * as its new cursor, and only then resume delta polling.
 */
export const blenderLiveLinkPollSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("frames"),
    contract: z.literal(BLENDER_LIVE_CONTRACT),
    sceneEpoch,
    seq: sequence,
    frames: z.array(blenderLiveLinkFrameSchema).max(1_024),
  }),
  z.strictObject({
    kind: z.literal("resync"),
    contract: z.literal(BLENDER_LIVE_CONTRACT),
    sceneEpoch,
    seq: sequence,
    reason: z.enum(["initial", "epoch_changed", "history_evicted"]),
  }),
]);

/** A parsed live-link object update. */
export type BlenderLiveLinkObjectUpdate = z.infer<typeof blenderLiveLinkObjectUpdateSchema>;
/** A parsed live-link camera update. */
export type BlenderLiveLinkCameraUpdate = z.infer<typeof blenderLiveLinkCameraUpdateSchema>;
/** A parsed live-link light update. */
export type BlenderLiveLinkLightUpdate = z.infer<typeof blenderLiveLinkLightUpdateSchema>;
/** A parsed live-link delta frame. */
export type BlenderLiveLinkFrame = z.infer<typeof blenderLiveLinkFrameSchema>;
/** A parsed live-link poll response. */
export type BlenderLiveLinkPoll = z.infer<typeof blenderLiveLinkPollSchema>;

/** The result of feeding one poll response through the replay guard. */
export interface BlenderLiveLinkGuardResult {
  /** Frames that are safe to apply, in order. Empty when a resync is required. */
  apply: BlenderLiveLinkFrame[];
  /** True when the consumer must reload the authoritative snapshot before continuing. */
  resyncRequired: boolean;
  /** Why a resync is required (or why frames were dropped). */
  reason: "ok" | "initial" | "epoch_changed" | "history_evicted" | "sequence_gap" | "no_new_frames";
  /** Number of duplicate/replayed frames dropped from this poll. */
  droppedReplays: number;
}

/** Cursor state tracked by the replay guard. */
export interface BlenderLiveLinkCursor {
  /** Scene epoch of the last synced snapshot, or null before first sync. */
  sceneEpoch: string | null;
  /** Highest applied (or synced) sequence number within the epoch. */
  seq: number;
}

/**
 * A host-free replay guard for live-link consumers.
 *
 * The guard tracks an `(sceneEpoch, seq)` cursor. `accept` classifies one
 * poll response: duplicate frames are dropped, out-of-order or gapped frames
 * force a resync, and epoch changes always force a resync. After the consumer
 * reloads the authoritative snapshot it must call `markSynced` with the
 * snapshot's epoch and the live-link seq so delta polling can resume.
 */
export interface BlenderLiveLinkReplayGuard {
  /** Classify one poll response and return the frames that are safe to apply. */
  accept(poll: BlenderLiveLinkPoll): BlenderLiveLinkGuardResult;
  /** Adopt a new cursor after the consumer reloaded the authoritative snapshot. */
  markSynced(sceneEpoch: string, seq: number): void;
  /** The current cursor. */
  cursor(): BlenderLiveLinkCursor;
}

/**
 * Creates a host-free live-link replay guard.
 *
 * @returns A guard with `accept`, `markSynced`, and `cursor`.
 */
export function createBlenderLiveLinkReplayGuard(): BlenderLiveLinkReplayGuard {
  let epoch: string | null = null;
  let seq = 0;

  return {
    accept(pollInput) {
      const poll = blenderLiveLinkPollSchema.parse(pollInput);
      if (poll.kind === "resync") {
        return { apply: [], resyncRequired: true, reason: poll.reason, droppedReplays: 0 };
      }
      if (epoch === null) {
        return { apply: [], resyncRequired: true, reason: "initial", droppedReplays: 0 };
      }
      if (poll.sceneEpoch !== epoch) {
        return { apply: [], resyncRequired: true, reason: "epoch_changed", droppedReplays: 0 };
      }
      const fresh = poll.frames.filter((frame) => frame.seq > seq);
      const droppedReplays = poll.frames.length - fresh.length;
      if (!fresh.length) {
        return { apply: [], resyncRequired: false, reason: "no_new_frames", droppedReplays };
      }
      const contiguous =
        fresh[0]!.seq === seq + 1 &&
        fresh.every((frame, index) => index === 0 || frame.seq === fresh[index - 1]!.seq + 1);
      if (!contiguous) {
        // A gap means deltas were lost (evicted or reordered in transit);
        // applying the remainder would silently desynchronize the preview.
        return { apply: [], resyncRequired: true, reason: "sequence_gap", droppedReplays };
      }
      seq = fresh[fresh.length - 1]!.seq;
      return { apply: fresh, resyncRequired: false, reason: "ok", droppedReplays };
    },
    markSynced(sceneEpochInput, seqInput) {
      // Validate both inputs before assigning either, so a rejected call
      // can never leave the cursor half-updated (epoch moved, seq stale).
      const parsedEpoch = sceneEpoch.parse(sceneEpochInput);
      const parsedSeq = sequence.parse(seqInput);
      epoch = parsedEpoch;
      seq = parsedSeq;
    },
    cursor() {
      return { sceneEpoch: epoch, seq };
    },
  };
}
