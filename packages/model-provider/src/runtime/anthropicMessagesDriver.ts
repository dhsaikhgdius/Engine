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
} from "./modelDriver";
import {
  fetchModelJson,
  fetchModelResponse,
  isEventStreamResponse,
  ModelDriverResponseError,
  readServerSentEvents,
  redactModelDriverText,
  responseValidationError,
  type FetchImplementation,
} from "./http";

type JsonRecord = Record<string, unknown>;

/** Schema for an Anthropic text content block. */
const anthropicTextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
/** Schema for an Anthropic tool_use content block. */
const anthropicToolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(160),
  input: jsonValueSchema,
});
/** Schema for any other Anthropic content block type. */
const anthropicOtherBlockSchema = z.looseObject({
  type: z.string().refine((type) => type !== "text" && type !== "tool_use"),
});

/** Schema for an Anthropic Messages API completion. */
const anthropicCompletionSchema = z.looseObject({
  id: z.string(),
  type: z.literal("message").optional(),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.union([anthropicTextBlockSchema, anthropicToolUseBlockSchema, anthropicOtherBlockSchema])),
  stop_reason: z.string().nullable(),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
  }),
});

/** Schema for usage in an Anthropic stream event. */
const anthropicStreamUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

/** Schema for a single Anthropic SSE stream event. */
const anthropicStreamEventSchema = z.looseObject({
  type: z.string(),
  index: z.number().int().nonnegative().optional(),
  message: z
    .looseObject({
      id: z.string().optional(),
      model: z.string().optional(),
      usage: anthropicStreamUsageSchema.optional(),
    })
    .optional(),
  content_block: z
    .looseObject({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  delta: z
    .looseObject({
      type: z.string().optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
      thinking: z.string().optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
  usage: anthropicStreamUsageSchema.optional(),
  error: z.looseObject({ type: z.string().optional(), message: z.string().optional() }).optional(),
});

/**
 * Internal representation of a content block being assembled from stream events.
 */
type AnthropicStreamBlock =
  { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string } | { type: "other" };

/**
 * Configuration for the Anthropic Messages API driver.
 */
export type AnthropicMessagesDriverConfig = {
  /** Stable driver id. */
  id: string;
  /** The Anthropic API key. */
  apiKey: string;
  /** Base URL for the Messages API (defaults to `https://api.anthropic.com/v1`). */
  baseUrl?: string;
  /** The `anthropic-version` header value (defaults to `"2023-06-01"`). */
  apiVersion?: string;
  /** Optional beta header value. */
  beta?: string;
  /** Default max output tokens when not specified in the request. */
  defaultMaxOutputTokens?: number;
  /** Additional headers to include in every request. */
  defaultHeaders?: Record<string, string>;
  /** Maximum number of retries for 429/5xx errors (default 2). */
  maxRetries?: number;
  /** Called once per retry attempt, so callers can meter retry counts. */
  onRetry?: () => void;
  /** Custom fetch implementation for testing. */
  fetch?: FetchImplementation;
};

/**
 * Normalizes the base URL to the Messages API endpoint.
 */
function endpoint(baseUrl: string) {
  return baseUrl.endsWith("/messages") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/messages`;
}

/**
 * Converts a canonical image source to the Anthropic format.
 */
function imageSource(image: ModelImageContent) {
  return image.source.type === "url"
    ? { type: "url", url: image.source.url }
    : { type: "base64", media_type: image.source.mediaType, data: image.source.data };
}

/**
 * Returns the structured arguments for a tool call.
 */
function toolArguments(item: Extract<ModelContent, { type: "tool-call" }>) {
  return item.arguments ?? {};
}

/**
 * Converts a canonical message to Anthropic content blocks.
 */
function toAnthropicContent(message: ModelMessage): JsonRecord[] {
  return message.content.map((item): JsonRecord => {
    if (item.type === "text") return { type: "text", text: item.text };
    if (item.type === "image") return { type: "image", source: imageSource(item) };
    if (item.type === "tool-call") {
      return { type: "tool_use", id: item.id, name: item.name, input: toolArguments(item) };
    }
    return {
      type: "tool_result",
      tool_use_id: item.toolCallId,
      content: item.content.map((result) =>
        result.type === "text" ? { type: "text", text: result.text } : { type: "image", source: imageSource(result) },
      ),
      ...(item.isError !== undefined ? { is_error: item.isError } : {}),
    };
  });
}

/**
 * Maps canonical messages to the Anthropic Messages API wire format.
 *
 * Anthropic has a top-level `system` field (not a message role) and requires
 * alternating `user`/`assistant` messages. Consecutive messages with the same
 * role are merged.
 *
 * @param messages - The canonical model messages.
 * @returns The system blocks and alternating user/assistant messages.
 */
export function toAnthropicMessages(messages: readonly ModelMessage[]) {
  const system: JsonRecord[] = [];
  const wireMessages: Array<{ role: "user" | "assistant"; content: JsonRecord[] }> = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(...toAnthropicContent(message));
      continue;
    }
    const content = toAnthropicContent(message);
    const previous = wireMessages.at(-1);
    if (previous?.role === message.role) previous.content.push(...content);
    else wireMessages.push({ role: message.role, content });
  }
  return { system, messages: wireMessages };
}

/**
 * Converts canonical tools to the Anthropic format.
 */
function toAnthropicTools(tools: readonly ModelTool[]): JsonRecord[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.inputSchema,
  }));
}

/**
 * Marks the last block as a prompt-cache breakpoint.
 *
 * Agent tool loops resend the full prefix (tools, system, history) on every
 * round, so breakpoints at the end of each section let the provider reuse the
 * processed prefix instead of re-reading it, which is the dominant per-round
 * latency cost.
 */
function withTrailingCacheControl(blocks: readonly JsonRecord[]): JsonRecord[] {
  return blocks.map((block, index) =>
    index === blocks.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
  );
}

/**
 * Converts a canonical tool choice to the Anthropic format.
 */
function toAnthropicToolChoice(choice: ModelToolChoice | undefined) {
  if (!choice || choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return undefined;
  return { type: "tool", name: choice.name };
}

/**
 * Maps an Anthropic stop reason to the canonical {@link ModelFinishReason}.
 */
function finishReason(raw: string | null): ModelFinishReason {
  if (raw === "end_turn" || raw === "stop_sequence") return "stop";
  if (raw === "max_tokens") return "length";
  if (raw === "tool_use") return "tool-calls";
  if (raw === "pause_turn") return "pause";
  if (raw === "refusal") return "content-filter";
  return "other";
}

/**
 * An Anthropic Messages API driver.
 *
 * Implements both `complete` and `stream` — the stream method handles the
 * case where the server ignores the `stream` flag and returns a plain JSON
 * message instead.
 */
export class AnthropicMessagesDriver implements ModelDriver {
  /** Always `"anthropic-messages"`. */
  readonly kind = "anthropic-messages" as const;
  /** The driver id from configuration. */
  readonly id: string;
  /** The fetch implementation to use. */
  private readonly fetch: FetchImplementation;

  /**
   * @param config - The driver configuration.
   */
  constructor(private readonly config: AnthropicMessagesDriverConfig) {
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
    return this.parseCompletionPayload(payload);
  }

  /**
   * Sends a streaming completion request.
   *
   * If the server returns a non-streaming response, it is parsed as a plain
   * JSON message.
   *
   * @param rawRequest - The completion request.
   * @param callbacks - Callbacks for live text and reasoning deltas.
   * @returns The parsed and normalized completion.
   */
  async stream(rawRequest: ModelCompletionRequest, callbacks: ModelStreamCallbacks): Promise<ModelCompletion> {
    const request = parseModelCompletionRequest(rawRequest);
    const response = await fetchModelResponse(this.requestOptions(request, true));
    if (!isEventStreamResponse(response)) {
      // Anthropic-compatible proxies may ignore the stream flag and answer
      // with one plain JSON message; treat that as a valid non-streamed turn.
      const body = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new ModelDriverResponseError(this.id, `${this.id} returned invalid JSON`);
      }
      return this.parseCompletionPayload(payload);
    }

    let id: string | null = null;
    let model: string | null = null;
    let rawStopReason: string | null = null;
    let inputUsage: z.infer<typeof anthropicStreamUsageSchema> | null = null;
    let outputTokens: number | null = null;
    const blocks = new Map<number, AnthropicStreamBlock>();
    for await (const streamEvent of readServerSentEvents(response, this.id)) {
      const data = streamEvent.data.trim();
      if (!data) continue;
      let eventPayload: unknown;
      try {
        eventPayload = JSON.parse(data) as unknown;
      } catch {
        throw new ModelDriverResponseError(this.id, `${this.id} returned an invalid stream event`);
      }
      const event = anthropicStreamEventSchema.safeParse(eventPayload);
      if (!event.success) throw responseValidationError(this.id, event.error.issues, [this.config.apiKey]);
      const value = event.data;
      if (value.type === "error") {
        throw new ModelDriverResponseError(
          this.id,
          redactModelDriverText(`${this.id} stream failed: ${value.error?.message ?? "unknown provider error"}`, [
            this.config.apiKey,
          ]),
        );
      }
      if (value.type === "message_start") {
        id = value.message?.id ?? id;
        model = value.message?.model ?? model;
        inputUsage = value.message?.usage ?? inputUsage;
        outputTokens = value.message?.usage?.output_tokens ?? outputTokens;
      } else if (value.type === "content_block_start" && value.index !== undefined) {
        const block = value.content_block;
        if (block?.type === "text") {
          const text = block.text ?? "";
          blocks.set(value.index, { type: "text", text });
          if (text) callbacks.onTextDelta?.(text);
        } else if (block?.type === "tool_use") {
          if (!block.id || !block.name) {
            throw new ModelDriverResponseError(this.id, `${this.id} streamed an incomplete tool_use block`);
          }
          blocks.set(value.index, { type: "tool_use", id: block.id, name: block.name, json: "" });
        } else {
          blocks.set(value.index, { type: "other" });
        }
      } else if (value.type === "content_block_delta" && value.index !== undefined) {
        const block = blocks.get(value.index);
        const delta = value.delta;
        if (!delta) continue;
        if (delta.type === "text_delta" && typeof delta.text === "string" && block?.type === "text") {
          block.text += delta.text;
          if (delta.text) callbacks.onTextDelta?.(delta.text);
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          block?.type === "tool_use"
        ) {
          block.json += delta.partial_json;
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          callbacks.onReasoningDelta?.(delta.thinking);
        }
      } else if (value.type === "message_delta") {
        if (value.delta?.stop_reason) rawStopReason = value.delta.stop_reason;
        if (value.usage?.output_tokens !== undefined) outputTokens = value.usage.output_tokens;
      } else if (value.type === "message_stop") {
        break;
      }
    }

    const content: ModelContent[] = [];
    for (const [, block] of [...blocks.entries()].sort(([left], [right]) => left - right)) {
      if (block.type === "text") {
        if (block.text) content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        let input: unknown;
        try {
          input = JSON.parse(block.json || "{}") as unknown;
        } catch {
          throw new ModelDriverResponseError(this.id, `${this.id} streamed invalid tool_use JSON`);
        }
        const parsedInput = jsonValueSchema.parse(input);
        content.push({
          type: "tool-call",
          id: block.id,
          name: block.name,
          arguments: parsedInput,
          rawArguments: JSON.stringify(parsedInput),
        });
      }
    }
    if (!content.length) content.push({ type: "text", text: "" });
    const usage =
      inputUsage?.input_tokens !== undefined
        ? {
            inputTokens: inputUsage.input_tokens,
            outputTokens: outputTokens ?? 0,
            totalTokens:
              inputUsage.input_tokens +
              (inputUsage.cache_read_input_tokens ?? 0) +
              (inputUsage.cache_creation_input_tokens ?? 0) +
              (outputTokens ?? 0),
            ...(inputUsage.cache_read_input_tokens !== undefined
              ? { cacheReadInputTokens: inputUsage.cache_read_input_tokens }
              : {}),
            ...(inputUsage.cache_creation_input_tokens !== undefined
              ? { cacheWriteInputTokens: inputUsage.cache_creation_input_tokens }
              : {}),
          }
        : null;
    return modelCompletionSchema.parse({
      id,
      model: model ?? request.model,
      message: { role: "assistant", content },
      finishReason: finishReason(rawStopReason),
      rawFinishReason: rawStopReason,
      usage,
    });
  }

  /**
   * Builds the fetch options for a completion request.
   *
   * Applies trailing cache-control breakpoints to the system blocks, tools,
   * and the last message for Anthropic prompt caching.
   */
  private requestOptions(request: ReturnType<typeof parseModelCompletionRequest>, stream: boolean) {
    const mapped = toAnthropicMessages(request.messages);
    const tools = request.toolChoice === "none" ? [] : (request.tools ?? []);
    const toolChoice = toAnthropicToolChoice(request.toolChoice);
    const system = withTrailingCacheControl(mapped.system);
    const wireTools = withTrailingCacheControl(toAnthropicTools(tools));
    const messages = mapped.messages.map((message, index) =>
      index === mapped.messages.length - 1
        ? { ...message, content: withTrailingCacheControl(message.content) }
        : message,
    );
    return {
      fetch: this.fetch,
      url: endpoint(this.config.baseUrl ?? "https://api.anthropic.com/v1"),
      providerId: this.id,
      secrets: [this.config.apiKey],
      maxRetries: this.config.maxRetries,
      onRetry: this.config.onRetry,
      signal: request.signal,
      init: {
        method: "POST",
        headers: {
          ...this.config.defaultHeaders,
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": this.config.apiVersion ?? "2023-06-01",
          ...(this.config.beta ? { "anthropic-beta": this.config.beta } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens ?? this.config.defaultMaxOutputTokens ?? 4_096,
          ...(system.length ? { system } : {}),
          messages,
          ...(wireTools.length ? { tools: wireTools } : {}),
          ...(wireTools.length && toolChoice ? { tool_choice: toolChoice } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.stopSequences?.length ? { stop_sequences: request.stopSequences } : {}),
          ...(stream ? { stream: true } : {}),
        }),
      },
    };
  }

  /**
   * Parses a non-streaming completion payload into the canonical format.
   */
  private parseCompletionPayload(payload: unknown): ModelCompletion {
    const parsed = anthropicCompletionSchema.safeParse(payload);
    if (!parsed.success) throw responseValidationError(this.id, parsed.error.issues, [this.config.apiKey]);
    const content: ModelContent[] = [];
    for (const block of parsed.data.content) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "tool_use" &&
        "id" in block &&
        typeof block.id === "string" &&
        "name" in block &&
        typeof block.name === "string" &&
        "input" in block
      ) {
        const input = jsonValueSchema.parse(block.input);
        content.push({
          type: "tool-call",
          id: block.id,
          name: block.name,
          arguments: input,
          rawArguments: JSON.stringify(input),
        });
      }
    }
    if (!content.length) content.push({ type: "text", text: "" });
    const usage = {
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
      totalTokens:
        parsed.data.usage.input_tokens +
        (parsed.data.usage.cache_read_input_tokens ?? 0) +
        (parsed.data.usage.cache_creation_input_tokens ?? 0) +
        parsed.data.usage.output_tokens,
      ...(parsed.data.usage.cache_read_input_tokens !== undefined
        ? { cacheReadInputTokens: parsed.data.usage.cache_read_input_tokens }
        : {}),
      ...(parsed.data.usage.cache_creation_input_tokens !== undefined
        ? { cacheWriteInputTokens: parsed.data.usage.cache_creation_input_tokens }
        : {}),
    };
    return modelCompletionSchema.parse({
      id: parsed.data.id,
      model: parsed.data.model,
      message: { role: "assistant", content },
      finishReason: finishReason(parsed.data.stop_reason),
      rawFinishReason: parsed.data.stop_reason,
      usage,
    });
  }
}
