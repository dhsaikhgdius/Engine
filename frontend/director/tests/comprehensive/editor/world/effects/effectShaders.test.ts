import { describe, expect, it } from "vitest";
import { WORLD_EFFECT_KINDS } from "../../../../../src/comprehensive/editor/world/effects/effectPresets";
import {
  EFFECT_FRAGMENT_RAMPS,
  EFFECT_VERTEX_SHADER,
  SCENE_LIT_EFFECT_VARIANTS,
  buildEffectShaderSource,
} from "../../../../../src/comprehensive/editor/world/effects/effectShaders";

describe("effect shader assembly", () => {
  it("is deterministic: repeated builds return identical sources", () => {
    for (const kind of WORLD_EFFECT_KINDS) {
      const first = buildEffectShaderSource(kind);
      const second = buildEffectShaderSource(kind);
      expect(first.vertexShader).toBe(second.vertexShader);
      expect(first.fragmentShader).toBe(second.fragmentShader);
      expect(first.vertexShader.length).toBeGreaterThan(0);
      expect(first.fragmentShader.length).toBeGreaterThan(0);
    }
  });

  it("evaluates the analytic particle lifecycle in the vertex shader", () => {
    expect(EFFECT_VERTEX_SHADER).toContain("attribute float aParticleIndex;");
    expect(EFFECT_VERTEX_SHADER).toContain("uniform float uTime;");
    expect(EFFECT_VERTEX_SHADER).toContain("uniform vec2 uSeed;");
    expect(EFFECT_VERTEX_SHADER).toContain("float age = mod(cursor, lifetime);");
    expect(EFFECT_VERTEX_SHADER).toContain("float cycleIndex = floor(cursor / lifetime);");
    expect(EFFECT_VERTEX_SHADER).toContain("cycleIndex * 0.7071067");
    expect(EFFECT_VERTEX_SHADER).toContain("hash11");
    expect(EFFECT_VERTEX_SHADER).toContain("uWind * age");
    expect(EFFECT_VERTEX_SHADER).toContain("0.5 * uGravity * age * age");
    expect(EFFECT_VERTEX_SHADER).toContain("uTurbFrequency");
  });

  it("wraps camera-following precipitation and stretches quads along velocity", () => {
    expect(EFFECT_VERTEX_SHADER).toContain("uWrapExtents");
    expect(EFFECT_VERTEX_SHADER).toContain("mod(displaced - uOrigin + 0.5 * uWrapExtents, uWrapExtents)");
    expect(EFFECT_VERTEX_SHADER).toContain("uStretch");
    expect(EFFECT_VERTEX_SHADER).toContain("velocityView");
  });

  it("ships a distinct color ramp per kind", () => {
    const fragments = WORLD_EFFECT_KINDS.map((kind) => buildEffectShaderSource(kind).fragmentShader);
    expect(new Set(fragments).size).toBe(WORLD_EFFECT_KINDS.length);
    for (const kind of WORLD_EFFECT_KINDS) {
      expect(EFFECT_FRAGMENT_RAMPS[kind]).toContain("vec4 effectRamp(float ageN, float rand, float mask)");
      expect(buildEffectShaderSource(kind).fragmentShader).toContain("effectRamp(vAgeNorm, vRand, mask)");
    }
  });

  it("parameterizes fire as body + glow shader variants", () => {
    const body = buildEffectShaderSource("fire", "fire-body");
    const glow = buildEffectShaderSource("fire", "fire-glow");
    // "main" resolves to the body ramp for fire.
    expect(buildEffectShaderSource("fire")).toBe(body);
    expect(body.fragmentShader).not.toBe(glow.fragmentShader);
    expect(body.vertexShader).toBe(glow.vertexShader);
    expect(EFFECT_FRAGMENT_RAMPS["fire-glow"]).toContain("vec4 effectRamp(float ageN, float rand, float mask)");
    // Glow must stay distinct from every single-pass kind ramp too.
    const fragments = WORLD_EFFECT_KINDS.map((kind) => buildEffectShaderSource(kind).fragmentShader);
    expect(fragments).not.toContain(glow.fragmentShader);
    // Body occludes (dark ember tones + widened mask); glow layers hot color.
    expect(EFFECT_FRAGMENT_RAMPS.fire).toContain("pow(mask, 0.6)");
    expect(EFFECT_FRAGMENT_RAMPS["fire-glow"]).toContain("pow(mask, 5.0)");
    // The pass argument is ignored for single-pass kinds.
    expect(buildEffectShaderSource("smoke", "main")).toBe(buildEffectShaderSource("smoke"));
  });

  it("compiles three's scene-fog chunks into every shader", () => {
    expect(EFFECT_VERTEX_SHADER).toContain("#include <fog_pars_vertex>");
    expect(EFFECT_VERTEX_SHADER).toContain("vFogDepth = -viewCenter.z;");
    for (const kind of WORLD_EFFECT_KINDS) {
      const { fragmentShader } = buildEffectShaderSource(kind);
      expect(fragmentShader).toContain("#include <fog_pars_fragment>");
      expect(fragmentShader).toContain("#include <fog_fragment>");
    }
  });

  it("supports optional color tinting in every fragment shader", () => {
    for (const kind of WORLD_EFFECT_KINDS) {
      const { fragmentShader } = buildEffectShaderSource(kind);
      expect(fragmentShader).toContain("uTint");
      expect(fragmentShader).toContain("uTintFlag");
    }
  });

  it("multiplies scattering-lit ramp color — never alpha — by the scene light tint", () => {
    const litKinds = ["smoke", "steam", "dust", "rain", "snow"] as const;
    expect([...SCENE_LIT_EFFECT_VARIANTS].sort()).toEqual([...litKinds].sort());
    for (const kind of litKinds) {
      const { fragmentShader } = buildEffectShaderSource(kind);
      expect(fragmentShader).toContain("uniform vec3 uSceneLightColor;");
      expect(fragmentShader).toContain("uniform float uSceneLightLevel;");
      expect(fragmentShader).toContain("color *= uSceneLightColor * uSceneLightLevel;");
      expect(fragmentShader).not.toContain("alpha *= uSceneLightLevel");
    }
  });

  it("keeps emissive kinds unlit by the scene tint", () => {
    const unlitBuilds = [
      buildEffectShaderSource("fire", "fire-body"),
      buildEffectShaderSource("fire", "fire-glow"),
      buildEffectShaderSource("sparks"),
      buildEffectShaderSource("fireflies"),
    ];
    for (const { fragmentShader } of unlitBuilds) {
      expect(fragmentShader).not.toContain("uSceneLightColor");
      expect(fragmentShader).not.toContain("uSceneLightLevel");
    }
  });

  it("night-boosts only the firefly alpha", () => {
    const fireflies = buildEffectShaderSource("fireflies").fragmentShader;
    expect(fireflies).toContain("uniform float uNightBoost;");
    expect(fireflies).toContain("alpha *= uNightBoost;");
    for (const kind of WORLD_EFFECT_KINDS.filter((entry) => entry !== "fireflies")) {
      expect(buildEffectShaderSource(kind).fragmentShader).not.toContain("uNightBoost");
    }
    expect(buildEffectShaderSource("fire", "fire-glow").fragmentShader).not.toContain("uNightBoost");
  });

  it("occludes rain and snow under the camera-centred height map, not fire", () => {
    const rain = buildEffectShaderSource("rain").fragmentShader;
    const snow = buildEffectShaderSource("snow").fragmentShader;
    const fire = buildEffectShaderSource("fire").fragmentShader;
    expect(rain).toContain("uOcclusionMap");
    expect(rain).toContain("directorWorldHeightMapUv");
    expect(snow).toContain("uOcclusionBlend");
    expect(fire).not.toContain("uOcclusionMap");
    expect(EFFECT_VERTEX_SHADER).toContain("vParticleWorld");
  });

  it("never references wall-clock or unseeded randomness", () => {
    for (const kind of WORLD_EFFECT_KINDS) {
      const { vertexShader, fragmentShader } = buildEffectShaderSource(kind);
      expect(vertexShader).not.toContain("Math.random");
      expect(fragmentShader).not.toContain("Math.random");
      expect(vertexShader).not.toContain("Date.now");
      expect(fragmentShader).not.toContain("Date.now");
    }
  });
});
