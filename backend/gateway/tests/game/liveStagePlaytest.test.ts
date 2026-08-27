import { describe, expect, it, vi } from "vitest";
import {
  createGameSliceFromBrief,
  gamePlaytestScriptSchema,
  type GameSlice,
} from "../../../../packages/protocol/src/gameSliceProtocol";
import { hostFreePlaytestTimeoutMs } from "../../../../packages/protocol/src/gamePlaytestHostFree";
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
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 1, input: { forward: true } }] }),
      },
    });
    expect(requestWorkbenchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ op: "game_playtest", actor_id: "hero-1", slice_id: slice.id }),
      expect.any(Number),
    );
    expect(trace.samples).toHaveLength(1);
    expect(trace.verbs_exercised).toContain("move");
    // The tab receipt did not stamp a source; the Gateway bridge is the
    // authority and labels everything relayed from a live tab `live_stage`.
    expect(trace.source).toBe("live_stage");
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
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 12, input: { forward: true } }] }),
      },
    });
    expect(trace.samples.length).toBe(12);
    expect(trace.samples.every((sample) => sample.on_ground)).toBe(true);
    expect(trace.source).toBe("host_free");
  });

  it("falls back to host-free when the live tab returns a malformed trace", async () => {
    const slice = boundSlice();
    const malformedResults = [
      // Wrong contract literal.
      { trace: { contract: "not-a-playtest-trace", slice_id: slice.id, dt: 1 / 30, samples: [] } },
      // Samples missing required fields.
      {
        trace: {
          contract: "director-game-playtest-trace-v1",
          slice_id: slice.id,
          dt: 1 / 30,
          samples: [{ frame: 0 }],
        },
      },
      // Not an object at all.
      "compiled ok",
      // Success with no result payload.
      undefined,
    ];
    for (const result of malformedResults) {
      const requestWorkbenchCommand = vi.fn().mockResolvedValue({ success: true, result });
      const runner = createLiveStagePlaytestRunner({ requestWorkbenchCommand });
      const trace = await runner!({
        slice,
        operation: {
          op: "playtest",
          slice_id: slice.id,
          script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 6, input: { forward: true } }] }),
        },
      });
      // The malformed live receipt is discarded; the host-free kinematic
      // runner still produces a scoreable trace for the same tape, and its
      // provenance honestly reports the fallback rather than the live tab.
      expect(requestWorkbenchCommand).toHaveBeenCalledTimes(1);
      expect(trace.contract).toBe("director-game-playtest-trace-v1");
      expect(trace.slice_id).toBe(slice.id);
      expect(trace.samples).toHaveLength(6);
      expect(trace.source).toBe("host_free");
    }
  });

  it("cannot be spoofed by a tab receipt that claims a non-live source", async () => {
    const slice = boundSlice();
    const requestWorkbenchCommand = vi.fn().mockResolvedValue({
      success: true,
      result: {
        trace: {
          contract: "director-game-playtest-trace-v1",
          slice_id: slice.id,
          dt: 1 / 30,
          verbs_exercised: ["move"],
          source: "inline",
          samples: [
            { frame: 0, time_s: 0, position: [0, 0, 0], yaw: 0, velocity: [0, 0, 1], on_ground: true, verb: "move" },
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
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 1, input: { forward: true } }] }),
      },
    });
    expect(trace.source).toBe("live_stage");
  });

  it("falls back to host-free when the live dispatch throws (e.g. command timeout)", async () => {
    const slice = boundSlice();
    const requestWorkbenchCommand = vi
      .fn()
      .mockRejectedValue(new Error('workbench command "game_playtest" timed out after 12000 ms and was cancelled.'));
    const runner = createLiveStagePlaytestRunner({ requestWorkbenchCommand });
    const trace = await runner!({
      slice,
      operation: {
        op: "playtest",
        slice_id: slice.id,
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 10, input: { forward: true } }] }),
      },
    });
    expect(requestWorkbenchCommand).toHaveBeenCalledTimes(1);
    expect(trace.samples).toHaveLength(10);
    // The degradation stays visible on the receipt instead of a hard failure.
    expect(trace.source).toBe("host_free");
  });

  it("falls back to host-free when the live tape fails on the tab", async () => {
    const slice = boundSlice();
    const requestWorkbenchCommand = vi.fn().mockResolvedValue({
      success: false,
      error: "player session rejected play_script: actor not found",
    });
    const runner = createLiveStagePlaytestRunner({ requestWorkbenchCommand });
    const trace = await runner!({
      slice,
      operation: {
        op: "playtest",
        slice_id: slice.id,
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 8, input: { forward: true } }] }),
      },
    });
    expect(trace.samples).toHaveLength(8);
    expect(trace.verbs_exercised).toContain("move");
  });

  it("restamps a live trace whose slice_id disagrees with the stored slice", async () => {
    const slice = boundSlice();
    const requestWorkbenchCommand = vi.fn().mockResolvedValue({
      success: true,
      result: {
        trace: {
          contract: "director-game-playtest-trace-v1",
          slice_id: "game-playtest-session",
          dt: 1 / 30,
          verbs_exercised: ["move"],
          samples: [
            { frame: 0, time_s: 0, position: [0, 0, 0], yaw: 0, velocity: [0, 0, 1], on_ground: true, verb: "move" },
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
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 1, input: { forward: true } }] }),
      },
    });
    expect(trace.slice_id).toBe(slice.id);
    expect(trace.samples).toHaveLength(1);
  });

  it("omits actor_id when the player role has no bound object id", async () => {
    const slice = createGameSliceFromBrief({
      id: "game-live-bridge-02",
      brief: { requirement: "Walk and interact.", genre: "exploration" },
      now: NOW,
    });
    const requestWorkbenchCommand = vi.fn().mockResolvedValue(null);
    const runner = createLiveStagePlaytestRunner({ requestWorkbenchCommand });
    await runner!({
      slice,
      operation: {
        op: "playtest",
        slice_id: slice.id,
        script: gamePlaytestScriptSchema.parse({ steps: [{ frames: 1, input: { forward: true } }] }),
      },
    });
    const [command] = requestWorkbenchCommand.mock.calls[0]!;
    expect(command).not.toHaveProperty("actor_id");
    expect(command).toMatchObject({ op: "game_playtest", slice_id: slice.id });
  });

  it("budgets the live command timeout from the tape duration", async () => {
    const slice = boundSlice();
    const requestWorkbenchCommand = vi.fn().mockResolvedValue(null);
    const runner = createLiveStagePlaytestRunner({ requestWorkbenchCommand });
    const script = gamePlaytestScriptSchema.parse({
      dt: 1 / 30,
      steps: [
        { frames: 30, input: { forward: true } },
        { frames: 60, input: { look_right: true } },
      ],
    });
    await runner!({ slice, operation: { op: "playtest", slice_id: slice.id, script } });
    expect(hostFreePlaytestTimeoutMs(script)).toBe(17_000);
    // 90 frames at 1/30 s = 3 s simulated, tripled, plus 8 s session grace.
    expect(requestWorkbenchCommand).toHaveBeenCalledWith(expect.anything(), 17_000);
  });
});
