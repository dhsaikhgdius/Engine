// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentToolAuditStore } from "../../agentToolAuditStore";
import { handleAgentToolAuditRoute } from "../../routes/agentToolAuditRoutes";

const temporaryRoots: string[] = [];

async function temporaryStore() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-audit-route-"));
  temporaryRoots.push(directory);
  return new AgentToolAuditStore(directory);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function harness(store: AgentToolAuditStore, body: unknown = null) {
  const writes: Array<{ status: number; body: unknown }> = [];
  return {
    writes,
    dependencies: {
      readBody: vi.fn().mockResolvedValue(body),
      json: (_response: ServerResponse, status: number, responseBody: unknown) =>
        writes.push({ status, body: responseBody }),
      store,
    },
    request: (method: string) => ({ method, headers: {} }) as IncomingMessage,
    response: () => ({ end: vi.fn() }) as unknown as ServerResponse,
  };
}

describe("agent tool audit routes", () => {
  it("ignores unrelated paths", async () => {
    const context = harness(await temporaryStore());
    const handled = await handleAgentToolAuditRoute(
      context.request("GET"),
      context.response(),
      new URL("http://director.test/api/agent/elsewhere"),
      context.dependencies,
    );
    expect(handled).toBe(false);
  });

  it("ingests one UI-dispatched authoring record and lists it back", async () => {
    const store = await temporaryStore();
    const post = harness(store, {
      tool: "director_workbench",
      operation: "author",
      source: "ui",
      role: null,
      outcome: "success",
      idempotency_key: "ui-author:abc",
      revision_before: "revision-1",
      revision_after: "revision-2",
    });

    const handled = await handleAgentToolAuditRoute(
      post.request("POST"),
      post.response(),
      new URL("http://director.test/api/agent/tool-audit"),
      post.dependencies,
    );
    expect(handled).toBe(true);
    expect(post.writes.at(-1)).toMatchObject({ status: 201, body: { success: true } });

    const get = harness(store);
    await handleAgentToolAuditRoute(
      get.request("GET"),
      get.response(),
      new URL("http://director.test/api/agent/tool-audit"),
      get.dependencies,
    );
    expect(get.writes.at(-1)).toMatchObject({
      status: 200,
      body: {
        success: true,
        result: {
          records: [
            {
              tool: "director_workbench",
              operation: "author",
              source: "ui",
              outcome: "success",
              revision_before: "revision-1",
              revision_after: "revision-2",
            },
          ],
        },
      },
    });
  });

  it("filters listed records by session_id and honours the limit", async () => {
    const store = await temporaryStore();
    await store.record({
      tool: "director_workbench",
      operation: "observe",
      source: "mcp",
      outcome: "success",
      session_id: "mcp-a",
    });
    await store.record({
      tool: "director_workbench",
      operation: "author",
      source: "mcp",
      outcome: "success",
      session_id: "mcp-a",
    });
    await store.record({
      tool: "blender_native",
      operation: "status",
      source: "cli",
      outcome: "success",
      session_id: "cli-default",
    });

    const context = harness(store);
    await handleAgentToolAuditRoute(
      context.request("GET"),
      context.response(),
      new URL("http://director.test/api/agent/tool-audit?session_id=mcp-a&limit=1"),
      context.dependencies,
    );
    const body = context.writes.at(-1)?.body as { result: { records: Array<Record<string, unknown>> } };
    expect(body.result.records).toHaveLength(1);
    expect(body.result.records[0]).toMatchObject({ operation: "author", session_id: "mcp-a" });
  });

  it("rejects malformed ingest records with 400 and refuses raw tool inputs", async () => {
    const store = await temporaryStore();
    const invalidOutcome = harness(store, {
      tool: "director_workbench",
      source: "ui",
      outcome: "detonated",
    });
    await handleAgentToolAuditRoute(
      invalidOutcome.request("POST"),
      invalidOutcome.response(),
      new URL("http://director.test/api/agent/tool-audit"),
      invalidOutcome.dependencies,
    );
    expect(invalidOutcome.writes.at(-1)).toMatchObject({
      status: 400,
      body: { success: false, code: "invalid_audit_record" },
    });

    const withRawInput = harness(store, {
      tool: "director_workbench",
      source: "ui",
      outcome: "success",
      input: { api_key: "sk-secret" },
    });
    await handleAgentToolAuditRoute(
      withRawInput.request("POST"),
      withRawInput.response(),
      new URL("http://director.test/api/agent/tool-audit"),
      withRawInput.dependencies,
    );
    expect(withRawInput.writes.at(-1)).toMatchObject({ status: 400, body: { code: "invalid_audit_record" } });
    expect(await store.list()).toEqual([]);
  });

  it("answers 405 for unsupported methods", async () => {
    const context = harness(await temporaryStore());
    await handleAgentToolAuditRoute(
      context.request("DELETE"),
      context.response(),
      new URL("http://director.test/api/agent/tool-audit"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 405, body: { success: false } });
  });
});
