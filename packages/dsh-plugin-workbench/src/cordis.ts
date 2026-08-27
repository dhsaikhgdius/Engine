/**
 * Cordis plugin entry point loaded by DeepSeek Harness.
 *
 * DSH discovers plugins by this module shape: `name` identifies the plugin,
 * `inject` declares the harness services it needs (tool registry, LLM
 * registry for image-input detection, system prompt sections, attachment
 * storage for captures), and `apply` runs once per DSH process. All real
 * work lives in {@link registerDirectorWorkbenchPlugin}.
 *
 * @module cordis
 */

import { registerDirectorWorkbenchPlugin } from "./register";

export const name = "director-workbench";
export const inject = ["tools", "llm", "systemPrompt", "attachments"];

/** DSH calls this once at plugin load; context provides the injected services. */
export function apply(context: Parameters<typeof registerDirectorWorkbenchPlugin>[0]) {
  registerDirectorWorkbenchPlugin(context);
}
