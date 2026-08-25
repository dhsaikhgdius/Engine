import { describe, expect, it } from "vitest";
import { RefSessionRegistry } from "../../refSessions";

describe("ref session registry", () => {
  it("keeps refs in a live session and expires inactive sessions", () => {
    let now = 0;
    const registry = new RefSessionRegistry({ ttlMs: 100, now: () => now });
    registry.get("agent-a").set("hero", "human-1");
    now = 99;
    expect(registry.get("agent-a").get("hero")).toBe("human-1");
    now = 200;
    expect(registry.get("agent-a").has("hero")).toBe(false);
  });

  it("caps sessions using least-recently-used order", () => {
    let now = 0;
    const registry = new RefSessionRegistry({ ttlMs: 1_000, maxSessions: 2, now: () => now });
    registry.get("a").set("ref", "a-id");
    now += 1;
    registry.get("b").set("ref", "b-id");
    now += 1;
    registry.get("a");
    now += 1;
    registry.get("c");
    expect(registry.get("a").get("ref")).toBe("a-id");
    expect(registry.get("b").has("ref")).toBe(false);
    expect(registry.size).toBe(2);
  });
});
