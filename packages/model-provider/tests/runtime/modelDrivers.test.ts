// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AnthropicMessagesDriver } from "../../src/runtime/anthropicMessagesDriver";
import { ModelDriverHttpError, ModelDriverResponseError } from "../../src/runtime/http";
import { createModelDriver } from "../../src/runtime/modelDriverFactory";
import type { ModelCompletionRequest } from "../../src/runtime/modelDriver";
import { OpenAiChatDriver } from "../../src/runtime/openAiChatDriver";

type CapturedRequest = { url: string; init: RequestInit; body: Record<string, unknown> };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sequenceFetch(responses: Array<Response | ((request: CapturedRequest) => Response | Promise<Response>)>) {
  const requests: CapturedRequest[] = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
    };
    requests.push(request);
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call");
    return typeof response === "function" ? response(request) : response;
  }) as unknown as typeof fetch;
  return { fetchImplementation, requests };
}

const TOOL = {
  name: "director_workbench",
  description: "Inspect or edit the Director project",
  inputSchema: {
    type: "object",
    properties: { op: { type: "string" } },
    required: ["op"],
    additionalProperties: false,
  },
  strict: true,
} as const;

describe("createModelDriver", () => {
  it("constructs both canonical wire formats", () => {
    expect(
      createModelDriver({
        kind: "openai-chat-compatible",
        id: "openai-test",
        baseUrl: "https://models.example.test/v1",
      }),
    ).toBeInstanceOf(OpenAiChatDriver);
    expect(
      createModelDriver({
        kind: "anthropic-messages",
        id: "anthropic-test",
        baseUrl: "https://models.example.test/v1",
        apiKey: "test-key",
      }),
    ).toBeInstanceOf(AnthropicMessagesDriver);
  });
});

