import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultDirectorWorldSettings } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { DirectorWorldSettings } from "../../../../../src/comprehensive/editor/schema/directorProject";
import {
  createDefaultDirectorProject,
  createInitialDirectorState,
  useDirectorStore,
} from "../../../../../src/comprehensive/editor/store/directorStore";
import type { LivingWorldFrameContext } from "../../../../../src/comprehensive/editor/world/livingWorldContracts";
import SkyLayer, { shouldShowSkyDome } from "../../../../../src/comprehensive/editor/world/sky/SkyLayer";

/**
 * Render-level contract tests for the `drivesSky === false` light-list rule:
 * the layer must not mount the dome, stars, clouds, or day/night lights when
 * the authored look owns the sky — the only allowed exception is the storm
 * lightning overlay.
 */

vi.mock("@react-three/fiber", () => ({
  useFrame: () => undefined,
  useThree: () => ({}),
}));

vi.mock("../../../../../src/comprehensive/editor/world/sky/AtmosphereSky", () => ({
  AtmosphereSky: () => <div data-testid="atmosphere-sky" />,
}));
vi.mock("../../../../../src/comprehensive/editor/world/sky/SkyStars", () => ({
  default: () => <div data-testid="sky-stars" />,
}));
vi.mock("../../../../../src/comprehensive/editor/world/sky/SkyClouds", () => ({
  default: () => <div data-testid="sky-clouds" />,
}));
vi.mock("../../../../../src/comprehensive/editor/world/sky/SkyLightningBolt", () => ({
  default: () => <div data-testid="lightning-bolt" />,
}));

function contextWith(settings: DirectorWorldSettings): LivingWorldFrameContext {
  return {
    worldSeconds: 0,
    frame: 0,
    fps: 24,
    isPlaying: false,
    seed: settings.seed,
    settings,
    windVector: [0, 0, 0],
    groundHeight: 0,
  };
}

function settingsWith(overrides: {
  drivesSky: boolean;
  weather?: Partial<DirectorWorldSettings["weather"]>;
}): DirectorWorldSettings {
  const base = createDefaultDirectorWorldSettings();
  return {
    ...base,
    timeOfDay: { ...base.timeOfDay, mode: "fixed", hours: 12, drivesSky: overrides.drivesSky },
    weather: { ...base.weather, ...overrides.weather },
  };
}

describe("shouldShowSkyDome", () => {
  it("mounts the dome only when drivesSky is on and no panorama backdrop renders", () => {
    expect(shouldShowSkyDome(true, false)).toBe(true);
    expect(shouldShowSkyDome(true, true)).toBe(false);
    expect(shouldShowSkyDome(false, false)).toBe(false);
    expect(shouldShowSkyDome(false, true)).toBe(false);
  });
});

describe("SkyLayer drivesSky=false contract", () => {
  beforeEach(() => {
    const project = createDefaultDirectorProject();
    useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState(), project });
  });

  it("mounts no dome, stars, clouds, or day/night lights while the authored look owns the sky", () => {
    const { container, queryByTestId } = render(
      <SkyLayer context={contextWith(settingsWith({ drivesSky: false, weather: { preset: "clear" } }))} />,
    );
    expect(queryByTestId("atmosphere-sky")).toBeNull();
    expect(queryByTestId("sky-stars")).toBeNull();
    expect(queryByTestId("sky-clouds")).toBeNull();
    expect(container.querySelector('[name="living-world-sun"]')).toBeNull();
    expect(container.querySelector('[name="living-world-sky-ambient"]')).toBeNull();
    expect(container.querySelector('[name="living-world-lightning-fill"]')).toBeNull();
    expect(container.querySelector('[name="living-world-lightning-key"]')).toBeNull();
    expect(queryByTestId("lightning-bolt")).toBeNull();
  });

  it("still allows the transient storm lightning overlay, and nothing else", () => {
    const { container, queryByTestId } = render(
      <SkyLayer
        context={contextWith(
          settingsWith({ drivesSky: false, weather: { preset: "storm", intensity: 1, cloudCover: 0.9 } }),
        )}
      />,
    );
    expect(container.querySelector('[name="living-world-lightning-fill"]')).not.toBeNull();
    expect(container.querySelector('[name="living-world-lightning-key"]')).not.toBeNull();
    expect(queryByTestId("lightning-bolt")).not.toBeNull();
    // The storm must not smuggle in the dome or the day/night lights.
    expect(queryByTestId("atmosphere-sky")).toBeNull();
    expect(queryByTestId("sky-stars")).toBeNull();
    expect(queryByTestId("sky-clouds")).toBeNull();
    expect(container.querySelector('[name="living-world-sun"]')).toBeNull();
    expect(container.querySelector('[name="living-world-sky-ambient"]')).toBeNull();
  });
});
