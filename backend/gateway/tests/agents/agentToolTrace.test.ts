// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildAgentToolTraceEvent, describeAgentToolOperation } from "../../agents/agentToolTrace";

describe("describeAgentToolOperation", () => {
  it("returns the op field and flattens nested command actions", () => {
    expect(describeAgentToolOperation({ op: "observe" })).toBe("observe");
    expect(describeAgentToolOperation({ op: "production", command: { action: "plan" } })).toBe("production.plan");
    expect(describeAgentToolOperation({ op: "generation", request: { action: "submit" } })).toBe("generation.submit");
  });

  it("falls back to unknown for inputs without an op", () => {
    expect(describeAgentToolOperation(null)).toBe("unknown");
    expect(describeAgentToolOperation({ prompt: "secret text" })).toBe("unknown");
    expect(describeAgentToolOperation([1, 2])).toBe("unknown");
  });
});

describe("buildAgentToolTraceEvent", () => {
  const base = {
    tool: "director_workbench",
    sessionId: "mcp-session-1",
    source: "mcp" as const,
    operation: "author",
    startedAtMs: Date.parse("2026-08-25T10:00:00.000Z"),
    nowMs: Date.parse("2026-08-25T10:00:00.250Z"),
  };

  it("classifies success and extracts revisions plus the boundary receipt", () => {
    const event = buildAgentToolTraceEvent({
      ...base,
      status: 200,
      body: {
        success: true,
        result: { project_revision: "rev-9" },
        agent_boundary: {
          guard: { mode: "revision", value: "rev-8" },
          idempotency: { key: "idem-1", replayed: false },
        },
      },
    });
    expect(event.outcome).toBe("success");
    expect(event.duration_ms).toBe(250);
    expect(event.revision_before).toBe("rev-8");
    expect(event.revision_after).toBe("rev-9");
    expect(event.idempotency_key).toBe("idem-1");
    expect(event.capture_ref).toBeUndefined();
  });

  it("classifies 409 as conflict and keeps the structured code", () => {
    const event = buildAgentToolTraceEvent({
      ...base,
      status: 409,
      body: { success: false, code: "stale_project_revision", error: "修订已过期" },
    });
    expect(event.outcome).toBe("conflict");
    expect(event.code).toBe("stale_project_revision");
    expect(event.error).toBe("修订已过期");
  });

  it("classifies success:false bodies as errors even with HTTP 200", () => {
    const event = buildAgentToolTraceEvent({ ...base, status: 200, body: { success: false, error: "boom" } });
    expect(event.outcome).toBe("error");
  });

  it("stores a token-free capture reference only when the response carried a capture", () => {
    const withCapture = buildAgentToolTraceEvent({
      ...base,
      status: 200,
      body: { success: true, capture: { mime_type: "image/png" } },
      captureRef: "http://127.0.0.1:8787/api/preview?preview_token=secret-token",
    });
    expect(withCapture.capture_ref).toBe("http://127.0.0.1:8787/api/preview");
    expect(JSON.stringify(withCapture)).not.toContain("secret-token");

    const withoutCapture = buildAgentToolTraceEvent({
      ...base,
      status: 200,
      body: { success: true },
      captureRef: "http://127.0.0.1:8787/api/preview?preview_token=secret-token",
    });
    expect(withoutCapture.capture_ref).toBeUndefined();
  });

  it("never embeds the response payload in the trace event", () => {
    const event = buildAgentToolTraceEvent({
      ...base,
      status: 200,
      body: { success: true, scene: { objects: [{ id: "cube-1" }] }, result: { prompt: "raw prompt text" } },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("cube-1");
    expect(serialized).not.toContain("raw prompt text");
  });
});
