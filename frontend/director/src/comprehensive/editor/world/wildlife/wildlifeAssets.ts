import { Box3 } from "three";
import type { AnimationClip, Object3D } from "three";
import type { WorldWildlifeSpecies } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { buildWildlifeGeometry, WILDLIFE_RENDER_PROFILES } from "./placeholderModels";

/**
 * glTF animal binding for herd wildlife groups.
 *
 * This module owns everything that does not need React or a live scene:
 * clip-name selection, the deterministic mixer time mapping, bounding-box
 * normalization math, and the module-level asset loader cache. The render
 * component (`WildlifeGltfHerd`) stays a thin consumer, and the pure parts
 * are unit-testable without loading GLTF in jsdom.
 */

// ---------------------------------------------------------------------------
// Clip selection (pure)
// ---------------------------------------------------------------------------

/** Case-insensitive substring keywords for movement clips, in priority order. */
export const WILDLIFE_MOVE_CLIP_KEYWORDS = ["walk", "run"] as const;
/** Case-insensitive substring keywords for grazing/idle clips, in priority order. */
export const WILDLIFE_GRAZE_CLIP_KEYWORDS = ["idle", "eat", "graze"] as const;

/**
 * Picks the clip driving an agent: moving agents prefer walk/run clips,
 * grazing agents prefer idle/eat/graze clips, and any miss falls back to the
 * first clip so untagged single-clip models still animate. Returns -1 only
 * for an empty clip list.
 */
