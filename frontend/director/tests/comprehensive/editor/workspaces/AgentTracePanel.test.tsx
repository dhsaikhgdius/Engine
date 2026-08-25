import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const directorControlPlaneFetch = vi.fn();

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: (path: string) => directorControlPlaneFetch(path) as Promise<Response>,
}));

import {
  AgentTracePanel,
  formatTraceDuration,
  loadAgentTracePanelData,
} from "../../../../src/comprehensive/editor/workspaces/AgentTracePanel";

const SUMMARY = {
  session_id: "mcp-session-1",
  sources: ["mcp"],
  started_at: "2026-08-25T10:00:00.000Z",
  ended_at: "2026-08-25T10:00:03.000Z",
  call_count: 2,
  error_count: 0,
  conflict_count: 1,
  total_duration_ms: 1_250,
  revision_start: "rev-1",
  revision_end: "rev-2",
  chain: [
    {
      tool: "director_workbench",
      operation: "observe",
      outcome: "success",
      started_at: "2026-08-25T10:00:00.000Z",
      duration_ms: 40,
      revision_before: "rev-1",
      revision_after: "rev-2",
      capture_ref: "http://127.0.0.1:8787/api/preview",
    },
    {
      tool: "director_workbench",
      operation: "author",
      outcome: "conflict",
      started_at: "2026-08-25T10:00:03.000Z",
      duration_ms: 1_210,
      revision_before: "rev-2",
      revision_after: null,
      code: "stale_project_revision",
    },
  ],
};

const USAGE = {
  sample_count: 2,
  input_tokens: 110,
  output_tokens: 50,
  total_tokens: 160,
  total_duration_ms: 1_500,
  retries: 3,
  failure_count: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  directorControlPlaneFetch.mockReset();
});

describe("formatTraceDuration", () => {
  it("keeps milliseconds under a second and switches to seconds above", () => {
    expect(formatTraceDuration(950)).toBe("950 ms");
    expect(formatTraceDuration(1_250)).toBe("1.3 s");
  });
});

describe("loadAgentTracePanelData", () => {
  it("parses the summary and usage responses", async () => {
    const fetcher = vi.fn(async (path: string) =>
      path.startsWith("/api/agent/traces/summary")
        ? jsonResponse({ summary: SUMMARY })
        : jsonResponse({ samples: [], summary: USAGE }),
    );
    const data = await loadAgentTracePanelData(fetcher);
    expect(data.summary?.session_id).toBe("mcp-session-1");
    expect(data.usage?.total_tokens).toBe(160);
    expect(fetcher).toHaveBeenCalledWith("/api/agent/traces/summary");
  });

  it("treats a 404 summary as an empty state instead of an error", async () => {
    const fetcher = vi.fn(async (path: string) =>
      path.startsWith("/api/agent/traces/summary")
        ? jsonResponse({ error: "none" }, 404)
        : jsonResponse({ samples: [], summary: { ...USAGE, sample_count: 0 } }),
    );
    const data = await loadAgentTracePanelData(fetcher);
    expect(data.summary).toBeNull();
  });

  it("throws when the summary endpoint fails", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    await expect(loadAgentTracePanelData(fetcher)).rejects.toThrow(/HTTP 500/);
  });
});

describe("AgentTracePanel", () => {
  it("renders the reconstructed tool chain with usage totals", async () => {
    directorControlPlaneFetch.mockImplementation(async (path: string) =>
      path.startsWith("/api/agent/traces/summary")
        ? jsonResponse({ summary: SUMMARY })
        : jsonResponse({ samples: [], summary: USAGE }),
    );
    render(<AgentTracePanel onClose={() => {}} />);

    expect(await screen.findByText("mcp-session-1")).toBeInTheDocument();
    expect(screen.getByText("director_workbench · observe")).toBeInTheDocument();
    expect(screen.getByText("director_workbench · author")).toBeInTheDocument();
    expect(screen.getByText(/stale_project_revision/)).toBeInTheDocument();
    expect(screen.getByText(/160 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/修订 rev-1 → rev-2/)).toBeInTheDocument();
  });

  it("shows the empty state when no session has been traced yet", async () => {
    directorControlPlaneFetch.mockImplementation(async (path: string) =>
      path.startsWith("/api/agent/traces/summary")
        ? jsonResponse({ error: "none" }, 404)
        : jsonResponse({ samples: [], summary: { ...USAGE, sample_count: 0 } }),
    );
    render(<AgentTracePanel onClose={() => {}} />);

    expect(await screen.findByText("还没有可回放的 Agent 会话")).toBeInTheDocument();
  });

  it("shows a degraded notice when the trace API is unreachable and closes on demand", async () => {
    directorControlPlaneFetch.mockRejectedValue(new Error("offline"));
    const onClose = vi.fn();
    render(<AgentTracePanel onClose={onClose} />);

    expect(await screen.findByText("轨迹服务暂时不可用")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "关闭轨迹面板" }));
    expect(onClose).toHaveBeenCalled();
  });
});
