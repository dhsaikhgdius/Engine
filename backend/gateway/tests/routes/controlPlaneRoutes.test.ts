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
