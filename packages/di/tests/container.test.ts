// @director/di — unit tests

import { describe, it, expect } from "vitest";
import { Container, loadPlugin, loadPlugins } from "../src/container";

describe("Container", () => {
  it("registers and resolves a singleton", async () => {
    const ctx = new Container();
    ctx.singleton("greeting", () => "hello");
    const result = await ctx.resolve<string>("greeting");
    expect(result).toBe("hello");
  });

  it("caches singleton instances", async () => {
    const ctx = new Container();
    let calls = 0;
    ctx.singleton("counter", () => ++calls);
    const a = await ctx.resolve<number>("counter");
    const b = await ctx.resolve<number>("counter");
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it("creates new transient instances each time", async () => {
    const ctx = new Container();
    let calls = 0;
    ctx.transient("counter", () => ++calls);
    const a = await ctx.resolve<number>("counter");
    const b = await ctx.resolve<number>("counter");
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("registers a constant value", async () => {
    const ctx = new Container();
    ctx.constant("pi", 3.14);
    expect(await ctx.resolve<number>("pi")).toBe(3.14);
  });

  it("throws for unregistered token", async () => {
    const ctx = new Container();
    await expect(ctx.resolve("nope")).rejects.toThrow("not registered");
  });

  it("throws on duplicate registration", () => {
    const ctx = new Container();
    ctx.singleton("a", () => 1);
    expect(() => ctx.singleton("a", () => 2)).toThrow("already registered");
  });

  it("detects circular dependencies", async () => {
    const ctx = new Container();
    ctx.singleton("a", async (c) => {
      await c.resolve("b");
      return "a";
    });
    ctx.singleton("b", async (c) => {
      await c.resolve("a");
      return "b";
    });
    await expect(ctx.resolve("a")).rejects.toThrow("Circular dependency");
  });

  it("sync get returns cached singleton", async () => {
    const ctx = new Container();
    ctx.singleton("x", () => 42);
    await ctx.resolve("x");
    expect(ctx.get<number>("x")).toBe(42);
  });

  it("sync get throws for unresolved service", () => {
    const ctx = new Container();
    ctx.singleton("x", () => 42);
    expect(() => ctx.get("x")).toThrow("not been resolved");
  });

  it("tryResolve returns undefined for unregistered", async () => {
    const ctx = new Container();
    expect(await ctx.tryResolve("nope")).toBeUndefined();
  });

  it("lists registered tokens", () => {
    const ctx = new Container();
    ctx.singleton("a", () => 1);
    ctx.singleton("b", () => 2);
    expect(ctx.list()).toContain("a");
    expect(ctx.list()).toContain("b");
  });

  it("finds by tag", () => {
    const ctx = new Container();
    ctx.register({ token: "db", factory: () => "pg", lifecycle: "singleton", tags: ["database"] });
    ctx.register({ token: "cache", factory: () => "redis", lifecycle: "singleton", tags: ["database"] });
    ctx.register({ token: "http", factory: () => "express", lifecycle: "singleton", tags: ["server"] });
    expect(ctx.findByTag("database")).toEqual(["db", "cache"]);
    expect(ctx.findByTag("server")).toEqual(["http"]);
  });

  it("fires onResolved hooks", async () => {
    const ctx = new Container();
    const fired: string[] = [];
    ctx.singleton("x", () => 42);
    ctx.onResolved("x", (v) => fired.push(`got ${v}`));
    await ctx.resolve("x");
    expect(fired).toEqual(["got 42"]);
  });

  it("disposes disposable services", async () => {
    const ctx = new Container();
    const disposed: string[] = [];
    ctx.singleton("a", () => ({
      dispose: () => { disposed.push("a"); },
    }));
    ctx.singleton("b", () => ({
      // Not disposable
    }));
    await ctx.resolve("a");
    await ctx.resolve("b");
    await ctx.dispose();
    expect(disposed).toEqual(["a"]);
  });

  it("throws on resolve after dispose", async () => {
    const ctx = new Container();
    ctx.singleton("x", () => 1);
    await ctx.dispose();
    await expect(ctx.resolve("x")).rejects.toThrow("disposed");
  });
});

describe("Plugin loading", () => {
  it("loads a plugin function", async () => {
    const ctx = new Container();
    await loadPlugin(ctx, (c) => {
      c.singleton("hello", () => "world");
    });
    expect(await ctx.resolve<string>("hello")).toBe("world");
  });

  it("loads a plugin module", async () => {
    const ctx = new Container();
    await loadPlugin(ctx, {
      default: (c) => {
        c.singleton("hello", () => "world");
      },
      meta: { name: "test", version: "1.0.0" },
    });
    expect(await ctx.resolve<string>("hello")).toBe("world");
  });

  it("loads multiple plugins in order", async () => {
    const ctx = new Container();
    await loadPlugins(ctx, [
      (c) => {
        c.singleton("a", () => 1);
      },
      (c) => {
        c.singleton("b", () => 2);
      },
    ]);
    expect(await ctx.resolve<number>("a")).toBe(1);
    expect(await ctx.resolve<number>("b")).toBe(2);
  });

  it("throws for invalid plugin module", async () => {
    const ctx = new Container();
    await expect(loadPlugin(ctx, {} as any)).rejects.toThrow("Invalid plugin");
  });
});

describe("resolveAll", () => {
  it("resolves multiple services in parallel", async () => {
    const ctx = new Container();
    ctx.singleton("a", () => 1);
    ctx.singleton("b", () => 2);
    const [a, b] = await ctx.resolveAll("a", "b");
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});