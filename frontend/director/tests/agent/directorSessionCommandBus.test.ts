import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directorPlayerScriptTimeoutMs,
  dispatchDirectorSessionCommand,
  publishDirectorSessionCommandResult,
  subscribeDirectorSessionCommands,
  type DirectorSessionCommand,
} from "../../src/agent/directorSessionCommandBus";

afterEach(() => {
  vi.useRealTimers();
});

describe("directorSessionCommandBus", () => {
  it("fails closed when no Stage tab is subscribed", async () => {
    const result = await dispatchDirectorSessionCommand({
      surface: "player",
      command: { type: "exit" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No live Director Stage tab is subscribed/);
  });

  it("delivers a player command to the subscriber and resolves the published receipt", async () => {
    const seen: DirectorSessionCommand[] = [];
    const unsubscribe = subscribeDirectorSessionCommands((command) => {
      seen.push(command);
      publishDirectorSessionCommandResult({
        requestId: command.requestId,
        ok: true,
        result: { entered: true },
      });
    });

    try {
      const result = await dispatchDirectorSessionCommand({
        surface: "player",
        command: { type: "enter", actor_id: "char_default_a" },
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        surface: "player",
        command: { type: "enter", actor_id: "char_default_a" },
      });
      expect(result).toMatchObject({
        ok: true,
        result: { entered: true },
      });
    } finally {
      unsubscribe();
    }
  });

  it("delivers a play_script tape command and sizes its dispatch timeout from the tape", async () => {
    const script = {
      dt: 1 / 30,
      steps: [{ frames: 60, input: { forward: true } }],
    };
    const seen: DirectorSessionCommand[] = [];
    const unsubscribe = subscribeDirectorSessionCommands((command) => {
      seen.push(command);
      publishDirectorSessionCommandResult({
        requestId: command.requestId,
        ok: true,
        result: { sample_count: 60 },
      });
    });

    try {
      const result = await dispatchDirectorSessionCommand(
        {
          surface: "player",
          command: { type: "play_script", script, actor_id: "char_default_a", slice_id: "game-live-playtest" },
        },
        directorPlayerScriptTimeoutMs(script),
      );

      expect(seen[0]).toMatchObject({
        surface: "player",
        command: { type: "play_script", actor_id: "char_default_a", slice_id: "game-live-playtest" },
      });
      expect(result).toMatchObject({ ok: true, result: { sample_count: 60 } });
      // 60 frames at 1/30 s = 2 s simulated; tripled plus entry grace.
      expect(directorPlayerScriptTimeoutMs(script)).toBe(14_000);
    } finally {
      unsubscribe();
    }
  });

  it("times out when a subscribed Stage tab never publishes a receipt", async () => {
    vi.useFakeTimers();
    const unsubscribe = subscribeDirectorSessionCommands(() => {
      // Intentionally ignore the envelope so the dispatcher must time out.
    });

    try {
      const pending = dispatchDirectorSessionCommand(
        {
          surface: "pilot",
          command: { type: "start", camera_id: "cam_1" },
        },
        25,
      );
      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No live Director Stage tab handled this session command/);
    } finally {
      unsubscribe();
    }
  });
});
