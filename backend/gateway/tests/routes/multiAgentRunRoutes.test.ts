// @vitest-environment node

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AgentProfileRegistry } from "../../agents/agentProfileRegistry";
import type { MultiAgentRunStore } from "../../multiAgent/multiAgentRunStore";
import {
  DEFAULT_FILM_GRAPH,
  type ProductionRunOrchestrator,
} from "../../multiAgent/productionRunOrchestrator";
import { handleMultiAgentRunRoute, type MultiAgentRunRouteDependencies } from "../../routes/multiAgentRunRoutes";

const TARGET = {
  token: "target-token",
  client_id: "browser-client",
  instance_id: "director-instance",
  scene_id: "scene-1",
  creative_scope_id: "scope-1",
  contract_version: 2 as const,
};

function mockResponse() {
  return { end: vi.fn() } as unknown as ServerResponse;
}

function dependencies(
  body: unknown,
  options: {
    profileAvailable?: boolean;
    targetAvailable?: boolean;
    profiles?: Record<string, { provider?: "api" | "codex"; available?: boolean; tools?: boolean; vision?: boolean }>;
    storedRun?: unknown;
  } = {},
) {
  const json = vi.fn();
  const create = vi.fn().mockResolvedValue({ id: "run-created" });
  const resume = vi.fn().mockResolvedValue({ id: "run-resumed" });
  const store = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(options.storedRun ?? null),
  } as unknown as MultiAgentRunStore;
  const orchestrator = {
    create,
    resume,
    cancel: vi.fn(),
    resolveRoleProfiles: vi.fn(
      (input: {
        profileId: string;
        profileByRole?: Record<string, string>;
        roles?: string[];
        graph?: { nodes: Array<{ roleId: string }> };
      }) =>
        Object.fromEntries(
          (input.graph ? input.graph.nodes.map((node) => node.roleId) : (input.roles ?? DEFAULT_FILM_GRAPH)).map(
            (roleId) => [roleId, input.profileByRole?.[roleId] ?? input.profileId],
          ),
        ),
    ),
  } as unknown as ProductionRunOrchestrator;
  const profiles = {
    get: vi.fn((id: string) => {
      const configured = options.profiles?.[id];
      if (options.profiles && !configured) return null;
      return {
        provider: configured?.provider ?? "api",
        public: {
          available: configured?.available ?? options.profileAvailable ?? true,
          capabilities: { tools: configured?.tools ?? true, vision: configured?.vision ?? true },
        },
      };
    }),
  } as unknown as AgentProfileRegistry;
  const result: MultiAgentRunRouteDependencies = {
    readBody: vi.fn().mockResolvedValue(body),
    json,
    store,
    orchestrator,
    profiles,
    isTargetAvailable: vi.fn().mockReturnValue(options.targetAvailable ?? true),
  };
  return { dependencies: result, json, create, resume };
}

