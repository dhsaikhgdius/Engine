import { describe, expect, it } from "vitest";
import { Color, Group, Mesh, Object3D, PerspectiveCamera, Scene, ShaderLib, ShaderMaterial } from "three";
import {
  WORLD_HEIGHT_MAP_CAMERA_DELTA_M,
  WORLD_HEIGHT_MAP_SAMPLE_GLSL,
  WORLD_HEIGHT_MAP_SIZE_M,
  WORLD_HEIGHT_MAP_Y_MAX,
  WORLD_HEIGHT_MAP_Y_MIN,
  bindWorldHeightMapUniforms,
  createWorldHeightMap,
  createWorldHeightMapRefreshMark,
  createWorldHeightMapSampleUniforms,
  injectWorldHeightMapVertexShader,
  isWorldHeightMapOverlayName,
  packWorldHeight,
  quantizeWorldHeightMapWorldSeconds,
  shouldHideObjectFromWorldHeightMap,
  shouldRefreshWorldHeightMap,
  unpackWorldHeight,
  worldHeightMapUv,
} from "../../../../../src/comprehensive/editor/world/surface/worldHeightMap";
import type { WebGLRenderer } from "three";

function createHeightMapRenderer() {
  const renderer = {
    autoClear: true,
    info: { render: { frame: 0 } },
    renderCalls: 0,
    beginFrame() {
      this.info.render.frame += 1;
    },
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getClearColor: (target: Color) => target.set(0),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    render() {
      this.info.render.frame += 1;
      this.renderCalls += 1;
    },
  };
  return renderer;
}

function createHeightMapCamera(x: number, y: number, z: number) {
  const camera = new PerspectiveCamera();
  camera.position.set(x, y, z);
  camera.updateMatrixWorld();
  return camera;
}

describe("world height pack/unpack", () => {
  it("round-trips the authored range and clamps outside it", () => {
    expect(unpackWorldHeight(packWorldHeight(WORLD_HEIGHT_MAP_Y_MIN))).toBeCloseTo(WORLD_HEIGHT_MAP_Y_MIN, 10);
    expect(unpackWorldHeight(packWorldHeight(WORLD_HEIGHT_MAP_Y_MAX))).toBeCloseTo(WORLD_HEIGHT_MAP_Y_MAX, 10);
    expect(unpackWorldHeight(packWorldHeight(12))).toBeCloseTo(12, 10);
    expect(packWorldHeight(-40)).toBe(0);
    expect(packWorldHeight(120)).toBe(1);
  });

  it("maps world XZ onto the down-looking ortho with −Z as camera up", () => {
    const uv = worldHeightMapUv(10, -6, 0, 0, WORLD_HEIGHT_MAP_SIZE_M);
    expect(uv.u).toBeCloseTo(10 / WORLD_HEIGHT_MAP_SIZE_M + 0.5, 10);
    expect(uv.v).toBeCloseTo(0.5 - -6 / WORLD_HEIGHT_MAP_SIZE_M, 10);
  });
});

describe("world height overlay culling", () => {
  it("hides living-world overlays and water so they do not fill the map", () => {
    expect(isWorldHeightMapOverlayName("living-world-effects")).toBe(true);
    expect(isWorldHeightMapOverlayName("director-water-pond_1")).toBe(true);
    expect(isWorldHeightMapOverlayName("director-object-hall")).toBe(false);
    const water = new Object3D();
    water.name = "director-living-world-water";
    expect(shouldHideObjectFromWorldHeightMap(water)).toBe(true);
  });
});

