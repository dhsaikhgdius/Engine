import { describe, expect, it } from "vitest";
import type { AgentProvider } from "@director/agent-engine";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { AgentProfileRegistry } from "../../agents/agentProfileRegistry";

const unavailableLocalRuntimes: Record<AgentProvider, boolean> = {
  codex: false,
  claude: false,
  api: false,
};

describe("AgentProfileRegistry", () => {
  it("publishes sanitized native and compatible profiles", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      OPENAI_API_KEY: "never-public-openai",
      ANTHROPIC_API_KEY: "never-public-anthropic",
      DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
        { id: "openai-main", label: "OpenAI Main", driver: "openai", model: "gpt-4o" },
        { id: "claude-review", label: "Claude Review", driver: "anthropic", model: "claude-review" },
        {
          id: "local-compatible",
          label: "Local Compatible",
          driver: "openai-compatible",
          baseUrl: "http://localhost:8080/v1",
          model: "qwen-local",
          capabilities: { vision: true },
        },
      ]),
    });
    const registry = new AgentProfileRegistry(config, unavailableLocalRuntimes);

    expect(registry.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai-main",
          runtime: "native-openai",
          endpointHost: "api.openai.com",
          credentialConfigured: true,
          available: true,
          capabilities: expect.objectContaining({
            vision: true,
            maxContextTokens: 128_000,
            maxOutputTokens: 16_384,
          }),
        }),
        expect.objectContaining({
          id: "claude-review",
          runtime: "native-anthropic",
          endpointHost: "api.anthropic.com",
          credentialConfigured: true,
          available: true,
        }),
        expect.objectContaining({
          id: "local-compatible",
          runtime: "native-openai-compatible",
          endpointHost: "localhost:8080",
          credentialConfigured: false,
          available: true,
          capabilities: expect.objectContaining({ vision: true }),
        }),
      ]),
    );
    expect(JSON.stringify(registry.list())).not.toContain("never-public");
    expect(JSON.stringify(registry.list())).not.toContain("OPENAI_API_KEY");
    expect(registry.get("openai-main")).toMatchObject({
      provider: "api",
      hostedConfig: { apiKey: "never-public-openai", maxToolRounds: 24 },
    });
  });

  it("keeps legacy DIRECTOR_AGENT_API settings as api-default", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_AGENT_API_BASE_URL: "https://legacy.example/v1",
      DIRECTOR_AGENT_API_KEY: "legacy-secret",
      DIRECTOR_AGENT_API_MODEL: "legacy-model",
      DIRECTOR_AGENT_API_LABEL: "Legacy API",
    });
    const profile = new AgentProfileRegistry(config, unavailableLocalRuntimes).get("api-default");
    expect(profile).toMatchObject({
      provider: "api",
      public: {
        label: "Legacy API",
        runtime: "native-openai-compatible",
        model: "legacy-model",
        endpointHost: "legacy.example",
        credentialConfigured: true,
        available: true,
        capabilities: {
          streaming: true,
          tools: true,
          parallelToolCalls: false,
          vision: false,
          jsonSchema: false,
          maxContextTokens: null,
          maxOutputTokens: null,
        },
      },
    });
    expect(JSON.stringify(profile?.public)).not.toContain("legacy-secret");
  });

  it("does not advertise unauthenticated remote native profiles as available", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
        { id: "openai-missing-key", label: "Missing Key", driver: "openai", model: "gpt-main" },
      ]),
    });
    expect(new AgentProfileRegistry(config, unavailableLocalRuntimes).get("openai-missing-key")?.public).toMatchObject({
      credentialConfigured: false,
      available: false,
    });
  });

  it("hot-reloads extra hosted profiles without dropping local CLIs", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {});
    const registry = new AgentProfileRegistry(config, unavailableLocalRuntimes);
    registry.replaceExtraHostedProfiles([
      {
        id: "openai.gpt-4.1",
        label: "OpenAI",
        driver: "openai",
        runtime: "native-openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4.1",
        apiKey: "sk-live",
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
    ]);
    expect(registry.get("codex-local")?.public.id).toBe("codex-local");
    expect(registry.get("api-default")?.public.id).toBe("api-default");
    expect(registry.get("openai.gpt-4.1")?.public).toMatchObject({
      model: "gpt-4.1",
      available: true,
    });
    registry.replaceExtraHostedProfiles([]);
    expect(registry.get("openai.gpt-4.1")).toBeNull();
  });
});
