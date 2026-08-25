import { describe, expect, it, vi } from "vitest";
import {
  beginDirectorCompositeRendererInfoPass,
  beginDirectorCompositeShadowPass,
  claimDirectorPrimaryCompositeRenderPass,
  DIRECTOR_CAMERA_PREVIEW_MAX_FPS,
  getDirectorCameraPreviewRenderPlan,
  getDirectorRenderFrameKey,
  getDirectorStageFrameloop,
  shouldContinuouslyUpdateDirectorShadows,
  shouldRefreshDirectorCameraPreview,
} from "../../../../src/comprehensive/editor/performance/renderBudget";

describe("director render budget", () => {
  it("renders a static stage on demand and continuous activity every frame", () => {
    const idle = {
      cameraHandheldActive: false,
      cameraPilotMode: false,
      isPlaying: false,
      playerMode: false,
      recordingActive: false,
      worldAmbientActive: false,
    };

    expect(getDirectorStageFrameloop(idle)).toBe("demand");
    for (const key of Object.keys(idle) as Array<keyof typeof idle>) {
      expect(getDirectorStageFrameloop({ ...idle, [key]: true })).toBe("always");
    }
  });

  it("keeps rendering while a Living World can evolve on a parked playhead", () => {
    expect(
      getDirectorStageFrameloop({
        cameraHandheldActive: false,
        cameraPilotMode: false,
        isPlaying: false,
        playerMode: false,
        recordingActive: false,
        worldAmbientActive: true,
      }),
    ).toBe("always");
  });

  it("parks a hidden stage unless an active recording still needs frames", () => {
    const hiddenActivity = {
      cameraHandheldActive: false,
      cameraPilotMode: false,
      isPlaying: false,
      playerMode: false,
      recordingActive: false,
      worldAmbientActive: true,
    };

    expect(getDirectorStageFrameloop(hiddenActivity, false)).toBe("demand");
    expect(getDirectorStageFrameloop({ ...hiddenActivity, recordingActive: true }, false)).toBe("always");
  });

  it("keeps shadow maps static unless a visible caster or its light position moves", () => {
    const staticWorld = {
      settings: { enabled: true },
      effects: [{ kind: "rain", visible: true, intensity: 1 }],
      wildlife: [{ visible: false, count: 12 }],
      roads: [{ visible: true, vehicleCount: 0 }],
    };

    expect(shouldContinuouslyUpdateDirectorShadows({ isPlaying: false, playerMode: false, world: staticWorld })).toBe(
      false,
    );
    expect(shouldContinuouslyUpdateDirectorShadows({ isPlaying: true, playerMode: false, world: staticWorld })).toBe(
      true,
    );
    expect(shouldContinuouslyUpdateDirectorShadows({ isPlaying: false, playerMode: true, world: staticWorld })).toBe(
      true,
    );
    expect(
      shouldContinuouslyUpdateDirectorShadows({
        isPlaying: false,
        playerMode: false,
        world: { ...staticWorld, wildlife: [{ visible: true, count: 12 }] },
      }),
    ).toBe(true);
    expect(
      shouldContinuouslyUpdateDirectorShadows({
        isPlaying: false,
        playerMode: false,
        world: { ...staticWorld, roads: [{ visible: true, vehicleCount: 6 }] },
      }),
    ).toBe(true);
    expect(
      shouldContinuouslyUpdateDirectorShadows({
        isPlaying: false,
        playerMode: false,
        world: { ...staticWorld, effects: [{ kind: "fire", visible: true, intensity: 1 }] },
      }),
    ).toBe(false);
    expect(
      shouldContinuouslyUpdateDirectorShadows({
        isPlaying: false,
        playerMode: false,
        world: { ...staticWorld, settings: { enabled: false }, wildlife: [{ visible: true, count: 12 }] },
      }),
    ).toBe(false);
  });

  it("refreshes a cached camera preview on budget while compositing it on every presented frame", () => {
    expect(shouldRefreshDirectorCameraPreview(0, Number.NEGATIVE_INFINITY)).toBe(true);
    expect(shouldRefreshDirectorCameraPreview(1 / 120, 0)).toBe(false);
    expect(shouldRefreshDirectorCameraPreview(1 / DIRECTOR_CAMERA_PREVIEW_MAX_FPS, 0)).toBe(true);

    let mainViewportFrames = 0;
    let previewRefreshes = 0;
    let previewComposites = 0;
    let lastRefreshSeconds = Number.NEGATIVE_INFINITY;
    for (let displayFrame = 0; displayFrame < 120; displayFrame += 1) {
      const elapsedSeconds = displayFrame / 120;
      const plan = getDirectorCameraPreviewRenderPlan(elapsedSeconds, lastRefreshSeconds);
      if (plan.renderMainViewport) mainViewportFrames += 1;
      if (plan.refreshPictureInPicture) {
        previewRefreshes += 1;
        lastRefreshSeconds = elapsedSeconds;
      }
      if (plan.compositePictureInPicture) previewComposites += 1;
    }
    expect(mainViewportFrames).toBe(120);
    expect(previewRefreshes).toBe(30);
    expect(previewComposites).toBe(120);
  });

  it("refreshes a dirty camera preview immediately without dropping its composite", () => {
    expect(getDirectorCameraPreviewRenderPlan(1 / 120, 0, true)).toEqual({
      renderMainViewport: true,
      refreshPictureInPicture: true,
      compositePictureInPicture: true,
    });
  });

  it("pauses picture-in-picture scene refresh while the inset is being dragged", () => {
    expect(getDirectorCameraPreviewRenderPlan(1 / 120, 0, true, 30, true)).toEqual({
      renderMainViewport: true,
      refreshPictureInPicture: false,
      compositePictureInPicture: true,
    });
  });

  it("updates shadows only on the first pass of a composite render", () => {
    const shadowMap = { autoUpdate: true, needsUpdate: false };
    const restore = beginDirectorCompositeShadowPass(shadowMap);

    expect(shadowMap).toEqual({ autoUpdate: false, needsUpdate: true });
    shadowMap.needsUpdate = false;
    expect(shadowMap).toEqual({ autoUpdate: false, needsUpdate: false });

    restore();
    expect(shadowMap).toEqual({ autoUpdate: true, needsUpdate: false });
  });

  it("aggregates renderer counters across all passes in a composite frame", () => {
    const info = { autoReset: true, render: { frame: 12 }, reset: vi.fn() };
    const restore = beginDirectorCompositeRendererInfoPass(info);

    expect(info.autoReset).toBe(false);
    expect(info.reset).toHaveBeenCalledTimes(1);
    const compositeFrame = getDirectorRenderFrameKey(info);
    info.render.frame = 99;
    expect(getDirectorRenderFrameKey(info)).toBe(compositeFrame);
    expect(claimDirectorPrimaryCompositeRenderPass(info)).toBe(true);
    expect(claimDirectorPrimaryCompositeRenderPass(info)).toBe(false);

    restore();
    expect(info.autoReset).toBe(true);
    expect(getDirectorRenderFrameKey(info)).toBe(99);
    expect(claimDirectorPrimaryCompositeRenderPass(info)).toBe(true);
  });
});
