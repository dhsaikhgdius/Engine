import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  blenderLiveLinkFrameSchema,
  blenderLiveLinkPollSchema,
  createBlenderLiveLinkReplayGuard,
  type BlenderLiveLinkFrame,
} from "../../../../packages/protocol/src/blenderLiveLinkProtocol";
import { blenderLiveHealthSchema, BLENDER_LIVE_CONTRACT } from "../../../../packages/protocol/src/blenderLiveProtocol";
import { createBlenderNativeSession } from "../../dcc/blenderNativeSession";

const execFileAsync = promisify(execFile);
const EPOCH_A = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";
const EPOCH_B = "1d1cf6cc-0b39-4f21-a2ad-05a3cbb0be51";
const kernelTestFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../integrations/blender/live/addons/worldengine_studio/tests/test_live_link.py",
);

function transformFrame(seq: number, patch: Partial<BlenderLiveLinkFrame> = {}): BlenderLiveLinkFrame {
  return blenderLiveLinkFrameSchema.parse({
    seq,
    kind: "transform",
    revision: seq,
    frame: 0,
    objects: [
      {
        id: "obj-cube",
        directorId: "director-cube",
        position: [seq, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    cameras: [],
    lights: [],
    ...patch,
  });
}

function framesPoll(sceneEpoch: string, frames: BlenderLiveLinkFrame[], seq?: number) {
  return blenderLiveLinkPollSchema.parse({
    kind: "frames",
    contract: BLENDER_LIVE_CONTRACT,
    sceneEpoch,
    seq: seq ?? frames.at(-1)?.seq ?? 0,
    frames,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Blender live-link protocol", () => {
  it("rejects structure frames that smuggle entity updates", () => {
    const invalid = blenderLiveLinkFrameSchema.safeParse({
      ...transformFrame(1),
      kind: "structure",
    });
    expect(invalid.success).toBe(false);
    expect(
      blenderLiveLinkFrameSchema.safeParse({
        seq: 1,
        kind: "structure",
        revision: 1,
        frame: 0,
        objects: [],
        cameras: [],
        lights: [],
      }).success,
    ).toBe(true);
  });

  it("accepts the kernel health stanza and keeps it optional for older kernels", () => {
    const base = {
      ok: true,
      contract: BLENDER_LIVE_CONTRACT,
      sceneEpoch: EPOCH_A,
      blenderVersion: "5.1.2",
      revision: 2,
      busy: false,
    };
    expect(blenderLiveHealthSchema.safeParse(base).success).toBe(true);
    const withLiveLink = blenderLiveHealthSchema.parse({
      ...base,
      liveLink: { seq: 12, bufferedFrames: 4, capacity: 128 },
    });
    expect(withLiveLink.liveLink).toEqual({ seq: 12, bufferedFrames: 4, capacity: 128 });
    expect(
      blenderLiveHealthSchema.safeParse({ ...base, liveLink: { seq: -1, bufferedFrames: 0, capacity: 128 } }).success,
    ).toBe(false);
  });
});

describe("Blender live-link replay guard", () => {
  it("forces an initial resync before any frame is applied", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    const result = guard.accept(framesPoll(EPOCH_A, [transformFrame(1)]));
    expect(result).toMatchObject({ apply: [], resyncRequired: true, reason: "initial" });
    expect(guard.cursor()).toEqual({ sceneEpoch: null, seq: 0 });
  });

  it("applies contiguous frames and drops replayed duplicates", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, 1);
    const result = guard.accept(framesPoll(EPOCH_A, [transformFrame(1), transformFrame(2), transformFrame(3)]));
    expect(result.resyncRequired).toBe(false);
    expect(result.reason).toBe("ok");
    expect(result.droppedReplays).toBe(1);
    expect(result.apply.map((frame) => frame.seq)).toEqual([2, 3]);
    expect(guard.cursor()).toEqual({ sceneEpoch: EPOCH_A, seq: 3 });

    const replayed = guard.accept(framesPoll(EPOCH_A, [transformFrame(2), transformFrame(3)], 3));
    expect(replayed).toMatchObject({ apply: [], resyncRequired: false, reason: "no_new_frames", droppedReplays: 2 });
    expect(guard.cursor()).toEqual({ sceneEpoch: EPOCH_A, seq: 3 });
  });

  it("resyncs on sequence gaps instead of silently desynchronizing", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, 1);
    const gapped = guard.accept(framesPoll(EPOCH_A, [transformFrame(3), transformFrame(4)]));
    expect(gapped).toMatchObject({ apply: [], resyncRequired: true, reason: "sequence_gap" });
    // The cursor is unchanged; the consumer reloads the snapshot and re-syncs.
    expect(guard.cursor()).toEqual({ sceneEpoch: EPOCH_A, seq: 1 });
  });

  it("resyncs when the scene epoch changes or the kernel reports eviction", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_A, 5);
    expect(guard.accept(framesPoll(EPOCH_B, [transformFrame(1)]))).toMatchObject({
      resyncRequired: true,
      reason: "epoch_changed",
    });
    expect(
      guard.accept(
        blenderLiveLinkPollSchema.parse({
          kind: "resync",
          contract: BLENDER_LIVE_CONTRACT,
          sceneEpoch: EPOCH_A,
          seq: 40,
          reason: "history_evicted",
        }),
      ),
    ).toMatchObject({ apply: [], resyncRequired: true, reason: "history_evicted" });
  });

  it("resumes cleanly after a resync via markSynced", () => {
    const guard = createBlenderLiveLinkReplayGuard();
    guard.markSynced(EPOCH_B, 40);
    const result = guard.accept(framesPoll(EPOCH_B, [transformFrame(41)]));
    expect(result.apply.map((frame) => frame.seq)).toEqual([41]);
    expect(guard.cursor()).toEqual({ sceneEpoch: EPOCH_B, seq: 41 });
  });
});

describe("Blender native session live-link client", () => {
  it("polls without a cursor and parses a resync directive", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        kind: "resync",
        contract: BLENDER_LIVE_CONTRACT,
        sceneEpoch: EPOCH_A,
        seq: 7,
        reason: "initial",
      }),
    );
    const session = createBlenderNativeSession({ fetcher, token: "secret" });
    await expect(session.liveLink()).resolves.toMatchObject({ kind: "resync", reason: "initial", seq: 7 });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8791/v1/live-link",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
  });

  it("polls with an epoch/sequence cursor and parses contiguous frames", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(framesPoll(EPOCH_A, [transformFrame(3)])),
    );
    const session = createBlenderNativeSession({ fetcher });
    const poll = await session.liveLink({ sceneEpoch: EPOCH_A, since: 2 });
    expect(poll.kind).toBe("frames");
    expect(fetcher).toHaveBeenCalledWith(
      `http://127.0.0.1:8791/v1/live-link?epoch=${EPOCH_A}&since=2`,
      expect.anything(),
    );
  });

  it("rejects malformed poll payloads instead of passing them through", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ kind: "frames", contract: BLENDER_LIVE_CONTRACT, sceneEpoch: EPOCH_A, seq: -1, frames: [] }),
    );
    const session = createBlenderNativeSession({ fetcher });
    await expect(session.liveLink()).rejects.toThrow(/contract mismatch/i);
  });
});

describe("Blender live kernel live-link buffer (host-free Python)", () => {
  it("passes its unittest suite without Blender installed", async () => {
    const { stderr } = await execFileAsync("python3", [kernelTestFile]);
    expect(stderr).toContain("OK");
  }, 30_000);
});
