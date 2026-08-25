import { act, render } from "@testing-library/react";
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MixamoRiggedCharacter } from "../../../../../src/comprehensive/editor/runtime/mixamo/MixamoRiggedCharacter";
import type { DirectorCharacterLocomotionRuntimeState } from "../../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime";

const loader = vi.hoisted(() => vi.fn());
const frame = vi.hoisted(() => vi.fn());
const runtimeState = vi.hoisted(() => ({ current: null as unknown }));
const applyWeightedMotionFrame = vi.hoisted(() => vi.fn());

vi.mock("@react-three/fiber", () => ({
  useFrame: frame,
  useLoader: loader,
}));

vi.mock("../../../../../src/comprehensive/editor/runtime/gltfLoader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/comprehensive/editor/runtime/gltfLoader")>();
  return {
    ...actual,
    useDirectorGltfDocuments: loader,
  };
});

vi.mock("../../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/comprehensive/editor/runtime/mixamo/mixamoLocomotionRuntime")>();
  return {
    ...actual,
    readDirectorCharacterLocomotionRuntimeState: () => runtimeState.current,
  };
});

vi.mock("../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/comprehensive/editor/runtime/mixamo/mixamoMotion")>();
  return {
    ...actual,
    applyDirectorCharacterWeightedMotionFrame: applyWeightedMotionFrame,
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
  const clipName =
    url
      .split("/")
      .at(-1)
      ?.replace(/\.glb$/, "") ?? "motion";
  return {
    scene: createTestRig(),
    animations: [
      new AnimationClip(clipName, 1, [new VectorKeyframeTrack("Hips.position", [0, 1], [0, 1, 0, 0, 1.1, 0])]),
    ],
  };
}

type FrameCallback = (state: { invalidate: () => void }, deltaS: number) => void;
type AppliedLayer = { action: { getClip: () => AnimationClip; paused: boolean }; timeS: number; weight: number };

function lastAppliedLayers(): AppliedLayer[] {
  return applyWeightedMotionFrame.mock.lastCall?.[0]?.layers ?? [];
}

function renderRuntimeCharacter() {
  render(
    <MixamoRiggedCharacter
      runtimeControlled
      source={createTestRig()}
      sourceKey="test-rig"
      targetHeightM={1.78}
      rootName="test-player"
    />,
  );
  const renderFrame = frame.mock.calls[0]?.[0] as FrameCallback | undefined;
  expect(renderFrame).toBeTypeOf("function");
  applyWeightedMotionFrame.mockClear();
  return renderFrame!;
}

const BASE_RUNTIME_STATE = {
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
  transitionDurationS: 0.16,
  clipStartedFrame: 1,
} satisfies DirectorCharacterLocomotionRuntimeState;

describe("MixamoRiggedCharacter runtime layer", () => {
  beforeEach(() => {
    frame.mockReset();
    runtimeState.current = null;
    applyWeightedMotionFrame.mockReset();
    loader.mockReset();
    loader.mockImplementation((input: string | string[]) =>
      Array.isArray(input) ? input.map((url) => createTestMotion(url)) : createTestMotion(String(input)),
    );
  });

  it("preloads every packaged emote clip alongside the locomotion set", () => {
    renderRuntimeCharacter();

    const motionLoad = loader.mock.calls.find(([input]) => Array.isArray(input));
    expect(motionLoad?.[0]).toEqual(
      expect.arrayContaining([
        "/mixamo-animations/clips/wave.glb",
        "/mixamo-animations/clips/clap.glb",
        "/mixamo-animations/clips/talk.glb",
        "/mixamo-animations/clips/sit-idle.glb",
      ]),
    );
  });

  it("keeps walk playback when a sibling roam clip fails to load", () => {
    loader.mockImplementation((input: string | string[]) => {
      const urls = Array.isArray(input) ? input : [String(input)];
      return urls.map((url) => (String(url).includes("sit-idle") ? null : createTestMotion(url)));
    });
    const renderFrame = renderRuntimeCharacter();
    runtimeState.current = {
      ...BASE_RUNTIME_STATE,
      mode: "walk",
      speedMps: 2,
      localVelocityZ: 2,
    };

    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    expect(lastAppliedLayers().some((layer) => layer.action.getClip().name === "runtime-walk")).toBe(true);
  });

  it("floors a zero transition duration so roam entry crossfades instead of hard-cutting", () => {
    const renderFrame = renderRuntimeCharacter();
    runtimeState.current = { ...BASE_RUNTIME_STATE, transitionDurationS: 0 };

    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    let layers = lastAppliedLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].action.getClip().name).toBe("runtime-idle");
    expect(layers[0].weight).toBeGreaterThan(0);
    expect(layers[0].weight).toBeLessThan(0.2);

    act(() => renderFrame({ invalidate: vi.fn() }, 0.2));
    layers = lastAppliedLayers();
    expect(layers[0].weight).toBeCloseTo(1, 6);
  });

  it("plays the emote clip selected by emoteClipId and crossfades emote-to-emote switches", () => {
    const renderFrame = renderRuntimeCharacter();
    const waveState = {
      ...BASE_RUNTIME_STATE,
      mode: "emote",
      timeS: 0.2,
      transitionDurationS: 0.22,
      clipStartedFrame: 5,
      emoteClipId: "wave",
    } satisfies DirectorCharacterLocomotionRuntimeState;
    runtimeState.current = waveState;

    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    let layers = lastAppliedLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].action.getClip().name).toBe("runtime-wave");
    expect(layers[0].timeS).toBeCloseTo(0.2, 6);

    // Settle into steady playback, then switch to another emote performance.
    act(() => renderFrame({ invalidate: vi.fn() }, 0.3));
    runtimeState.current = { ...waveState, timeS: 0, clipStartedFrame: 9, emoteClipId: "talk" };
    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    layers = lastAppliedLayers();
    expect(layers.map((layer) => layer.action.getClip().name)).toEqual(["runtime-wave", "runtime-talk"]);
    expect(layers[0].weight).toBeGreaterThan(0);
    expect(layers[1].weight).toBeGreaterThan(0);
  });

  it("falls back to the idle clip when the requested emote is not packaged", () => {
    const renderFrame = renderRuntimeCharacter();
    runtimeState.current = {
      ...BASE_RUNTIME_STATE,
      mode: "emote",
      transitionDurationS: 0.22,
      emoteClipId: "moonwalk",
    } satisfies DirectorCharacterLocomotionRuntimeState;

    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    const layers = lastAppliedLayers();
    expect(layers).toHaveLength(1);
    expect(layers[0].action.getClip().name).toBe("runtime-idle");
  });

  it("re-arms a restarted one-shot emote even after its action clamped and paused", () => {
    const renderFrame = renderRuntimeCharacter();
    const waveState = {
      ...BASE_RUNTIME_STATE,
      mode: "emote",
      timeS: 0.9,
      transitionDurationS: 0.22,
      clipStartedFrame: 5,
      emoteClipId: "wave",
    } satisfies DirectorCharacterLocomotionRuntimeState;
    runtimeState.current = waveState;

    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    const waveLayer = lastAppliedLayers().find((layer) => layer.action.getClip().name === "runtime-wave");
    expect(waveLayer).toBeDefined();
    waveLayer!.action.paused = true;

    runtimeState.current = { ...waveState, timeS: 0, clipStartedFrame: 6 };
    act(() => renderFrame({ invalidate: vi.fn() }, 1 / 60));
    const restarted = lastAppliedLayers().find((layer) => layer.action.getClip().name === "runtime-wave");
    expect(restarted?.timeS).toBe(0);
    expect(restarted?.action.paused).toBe(false);
  });
});
