import { describe, expect, it } from "vitest";
import { WORLD_EFFECT_KINDS } from "../../../../../src/comprehensive/editor/world/effects/effectPresets";
import {
  BURN_EFFECT_VARIANTS,
  EFFECT_FRAGMENT_RAMPS,
  EFFECT_SPRITE_MASK_CHANNELS,
  EFFECT_VERTEX_SHADER,
  SCENE_LIT_EFFECT_VARIANTS,
  TIME_ANIMATED_EFFECT_VARIANTS,
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
    expect(EFFECT_VERTEX_SHADER).toContain("0.5 * uGravity * age * age");
    expect(EFFECT_VERTEX_SHADER).toContain("uTurbFrequency");
  });

  it("advects by the closed-form integral of the gusting wind", () => {
    // Mean wind times age is the base displacement...
    expect(EFFECT_VERTEX_SHADER).toContain("vec3 windDrift = uWind * (age + gustDrift);");
    // ...plus the exact antiderivative of the three gust bands over the
    // particle's age, mirroring worldWind.ts (0.9 / 2.33 / 5.71 rad/s).
    expect(EFFECT_VERTEX_SHADER).toContain("windGustIntegral(localTime) - windGustIntegral(spawnTime)");
    expect(EFFECT_VERTEX_SHADER).toContain("0.6 * uGustiness");
    expect(EFFECT_VERTEX_SHADER).toContain("0.55 * sin(t * 0.9)");
    expect(EFFECT_VERTEX_SHADER).toContain("uniform float uGustiness;");
    // Streak slant uses the instantaneous gusting wind, not the mean.
    expect(EFFECT_VERTEX_SHADER).toContain("uWind * (1.0 + 0.6 * uGustiness * windGustSignal(localTime))");
  });

  it("wraps camera-following precipitation and stretches quads along velocity", () => {
    expect(EFFECT_VERTEX_SHADER).toContain("uWrapExtents");
    expect(EFFECT_VERTEX_SHADER).toContain("mod(displaced - uOrigin + 0.5 * uWrapExtents, uWrapExtents)");
    expect(EFFECT_VERTEX_SHADER).toContain("uStretch");
    expect(EFFECT_VERTEX_SHADER).toContain("velocityView");
  });

  it("renders a hashed fraction of weather rain as ground splash rings", () => {
    // Splash designation is per-particle so scrubbing never reshuffles it.
    expect(EFFECT_VERTEX_SHADER).toContain("uniform float uSplash;");
    expect(EFFECT_VERTEX_SHADER).toContain("uniform float uGroundY;");
    expect(EFFECT_VERTEX_SHADER).toContain("float splashPick = hash11(");
    expect(EFFECT_VERTEX_SHADER).toContain("varying float vSplash;");
    // Rings sit flat on the splash plane and expand over their short cycle.
    expect(EFFECT_VERTEX_SHADER).toContain("vec3 ripple = vec3(corner.x, 0.0, corner.y) * size;");
    expect(EFFECT_VERTEX_SHADER).toContain("particlePos.y = mix(particlePos.y, uGroundY, isSplash);");
  });

  it("wobbles upright sprites instead of freely rotating them", () => {
    expect(EFFECT_VERTEX_SHADER).toContain("uniform float uUpright;");
    expect(EFFECT_VERTEX_SHADER).toContain("uUpright > 0.0 ? (r7 * 2.0 - 1.0) * uUpright : r7 * TAU");
  });

  it("ships a distinct color ramp per kind", () => {
    const fragments = WORLD_EFFECT_KINDS.map((kind) => buildEffectShaderSource(kind).fragmentShader);
    expect(new Set(fragments).size).toBe(WORLD_EFFECT_KINDS.length);
    for (const kind of WORLD_EFFECT_KINDS) {
      expect(EFFECT_FRAGMENT_RAMPS[kind]).toContain("vec4 effectRamp(float ageN, float rand, float mask)");
      expect(buildEffectShaderSource(kind).fragmentShader).toContain("effectRamp(vAgeNorm, vRand, mask)");
    }
  });

  it("selects a distinct sprite atlas channel per silhouette family", () => {
    // One shared RGBA atlas: flame teardrop (r), snow crystal (g), splash
    // ring (b), soft disc (a). See softParticleTexture.ts.
    expect(EFFECT_SPRITE_MASK_CHANNELS.fire).toBe("spriteTexel.r");
    expect(EFFECT_SPRITE_MASK_CHANNELS["fire-glow"]).toBe("spriteTexel.r");
    expect(EFFECT_SPRITE_MASK_CHANNELS.snow).toBe("spriteTexel.g");
    expect(EFFECT_SPRITE_MASK_CHANNELS.rain).toBe("mix(spriteTexel.a, spriteTexel.b, vSplash)");
    for (const variant of ["smoke", "steam", "sparks", "fireflies", "dust"] as const) {
      expect(EFFECT_SPRITE_MASK_CHANNELS[variant]).toBe("spriteTexel.a");
    }
    // Every variant's fragment shader actually samples its channel.
    for (const kind of WORLD_EFFECT_KINDS) {
      expect(buildEffectShaderSource(kind).fragmentShader).toContain(EFFECT_SPRITE_MASK_CHANNELS[kind]);
    }
    expect(buildEffectShaderSource("fire", "fire-glow").fragmentShader).toContain("spriteTexel.r");
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
    // Both passes cool along the shared blackbody locus; the glow's bloom
    // stays gated on the sprite core so stacks don't clip to white.
    expect(body.fragmentShader).toContain("effectFireBlackbody");
    expect(glow.fragmentShader).toContain("effectFireBlackbody");
    expect(EFFECT_FRAGMENT_RAMPS["fire-glow"]).toContain("pow(mask, 5.0)");
    // Flipbook-style life without an atlas: noise erosion scrolls with uTime.
    expect(EFFECT_FRAGMENT_RAMPS.fire).toContain("effectValueNoise");
    // The pass argument is ignored for single-pass kinds.
    expect(buildEffectShaderSource("smoke", "main")).toBe(buildEffectShaderSource("smoke"));
  });

  it("erodes the volumetric media with value noise", () => {
    for (const kind of ["smoke", "steam"] as const) {
      const { fragmentShader } = buildEffectShaderSource(kind);
      expect(fragmentShader).toContain("effectValueNoise");
      expect(fragmentShader).toContain("uniform float uTime;");
    }
    // Rain and fireflies animate purely through vertex-stage inputs.
    expect(buildEffectShaderSource("rain").fragmentShader).not.toContain("uniform float uTime;");
    expect(buildEffectShaderSource("fireflies").fragmentShader).not.toContain("uniform float uTime;");
    expect([...TIME_ANIMATED_EFFECT_VARIANTS].sort()).toEqual(
      ["fire", "fire-glow", "smoke", "steam", "sparks", "dust", "snow"].sort(),
    );
  });

  it("suppresses only the fire passes with the weather burn factor", () => {
    expect([...BURN_EFFECT_VARIANTS].sort()).toEqual(["fire", "fire-glow"].sort());
    expect(buildEffectShaderSource("fire", "fire-body").fragmentShader).toContain("uniform float uBurn;");
    expect(buildEffectShaderSource("fire", "fire-glow").fragmentShader).toContain("uniform float uBurn;");
    for (const kind of WORLD_EFFECT_KINDS.filter((entry) => entry !== "fire")) {
      expect(buildEffectShaderSource(kind).fragmentShader).not.toContain("uBurn");
    }
  });

  it("gives rain streak heads and splash ripples their own shading", () => {
    const rain = buildEffectShaderSource("rain").fragmentShader;
    // Streaks brighten toward the leading tip along the velocity axis.
    expect(rain).toContain("vUv.y");
    // Splash rings branch on the vSplash varying and fade as they expand.
    expect(rain).toContain("vSplash > 0.5");
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

  it("kills covered precipitation in the vertex shader via the height map", () => {
    // Vertex-stage occlusion (survey §3.5, AC4-style): covered drops collapse
    // their footprint to zero, saving all fragment work. The uniforms default
    // to a zero blend, so anchored (non-weather) systems skip the branch.
    expect(EFFECT_VERTEX_SHADER).toContain("uniform sampler2D uOcclusionMap;");
    expect(EFFECT_VERTEX_SHADER).toContain("directorWorldHeightMapUv");
    expect(EFFECT_VERTEX_SHADER).toContain("directorWorldUnpackHeight");
    expect(EFFECT_VERTEX_SHADER).toContain("if (uOcclusionBlend > 0.001)");
    // Soft cover band instead of a hard step so roof edges never pop.
    expect(EFFECT_VERTEX_SHADER).toContain("smoothstep(0.0, 0.45, occluderY -");
    expect(EFFECT_VERTEX_SHADER).toContain("vParticleWorld");
    // Fragment shaders no longer carry the occlusion sampling.
    for (const kind of WORLD_EFFECT_KINDS) {
      expect(buildEffectShaderSource(kind).fragmentShader).not.toContain("uOcclusionMap");
    }
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
