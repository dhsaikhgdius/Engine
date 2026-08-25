import type { Container, Plugin } from "@director/di";
import { registerBuiltinProviders } from "./agents/modelProviderIntegration";
import { modelProviderRegistry } from "@director/model-provider";

/**
 * DI plugin that registers all built-in model providers and exposes the
 * shared {@link modelProviderRegistry} as a container constant.
 */
export const modelProviderPlugin: Plugin = (ctx: Container) => {
  registerBuiltinProviders(modelProviderRegistry);
  ctx.constant("modelProviderRegistry", modelProviderRegistry);
};

/** All gateway plugins loaded at bootstrap. */
export const gatewayPlugins: Plugin[] = [modelProviderPlugin];
