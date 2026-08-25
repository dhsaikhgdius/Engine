// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkspaceStore } from "../../agents/agentWorkspaceStore";
import { handleAgentWorkspaceRoute } from "../../routes/agentWorkspaceRoutes";

const openStores: AgentWorkspaceStore[] = [];

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  }
  openStores.length = 0;
});

function harness(nowMs = { value: 1_700_000_000_000 }) {
  const store = new AgentWorkspaceStore("/unused", { path: ":memory:", now: () => nowMs.value });
  openStores.push(store);
  const writes: Array<{ status: number; body: unknown }> = [];
  let requestBody: unknown = {};
  const dependencies = {
    readBody: async () => requestBody,
    json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
    store,
  };
  return {
    store,
    writes,
    dependencies,
    nowMs,
    setBody(body: unknown) {
      requestBody = body;
    },
    response: {} as ServerResponse,
  };
}

const request = (method: string) => ({ method }) as IncomingMessage;
const url = (pathnameAndQuery: string) => new URL(`http://127.0.0.1:8787${pathnameAndQuery}`);

describe("agent workspace routes", () => {
  it("ignores unrelated paths", async () => {
    const context = harness();
    expect(
      await handleAgentWorkspaceRoute(
        request("GET"),
        context.response,
        url("/api/agent/profiles"),
        context.dependencies,
      ),
    ).toBe(false);
    expect(context.writes).toHaveLength(0);
  });

  it("saves a document and lists version history", async () => {
    const context = harness();
    context.setBody({ scope: "org", kind: "instructions", content: "先 observe 再 mutate" });
    await handleAgentWorkspaceRoute(
      request("PUT"),
      context.response,
      url("/api/agent/workspace/document"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 200 });
    expect((context.writes[0]?.body as { document: { version: number } }).document.version).toBe(1);

    await handleAgentWorkspaceRoute(
      request("GET"),
      context.response,
      url("/api/agent/workspace/document/versions?scope=org&kind=instructions"),
      context.dependencies,
    );
    const versions = (context.writes[1]?.body as { versions: unknown[] }).versions;
    expect(versions).toHaveLength(1);
  });

  it("rejects invalid document payloads", async () => {
    const context = harness();
    context.setBody({ scope: "team", kind: "instructions", content: "x" });
    await handleAgentWorkspaceRoute(
      request("PUT"),
      context.response,
      url("/api/agent/workspace/document"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("restores a version and 404s unknown versions", async () => {
    const context = harness();
    context.store.saveDocument("user", "instructions", "v1");
    context.store.saveDocument("user", "instructions", "v2");
    context.setBody({ scope: "user", kind: "instructions", version: 1 });
    await handleAgentWorkspaceRoute(
      request("POST"),
      context.response,
      url("/api/agent/workspace/document/restore"),
      context.dependencies,
    );
    expect((context.writes[0]?.body as { document: { content: string; version: number } }).document).toMatchObject({
      content: "v1",
      version: 3,
    });

    context.setBody({ scope: "user", kind: "instructions", version: 42 });
    await handleAgentWorkspaceRoute(
      request("POST"),
      context.response,
      url("/api/agent/workspace/document/restore"),
      context.dependencies,
    );
    expect(context.writes[1]).toMatchObject({ status: 404, body: { code: "version_not_found" } });
  });

  it("manages memory entries with TTL through the HTTP surface", async () => {
    const context = harness();
    context.setBody({ scope: "user", key: "pref", value: { theme: "dark" }, ttl_seconds: 60 });
    await handleAgentWorkspaceRoute(
      request("PUT"),
      context.response,
      url("/api/agent/workspace/memory"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 200 });

    context.nowMs.value += 61_000;
    await handleAgentWorkspaceRoute(
      request("GET"),
      context.response,
      url("/api/agent/workspace"),
      context.dependencies,
    );
    const workspace = (context.writes[1]?.body as { workspace: { memory: unknown[] } }).workspace;
    expect(workspace.memory).toHaveLength(0);
  });

  it("round-trips the export/import bundle over HTTP", async () => {
    const context = harness();
    context.store.saveDocument("org", "instructions", "团队指令");
    context.store.setMemory("user", "pref", "dark");
    await handleAgentWorkspaceRoute(
      request("GET"),
      context.response,
      url("/api/agent/workspace/export"),
      context.dependencies,
    );
    const bundle = context.writes[0]?.body;

    const cloned = harness();
    cloned.setBody(bundle);
    await handleAgentWorkspaceRoute(
      request("POST"),
      cloned.response,
      url("/api/agent/workspace/import"),
      cloned.dependencies,
    );
    expect(cloned.writes[0]?.status).toBe(200);
    const workspace = (
      cloned.writes[0]?.body as {
        workspace: { documents: { scope: string; kind: string; content: string }[]; memory: { key: string }[] };
      }
    ).workspace;
    expect(workspace.documents.find((d) => d.scope === "org" && d.kind === "instructions")?.content).toBe("团队指令");
    expect(workspace.memory.map((entry) => entry.key)).toEqual(["pref"]);
  });

  it("rejects malformed bundles", async () => {
    const context = harness();
    context.setBody({ format: "wrong", version: 1 });
    await handleAgentWorkspaceRoute(
      request("POST"),
      context.response,
      url("/api/agent/workspace/import"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("serves the merged prompt and keeps memory out of it", async () => {
    const context = harness();
    context.store.saveDocument("org", "instructions", "团队级指令内容");
    context.store.setMemory("user", "hidden", "NEVER-IN-PROMPT");
    await handleAgentWorkspaceRoute(
      request("GET"),
      context.response,
      url(`/api/agent/workspace/prompt?session_override=${encodeURIComponent("会话覆盖")}`),
      context.dependencies,
    );
    const body = context.writes[0]?.body as { prompt: string; merge_order: string[] };
    expect(context.writes[0]?.status).toBe(200);
    expect(body.prompt).toContain("团队级指令内容");
    expect(body.prompt).toContain("会话覆盖");
    expect(body.prompt).not.toContain("NEVER-IN-PROMPT");
    expect(body.merge_order).toEqual(["repo_skills", "workspace_org", "workspace_user", "session_override"]);
  });

  it("404s unknown workspace endpoints", async () => {
    const context = harness();
    await handleAgentWorkspaceRoute(
      request("GET"),
      context.response,
      url("/api/agent/workspace/unknown"),
      context.dependencies,
    );
    expect(context.writes[0]).toMatchObject({ status: 404, body: { code: "not_found" } });
  });
});
