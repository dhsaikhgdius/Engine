// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { AgentProfileRegistry } from "../../agents/agentProfileRegistry";
import type { HostedAgentProfileConfig } from "../../controlPlane/controlPlaneConfig";
import { HostedProductionAgentRunner } from "../../multiAgent/hostedProductionAgentRunner";

const TARGET = {
  token: "target-token",
  client_id: "browser-client",
  instance_id: "director-instance",
  scene_id: "scene-1",
  creative_scope_id: "scope-1",
  contract_version: 2 as const,
};

function hostedConfig(id = "api-default"): HostedAgentProfileConfig {
  return {
    id,
    label: "API",
    driver: "openai-compatible",
    runtime: "native-openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "local-model",
    apiKey: "secret",
    apiKeyEnv: "DIRECTOR_AGENT_API_KEY",
    maxToolRounds: 24,
    capabilities: {
      streaming: true,
      tools: false,
      parallelToolCalls: false,
      vision: false,
      jsonSchema: true,
      maxContextTokens: null,
      maxOutputTokens: null,
    },
  };
}

function profiles(config = hostedConfig()): AgentProfileRegistry {
  return {
    get: (id: string) =>
      id === config.id
        ? { provider: "api" as const, hostedConfig: config, public: { id, available: true } }
        : null,
  } as unknown as AgentProfileRegistry;
}

describe("HostedProductionAgentRunner", () => {
  it("refuses Codex/Claude sessions before calling a model", async () => {
    const complete = vi.fn();
    const runner = new HostedProductionAgentRunner(profiles(), () => ({ complete }));
    const session = runner.createSession({
      provider: "codex",
      profileId: "codex-local",
      roleId: "showrunner",
      title: "showrunner",
    });

    await expect(runner.sendMessage(session.id, "plan the film", undefined, TARGET)).rejects.toThrow(
      /hosted API Profile/,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses mutating and visual-evidence roles before calling a model", async () => {
    const complete = vi.fn();
    const runner = new HostedProductionAgentRunner(profiles(), () => ({ complete }));
    const session = runner.createSession({
      provider: "api",
      profileId: "api-default",
      roleId: "stage-director",
      title: "stage-director",
    });

    await expect(runner.sendMessage(session.id, "block the scene", undefined, TARGET)).rejects.toThrow(
      /workbench tools/,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes an observe-only hosted turn", async () => {
    const complete = vi.fn(async () => ({
      id: "completion-1",
      model: "local-model",
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "creative brief" }] },
      finishReason: "stop" as const,
      rawFinishReason: "stop",
      usage: null,
    }));
    const runner = new HostedProductionAgentRunner(profiles(), () => ({ complete }));
    const session = runner.createSession({
      provider: "api",
      profileId: "api-default",
      roleId: "showrunner",
      title: "showrunner",
    });
    const events: string[] = [];
    runner.subscribe(session.id, (event) => events.push(event.type));

    await runner.sendMessage(session.id, "define the brief", undefined, TARGET);

    expect(complete).toHaveBeenCalledOnce();
    expect(events).toEqual(["turn.completed"]);
    expect(runner.store.listEvents(session.id).map((event) => event.type)).toEqual([
      "assistant.message",
      "turn.completed",
    ]);
  });
});
