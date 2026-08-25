/** Shared Provider facade for OpenAI-compatible chat APIs. */

import type { ModelDescriptor, ModelProvider, ModelProviderConfig } from "../types";
import { createModelDriver } from "../runtime/modelDriverFactory";
import { createModelDriverProvider } from "./modelDriverProvider";

/** Creates a Provider whose low- and high-level APIs share one canonical Driver. */
export function createOpenAiCompatibleProvider(
  descriptor: ModelDescriptor,
  config: ModelProviderConfig,
  headers?: Record<string, string>,
): ModelProvider {
  const model = config.model ?? descriptor.model;
  const resolvedDescriptor = { ...descriptor, model };
  const driver = createModelDriver({
    kind: "openai-chat-compatible",
    id: `${descriptor.provider}/${model}`,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    defaultHeaders: headers,
    maxRetries: config.maxRetries,
  });
  return createModelDriverProvider({
    descriptor: resolvedDescriptor,
    driver,
    timeoutMs: config.timeoutMs ?? 120_000,
  });
}
