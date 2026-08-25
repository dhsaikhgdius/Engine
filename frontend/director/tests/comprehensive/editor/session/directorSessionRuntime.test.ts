import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDirectorSessionRuntime,
  resetDirectorSessionRuntime,
  subscribeDirectorSessionRuntime,
  updateDirectorSessionRuntime,
} from "../../../../src/comprehensive/editor/session/directorSessionRuntime";

afterEach(() => resetDirectorSessionRuntime());

describe("directorSessionRuntime", () => {
  it("publishes authoritative scene identity and revision without persisting UI state", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDirectorSessionRuntime(listener);

    updateDirectorSessionRuntime({
      instanceId: "node-7",
      sceneId: "shot-a",
      revision: 12,
      comfyui: "connected",
    });

    expect(getDirectorSessionRuntime()).toMatchObject({
      instanceId: "node-7",
      sceneId: "shot-a",
      revision: 12,
      dirty: false,
      comfyui: "connected",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    updateDirectorSessionRuntime({ revision: 12 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("clears connection and revision state between iframe sessions", () => {
    updateDirectorSessionRuntime({
      sceneId: "shot-b",
      revision: 3,
      dirty: true,
      gateway: "connected",
      mcp: "connected",
      codex: "ready",
    });
    resetDirectorSessionRuntime();

    expect(getDirectorSessionRuntime()).toEqual({
      instanceId: "",
      sceneId: "",
      revision: null,
      dirty: false,
      conflict: null,
      comfyui: "disconnected",
      gateway: "disconnected",
      mcp: "disconnected",
      codex: "unknown",
    });
  });
});
