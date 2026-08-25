import { describe, expect, it, vi } from "vitest";
import {
  applyDirectorTargetQueueTiming,
  DirectorAgentTargetScheduler,
  executeDirectorAgentToolCalls,
  type DirectorAgentToolSchedulingMetric,
} from "../../agents/agentToolScheduler";

describe("executeDirectorAgentToolCalls", () => {
  it("runs bounded read windows around exclusive mutation barriers and preserves result order", async () => {
    const active = new Set<string>();
    const snapshots: string[][] = [];
    const metrics: DirectorAgentToolSchedulingMetric[] = [];
    const calls = [
      { name: "director_workbench", arguments: { op: "observe", id: "a" } },
      { name: "director_workbench", arguments: { op: "query_objects", id: "b" } },
      { name: "director_workbench", arguments: { op: "author", id: "write" } },
      { name: "stage_video", arguments: { op: "status", id: "c" } },
    ];

    const results = await executeDirectorAgentToolCalls(
      calls,
      async (call) => {
        const id = String((call.arguments as { id: string }).id);
        active.add(id);
        snapshots.push([...active].sort());
        await Promise.resolve();
        active.delete(id);
        return id;
      },
      2,
      (metric) => metrics.push(metric),
    );

    expect(results).toEqual(["a", "b", "write", "c"]);
    expect(snapshots).toContainEqual(["a", "b"]);
    expect(snapshots.find((snapshot) => snapshot.includes("write"))).toEqual(["write"]);
    expect(
      metrics
        .sort((left, right) => left.index - right.index)
        .map(({ index, tool, executionMode, windowSize, concurrencyLimit }) => ({
          index,
          tool,
          executionMode,
          windowSize,
          concurrencyLimit,
        })),
    ).toEqual([
      {
        index: 0,
        tool: "director_workbench",
        executionMode: "parallel",
        windowSize: 2,
        concurrencyLimit: 2,
      },
      {
        index: 1,
        tool: "director_workbench",
        executionMode: "parallel",
        windowSize: 2,
        concurrencyLimit: 2,
      },
      {
        index: 2,
        tool: "director_workbench",
        executionMode: "exclusive",
        windowSize: 1,
        concurrencyLimit: 2,
      },
      {
        index: 3,
        tool: "stage_video",
        executionMode: "parallel",
        windowSize: 1,
        concurrencyLimit: 2,
      },
    ]);
    metrics.forEach((metric) => {
      expect(metric.queueWaitMs).toBeGreaterThanOrEqual(0);
      expect(metric.executionMs).toBeGreaterThanOrEqual(0);
      expect(metric.elapsedMs).toBeGreaterThanOrEqual(metric.queueWaitMs);
    });
  });

  it("runs inspect and audit in the same read window as observe", async () => {
    const active = new Set<string>();
    const snapshots: string[][] = [];
    const results = await executeDirectorAgentToolCalls(
      [
        { name: "director_workbench", arguments: { op: "observe", id: "observe" } },
        { name: "director_workbench", arguments: { op: "inspect", id: "inspect" } },
        { name: "director_workbench", arguments: { op: "audit", id: "audit" } },
      ],
      async (call) => {
        const id = String((call.arguments as { id: string }).id);
        active.add(id);
        snapshots.push([...active].sort());
        await Promise.resolve();
        active.delete(id);
        return id;
      },
      3,
    );
    expect(results).toEqual(["observe", "inspect", "audit"]);
    expect(snapshots.some((snapshot) => snapshot.length > 1)).toBe(true);
  });

  it("separates Harness and target queue time from pure execution", () => {
    expect(
      applyDirectorTargetQueueTiming(
        {
          index: 0,
          tool: "director_workbench",
          executionMode: "exclusive",
          harnessQueueWaitMs: 10,
          queueWaitMs: 10,
          executionMs: 100,
          elapsedMs: 110,
          windowSize: 1,
          concurrencyLimit: 4,
        },
        30,
      ),
    ).toEqual({
      index: 0,
      tool: "director_workbench",
      executionMode: "exclusive",
      harnessQueueWaitMs: 10,
      targetQueueWaitMs: 30,
      queueWaitMs: 40,
      executionMs: 70,
      elapsedMs: 110,
      windowSize: 1,
      concurrencyLimit: 4,
    });
  });
});

describe("DirectorAgentTargetScheduler", () => {
  it("reports the time a lease spent waiting for its target", async () => {
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(150)
      .mockReturnValueOnce(230);
    try {
      const scheduler = new DirectorAgentTargetScheduler(1);
      const blocker = await scheduler.acquire("target-a", "exclusive");
      const waiting = scheduler.acquire("target-a", "parallel");
      blocker.release();
      const lease = await waiting;

      expect(lease.queueWaitMs).toBe(80);
      lease.release();
    } finally {
      clock.mockRestore();
    }
  });

  it("runs same-target reads concurrently up to the configured limit", async () => {
    const scheduler = new DirectorAgentTargetScheduler(2);
    const first = await scheduler.acquire("target-a", "parallel");
    const second = await scheduler.acquire("target-a", "parallel");
    let thirdStarted = false;
    const thirdPromise = scheduler.acquire("target-a", "parallel").then((lease) => {
      thirdStarted = true;
      return lease;
    });

    await Promise.resolve();
    expect(thirdStarted).toBe(false);

    first.release();
    const third = await thirdPromise;
    expect(thirdStarted).toBe(true);

    second.release();
    third.release();
  });

  it("preserves an exclusive mutation barrier across sessions targeting the same scene", async () => {
    const scheduler = new DirectorAgentTargetScheduler(4);
    const events: string[] = [];
    const firstRead = await scheduler.acquire("target-a", "parallel");
    const writerPromise = scheduler.acquire("target-a", "exclusive").then((lease) => {
      events.push("writer");
      return lease;
    });
    const laterReadPromise = scheduler.acquire("target-a", "parallel").then((lease) => {
      events.push("later-read");
      return lease;
    });

    await Promise.resolve();
    expect(events).toEqual([]);

    firstRead.release();
    const writer = await writerPromise;
    expect(events).toEqual(["writer"]);

    writer.release();
    const laterRead = await laterReadPromise;
    expect(events).toEqual(["writer", "later-read"]);
    laterRead.release();
  });

  it("does not dispatch a queued call after cancellation", async () => {
    const scheduler = new DirectorAgentTargetScheduler(1);
    const writer = await scheduler.acquire("target-a", "exclusive");
    const controller = new AbortController();
    const queued = scheduler.acquire("target-a", "parallel", controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    await rejected;
    writer.release();

    const next = await scheduler.acquire("target-a", "parallel");
    next.release();
  });

  it("keeps independent targets isolated", async () => {
    const scheduler = new DirectorAgentTargetScheduler(1);
    const firstTargetWriter = await scheduler.acquire("target-a", "exclusive");
    const secondTargetRead = await scheduler.acquire("target-b", "parallel");

    secondTargetRead.release();
    firstTargetWriter.release();
  });
});
