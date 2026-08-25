import { afterEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  bootstrapDirectorAgent: vi.fn(),
  clearDirectorAgentClient: vi.fn(),
  directorAgentFetch: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/assistant/agentGatewayClient", () => gatewayMocks);

import {
  directorControlPlaneEventUrl,
  directorControlPlaneFetch,
  directorControlPlaneUrl,
  resetDirectorControlPlaneCredentials,
} from "../../../../src/comprehensive/editor/api/directorControlPlaneClient";

afterEach(() => vi.clearAllMocks());

describe("directorControlPlaneClient", () => {
  it("resolves control-plane paths against the configured gateway origin", () => {
    expect(directorControlPlaneUrl("api/agent/runs")).toBe("http://127.0.0.1:8787/api/agent/runs");
    expect(directorControlPlaneUrl("/api/video/providers")).toBe("http://127.0.0.1:8787/api/video/providers");
  });

  it("delegates HTTP through the authenticated Agent fetch without rewriting request options", async () => {
    const expected = new Response("{}", { status: 202 });
    gatewayMocks.directorAgentFetch.mockResolvedValue(expected);
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"objective":"scene"}',
    };

    await expect(directorControlPlaneFetch("/api/agent/runs", init)).resolves.toBe(expected);
    expect(gatewayMocks.directorAgentFetch).toHaveBeenCalledWith("http://127.0.0.1:8787/api/agent/runs", init);
  });

  it("injects the process-epoch token into an encoded EventSource URL", async () => {
    gatewayMocks.bootstrapDirectorAgent.mockResolvedValue({ browserToken: "epoch token/+?" });
    const query = new URLSearchParams({ after: "17", filter: "角色 A" });

    const value = await directorControlPlaneEventUrl("/api/agent/sessions/session%2F1/events/stream", query);
    const parsed = new URL(value);

    expect(parsed.pathname).toBe("/api/agent/sessions/session%2F1/events/stream");
    expect(parsed.searchParams.get("after")).toBe("17");
    expect(parsed.searchParams.get("filter")).toBe("角色 A");
    expect(parsed.searchParams.get("browser_token")).toBe("epoch token/+?");
    expect(gatewayMocks.bootstrapDirectorAgent).toHaveBeenCalledOnce();
  });

  it("clears the shared credential cache", () => {
    resetDirectorControlPlaneCredentials();
    expect(gatewayMocks.clearDirectorAgentClient).toHaveBeenCalledOnce();
  });
});
