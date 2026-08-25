import { expect, it } from "vitest";
import { ModelProviderRegistry } from "@director/model-provider";
import {
  BUILTIN_PROVIDER_IDS,
  registerBuiltinProviders,
  resolveModelProvider,
} from "../../agents/modelProviderIntegration";

it("registers and resolves providers from canonical built-in profiles", () => {
  const registry = new ModelProviderRegistry();

  registerBuiltinProviders(registry);
  registerBuiltinProviders(registry);

  expect(registry.list()).toEqual(BUILTIN_PROVIDER_IDS);
  expect(resolveModelProvider("openai", undefined, "test-key", undefined, registry)).toMatchObject({
    id: "openai/gpt-4o",
    descriptor: { model: "gpt-4o" },
  });
});
