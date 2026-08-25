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
    expect(dry.vertexShader).not.toContain("uWorldWindDir * (uWorldWindStrength");
    const veg = injectWorldSurfaceShaders(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader, true);
    expect(veg.vertexShader).toContain(WORLD_SURFACE_VEGETATION_SWAY_CHUNK.trim().slice(0, 20));
    expect(veg.vertexShader.indexOf("vWorldUpDot")).toBeGreaterThan(-1);
    expect(veg.fragmentShader).toContain("float porosity = 0.85;");
    expect(dry.fragmentShader).toContain("mix(0.55, 0.08, clamp(metalness, 0.0, 1.0))");
    expect(injectWorldSurfaceShaders("void main() {}", "void main() {}", true)).toEqual({
      vertexShader: "void main() {}",
      fragmentShader: "void main() {}",
    });
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
    expect(material.customProgramCacheKey()).toContain("director-world-surface-v1");
    restoreWorldSurfaceMaterial(material);
    const restored = fakeShader();
    material.onBeforeCompile(restored, undefined as never);
    expect(restored.vertexShader).toContain("wildlifePartAngleRad");
    expect(restored.vertexShader).not.toContain("uWorldWetness");
    material.dispose();
  });

  it("writes weather uniforms as a pure function of wind and weather", () => {
    const uniforms = createWorldSurfaceUniforms();
    writeWorldSurfaceUniforms(
      uniforms,
      { preset: "rain", intensity: 1, wetness: 0, cloudCover: 0.6 },
      3,
      4,
      12.5,
    );
    expect(uniforms.uWorldWetness.value).toBeGreaterThan(0.9);
    expect(uniforms.uWorldSnowCover.value).toBe(0);
    expect(uniforms.uWorldWindDir.value.length()).toBeCloseTo(1, 10);
    expect(uniforms.uWorldTime.value).toBe(12.5);
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
