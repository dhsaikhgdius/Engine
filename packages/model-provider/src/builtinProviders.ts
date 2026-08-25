import type { ModelDescriptor, ModelProvider, ModelProviderConfig, ModelProviderFactory } from "./types";
import type { ModelProviderRegistry, RegisteredProvider } from "./registry";
import { createModelDriver } from "./runtime/modelDriverFactory";
import { createModelDriverProvider } from "./providers/modelDriverProvider";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible";

type BuiltinProviderProtocol = "openai-chat-compatible" | "anthropic-messages";

type BuiltinProviderDefinition<Id extends string> = {
  id: Id;
  protocol: BuiltinProviderProtocol;
  descriptor: ModelDescriptor;
  models: readonly ModelDescriptor[];
  defaultBaseUrl: string;
  apiKeyEnvironmentVariable: string;
  fallbackApiKey?: string;
  defaultHeaders?: (config: ModelProviderConfig) => Record<string, string>;
  descriptorLabel?: (model: string) => string;
  providerLabel?: (model: string) => string;
};

/** Complete metadata and construction entry for one built-in provider family. */
export interface BuiltinModelProviderProfile extends RegisteredProvider {
  readonly id: string;
  readonly protocol: BuiltinProviderProtocol;
  readonly models: readonly ModelDescriptor[];
  readonly defaultBaseUrl: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly fallbackApiKey?: string;
}

export const DEEPSEEK_DESCRIPTOR = {
  provider: "deepseek",
  model: "deepseek-chat",
  label: "DeepSeek V3",
  capabilities: {
    tools: true,
    images: false,
    streaming: true,
    reasoning: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
  },
  pricing: {
    inputPerMillion: 0.27,
    outputPerMillion: 1.1,
    cacheReadPerMillion: 0.07,
  },
} as const satisfies ModelDescriptor;

export const DEEPSEEK_R1_DESCRIPTOR = {
  provider: "deepseek",
  model: "deepseek-reasoner",
  label: "DeepSeek R1",
  capabilities: {
    tools: false,
    images: false,
    streaming: true,
    reasoning: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
  },
  pricing: {
    inputPerMillion: 0.55,
    outputPerMillion: 2.19,
    cacheReadPerMillion: 0.14,
  },
} as const satisfies ModelDescriptor;

export const OPENAI_GPT4O_DESCRIPTOR = {
  provider: "openai",
  model: "gpt-4o",
  label: "GPT-4o",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
  },
  pricing: {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cacheReadPerMillion: 1.25,
  },
} as const satisfies ModelDescriptor;

export const OPENAI_O3_DESCRIPTOR = {
  provider: "openai",
  model: "o3",
  label: "o3",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 100_000,
  },
  pricing: {
    inputPerMillion: 10,
    outputPerMillion: 40,
    cacheReadPerMillion: 2.5,
  },
} as const satisfies ModelDescriptor;

export const OPENAI_O4_MINI_DESCRIPTOR = {
  provider: "openai",
  model: "o4-mini",
  label: "o4-mini",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 100_000,
  },
  pricing: {
    inputPerMillion: 1.1,
    outputPerMillion: 4.4,
    cacheReadPerMillion: 0.275,
  },
} as const satisfies ModelDescriptor;

export const CLAUDE_SONNET_DESCRIPTOR = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  label: "Claude 4 Sonnet",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 16_384,
  },
  pricing: {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
  },
} as const satisfies ModelDescriptor;

export const CLAUDE_OPUS_DESCRIPTOR = {
  provider: "anthropic",
  model: "claude-opus-4-20250514",
  label: "Claude 4 Opus",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 32_768,
  },
  pricing: {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
  },
} as const satisfies ModelDescriptor;

export const GEMINI_PRO_DESCRIPTOR = {
  provider: "gemini",
  model: "gemini-2.5-pro",
  label: "Gemini 2.5 Pro",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 65_536,
  },
  pricing: {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  },
} as const satisfies ModelDescriptor;

export const GEMINI_FLASH_DESCRIPTOR = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  label: "Gemini 2.5 Flash",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: false,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 65_536,
  },
  pricing: {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
} as const satisfies ModelDescriptor;

