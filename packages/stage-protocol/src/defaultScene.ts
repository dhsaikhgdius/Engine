import defaultScene from "./defaultScene.json";
import { stageSceneSchema } from "./sceneSchema";
import type { StageScene } from "./types";

const parsedDefaultScene = stageSceneSchema.parse(defaultScene);

/** Well-known IDs for the default Stage scene entities. */
export const DEFAULT_IDS = {
  human: "human-1",
  target: "target-1",
  camera: "camera-1",
  cameraTrack: "track-camera-1",
  orbitItem: "item-orbit-1",
} as const;

/**
 * Create a deep-cloned copy of the default Stage scene.
 * The parsed default scene is created once at module load and cloned on every call.
 *
 * @returns A fresh, independent copy of the default scene.
 */
export function createDefaultScene(): StageScene {
  return structuredClone(parsedDefaultScene);
}

/**
 * Deep-clone a Stage scene to produce an independent copy.
 *
 * @param scene - The scene to clone.
 * @returns An independent deep copy.
 */
export function cloneScene(scene: StageScene): StageScene {
  return structuredClone(scene);
}

/**
 * Generate a unique Stage identifier with a prefix.
 * Uses crypto.randomUUID when available, falling back to a timestamp-based ID.
 *
 * @param prefix - The prefix to prepend (e.g. "human", "camera").
 * @returns A unique ID like "human-a1b2c3d4".
 */
export function createStageId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}-${uuid.slice(0, 8)}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
