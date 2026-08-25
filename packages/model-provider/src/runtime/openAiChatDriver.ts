import { z } from "zod";
import {
  jsonValueSchema,
  modelCompletionSchema,
  parseModelCompletionRequest,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelContent,
  type ModelDriver,
  type ModelFinishReason,
  type ModelImageContent,
  type ModelMessage,
  type ModelStreamCallbacks,
  type ModelTool,
  type ModelToolChoice,
  type ModelToolResultContent,
} from "./modelDriver";
import {
  fetchModelJson,
  fetchModelResponse,
  isEventStreamResponse,
  ModelDriverResponseError,
  readServerSentEvents,
  responseValidationError,
  type FetchImplementation,
} from "./http";

type JsonRecord = Record<string, unknown>;

/** Schema for a text part in an OpenAI chat completion content array. */
const openAiTextPartSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

/** Schema for a refusal part in an OpenAI chat completion content array. */
const openAiRefusalPartSchema = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});

/** Schema for a single tool call in an OpenAI chat completion. */
const openAiToolCallSchema = z.looseObject({
  id: z.string().trim().min(1).max(240),
  type: z.literal("function").optional(),
  function: z.looseObject({
    name: z.string().trim().min(1).max(160),
    arguments: z.string().max(2_000_000),
  }),
});

/** Schema for OpenAI token usage. */
const openAiUsageSchema = z.looseObject({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z.looseObject({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
  completion_tokens_details: z.looseObject({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional(),
});

/** Schema for an OpenAI chat completion response. */
const openAiCompletionSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          role: z.literal("assistant").optional(),
          content: z
            .union([z.string(), z.null(), z.array(z.union([openAiTextPartSchema, openAiRefusalPartSchema]))])
            .optional(),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(openAiToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: openAiUsageSchema.optional(),
});

/** Schema for a tool call delta in an OpenAI streaming chunk. */
const openAiStreamToolCallSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z
    .looseObject({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

/** Schema for a single OpenAI streaming chunk. */
const openAiStreamChunkSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullable().optional(),
            refusal: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            tool_calls: z.array(openAiStreamToolCallSchema).optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: openAiUsageSchema.nullable().optional(),
});

/**
 * Maps OpenAI usage to the canonical {@link ModelUsage} format.
 */
function mapOpenAiUsage(usage: z.infer<typeof openAiUsageSchema> | null | undefined) {
  if (!usage) return null;
  const cacheReadInputTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheReadInputTokens ?? 0),
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
  };
}

/**
 * Configuration for the OpenAI Chat Completions driver.
 */
export type OpenAiChatDriverConfig = {
  /** Stable driver id. */
  id: string;
  /** Base URL for the chat completions endpoint. */
  baseUrl: string;
  /** Optional API key (sent as `Authorization: Bearer`). */
  apiKey?: string;
  /** Additional headers to include in every request. */
  defaultHeaders?: Record<string, string>;
  /** Maximum number of retries for 429/5xx errors (default 2). */
  maxRetries?: number;
  /** Custom fetch implementation for testing. */
  fetch?: FetchImplementation;
};

/**
 * Normalizes the base URL to the chat completions endpoint.
 */
function endpoint(baseUrl: string) {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

/**
 * Converts an image content item to a URL string.
 */
function imageUrl(image: ModelImageContent) {
  return image.source.type === "url" ? image.source.url : `data:${image.source.mediaType};base64,${image.source.data}`;
}

/**
 * Converts an image content item to an OpenAI image_url part.
 */
function imagePart(image: ModelImageContent) {
  return {
    type: "image_url",
    image_url: { url: imageUrl(image), ...(image.detail ? { detail: image.detail } : {}) },
  };
}

/**
 * Extracts text from a tool result, falling back to a visual-result hint.
 */
function textFromResult(result: ModelToolResultContent) {
  const text = result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (text) return text;
  return result.isError ? "Tool failed; visual result follows." : "Tool completed; visual result follows.";
}

/**
 * Returns the string arguments for a tool call, preferring the raw provider
 * input when available.
 */
function toolArguments(item: Extract<ModelContent, { type: "tool-call" }>) {
  if (item.rawArguments !== undefined) return item.rawArguments;
  return JSON.stringify(item.arguments);
}

/**
 * Maps canonical {@link ModelMessage} array to the widest-supported Chat
 * Completions wire shape.
 *
 * Handles the content-type restrictions of the OpenAI API: assistant
 * messages with tool_calls, user messages with images, and tool messages
 * for tool results.
 *
 * @param messages - The canonical model messages.
 * @returns The OpenAI chat completions message array.
 */
export function toOpenAiChatMessages(messages: readonly ModelMessage[]) {
  const output: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((item): item is Extract<ModelContent, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const calls = message.content
        .filter((item): item is Extract<ModelContent, { type: "tool-call" }> => item.type === "tool-call")
        .map((item) => ({
          id: item.id,
          type: "function",
          function: { name: item.name, arguments: toolArguments(item) },
        }));
      output.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    const regular = message.content.filter((item) => item.type === "text" || item.type === "image");
    const results = message.content.filter((item): item is ModelToolResultContent => item.type === "tool-result");
    if (regular.length) {
      const hasImage = regular.some((item) => item.type === "image");
      output.push({
        role: message.role,
        content: hasImage
          ? regular.map((item) => (item.type === "text" ? { type: "text", text: item.text } : imagePart(item)))
          : regular.map((item) => (item.type === "text" ? item.text : "")).join("\n"),
      });
    }
    for (const result of results) {
      output.push({ role: "tool", tool_call_id: result.toolCallId, content: textFromResult(result) });
      const images = result.content.filter(
        (item): item is Extract<(typeof result.content)[number], { type: "image" }> => item.type === "image",
      );
      if (images.length) {
        output.push({
          role: "user",
          content: [
            { type: "text", text: `Visual output for tool call ${result.toolCallId}.` },
            ...images.map(imagePart),
          ],
        });
      }
    }
  }
  return output;
}

/**
 * Converts canonical tools to the OpenAI function format.
 */
function toOpenAiTools(tools: readonly ModelTool[]) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));
}