export const QWEN3_DESCRIPTOR = {
  provider: "qwen",
  model: "qwen3-235b-a22b",
  label: "Qwen3 235B",
  capabilities: {
    tools: true,
    images: true,
    streaming: true,
    reasoning: true,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
  },
  pricing: {
    inputPerMillion: 0.55,
    outputPerMillion: 2.2,
  },
} as const satisfies ModelDescriptor;

export const QWEN_MAX_DESCRIPTOR = {
  provider: "qwen",
  model: "qwen-max",
  label: "Qwen Max",
  capabilities: {
    tools: true,
    images: false,
    streaming: true,
    reasoning: false,
    maxContextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
  pricing: {
    inputPerMillion: 2.8,
    outputPerMillion: 10,
  },
} as const satisfies ModelDescriptor;

export const OLLAMA_DESCRIPTOR = {
  provider: "ollama",
  model: "llama3.2",
  label: "Ollama (local)",
  capabilities: {
    tools: false,
    images: false,
    streaming: true,
    reasoning: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
  },
} as const satisfies ModelDescriptor;

export const DEEPSEEK_PROFILE = defineBuiltinModelProvider({
  id: "deepseek",
  protocol: "openai-chat-compatible",
  descriptor: DEEPSEEK_DESCRIPTOR,
  models: [DEEPSEEK_DESCRIPTOR, DEEPSEEK_R1_DESCRIPTOR],
  defaultBaseUrl: "https://api.deepseek.com/v1",
  apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
});

export const OPENAI_PROFILE = defineBuiltinModelProvider({
  id: "openai",
  protocol: "openai-chat-compatible",
  descriptor: OPENAI_GPT4O_DESCRIPTOR,
  models: [OPENAI_GPT4O_DESCRIPTOR, OPENAI_O3_DESCRIPTOR, OPENAI_O4_MINI_DESCRIPTOR],
  defaultBaseUrl: "https://api.openai.com/v1",
  apiKeyEnvironmentVariable: "OPENAI_API_KEY",
});

export const ANTHROPIC_PROFILE = defineBuiltinModelProvider({
  id: "anthropic",
  protocol: "anthropic-messages",
  descriptor: CLAUDE_SONNET_DESCRIPTOR,
  models: [CLAUDE_SONNET_DESCRIPTOR, CLAUDE_OPUS_DESCRIPTOR],
  defaultBaseUrl: "https://api.anthropic.com/v1",
  apiKeyEnvironmentVariable: "ANTHROPIC_API_KEY",
  providerLabel: (model) => `Claude (${model})`,
});

export const GEMINI_PROFILE = defineBuiltinModelProvider({
  id: "gemini",
  protocol: "openai-chat-compatible",
  descriptor: GEMINI_PRO_DESCRIPTOR,
  models: [GEMINI_PRO_DESCRIPTOR, GEMINI_FLASH_DESCRIPTOR],
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKeyEnvironmentVariable: "GEMINI_API_KEY",
  defaultHeaders: (config) => ({ "x-goog-api-key": config.apiKey }),
});

export const QWEN_PROFILE = defineBuiltinModelProvider({
  id: "qwen",
  protocol: "openai-chat-compatible",
  descriptor: QWEN3_DESCRIPTOR,
  models: [QWEN3_DESCRIPTOR, QWEN_MAX_DESCRIPTOR],
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKeyEnvironmentVariable: "DASHSCOPE_API_KEY",
});

export const OLLAMA_PROFILE = defineBuiltinModelProvider({
  id: "ollama",
  protocol: "openai-chat-compatible",
  descriptor: OLLAMA_DESCRIPTOR,
  models: [OLLAMA_DESCRIPTOR],
  defaultBaseUrl: "http://localhost:11434/v1",
  apiKeyEnvironmentVariable: "OLLAMA_API_KEY",
  fallbackApiKey: "ollama",
  descriptorLabel: (model) => `Ollama (${model})`,
});

/** The single built-in provider table used by package factories and the Gateway. */
export const BUILTIN_MODEL_PROVIDER_PROFILES = [
  DEEPSEEK_PROFILE,
  OPENAI_PROFILE,
  ANTHROPIC_PROFILE,
  GEMINI_PROFILE,
  QWEN_PROFILE,
  OLLAMA_PROFILE,
] as const;

export type BuiltinModelProviderId = (typeof BUILTIN_MODEL_PROVIDER_PROFILES)[number]["id"];

export const BUILTIN_MODEL_PROVIDER_IDS: readonly BuiltinModelProviderId[] = BUILTIN_MODEL_PROVIDER_PROFILES.map(
  (profile) => profile.id,
);

const builtinProfilesById = new Map<string, BuiltinModelProviderProfile>(
  BUILTIN_MODEL_PROVIDER_PROFILES.map((profile) => [profile.id, profile]),
);

/** Returns the canonical profile for a built-in provider id. */
export function getBuiltinModelProviderProfile(id: string): BuiltinModelProviderProfile | undefined {
  return builtinProfilesById.get(id);
}

/** Finds exact metadata for a known model without creating a Provider. */
export function findBuiltinModelDescriptor(model: string, providerId?: string): ModelDescriptor | undefined {
  for (const profile of BUILTIN_MODEL_PROVIDER_PROFILES) {
    if (providerId && profile.id !== providerId) continue;
    const descriptor = profile.models.find((candidate) => candidate.model === model);
    if (descriptor) return descriptor;
  }
  return undefined;
}

/** Creates a built-in provider through its canonical profile. */
export function createBuiltinModelProvider(id: string, config: ModelProviderConfig): ModelProvider {
  const profile = getBuiltinModelProviderProfile(id);
  if (!profile) {
    throw new Error(`Unknown built-in ModelProvider "${id}"`);
  }
  return profile.factory(config);
}

/** Idempotently registers every built-in profile without instantiating a Provider. */
export function registerBuiltinModelProviders(registry: ModelProviderRegistry): void {
  for (const profile of BUILTIN_MODEL_PROVIDER_PROFILES) {
    if (registry.describe(profile.id)) continue;
    registry.register(profile.id, profile);
  }
}

export const createDeepSeekProvider = DEEPSEEK_PROFILE.factory;
export const createOpenAiProvider = OPENAI_PROFILE.factory;
export const createAnthropicProvider = ANTHROPIC_PROFILE.factory;
export const createGeminiProvider = GEMINI_PROFILE.factory;
export const createQwenProvider = QWEN_PROFILE.factory;
export const createOllamaProvider = OLLAMA_PROFILE.factory;

export const createDeepSeekR1Provider = createVariantFactory(DEEPSEEK_PROFILE, DEEPSEEK_R1_DESCRIPTOR.model);

function defineBuiltinModelProvider<const Id extends string>(
  definition: BuiltinProviderDefinition<Id>,
): BuiltinModelProviderProfile & { readonly id: Id } {
  return {
    id: definition.id,
    protocol: definition.protocol,
    descriptor: definition.descriptor,
    models: definition.models,
    defaultBaseUrl: definition.defaultBaseUrl,
    apiKeyEnvironmentVariable: definition.apiKeyEnvironmentVariable,
    ...(definition.fallbackApiKey ? { fallbackApiKey: definition.fallbackApiKey } : {}),
    factory: (config) => createProviderFromProfile(definition, config),
  };
}

function createVariantFactory(profile: BuiltinModelProviderProfile, defaultModel: string): ModelProviderFactory {
  return (config) => profile.factory({ ...config, model: config.model ?? defaultModel });
}

function createProviderFromProfile(
  profile: BuiltinProviderDefinition<string>,
  config: ModelProviderConfig,
): ModelProvider {
  const model = config.model ?? profile.descriptor.model;
  const knownDescriptor = profile.models.find((descriptor) => descriptor.model === model) ?? profile.descriptor;
  const descriptor = {
    ...knownDescriptor,
    model,
    ...(profile.descriptorLabel ? { label: profile.descriptorLabel(model) } : {}),
  };
  const resolvedConfig = {
    ...config,
    model,
    baseUrl: config.baseUrl || profile.defaultBaseUrl,
    apiKey: config.apiKey || profile.fallbackApiKey || "",
  };

  if (profile.protocol === "openai-chat-compatible") {
    return createOpenAiCompatibleProvider(descriptor, resolvedConfig, profile.defaultHeaders?.(resolvedConfig));
  }

  const driver = createModelDriver({
    kind: "anthropic-messages",
    id: `${profile.id}/${model}`,
    apiKey: resolvedConfig.apiKey,
    baseUrl: resolvedConfig.baseUrl,
    maxRetries: resolvedConfig.maxRetries,
  });
  return createModelDriverProvider({
    descriptor,
    driver,
    label: profile.providerLabel?.(model),
    timeoutMs: resolvedConfig.timeoutMs ?? 120_000,
  });
}
