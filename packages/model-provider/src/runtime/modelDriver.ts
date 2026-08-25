import { z } from "zod";

/**
 * A JSON value — the canonical recursive type for tool arguments and
 * structured data within the model driver layer.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Zod schema for {@link JsonValue}. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Helper for non-empty trimmed strings with a max length. */
const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Zod schema for a text content block. */
export const modelTextContentSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
});

/** Zod schema for an image source — either base64 data or a URL. */
export const modelImageSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("base64"),
    mediaType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
    data: nonEmptyText(100_000_000),
  }),
  z.strictObject({
    type: z.literal("url"),
    url: z.string().url().max(16_384),
  }),
]);

/** Zod schema for an image content block. */
export const modelImageContentSchema = z.strictObject({
  type: z.literal("image"),
  source: modelImageSourceSchema,
  detail: z.enum(["auto", "low", "high"]).optional(),
});

/** Zod schema for a tool-call content block. */
export const modelToolCallContentSchema = z.strictObject({
  type: z.literal("tool-call"),
  id: nonEmptyText(240),
  name: nonEmptyText(160),
  arguments: jsonValueSchema.nullable(),
  /**
   * Exact provider input. Present when the provider supplied a serialized
   * argument string rather than a structured object.
   */
  rawArguments: z.string().max(2_000_000).optional(),
  /**
   * Stable parser error code; never contains the raw argument payload.
   * Only `"invalid_json"` is currently defined.
   */
  parseError: z.enum(["invalid_json"]).optional(),
});

/** Zod schema for a single item within a tool result. */
export const modelToolResultItemSchema = z.discriminatedUnion("type", [
  modelTextContentSchema,
  modelImageContentSchema,
]);

/** Zod schema for a tool-result content block. */
export const modelToolResultContentSchema = z.strictObject({
  type: z.literal("tool-result"),
  toolCallId: nonEmptyText(240),
  name: nonEmptyText(160).optional(),
  content: z.array(modelToolResultItemSchema).min(1).max(256),
  /** When `true`, the tool call produced an error. */
  isError: z.boolean().optional(),
});

/** Zod schema for all content types, discriminated by `type`. */
export const modelContentSchema = z.discriminatedUnion("type", [
  modelTextContentSchema,
  modelImageContentSchema,
  modelToolCallContentSchema,
  modelToolResultContentSchema,
]);

/**
 * Zod schema for a model message, with superRefine validation that enforces
 * role-appropriate content types:
 *
 * - `system` — text only.
 * - `assistant` — text and tool-call.
 * - `user` — text, image, and tool-result.
 */
export const modelMessageSchema = z
  .strictObject({
    role: z.enum(["system", "user", "assistant"]),
    content: z.array(modelContentSchema).min(1).max(512),
  })
  .superRefine((message, context) => {
    for (const [index, item] of message.content.entries()) {
      const allowed =
        message.role === "system"
          ? item.type === "text"
          : message.role === "assistant"
            ? item.type === "text" || item.type === "tool-call"
            : item.type === "text" || item.type === "image" || item.type === "tool-result";
      if (!allowed) {
        context.addIssue({
          code: "custom",
          path: ["content", index],
          message: `${item.type} content is not valid for the ${message.role} role`,
        });
      }
    }
  });

/** Zod schema for a provider-neutral function tool definition using JSON Schema. */
export const modelToolSchema = z.strictObject({
  name: nonEmptyText(160),
  description: z.string().max(32_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** When `true`, the model must strictly adhere to the schema. */
  strict: z.boolean().optional(),
});

/** Zod schema for the tool choice directive. */
export const modelToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.strictObject({
    type: z.literal("tool"),
    name: nonEmptyText(160),
  }),
]);

/** Zod schema for the model completion input (without the runtime signal). */
export const modelCompletionInputSchema = z.strictObject({
  model: nonEmptyText(320),
  messages: z.array(modelMessageSchema).min(1).max(20_000),
  tools: z.array(modelToolSchema).max(1_000).optional(),
  toolChoice: modelToolChoiceSchema.optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  stopSequences: z.array(nonEmptyText(1_000)).max(32).optional(),
});

/** Zod schema for the canonical finish reason. */
export const modelFinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "pause",
  "error",
  "other",
]);

