/**
 * Factory defaults for Director scene lights.
 *
 * These defaults exist so every freshly created scene or light is readable
 * immediately: a soft ambient fill plus one shadow-casting key light gives
 * the clay/white-box look usable contrast without any manual lighting work.
 * Names are user-facing UI copy in Simplified Chinese (the product's source
 * language); the fixed ids of the default set are relied upon by scene
 * templates and tests, so they must stay stable.
 */
import type { DirectorLight, DirectorLightType } from "./directorProject";

/** Default white color used for all new director lights. */
export const DEFAULT_DIRECTOR_LIGHT_COLOR = "#ffffff";

/** Creates the default ambient and directional light set for a new scene. */
export function createDefaultDirectorLights(): DirectorLight[] {
  return [
    {
      id: "light_ambient_1",
      name: "环境光",
      type: "ambient",
      visible: true,
      locked: false,
      color: DEFAULT_DIRECTOR_LIGHT_COLOR,
      intensity: 1.15,
    },
    {
      id: "light_directional_1",
      name: "主平行光",
      type: "directional",
      visible: true,
      locked: false,
      color: DEFAULT_DIRECTOR_LIGHT_COLOR,
      intensity: 1.2,
      position: [8, 10, 6],
      target: [0, 0, 0],
      castShadow: true,
    },
  ];
}

/**
 * Creates a single director light with sensible defaults for the given type.
 *
 * Per-type choices mirror three.js semantics: `distance: 0` means unlimited
 * range, `decay: 2` is physically-correct falloff, and ambient/hemisphere
 * lights get a lower default intensity (0.8) than placed lights because they
 * illuminate everything at once. Only lights that can meaningfully produce
 * shadows default to `castShadow: true`.
 */
export function createDirectorLight(id: string, type: DirectorLightType): DirectorLight {
  const common = {
    id,
    name: lightTypeDefaultName(type),
    type,
    visible: true,
    locked: false,
    color: DEFAULT_DIRECTOR_LIGHT_COLOR,
    intensity: type === "ambient" || type === "hemisphere" ? 0.8 : 1,
  } as const;

  if (type === "ambient") return common;
  if (type === "hemisphere") return { ...common, groundColor: "#303744", position: [0, 5, 0] };
  if (type === "point") return { ...common, position: [0, 3, 0], distance: 0, decay: 2, castShadow: true };
  if (type === "spot") {
    return {
      ...common,
      position: [3, 5, 3],
      target: [0, 0, 0],
      distance: 0,
      decay: 2,
      angle: Math.PI / 6,
      penumbra: 0.25,
      castShadow: true,
    };
  }
  if (type === "rect-area") {
    return { ...common, position: [0, 4, 2], target: [0, 1, 0], width: 2, height: 2 };
  }
  return { ...common, position: [5, 8, 5], target: [0, 0, 0], castShadow: true };
}

function lightTypeDefaultName(type: DirectorLightType) {
  switch (type) {
    case "ambient":
      return "环境光";
    case "hemisphere":
      return "半球光";
    case "directional":
      return "平行光";
    case "point":
      return "点光源";
    case "spot":
      return "聚光灯";
    case "rect-area":
      return "矩形面光";
  }
}
