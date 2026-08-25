import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { MediaTranscriptionExecutor } from "./mediaTranscriptionExecutor";
import { MediaTranscriptionInputStore } from "./mediaTranscriptionInputStore";

/**
 * Creates the media transcription runtime: input store and executor.
 *
 * Wires the transcription configuration from the control plane to the
 * executor and input store, returning both as a read-only tuple.
 *
 * @param config - The Director control plane configuration.
 * @param dataDirectory - The data directory for input persistence.
 * @param store - The production job store for persisting job state.
 * @returns An object with the input store and executor.
 */
export function createMediaTranscriptionRuntime(
  config: DirectorControlPlaneConfig,
  dataDirectory: string,
  store: ProductionJobStore,
) {
  const inputs = new MediaTranscriptionInputStore(dataDirectory, config.transcription.maxInputBytes);
  const executor = new MediaTranscriptionExecutor({ store, inputs, config: config.transcription });
  return { inputs, executor } as const;
}
