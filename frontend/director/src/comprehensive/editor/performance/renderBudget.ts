/** Whether the stage render loop runs continuously or only on demand. */
export type DirectorStageFrameloop = "always" | "demand";

/** Continuous-rendering reasons; any true flag upgrades the stage frameloop to "always". */
export interface DirectorStageRenderActivity {
  /** Handheld camera inertia is active. */
  cameraHandheldActive: boolean;
  /** Camera pilot mode is active. */
  cameraPilotMode: boolean;
  /** Timeline playback is running. */
  isPlaying: boolean;
  /** Player mode is active. */
  playerMode: boolean;
  /** Timeline recording is active. */
  recordingActive: boolean;
  /** Living World ambient systems (day cycle, weather, effects/water/wildlife) evolving on a parked playhead. */
  worldAmbientActive: boolean;
}

interface DirectorShadowWorldState {
  effects?: readonly { intensity: number; kind: string; visible: boolean }[];
  settings: { enabled: boolean };
  wildlife: readonly { count: number; visible: boolean }[];
  roads?: readonly { vehicleCount: number; visible: boolean }[];
}

/** Shadow world state used to decide whether shadow maps need updating. */
export interface DirectorShadowRenderActivity {
  /** Whether timeline playback is running. */
  isPlaying: boolean;
  /** Whether player mode is active. */
  playerMode: boolean;
  /** Living World state with wildlife, effects, and road vehicles. */
  world: DirectorShadowWorldState | null | undefined;
}

/** Maximum FPS for the camera preview inset. */
export const DIRECTOR_CAMERA_PREVIEW_MAX_FPS = 30;

interface DirectorCompositeShadowMap {
  autoUpdate: boolean;
  needsUpdate: boolean;
}

interface DirectorRenderFrameInfo {
  render: { frame: number };
}

interface DirectorCompositeRendererInfo extends DirectorRenderFrameInfo {
  autoReset: boolean;
  reset: () => void;
}

interface DirectorCompositeFrameState {
  frameKey: number;
  primaryPassClaimed: boolean;
}

const directorCompositeFrames = new WeakMap<DirectorRenderFrameInfo, DirectorCompositeFrameState>();
let nextDirectorCompositeFrameKey = -1;

/** Stable frame identity while one displayed frame renders through several cameras. */
export function getDirectorRenderFrameKey(info: DirectorRenderFrameInfo) {
  return directorCompositeFrames.get(info)?.frameKey ?? info.render.frame;
}

/** True once for the primary scene pass of a composite frame; always true outside one. */
export function claimDirectorPrimaryCompositeRenderPass(info: DirectorRenderFrameInfo) {
  const frame = directorCompositeFrames.get(info);
  if (frame === undefined) return true;
  if (frame.primaryPassClaimed) return false;
  frame.primaryPassClaimed = true;
  return true;
}

/**
 * Decides whether the stage render loop should run continuously.
 *
 * @param activity - The current render activity flags.
 * @param pageVisible - Whether the browser tab is visible.
 * @returns "always" or "demand".
 */
export function getDirectorStageFrameloop(
  activity: DirectorStageRenderActivity,
  pageVisible = true,
): DirectorStageFrameloop {
  if (!pageVisible && !activity.recordingActive) return "demand";
  return Object.values(activity).some(Boolean) ? "always" : "demand";
}

/**
 * Only moving shadow casters need another shadow render. Water, weather
 * particles, clouds, the editor camera, and intensity-only fire flicker can
 * keep presenting new color frames against the cached static shadow maps.
 * A shadow map stores light-space depth, so changing a stationary fire's
 * intensity cannot change it.
 */
export function shouldContinuouslyUpdateDirectorShadows(activity: DirectorShadowRenderActivity) {
  if (activity.isPlaying || activity.playerMode) return true;
  const world = activity.world;
  if (!world?.settings.enabled) return false;
  return (
    world.wildlife.some((group) => group.visible && group.count > 0) ||
    (world.roads ?? []).some((road) => road.visible && road.vehicleCount > 0)
  );
}