/**
 * Converts a canonical tool choice to the OpenAI format.
 */
function toOpenAiToolChoice(choice: ModelToolChoice | undefined) {
  if (!choice || typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

/**
 * Maps an OpenAI finish reason to the canonical {@link ModelFinishReason}.
 */
function finishReason(raw: string | null | undefined): ModelFinishReason {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "tool_calls" || raw === "function_call") return "tool-calls";
  if (raw === "content_filter") return "content-filter";
  return "other";
}

/**
 * Parses raw tool-call arguments from a JSON string.
 *
 * Returns the parsed arguments, the raw string, and an optional parse error
 * when the JSON is invalid.
 */
function parseArguments(
  rawArguments: string,
): Pick<Extract<ModelContent, { type: "tool-call" }>, "arguments" | "rawArguments" | "parseError"> {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(rawArguments) as unknown);
    if (parsed.success) return { arguments: parsed.data, rawArguments };
  } catch {
    // The stable parseError below is safe to persist; it does not echo model output.
  }
  return { arguments: null, rawArguments, parseError: "invalid_json" };
}

/**
 * Extracts the response text from an OpenAI completion content field.
 *
 * Handles string, array-of-parts, and null content.
 */
function responseText(content: z.infer<typeof openAiCompletionSchema>["choices"][number]["message"]["content"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("\n");
}

/**
 * An OpenAI Chat Completions API driver.
 *
 * Implements both `complete` and `stream` — the stream method handles the
 * case where the server ignores the `stream` flag and returns a plain JSON
 * response instead.
 */
export class OpenAiChatDriver implements ModelDriver {
  /** Always `"openai-chat-compatible"`. */
  readonly kind = "openai-chat-compatible" as const;
  /** The driver id from configuration. */
  readonly id: string;
  /** The fetch implementation to use. */
  private readonly fetch: FetchImplementation;

  /**
   * @param config - The driver configuration.
   */
  constructor(private readonly config: OpenAiChatDriverConfig) {
    this.id = config.id;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  /**
   * Sends a non-streaming completion request.
   *
   * @param rawRequest - The completion request.
   * @returns The parsed and normalized completion.
   */
  async complete(rawRequest: ModelCompletionRequest): Promise<ModelCompletion> {
    const request = parseModelCompletionRequest(rawRequest);
    const payload = await fetchModelJson(this.requestOptions(request, false));
    return this.parseCompletionPayload(payload, request.model);
  }

  /**
   * Sends a streaming completion request.
   *
   * If the server returns a non-streaming response (the stream flag was
   * ignored), it is parsed as a plain JSON completion.
   *
   * @param rawRequest - The completion request.
   * @param callbacks - Callbacks for live text and reasoning deltas.
   * @returns The parsed and normalized completion.
   */
  async stream(rawRequest: ModelCompletionRequest, callbacks: ModelStreamCallbacks): Promise<ModelCompletion> {
    const request = parseModelCompletionRequest(rawRequest);
    const response = await fetchModelResponse(this.requestOptions(request, true));
    if (!isEventStreamResponse(response)) {
      // OpenAI-compatible servers may ignore the stream flag and answer with
      // one plain JSON completion; treat that as a valid non-streamed turn.
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new ModelDriverResponseError(this.id, `${this.id} returned invalid JSON`);
      }
      return this.parseCompletionPayload(payload, request.model);
    }

    let id: string | null = null;
    let model: string | null = null;
    let text = "";
    let refusal = "";
    let rawFinishReason: string | null = null;
    let usage: z.infer<typeof openAiUsageSchema> | null = null;
    const toolCalls = new Map<number, { id: string | null; name: string; arguments: string }>();
    for await (const event of readServerSentEvents(response, this.id)) {
      const data = event.data.trim();
      if (!data || data === "[DONE]") continue;
      let chunkPayload: unknown;
      try {
        chunkPayload = JSON.parse(data) as unknown;
      } catch {
        throw new ModelDriverResponseError(this.id, `${this.id} returned an invalid stream chunk`);
      }
      const chunk = openAiStreamChunkSchema.safeParse(chunkPayload);
      if (!chunk.success) throw responseValidationError(this.id, chunk.error.issues, [this.config.apiKey]);
      if (chunk.data.id) id ??= chunk.data.id;
      if (chunk.data.model) model ??= chunk.data.model;
      if (chunk.data.usage) usage = chunk.data.usage;
      const choice = chunk.data.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) rawFinishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        callbacks.onTextDelta?.(delta.content);
      }
      if (typeof delta.refusal === "string" && delta.refusal) refusal += delta.refusal;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        callbacks.onReasoningDelta?.(delta.reasoning_content);
      }
      for (const call of delta.tool_calls ?? []) {
        const slot = toolCalls.get(call.index) ?? { id: null, name: "", arguments: "" };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name += call.function.name;
        if (call.function?.arguments) slot.arguments += call.function.arguments;
        toolCalls.set(call.index, slot);
      }
    }

    const content: ModelContent[] = [];
    if (text) content.push({ type: "text", text });
    if (!text && refusal) content.push({ type: "text", text: refusal });
    for (const [, call] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
      if (!call.id || !call.name) {
        throw new ModelDriverResponseError(this.id, `${this.id} streamed an incomplete tool call`);
      }
      content.push({
        type: "tool-call",
        id: call.id,
        name: call.name,
        ...parseArguments(call.arguments || "{}"),
      });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    return modelCompletionSchema.parse({
      id,
      model: model ?? request.model,
      message: { role: "assistant", content },
      finishReason: finishReason(rawFinishReason),
      rawFinishReason,
      usage: mapOpenAiUsage(usage),
    });
  }

  /**
   * Builds the fetch options for a completion request.
   */
  private requestOptions(request: ReturnType<typeof parseModelCompletionRequest>, stream: boolean) {
    const tools = request.toolChoice === "none" ? [] : (request.tools ?? []);
    return {
      fetch: this.fetch,
      url: endpoint(this.config.baseUrl),
      providerId: this.id,
      secrets: [this.config.apiKey],
      maxRetries: this.config.maxRetries,
      signal: request.signal,
      init: {
        method: "POST",
        headers: {
          ...this.config.defaultHeaders,
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: toOpenAiChatMessages(request.messages),
          ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
          ...(tools.length && request.toolChoice ? { tool_choice: toOpenAiToolChoice(request.toolChoice) } : {}),
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
      },
    };
  }

  /**
   * Parses a non-streaming completion payload into the canonical format.
   */
  private parseCompletionPayload(payload: unknown, requestModel: string): ModelCompletion {
    const parsed = openAiCompletionSchema.safeParse(payload);
    if (!parsed.success) throw responseValidationError(this.id, parsed.error.issues, [this.config.apiKey]);
    const choice = parsed.data.choices[0]!;
    const content: ModelContent[] = [];
    const text = responseText(choice.message.content);
    if (text) content.push({ type: "text", text });
    if (!text && choice.message.refusal) content.push({ type: "text", text: choice.message.refusal });
    for (const call of choice.message.tool_calls ?? []) {
      content.push({
        type: "tool-call",
        id: call.id,
        name: call.function.name,
        ...parseArguments(call.function.arguments),
      });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    return modelCompletionSchema.parse({
      id: parsed.data.id ?? null,
      model: parsed.data.model ?? requestModel,
      message: { role: "assistant", content },
      finishReason: finishReason(choice.finish_reason),
      rawFinishReason: choice.finish_reason ?? null,
      usage: mapOpenAiUsage(parsed.data.usage),
    });
  }
}
