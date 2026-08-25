// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentToolAuditStore, recordAgentToolAuditSafely } from "../agentToolAuditStore";

const temporaryRoots: string[] = [];

async function temporaryDataDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-tool-audit-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent tool audit store", () => {
  it("records rejection and success entries with source tags and persists them atomically", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = new AgentToolAuditStore(dataDirectory);

    await store.record({
      tool: "director_workbench",
      operation: "author",
      role: "visual-critic",
      source: "cli",
      outcome: "rejected",
      code: "tool_policy_rejected",
      session_id: "cli-default",
    });
    await store.record({
      tool: "director_workbench",
      operation: "observe",
      role: "visual-critic",
      source: "mcp",
      outcome: "success",
      session_id: "mcp-session-1",
      revision_after: `director-project-revision:v1:sha256:${"a".repeat(64)}`,
    });

    const records = await store.list();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tool: "director_workbench",
      outcome: "rejected",
      source: "cli",
      role: "visual-critic",
      code: "tool_policy_rejected",
    });
    expect(records[1]).toMatchObject({ outcome: "success", source: "mcp" });
    expect(records[0]?.id).toBeTruthy();
    expect(Date.parse(records[0]?.timestamp ?? "")).not.toBeNaN();

    const persisted = JSON.parse(await readFile(join(dataDirectory, "agent-tool-audit.json"), "utf8")) as {
      version: number;
      records: unknown[];
    };
    expect(persisted.version).toBe(1);
    expect(persisted.records).toHaveLength(2);

    const reloaded = new AgentToolAuditStore(dataDirectory);
    expect(await reloaded.list()).toEqual(records);
  });

  it("reconstructs one session's tool chain across entry points by session_id", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = new AgentToolAuditStore(dataDirectory);
    const sessionId = "mcp-chain-session";

    await store.record({
      tool: "director_workbench",
      operation: "observe",
      source: "mcp",
      outcome: "success",
      session_id: sessionId,
    });
    await store.record({
      tool: "director_workbench",
      operation: "author",
      source: "mcp",
      outcome: "success",
      session_id: sessionId,
      idempotency_key: "agent-intent:chain-1",
    });
    await store.record({
      tool: "blender_native",
      operation: "apply",
      source: "cli",
      outcome: "rejected",
      session_id: "cli-default",
      code: "tool_policy_rejected",
    });
    await store.record({
      tool: "director_workbench",
      operation: "capture",
      source: "mcp",
      outcome: "error",
      session_id: sessionId,
      code: "capture_unavailable",
    });

    const chain = await store.list({ sessionId });
    expect(chain.map((record) => `${record.operation}:${record.outcome}`)).toEqual([
      "observe:success",
      "author:success",
      "capture:error",
    ]);
    expect(chain.every((record) => record.source === "mcp")).toBe(true);
  });

  it("caps retained records so the audit file cannot grow unbounded", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = new AgentToolAuditStore(dataDirectory, 5);
    for (let index = 0; index < 8; index += 1) {
      await store.record({ tool: "stage_read", operation: `op-${index}`, source: "http", outcome: "success" });
    }
    const records = await store.list();
    expect(records).toHaveLength(5);
    expect(records[0]?.operation).toBe("op-3");
    expect(records.at(-1)?.operation).toBe("op-7");
  });

  it("starts an empty trail from a corrupt audit file and skips invalid records", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await writeFile(join(dataDirectory, "agent-tool-audit.json"), "not json", "utf8");
    const corrupt = new AgentToolAuditStore(dataDirectory);
    expect(await corrupt.list()).toEqual([]);

    const partialDirectory = await temporaryDataDirectory();
    const valid = {
      id: "record-1",
      timestamp: new Date().toISOString(),
      tool: "director_workbench",
      role: null,
      source: "http",
      outcome: "success",
    };
    await writeFile(
      join(partialDirectory, "agent-tool-audit.json"),
      JSON.stringify({ version: 1, records: [valid, { bogus: true }] }),
      "utf8",
    );
    const partial = new AgentToolAuditStore(partialDirectory);
    expect(await partial.list()).toMatchObject([{ id: "record-1", tool: "director_workbench" }]);
  });

  it("rejects entries outside the closed outcome/source sets", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = new AgentToolAuditStore(dataDirectory);
    await expect(
      store.record({ tool: "director_workbench", source: "http", outcome: "exploded" as never }),
    ).rejects.toThrow();
    await expect(
      store.record({ tool: "director_workbench", source: "carrier-pigeon" as never, outcome: "success" }),
    ).rejects.toThrow();
  });

  it("never propagates audit write failures through the safe recorder", async () => {
    const failing = {
      record: () => Promise.reject(new Error("disk full")),
    } as unknown as AgentToolAuditStore;
    expect(() =>
      recordAgentToolAuditSafely(failing, { tool: "director_workbench", source: "http", outcome: "success" }),
    ).not.toThrow();
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  });
});
