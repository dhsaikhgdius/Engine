import { act, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localAssetIt } from "../../../../../../packages/protocol/tests/localAssetTest";
import { MixamoCharacterModel } from "../../../../src/comprehensive/editor/runtime/MixamoCharacterModel";
import {
  collectMixamoBones,
  resolveMixamoBones,
} from "../../../../src/comprehensive/editor/runtime/mixamo/mixamoCharacterRig";
import { configureDirectorGLTFLoader } from "../../../../src/comprehensive/editor/runtime/gltfLoader";
import type { DirectorCharacterLocomotionRuntimeState } from "../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime";
import type { DirectorCharacterMotionState } from "../../../../src/comprehensive/editor/schema/directorProject";

const loader = vi.hoisted(() => vi.fn());
const motionDocuments = vi.hoisted(() => vi.fn());
const frame = vi.hoisted(() => vi.fn());
const runtimeState = vi.hoisted(() => ({ current: null as unknown }));
const applyWeightedMotionFrame = vi.hoisted(() => vi.fn());
const retargetClip = vi.hoisted(() => vi.fn());

vi.mock("@react-three/fiber", () => ({
  useFrame: frame,
  useLoader: loader,
}));

vi.mock("../../../../src/comprehensive/editor/runtime/gltfLoader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/runtime/gltfLoader")>();
  return {
    ...actual,
    useDirectorGltfDocuments: motionDocuments,
  };
});

vi.mock("../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime")
    >();
  return {
    ...actual,
    readDirectorCharacterLocomotionRuntimeState: () => runtimeState.current,
  };
});

vi.mock("../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion")>();
  return {
    ...actual,
    applyDirectorCharacterWeightedMotionFrame: applyWeightedMotionFrame,
    retargetMixamoAnimationClip: retargetClip.mockImplementation(actual.retargetMixamoAnimationClip),
  };
});

function createTestRig() {
  const root = new Group();
  const hips = new Bone();
  hips.name = "Hips";
  hips.position.y = 1;
  root.add(hips);
  root.updateMatrixWorld(true);
  return root;
}

function createTestMotion(url: string) {
  const source = createTestRig();
  const clipName =
    url
      .split("/")
      .at(-1)
      ?.replace(/\.glb$/, "") ?? "motion";
  return {
    scene: source,
    animations: [
      new AnimationClip(clipName, 1, [new VectorKeyframeTrack("Hips.position", [0, 1], [0, 1, 0, 0, 1.1, 0])]),
    ],
  };
}