describe("world height refresh policy", () => {
  it("refreshes once per frame and again after quantized time or camera travel", () => {
    const first = {
      renderFrame: 4,
      worldSeconds: 1.0,
      cameraX: 0,
      cameraY: 8,
      cameraZ: 0,
    };
    expect(shouldRefreshWorldHeightMap(null, first)).toBe(true);
    const after = createWorldHeightMapRefreshMark(first, 5);
    expect(shouldRefreshWorldHeightMap(after, { ...first, renderFrame: 5 })).toBe(false);
    expect(shouldRefreshWorldHeightMap(after, { ...first, renderFrame: 6, worldSeconds: 1.3 })).toBe(true);
    expect(
      shouldRefreshWorldHeightMap(after, {
        ...first,
        renderFrame: 6,
        cameraX: WORLD_HEIGHT_MAP_CAMERA_DELTA_M + 0.1,
      }),
    ).toBe(true);
    expect(quantizeWorldHeightMapWorldSeconds(0.24)).toBe(0);
    expect(quantizeWorldHeightMapWorldSeconds(0.25)).toBe(1);
  });

  it("keeps independent cached captures for the editor and preview cameras", () => {
    const map = createWorldHeightMap();
    const renderer = createHeightMapRenderer();
    const scene = new Scene();
    const editorCamera = createHeightMapCamera(0, 8, 0);
    const previewCamera = createHeightMapCamera(100, 20, -80);

    renderer.beginFrame();
    map.handleBeforeRender(renderer as unknown as WebGLRenderer, scene, editorCamera, 0);
    const editorTexture = map.getTexture();
    expect(map.getOrigin(new Object3D().position).toArray()).toEqual([0, 8, 0]);

    renderer.beginFrame();
    map.handleBeforeRender(renderer as unknown as WebGLRenderer, scene, previewCamera, 0);
    const previewTexture = map.getTexture();
    expect(previewTexture).not.toBe(editorTexture);
    expect(map.getOrigin(new Object3D().position).toArray()).toEqual([100, 20, -80]);
    expect(renderer.renderCalls).toBe(2);

    renderer.beginFrame();
    map.handleBeforeRender(renderer as unknown as WebGLRenderer, scene, editorCamera, 0);
    expect(renderer.renderCalls).toBe(2);
    expect(map.getTexture()).toBe(editorTexture);

    renderer.beginFrame();
    map.handleBeforeRender(renderer as unknown as WebGLRenderer, scene, previewCamera, 0);
    expect(renderer.renderCalls).toBe(2);
    expect(map.getTexture()).toBe(previewTexture);
    map.dispose();
  });
});

describe("height-map shader injection", () => {
  it("pins ShaderLib.basic anchors and writes instanced world Y", () => {
    expect(ShaderLib.basic.vertexShader).toContain("#include <common>");
    expect(ShaderLib.basic.vertexShader).toContain("#include <project_vertex>");
    const injected = injectWorldHeightMapVertexShader(ShaderLib.basic.vertexShader);
    expect(injected).toContain("varying float vWorldY;");
    expect(injected).toContain("modelMatrix * instanceMatrix * vec4(transformed, 1.0)");
    expect(injectWorldHeightMapVertexShader("void main() {}")).toBe("void main() {}");
  });

  it("exports unpack helpers that match the CPU pack range", () => {
    expect(WORLD_HEIGHT_MAP_SAMPLE_GLSL).toContain("directorWorldHeightMapUv");
    expect(WORLD_HEIGHT_MAP_SAMPLE_GLSL).toContain(String(WORLD_HEIGHT_MAP_Y_MIN.toFixed(1)));
  });
});

describe("height-map uniform binding", () => {
  it("falls back to a dummy texture and zero blend when the map is empty", () => {
    const uniforms = createWorldHeightMapSampleUniforms();
    bindWorldHeightMapUniforms(uniforms, null);
    expect(uniforms.uOcclusionBlend.value).toBe(0);
    expect(uniforms.uOcclusionMap.value).not.toBeNull();
    expect(uniforms.uOcclusionSize.value).toBe(WORLD_HEIGHT_MAP_SIZE_M);
  });
});

describe("overlay skip does not hide ordinary scene meshes", () => {
  it("leaves ordinary scene meshes visible to the height pass", () => {
    const hall = new Mesh();
    hall.name = "大厅";
    const group = new Group();
    group.name = "director-object-hall";
    group.add(hall);
    expect(shouldHideObjectFromWorldHeightMap(hall)).toBe(false);
    expect(shouldHideObjectFromWorldHeightMap(group)).toBe(false);
    expect(new ShaderMaterial().type).toBe("ShaderMaterial");
  });
});