/** Zod schema for token usage statistics. */
export const modelUsageSchema = z.strictObject({
  /** Prompt tokens processed at the normal input rate, excluding cache reads and writes. */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** All prompt-side buckets plus output tokens. */
  totalTokens: z.number().int().nonnegative(),
  /** Tokens read from the provider's prompt cache. */
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  /** Tokens written to the provider's prompt cache. */
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  /** Tokens consumed by reasoning/thinking output. */
  reasoningTokens: z.number().int().nonnegative().optional(),
});

/** Zod schema for a model completion. */
export const modelCompletionSchema = z.strictObject({
  id: z.string().nullable(),
  model: z.string().nullable(),
  message: modelMessageSchema,
  finishReason: modelFinishReasonSchema,
  /** The raw provider finish reason before normalization. */
  rawFinishReason: z.string().nullable(),
  usage: modelUsageSchema.nullable(),
});

/** A text content block within a model message. */
export type ModelTextContent = z.infer<typeof modelTextContentSchema>;
/** An image content block within a model message. */
export type ModelImageContent = z.infer<typeof modelImageContentSchema>;
/** A tool-call content block within a model message. */
export type ModelToolCallContent = z.infer<typeof modelToolCallContentSchema>;
/** A tool-result content block within a model message. */
export type ModelToolResultContent = z.infer<typeof modelToolResultContentSchema>;
/** Any content block within a model message. */
export type ModelContent = z.infer<typeof modelContentSchema>;
/** A model message with a role and content blocks. */
export type ModelMessage = z.infer<typeof modelMessageSchema>;
/** A provider-neutral function tool definition. */
export type ModelTool = z.infer<typeof modelToolSchema>;
/** A tool choice directive. */
export type ModelToolChoice = z.infer<typeof modelToolChoiceSchema>;
/** The input to a model completion. */
export type ModelCompletionInput = z.infer<typeof modelCompletionInputSchema>;
/** The canonical finish reason. */
export type ModelFinishReason = z.infer<typeof modelFinishReasonSchema>;
/** Token usage statistics. */
export type ModelUsage = z.infer<typeof modelUsageSchema>;
/** A model completion result. */
export type ModelCompletion = z.infer<typeof modelCompletionSchema>;

/**
 * A model completion request — the canonical input, plus an optional
 * AbortSignal for cancellation.
 */
export type ModelCompletionRequest = ModelCompletionInput & {
  signal?: AbortSignal;
};

/**
 * The kind of model driver, used to select the appropriate wire format.
 *
 * - `openai-chat-compatible` — uses the Chat Completions API shape.
 * - `anthropic-messages` — uses the Messages API shape.
 */
export type ModelDriverKind = "openai-chat-compatible" | "anthropic-messages";

/**
 * Callbacks for streaming model output.
 */
export type ModelStreamCallbacks = {
  /** Live assistant text exactly as the provider emits it. */
  onTextDelta?: (delta: string) => void;
  /** Live reasoning/thinking text when the provider exposes it. */
  onReasoningDelta?: (delta: string) => void;
};

/**
 * The model driver interface — a provider-neutral abstraction over model
 * completion APIs.
 *
 * Every driver has a `complete` method; drivers that support streaming
 * also expose a `stream` method that resolves to the same canonical
 * completion shape.
 */
export interface ModelDriver {
  /** Stable driver id, typically the profile id. */
  readonly id: string;
  /** The driver kind, which determines the wire format. */
  readonly kind: ModelDriverKind;
  /**
   * Sends a completion request and returns the canonical result.
   *
   * @param request - The completion request.
   * @returns The parsed and normalized completion.
   */
  complete(request: ModelCompletionRequest): Promise<ModelCompletion>;
  /**
   * Streams live deltas and resolves with the same canonical completion as
   * {@link complete}. Providers that ignore the stream flag are handled by
   * falling back to their single JSON completion.
   *
   * @param request - The completion request.
   * @param callbacks - Callbacks for live text and reasoning deltas.
   * @returns The parsed and normalized completion.
   */
  stream?(request: ModelCompletionRequest, callbacks: ModelStreamCallbacks): Promise<ModelCompletion>;
}

/**
 * Parses and validates a model completion request, stripping the runtime
 * signal before validation.
 *
 * @param request - The raw request with an optional signal.
 * @returns The validated input with the signal reattached.
 * @throws {@link ZodError} When the request is invalid.
 */
export function parseModelCompletionRequest(request: ModelCompletionRequest) {
  const { signal, ...input } = request;
  return { ...modelCompletionInputSchema.parse(input), signal };
}