describe("MixamoCharacterModel", () => {
  beforeEach(() => {
    frame.mockReset();
    loader.mockReset();
    motionDocuments.mockReset();
    runtimeState.current = null;
    applyWeightedMotionFrame.mockReset();
    // Keep the pass-through implementation installed by the module mock.
    retargetClip.mockClear();
    loader.mockImplementation(() => ({ animations: [], scene: createTestRig() }));
    const loadedMotionsByUrls = new Map<string, ReturnType<typeof createTestMotion>[]>();
    motionDocuments.mockImplementation((urls: string[]) => {
      const key = urls.join();
      const cached = loadedMotionsByUrls.get(key);
      if (cached) return cached;
      const loaded = urls.map((url) => createTestMotion(url));
      loadedMotionsByUrls.set(key, loaded);
      return loaded;
    });
  });

  it("keeps a non-player character static without loading locomotion clips or entering a frame loop", () => {
    render(<MixamoCharacterModel url="/mixamo-characters/models/x-bot.glb" />);

    expect(loader).toHaveBeenCalledWith(GLTFLoader, "/mixamo-characters/models/x-bot.glb", configureDirectorGLTFLoader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(motionDocuments).not.toHaveBeenCalled();
    expect(frame).not.toHaveBeenCalled();
  });

  it("loads every roam clip into one persistent frame runtime only for the active player", () => {
    render(<MixamoCharacterModel runtimeControlled url="/mixamo-characters/models/x-bot.glb" />);

    expect(motionDocuments).toHaveBeenCalledWith(
      expect.arrayContaining([
        "/mixamo-animations/clips/idle.glb",
        "/mixamo-animations/clips/walk.glb",
        "/mixamo-animations/clips/walk-back.glb",
        "/mixamo-animations/clips/walk-left.glb",
        "/mixamo-animations/clips/walk-right.glb",
        "/mixamo-animations/clips/run.glb",
        "/mixamo-animations/clips/run-back.glb",
        "/mixamo-animations/clips/run-left.glb",
        "/mixamo-animations/clips/run-right.glb",
        "/mixamo-animations/clips/jump.glb",
        // Roam emotes are part of the persistent runtime set so a hotkey can
        // start them without an async fetch mid-performance.
        "/mixamo-animations/clips/wave.glb",
        "/mixamo-animations/clips/clap.glb",
        "/mixamo-animations/clips/talk.glb",
        "/mixamo-animations/clips/sit-idle.glb",
      ]),
    );
    expect(motionDocuments.mock.calls[0]?.[0]).toHaveLength(14);
    expect(frame).toHaveBeenCalledTimes(1);
  });

  it("keeps the runtime mixer and actions across playback-only motion edits and rebuilds on clip changes", () => {
    // Mirror useLoader's suspense cache so rerenders observe reference-stable
    // loader results, as they do in the live renderer.
    const loadedByInput = new Map<string, unknown>();
    loader.mockImplementation((_loader, input: string | string[]) => {
      const key = Array.isArray(input) ? input.join() : input;
      if (!loadedByInput.has(key)) {
        loadedByInput.set(
          key,
          Array.isArray(input) ? input.map((url) => createTestMotion(url)) : { animations: [], scene: createTestRig() },
        );
      }
      return loadedByInput.get(key);
    });
    const renderModel = (motion: Partial<DirectorCharacterMotionState>) => (
      <MixamoCharacterModel
        runtimeControlled
        rigState={{
          rigType: "mixamo",
          posePresetId: "stand",
          controls: {},
          motion: {
            clipId: "wave",
            enabled: true,
            loop: "repeat",
            speed: 1,
            weight: 1,
            startFrame: 0,
            blendInS: 0,
            blendOutS: 0,
            rootMotion: "in-place",
            ...motion,
          },
        }}
        url="/mixamo-characters/models/x-bot.glb"
      />
    );
    const { rerender } = render(renderModel({}));
    const mounted = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(mounted.layers[0].action.getClip().name).toBe("timeline-wave");
    const retargetsAfterMount = retargetClip.mock.calls.length;
    expect(retargetsAfterMount).toBeGreaterThan(0);

    rerender(renderModel({ speed: 2 }));
    let frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(frameInput.mixer).toBe(mounted.mixer);
    expect(frameInput.actions).toBe(mounted.actions);
    expect(frameInput.layers[0].action).toBe(mounted.layers[0].action);
    expect(retargetClip).toHaveBeenCalledTimes(retargetsAfterMount);

    rerender(renderModel({ speed: 2, weight: 0.5, startFrame: 12, blendInS: 0.3, blendOutS: 0.2 }));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(frameInput.mixer).toBe(mounted.mixer);
    expect(frameInput.actions).toBe(mounted.actions);
    expect(retargetClip).toHaveBeenCalledTimes(retargetsAfterMount);

    rerender(renderModel({ clipId: "idle" }));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(frameInput.mixer).not.toBe(mounted.mixer);
    expect(frameInput.layers[0].action).not.toBe(mounted.layers[0].action);
    expect(frameInput.layers[0].action.getClip().name).toBe("timeline-idle");
    expect(retargetClip.mock.calls.length).toBeGreaterThan(retargetsAfterMount);
  });

  it("loads only the requested timeline clip and samples it without a per-frame callback", () => {
    render(
      <MixamoCharacterModel
        rigState={{
          rigType: "mixamo",
          posePresetId: "stand",
          controls: {},
          motion: {
            clipId: "wave",
            enabled: true,
            loop: "repeat",
            speed: 1,
            weight: 1,
            startFrame: 0,
            blendInS: 0.12,
            blendOutS: 0,
            rootMotion: "in-place",
          },
        }}
        url="/mixamo-characters/models/x-bot.glb"
      />,
    );

    expect(loader).toHaveBeenCalledWith(GLTFLoader, "/mixamo-animations/clips/wave.glb", configureDirectorGLTFLoader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(frame).not.toHaveBeenCalled();
  });

  it("samples smoothed four-way layers by normalized phase, applies turn lean, and restarts jump", () => {
    loader.mockImplementation((_loader, input: string | string[]) =>
      Array.isArray(input) ? input.map((url) => createTestMotion(url)) : { animations: [], scene: createTestRig() },
    );
    render(<MixamoCharacterModel runtimeControlled url="/mixamo-characters/models/x-bot.glb" />);
    const renderFrame = frame.mock.calls[0]?.[0] as
      ((state: { invalidate: () => void }, deltaS: number) => void) | undefined;
    expect(renderFrame).toBeTypeOf("function");
    applyWeightedMotionFrame.mockClear();

    const locomotion = {
      version: 1,
      mode: "walk",
      timeS: 0.25,
      speedMps: 2,
      normalizedPhase: 0.25,
      playbackRate: 1,
      weight: 1,
      localVelocityX: 0,
      localVelocityZ: 2,
      angularVelocityRadS: 0,
      verticalVelocityMps: 0,
      grounded: true,
      jumpPhase: "none",
      transitionDurationS: 0.4,
      clipStartedFrame: 0,
    } satisfies DirectorCharacterLocomotionRuntimeState;
    runtimeState.current = locomotion;

    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.2));
    let frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(frameInput.layers).toHaveLength(1);
    expect(frameInput.layers[0].action.getClip().name).toBe("runtime-walk");
    expect(frameInput.layers[0].timeS / frameInput.layers[0].durationS).toBeCloseTo(0.25, 6);
    expect(frameInput.layers[0].weight).toBeCloseTo(0.5, 6);

    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.2));

    runtimeState.current = {
      ...locomotion,
      normalizedPhase: 0.4,
      localVelocityX: 2,
      localVelocityZ: 0,
      angularVelocityRadS: Math.PI / 2,
    };
    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.01));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(
      frameInput.layers.map((layer: { action: { getClip: () => AnimationClip } }) => layer.action.getClip().name),
    ).toEqual(["runtime-walk", "runtime-walk-right"]);
    expect(frameInput.layers[0].weight).toBeGreaterThan(0);
    expect(frameInput.layers[1].weight).toBeGreaterThan(0);
    expect(frameInput.layers[1].timeS / frameInput.layers[1].durationS).toBeCloseTo(0.4, 6);
    expect(frameInput.controls["body.roll"]).toBeGreaterThan(0);

    runtimeState.current = {
      ...locomotion,
      mode: "jump",
      timeS: 0.5,
      normalizedPhase: 0.2,
      localVelocityX: 0,
      localVelocityZ: 0,
      grounded: false,
      jumpPhase: "airborne",
      transitionDurationS: 0,
      clipStartedFrame: 10,
    };
    act(() => renderFrame?.({ invalidate: vi.fn() }, 1 / 60));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    const jumpLayer = frameInput.layers.find(
      (layer: { action: { getClip: () => AnimationClip } }) => layer.action.getClip().name === "runtime-jump",
    );
    expect(jumpLayer.timeS).toBeCloseTo(0.5, 6);
    jumpLayer.action.paused = true;

    runtimeState.current = {
      ...(runtimeState.current as DirectorCharacterLocomotionRuntimeState),
      timeS: 0,
      normalizedPhase: 0,
      clipStartedFrame: 11,
    };
    act(() => renderFrame?.({ invalidate: vi.fn() }, 1 / 60));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    const restartedJumpLayer = frameInput.layers.find(
      (layer: { action: { getClip: () => AnimationClip } }) => layer.action.getClip().name === "runtime-jump",
    );
    expect(restartedJumpLayer.timeS).toBe(0);
    expect(restartedJumpLayer.action.paused).toBe(false);
  });

  it("keeps the visible source mixture when a locomotion transition is interrupted", () => {
    loader.mockImplementation((_loader, input: string | string[]) =>
      Array.isArray(input) ? input.map((url) => createTestMotion(url)) : { animations: [], scene: createTestRig() },
    );
    render(
      <MixamoCharacterModel
        runtimeControlled
        rigState={{
          rigType: "mixamo",
          posePresetId: "stand",
          controls: {},
          motion: {
            clipId: "idle",
            enabled: true,
            loop: "repeat",
            speed: 1,
            weight: 1,
            startFrame: 0,
            blendInS: 0,
            blendOutS: 0,
            rootMotion: "in-place",
          },
        }}
        url="/mixamo-characters/models/x-bot.glb"
      />,
    );
    const renderFrame = frame.mock.calls[0]?.[0] as
      ((state: { invalidate: () => void }, deltaS: number) => void) | undefined;
    const walkState = {
      version: 1,
      mode: "walk",
      timeS: 0.1,
      speedMps: 2,
      normalizedPhase: 0.1,
      playbackRate: 1,
      weight: 1,
      localVelocityX: 0,
      localVelocityZ: 2,
      angularVelocityRadS: 0,
      verticalVelocityMps: 0,
      grounded: true,
      jumpPhase: "none",
      transitionDurationS: 0.4,
      clipStartedFrame: 1,
    } satisfies DirectorCharacterLocomotionRuntimeState;
    runtimeState.current = walkState;

    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.1));
    let frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(
      frameInput.layers.map((layer: { action: { getClip: () => AnimationClip } }) => layer.action.getClip().name),
    ).toEqual(["timeline-idle", "runtime-walk"]);
    expect(frameInput.layers[0].weight).toBeCloseTo(0.84375, 6);
    expect(frameInput.layers[1].weight).toBeCloseTo(0.15625, 6);

    runtimeState.current = {
      ...walkState,
      mode: "jump",
      timeS: 0,
      normalizedPhase: 0,
      localVelocityZ: 0,
      grounded: false,
      jumpPhase: "takeoff",
      clipStartedFrame: 2,
    };
    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.01));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    const weights = Object.fromEntries(
      frameInput.layers.map((layer: { action: { getClip: () => AnimationClip }; weight: number }) => [
        layer.action.getClip().name,
        layer.weight,
      ]),
    );
    expect(weights["timeline-idle"]).toBeGreaterThan(0.8);
    expect(weights["runtime-walk"]).toBeGreaterThan(0.14);
    expect(weights["runtime-walk"]).toBeLessThan(0.2);
    expect(weights["runtime-jump"]).toBeCloseTo(0.00184375, 6);
  });

  it("restores authored lower-body controls continuously while roam exits", () => {
    loader.mockImplementation((_loader, input: string | string[]) =>
      Array.isArray(input) ? input.map((url) => createTestMotion(url)) : { animations: [], scene: createTestRig() },
    );
    const leftHandIk = {
      target: [-0.4, 1.2, 0.2] as [number, number, number],
      pole: [-0.7, 1.1, 0.5] as [number, number, number],
      weight: 0.5,
      reachClamp: 0.98,
    };
    render(
      <MixamoCharacterModel
        runtimeControlled
        rigState={{
          rigType: "mixamo",
          posePresetId: "stand",
          controls: { "body.pitch": 20 },
          ik: { leftHand: leftHandIk },
        }}
        url="/mixamo-characters/models/x-bot.glb"
      />,
    );
    const renderFrame = frame.mock.calls[0]?.[0] as
      ((state: { invalidate: () => void }, deltaS: number) => void) | undefined;
    runtimeState.current = {
      version: 1,
      mode: "idle",
      timeS: 0,
      speedMps: 0,
      normalizedPhase: 0,
      playbackRate: 1,
      weight: 1,
      localVelocityX: 0,
      localVelocityZ: 0,
      angularVelocityRadS: 0,
      verticalVelocityMps: 0,
      grounded: true,
      jumpPhase: "none",
      transitionDurationS: 0,
      clipStartedFrame: 1,
    } satisfies DirectorCharacterLocomotionRuntimeState;
    act(() => renderFrame?.({ invalidate: vi.fn() }, 1 / 60));

    runtimeState.current = null;
    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.05));
    let frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(frameInput.ik).toBeUndefined();
    expect(frameInput.controls["body.pitch"]).toBeGreaterThan(0);
    expect(frameInput.controls["body.pitch"]).toBeLessThan(20);

    act(() => renderFrame?.({ invalidate: vi.fn() }, 0.2));
    frameInput = applyWeightedMotionFrame.mock.lastCall?.[0];
    expect(frameInput.ik?.leftHand).toBe(leftHandIk);
    expect(frameInput.controls["body.pitch"]).toBe(20);
  });

  localAssetIt("parses the packaged Mixamo X-Bot GLB and resolves its production deform chains", async () => {
    const bytes = readFileSync(resolve(process.cwd(), "assets/library/mixamo-characters/models/x-bot.glb"));
    const buffer = Uint8Array.from(bytes).buffer;
    const gltf = await new Promise<GLTF>((resolveGltf, rejectGltf) => {
      configureDirectorGLTFLoader(new GLTFLoader()).parse(buffer, "", resolveGltf, rejectGltf);
    });
    const bones = collectMixamoBones(gltf.scene);
    const resolvedBones = resolveMixamoBones(gltf.scene, bones);

    expect(bones).toHaveLength(65);
    expect(Object.keys(resolvedBones).sort()).toEqual(
      [
        "body",
        "head",
        "leftElbow",
        "leftFoot",
        "leftHand",
        "leftHip",
        "leftKnee",
        "leftShoulder",
        "rightElbow",
        "rightFoot",
        "rightHand",
        "rightHip",
        "rightKnee",
        "rightShoulder",
        "torso",
      ].sort(),
    );
  });
});
