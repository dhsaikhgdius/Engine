import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../src/providers/anthropic";
import { createGeminiProvider, GEMINI_FLASH_DESCRIPTOR } from "../src/providers/gemini";
import { createOpenAiProvider } from "../src/providers/openai";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canonical provider runtime", () => {
  it("normalizes OpenAI cache usage through complete and high-level chat", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        id: "chatcmpl-shared",
        model: "gpt-test",
        choices: [{ message: { role: "assistant", content: "Scene ready." }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 31,
          completion_tokens: 7,
          total_tokens: 38,
          prompt_tokens_details: { cached_tokens: 11 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiProvider({
      baseUrl: "https://openai.example.test/v1",
      apiKey: "test-key",
      model: "gpt-test",
    });

    const completion = await provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: [{ type: "text", text: "Build the scene" }] }],
    });
    const chat = await provider.chat([{ role: "user", content: "Build the scene" }]);

    expect(completion.usage).toEqual({
      inputTokens: 20,
      cacheReadInputTokens: 11,
      outputTokens: 7,
      reasoningTokens: 3,
      totalTokens: 38,
    });
    expect(chat.usage).toEqual(completion.usage);
    expect(chat.toolCalls).toBeUndefined();
  });

  it("projects the canonical SSE stream through the high-level chat iterator", async () => {
    const stream = [
      'data: {"id":"chatcmpl-stream","model":"gpt-test","choices":[{"delta":{"content":"Scene "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"checking"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ready."},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const provider = createOpenAiProvider({
      baseUrl: "https://openai.example.test/v1",
      apiKey: "test-key",
      model: "gpt-test",
    });

    const chunks = [];
    for await (const chunk of provider.streamChat?.([{ role: "user", content: "Build the scene" }]) ?? []) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.delta).join("")).toBe("Scene ready.");
    expect(chunks.some((chunk) => chunk.reasoningDelta === "checking")).toBe(true);
    expect(chunks.at(-1)?.finishReason).toBe("stop");
  });

  it("uses Anthropic cache breakpoints and keeps all usage buckets", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: "msg-shared",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "Scene ready." }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 42,
          output_tokens: 9,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 13,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAnthropicProvider({
      baseUrl: "https://anthropic.example.test/v1",
      apiKey: "test-key",
      model: "claude-test",
    });

    const completion = await provider.complete({
      model: "claude-test",
      tools: [
        {
          name: "director_workbench",
          description: "Operate Director",
          inputSchema: { type: "object", properties: { op: { type: "string" } }, required: ["op"] },
        },
      ],
      messages: [
        { role: "system", content: [{ type: "text", text: "Direct the scene." }] },
        { role: "user", content: [{ type: "text", text: "Build the scene" }] },
      ],
    });

    expect(completion.usage).toEqual({
      inputTokens: 42,
      cacheReadInputTokens: 13,
      cacheWriteInputTokens: 5,
      outputTokens: 9,
      totalTokens: 69,
    });
    expect((requestBody?.system as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect((requestBody?.tools as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("uses the canonical Gemini endpoint, credential header, and variant descriptor", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        id: "gemini-shared",
        model: GEMINI_FLASH_DESCRIPTOR.model,
        choices: [{ message: { role: "assistant", content: "Scene ready." }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createGeminiProvider({
      baseUrl: "",
      apiKey: "gemini-key",
      model: GEMINI_FLASH_DESCRIPTOR.model,
    });

    await provider.complete({
      model: GEMINI_FLASH_DESCRIPTOR.model,
      messages: [{ role: "user", content: [{ type: "text", text: "Build the scene" }] }],
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("gemini-key");
    expect(provider.descriptor).toMatchObject(GEMINI_FLASH_DESCRIPTOR);
  });
});