describe("OpenAiChatDriver", () => {
  it("maps canonical text, images, tool calls, tool results, usage, and malformed arguments", async () => {
    const mock = sequenceFetch([
      jsonResponse({
        id: "chatcmpl-1",
        model: "gpt-test",
        choices: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Scene inspected." }],
              tool_calls: [
                {
                  id: "call-valid",
                  type: "function",
                  function: { name: "director_workbench", arguments: '{"op":"audit"}' },
                },
                {
                  id: "call-invalid",
                  type: "function",
                  function: { name: "director_workbench", arguments: "{broken" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 31,
          completion_tokens: 7,
          total_tokens: 38,
          prompt_tokens_details: { cached_tokens: 11 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ]);
    const driver = new OpenAiChatDriver({
      id: "openai-primary",
      baseUrl: "https://models.example.test/v1",
      apiKey: "openai-test-secret",
      fetch: mock.fetchImplementation,
    });

    const result = await driver.complete({
      model: "gpt-test",
      maxOutputTokens: 512,
      toolChoice: { type: "tool", name: "director_workbench" },
      tools: [TOOL],
      messages: [
        { role: "system", content: [{ type: "text", text: "Operate Director safely." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this clean frame." },
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" },
              detail: "high",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will observe it." },
            {
              type: "tool-call",
              id: "call-observe",
              name: "director_workbench",
              arguments: { op: "observe" },
              rawArguments: '{"op":"observe"}',
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-observe",
              name: "director_workbench",
              content: [
                { type: "text", text: '{"success":true}' },
                { type: "image", source: { type: "url", url: "https://assets.example.test/frame.png" } },
              ],
            },
          ],
        },
      ],
    });

    expect(driver.kind).toBe("openai-chat-compatible");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.url).toBe("https://models.example.test/v1/chat/completions");
    expect(new Headers(mock.requests[0]?.init.headers).get("authorization")).toBe("Bearer openai-test-secret");
    expect(mock.requests[0]?.body).toMatchObject({
      model: "gpt-test",
      max_tokens: 512,
      tool_choice: { type: "function", function: { name: "director_workbench" } },
      tools: [
        {
          type: "function",
          function: {
            name: "director_workbench",
            description: "Inspect or edit the Director project",
            parameters: TOOL.inputSchema,
            strict: true,
          },
        },
      ],
    });
    const messages = mock.requests[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(5);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Inspect this clean frame." },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=", detail: "high" } },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call-observe",
          type: "function",
          function: { name: "director_workbench", arguments: '{"op":"observe"}' },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call-observe",
      content: '{"success":true}',
    });
    expect(messages[4]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Visual output for tool call call-observe." },
        { type: "image_url", image_url: { url: "https://assets.example.test/frame.png" } },
      ],
    });
    expect(result).toMatchObject({
      id: "chatcmpl-1",
      model: "gpt-test",
      finishReason: "tool-calls",
      rawFinishReason: "tool_calls",
      usage: {
        inputTokens: 20,
        outputTokens: 7,
        totalTokens: 38,
        cacheReadInputTokens: 11,
        reasoningTokens: 3,
      },
    });
    expect(result.message.content[0]).toEqual({ type: "text", text: "Scene inspected." });
    expect(result.message.content[1]).toEqual({
      type: "tool-call",
      id: "call-valid",
      name: "director_workbench",
      arguments: { op: "audit" },
      rawArguments: '{"op":"audit"}',
    });
    expect(result.message.content[2]).toEqual({
      type: "tool-call",
      id: "call-invalid",
      name: "director_workbench",
      arguments: null,
      rawArguments: "{broken",
      parseError: "invalid_json",
    });
  });

  it("retries a 429 response and never leaks the API key in an HTTP error", async () => {
    const recovered = sequenceFetch([
      jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" }),
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Recovered." }, finish_reason: "stop" }],
      }),
    ]);
    const driver = new OpenAiChatDriver({
      id: "rate-limited",
      baseUrl: "https://models.example.test/v1",
      apiKey: "retry-secret",
      fetch: recovered.fetchImplementation,
    });
    const result = await driver.complete({
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    });
    expect(recovered.requests).toHaveLength(2);
    expect(result.finishReason).toBe("stop");

    const rejected = sequenceFetch([jsonResponse({ error: "invalid key leaked-secret-value" }, 401)]);
    const rejectingDriver = new OpenAiChatDriver({
      id: "rejecting",
      baseUrl: "https://models.example.test/v1",
      apiKey: "leaked-secret-value",
      fetch: rejected.fetchImplementation,
    });
    const promise = rejectingDriver.complete({
      model: "model",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    });
    await expect(promise).rejects.toBeInstanceOf(ModelDriverHttpError);
    await expect(promise).rejects.not.toThrow(/leaked-secret-value/);
    await expect(promise).rejects.toThrow(/\[REDACTED\]/);
  });
});

