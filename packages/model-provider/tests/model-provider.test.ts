// @director/model-provider — unit tests for registry and provider descriptors

import { describe, it, expect } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  findBuiltinModelDescriptor,
  getBuiltinModelProviderProfile,
  registerBuiltinModelProviders,
} from "../src/builtinProviders";
import { ModelProviderRegistry } from "../src/registry";
import {
  DEEPSEEK_DESCRIPTOR,
  DEEPSEEK_R1_DESCRIPTOR,
  createDeepSeekProvider,
  createDeepSeekR1Provider,
} from "../src/providers/deepseek";
import { OPENAI_GPT4O_DESCRIPTOR, OPENAI_O3_DESCRIPTOR, createOpenAiProvider } from "../src/providers/openai";
import { CLAUDE_SONNET_DESCRIPTOR, createAnthropicProvider } from "../src/providers/anthropic";
import { GEMINI_PRO_DESCRIPTOR, createGeminiProvider } from "../src/providers/gemini";
import { QWEN3_DESCRIPTOR, createQwenProvider } from "../src/providers/qwen";
import { OLLAMA_DESCRIPTOR, createOllamaProvider } from "../src/providers/ollama";

const mockConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key",
};

describe("ModelProviderRegistry", () => {
  it("registers a provider factory", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });
    expect(registry.list()).toContain("deepseek");
  });

  it("throws on duplicate registration", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });
    expect(() =>
      registry.register("deepseek", {
        factory: createDeepSeekProvider,
        descriptor: { ...DEEPSEEK_DESCRIPTOR },
      }),
    ).toThrow("already registered");
  });

  it("creates a provider instance", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });

    const provider = registry.create("deepseek", mockConfig);
    expect(provider).toBeDefined();
    expect(provider.id).toBe("deepseek/deepseek-chat");
    expect(provider.label).toBe("DeepSeek V3");
  });

  it("returns cached instance for same config", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });

    const a = registry.create("deepseek", mockConfig);
    const b = registry.create("deepseek", mockConfig);
    expect(a).toBe(b);
  });

  it("replaces a cached instance when its connection config changes", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });

    const a = registry.create("deepseek", mockConfig);
    const b = registry.create("deepseek", {
      ...mockConfig,
      baseUrl: "https://second.example.com/v1",
      apiKey: "second-key",
    });

    expect(b).not.toBe(a);
    expect(registry.get("deepseek:default")).toBe(b);
  });

  it("evicts cached instances", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });

    registry.create("deepseek", mockConfig);
    expect(registry.evict("deepseek:default")).toBe(true);
    expect(registry.evict("nonexistent")).toBe(false);
  });

  it("describes registered providers", () => {
    const registry = new ModelProviderRegistry();
    registry.register("deepseek", {
      factory: createDeepSeekProvider,
      descriptor: { ...DEEPSEEK_DESCRIPTOR },
    });

    const desc = registry.describe("deepseek");
    expect(desc?.provider).toBe("deepseek");
    expect(desc?.capabilities.tools).toBe(true);
  });

  it("throws for unregistered provider", () => {
    const registry = new ModelProviderRegistry();
    expect(() => registry.create("nonexistent", mockConfig)).toThrow("not registered");
  });
});

describe("Built-in provider profiles", () => {
  it("registers every built-in from the canonical profile table", () => {
    const registry = new ModelProviderRegistry();

    registerBuiltinModelProviders(registry);
    registerBuiltinModelProviders(registry);

    expect(registry.list()).toEqual(BUILTIN_MODEL_PROVIDER_IDS);
    for (const id of BUILTIN_MODEL_PROVIDER_IDS) {
      expect(registry.describe(id)).toBe(getBuiltinModelProviderProfile(id)?.descriptor);
    }
  });

  it("keeps legacy factories bound to their canonical profiles", () => {
    expect(createDeepSeekProvider).toBe(getBuiltinModelProviderProfile("deepseek")?.factory);
    expect(createOpenAiProvider).toBe(getBuiltinModelProviderProfile("openai")?.factory);
    expect(createAnthropicProvider).toBe(getBuiltinModelProviderProfile("anthropic")?.factory);
    expect(createGeminiProvider).toBe(getBuiltinModelProviderProfile("gemini")?.factory);
    expect(createQwenProvider).toBe(getBuiltinModelProviderProfile("qwen")?.factory);
    expect(createOllamaProvider).toBe(getBuiltinModelProviderProfile("ollama")?.factory);
  });

  it("keeps endpoint and credential metadata beside the model descriptor", () => {
    const openai = getBuiltinModelProviderProfile("openai");
    const ollama = getBuiltinModelProviderProfile("ollama");

    expect(openai).toMatchObject({
      defaultBaseUrl: "https://api.openai.com/v1",
      apiKeyEnvironmentVariable: "OPENAI_API_KEY",
    });
    expect(openai?.models.map((descriptor) => descriptor.model)).toEqual(["gpt-4o", "o3", "o4-mini"]);
    expect(ollama).toMatchObject({
      defaultBaseUrl: "http://localhost:11434/v1",
      apiKeyEnvironmentVariable: "OLLAMA_API_KEY",
      fallbackApiKey: "ollama",
    });
  });

  it("resolves exact model metadata without constructing a provider", () => {
    expect(findBuiltinModelDescriptor("o3")).toBe(OPENAI_O3_DESCRIPTOR);
    expect(findBuiltinModelDescriptor("deepseek-reasoner")).toBe(DEEPSEEK_R1_DESCRIPTOR);
    expect(findBuiltinModelDescriptor("private-model")).toBeUndefined();
  });
});

