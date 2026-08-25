import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { Generated3DExecutor } from "./generated3dExecutor";
import { Generated3DProviderRegistry } from "./generated3dProviders";
import { Generated3DPromotionStore } from "./generated3dPromotionStore";
import { Generated3DSourceStore } from "./generated3dSourceStore";

/**
 * Creates the generated 3D runtime: provider registry, source store,
 * executor, and promotion store.
 *
 * Wires together all components needed for submitting, polling, and
 * promoting generated 3D assets from the configured providers.
 *
 * @param config - The Director control plane configuration.
 * @param dataDirectory - The data directory for source persistence.
 * @param productionJobs - The production job store for persisting job state.
 * @param generatedAssetRoot - The root directory for promoted generated assets.
 * @param fetchImpl - Optional fetch implementation for HTTP requests.
 * @returns An object with the providers, sources, executor, and promotions.
 */
export function createGenerated3DRuntime(
  config: DirectorControlPlaneConfig,
  dataDirectory: string,
  productionJobs: ProductionJobStore,
  generatedAssetRoot: string,
  fetchImpl: typeof fetch = fetch,
) {
  const providers = new Generated3DProviderRegistry(config.generation.generated3d, fetchImpl);
  const sources = new Generated3DSourceStore(dataDirectory);
  const executor = new Generated3DExecutor(productionJobs, providers, sources, {
    pollIntervalMs: config.generation.generated3d.pollIntervalMs,
    timeoutMs: config.generation.generated3d.timeoutMs,
    fetchImpl,
  });
  const promotions = new Generated3DPromotionStore(generatedAssetRoot, productionJobs);
  return { providers, sources, executor, promotions };
}
