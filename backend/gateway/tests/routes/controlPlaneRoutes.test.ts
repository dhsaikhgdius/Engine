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
      listAgentSessions: () => [],
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

  it("lists live workbench agent sessions with a derived status and hides the anonymous fallback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-25T10:20:00.000Z"));
      const writes: Array<{ status: number; body: unknown }> = [];
      const dependencies = {
        config: loadDirectorControlPlaneConfig("/tmp/director", {}),
        json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
        listAgentProfiles: () => [],
        listAgentSessions: () => [
          { sessionId: "dsh-live", lastActiveAtMs: Date.parse("2026-08-25T10:19:00.000Z") },
          { sessionId: "http-default", lastActiveAtMs: Date.parse("2026-08-25T10:19:30.000Z") },
          { sessionId: "dsh-stale", lastActiveAtMs: Date.parse("2026-08-25T09:00:00.000Z") },
        ],
        videoCapabilities: async () => ({}),
      };

      await expect(
        handleControlPlaneRoute(
          request(),
          {} as ServerResponse,
          new URL("http://director.test/api/agent/sessions"),
          dependencies,
        ),
      ).resolves.toBe(true);
      expect(writes).toEqual([
        {
          status: 200,
          body: {
            sessions: [
              {
                id: "dsh-live",
                tool: "director_workbench",
                status: "active",
                last_active_at: "2026-08-25T10:19:00.000Z",
              },
              {
                id: "dsh-stale",
                tool: "director_workbench",
                status: "idle",
                last_active_at: "2026-08-25T09:00:00.000Z",
              },
            ],
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
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
      listAgentSessions: () => [],
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

  it("serves a discovery-only A2A agent card without a live A2A endpoint or secrets", async () => {
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
      listAgentSessions: () => [],
      videoCapabilities: async () => ({}),
    };

    await expect(
      handleControlPlaneRoute(
        request(),
        {} as ServerResponse,
        new URL("http://director.test/api/control-plane/a2a-agent-card"),
        dependencies,
      ),
    ).resolves.toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe(200);
    const serialized = JSON.stringify(writes[0]?.body);
    expect(serialized).not.toContain("super-secret-agent-key");
    expect(serialized).not.toContain("DIRECTOR_AGENT_API_KEY");

    const card = writes[0]?.body as {
      contract: string;
      discovery_only: boolean;
      url: string;
      a2a: { jsonrpc_endpoint: null };
      capabilities: { streaming: boolean; push_notifications: boolean };
      interfaces: { http: { base_url: string; tool_manifest_path: string } };
      skills: Array<{ id: string; operations: string[]; http: { method: string; path: string } }>;
    };
    expect(card.contract).toBe("director-a2a-agent-card-v1");
    expect(card.discovery_only).toBe(true);
    expect(card.url).toBe("http://127.0.0.1:8787");
    expect(card.a2a.jsonrpc_endpoint).toBeNull();
    expect(card.capabilities).toMatchObject({ streaming: false, push_notifications: false });
    expect(card.interfaces.http.tool_manifest_path).toBe("/api/control-plane/tool-manifest");
    expect(card.skills.map((skill) => skill.id)).toEqual([
      "director_workbench",
      "director_creative",
      "blender_native",
      "stage_video",
    ]);
    const workbench = card.skills.find((skill) => skill.id === "director_workbench");
    expect(workbench?.operations).toContain("observe");
    expect(workbench?.http).toEqual({ method: "POST", path: "/api/tools/director_workbench" });
  });

  it("does not claim unknown paths or non-GET methods", async () => {
    const dependencies = {
      config: loadDirectorControlPlaneConfig("/tmp/director", {}),
      json: vi.fn(),
      listAgentProfiles: () => [],
      listAgentSessions: () => [],
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