describe("Provider descriptors", () => {
  it("DeepSeek V3 has correct capabilities", () => {
    expect(DEEPSEEK_DESCRIPTOR.provider).toBe("deepseek");
    expect(DEEPSEEK_DESCRIPTOR.model).toBe("deepseek-chat");
    expect(DEEPSEEK_DESCRIPTOR.capabilities.tools).toBe(true);
    expect(DEEPSEEK_DESCRIPTOR.capabilities.streaming).toBe(true);
    expect(DEEPSEEK_DESCRIPTOR.capabilities.maxContextTokens).toBe(128_000);
  });

  it("GPT-4o has image support", () => {
    expect(OPENAI_GPT4O_DESCRIPTOR.capabilities.images).toBe(true);
    expect(OPENAI_GPT4O_DESCRIPTOR.capabilities.tools).toBe(true);
  });

  it("Claude Sonnet has correct pricing", () => {
    expect(CLAUDE_SONNET_DESCRIPTOR.pricing?.inputPerMillion).toBe(3.0);
    expect(CLAUDE_SONNET_DESCRIPTOR.pricing?.outputPerMillion).toBe(15.0);
  });

  it("Gemini Pro has 1M context", () => {
    expect(GEMINI_PRO_DESCRIPTOR.capabilities.maxContextTokens).toBe(1_000_000);
  });

  it("Qwen3 has correct model name", () => {
    expect(QWEN3_DESCRIPTOR.model).toBe("qwen3-235b-a22b");
  });

  it("Ollama defaults to llama3.2", () => {
    expect(OLLAMA_DESCRIPTOR.model).toBe("llama3.2");
  });
});

describe("Provider factories", () => {
  it("DeepSeek factory creates a provider", () => {
    const provider = createDeepSeekProvider(mockConfig);
    expect(provider.id).toBe("deepseek/deepseek-chat");
    expect(provider.descriptor.provider).toBe("deepseek");
    expect(typeof provider.chat).toBe("function");
    expect(typeof provider.complete).toBe("function");
  });

  it("OpenAI factory creates a provider", () => {
    const provider = createOpenAiProvider(mockConfig);
    expect(provider.id).toBe("openai/gpt-4o");
    expect(provider.descriptor.capabilities.images).toBe(true);
  });

  it("uses the matching descriptor when a known model variant is selected", () => {
    const openai = createOpenAiProvider({ ...mockConfig, model: OPENAI_O3_DESCRIPTOR.model });
    const deepseek = createDeepSeekR1Provider(mockConfig);

    expect(openai.descriptor).toMatchObject(OPENAI_O3_DESCRIPTOR);
    expect(deepseek.id).toBe(`deepseek/${DEEPSEEK_R1_DESCRIPTOR.model}`);
    expect(deepseek.descriptor).toMatchObject(DEEPSEEK_R1_DESCRIPTOR);
  });

  it("Anthropic factory creates a provider", () => {
    const provider = createAnthropicProvider(mockConfig);
    expect(provider.id).toBe("anthropic/claude-sonnet-4-20250514");
    expect(typeof provider.chat).toBe("function");
  });

  it("Gemini factory creates a provider", () => {
    const provider = createGeminiProvider({
      ...mockConfig,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
    expect(provider.id).toBe("gemini/gemini-2.5-pro");
  });

  it("Qwen factory creates a provider", () => {
    const provider = createQwenProvider(mockConfig);
    expect(provider.id).toBe("qwen/qwen3-235b-a22b");
  });

  it("Ollama factory creates a provider with custom model", () => {
    const provider = createOllamaProvider({ ...mockConfig, model: "codellama" });
    expect(provider.id).toBe("ollama/codellama");
    expect(provider.label).toContain("codellama");
  });
});

describe("Global registry singleton", () => {
  it("exists", async () => {
    const { modelProviderRegistry } = await import("../src/registry");
    expect(modelProviderRegistry).toBeDefined();
    expect(modelProviderRegistry.list()).toEqual([]);
  });
});
