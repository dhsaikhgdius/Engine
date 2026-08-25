import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDirectorWorld } from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  createDefaultDirectorProject,
  createInitialDirectorState,
  useDirectorStore,
} from "../../../../src/comprehensive/editor/store/directorStore";
import type { LivingWorldFrameContext } from "../../../../src/comprehensive/editor/world/livingWorldContracts";
import { LivingWorldLayer } from "../../../../src/comprehensive/editor/world/LivingWorldLayer";
import { advanceWorldAmbientClock, useWorldClockStore } from "../../../../src/comprehensive/editor/world/worldClock";

const fiberMocks = vi.hoisted(() => ({
  frame: null as null | {
    callback: (state: unknown, delta: number) => void;
    priority: number;
  },
}));

const layerMocks = vi.hoisted(() => ({
  sky: vi.fn<(context: LivingWorldFrameContext) => void>(),
}));

vi.mock("@react-three/fiber", async () => {
  const actual = await vi.importActual<typeof import("@react-three/fiber")>("@react-three/fiber");
  return {
    ...actual,
    useFrame: (callback: (state: unknown, delta: number) => void, priority = 0) => {
      fiberMocks.frame = { callback, priority };
    },
  };
});

vi.mock("../../../../src/comprehensive/editor/world/worldGround", () => ({ useWorldGroundSampler: () => undefined }));
vi.mock("../../../../src/comprehensive/editor/world/effects/EffectsLayer", () => ({ default: () => null }));
vi.mock("../../../../src/comprehensive/editor/world/water/WaterLayer", () => ({ default: () => null }));
vi.mock("../../../../src/comprehensive/editor/world/river/RiverLayer", () => ({ default: () => null }));
vi.mock("../../../../src/comprehensive/editor/world/wildlife/WildlifeLayer", () => ({ default: () => null }));
vi.mock("../../../../src/comprehensive/editor/world/traffic/TrafficLayer", () => ({ default: () => null }));
vi.mock("../../../../src/comprehensive/editor/world/surface/WorldSurfaceLayer", () => ({ default: () => null }));
vi.mock("../../../../src/comprehensive/editor/world/sky/SkyLayer", () => ({
  default: ({ context }: { context: LivingWorldFrameContext }) => {
    layerMocks.sky(context);
    return null;
  },
}));

describe("LivingWorldLayer render clock", () => {
  beforeEach(() => {
    const project = createDefaultDirectorProject();
    const world = createDefaultDirectorWorld();
    world.settings.enabled = true;
    world.settings.wind = { directionDegrees: 35, speedMps: 12, gustiness: 0.8, turbulence: 0.4 };
    project.world = world;
    useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState(), project });
    useWorldClockStore.setState({ ambientOffsetSeconds: 0, suspended: false, suspensionDepth: 0 });
    fiberMocks.frame = null;
    layerMocks.sky.mockClear();
  });

  it("mounts sky lighting on the first commit so the stage is not unlit while other world chunks load", () => {
    render(<LivingWorldLayer evaluatedObjects={[]} fps={24} frame={24} />);
    expect(layerMocks.sky).toHaveBeenCalledTimes(1);
  });

  it("advances one mutable frame context without rerendering the world layer tree", async () => {
    render(<LivingWorldLayer evaluatedObjects={[]} fps={24} frame={24} />);

    expect(layerMocks.sky).toHaveBeenCalledTimes(1);
    const initialContext = layerMocks.sky.mock.calls[0]![0];
    const initialWind = [...initialContext.windVector];

    await act(async () => {
      advanceWorldAmbientClock(2);
      await Promise.resolve();
    });

    expect(layerMocks.sky).toHaveBeenCalledTimes(1);
    expect(fiberMocks.frame).not.toBeNull();

    act(() => {
      fiberMocks.frame!.callback({}, 1 / 60);
    });

    expect(layerMocks.sky.mock.calls[0]![0]).toBe(initialContext);
    expect(initialContext.worldSeconds).toBe(3);
    expect(initialContext.windVector).not.toEqual(initialWind);
  });
});
