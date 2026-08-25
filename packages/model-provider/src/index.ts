/**
 * @director/model-provider — barrel export.
 *
 * Re-exports the model provider registry, types, and all built-in provider
 * factories in a single import target.
 *
 * @module @director/model-provider
 */

export * from "./types";
export * from "./registry";
export * from "./runtime";
export {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_MODEL_PROVIDER_PROFILES,
  createBuiltinModelProvider,
  findBuiltinModelDescriptor,
  getBuiltinModelProviderProfile,
  registerBuiltinModelProviders,
  type BuiltinModelProviderId,
  type BuiltinModelProviderProfile,
} from "./builtinProviders";

// Provider factories
export { createOpenAiCompatibleProvider } from "./providers/openai-compatible";
export {
  createDeepSeekProvider,
  createDeepSeekR1Provider,
  DEEPSEEK_DESCRIPTOR,
  DEEPSEEK_R1_DESCRIPTOR,
} from "./providers/deepseek";
export {
  createOpenAiProvider,
  OPENAI_GPT4O_DESCRIPTOR,
  OPENAI_O3_DESCRIPTOR,
  OPENAI_O4_MINI_DESCRIPTOR,
} from "./providers/openai";
export { createAnthropicProvider, CLAUDE_SONNET_DESCRIPTOR, CLAUDE_OPUS_DESCRIPTOR } from "./providers/anthropic";
export { createGeminiProvider, GEMINI_PRO_DESCRIPTOR, GEMINI_FLASH_DESCRIPTOR } from "./providers/gemini";
export { createQwenProvider, QWEN3_DESCRIPTOR, QWEN_MAX_DESCRIPTOR } from "./providers/qwen";
export { createOllamaProvider, OLLAMA_DESCRIPTOR } from "./providers/ollama";
