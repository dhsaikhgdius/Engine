import { describe, expect, it } from "vitest";
import { fetchHostedAgentModels, hostedAgentModelsEndpoint } from "../../agents/agentApiModels";

describe("hostedAgentModelsEndpoint", () => {
  it("maps chat roots onto /models", () => {
    expect(hostedAgentModelsEndpoint("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/models");
    expect(hostedAgentModelsEndpoint("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(hostedAgentModelsEndpoint("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });
});

describe("fetchHostedAgentModels", () => {
  it("parses OpenAI-style lists and sends a bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const models = await fetchHostedAgentModels(
      { driver: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-secret" },
      async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }, { id: "gpt-4o" }, { id: "gpt-4.1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(models).toEqual(["gpt-4.1", "gpt-4o"]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer sk-secret" });
  });

  it("sends Anthropic headers and surfaces a missing /models endpoint", async () => {
    const models = await fetchHostedAgentModels(
      { driver: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant" },
      async (_url, init) => {
        expect(init?.headers).toMatchObject({
          "x-api-key": "sk-ant",
          "anthropic-version": "2023-06-01",
        });
        return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-20250514" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(models).toEqual(["claude-sonnet-4-20250514"]);

    await expect(
      fetchHostedAgentModels({ driver: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" }, async () => {
        return new Response("nope", { status: 404 });
      }),
    ).rejects.toThrow("该端点没有模型列表，请手动填写模型 ID");
  });
});
