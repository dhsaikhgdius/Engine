import { describe, expect, it } from "vitest";
import {
  BLENDER_LIVE_LINK_MAX_UPDATES_PER_FRAME,
  blenderLiveLinkFrameSchema,
  blenderLiveLinkPollSchema,
  createBlenderLiveLinkReplayGuard,
  type BlenderLiveLinkFrame,
} from "../src/blenderLiveLinkProtocol";
import { BLENDER_LIVE_CONTRACT } from "../src/blenderLiveProtocol";

/**
 * Adversarial stress tests for the preview-only live-link replay guard.
 * The invariant under attack: no matter how frames are duplicated,
 * reordered, gapped, or replayed across epochs, a consumer either applies a
 * contiguous run starting at cursor+1 or is forced into an explicit resync —
 * it can never silently desynchronize and the cursor can never move backward.
 */

const EPOCH_A = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const EPOCH_B = "1d1cf6cc-0b39-4f21-a2ad-05a3cbb0be51";

function frame(seq: number): BlenderLiveLinkFrame {
  return blenderLiveLinkFrameSchema.parse({
    seq,
    kind: "transform",
    revision: seq,
    frame: 0,
    objects: [
      {
        id: "obj-cube",
        position: [seq, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    cameras: [],
    lights: [],
  });
}

function poll(sceneEpoch: string, frames: BlenderLiveLinkFrame[], seq?: number) {
  return blenderLiveLinkPollSchema.parse({
    kind: "frames",
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch,
    seq: seq ?? frames.at(-1)?.seq ?? 0,
    frames,
  });
}

/** Deterministic PRNG so fuzz failures reproduce byte-for-byte. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("live-link replay guard fuzz: shuffled, duplicated, and gapped polls", () => {
  it("never applies out-of-order frames and never moves the cursor backward (256 seeded rounds)", () => {
    for (let seed = 1; seed <= 256; seed += 1) {
      const random = mulberry32(seed);
      const guard = createBlenderLiveLinkReplayGuard();
      guard.markSynced(EPOCH_A, 0);
      let cursor = 0;
      for (let round = 0; round < 8; round += 1) {
        // Build an adversarial poll: a window of frames around the cursor,
        // randomly shuffled, duplicated, and sometimes gapped.
        const start = Math.max(1, cursor - 2 + Math.floor(random() * 5));
        const length = 2 + Math.floor(random() * 6);
        const seqs = Array.from({ length }, (_, index) => start + index);
        if (random() < 0.3) seqs.splice(Math.floor(random() * seqs.length), 1);
        if (seqs.length && random() < 0.4) seqs.push(seqs[Math.floor(random() * seqs.length)]!);
        for (let index = seqs.length - 1; index > 0; index -= 1) {
          if (random() < 0.5) continue;
          const swap = Math.floor(random() * (index + 1));
          [seqs[index], seqs[swap]] = [seqs[swap]!, seqs[index]!];
        }
        const frames = seqs.map((seq) => frame(seq));
        const result = guard.accept(poll(EPOCH_A, frames, Math.max(...seqs, cursor)));

        const applied = result.apply.map((entry) => entry.seq);
        if (applied.length) {
          // Applied frames must be exactly contiguous from cursor + 1.
          expect(applied[0], `seed ${seed}`).toBe(cursor + 1);
          applied.forEach((seq, index) => {
            if (index > 0) expect(seq, `seed ${seed}`).toBe(applied[index - 1]! + 1);
          });
          expect(result.resyncRequired).toBe(false);
          cursor = applied[applied.length - 1]!;
        }
        expect(guard.cursor().seq, `seed ${seed}`).toBe(cursor);
        if (result.resyncRequired) {
          // Simulate the consumer reloading the authoritative snapshot.
          const resyncSeq = cursor + Math.floor(random() * 4);
          guard.markSynced(EPOCH_A, resyncSeq);
          cursor = resyncSeq;
        }
      }
    }
  });

  it("drops exact replays of already applied frames without moving the cursor", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, 0);
    const frames = [frame(1), frame(2), frame(3)];
    expect(guard.accept(poll(EPOCH_A, frames)).apply).toHaveLength(3);
    for (let replay = 0; replay < 32; replay += 1) {
      const result = guard.accept(poll(EPOCH_A, frames, 3));
      expect(result).toMatchObject({ apply: [], resyncRequired: false, reason: "no_new_frames", droppedReplays: 3 });
      expect(guard.cursor()).toEqual({ sceneEpoch: EPOCH_A, seq: 3 });
    }
  });

  it("forces a resync on every epoch flap and applies nothing from the stale epoch", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, 5);
    for (let round = 0; round < 16; round += 1) {
      const stale = guard.accept(poll(EPOCH_B, [frame(1)]));
      expect(stale).toMatchObject({ apply: [], resyncRequired: true, reason: "epoch_changed" });
      expect(guard.cursor()).toEqual({ sceneEpoch: EPOCH_A, seq: 5 });
    }
    guard.markSynced(EPOCH_B, 0);
    expect(guard.accept(poll(EPOCH_B, [frame(1)])).apply.map((entry) => entry.seq)).toEqual([1]);
  });

  it("survives a 1024-frame flood in order and rejects a 1025-frame poll at the schema", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, 0);
    const flood = Array.from({ length: 1_024 }, (_, index) => frame(index + 1));
    const result = guard.accept(poll(EPOCH_A, flood));
    expect(result.apply).toHaveLength(1_024);
    expect(guard.cursor().seq).toBe(1_024);

    const oversized = {
      kind: "frames",
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch: EPOCH_A,
      seq: 1_025,
      frames: Array.from({ length: 1_025 }, (_, index) => frame(index + 1)),
    };
    expect(blenderLiveLinkPollSchema.safeParse(oversized).success).toBe(false);
    expect(() => guard.accept(oversized as never)).toThrow();
  });

  it("keeps working at the safe-integer sequence boundary", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, Number.MAX_SAFE_INTEGER - 1);
    const result = guard.accept(poll(EPOCH_A, [frame(Number.MAX_SAFE_INTEGER)]));
    expect(result.apply.map((entry) => entry.seq)).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(guard.cursor().seq).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("live-link schema stress: hostile frame payloads", () => {
  it("rejects frames with more than the per-frame update cap", () => {
    const oversized = {
      seq: 1,
      kind: "transform",
      revision: 1,
      frame: 0,
      objects: Array.from({ length: BLENDER_LIVE_LINK_MAX_UPDATES_PER_FRAME + 1 }, (_, index) => ({
        id: `obj-${index}`,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      })),
      cameras: [],
      lights: [],
    };
    expect(blenderLiveLinkFrameSchema.safeParse(oversized).success).toBe(false);
  });

  it.each([
    ["negative seq", { seq: -1 }],
    ["fractional seq", { seq: 1.5 }],
    ["non-finite position", { objects: [{ id: "o", position: [Infinity, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] }],
    ["empty id", { objects: [{ id: "", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] }],
    ["overlong id", { objects: [{ id: "x".repeat(161), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }] }],
    ["unknown extra key", { smuggled: true }],
  ])("rejects a frame with %s", (_name, patch) => {
    const candidate = {
      seq: 1,
      kind: "transform",
      revision: 1,
      frame: 0,
      objects: [],
      cameras: [],
      lights: [],
      ...patch,
    };
    expect(blenderLiveLinkFrameSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects polls with a malformed epoch or an unknown resync reason", () => {
    expect(
      blenderLiveLinkPollSchema.safeParse({
        kind: "frames",
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch: "not-a-uuid",
        seq: 0,
        frames: [],
      }).success,
    ).toBe(false);
    expect(
      blenderLiveLinkPollSchema.safeParse({
        kind: "resync",
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch: EPOCH_A,
        seq: 0,
        reason: "because",
      }).success,
    ).toBe(false);
  });

  it("rejects markSynced with a malformed epoch or negative sequence", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    expect(() => guard.markSynced("not-a-uuid", 0)).toThrow();
    expect(() => guard.markSynced(EPOCH_A, -1)).toThrow();
    expect(() => guard.markSynced(EPOCH_A, 1.5)).toThrow();
    // A failed markSynced must not corrupt the cursor.
    expect(guard.cursor()).toEqual({ sceneEpoch: null, seq: 0 });
  });
});
