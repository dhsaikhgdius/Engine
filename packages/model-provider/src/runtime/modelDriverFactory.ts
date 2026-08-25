import { AnthropicMessagesDriver, type AnthropicMessagesDriverConfig } from "./anthropicMessagesDriver";
import type { ModelDriver } from "./modelDriver";
import { OpenAiChatDriver, type OpenAiChatDriverConfig } from "./openAiChatDriver";

export type ModelDriverConfig =
  | ({ kind: "openai-chat-compatible" } & OpenAiChatDriverConfig)
  | ({ kind: "anthropic-messages" } & AnthropicMessagesDriverConfig);

/** Creates a canonical wire Driver from one discriminated configuration. */
export function createModelDriver(config: ModelDriverConfig): ModelDriver {
  return config.kind === "anthropic-messages" ? new AnthropicMessagesDriver(config) : new OpenAiChatDriver(config);
}
