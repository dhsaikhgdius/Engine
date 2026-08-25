import { createModelDriver } from "@director/model-provider/runtime";
import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { FilmStructuredCaller } from "../film/structuredCall";
import { AssetSizeEstimator } from "./assetSizeEstimator";
import { ImagePromptExpander } from "./imagePromptExpander";
import { VideoPromptExpander } from "./videoPromptExpander";

/**
 * Prompt expansion reuses the film-planning LLM credentials: the same writer
 * that plans storyboards rewrites prompts into a generator's dialect, so no
 * extra configuration is required to turn enhance-prompt flags into real
 * gateway-side rewrites.
 */
function createStructuredCaller(config: DirectorControlPlaneConfig): FilmStructuredCaller | undefined {
  const llm = config.film.llm;
  if (!llm.baseUrl || !llm.model) return undefined;
  if (llm.driver === "anthropic" && !llm.apiKey) return undefined;
  const driver = createModelDriver({
    kind: llm.driver === "anthropic" ? "anthropic-messages" : "openai-chat-compatible",
    id: "prompt-expansion-llm",
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey ?? "",
  });
  return new FilmStructuredCaller(driver, llm.model);
}

export function createVideoPromptExpander(config: DirectorControlPlaneConfig): VideoPromptExpander | undefined {
  const caller = createStructuredCaller(config);
  return caller ? new VideoPromptExpander(caller) : undefined;
}

export function createImagePromptExpander(config: DirectorControlPlaneConfig): ImagePromptExpander | undefined {
  const caller = createStructuredCaller(config);
  return caller ? new ImagePromptExpander(caller) : undefined;
}

export function createAssetSizeEstimator(config: DirectorControlPlaneConfig): AssetSizeEstimator | undefined {
  const caller = createStructuredCaller(config);
  return caller ? new AssetSizeEstimator(caller) : undefined;
}