describe("multi-agent production run routes", () => {
  it("rejects malformed run creation input before profile lookup or orchestration", async () => {
    const fixture = dependencies({ objective: "Missing an exact browser target" });

    const handled = await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(handled).toBe(true);
    expect(fixture.json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("applies API profile defaults and starts a validated target-bound run", async () => {
    const fixture = dependencies({
      objective: "Block and verify a two-character dialogue scene.",
      roles: ["showrunner", "shot-planner"],
      target: TARGET,
    });

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "api",
        profileId: "api-default",
        roles: ["showrunner", "shot-planner"],
        target: TARGET,
      }),
      undefined,
    );
    expect(fixture.json).toHaveBeenCalledWith(expect.anything(), 202, { run: { id: "run-created" } });
  });

  it("rejects Codex/Claude production runs before orchestration", async () => {
    const fixture = dependencies(
      {
        objective: "Create a coherent three-scene science-fiction short film.",
        provider: "codex",
        profileId: "codex-local",
        roles: ["showrunner", "screenwriter", "stage-director", "visual-critic", "editor"],
        target: TARGET,
      },
      { profiles: { "codex-local": { provider: "codex", available: true, tools: true, vision: true } } },
    );

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "provider_unsupported", provider: "codex" }),
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects roles that need a workbench tool loop on the hosted runner", async () => {
    const fixture = dependencies(
      {
        objective: "Direct, shoot, critique, repair, and verify an exact scene.",
        roles: ["stage-director", "cinematographer", "visual-critic", "repair-operator"],
        profileByRole: {
          "stage-director": "openai-director",
          cinematographer: "claude-camera",
          "visual-critic": "openai-vision",
          "repair-operator": "claude-repair",
        },
        target: TARGET,
      },
      {
        profiles: {
          "openai-director": {},
          "claude-camera": {},
          "openai-vision": {},
          "claude-repair": {},
        },
      },
    );

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "hosted_tools_unavailable", roleId: "stage-director" }),
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects the default film graph because it includes mutating roles", async () => {
    const fixture = dependencies({
      objective: "Run the complete serial production graph.",
      target: TARGET,
    });

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "hosted_tools_unavailable" }),
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("allows observe-only hosted roles even when the profile does not advertise tools", async () => {
    const fixture = dependencies(
      {
        objective: "Write a creative brief without mutating the stage.",
        roles: ["showrunner", "shot-planner"],
        target: TARGET,
      },
      { profiles: { "api-default": { tools: false, vision: false } } },
    );

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.json).toHaveBeenCalledWith(expect.anything(), 202, { run: { id: "run-created" } });
  });

  it("rejects one unavailable or under-capable routed profile before background work starts", async () => {
    const unavailable = dependencies(
      {
        objective: "Reject a run whose repair model cannot be used.",
        roles: ["repair-operator"],
        profileByRole: { "repair-operator": "offline-repair" },
        target: TARGET,
      },
      { profiles: { "offline-repair": { available: false } } },
    );
    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      unavailable.dependencies,
    );
    expect(unavailable.json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "profile_unavailable", roleId: "repair-operator" }),
    );
    expect(unavailable.create).not.toHaveBeenCalled();

    const critic = dependencies(
      {
        objective: "Reject a visual critic that cannot capture evidence.",
        roles: ["visual-critic"],
        profileByRole: { "visual-critic": "openai-vision" },
        target: TARGET,
      },
      { profiles: { "openai-vision": { vision: true } } },
    );
    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      critic.dependencies,
    );
    expect(critic.json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "hosted_tools_unavailable", roleId: "visual-critic" }),
    );
    expect(critic.create).not.toHaveBeenCalled();
  });

  it("rejects an unavailable Director target without starting background work", async () => {
    const fixture = dependencies(
      {
        objective: "Plan a scene against a disconnected browser.",
        roles: ["showrunner"],
        target: TARGET,
      },
      { targetAvailable: false },
    );

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ code: "target_unavailable" }),
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("accepts an explicit observe-only production graph and starts the run", async () => {
    const fixture = dependencies({
      objective: "Run a diamond graph of observe-only departments.",
      graph: {
        nodes: [
          { id: "brief", roleId: "showrunner" },
          { id: "script", roleId: "screenwriter", dependsOn: ["brief"] },
          { id: "sound", roleId: "sound-designer", dependsOn: ["brief"] },
        ],
      },
      target: TARGET,
    });

    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      fixture.dependencies,
    );

    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graph: {
          nodes: [
            { id: "brief", roleId: "showrunner", dependsOn: [] },
            { id: "script", roleId: "screenwriter", dependsOn: ["brief"] },
            { id: "sound", roleId: "sound-designer", dependsOn: ["brief"] },
          ],
        },
      }),
      undefined,
    );
    expect(fixture.json).toHaveBeenCalledWith(expect.anything(), 202, { run: { id: "run-created" } });
  });

  it("rejects cyclic graphs, unknown edges, and mixed roles+graph requests at the boundary", async () => {
    const cyclic = dependencies({
      objective: "Reject a cyclic production graph.",
      graph: {
        nodes: [
          { id: "a", roleId: "showrunner", dependsOn: ["b"] },
          { id: "b", roleId: "screenwriter", dependsOn: ["a"] },
        ],
      },
      target: TARGET,
    });
    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      cyclic.dependencies,
    );
    expect(cyclic.json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(cyclic.create).not.toHaveBeenCalled();

    const mixed = dependencies({
      objective: "Reject a request that provides both roles and a graph.",
      roles: ["showrunner"],
      graph: { nodes: [{ id: "brief", roleId: "showrunner" }] },
      target: TARGET,
    });
    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs"),
      mixed.dependencies,
    );
    expect(mixed.json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(mixed.create).not.toHaveBeenCalled();
  });

  it("resumes from a durable checkpoint node and rejects unknown checkpoints", async () => {
    const storedRun = { id: "run-existing", nodes: [{ id: "script" }, { id: "cut" }] };
    const fixture = dependencies({ from_node_id: "script" }, { storedRun });
    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs/run-existing/resume"),
      fixture.dependencies,
    );
    expect(fixture.resume).toHaveBeenCalledWith("run-existing", undefined, { fromNodeId: "script" });
    expect(fixture.json).toHaveBeenCalledWith(expect.anything(), 202, { run: { id: "run-resumed" } });

    const unknown = dependencies({ from_node_id: "missing" }, { storedRun });
    await handleMultiAgentRunRoute(
      { method: "POST" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs/run-existing/resume"),
      unknown.dependencies,
    );
    expect(unknown.json).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({ code: "checkpoint_not_found" }),
    );
    expect(unknown.resume).not.toHaveBeenCalled();
  });

  it("returns a controlled boundary error for a malformed percent-encoded run id", async () => {
    const fixture = dependencies(undefined);

    const handled = await handleMultiAgentRunRoute(
      { method: "GET" } as IncomingMessage,
      mockResponse(),
      new URL("http://director.test/api/agent/runs/%E0%A4%A"),
      fixture.dependencies,
    );

    expect(handled).toBe(true);
    expect(fixture.json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "invalid_run_id" }),
    );
  });
});
