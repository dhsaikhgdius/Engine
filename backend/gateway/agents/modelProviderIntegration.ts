// ModelProvider registration and resolution for Gateway integrations.

import {
  BUILTIN_MODEL_PROVIDER_IDS,
  ModelProviderRegistry,
  getBuiltinModelProviderProfile,
  modelProviderRegistry,
  registerBuiltinModelProviders,
  type BuiltinModelProviderId,
  type ModelProvider,
} from "@director/model-provider";

/**
 * The set of provider ids that ship with Director.
 * Each maps to a corresponding factory in {@link registerBuiltinProviders}.
 */
export const BUILTIN_PROVIDER_IDS = BUILTIN_MODEL_PROVIDER_IDS;

/** A provider id from the built-in set. */
export type BuiltinProviderId = BuiltinModelProviderId;

/**
 * Registers all built-in providers on the given registry.
 *
 * Call this once at startup before resolving any providers. Idempotent —
 * already-registered providers are skipped.
 *
 * @param registry - The registry to populate (defaults to the global singleton).
 */
export function registerBuiltinProviders(registry: ModelProviderRegistry = modelProviderRegistry): void {
  registerBuiltinModelProviders(registry);
}

/**
 * Resolves a {@link ModelProvider} from configuration.
 *
 * Uses the profile's credential environment variable and default base URL
 * when they are not explicitly provided.
 *
 * @param providerId - The provider id (e.g. `"openai"`, `"anthropic"`).
 * @param model - Optional model name override.
 * @param apiKey - Optional API key override.
 * @param baseUrl - Optional base URL override.
 * @param registry - The registry to use (defaults to the global singleton).
 * @returns A configured {@link ModelProvider}.
 */
export function resolveModelProvider(
  providerId: string,
  model?: string,
  apiKey?: string,
  baseUrl?: string,
  registry: ModelProviderRegistry = modelProviderRegistry,
): ModelProvider {
  const profile = getBuiltinModelProviderProfile(providerId);
  return registry.create(providerId, {
    apiKey: apiKey ?? (profile ? (process.env[profile.apiKeyEnvironmentVariable] ?? "") : ""),
    baseUrl: baseUrl ?? profile?.defaultBaseUrl ?? "",
    model,
  });
}
