// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTraceStore, type AgentTraceEventInput } from "../../agents/agentTraceStore";

const cleanups: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "agent-trace-store-"));
  cleanups.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function eventInput(overrides: Partial<AgentTraceEventInput> = {}): AgentTraceEventInput {
  return {
    session_id: "mcp-session-1",
    source: "mcp",
    tool: "director_workbench",
    operation: "observe",
    outcome: "success",
    status_code: 200,
    started_at: "2026-08-25T10:00:00.000Z",
    duration_ms: 25,
    revision_before: null,
    revision_after: null,
    ...overrides,
  };
}

describe("AgentTraceStore", () => {
  it("records events, lists newest first, and filters by session/source/tool", async () => {
    const store = new AgentTraceStore();
    await store.record(eventInput({ operation: "observe" }));
    await store.record(eventInput({ operation: "author", started_at: "2026-08-25T10:00:01.000Z" }));
    await store.record(eventInput({ session_id: "cli-1", source: "cli", operation: "production.plan" }));

    const all = await store.list();
    expect(all.map((event) => event.operation)).toEqual(["production.plan", "author", "observe"]);
    expect(await store.list({ sessionId: "mcp-session-1" })).toHaveLength(2);
    expect(await store.list({ source: "cli" })).toHaveLength(1);
    expect(await store.list({ tool: "stage_video" })).toHaveLength(0);
  });

  it("redacts credential text in stored errors", async () => {
    const store = new AgentTraceStore();
    const event = await store.record(
      eventInput({ outcome: "error", status_code: 500, error: "upstream rejected api_key=sk-secret-value" }),
    );
    expect(event.error).not.toContain("sk-secret-value");
    expect(event.error).toContain("[REDACTED]");
  });

  it("keeps the buffer bounded to the configured limit", async () => {
    const store = new AgentTraceStore({ limit: 3 });
    for (let index = 0; index < 5; index += 1) {
      await store.record(eventInput({ operation: `op-${index}` }));
    }
    const events = await store.list({ limit: 10 });
    expect(events).toHaveLength(3);
    expect(events[0]?.operation).toBe("op-4");
  });

  it("compacts on-disk JSONL when the in-memory window trims", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new AgentTraceStore({ dataDirectory, limit: 3 });
    for (let index = 0; index < 8; index += 1) {
      await store.record(eventInput({ operation: `op-${index}` }));
    }
    await store.flush();
    const eventsFile = await readFile(join(dataDirectory, "agent-traces", "events.jsonl"), "utf8");
    const lines = eventsFile
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as { operation: string }).operation)).toEqual([
      "op-5",
      "op-6",
      "op-7",
    ]);
  });

  it("summarizes the most recent session by default", async () => {
    const store = new AgentTraceStore();
    await store.record(eventInput({ session_id: "first" }));
    await store.record(eventInput({ session_id: "second", operation: "author" }));
    const summary = await store.summarizeSession();
    expect(summary?.session_id).toBe("second");
    expect(summary?.chain.map((step) => step.operation)).toEqual(["author"]);
    expect(await store.summarizeSession("missing")).toBeNull();
  });

  it("persists events and usage to JSONL and reloads them across restarts", async () => {
    const dataDirectory = await temporaryDirectory();
    const first = new AgentTraceStore({ dataDirectory });
    await first.record(eventInput({ operation: "author", revision_before: "rev-1", revision_after: "rev-2" }));
    first.meter()({
      scope: "production-session-1",
      provider: "anthropic",
      model: "claude-x",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      duration_ms: 900,
      retries: 1,
      succeeded: true,
    });
    await first.flush();

    const eventsFile = await readFile(join(dataDirectory, "agent-traces", "events.jsonl"), "utf8");
    expect(eventsFile).toContain('"operation":"author"');

    const second = new AgentTraceStore({ dataDirectory });
    const summary = await second.summarizeSession("mcp-session-1");
    expect(summary?.revision_start).toBe("rev-1");
    expect(summary?.revision_end).toBe("rev-2");
    const usage = await second.listUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.total_tokens).toBe(15);
    expect(usage[0]?.retries).toBe(1);
  });

  it("skips corrupt JSONL lines without losing the valid history", async () => {
    const dataDirectory = await temporaryDirectory();
    const first = new AgentTraceStore({ dataDirectory });
    await first.record(eventInput());
    await first.flush();
    const path = join(dataDirectory, "agent-traces", "events.jsonl");
    const contents = await readFile(path, "utf8");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "not-json\n");
    expect(contents.trim()).not.toHaveLength(0);

    const second = new AgentTraceStore({ dataDirectory });
    expect(await second.list()).toHaveLength(1);
  });
});
