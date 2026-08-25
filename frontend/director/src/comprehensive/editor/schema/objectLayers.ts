import type { DirectorObject, DirectorObjectLayer, SceneSettings } from "./directorProject";

export const DEFAULT_DIRECTOR_OBJECT_LAYER_ID = "default";

export function getDirectorObjectLayerId(object: Pick<DirectorObject, "layer">) {
  return object.layer?.trim() || DEFAULT_DIRECTOR_OBJECT_LAYER_ID;
}

/** Configured order first, then any legacy object layer names not yet registered. */
export function getDirectorObjectLayers(scene: SceneSettings, objects: readonly Pick<DirectorObject, "layer">[]) {
  const layers = new Map<string, DirectorObjectLayer>();
  for (const layer of scene.objectLayers ?? []) layers.set(layer.id, layer);
  for (const object of objects) {
    const id = getDirectorObjectLayerId(object);
    if (!layers.has(id)) layers.set(id, { id, visible: true, locked: false });
  }
  if (!layers.has(DEFAULT_DIRECTOR_OBJECT_LAYER_ID)) {
    layers.set(DEFAULT_DIRECTOR_OBJECT_LAYER_ID, {
      id: DEFAULT_DIRECTOR_OBJECT_LAYER_ID,
      visible: true,
      locked: false,
    });
  }
  return [...layers.values()];
}

export function getDirectorObjectLayerState(
  scene: SceneSettings,
  object: Pick<DirectorObject, "layer">,
): DirectorObjectLayer {
  const id = getDirectorObjectLayerId(object);
  return scene.objectLayers?.find((layer) => layer.id === id) ?? { id, visible: true, locked: false };
}

export function isDirectorObjectEffectivelyVisible(
  scene: SceneSettings,
  object: Pick<DirectorObject, "visible" | "layer">,
) {
  return object.visible && getDirectorObjectLayerState(scene, object).visible;
}

export function isDirectorObjectEffectivelyLocked(
  scene: SceneSettings,
  object: Pick<DirectorObject, "locked" | "layer">,
) {
  return object.locked || getDirectorObjectLayerState(scene, object).locked;
}
