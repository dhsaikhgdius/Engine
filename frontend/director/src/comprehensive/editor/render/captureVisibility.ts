import type { Mesh, Object3D, Scene } from "three";

/** userData key that marks an object to be hidden from viewport captures. */
export const DIRECTOR_HIDE_FROM_CAPTURE_KEY = "hideFromViewportCapture";

// Shared userData contract (see SceneRoot object mounting): authored project
// objects carry `directorObjectId` at their runtime root. Consumers re-declare
// the key string rather than importing it; the contract is the value.
const DIRECTOR_OBJECT_ID_KEY = "directorObjectId";
const DIRECTOR_INSTANCE_OBJECT_IDS_KEY = "directorInstanceObjectIds";

export interface DirectorCaptureVisibilityScope {
  hiddenCount: number;
  /** Idempotently restores every helper to the visibility it had on entry. */
  restore: () => void;
}

/**
 * Collects every object in the scene tree tagged with the hide-from-capture flag.
 * Returns a flat list suitable for visibility scoping and diagnostics.
 *
 * @param scene - The scene to traverse.
 * @returns Objects tagged with `hideFromViewportCapture` in userData.
 */
export function collectDirectorCaptureHelpers(scene: Scene) {
  const helpers: Object3D[] = [];
  scene.traverse((object) => {
    if (object.userData?.[DIRECTOR_HIDE_FROM_CAPTURE_KEY]) helpers.push(object);
  });
  return helpers;
}

/**
 * Temporarily removes editor-only helpers from a render. The returned scope is
 * deliberately imperative so callers can restore visibility from a `finally`
 * block even when WebGL rendering or pixel readback throws.
 */
export function suppressDirectorCaptureHelpers(
  scene: Scene,
  helpers = collectDirectorCaptureHelpers(scene),
): DirectorCaptureVisibilityScope {
  const hidden: Array<{ object: Object3D; visible: boolean }> = [];
  let restored = false;

  helpers.forEach((object) => {
    hidden.push({ object, visible: object.visible });
    object.visible = false;
  });

  return {
    hiddenCount: hidden.length,
    restore: () => {
      if (restored) return;
      restored = true;
      hidden.forEach(({ object, visible }) => {
        object.visible = visible;
      });
    },
  };
}

/** Executes a synchronous helper-free capture without leaking visibility. */
export function withDirectorCaptureHelpersHidden<T>(scene: Scene, capture: () => T): T {
  const scope = suppressDirectorCaptureHelpers(scene);
  try {
    return capture();
  } finally {
    scope.restore();
  }
}

function hasDirectorObjectOwner(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    const value = current.userData?.[DIRECTOR_OBJECT_ID_KEY];
    if (typeof value === "string" && value.trim()) return true;
    const instanceObjectIds = current.userData?.[DIRECTOR_INSTANCE_OBJECT_IDS_KEY];
    if (Array.isArray(instanceObjectIds) && instanceObjectIds.length > 0) return true;
    current = current.parent;
  }
  return false;
}

function isRenderableSceneObject(object: Object3D): boolean {
  const candidate = object as Partial<Mesh> & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return Boolean(candidate.isMesh || candidate.isLine || candidate.isPoints || candidate.isSprite);
}

/**
 * Temporarily hides environment dressing for transparent-background captures.
 *
 * The rule mirrors the mask/semantic passes: a renderable belongs to authored
 * scene content iff it (or an ancestor) carries `userData.directorObjectId`,
 * which SceneRoot stamps on every project object's runtime root. Everything
 * else that draws pixels — the stage floor, panorama backdrop dome, Living
 * World ambience, live DCC preview layers — is environment dressing and is
 * hidden so empty pixels keep alpha 0. Lights, `scene.environment` IBL, and
 * fog are not renderables and keep lighting authored objects unchanged.
 */
export function suppressDirectorEnvironmentDressing(scene: Scene): DirectorCaptureVisibilityScope {
  const dressing: Object3D[] = [];
  scene.traverse((object) => {
    if (object.visible && isRenderableSceneObject(object) && !hasDirectorObjectOwner(object)) {
      dressing.push(object);
    }
  });

  const hidden = dressing.map((object) => ({ object, visible: object.visible }));
  hidden.forEach(({ object }) => {
    object.visible = false;
  });
  let restored = false;

  return {
    hiddenCount: hidden.length,
    restore: () => {
      if (restored) return;
      restored = true;
      hidden.forEach(({ object, visible }) => {
        object.visible = visible;
      });
    },
  };
}
