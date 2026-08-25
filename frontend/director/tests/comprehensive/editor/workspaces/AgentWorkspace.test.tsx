import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AgentWorkspace,
  DEFAULT_DSH_WEB_URL,
  DIRECTOR_DSH_HEALTH_PATH,
  isDirectorDshHealth,
  resolveDshWebUrl,
} from "../../../../src/comprehensive/editor/workspaces/AgentWorkspace";

const directorHealth = {
  service: "director-deepseek-harness",
  version: 1,
  tools: ["director_creative", "director_workbench", "stage_video", "blender_native", "director_model_routes"],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("falls back to the DSH Web default listen address", () => {
  expect(resolveDshWebUrl(undefined)).toBe(DEFAULT_DSH_WEB_URL);
  expect(resolveDshWebUrl("")).toBe(DEFAULT_DSH_WEB_URL);
  expect(resolveDshWebUrl("  http://127.0.0.1:4090/  ")).toBe("http://127.0.0.1:4090");
});

it("embeds DSH Web only when the Director plugin health contract answers", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify(directorHealth), { headers: { "content-type": "application/json" } }),
  );
  render(<AgentWorkspace />);
  const frame = await screen.findByTitle("DeepSeek Harness");
  expect(frame).toHaveAttribute("src", DEFAULT_DSH_WEB_URL);
  expect(fetch).toHaveBeenCalledWith(`${DEFAULT_DSH_WEB_URL}${DIRECTOR_DSH_HEALTH_PATH}`, {
    headers: { accept: "application/json" },
  });
  expect(screen.queryByRole("heading", { name: "用 DeepSeek Harness 驱动导演台" })).not.toBeInTheDocument();
});

it("shows the launch commands when DSH Web is down", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("failed to fetch"));
  render(<AgentWorkspace />);
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "用 DeepSeek Harness 驱动导演台" })).toBeInTheDocument();
  });
  expect(screen.queryByTitle("DeepSeek Harness")).not.toBeInTheDocument();
  expect(screen.getByText("npm run dsh")).toBeInTheDocument();
});

it("rejects a reachable bare DSH instance without the Director plugin", async () => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input).endsWith(DIRECTOR_DSH_HEALTH_PATH)) return new Response("<html></html>");
    return new Response(null);
  });
  render(<AgentWorkspace />);
  expect(await screen.findByRole("heading", { name: "DeepSeek Harness 未加载 Director 插件" })).toBeInTheDocument();
  expect(screen.queryByTitle("DeepSeek Harness")).not.toBeInTheDocument();
});

it("requires all Director domain tools in the health payload", () => {
  expect(isDirectorDshHealth(directorHealth)).toBe(true);
  expect(isDirectorDshHealth({ ...directorHealth, tools: ["director_workbench"] })).toBe(false);
  expect(isDirectorDshHealth({ ...directorHealth, tools: directorHealth.tools.slice(0, -1) })).toBe(false);
});
