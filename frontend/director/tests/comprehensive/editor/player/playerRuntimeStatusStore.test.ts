import { describe, expect, it, vi } from "vitest";
import { createPlayerRuntimeStatusStore } from "../../../../src/comprehensive/editor/player/playerRuntimeStatusStore";
import type { PlayerRuntimeStatus } from "../../../../src/comprehensive/editor/player/playerLocomotion";

function statusAt(x: number): PlayerRuntimeStatus {
  return {
    aiming: false,
    cameraDistance: 4,
    cameraObstructed: false,
    cameraPosition: [x, 2, 4],
    emoteClipId: null,
    playerPosition: [x, 0, 0],
    playerVisible: true,
    targetPosition: [x, 1, 0],
    viewMode: "third",
  };
}

describe("player runtime status store", () => {
  it("publishes roam telemetry only to local subscribers", () => {
    const store = createPlayerRuntimeStatusStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = statusAt(1);

    store.publish(first);
    expect(store.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledOnce();

    store.publish(first);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    store.publish(statusAt(2));
    expect(listener).toHaveBeenCalledOnce();
  });
});
