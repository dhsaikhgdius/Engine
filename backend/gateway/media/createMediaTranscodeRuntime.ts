import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { MediaTranscodeExecutor } from "./mediaTranscodeExecutor";
import { MediaTranscodeInputStore } from "./mediaTranscodeInputStore";

// Transcode sources routinely exceed the transcription upload ceiling and no
// dedicated env var exists yet, so keep a generous fixed staging bound.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * Creates the media transcode runtime: input store and executor.
 *
 * Wires the ffmpeg/ffprobe paths from the control plane to the
 * executor and input store, returning both as a read-only tuple.
 *
 * @param config - The Director control plane configuration.
 * @param dataDirectory - The data directory for input persistence.
 * @param store - The production job store for persisting job state.
 * @returns An object with the input store and executor.
 */
export function createMediaTranscodeRuntime(
  config: DirectorControlPlaneConfig,
  dataDirectory: string,
  store: ProductionJobStore,
) {
  const inputs = new MediaTranscodeInputStore(dataDirectory, MAX_SOURCE_BYTES);
  const executor = new MediaTranscodeExecutor({
    store,
    inputs,
    config: {
      // DIRECTOR_FFMPEG_PATH / DIRECTOR_FFPROBE_PATH are resolved once by the
      // control plane; the film pipeline shares the same binaries.
      ffmpegPath: config.film.ffmpegPath,
      ffprobePath: config.film.ffprobePath,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  });
  return { inputs, executor } as const;
}
