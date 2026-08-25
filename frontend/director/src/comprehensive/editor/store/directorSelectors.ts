/**
 * @module Selector functions for deriving UI state from the director store.
 */

import type { RightPanelKind } from "../schema/directorProject";
import type { DirectorState } from "./directorStore";

/** Determines which right panel to show based on the current view mode, selection, and inspector state. */
export function selectRightPanelKind(state: DirectorState): RightPanelKind {
  if (state.viewMode === "director" && state.directorInspectorMode === "scene") {
    return "scene";
  }

  if (state.selectedCrowdId) return "character";

  const selected = state.project.objects.find((item) => item.id === state.selectedObjectId);
  const selectedAsset = selected?.assetRefId
    ? state.project.assets.find((asset) => asset.id === selected.assetRefId)
    : undefined;
  if (selected?.kind === "character") return "character";
  if (selected?.kind === "prop" || selected?.kind === "scene" || selectedAsset?.sourceType === "model") return "prop";
  if (selected?.kind === "camera") return "camera";
  if (state.viewMode === "camera") return "camera";
  return "scene";
}
