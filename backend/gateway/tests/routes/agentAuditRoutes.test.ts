// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentAuditRoute } from "../../routes/agentAuditRoutes";
import { ToolInvocationAuditStore } from "../../agents/toolInvocationAuditStore";
import { directorGatewayRequestAuthorized, requiresDirectorGatewayAuth } from "../../gatewayAuth";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seededStore() {
  const dataDirectory = await mkdtemp(resolve(tmpdir(), "director-audit-route-"));
  temporaryRoots.push(dataDirectory);
  const store = new ToolInvocationAuditStore(dataDirectory);
  const base = {
    operation: "observe",
    role: null,
    revision_before: null,
    revision_after: null,
    idempotency_key: null,
    outcome: "succeeded" as const,
    http_status: 200,
    error_code: null,
    error: null,
  };
  store.record({ ...base, source: "cli", tool: "director_workbench", session_id: "cli-default" });
  store.record({ ...base, source: "mcp", tool: "blender_native", session_id: "mcp-1-a" });
  store.record({
    ...base,
    source: "http",
    tool: "director_workbench",
    session_id: "http-default",
    outcome: "rejected",
    http_status: 403,
    error_code: "tool_policy_rejected",
    error: "visual-critic is not allowed to execute director_workbench with this operation",
  });
  await store.flush();
  return store;
}

function harness(store: ToolInvocationAuditStore) {
  const writes: Array<{ status: number; body: unknown }> = [];
  return {
    writes,
    dependencies: {
      json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
      store,
    },
    response: { end: vi.fn() } as unknown as ServerResponse,
  };
}

describe("agent audit route", () => {
  it("is covered by the standard gateway authorization gate", () => {
    const url = new URL("http://127.0.0.1:8787/api/agent/audit");
    const request = { method: "GET", headers: {} } as IncomingMessage;
    expect(requiresDirectorGatewayAuth(request, url)).toBe(true);
    expect(directorGatewayRequestAuthorized(request, url, "gateway-secret-000000000000", "preview-secret")).toBe(false);
  });

  it("lists newest-first and filters by source, session, and tool", async () => {
    const store = await seededStore();
    const context = harness(store);

    const handled = await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit"),
      context.dependencies,
    );
    expect(handled).toBe(true);
    const listing = context.writes.at(-1)?.body as { success: boolean; records: Array<Record<string, unknown>> };
    expect(context.writes.at(-1)?.status).toBe(200);
    expect(listing.success).toBe(true);
    expect(listing.records.map((record) => record.source)).toEqual(["http", "mcp", "cli"]);
    expect(listing.records[0]).toMatchObject({ outcome: "rejected", error_code: "tool_policy_rejected" });

    await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit?source=cli"),
      context.dependencies,
    );
    const bySource = context.writes.at(-1)?.body as { records: Array<Record<string, unknown>> };
    expect(bySource.records).toHaveLength(1);
    expect(bySource.records[0]).toMatchObject({ session_id: "cli-default" });

    await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit?session_id=mcp-1-a&tool=blender_native&limit=1"),
      context.dependencies,
    );
    const bySession = context.writes.at(-1)?.body as { records: Array<Record<string, unknown>> };
    expect(bySession.records).toHaveLength(1);
    expect(bySession.records[0]).toMatchObject({ source: "mcp", tool: "blender_native" });
  });

  it("pages older records with the after cursor", async () => {
    const store = await seededStore();
    const context = harness(store);

    await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit?limit=1"),
      context.dependencies,
    );
    const firstPage = context.writes.at(-1)?.body as {
      records: Array<{ id: string; source: string }>;
      next_after: string;
    };
    expect(firstPage.records[0]?.source).toBe("http");
    expect(firstPage.next_after).toBe(firstPage.records[0]?.id);

    await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL(`http://director.test/api/agent/audit?limit=1&after=${firstPage.next_after}`),
      context.dependencies,
    );
    const secondPage = context.writes.at(-1)?.body as { records: Array<{ source: string }> };
    expect(secondPage.records[0]?.source).toBe("mcp");
  });

  it("rejects writes and invalid queries", async () => {
    const store = await seededStore();
    const context = harness(store);

    await handleAgentAuditRoute(
      { method: "POST" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit"),
      context.dependencies,
    );
    expect(context.writes.at(-1)?.status).toBe(405);

    await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit?limit=9999"),
      context.dependencies,
    );
    expect(context.writes.at(-1)?.status).toBe(400);

    await handleAgentAuditRoute(
      { method: "GET" } as IncomingMessage,
      context.response,
      new URL("http://director.test/api/agent/audit?source=telepathy"),
      context.dependencies,
    );
    expect(context.writes.at(-1)?.status).toBe(400);
  });

  it("ignores other paths", async () => {
    const store = await seededStore();
    const context = harness(store);
    expect(
      await handleAgentAuditRoute(
        { method: "GET" } as IncomingMessage,
        context.response,
        new URL("http://director.test/api/agent/other"),
        context.dependencies,
      ),
    ).toBe(false);
  });
});
