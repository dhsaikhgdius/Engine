import { describe, expect, it, vi } from "vitest";
import { createGameSliceFromBrief, type GameSlice } from "../../../../packages/protocol/src/gameSliceProtocol";
import { createLiveStagePlaytestRunner } from "../../game/liveStagePlaytest";

const NOW = "2026-08-26T04:30:00.000Z";

function boundSlice(): GameSlice {
  const slice = createGameSliceFromBrief({
    id: "game-live-bridge-01",
    brief: { requirement: "Walk and interact.", genre: "exploration" },
    now: NOW,
  });
  return {
    ...slice,
    status: "bound",
    roles: slice.roles.map((role) => {
      if (role.id === "player") return { ...role, object_id: "hero-1" };
      if (role.id === "spawn") return { ...role, object_id: "spawn-1" };
      if (role.id === "objective-1") return { ...role, object_id: "stele-1" };
      return role;
    }),
  };
}

describe("liveStagePlaytest", () => {
  it("uses the live Stage receipt when the workbench returns a valid trace", async () => {
    const slice = boundSlice();
    const requestWorkbenchCommand = vi.fn().mockResolvedValue({
      success: true,
      result: {
        trace: {
          contract: "director-game-playtest-trace-v1",
          slice_id: slice.id,
          dt: 1 / 30,
          verbs_exercised: ["move"],
          samples: [
            {
              frame: 0,
              time_s: 0,
              position: [0, 0, 0],
              yaw: 0,
              velocity: [0, 0, 1],
              on_ground: true,
              flying: false,
              verb: "move",
              camera_clip: false,
              stuck: false,
            },
          ],
        },
      },
    });
    const runner = createLiveStagePlaytestRunner({ requestWorkbenchCommand });
    const trace = await runner!({
      slice,
      operation: {
        op: "playtest",
        slice_id: slice.id,
        script: { steps: [{ frames: 1, input: { forward: true } }] },
      },
    });
    expect(requestWorkbenchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ op: "game_playtest", actor_id: "hero-1", slice_id: slice.id }),
      expect.any(Number),
    );
    expect(trace.samples).toHaveLength(1);
    expect(trace.verbs_exercised).toContain("move");
  });

  it("falls back to host-free when no workbench client is connected", async () => {
    const slice = boundSlice();
    const runner = createLiveStagePlaytestRunner({
      requestWorkbenchCommand: vi.fn().mockResolvedValue(null),
    });
    const trace = await runner!({
      slice,
      operation: {
        op: "playtest",
        slice_id: slice.id,
        script: { steps: [{ frames: 12, input: { forward: true } }] },
      },
    });
    expect(trace.samples.length).toBe(12);
    expect(trace.samples.every((sample) => sample.on_ground)).toBe(true);
  });
});