/**
 * Throttles camera preview refresh to a maximum FPS.
 *
 * @param elapsedSeconds - Current elapsed time in seconds.
 * @param lastRefreshSeconds - Time of the last preview refresh.
 * @param maxFps - Maximum refresh rate.
 * @returns Whether the preview should refresh now.
 */
export function shouldRefreshDirectorCameraPreview(
  elapsedSeconds: number,
  lastRefreshSeconds: number,
  maxFps = DIRECTOR_CAMERA_PREVIEW_MAX_FPS,
) {
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(lastRefreshSeconds) || maxFps <= 0) return true;
  if (elapsedSeconds < lastRefreshSeconds) return true;
  return elapsedSeconds - lastRefreshSeconds + Number.EPSILON >= 1 / maxFps;
}

/**
 * The camera image may refresh in a persistent offscreen target at a lower
 * cadence, but that cached image must be composited into the default
 * framebuffer on every presented frame. A main-viewport render clears that
 * framebuffer; throttling the composite itself makes the inset alternate with
 * the editor camera and visibly flicker while the user orbits or dollies.
 *
 * `previewDirty` bypasses the cadence after a camera, scene, or layout edit so
 * an idle demand-rendered Stage can never leave a stale inset behind.
 *
 * @param elapsedSeconds - Current elapsed time in seconds.
 * @param lastPreviewRefreshSeconds - Time of the last preview refresh.
 * @param previewDirty - Whether the preview content has changed.
 * @param maxFps - Maximum refresh rate.
 * @param pausePreviewRefresh - Whether to pause preview refresh entirely.
 * @returns A plan with render, refresh, and composite flags.
 */
export function getDirectorCameraPreviewRenderPlan(
  elapsedSeconds: number,
  lastPreviewRefreshSeconds: number,
  previewDirty = false,
  maxFps = DIRECTOR_CAMERA_PREVIEW_MAX_FPS,
  pausePreviewRefresh = false,
): {
  renderMainViewport: boolean;
  refreshPictureInPicture: boolean;
  compositePictureInPicture: boolean;
} {
  return {
    renderMainViewport: true,
    refreshPictureInPicture:
      !pausePreviewRefresh &&
      (previewDirty || shouldRefreshDirectorCameraPreview(elapsedSeconds, lastPreviewRefreshSeconds, maxFps)),
    compositePictureInPicture: true,
  };
}

/**
 * A composite frame may render the same scene through several cameras. Let the
 * first pass refresh shadows, then reuse that shadow map for the remaining
 * passes instead of repeating the complete shadow render for every viewport.
 *
 * @param shadowMap - The shadow map to manage.
 * @returns A cleanup function that restores the previous autoUpdate state.
 */
export function beginDirectorCompositeShadowPass(shadowMap: DirectorCompositeShadowMap) {
  const previousAutoUpdate = shadowMap.autoUpdate;
  shadowMap.autoUpdate = false;
  if (previousAutoUpdate) shadowMap.needsUpdate = true;
  return () => {
    shadowMap.autoUpdate = previousAutoUpdate;
  };
}

/**
 * Three resets renderer.info before every render call by default. Director's
 * PIP and quad frames deliberately render several passes, so aggregate them
 * as one presented frame instead of reporting only the final two-triangle
 * composite.
 *
 * @param info - The renderer info to manage.
 * @returns A cleanup function that restores the previous autoReset state and frame identity.
 */
export function beginDirectorCompositeRendererInfoPass(info: DirectorCompositeRendererInfo) {
  const previousAutoReset = info.autoReset;
  const previousFrame = directorCompositeFrames.get(info);
  directorCompositeFrames.set(info, {
    frameKey: nextDirectorCompositeFrameKey,
    primaryPassClaimed: false,
  });
  nextDirectorCompositeFrameKey -= 1;
  info.autoReset = false;
  info.reset();
  return () => {
    info.autoReset = previousAutoReset;
    if (previousFrame === undefined) directorCompositeFrames.delete(info);
    else directorCompositeFrames.set(info, previousFrame);
  };
}
