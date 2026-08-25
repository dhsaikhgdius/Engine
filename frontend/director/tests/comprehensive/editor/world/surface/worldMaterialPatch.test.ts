import { describe, expect, it } from "vitest";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  ShaderLib,
  ShaderMaterial,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { createWildlifePartMaterial } from "../../../../../src/comprehensive/editor/world/wildlife/wildlifePartMaterial";
import {
  WORLD_SURFACE_COLOR_CHUNK,
  WORLD_SURFACE_ROUGHNESS_CHUNK,
  WORLD_SURFACE_VEGETATION_SWAY_CHUNK,
  createWorldSurfaceUniforms,
  injectWorldSurfaceShaders,
  isWorldSurfacePatchableMaterial,
  isWorldVegetationMesh,
  patchWorldSurfaceMaterial,
  restoreWorldSurfaceMaterial,
  shouldSkipWorldSurfaceMesh,
  syncWorldSurfaceMaterials,
  writeWorldSurfaceUniforms,
} from "../../../../../src/comprehensive/editor/world/surface/worldMaterialPatch";

function fakeShader(): WebGLProgramParametersWithUniforms {
  return {
    vertexShader: ShaderLib.standard.vertexShader,
    fragmentShader: ShaderLib.standard.fragmentShader,
    uniforms: {},
  } as unknown as WebGLProgramParametersWithUniforms;
}

describe("world surface shader anchors", () => {
  it("pins the ShaderLib.standard chunks the injection rewrites", () => {
    expect(ShaderLib.standard.vertexShader).toContain("#include <common>");
    expect(ShaderLib.standard.vertexShader).toContain("#include <begin_vertex>");
    expect(ShaderLib.standard.vertexShader).toContain("#include <defaultnormal_vertex>");
    expect(ShaderLib.standard.fragmentShader).toContain("#include <color_fragment>");
    expect(ShaderLib.standard.fragmentShader).toContain("#include <metalnessmap_fragment>");
  });

  it("injects wetness/snow on every variant and sway only on vegetation", () => {
    const dry = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, false);
    expect(dry.fragmentShader).toContain(WORLD_SURFACE_COLOR_CHUNK.trim().slice(0, 24));
    expect(dry.fragmentShader).toContain("uWorldWetness");
    expect(dry.fragmentShader).toContain("uWorldSnowCover");
    expect(dry.vertexShader).not.toContain("uWorldWindStrength * height");
    const veg = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, true);
    expect(veg.vertexShader).toContain(WORLD_SURFACE_VEGETATION_SWAY_CHUNK.trim().slice(0, 20));
    expect(veg.vertexShader).toContain("uWorldWindStrength * height");
    expect(veg.vertexShader.indexOf("vWorldUpDot")).toBeGreaterThan(-1);
    expect(veg.fragmentShader).toContain("float porosity = 0.85;");
    expect(dry.fragmentShader).toContain("mix(0.55, 0.08, clamp(metalness, 0.0, 1.0))");
    expect(injectWorldSurfaceShaders("void main() {}", "void main() {}", true)).toEqual({
      vertexShader: "void main() {}",
      fragmentShader: "void main() {}",
    });
  });

  it("darkens and glazes porous dielectrics hardest while metals barely move (Lagarde)", () => {
    const dry = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, false);
    // First endpoint (porosity 0 ≙ metal) must sit closer to 1 than the
    // second (porosity 1): wet response GROWS with porosity, never shrinks.
    expect(dry.fragmentShader).toContain("mix(0.92, 0.52, porosity), wet");
    expect(dry.fragmentShader).toContain("mix(0.72, 0.28, porosity), wet");
  });

  it("consumes the full wind vector: direction, gustiness, and turbulence", () => {
    const veg = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, true);
    // Gust waves travel along the wind direction (dot with anchor) and the
    // steady lean + cross-wind flutter consume the direction vector itself.
    expect(veg.vertexShader).toContain("dot(anchor, uWorldWindDir)");
    expect(veg.vertexShader).toContain("uWorldWindGust");
    expect(veg.vertexShader).toContain("uWorldWindTurbulence");
    expect(veg.vertexShader).toContain("vec2 crossDir = vec2(-uWorldWindDir.y, uWorldWindDir.x);");
    // Phases come from uWorldTime + seeded anchor hash, never the wall clock.
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).toContain("uWorldTime");
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).toContain("uWorldSeed");
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).not.toContain("cameraPosition");
  });

  it("pulls the world-space lean back into object space so rotated plants read the wind", () => {
    // v * M multiplies by transpose(M) — the rotation inverse — so a plant
    // rotated 90° still bends down the WORLD wind, not its local +X. The
    // instance rotation joins the frame for instanced batches.
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).toContain("mat3 swayFrame = mat3(modelMatrix);");
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).toContain("swayFrame = swayFrame * mat3(instanceMatrix);");
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).toContain("vec3(swayWorld.x, 0.0, swayWorld.y) * swayFrame");
    // Re-normalised to the world magnitude: instance scale sways the plant
    // proportionally to its size, never by scale².
    expect(WORLD_SURFACE_VEGETATION_SWAY_CHUNK).toContain("length(swayWorld) / swayLocalLength");
  });

  it("pools seeded spatial puddles on flat faces but never on vegetation", () => {
    const dry = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, false);
    expect(dry.fragmentShader).toContain("uWorldPuddle");
    expect(dry.fragmentShader).toContain("directorWorldValueNoise(vWorldSurfaceXZ * 0.45)");
    expect(dry.fragmentShader).toContain("float puddleMask = 1.0;");
    expect(dry.vertexShader).toContain("vWorldSurfaceXZ");
    const veg = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, true);
    expect(veg.fragmentShader).toContain("float puddleMask = 0.0;");
    expect(veg.fragmentShader).not.toContain("float puddleMask = 1.0;");
  });
});