export function selectWildlifeClipIndex(clipNames: readonly string[], moving: boolean): number {
  if (clipNames.length === 0) return -1;
  const keywords = moving ? WILDLIFE_MOVE_CLIP_KEYWORDS : WILDLIFE_GRAZE_CLIP_KEYWORDS;
  for (const keyword of keywords) {
    for (let index = 0; index < clipNames.length; index += 1) {
      if (clipNames[index].toLowerCase().includes(keyword)) return index;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Deterministic mixer time (pure)
// ---------------------------------------------------------------------------

/**
 * Absolute mixer time for an agent. Never advance a mixer by frame delta:
 * `mixer.setTime(wildlifeMixerTimeSeconds(...))` makes the pose a pure
 * function of (worldSeconds, agent phase, playback scale), so scrubbing and
 * out-of-order frame export reproduce identical skeletons. The agent's hashed
 * phase decorrelates gaits inside a herd; playbackScale follows the group's
 * speedScale so cadence tracks the sim's actual walk speed.
 */
export function wildlifeMixerTimeSeconds(worldSeconds: number, phaseSeconds: number, playbackScale: number): number {
  return (worldSeconds + phaseSeconds) * playbackScale;
}

// ---------------------------------------------------------------------------
// Bounding-box normalization (pure)
// ---------------------------------------------------------------------------

export interface WildlifeModelNormalization {
  /** Uniform scale applied to the cloned model root. */
  scale: number;
  /** Y offset (after scaling) that puts the model's bbox base at y=0. */
  offsetY: number;
}

/**
 * Normalizes an arbitrary model so its bounding-box height matches the
 * species target and its feet (bbox bottom) rest on the agent origin, which
 * the render loop pins to the sampled terrain height.
 */
export function computeWildlifeModelNormalization(
  bboxMinY: number,
  bboxHeight: number,
  targetHeightM: number,
): WildlifeModelNormalization {
  const scale = targetHeightM / Math.max(bboxHeight, 1e-6);
  // +0 to normalize the -0 a zero minY would otherwise produce.
  return { scale, offsetY: -bboxMinY * scale + 0 };
}

const placeholderStandingHeightCache = new Map<WorldWildlifeSpecies, number>();

/**
 * Ground-to-top standing height of the species placeholder at sizeScale 1:
 * the silhouette's bbox top plus `bodyOffsetYM` (the placeholder floats its
 * body centre above ground with legs implied, so offset + bbox top is the
 * visual height a replacement model should match). Measured once per species
 * from the real placeholder geometry so the two render paths cannot drift.
 */
export function resolveWildlifePlaceholderHeightM(species: WorldWildlifeSpecies): number {
  const cached = placeholderStandingHeightCache.get(species);
  if (cached !== undefined) return cached;
  const geometry = buildWildlifeGeometry(species, 1);
  geometry.computeBoundingBox();
  const topY = geometry.boundingBox?.max.y ?? 0;
  geometry.dispose();
  const height = Math.max(WILDLIFE_RENDER_PROFILES[species].bodyOffsetYM + topY, 0.05);
  placeholderStandingHeightCache.set(species, height);
  return height;
}

// ---------------------------------------------------------------------------
// Module-level asset loader cache (impure edge)
// ---------------------------------------------------------------------------

export interface WildlifeAssetBinding {
  /** Prototype scene; render paths must clone (SkeletonUtils) — never mount it. */
  scene: Object3D;
  /** Animation clips extracted from the glTF. */
  clips: AnimationClip[];
  /** Clip names in the same order as `clips`, for keyword matching. */
  clipNames: string[];
  /** Raw (unscaled) bounding-box minimum Y of the prototype, measured once. */
  bboxMinY: number;
  /** Raw (unscaled) bounding-box height of the prototype, measured once. */
  bboxHeight: number;
}

interface WildlifeAssetCacheEntry {
  url: string;
  promise: Promise<WildlifeAssetBinding | null>;
}

// Keyed by asset id per the binding contract; entries live for the session
// (bounded by the number of distinct animal assets in the project). A url
// change under the same id (re-imported asset) restarts the load.
const assetBindingCache = new Map<string, WildlifeAssetCacheEntry>();
const warnedAssetIds = new Set<string>();

async function loadBinding(assetId: string, url: string): Promise<WildlifeAssetBinding | null> {
  try {
    // Dynamic imports keep GLTFLoader + the meshopt decoder out of the lazy
    // wildlife chunk until a group actually binds an asset.
    const [{ GLTFLoader }, { configureDirectorGLTFLoader }] = await Promise.all([
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("../../runtime/gltfLoader"),
    ]);
    const gltf = await configureDirectorGLTFLoader(new GLTFLoader()).loadAsync(url);
    const bounds = new Box3().setFromObject(gltf.scene);
    if (bounds.isEmpty()) throw new Error("model has no measurable bounds");
    return {
      scene: gltf.scene,
      clips: gltf.animations ?? [],
      clipNames: (gltf.animations ?? []).map((clip) => clip.name),
      bboxMinY: bounds.min.y,
      bboxHeight: Math.max(bounds.max.y - bounds.min.y, 1e-6),
    };
  } catch (error) {
    // Failure tolerance: warn once per asset and let the caller keep the
    // placeholder silhouettes; a broken asset must never crash the layer.
    if (!warnedAssetIds.has(assetId)) {
      warnedAssetIds.add(assetId);
      console.warn(`[wildlife] failed to load model asset "${assetId}"; keeping placeholder silhouettes.`, error);
    }
    return null;
  }
}

/** One-shot warning channel shared with the loader (missing asset records). */
export function warnWildlifeAssetOnce(assetId: string, message: string): void {
  if (warnedAssetIds.has(assetId)) return;
  warnedAssetIds.add(assetId);
  console.warn(`[wildlife] ${message}`);
}

/** Resolves the shared prototype for an asset id, loading it at most once. */
export function loadWildlifeAssetBinding(assetId: string, url: string): Promise<WildlifeAssetBinding | null> {
  const existing = assetBindingCache.get(assetId);
  if (existing && existing.url === url) return existing.promise;
  const entry: WildlifeAssetCacheEntry = { url, promise: loadBinding(assetId, url) };
  assetBindingCache.set(assetId, entry);
  return entry.promise;
}
