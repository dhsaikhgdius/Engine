import { EquirectangularReflectionMapping } from "three";
import { describe, expect, it } from "vitest";
import { createDefaultDirectorWorldSettings } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import { evaluateSkyAtmosphere } from "../../../../../src/comprehensive/editor/world/sky/solar";
import {
  ATMOSPHERE_ENVIRONMENT_INTENSITY,
  ATMOSPHERE_GPU_EXPOSURE,
  ATMOSPHERE_LUT_FLIP_Y,
  atmosphereSkyCloudAmount,
  atmosphereSkyRidgeAmplitude,
  createAtmosphereEnvironmentTexture,
} from "../../../../../src/comprehensive/editor/world/sky/AtmosphereSky";
import {
  ATMOSPHERE_SKY_FRAGMENT_SHADER,
  ATMOSPHERE_SKY_VERTEX_SHADER,
} from "../../../../../src/comprehensive/editor/world/sky/atmosphereSkyShaders";

describe("atmosphere sky film-set defaults", () => {
  it("does not flip the CPU zenith row and does not draw a default mountain matte", () => {
    expect(ATMOSPHERE_LUT_FLIP_Y).toBe(false);
    expect(atmosphereSkyRidgeAmplitude()).toBe(0);
  });

  it("keeps shader clouds off on a clear sky and follows authored cover", () => {
    expect(atmosphereSkyCloudAmount(0)).toBe(0);
    expect(atmosphereSkyCloudAmount(0.2)).toBeCloseTo(0.2);
    expect(atmosphereSkyCloudAmount(1.4)).toBe(1);
  });

  it("drives the dome cloud deck from coverage and darkens it per weather", () => {
    // Coverage must set the fbm threshold (not just scale a fixed wisp mask)
    // so a full cover closes the deck, and storms darken the deck colour.
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("mix(0.58, 0.02, cloudAmount)");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("uniform float cloudDarken");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("* cloudDarken");
    // The old constant 35% blend cap must be gone: heavy skies read covered.
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).not.toContain("cloud * 0.35");
  });

  it("gates the visible sun disc and aureole on the weather/twilight opacity", () => {
    // The disc must not be a hard-coded full-brightness dot: overcast keeps
    // no hard disc, storms crush it to a smudge, and at night the zeroed
    // opacity keeps it from shining through the below-horizon ground fill.
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("uniform float discOpacity");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("uniform float glowOpacity");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("* limb * discOpacity");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("* aureole * glowOpacity");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).not.toContain("sunColor * 8.0 * limb;");
  });

  it("drops the cloud deck to near-black after sunset instead of a glowing grey", () => {
    // Clouds are lit by the sky: the deck colour must follow the sun's
    // elevation so an overcast midnight reads as a dark ceiling.
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("smoothstep(-0.1, 0.16, sunDir.y)");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("mix(0.03, 1.0, dayLight)");
  });

  it("places the dome far from the camera instead of on an 80 m wall", () => {
    expect(ATMOSPHERE_SKY_VERTEX_SHADER).toContain("* 4000.0");
    expect(ATMOSPHERE_SKY_VERTEX_SHADER).not.toContain("* 80.0");
    expect(ATMOSPHERE_SKY_VERTEX_SHADER).not.toContain("gl_Position.z = gl_Position.w");
  });

  it("bakes the first sky LUT so IBL is not a black map on mount", () => {
    const settings = createDefaultDirectorWorldSettings();
    settings.timeOfDay = { ...settings.timeOfDay, mode: "fixed", hours: 12, drivesSky: true };
    const texture = createAtmosphereEnvironmentTexture(evaluateSkyAtmosphere(settings, 0));
    const data = texture.image.data as Float32Array;
    let peak = 0;
    for (let index = 0; index < data.length; index += 4) {
      peak = Math.max(peak, data[index]!, data[index + 1]!, data[index + 2]!);
    }
    expect(peak).toBeGreaterThan(0.2);
    texture.dispose();
  });

  it("displays the LUT at a gain that ACES can read as colour, and feeds it as IBL", () => {
    expect(ATMOSPHERE_GPU_EXPOSURE).toBeGreaterThanOrEqual(3);
    expect(ATMOSPHERE_ENVIRONMENT_INTENSITY).toBeGreaterThan(0.3);
    expect(ATMOSPHERE_ENVIRONMENT_INTENSITY).toBeLessThan(1);
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).not.toContain("* 0.52");
    expect(EquirectangularReflectionMapping).toBeGreaterThan(0);
  });

  it("lets Three provide tone-mapping and color-space declarations once", () => {
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("#include <common>");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).not.toContain("const float PI");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).not.toContain("#include <tonemapping_pars_fragment>");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).not.toContain("#include <colorspace_pars_fragment>");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("#include <tonemapping_fragment>");
    expect(ATMOSPHERE_SKY_FRAGMENT_SHADER).toContain("#include <colorspace_fragment>");
  });
});
