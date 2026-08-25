import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import type { MediaTranscodeInputStore } from "../media/mediaTranscodeInputStore";
import { CaptureReconstructionExecutor } from "./captureReconstructionExecutor";

/**
 * Capture reconstruction shares the content-addressed media-input staging
 * store with media.transcode, so one upload endpoint serves both pipelines.
 */
export function createCaptureReconstructionRuntime(
  config: DirectorControlPlaneConfig,
  store: ProductionJobStore,
  inputs: MediaTranscodeInputStore,
) {
  const executor = new CaptureReconstructionExecutor({
    store,
    inputs,
    config: {
      pythonBin: config.reconstruction.pythonBin,
      workerDir: config.reconstruction.workerDir,
      ffmpegPath: config.film.ffmpegPath,
      timeoutMs: config.reconstruction.timeoutMs,
    },
  });
  return { executor } as const;
}
