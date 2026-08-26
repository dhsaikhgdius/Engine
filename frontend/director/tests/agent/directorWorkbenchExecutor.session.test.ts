import { afterEach, describe, expect, it } from "vitest";
import {
  executeDirectorSessionWorkbenchOperation,
  executeDirectorWorkbenchOperation,
} from "../../src/agent/directorWorkbenchExecutor";
import {
  publishDirectorSessionCommandResult,
  subscribeDirectorSessionCommands,
  type DirectorSessionCommand,
} from "../../src/agent/directorSessionCommandBus";
import { createDefaultDirectorProject, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";

afterEach(() => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
});

describe("Director workbench player and pilot session ops", () => {
  it("rejects player and pilot on the sync executor and points at the session path", () => {
    const player = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "player",
      action: "enter",
    });
    expect(player).toMatchObject({
      success: false,
      error: expect.stringContaining("executeDirectorSessionWorkbenchOperation"),
    });

    const pilot = executeDirectorWorkbenchOperation(() => useDirectorStore.getState(), {
      op: "pilot",
      action: "start",
    });
    expect(pilot).toMatchObject({
      success: false,
      error: expect.stringContaining("executeDirectorSessionWorkbenchOperation"),
    });
  });

  it("delivers a player enter command through the live Stage session bus", async () => {
    const seen: DirectorSessionCommand[] = [];
    const unsubscribe = subscribeDirectorSessionCommands((command) => {
      seen.push(command);
      publishDirectorSessionCommandResult({
        requestId: command.requestId,
        ok: true,
        result: { actor_id: "char_default_a" },
      });
    });
    try {
      const result = await executeDirectorSessionWorkbenchOperation({
        op: "player",
        action: "enter",
        actor_id: "char_default_a",
      });
      expect(seen).toEqual([
        expect.objectContaining({
          surface: "player",
          command: { type: "enter", actor_id: "char_default_a" },
        }),
      ]);
      expect(result).toMatchObject({
        success: true,
        result: { surface: "player", action: "enter", actor_id: "char_default_a" },
      });
    } finally {
      unsubscribe();
    }
  });

  it("forwards actor_id on player teleport through the session bus", async () => {
    const seen: DirectorSessionCommand[] = [];
    const unsubscribe = subscribeDirectorSessionCommands((command) => {
      seen.push(command);
      publishDirectorSessionCommandResult({
        requestId: command.requestId,
        ok: true,
        result: { actor_id: "char_default_a", position: [1, 0, 2], mode: "teleport" },
      });
    });
    try {
      const result = await executeDirectorSessionWorkbenchOperation({
        op: "player",
        action: "teleport",
        actor_id: "char_default_a",
        position: [1, 0, 2],
      });
      expect(seen).toEqual([
        expect.objectContaining({
          surface: "player",
          command: { type: "teleport", actor_id: "char_default_a", position: [1, 0, 2] },
        }),
      ]);
      expect(result).toMatchObject({
        success: true,
        result: { surface: "player", action: "teleport", actor_id: "char_default_a" },
      });
    } finally {
      unsubscribe();
    }
  });

  it("requires position for pilot.set_view before dispatching", async () => {
    const result = await executeDirectorSessionWorkbenchOperation({
      op: "pilot",
      action: "set_view",
    });
    expect(result).toMatchObject({ success: false, error: "pilot.set_view requires position" });
  });

  it("fails closed when no Stage tab is subscribed for a session command", async () => {
    const result = await executeDirectorSessionWorkbenchOperation({
      op: "pilot",
      action: "stop",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No live Director Stage tab is subscribed/);
  });
});
