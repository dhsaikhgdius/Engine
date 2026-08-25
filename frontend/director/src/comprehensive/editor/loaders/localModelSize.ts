import { useDirectorStore } from "../store/directorStore";
import { estimateLocalModelSizeM } from "./localModelImport";

/**
 * The metric estimate settles after the model is already on stage, so an
 * unreachable estimator costs only the legacy normalization, and the late store
 * write can never land inside the import's own undo batch.
 *
 * @param assetId - The ID of the asset whose size is being estimated.
 * @param name - The asset's display name used as the estimation description.
 */
export function applyEstimatedLocalModelSize(assetId: string, name: string) {
  void estimateLocalModelSizeM(name).then((sizeM) => {
    if (sizeM !== null) useDirectorStore.getState().setAssetRealWorldSize(assetId, sizeM, "estimated");
  });
}