describe("world surface material patch", () => {
  it("skips ShaderMaterial and living-world overlay meshes", () => {
    expect(isWorldSurfacePatchableMaterial(new ShaderMaterial())).toBe(false);
    expect(isWorldSurfacePatchableMaterial(new MeshStandardMaterial())).toBe(true);
    const rain = new Mesh();
    rain.name = "living-world-effects";
    expect(shouldSkipWorldSurfaceMesh(rain)).toBe(true);
    const hall = new Mesh();
    hall.name = "大厅";
    expect(shouldSkipWorldSurfaceMesh(hall)).toBe(false);
    // TrafficLayer owns the asphalt weather response; vehicles stay patchable.
    const road = new Mesh();
    road.name = "living-world-road-road_1";
    expect(shouldSkipWorldSurfaceMesh(road)).toBe(true);
    const vehicles = new Mesh();
    vehicles.name = "living-world-traffic-vehicles-road_1";
    expect(shouldSkipWorldSurfaceMesh(vehicles)).toBe(false);
  });

  it("treats instanced batches as vegetation when any instance id matches", () => {
    const batch = new Mesh();
    batch.name = "director-static-primitive-batch";
    batch.userData.directorInstanceObjectIds = ["oak", "rock"];
    expect(isWorldVegetationMesh(batch, new Set(["oak"]))).toBe(true);
    expect(isWorldVegetationMesh(batch, new Set(["hall"]))).toBe(false);
    const wrapped = new Group();
    wrapped.name = "director-object-pine";
    const mesh = new Mesh();
    mesh.name = "geometry-box";
    wrapped.add(mesh);
    expect(isWorldVegetationMesh(mesh, new Set(["pine"]))).toBe(true);
  });

  it("chains an existing onBeforeCompile and restores it", () => {
    const material = createWildlifePartMaterial(0x8a6240);
    const uniforms = createWorldSurfaceUniforms();
    patchWorldSurfaceMaterial(material, uniforms, false);
    const shader = fakeShader();
    material.onBeforeCompile(shader, undefined as never);
    expect(shader.vertexShader).toContain("wildlifePartAngleRad");
    expect(shader.vertexShader).toContain("uWorldWetness");
    expect(shader.fragmentShader).toContain("uWorldSnowCover");
    expect(shader.uniforms.uWorldWetness).toBe(uniforms.uWorldWetness);
    expect(shader.uniforms.uWorldPuddle).toBe(uniforms.uWorldPuddle);
    expect(shader.uniforms.uWorldWindGust).toBe(uniforms.uWorldWindGust);
    expect(shader.uniforms.uWorldWindTurbulence).toBe(uniforms.uWorldWindTurbulence);
    expect(shader.uniforms.uWorldSeed).toBe(uniforms.uWorldSeed);
    expect(material.customProgramCacheKey()).toContain("director-world-surface-v2");
    restoreWorldSurfaceMaterial(material);
    const restored = fakeShader();
    material.onBeforeCompile(restored, undefined as never);
    expect(restored.vertexShader).toContain("wildlifePartAngleRad");
    expect(restored.vertexShader).not.toContain("uWorldWetness");
    material.dispose();
  });

  it("writes weather uniforms as a pure function of wind and weather", () => {
    const uniforms = createWorldSurfaceUniforms();
    writeWorldSurfaceUniforms(uniforms, { preset: "rain", intensity: 1, wetness: 0, cloudCover: 0.6 }, 3, 4, 12.5);
    expect(uniforms.uWorldWetness.value).toBeGreaterThan(0.9);
    expect(uniforms.uWorldSnowCover.value).toBe(0);
    expect(uniforms.uWorldPuddle.value).toBeGreaterThan(0.5);
    expect(uniforms.uWorldWindDir.value.length()).toBeCloseTo(1, 10);
    expect(uniforms.uWorldTime.value).toBe(12.5);
  });

  it("keeps clear + wetness 0 completely dry", () => {
    const uniforms = createWorldSurfaceUniforms();
    writeWorldSurfaceUniforms(uniforms, { preset: "clear", intensity: 0.5, wetness: 0, cloudCover: 0 }, 3, 4, 99, {
      seed: 42,
      gustiness: 0.5,
      turbulence: 0.5,
    });
    expect(uniforms.uWorldWetness.value).toBe(0);
    expect(uniforms.uWorldSnowCover.value).toBe(0);
    expect(uniforms.uWorldPuddle.value).toBe(0);
  });

  it("threads seed + gust character into the documented visual uniforms", () => {
    const uniforms = createWorldSurfaceUniforms();
    writeWorldSurfaceUniforms(uniforms, { preset: "clear", intensity: 0, wetness: 0, cloudCover: 0 }, 1, 0, 0, {
      seed: 20_260_813,
      gustiness: 0.35,
      turbulence: 0.8,
    });
    expect(uniforms.uWorldWindGust.value).toBeCloseTo(0.35, 10);
    // uWorldWindTurbulence drives the cross-wind foliage flutter amplitude.
    expect(uniforms.uWorldWindTurbulence.value).toBeCloseTo(0.8, 10);
    // Seed folds to a float32-exact offset for the GLSL spatial hash.
    expect(uniforms.uWorldSeed.value).toBe(20_260_813 % 2048);
    // Omitting the detail block leaves the previous character untouched.
    writeWorldSurfaceUniforms(uniforms, { preset: "clear", intensity: 0, wetness: 0, cloudCover: 0 }, 1, 0, 1);
    expect(uniforms.uWorldWindTurbulence.value).toBeCloseTo(0.8, 10);
  });

  it("patches scene meshes and ignores overlay shader materials", () => {
    const uniforms = createWorldSurfaceUniforms();
    const patched = new Set<Material>();
    const root = new Group();
    const hall = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    hall.name = "大厅";
    const water = new Mesh(new BoxGeometry(), new ShaderMaterial());
    water.name = "director-water-pond";
    root.add(hall, water);
    syncWorldSurfaceMaterials(root, uniforms, new Set(), patched);
    expect(patched.size).toBe(1);
    expect([...patched][0]).toBe(hall.material);
  });
});