describe("AnthropicMessagesDriver", () => {
  it("maps native system, image, tool_use, tool_result, tool schema, and cache usage fields", async () => {
    const mock = sequenceFetch([
      jsonResponse({
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [
          { type: "text", text: "I will audit the stage." },
          { type: "tool_use", id: "toolu-2", name: "director_workbench", input: { op: "audit" } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 42,
          output_tokens: 9,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 13,
        },
      }),
    ]);
    const driver = new AnthropicMessagesDriver({
      id: "anthropic-primary",
      apiKey: "anthropic-test-secret",
      baseUrl: "https://anthropic.example.test/v1",
      apiVersion: "2023-06-01",
      beta: "tool-feature-test",
      fetch: mock.fetchImplementation,
    });

    const result = await driver.complete({
      model: "claude-test",
      maxOutputTokens: 700,
      toolChoice: "required",
      tools: [TOOL],
      messages: [
        { role: "system", content: [{ type: "text", text: "You direct a deterministic 3D stage." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this frame." },
            { type: "image", source: { type: "url", url: "https://assets.example.test/clean.jpg" } },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              id: "toolu-1",
              name: "director_workbench",
              arguments: { op: "capture" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: "toolu-1",
              content: [
                { type: "text", text: "Capture ready" },
                {
                  type: "image",
                  source: { type: "base64", mediaType: "image/jpeg", data: "Y2xlYW4=" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(driver.kind).toBe("anthropic-messages");
    expect(mock.requests[0]?.url).toBe("https://anthropic.example.test/v1/messages");
    const headers = new Headers(mock.requests[0]?.init.headers);
    expect(headers.get("x-api-key")).toBe("anthropic-test-secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toBe("tool-feature-test");
    expect(mock.requests[0]?.body).toMatchObject({
      model: "claude-test",
      max_tokens: 700,
      system: [{ type: "text", text: "You direct a deterministic 3D stage." }],
      tool_choice: { type: "any" },
      tools: [
        {
          name: "director_workbench",
          description: "Inspect or edit the Director project",
          input_schema: TOOL.inputSchema,
        },
      ],
    });
    const messages = mock.requests[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this frame." },
          { type: "image", source: { type: "url", url: "https://assets.example.test/clean.jpg" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu-1", name: "director_workbench", input: { op: "capture" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-1",
            content: [
              { type: "text", text: "Capture ready" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Y2xlYW4=" } },
            ],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    const system = mock.requests[0]?.body.system as Array<Record<string, unknown>>;
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    const tools = mock.requests[0]?.body.tools as Array<Record<string, unknown>>;
    expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(result).toMatchObject({
      id: "msg-1",
      model: "claude-test",
      finishReason: "tool-calls",
      rawFinishReason: "tool_use",
      usage: {
        inputTokens: 42,
        outputTokens: 9,
        totalTokens: 69,
        cacheWriteInputTokens: 5,
        cacheReadInputTokens: 13,
      },
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will audit the stage." },
          {
            type: "tool-call",
            id: "toolu-2",
            name: "director_workbench",
            arguments: { op: "audit" },
            rawArguments: '{"op":"audit"}',
          },
        ],
      },
    });
  });

  it("passes AbortSignal to fetch and rejects schema-invalid provider responses", async () => {
    let observedSignal: AbortSignal | null = null;
    const abortingFetch = vi.fn((_input: string | URL | Request, init: RequestInit = {}) => {
      observedSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const driver = new AnthropicMessagesDriver({
      id: "anthropic-abort",
      apiKey: "secret",
      fetch: abortingFetch,
      maxRetries: 0,
    });
    const pending = driver.complete({
      model: "claude-test",
      signal: controller.signal,
      messages: [{ role: "user", content: [{ type: "text", text: "Wait" }] }],
    });
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal).toBe(controller.signal);

    const invalid = sequenceFetch([jsonResponse({ role: "assistant", content: [] })]);
    const invalidDriver = new AnthropicMessagesDriver({
      id: "anthropic-invalid",
      apiKey: "schema-secret",
      fetch: invalid.fetchImplementation,
      maxRetries: 0,
    });
    const invalidPromise = invalidDriver.complete({
      model: "claude-test",
      messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
    });
    await expect(invalidPromise).rejects.toBeInstanceOf(ModelDriverResponseError);
    await expect(invalidPromise).rejects.toThrow(/invalid response/);
    await expect(invalidPromise).rejects.not.toThrow(/schema-secret/);
  });
});

function sseResponse(events: string[]) {
  return new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAiChunk(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function anthropicEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const USER_MESSAGES: ModelCompletionRequest["messages"] = [
  { role: "user", content: [{ type: "text", text: "观察场景" }] },
];

describe("model driver streaming", () => {
  it("streams OpenAI text deltas and reassembles split tool-call fragments", async () => {
    const mock = sequenceFetch([
      sseResponse([
        openAiChunk({
          id: "chatcmpl-s1",
          model: "gpt-stream",
          choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }],
        }),
        openAiChunk({ choices: [{ delta: { content: "Scene " } }] }),
        openAiChunk({ choices: [{ delta: { content: "verified." } }] }),
        openAiChunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call-stream", type: "function", function: { name: "director_workbench" } },
                ],
              },
            },
          ],
        }),
        openAiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"op":' } }] } }] }),
        openAiChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"observe"}' } }] } }] }),
        openAiChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        openAiChunk({
          choices: [],
          usage: {
            prompt_tokens: 21,
            completion_tokens: 9,
            total_tokens: 30,
            prompt_tokens_details: { cached_tokens: 5 },
          },
        }),
        "data: [DONE]\n\n",
      ]),
    ]);
    const driver = new OpenAiChatDriver({
      id: "openai-stream",
      baseUrl: "https://models.example.test/v1",
      apiKey: "openai-stream-secret",
      fetch: mock.fetchImplementation,
    });

    const deltas: string[] = [];
    const result = await driver.stream(
      { model: "gpt-stream", tools: [TOOL], messages: USER_MESSAGES },
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(mock.requests[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(["Scene ", "verified."]);
    expect(result).toMatchObject({
      id: "chatcmpl-s1",
      model: "gpt-stream",
      finishReason: "tool-calls",
      rawFinishReason: "tool_calls",
      usage: { inputTokens: 16, outputTokens: 9, totalTokens: 30, cacheReadInputTokens: 5 },
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Scene verified." },
          {
            type: "tool-call",
            id: "call-stream",
            name: "director_workbench",
            arguments: { op: "observe" },
            rawArguments: '{"op":"observe"}',
          },
        ],
      },
    });
  });

  it("falls back to a plain JSON completion when a compatible server ignores the stream flag", async () => {
    const mock = sequenceFetch([
      jsonResponse({
        id: "chatcmpl-fallback",
        model: "gpt-local",
        choices: [{ message: { role: "assistant", content: "非流式回答" }, finish_reason: "stop" }],
      }),
    ]);
    const driver = new OpenAiChatDriver({
      id: "openai-fallback",
      baseUrl: "https://models.example.test/v1",
      apiKey: "secret",
      fetch: mock.fetchImplementation,
    });

    const deltas: string[] = [];
    const result = await driver.stream(
      { model: "gpt-local", messages: USER_MESSAGES },
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(deltas).toEqual([]);
    expect(result).toMatchObject({
      finishReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "非流式回答" }] },
    });
  });

  it("streams Anthropic text deltas and accumulated tool_use input JSON", async () => {
    const mock = sequenceFetch([
      sseResponse([
        anthropicEvent("message_start", {
          type: "message_start",
          message: {
            id: "msg-s1",
            model: "claude-stream",
            role: "assistant",
            content: [],
            usage: { input_tokens: 30, output_tokens: 2, cache_read_input_tokens: 7 },
          },
        }),
        anthropicEvent("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Checking " },
        }),
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "the frame." },
        }),
        anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicEvent("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu-stream", name: "director_workbench", input: {} },
        }),
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"op":"cap' },
        }),
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: 'ture"}' },
        }),
        anthropicEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
        anthropicEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 18 },
        }),
        anthropicEvent("message_stop", { type: "message_stop" }),
      ]),
    ]);
    const driver = new AnthropicMessagesDriver({
      id: "anthropic-stream",
      apiKey: "anthropic-stream-secret",
      fetch: mock.fetchImplementation,
    });

    const deltas: string[] = [];
    const result = await driver.stream(
      { model: "claude-stream", tools: [TOOL], messages: USER_MESSAGES },
      { onTextDelta: (delta) => deltas.push(delta) },
    );

    expect(mock.requests[0]?.body).toMatchObject({ stream: true });
    expect(deltas).toEqual(["Checking ", "the frame."]);
    expect(result).toMatchObject({
      id: "msg-s1",
      model: "claude-stream",
      finishReason: "tool-calls",
      rawFinishReason: "tool_use",
      usage: { inputTokens: 30, outputTokens: 18, totalTokens: 55, cacheReadInputTokens: 7 },
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the frame." },
          {
            type: "tool-call",
            id: "toolu-stream",
            name: "director_workbench",
            arguments: { op: "capture" },
            rawArguments: '{"op":"capture"}',
          },
        ],
      },
    });
  });

  it("surfaces an Anthropic stream error event without echoing credentials", async () => {
    const mock = sequenceFetch([
      sseResponse([
        anthropicEvent("error", {
          type: "error",
          error: { type: "overloaded_error", message: "Overloaded anthropic-error-secret" },
        }),
      ]),
    ]);
    const driver = new AnthropicMessagesDriver({
      id: "anthropic-stream-error",
      apiKey: "anthropic-error-secret",
      fetch: mock.fetchImplementation,
    });

    const pending = driver.stream({ model: "claude-stream", messages: USER_MESSAGES }, {});
    await expect(pending).rejects.toBeInstanceOf(ModelDriverResponseError);
    await expect(pending).rejects.toThrow(/Overloaded/);
    await expect(pending).rejects.not.toThrow(/anthropic-error-secret/);
  });
});
