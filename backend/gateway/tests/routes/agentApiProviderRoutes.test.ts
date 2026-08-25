import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApiProviderStore } from "../../agents/agentApiProviderStore";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { AgentProfileRegistry } from "../../agents/agentProfileRegistry";
import { applyAgentApiProviders, handleAgentApiProviderRoute } from "../../routes/agentApiProviderRoutes";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("agent API provider routes", () => {
  async function harness() {
    const directory = await mkdtemp(join(tmpdir(), "director-agent-api-routes-"));
    tempDirs.push(directory);
    const store = new AgentApiProviderStore(directory);
    await store.load();
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      OPENAI_API_KEY: "env-secret",
      DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
        { id: "openai-env", label: "Env OpenAI", driver: "openai", model: "gpt-env" },
      ]),
    });
    const registry = new AgentProfileRegistry(config, {
      api: false,
      codex: false,
      claude: false,
    });
    const writes: Array<{ status: number; body: unknown }> = [];
    const applied: unknown[] = [];
    const fetchModels = vi.fn(async () => ["gpt-4.1", "gpt-4o"]);
    const dependencies = {
      readBody: async () => ({}),
      json: (_response: ServerResponse, status: number, body: unknown) => writes.push({ status, body }),
      store,
      environmentProfiles: config.agents.profiles,
      applyHostedProfiles: (profiles: readonly unknown[]) => {
        applied.push(profiles);
        registry.replaceExtraHostedProfiles(
          profiles as Parameters<AgentProfileRegistry["replaceExtraHostedProfiles"]>[0],
        );
      },
      fetchModels,
    };
    return {
      store,
      registry,
      writes,
      applied,
      fetchModels,
      dependencies,
      response: {} as ServerResponse,
    };
  }

  const request = (method: string) => ({ method }) as IncomingMessage;
  const url = (pathname: string) => new URL(`http://127.0.0.1:8787${pathname}`);

  it("saves providers without echoing secrets and hot-reloads profiles", async () => {
    const context = await harness();
    context.dependencies.readBody = async () => ({
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          driver: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-never-public",
          models: ["gpt-4.1"],
        },
      ],
    });

    expect(
      await handleAgentApiProviderRoute(
        request("PUT"),
        context.response,
        url("/api/agent/api-providers"),
        context.dependencies,
      ),
    ).toBe(true);

    const body = JSON.stringify(context.writes[0]?.body);
    expect(context.writes[0]?.status).toBe(200);
    expect(body).not.toContain("sk-never-public");
    expect(body).toContain("openai.gpt-4.1");
    expect(context.registry.get("openai.gpt-4.1")?.public).toMatchObject({
      model: "gpt-4.1",
      available: true,
      credentialConfigured: true,
    });
    expect(JSON.stringify(context.registry.list())).not.toContain("sk-never-public");
    expect(context.applied).toHaveLength(1);
  });

  it("lists public providers and fetches models through the gateway", async () => {
    const context = await harness();
    await context.store.replace([
      {
        id: "openai",
        label: "OpenAI",
        driver: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-stored",
        models: ["gpt-4.1"],
      },
    ]);

    await handleAgentApiProviderRoute(
      request("GET"),
      context.response,
      url("/api/agent/api-providers"),
      context.dependencies,
    );
    expect(JSON.stringify(context.writes[0]?.body)).not.toContain("sk-stored");

    context.dependencies.readBody = async () => ({
      driver: "openai",
      baseUrl: "https://api.openai.com/v1",
      providerId: "openai",
    });
    await handleAgentApiProviderRoute(
      request("POST"),
      context.response,
      url("/api/agent/api-providers/models"),
      context.dependencies,
    );
    expect(context.fetchModels).toHaveBeenCalledWith({
      driver: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-stored",
    });
    expect(context.writes[1]).toEqual({ status: 200, body: { models: ["gpt-4.1", "gpt-4o"] } });
  });

  it("applies user providers over environment profiles", () => {
    const env = [
      {
        id: "openai-env",
        label: "Env",
        driver: "openai" as const,
        runtime: "native-openai" as const,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-env",
        apiKey: "env",
        apiKeyEnv: "OPENAI_API_KEY",
        maxToolRounds: 24,
        capabilities: {
          streaming: true,
          tools: true,
          parallelToolCalls: true,
          vision: true,
          jsonSchema: true,
          maxContextTokens: null,
          maxOutputTokens: null,
        },
      },
    ];
    const received: unknown[] = [];
    applyAgentApiProviders(
      env,
      [
        {
          id: "deepseek",
          label: "DeepSeek",
          driver: "openai-compatible",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-ds",
          models: ["deepseek-chat"],
        },
      ],
      (profiles) => received.push(profiles),
    );
    expect(received[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openai-env" }),
        expect.objectContaining({ id: "deepseek.deepseek-chat", model: "deepseek-chat" }),
      ]),
    );
  });

  it("rejects oversized model lists with a usable error", async () => {
    const context = await harness();
    context.dependencies.readBody = async () => ({
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          driver: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          models: Array.from({ length: 129 }, (_, index) => `model-${index}`),
        },
      ],
    });

    expect(
      await handleAgentApiProviderRoute(
        request("PUT"),
        context.response,
        url("/api/agent/api-providers"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[0]).toEqual({
      status: 400,
      body: { error: "每个提供方至少 1 个、最多 128 个模型", code: "invalid_request" },
    });
  });
});
