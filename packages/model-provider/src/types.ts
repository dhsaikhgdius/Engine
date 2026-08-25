// @director/model-provider — unified model provider abstraction.
// A ModelProvider wraps any LLM API (OpenAI, DeepSeek, Claude, Gemini, Qwen, Ollama, …)
// behind a single interface so the agent harness can hot-swap models at runtime.

import type { ModelCompletion, ModelCompletionRequest, ModelStreamCallbacks, ModelUsage } from "./runtime/modelDriver";

// Re-export the existing model driver types for compatibility.
export type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelMessage,
  ModelContent,
  ModelTextContent,
  ModelImageContent,
  ModelToolCallContent,
  ModelToolResultContent,
  ModelTool,
  ModelToolChoice,
  ModelFinishReason,
  ModelUsage,
  ModelStreamCallbacks,
  ModelDriverKind,
} from "./runtime/modelDriver";

// ---- Provider metadata ----

/** Provider-level capabilities advertised at registration time. */
export interface ModelProviderCapabilities {
  /** Whether the provider supports function/tool calling. */
  tools: boolean;
  /** Whether the provider accepts image inputs. */
  images: boolean;
  /** Whether the provider can stream deltas. */
  streaming: boolean;
  /** Whether the provider emits reasoning/thinking tokens. */
  reasoning: boolean;
  /** Maximum context window in tokens (0 = unknown). */
  maxContextTokens: number;
  /** Maximum output tokens per completion (0 = unknown). */
  maxOutputTokens: number;
}

/** Pricing estimate (USD per 1M tokens). May be approximate. */
export interface ModelProviderPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cached/prompt-cached input tokens per million. */
  cacheReadPerMillion?: number;
}

/** Identifies a specific model variant. */
export interface ModelDescriptor {
  /** Provider family, e.g. "deepseek", "openai", "anthropic". */
  provider: string;
  /** Model name as the API expects it, e.g. "deepseek-chat", "gpt-4o". */
  model: string;
  /** Human-readable label, e.g. "DeepSeek V3". */
  label: string;
  /** Capabilities of this model variant. */
  capabilities: ModelProviderCapabilities;
  /** Approximate pricing (USD / 1M tokens). */
  pricing?: ModelProviderPricing;
}

// ---- High-level chat API ----

/** A single chat message in the high-level API. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for a single chat completion request. */
export interface ChatOptions {
  /** Model to use (defaults to the provider's default). */
  model?: string;
  /** Maximum output tokens. */
  maxTokens?: number;
  /** Sampling temperature 0-2. */
  temperature?: number;
  /** Stop sequences. */
  stopSequences?: string[];
  /** Abort signal. */
  signal?: AbortSignal;
  /** Tools available to the model. */
  tools?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
  /** Force a specific tool choice. */
  toolChoice?: "auto" | "required" | "none" | { type: "tool"; name: string };
  /** System prompt. */
  system?: string;
}

/** A chunk emitted during streaming. */
export interface ChatChunk {
  /** Text delta. */
  delta: string;
  /** Reasoning/thinking delta (when available). */
  reasoningDelta?: string;
  /** Tool calls extracted from this chunk. */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** Why the stream ended. */
  finishReason?: "stop" | "tool_calls" | "length" | "content-filter" | "error";
}

/** Result of a complete chat. */
export interface ChatResult {
  /** Full assistant message text. */
  content: string;
  /** Tool calls from the assistant. */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Finish reason. */
  finishReason: "stop" | "tool_calls" | "length" | "content-filter" | "error";
  /** Token usage. */
  usage?: ModelUsage;
}

// ---- ModelProvider interface ----

/**
 * A ModelProvider wraps a specific LLM API.
 *
 * Every provider exposes:
 * - `complete()` — the low-level API compatible with the existing ModelDriver
 * - `chat()` — a high-level convenience API for simple text conversations
 * - `stream()` — a streaming variant of chat()
 * - `descriptor` — static metadata about the model
 */
export interface ModelProvider {
  /** Unique provider id, e.g. "deepseek/deepseek-chat". */
  readonly id: string;

  /** Static metadata. */
  readonly descriptor: ModelDescriptor;

  /**
   * Low-level completion API (compatible with existing ModelDriver).
   * Returns the canonical completion object.
   */
  complete(request: ModelCompletionRequest): Promise<ModelCompletion>;

  /**
   * Stream a completion with live deltas.
   * Returns the canonical completion when the stream ends.
   */
  stream?(request: ModelCompletionRequest, callbacks: ModelStreamCallbacks): Promise<ModelCompletion>;

  /**
   * High-level chat: send messages and get a completion.
   * This is the simplest API for agent use.
   */
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;

  /**
   * High-level streaming chat: send messages and receive deltas.
   */
  streamChat?(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatChunk>;

  /** Human-readable label for logging. */
  readonly label: string;
}

// ---- Provider factory ----

/** Configuration for creating a provider. */
export interface ModelProviderConfig {
  /** API base URL (e.g. "https://api.deepseek.com/v1"). */
  baseUrl: string;
  /** API key. */
  apiKey: string;
  /** Default model name. */
  model?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum retries on transient errors. */
  maxRetries?: number;
}

/** A factory function that creates a ModelProvider from config. */
export type ModelProviderFactory = (config: ModelProviderConfig) => ModelProvider;
