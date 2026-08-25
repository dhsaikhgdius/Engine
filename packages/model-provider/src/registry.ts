// ModelProviderRegistry — discover, register, and resolve model providers.
// Plugins register factories; the runtime instantiates providers from config.

import type { ModelProvider, ModelProviderConfig, ModelProviderFactory, ModelDescriptor } from "./types";

export interface RegisteredProvider {
  /** Factory that creates instances. */
  factory: ModelProviderFactory;
  /** Descriptor for the default model variant. */
  descriptor: ModelDescriptor;
}

export class ModelProviderRegistry {
  private factories = new Map<string, RegisteredProvider>();
  private instances = new Map<string, { config: ModelProviderConfig; provider: ModelProvider }>();

  /**
   * Register a provider factory. The id must be unique.
   * Built-in providers use ids like "deepseek", "openai", "anthropic".
   */
  register(id: string, entry: RegisteredProvider): void {
    if (this.factories.has(id)) {
      throw new Error(`ModelProvider "${id}" is already registered`);
    }
    this.factories.set(id, entry);
  }

  /** List all registered provider ids. */
  list(): string[] {
    return [...this.factories.keys()];
  }

  /** Get a descriptor for a registered provider. */
  describe(id: string): ModelDescriptor | undefined {
    return this.factories.get(id)?.descriptor;
  }

  /** Describe all registered providers. */
  describeAll(): ModelDescriptor[] {
    return [...this.factories.values()].map((entry) => entry.descriptor);
  }

  /**
   * Create or retrieve the active provider for a provider/model slot.
   * A changed connection configuration replaces the cached instance.
   */
  create(providerId: string, config: ModelProviderConfig): ModelProvider {
    const instanceId = `${providerId}:${config.model ?? "default"}`;
    const existing = this.instances.get(instanceId);
    if (existing && sameProviderConfig(existing.config, config)) return existing.provider;

    const entry = this.factories.get(providerId);
    if (!entry) {
      throw new Error(`ModelProvider "${providerId}" is not registered. Available: ${this.list().join(", ")}`);
    }

    const instance = entry.factory(config);
    this.instances.set(instanceId, { config: { ...config }, provider: instance });
    return instance;
  }

  /** Get an already-created instance by id. */
  get(instanceId: string): ModelProvider | undefined {
    return this.instances.get(instanceId)?.provider;
  }

  /** Remove a cached instance (does not unregister the factory). */
  evict(instanceId: string): boolean {
    return this.instances.delete(instanceId);
  }

  /** Remove all cached instances. */
  clear(): void {
    this.instances.clear();
  }
}

/** Singleton registry for the process. */
export const modelProviderRegistry = new ModelProviderRegistry();

function sameProviderConfig(left: ModelProviderConfig, right: ModelProviderConfig) {
  return (
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    left.model === right.model &&
    left.timeoutMs === right.timeoutMs &&
    left.maxRetries === right.maxRetries
  );
}
