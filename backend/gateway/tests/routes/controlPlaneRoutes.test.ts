import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { handleControlPlaneRoute } from "../../routes/controlPlaneRoutes";

function request(method = "GET") {
  return { method } as IncomingMessage;
}

describe("control-plane discovery routes", () => {
  it("exposes sanitized capabilities, public profiles, and live video providers", async () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_AGENT_API_BASE_URL: "https://models.example/v1",
      DIRECTOR_AGENT_API_KEY: "super-secret-agent-key",
      DIRECTOR_AGENT_API_MODEL: "movie-model",
    });
    const writes: Array<{ status: number; body: unknown }> = [];
    const response = {} as ServerResponse;
    const dependencies = {
      config,
      json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
      listAgentProfiles: () => [{ id: "api-default", available: true }],
      videoCapabilities: vi.fn(async () => ({ defaultProvider: "ltx-2.3", providers: [] })),
    };

    await expect(
      handleControlPlaneRoute(
        request(),
        response,
        new URL("http://director.test/api/control-plane/capabilities"),
        dependencies,
      ),
    ).resolves.toBe(true);
    await handleControlPlaneRoute(
      request(),
      response,
      new URL("http://director.test/api/agent/profiles"),
      dependencies,
    );
    await handleControlPlaneRoute(
      request(),
      response,
      new URL("http://director.test/api/video/providers"),
      dependencies,
    );

    const serialized = JSON.stringify(writes);
    expect(serialized).not.toContain("super-secret-agent-key");
    expect(writes).toEqual([
      expect.objectContaining({ status: 200, body: expect.objectContaining({ agents: expect.any(Object) }) }),
      { status: 200, body: { profiles: [{ id: "api-default", available: true }] } },
      { status: 200, body: { defaultProvider: "ltx-2.3", providers: [] } },
    ]);
    expect(dependencies.videoCapabilities).toHaveBeenCalledOnce();
  });

  it("serves the machine-readable tool manifest without secrets", async () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_AGENT_API_BASE_URL: "https://models.example/v1",
      DIRECTOR_AGENT_API_KEY: "super-secret-agent-key",
      DIRECTOR_AGENT_API_MODEL: "movie-model",
    });
    const writes: Array<{ status: number; body: unknown }> = [];
    const dependencies = {
      config,
      json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
      listAgentProfiles: () => [],
      videoCapabilities: async () => ({}),
    };

    await expect(
      handleControlPlaneRoute(
        request(),
        {} as ServerResponse,
        new URL("http://director.test/api/control-plane/tool-manifest"),
        dependencies,
      ),
    ).resolves.toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe(200);
    expect(JSON.stringify(writes[0]?.body)).not.toContain("super-secret-agent-key");

    const manifest = writes[0]?.body as {
      contract: string;
      tools: Array<{ name: string; surface: string; operations?: string[]; http: unknown; legacy?: boolean }>;
    };
    expect(manifest.contract).toBe("director-tool-manifest-v1");
    const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("director_workbench")).toMatchObject({
      surface: "both",
      http: { method: "POST", path: "/api/tools/director_workbench" },
    });
    expect(byName.get("director_creative")?.operations).toContain("interchange");
    expect(byName.get("stage_read")).toMatchObject({ surface: "http", legacy: true });
    expect(byName.get("stage_show")).toMatchObject({ surface: "http", legacy: true });
  });

  it("does not claim unknown paths or non-GET methods", async () => {
    const dependencies = {
      config: loadDirectorControlPlaneConfig("/tmp/director", {}),
      json: vi.fn(),
      listAgentProfiles: () => [],
      videoCapabilities: async () => ({}),
    };
    await expect(
      handleControlPlaneRoute(
        request("POST"),
        {} as ServerResponse,
        new URL("http://director.test/api/video/providers"),
        dependencies,
      ),
    ).resolves.toBe(false);
    await expect(
      handleControlPlaneRoute(
        request(),
        {} as ServerResponse,
        new URL("http://director.test/api/not-owned"),
        dependencies,
      ),
    ).resolves.toBe(false);
  });
});
