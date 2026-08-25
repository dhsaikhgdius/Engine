// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ToolInvocationAuditStore,
  buildToolInvocationAuditEntry,
  deriveToolInvocationSource,
  redactToolAuditText,
  toolInvocationOperation,
} from "../../agents/toolInvocationAuditStore";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDataDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-tool-audit-"));
  temporaryRoots.push(directory);
  return directory;
}

describe("tool invocation audit source", () => {
  it("derives the control surface from the session id conventions", () => {
    expect(deriveToolInvocationSource("browser-ui")).toBe("ui");
    expect(deriveToolInvocationSource("ui-panel-3")).toBe("ui");
    expect(deriveToolInvocationSource("mcp-123-abc")).toBe("mcp");
    expect(deriveToolInvocationSource("cli-default")).toBe("cli");
    expect(deriveToolInvocationSource("dsh-session-9")).toBe("dsh");
    expect(deriveToolInvocationSource("http-default")).toBe("http");
    expect(deriveToolInvocationSource("something-else")).toBe("unknown");
    expect(deriveToolInvocationSource(null)).toBe("unknown");
    expect(deriveToolInvocationSource("   ")).toBe("unknown");
  });
});

describe("tool invocation audit entry builder", () => {
  it("extracts operation, revisions, idempotency key, and outcome from a success", () => {
    const entry = buildToolInvocationAuditEntry({
      tool: "director_workbench",
      toolInput: { op: "author", action: "add_object" },
      sessionId: "cli-default",
      role: "stage-director",
      httpStatus: 200,
      body: {
        success: true,
        result: { project_revision: "revision-2" },
        agent_boundary: {
          guard: { mode: "revision", field: "expected_revision", source: "preflight_observe", value: "revision-1" },
          idempotency: { key: "agent-intent:abc", source: "generated", stable_retry: true },
        },
      },
    });

    expect(entry).toMatchObject({
      source: "cli",
      tool: "director_workbench",
      operation: "author.add_object",
      role: "stage-director",
      session_id: "cli-default",
      revision_before: "revision-1",
      revision_after: "revision-2",
      idempotency_key: "agent-intent:abc",
      outcome: "succeeded",
      http_status: 200,
      error_code: null,
      error: null,
    });
  });

  it("marks policy rejections and Blender receipts, and redacts error text", () => {
    const rejected = buildToolInvocationAuditEntry({
      tool: "blender_native",
      toolInput: { op: "apply", operations: [] },
      sessionId: "dsh-session",
      role: "visual-critic",
      httpStatus: 403,
      body: { success: false, code: "tool_policy_rejected", error: "visual-critic is not allowed" },
    });
    expect(rejected).toMatchObject({ source: "dsh", outcome: "rejected", error_code: "tool_policy_rejected" });

    const native = buildToolInvocationAuditEntry({
      tool: "blender_native",
      toolInput: { op: "apply", operations: [] },
      sessionId: "mcp-1-a",
      role: null,
      httpStatus: 200,
      body: { success: true, result: { receipt: { revisionBefore: 4, revisionAfter: 5 } } },
    });
    expect(native).toMatchObject({ source: "mcp", revision_before: "4", revision_after: "5", outcome: "succeeded" });

    const failed = buildToolInvocationAuditEntry({
      tool: "director_workbench",
      toolInput: { op: "capture" },
      sessionId: undefined,
      role: null,
      httpStatus: 400,
      body: {
        success: false,
        error: `capture failed api_key=super-secret data:image/png;base64,aGVsbG8= ${"x".repeat(600)}`,
      },
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.source).toBe("unknown");
    expect(failed.error).not.toContain("super-secret");
    expect(failed.error).not.toContain("aGVsbG8=");
    expect(failed.error?.length).toBeLessThanOrEqual(500);
  });

  it("extracts nested command and request operations plus caller idempotency keys", () => {
    expect(toolInvocationOperation({ op: "generation", command: { action: "submit" } })).toBe("generation.submit");
    expect(toolInvocationOperation({ op: "pipeline", request: { action: "start" } })).toBe("pipeline.start");
    expect(toolInvocationOperation({ op: "execute", operation: { op: "canvas.production.configure" } })).toBe(
      "execute.canvas.production.configure",
    );
    expect(toolInvocationOperation({ op: "observe" })).toBe("observe");
    expect(toolInvocationOperation({ prompt: "no op" })).toBeNull();

    const entry = buildToolInvocationAuditEntry({
      tool: "director_creative",
      toolInput: { op: "pipeline", request: { action: "start", idempotency_key: "caller-key-1" } },
      sessionId: "http-default",
      role: null,
      httpStatus: 200,
      body: { success: true },
    });
    expect(entry.idempotency_key).toBe("caller-key-1");
  });

  it("redacts credential-looking assignments while keeping surrounding text", () => {
    expect(redactToolAuditText("token: abc123 failed")).toBe("token=[redacted] failed");
    expect(redactToolAuditText("   ")).toBeNull();
    expect(redactToolAuditText(42)).toBeNull();
  });
});

describe("tool invocation audit store", () => {
  it("appends records to the JSONL trail and reloads them in a new instance", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = new ToolInvocationAuditStore(dataDirectory);
    const first = store.record({
      source: "cli",
      tool: "director_workbench",
      operation: "observe",
      role: null,
      session_id: "cli-default",
      revision_before: null,
      revision_after: null,
      idempotency_key: null,
      outcome: "succeeded",
      http_status: 200,
      error_code: null,
      error: null,
    });
    store.record({
      source: "http",
      tool: "blender_native",
      operation: "apply",
      role: "visual-critic",
      session_id: "http-default",
      revision_before: null,
      revision_after: null,
      idempotency_key: null,
      outcome: "rejected",
      http_status: 403,
      error_code: "tool_policy_rejected",
      error: "visual-critic is not allowed to execute blender_native with this operation",
    });
    await store.flush();

    const lines = (await readFile(store.filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: first.id, tool: "director_workbench" });

    const reloaded = new ToolInvocationAuditStore(dataDirectory);
    const listed = await reloaded.list();
    expect(listed.records.map((record) => record.tool)).toEqual(["blender_native", "director_workbench"]);
    expect(listed.next_after).toBeNull();
  });

  it("filters by session, source, and tool, and pages with the after cursor", async () => {
    const dataDirectory = await temporaryDataDirectory();
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
    store.record({ ...base, source: "mcp", tool: "director_workbench", session_id: "mcp-1-a" });
    store.record({ ...base, source: "cli", tool: "director_creative", session_id: "cli-default" });

    expect((await store.list({ source: "cli" })).records).toHaveLength(2);
    expect((await store.list({ tool: "director_creative" })).records).toHaveLength(1);
    expect((await store.list({ session_id: "mcp-1-a" })).records).toHaveLength(1);

    const firstPage = await store.list({ limit: 1 });
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.records[0]?.tool).toBe("director_creative");
    expect(firstPage.next_after).toBe(firstPage.records[0]?.id);
    const secondPage = await store.list({ limit: 1, after: firstPage.next_after! });
    expect(secondPage.records[0]?.session_id).toBe("mcp-1-a");
  });
});
