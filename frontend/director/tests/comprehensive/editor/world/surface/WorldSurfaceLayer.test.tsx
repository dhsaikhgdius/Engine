import { act, render } from "@testing-library/react";
import type { Group } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import WorldSurfaceLayer from "../../../../../src/comprehensive/editor/world/surface/WorldSurfaceLayer";

const mocks = vi.hoisted(() => ({
  frame: null as null | (() => void),
  invalidate: vi.fn(),
  scene: {} as Group,
  syncMaterials: vi.fn(),
  writeUniforms: vi.fn(),
}));

vi.mock("@react-three/fiber", () => ({
  useFrame: (callback: () => void) => {
    mocks.frame = callback;
  },
  useThree: (selector: (state: { invalidate: () => void; scene: Group }) => unknown) =>
    selector({ invalidate: mocks.invalidate, scene: mocks.scene }),
}));

vi.mock("../../../../../src/comprehensive/editor/world/surface/worldMaterialPatch", () => ({
  createWorldSurfaceUniforms: () => ({
    uWorldWetness: { value: 0 },
    uWorldSnowCover: { value: 0 },
    uWorldWindDir: { value: { set: vi.fn() } },
    uWorldWindStrength: { value: 0 },
    uWorldTime: { value: 0 },
  }),
  restorePatchedWorldSurfaceMaterials: vi.fn(),
  syncWorldSurfaceMaterials: mocks.syncMaterials,
  writeWorldSurfaceUniforms: mocks.writeUniforms,
}));

vi.mock("../../../../../src/comprehensive/editor/world/surface/worldHeightMap", () => ({
  acquireWorldHeightMap: vi.fn(),
  releaseWorldHeightMap: vi.fn(),
}));

vi.mock("../../../../../src/comprehensive/editor/world/surface/worldSurfaceResponse", () => ({
  collectWorldVegetationObjectIds: () => new Set<string>(),
}));

vi.mock("../../../../../src/comprehensive/editor/world/surface/worldAmbientAudio", () => ({ default: () => null }));

const weather = { preset: "clear", intensity: 0, wetness: 0, cloudCover: 0 };
const context = {
  worldSeconds: 0,
  frame: 0,
  fps: 24,
  isPlaying: false,
  seed: 1,
  settings: { weather },
  climate: { evolving: false, weather },
  windVector: [0, 0, 0],
  groundHeight: 0,
} as unknown as LivingWorldFrameContext;

describe("WorldSurfaceLayer material synchronization", () => {
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    mocks.frame = null;
    mocks.invalidate.mockClear();
    mocks.syncMaterials.mockClear();
    mocks.writeUniforms.mockClear();
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates uniforms every frame without traversing scene materials every frame", () => {
    render(<WorldSurfaceLayer captureHeightMap={false} context={context} evaluatedObjects={[]} />);

    expect(mocks.syncMaterials).toHaveBeenCalledTimes(1);
    expect(mocks.frame).not.toBeNull();

    act(() => {
      for (let index = 0; index < 30; index += 1) mocks.frame?.();
    });
    expect(mocks.writeUniforms).toHaveBeenCalledTimes(31);
    expect(mocks.syncMaterials).toHaveBeenCalledTimes(1);

    nowMs = 500;
    act(() => mocks.frame?.());
    expect(mocks.syncMaterials).toHaveBeenCalledTimes(2);
  });
});
