import type { DragEvent } from "react";
import type { DirectorAssetSource } from "../schema/directorProject";
import { setTransparentDragImage } from "../drag/transparentDragImage";
import { getModelLibraryItemSizeM } from "@director/dcc-interchange";
import type { FlickNativeAction, MixamoCharacterMetadata, ModelLibraryItem } from "./modelLibraryCatalog";

/** The custom MIME type for model library drag-and-drop transfers. */
export const MODEL_LIBRARY_DRAG_MIME = "application/x-director-model-library-asset";
const MODEL_LIBRARY_DRAG_TYPE = "director-model-library-asset";
const NATIVE_ACTIONS: FlickNativeAction[] = ["add-human", "add-camera", "add-cube", "add-sphere"];
const ASSET_SOURCES: DirectorAssetSource[] = ["local", "library", "remote", "generated"];

/** The JSON payload transferred during a model library drag operation. */
export type ModelLibraryDragPayload = {
  type: typeof MODEL_LIBRARY_DRAG_TYPE;
  id: string;
  kind?: "character" | "prop" | "scene";
  nativeAction?: FlickNativeAction;
  name: string;
  fileName: string;
  url: string;
  assetSource?: DirectorAssetSource;
  characterMetadata?: MixamoCharacterMetadata;
  /** Catalog default real-world size in meters (largest dimension). */
  realWorldSizeM?: number;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseCharacterMetadata(value: unknown): MixamoCharacterMetadata | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return null;
  const metadata = value as Partial<MixamoCharacterMetadata>;
  const rig = metadata.rig;
  if (
    !isFiniteNumber(metadata.heightM) ||
    metadata.heightM <= 0 ||
    !isFiniteNumber(metadata.groundOffsetY) ||
    !Array.isArray(metadata.visualCenter) ||
    metadata.visualCenter.length !== 3 ||
    !metadata.visualCenter.every(isFiniteNumber) ||
    !isFiniteNumber(metadata.labelAnchorY) ||
    !rig ||
    rig.type !== "mixamo" ||
    !Number.isInteger(rig.boneCount) ||
    rig.boneCount < 1 ||
    (rig.bonePrefix !== undefined && typeof rig.bonePrefix !== "string") ||
    (rig.boneNames !== undefined &&
      (!Array.isArray(rig.boneNames) ||
        rig.boneNames.length > 512 ||
        !rig.boneNames.every((name) => isNonEmptyString(name))))
  )
    return null;

  return {
    heightM: metadata.heightM,
    groundOffsetY: metadata.groundOffsetY,
    visualCenter: [metadata.visualCenter[0], metadata.visualCenter[1], metadata.visualCenter[2]],
    labelAnchorY: metadata.labelAnchorY,
    rig: {
      type: "mixamo",
      boneCount: rig.boneCount,
      ...(rig.bonePrefix ? { bonePrefix: rig.bonePrefix } : {}),
      ...(rig.boneNames ? { boneNames: [...rig.boneNames] } : {}),
    },
  };
}

/**
 * Creates a typed drag payload from a model library item.
 *
 * Includes the catalog default real-world size so the drop target can
 * apply proper scaling without a second catalog lookup.
 *
 * @param item - The model library item being dragged.
 * @returns The serializable drag payload.
 */
export function createModelLibraryDragPayload(item: ModelLibraryItem): ModelLibraryDragPayload {
  return {
    type: MODEL_LIBRARY_DRAG_TYPE,
    id: item.id,
    kind: item.kind,
    nativeAction: item.nativeAction,
    name: item.name,
    fileName: item.fileName,
    url: item.url,
    assetSource: item.assetSource,
    characterMetadata: item.characterMetadata,
    realWorldSizeM: getModelLibraryItemSizeM(item),
  };
}

/**
 * Sets the drag data on a React drag event for a model library item.
 *
 * Configures the copy effect, writes the JSON payload to the custom MIME type,
 * sets a fallback plain-text label, and applies a transparent drag image.
 *
 * @param event - The React drag event.
 * @param item - The model library item being dragged.
 */
export function setModelLibraryDragData(event: DragEvent<HTMLElement>, item: ModelLibraryItem) {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(MODEL_LIBRARY_DRAG_MIME, JSON.stringify(createModelLibraryDragPayload(item)));
  event.dataTransfer.setData("text/plain", item.name);
  setTransparentDragImage(event.dataTransfer);
}

/**
 * Parses and validates a raw drag data string into a model library drag payload.
 *
 * Returns null for any invalid or tampered payload to prevent injection
 * of malformed data into the scene.
 *
 * @param raw - The raw JSON string from the drag data transfer.
 * @returns The validated payload or null if invalid.
 */
export function parseModelLibraryDragData(raw: string | null | undefined): ModelLibraryDragPayload | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const payload = value as Partial<ModelLibraryDragPayload>;
    const characterMetadata = parseCharacterMetadata(payload.characterMetadata);
    if (
      payload.type !== MODEL_LIBRARY_DRAG_TYPE ||
      !isNonEmptyString(payload.id) ||
      !isNonEmptyString(payload.name) ||
      !isNonEmptyString(payload.fileName) ||
      typeof payload.url !== "string" ||
      (payload.kind !== undefined && !["character", "prop", "scene"].includes(payload.kind)) ||
      (payload.nativeAction !== undefined && !NATIVE_ACTIONS.includes(payload.nativeAction)) ||
      (payload.assetSource !== undefined && !ASSET_SOURCES.includes(payload.assetSource)) ||
      (payload.realWorldSizeM !== undefined &&
        (!isFiniteNumber(payload.realWorldSizeM) || payload.realWorldSizeM <= 0)) ||
      characterMetadata === null
    )
      return null;

    return {
      type: MODEL_LIBRARY_DRAG_TYPE,
      id: payload.id,
      kind: payload.kind,
      nativeAction: payload.nativeAction,
      name: payload.name,
      fileName: payload.fileName,
      url: payload.url,
      assetSource: payload.assetSource,
      characterMetadata,
      realWorldSizeM: payload.realWorldSizeM,
    };
  } catch {
    return null;
  }
}

/**
 * Reads the model library drag payload from a DataTransfer object.
 *
 * Convenience wrapper around {@link parseModelLibraryDragData} that
 * extracts the data from the custom MIME type.
 *
 * @param dataTransfer - The browser DataTransfer from the drop event.
 * @returns The validated payload or null.
 */
export function readModelLibraryDragData(dataTransfer: DataTransfer): ModelLibraryDragPayload | null {
  return parseModelLibraryDragData(dataTransfer.getData(MODEL_LIBRARY_DRAG_MIME));
}
