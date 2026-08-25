import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DirectorLight } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  DIRECTOR_VIEWPORT_SHADOW_LIGHT_LIMIT,
  DirectorSceneFog,
  DirectorSceneLighting,
  getDirectorShadowCastingLightIds,
  isDirectorLightShadowEnabled,
} from "../../../../src/comprehensive/editor/canvas/DirectorSceneLighting";

afterEach(() => vi.restoreAllMocks());

const lights: DirectorLight[] = [
  {
    id: "ambient",
    name: "Ambient",
    type: "ambient",
    visible: true,
    locked: false,
    color: "#ffffff",
    intensity: 0.4,
  },
  {
    id: "hemisphere",
    name: "Hemisphere",
    type: "hemisphere",
    visible: true,
    locked: false,
    color: "#ddeeff",
    groundColor: "#223344",
    intensity: 0.7,
  },
  {
    id: "directional",
    name: "Key",
    type: "directional",
    visible: true,
    locked: false,
    color: "#fff4dd",
    intensity: 2,
    position: [4, 6, 2],
    target: [0, 1, 0],
    castShadow: true,
  },
  {
    id: "point",
    name: "Practical",
    type: "point",
    visible: true,
    locked: false,
    color: "#ffb060",
    intensity: 3,
    position: [-2, 2, 1],
    castShadow: true,
  },
  {
    id: "spot",
    name: "Rim",
    type: "spot",
    visible: true,
    locked: false,
    color: "#aaccff",
    intensity: 4,
    position: [2, 5, -3],
    target: [0, 1, 0],
    castShadow: true,
  },
  {
    id: "area",
    name: "Softbox",
    type: "rect-area",
    visible: true,
    locked: false,
    color: "#ffffff",
    intensity: 5,
    position: [0, 4, 2],
    target: [0, 1, 0],
    width: 3,
    height: 2,
  },
  {
    id: "hidden",
    name: "Hidden",
    type: "point",
    visible: false,
    locked: false,
    color: "#ffffff",
    intensity: 10,
  },
];

it("renders all authored light types and suppresses disabled global shadows", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { container } = render(<DirectorSceneLighting lights={lights} shadowsEnabled={false} shadowMapSize={2048} />);

  expect(container.querySelectorAll("ambientlight")).toHaveLength(1);
  expect(container.querySelectorAll("hemispherelight")).toHaveLength(1);
  expect(container.querySelectorAll("directionallight")).toHaveLength(1);
  expect(container.querySelectorAll("pointlight")).toHaveLength(1);
  expect(container.querySelectorAll("spotlight")).toHaveLength(1);
  expect(container.querySelectorAll("rectarealight")).toHaveLength(1);
  expect(container.querySelector('[name="director-light-hidden"]')).not.toBeInTheDocument();
  expect(isDirectorLightShadowEnabled(lights[2], false)).toBe(false);
  expect(isDirectorLightShadowEnabled(lights[2], true)).toBe(true);
});

it("keeps enough texture units available for skinned character materials", () => {
  const repeatedShadowLights = Array.from({ length: 8 }, (_, index): DirectorLight => ({
    ...lights[2],
    id: `directional-${index + 1}`,
    name: `Key ${index + 1}`,
  }));

  expect(getDirectorShadowCastingLightIds(repeatedShadowLights, true)).toEqual(
    repeatedShadowLights.slice(0, DIRECTOR_VIEWPORT_SHADOW_LIGHT_LIMIT).map((light) => light.id),
  );
  expect(getDirectorShadowCastingLightIds(repeatedShadowLights, false)).toEqual([]);
});

it("adds one zero-energy directional light for the live character shadow layer", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { container } = render(<DirectorSceneLighting lights={lights} shadowsEnabled shadowMapSize={4096} />);

  expect(container.querySelectorAll("directionallight")).toHaveLength(2);
  expect(container.querySelector('[name="director-dynamic-shadow-light-directional"]')).toHaveAttribute(
    "intensity",
    "0",
  );
});

it("switches between linear and exponential fog contracts", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { container, rerender } = render(
    <DirectorSceneFog fog={{ enabled: true, mode: "linear", color: "#334455", near: 2, far: 20, density: 0.02 }} />,
  );
  expect(container.querySelector("fog")).toHaveAttribute("attach", "fog");

  rerender(
    <DirectorSceneFog
      fog={{ enabled: true, mode: "exponential", color: "#334455", near: 2, far: 20, density: 0.08 }}
    />,
  );
  expect(container.querySelector("fogexp2")).toHaveAttribute("attach", "fog");

  rerender(
    <DirectorSceneFog
      fog={{ enabled: false, mode: "exponential", color: "#334455", near: 2, far: 20, density: 0.08 }}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});
