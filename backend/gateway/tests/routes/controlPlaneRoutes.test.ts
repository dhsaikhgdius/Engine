import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { DIRECTOR_TOOL_MANIFEST_CONTRACT, directorToolManifest } from "../../controlPlane/toolManifest";
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

  it("serves the schema-generated tool manifest without leaking secrets", async () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_AGENT_API_BASE_URL: "https://models.example/v1",
      DIRECTOR_AGENT_API_KEY: "super-secret-agent-key",
      DIRECTOR_MESHY_API_KEY: "super-secret-meshy-key",
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
    const { status, body } = writes[0] as {
      status: number;
      body: {
        contract: string;
        generated_at: string;
        tools: Array<{
          name: string;
          description: string;
          input_schema: Record<string, unknown>;
          operations?: string[];
          legacy?: true;
        }>;
      };
    };
    expect(status).toBe(200);
    expect(body.contract).toBe(DIRECTOR_TOOL_MANIFEST_CONTRACT);
    expect(new Date(body.generated_at).getTime()).not.toBeNaN();

    const byName = new Map(body.tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "director_workbench",
      "director_creative",
      "director_dcc",
      "blender_native",
      "stage_video",
      "director_production",
      "director_film",
    ]) {
      const tool = byName.get(name);
      expect(tool, `${name} is missing from the manifest`).toBeDefined();
      expect(tool?.description.length).toBeGreaterThan(0);
      expect(tool?.input_schema).toBeTypeOf("object");
      expect(tool?.input_schema.type).toBe("object");
      expect(Array.isArray(tool?.operations)).toBe(true);
      expect(tool?.operations?.length).toBeGreaterThan(0);
      expect(tool?.legacy).toBeUndefined();
    }
    expect(byName.get("director_creative")?.operations).toContain("interchange");
    expect(byName.get("director_workbench")?.operations).toContain("author");

    const legacyTools = body.tools.filter((tool) => tool.legacy === true);
    expect(legacyTools.map((tool) => tool.name)).toEqual([
      "stage_read",
      "stage_scene",
      "stage_object",
      "stage_camera",
      "stage_show",
    ]);
    for (const tool of legacyTools) expect(tool.input_schema).toBeTypeOf("object");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("super-secret-agent-key");
    expect(serialized).not.toContain("super-secret-meshy-key");
    expect(serialized).not.toContain("models.example");
  });

  it("returns a stable cached manifest object across calls", () => {
    expect(directorToolManifest()).toBe(directorToolManifest());
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
        request("POST"),
        {} as ServerResponse,
        new URL("http://director.test/api/control-plane/tool-manifest"),
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
