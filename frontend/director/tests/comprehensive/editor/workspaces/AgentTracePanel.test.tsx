import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const directorControlPlaneFetch = vi.fn();

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: (path: string) => directorControlPlaneFetch(path) as Promise<Response>,
}));

import {
  AgentTracePanel,
  formatProgressPercent,
  formatTraceDuration,
  groupUsageByScope,
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

const FILM_PROGRESS = {
  contract: "director-progress-v1" as const,
  kind: "film_run" as const,
  id: "film-run-1",
  label: "idea-to-film",
  state: "running" as const,
  progress: 5 / 7,
  message: "开始渲染第 2 镜",
  source_status: "running",
  created_at: "2026-08-25T10:00:00.000Z",
  updated_at: "2026-08-25T10:05:00.000Z",
};

const SAMPLES = [
  {
    id: "usage-1",
    scope: "prod-session-1",
    provider: "openai-compatible",
    model: "gpt-test",
    input_tokens: 80,
    output_tokens: 20,
    total_tokens: 100,
    duration_ms: 900,
    retries: 1,
    succeeded: true,
    recorded_at: "2026-08-25T10:00:01.000Z",
  },
  {
    id: "usage-2",
    scope: "film-llm",
    provider: "openai-compatible",
    model: "film-model",
    input_tokens: 30,
    output_tokens: 30,
    total_tokens: 60,
    duration_ms: 600,
    retries: 2,
    succeeded: false,
    recorded_at: "2026-08-25T10:00:02.000Z",
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockObservability(options?: {
  summary?: unknown | "404";
  usage?: unknown;
  samples?: unknown[];
  progress?: unknown[];
  progressStatus?: number;
}) {
  const usageBody = {
    samples: options?.samples ?? [],
    summary: options?.usage ?? { ...USAGE, sample_count: 0, total_tokens: 0 },
  };
  return async (path: string) => {
    if (path.startsWith("/api/agent/traces/summary")) {
      if (options?.summary === "404") return jsonResponse({ error: "none" }, 404);
      return jsonResponse({ summary: options?.summary ?? SUMMARY });
    }
    if (path.startsWith("/api/agent/usage")) {
      return jsonResponse(usageBody);
    }
    if (path.startsWith("/api/agent/progress")) {
      return jsonResponse(
        { entries: options?.progress ?? [], summary: { entry_count: 0 } },
        options?.progressStatus ?? 200,
      );
    }
    return jsonResponse({ error: "missing" }, 404);
  };
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

describe("formatProgressPercent / groupUsageByScope", () => {
  it("formats progress fractions and sorts film scopes ahead of sessions", () => {
    expect(formatProgressPercent(5 / 7)).toBe("71%");
    expect(formatProgressPercent(null)).toBe("—");
    const rows = groupUsageByScope([
      ...SAMPLES,
      {
        id: "usage-3",
        scope: "film-video",
        provider: "videos-api:veo",
        model: "veo",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 2_000,
        retries: 1,
        succeeded: true,
        recorded_at: "2026-08-25T10:00:03.000Z",
      },
      {
        id: "usage-4",
        scope: "film-image",
        provider: "images-api:img",
        model: "img",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 400,
        retries: 0,
        succeeded: true,
        recorded_at: "2026-08-25T10:00:04.000Z",
      },
      {
        id: "usage-5",
        scope: "film-tts",
        provider: "speech-api:tts-1",
        model: "tts-1",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 700,
        retries: 1,
        succeeded: true,
        recorded_at: "2026-08-25T10:00:05.000Z",
      },
    ]);
    expect(rows.map((row) => row.scope)).toEqual([
      "film-llm",
      "film-image",
      "film-video",
      "film-tts",
      "prod-session-1",
    ]);
    expect(rows[0]!.summary.total_tokens).toBe(60);
  });
});

describe("loadAgentTracePanelData", () => {
  it("parses the summary, usage, and film progress responses", async () => {
    const fetcher = vi.fn(mockObservability({ usage: USAGE, samples: SAMPLES, progress: [FILM_PROGRESS] }));
    const data = await loadAgentTracePanelData(fetcher);
    expect(data.summary?.session_id).toBe("mcp-session-1");
    expect(data.usage?.total_tokens).toBe(160);
    expect(data.usageScopes.map((row) => row.scope)).toEqual(["film-llm", "prod-session-1"]);
    expect(data.filmProgress[0]?.id).toBe("film-run-1");
    expect(fetcher).toHaveBeenCalledWith("/api/agent/traces/summary");
    expect(fetcher).toHaveBeenCalledWith("/api/agent/usage?limit=200");
    expect(fetcher).toHaveBeenCalledWith("/api/agent/progress?kind=film_run&limit=20");
  });

  it("treats a 404 summary as an empty state instead of an error", async () => {
    const fetcher = vi.fn(mockObservability({ summary: "404" }));
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
    directorControlPlaneFetch.mockImplementation(mockObservability({ usage: USAGE }));
    render(<AgentTracePanel onClose={() => {}} />);

    expect(await screen.findByText("mcp-session-1")).toBeInTheDocument();
    expect(screen.getByText("director_workbench · observe")).toBeInTheDocument();
    expect(screen.getByText("director_workbench · author")).toBeInTheDocument();
    expect(screen.getByText(/stale_project_revision/)).toBeInTheDocument();
    expect(screen.getByText(/160 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/修订 rev-1 → rev-2/)).toBeInTheDocument();
  });

  it("renders film pipeline progress and per-scope usage including film scopes", async () => {
    const emptySummary = {
      sample_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      total_duration_ms: 0,
      retries: 0,
      failure_count: 0,
    };
    directorControlPlaneFetch.mockImplementation(
      mockObservability({
        usage: USAGE,
        samples: [
          ...SAMPLES,
          {
            id: "usage-3",
            scope: "film-image",
            provider: "images-api:img",
            model: "img",
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            duration_ms: 400,
            retries: 0,
            succeeded: true,
            recorded_at: "2026-08-25T10:00:03.000Z",
          },
        ],
        progress: [
          {
            ...FILM_PROGRESS,
            usage: {
              "film-llm": emptySummary,
              "film-image": emptySummary,
              "film-video": emptySummary,
              "film-tts": { ...emptySummary, sample_count: 4, total_duration_ms: 3_200 },
            },
          },
        ],
      }),
    );
    render(<AgentTracePanel onClose={() => {}} />);

    expect(await screen.findByLabelText("电影管线进度")).toBeInTheDocument();
    expect(screen.getByText(/idea-to-film · 71% · running/)).toBeInTheDocument();
    expect(screen.getByText("开始渲染第 2 镜")).toBeInTheDocument();
    expect(screen.getByText("Film 规划 LLM")).toBeInTheDocument();
    expect(screen.getByText("Film 图像生成")).toBeInTheDocument();
    // Per-run rollup: dialogue speech synthesis surfaces as its own scope line.
    expect(screen.getByText("Film 语音合成")).toBeInTheDocument();
    expect(screen.getByText(/4 · 3.2 s/)).toBeInTheDocument();
    expect(screen.getByText(/60 tokens · 600 ms · 失败 1/)).toBeInTheDocument();
    expect(screen.getByText("prod-session-1")).toBeInTheDocument();
  });

  it("refreshes when the refresh button is pressed", async () => {
    directorControlPlaneFetch.mockImplementation(mockObservability({ usage: USAGE }));
    render(<AgentTracePanel onClose={() => {}} />);
    expect(await screen.findByText("mcp-session-1")).toBeInTheDocument();
    const callsBefore = directorControlPlaneFetch.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(directorControlPlaneFetch.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
