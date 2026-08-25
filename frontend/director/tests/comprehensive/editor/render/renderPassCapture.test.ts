import { describe, expect, it, vi } from "vitest";
import {
  ACESFilmicToneMapping,
  BackSide,
  BatchedMesh,
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshNormalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Texture,
  WebGLRenderTarget,
  type ColorRepresentation,
  type Material,
  type WebGLRenderer,
} from "three";
import type { DirectorShotRenderPassId } from "../../../../src/comprehensive/editor/shot/shotPackage";
import { captureDirectorRenderPass, createDirectorObjectIdColorMap } from "../../../../src/comprehensive/editor/render/renderPassCapture";
import { DIRECTOR_SEMANTIC_PALETTE } from "../../../../src/comprehensive/editor/render/semanticPalette";

function expectStandardMaterial(material: unknown): MeshStandardMaterial {
  if (!(material instanceof MeshStandardMaterial)) {
    throw new Error("Expected the clay render pass to swap in a MeshStandardMaterial");
  }
  return material;
}

function createRendererHarness({
  onRead,
  onRender,
}: {
  onRead?: (buffer: Uint8Array) => void;
  onRender?: (scene: Scene) => void;
} = {}) {
  const originalTarget = new WebGLRenderTarget(3, 3);
  let renderTarget: WebGLRenderTarget | null = originalTarget;
  let activeCubeFace = 4;
  let activeMipmapLevel = 2;
  const clearColor = new Color(0x123456);
  let clearAlpha = 0.65;

  const renderer = {
    outputColorSpace: SRGBColorSpace,
    toneMapping: ACESFilmicToneMapping,
    toneMappingExposure: 1.7,
    autoClear: false,
    autoClearColor: false,
    autoClearDepth: false,
    autoClearStencil: false,
    getRenderTarget: vi.fn(() => renderTarget),
    getActiveCubeFace: vi.fn(() => activeCubeFace),
    getActiveMipmapLevel: vi.fn(() => activeMipmapLevel),
    setRenderTarget: vi.fn((next: WebGLRenderTarget | null, cubeFace = 0, mipmapLevel = 0) => {
      renderTarget = next;
      activeCubeFace = cubeFace;
      activeMipmapLevel = mipmapLevel;
    }),
    getClearColor: vi.fn((target: Color) => target.copy(clearColor)),
    getClearAlpha: vi.fn(() => clearAlpha),
    setClearColor: vi.fn((value: ColorRepresentation, alpha?: number) => {
      clearColor.set(value);
      if (alpha !== undefined) clearAlpha = alpha;
    }),
    clear: vi.fn(),
    render: vi.fn((scene: Scene) => onRender?.(scene)),
    readRenderTargetPixels: vi.fn(
      (_target: WebGLRenderTarget, _x: number, _y: number, _width: number, _height: number, buffer: Uint8Array) =>
        onRead?.(buffer),
    ),
  } as unknown as WebGLRenderer;

  return {
    renderer,
    originalTarget,
    state: () => ({
      renderTarget,
      activeCubeFace,
      activeMipmapLevel,
      clearColor: clearColor.getHex(),
      clearAlpha,
      outputColorSpace: renderer.outputColorSpace,
      toneMapping: renderer.toneMapping,
      toneMappingExposure: renderer.toneMappingExposure,
      autoClear: renderer.autoClear,
      autoClearColor: renderer.autoClearColor,
      autoClearDepth: renderer.autoClearDepth,
      autoClearStencil: renderer.autoClearStencil,
    }),
  };
}

function createSceneFixture() {
  const scene = new Scene();
  const originalOverride = new MeshBasicMaterial({ color: 0xff00ff });
  const originalBackground = new Color(0x223344);
  scene.overrideMaterial = originalOverride;
  scene.background = originalBackground;

  const owner = new Group();
  owner.userData.directorObjectId = "owner-a";
  const material = new MeshBasicMaterial({ color: 0xffaa00 });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  owner.add(mesh);
  scene.add(owner);

  const helper = new Group();
  helper.userData.hideFromViewportCapture = true;
  const helperMaterial = new MeshBasicMaterial({ color: 0xffffff });
  const helperMesh = new Mesh(new BoxGeometry(1, 1, 1), helperMaterial);
  helper.add(helperMesh);
  scene.add(helper);

  return {
    scene,
    originalOverride,
    originalBackground,
    owner,
    mesh,
    material,
    helper,
    helperMesh,
    helperMaterial,
  };
}

const camera = new PerspectiveCamera(50, 1, 0.1, 100);

function createBatchedBoxPair(material: Material) {
  const source = new BoxGeometry(1, 1, 1);
  const positionCount = source.getAttribute("position").count;
  const indexCount = source.getIndex()?.count ?? positionCount;
  const batch = new BatchedMesh(2, positionCount, indexCount, material);
  const geometryId = batch.addGeometry(source);
  const first = batch.addInstance(geometryId);
  const second = batch.addInstance(geometryId);
  batch.userData.directorInstanceObjectIds = ["box-a", "box-b"];
  batch.userData.directorObjectKind = "prop";
  batch.setColorAt(first, new Color(0xff0000));
  batch.setColorAt(second, new Color(0x00ff00));
  return { batch, first, second };
}

describe("captureDirectorRenderPass", () => {
  it("captures clean RGBA8 pixels, flips WebGL rows, hides helpers, and restores all state", () => {
    const fixture = createSceneFixture();
    const harness = createRendererHarness({
      onRead: (buffer) => {
        // WebGL starts with the bottom row.
        buffer.set([10, 11, 12, 13, 20, 21, 22, 23]);
      },
      onRender: (scene) => {
        expect(scene.overrideMaterial).toBeNull();
        expect(fixture.helper.visible).toBe(false);
        expect(fixture.mesh.material).toBe(fixture.material);
        expect(harness.state().renderTarget).not.toBe(harness.originalTarget);
      },
    });
    const rendererBefore = harness.state();

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "clean",
      width: 1,
      height: 2,
    });

    expect([...result.rgba]).toEqual([20, 21, 22, 23, 10, 11, 12, 13]);
    expect(result.metadata).toEqual({
      renderPass: "clean",
      width: 1,
      height: 2,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "srgb",
      encoding: "color",
      helpersExcluded: true,
    });
    expect(fixture.scene.overrideMaterial).toBe(fixture.originalOverride);
    expect(fixture.scene.background).toBe(fixture.originalBackground);
    expect(fixture.helper.visible).toBe(true);
    expect(fixture.mesh.material).toBe(fixture.material);
    expect(harness.state()).toEqual(rendererBefore);
  });

  it("renders a transparent clean pass without backdrop or environment dressing and returns straight alpha", () => {
    const fixture = createSceneFixture();
    const environmentMaterial = new MeshBasicMaterial({ color: 0x335577 });
    const environmentMesh = new Mesh(new BoxGeometry(2, 0.1, 2), environmentMaterial);
    fixture.scene.add(environmentMesh);
    const harness = createRendererHarness({
      onRead: (buffer) => {
        // Bottom row first (WebGL): a premultiplied half-covered red edge
        // pixel, then an opaque authored pixel above it.
        buffer.set([128, 0, 0, 128, 10, 200, 30, 255]);
      },
      onRender: (scene) => {
        expect(scene.background).toBeNull();
        expect(environmentMesh.visible).toBe(false);
        expect(fixture.helper.visible).toBe(false);
        expect(fixture.owner.visible).toBe(true);
        expect(fixture.mesh.visible).toBe(true);
        expect(harness.state().clearColor).toBe(0x000000);
        expect(harness.state().clearAlpha).toBe(0);
        expect((harness.state().renderTarget as WebGLRenderTarget).samples).toBe(4);
        expect(harness.renderer.outputColorSpace).toBe(SRGBColorSpace);
        expect(harness.renderer.toneMapping).toBe(ACESFilmicToneMapping);
      },
    });
    const rendererBefore = harness.state();

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "clean",
      width: 1,
      height: 2,
      background: "transparent",
    });

    // Rows flipped top-to-bottom, then un-premultiplied: the opaque authored
    // pixel is untouched while the coverage-128 edge recovers pure red.
    expect([...result.rgba]).toEqual([10, 200, 30, 255, 255, 0, 0, 128]);
    expect(result.metadata).toEqual({
      renderPass: "clean",
      width: 1,
      height: 2,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      rowOrder: "top-to-bottom",
      colorSpace: "srgb",
      encoding: "color",
      helpersExcluded: true,
      background: "transparent",
    });
    expect(fixture.scene.background).toBe(fixture.originalBackground);
    expect(environmentMesh.visible).toBe(true);
    expect(fixture.helper.visible).toBe(true);
    expect(harness.state()).toEqual(rendererBefore);
  });

  it("ignores the transparent background mode for technical data passes", () => {
    const fixture = createSceneFixture();
    const environmentMaterial = new MeshBasicMaterial({ color: 0x335577 });
    const environmentMesh = new Mesh(new BoxGeometry(2, 0.1, 2), environmentMaterial);
    fixture.scene.add(environmentMesh);
    const harness = createRendererHarness({
      onRender: () => {
        // Environment geometry stays part of technical data passes.
        expect(environmentMesh.visible).toBe(true);
        expect((harness.state().renderTarget as WebGLRenderTarget).samples).toBe(0);
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "mask",
      width: 2,
      height: 2,
      background: "transparent",
    });

    expect(result.metadata.background).toBeUndefined();
    expect(environmentMesh.visible).toBe(true);
  });

  it.each([
    ["depth", MeshDepthMaterial],
    ["normal", MeshNormalMaterial],
  ] as const)("uses an override material for the %s pass and restores allowOverride", (renderPass, MaterialType) => {
    const fixture = createSceneFixture();
    fixture.material.allowOverride = false;
    const harness = createRendererHarness({
      onRender: (scene) => {
        expect(scene.overrideMaterial).toBeInstanceOf(MaterialType);
        expect(scene.background).toBeNull();
        expect(fixture.material.allowOverride).toBe(true);
        expect(harness.renderer.outputColorSpace).toBe(LinearSRGBColorSpace);
        expect(harness.renderer.toneMapping).toBe(0);
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass,
      width: 2,
      height: 2,
    });

    expect(result.metadata).toMatchObject({
      renderPass,
      pixelFormat: "rgba8",
      bitsPerChannel: 8,
      encoding: renderPass === "depth" ? "rgba-depth-packed" : "view-normal-rgb",
    });
    expect(fixture.material.allowOverride).toBe(false);
    expect(fixture.scene.overrideMaterial).toBe(fixture.originalOverride);
  });

  it("assigns stable non-black object colors from the nearest owning ancestor and restores materials", () => {
    const fixture = createSceneFixture();
    const nestedOwner = new Group();
    nestedOwner.userData.directorObjectId = "owner-b";
    const nestedMaterial = new MeshBasicMaterial({ color: 0x00ff00 });
    const nestedMesh = new Mesh(new BoxGeometry(1, 1, 1), nestedMaterial);
    nestedOwner.add(nestedMesh);
    fixture.owner.add(nestedOwner);

    const unownedMaterial = new MeshBasicMaterial({ color: 0x0000ff });
    const unownedMesh = new Mesh(new BoxGeometry(1, 1, 1), unownedMaterial);
    fixture.scene.add(unownedMesh);

    const originalMaterialArray = [fixture.material, new MeshBasicMaterial({ color: 0x121212 })];
    (fixture.mesh as unknown as Mesh<BoxGeometry, Material | Material[]>).material = originalMaterialArray;
    const renderedRgb = new Map<string, [number, number, number]>();
    const harness = createRendererHarness({
      onRender: () => {
        expect(fixture.scene.overrideMaterial).toBeNull();
        expect(fixture.helper.visible).toBe(false);
        expect(fixture.helperMesh.material).toBe(fixture.helperMaterial);
        expect(unownedMesh.material).toBeInstanceOf(MeshBasicMaterial);
        expect((unownedMesh.material as MeshBasicMaterial).color.getHex()).toBe(0x000000);
        const ownerMaterials = fixture.mesh.material as unknown as MeshBasicMaterial[];
        expect(ownerMaterials).toHaveLength(2);
        renderedRgb.set(
          "owner-a",
          ownerMaterials[0]!.color.toArray().map((value) => Math.round(value * 255)) as [
            number,
            number,
            number,
          ],
        );
        renderedRgb.set(
          "owner-b",
          (nestedMesh.material as MeshBasicMaterial).color.toArray().map((value) => Math.round(value * 255)) as [
            number,
            number,
            number,
          ],
        );
      },
    });

    const first = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "object-id",
      width: 2,
      height: 2,
    });
    const second = captureDirectorRenderPass({
      renderer: createRendererHarness().renderer,
      scene: fixture.scene,
      camera,
      renderPass: "object-id",
      width: 2,
      height: 2,
    });

    expect(first.metadata.objectIdToRgb).toEqual({
      "owner-a": renderedRgb.get("owner-a"),
      "owner-b": renderedRgb.get("owner-b"),
    });
    expect(first.metadata.objectIdToRgb).toEqual(second.metadata.objectIdToRgb);
    expect(Object.values(first.metadata.objectIdToRgb!).every((rgb) => rgb.some((channel) => channel !== 0))).toBe(
      true,
    );
    expect(fixture.mesh.material).toBe(originalMaterialArray);
    expect(nestedMesh.material).toBe(nestedMaterial);
    expect(unownedMesh.material).toBe(unownedMaterial);
    expect(fixture.helperMesh.material).toBe(fixture.helperMaterial);
  });

  it("renders and restores one object-id color per static primitive instance", () => {
    const scene = new Scene();
    const originalMaterial = new MeshBasicMaterial({ color: 0x123456 });
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), originalMaterial, 2);
    instances.userData.directorInstanceObjectIds = ["box-a", "box-b"];
    instances.setMatrixAt(0, new Matrix4().makeTranslation(-1, 0, 0));
    instances.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, 0));
    scene.add(instances);
    const harness = createRendererHarness({
      onRender: () => {
        expect((instances.material as MeshBasicMaterial).vertexColors).toBe(true);
        expect(Array.from(instances.instanceColor!.array.slice(0, 3))).not.toEqual(
          Array.from(instances.instanceColor!.array.slice(3, 6)),
        );
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene,
      camera,
      renderPass: "object-id",
      width: 1,
      height: 1,
    });

    expect(Object.keys(result.metadata.objectIdToRgb ?? {}).sort()).toEqual(["box-a", "box-b"]);
    expect(instances.material).toBe(originalMaterial);
    expect(instances.instanceColor).toBeNull();
  });

  it("keeps object-id colors visibly distinct from the black background", () => {
    const color = createDirectorObjectIdColorMap(["gg-qad-rim"])["gg-qad-rim"]!;

    expect(color[0] + color[1] + color[2]).toBeGreaterThanOrEqual(192);
  });

  it("preserves authored alpha cutouts and face orientation in object-id silhouettes", () => {
    const scene = new Scene();
    const owner = new Group();
    owner.userData.directorObjectId = "foliage-a";
    const opacityTexture = new Texture();
    const authoredMaterial = new MeshStandardMaterial({
      alphaTest: 0.42,
      map: opacityTexture,
      side: BackSide,
    });
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), authoredMaterial);
    owner.add(mesh);
    scene.add(owner);
    const harness = createRendererHarness({
      onRender: () => {
        const segmentationMaterial = mesh.material as unknown as MeshBasicMaterial;
        expect(segmentationMaterial.alphaTest).toBe(0.42);
        expect(segmentationMaterial.map).toBe(opacityTexture);
        expect(segmentationMaterial.side).toBe(BackSide);
        const shader = { fragmentShader: "#include <map_fragment>", uniforms: {}, vertexShader: "" };
        segmentationMaterial.onBeforeCompile(shader as never, harness.renderer);
        expect(shader.fragmentShader).toContain("diffuseColor.a *= sampledDiffuseColor.a");
        expect(shader.fragmentShader).not.toContain("#include <map_fragment>");
      },
    });

    captureDirectorRenderPass({
      renderer: harness.renderer,
      scene,
      camera,
      renderPass: "object-id",
      width: 1,
      height: 1,
    });

    expect(mesh.material).toBe(authoredMaterial);
  });

  it("keeps GPU multi-draw batches correct across object, mask, clay, semantic, and PBR passes", () => {
    const scene = new Scene();
    const originalMaterial = new MeshStandardMaterial({ color: 0x336699, roughness: 0.72 });
    const { batch, first, second } = createBatchedBoxPair(originalMaterial);
    scene.add(batch);

    const capture = (renderPass: DirectorShotRenderPassId, onRender: () => void) =>
      captureDirectorRenderPass({
        renderer: createRendererHarness({ onRender }).renderer,
        scene,
        camera,
        renderPass,
        width: 1,
        height: 1,
      });
    const expectAuthoredColors = () => {
      expect(batch.getColorAt(first, new Color()).getHex()).toBe(0xff0000);
      expect(batch.getColorAt(second, new Color()).getHex()).toBe(0x00ff00);
    };
    const expectNeutralBatchColors = () => {
      expect(batch.getColorAt(first, new Color()).getHex()).toBe(0xffffff);
      expect(batch.getColorAt(second, new Color()).getHex()).toBe(0xffffff);
    };

    const objectId = capture("object-id", () => {
      expect((batch.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
      expect(batch.getColorAt(first, new Color()).getHex()).not.toBe(batch.getColorAt(second, new Color()).getHex());
    });
    expect(Object.keys(objectId.metadata.objectIdToRgb ?? {}).sort()).toEqual(["box-a", "box-b"]);
    expect(batch.material).toBe(originalMaterial);
    expectAuthoredColors();

    for (const renderPass of ["mask", "clay", "semantic", "roughness"] as const) {
      capture(renderPass, () => {
        expectNeutralBatchColors();
        if (renderPass === "semantic") {
          expect((batch.material as MeshBasicMaterial).color.toArray().map((value) => Math.round(value * 255))).toEqual(
            [...DIRECTOR_SEMANTIC_PALETTE.prop],
          );
        }
        if (renderPass === "roughness") {
          expect(batch.material.userData.directorGbufferPass).toBe("roughness");
        }
      });
      expect(batch.material).toBe(originalMaterial);
      expectAuthoredColors();
    }

    capture("albedo", expectAuthoredColors);
    expect(batch.material).toBe(originalMaterial);
    expectAuthoredColors();
  });

  it("renders a binary foreground mask from tagged scene objects and keeps unowned environment black", () => {
    const fixture = createSceneFixture();
    const environmentMaterial = new MeshBasicMaterial({ color: 0x335577 });
    const environmentMesh = new Mesh(new BoxGeometry(2, 0.1, 2), environmentMaterial);
    fixture.scene.add(environmentMesh);
    const harness = createRendererHarness({
      onRender: () => {
        expect((fixture.mesh.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
        expect((environmentMesh.material as MeshBasicMaterial).color.getHex()).toBe(0x000000);
        expect(harness.state().clearAlpha).toBe(1);
        expect(fixture.helper.visible).toBe(false);
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "mask",
      width: 2,
      height: 2,
    });

    expect(result.metadata).toMatchObject({
      renderPass: "mask",
      colorSpace: "data",
      encoding: "binary-mask-rgb",
      helpersExcluded: true,
    });
    expect(fixture.mesh.material).toBe(fixture.material);
    expect(environmentMesh.material).toBe(environmentMaterial);
  });

  it("renders cool environment clay, warm character clay, and removes authored static-instance colors", () => {
    const fixture = createSceneFixture();
    const characterOwner = new Group();
    characterOwner.userData.directorObjectId = "character-a";
    characterOwner.userData.directorObjectKind = "character";
    const characterMaterial = new MeshBasicMaterial({ color: 0xff00ff });
    const characterMesh = new Mesh(new BoxGeometry(1, 1, 1), characterMaterial);
    characterOwner.add(characterMesh);
    fixture.scene.add(characterOwner);
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xffffff }), 2);
    instances.userData.directorInstanceObjectIds = ["red-box", "green-box"];
    instances.setColorAt(0, new Color(0xff0000));
    instances.setColorAt(1, new Color(0x00ff00));
    const originalInstanceColor = instances.instanceColor;
    const originalInstanceMaterial = instances.material;
    fixture.scene.add(instances);
    const harness = createRendererHarness({
      onRender: () => {
        expect(fixture.mesh.material).toBe(instances.material);
        expect(expectStandardMaterial(fixture.mesh.material).color.getHex()).toBe(0xd8dce2);
        expect(expectStandardMaterial(characterMesh.material).color.getHex()).toBe(0xd19a3a);
        expect(characterMesh.material).not.toBe(fixture.mesh.material);
        expect(instances.instanceColor).toBeNull();
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "clay",
      width: 2,
      height: 2,
    });

    expect(result.metadata).toMatchObject({ renderPass: "clay", colorSpace: "srgb", encoding: "color" });
    expect(fixture.mesh.material).toBe(fixture.material);
    expect(characterMesh.material).toBe(characterMaterial);
    expect(instances.material).toBe(originalInstanceMaterial);
    expect(instances.instanceColor).toBe(originalInstanceColor);
  });

  it.each([
    ["albedo", "base-color-rgb", "srgb"],
    ["roughness", "roughness-grayscale", "data"],
    ["metalness", "metalness-grayscale", "data"],
    ["emissive", "emissive-rgb", "srgb"],
    ["ao", "ambient-occlusion-grayscale", "data"],
    ["shadow", "shadow-matte-grayscale", "data"],
  ] as const)("renders and restores the %s PBR G-buffer pass", (renderPass, encoding, colorSpace) => {
    const scene = new Scene();
    const source = new MeshStandardMaterial({
      color: 0x336699,
      emissive: 0x402010,
      emissiveIntensity: 0.5,
      metalness: 0.35,
      roughness: 0.72,
    });
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), source, 2);
    instances.setColorAt(0, new Color(0xff0000));
    instances.setColorAt(1, new Color(0x00ff00));
    const originalInstanceColor = instances.instanceColor;
    scene.add(instances);
    const harness = createRendererHarness({
      onRender: () => {
        const material = instances.material as Material;
        expect(material.userData.directorGbufferPass).toBe(renderPass);
        expect(material).toBeInstanceOf(renderPass === "shadow" ? ShadowMaterial : MeshBasicMaterial);
        expect(instances.instanceColor).toBe(renderPass === "albedo" ? originalInstanceColor : null);
        if (renderPass === "shadow") {
          expect(harness.state().clearColor).toBe(0xffffff);
          expect(harness.state().clearAlpha).toBe(1);
        }
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene,
      camera,
      renderPass,
      width: 2,
      height: 2,
    });

    expect(result.metadata).toMatchObject({ renderPass, encoding, colorSpace, helpersExcluded: true });
    expect(instances.material).toBe(source);
    expect(instances.instanceColor).toBe(originalInstanceColor);
  });

  it("binds the authored PBR texture to the matching G-buffer channel", () => {
    const maps = {
      albedo: new Texture(),
      roughness: new Texture(),
      metalness: new Texture(),
      emissive: new Texture(),
      ao: new Texture(),
    };
    const scene = new Scene();
    const source = new MeshStandardMaterial({
      map: maps.albedo,
      roughnessMap: maps.roughness,
      metalnessMap: maps.metalness,
      emissiveMap: maps.emissive,
      aoMap: maps.ao,
    });
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), source);
    scene.add(mesh);

    for (const renderPass of ["albedo", "roughness", "metalness", "emissive", "ao"] as const) {
      const harness = createRendererHarness({
        onRender: () => {
          expect(mesh.material).toBeInstanceOf(MeshBasicMaterial);
          if (!(mesh.material instanceof MeshBasicMaterial)) {
            throw new Error("Expected a temporary MeshBasicMaterial G-buffer override.");
          }
          const material = mesh.material;
          expect(material.map).toBe(maps[renderPass]);
          expect(material.userData.directorGbufferPass).toBe(renderPass);
        },
      });
      captureDirectorRenderPass({ renderer: harness.renderer, scene, camera, renderPass, width: 2, height: 2 });
      expect(mesh.material).toBe(source);
    }
  });

  it("removes authored static-instance colors from the binary mask", () => {
    const scene = new Scene();
    const originalMaterial = new MeshBasicMaterial({ color: 0xffffff });
    const instances = new InstancedMesh(new BoxGeometry(1, 1, 1), originalMaterial, 2);
    instances.userData.directorInstanceObjectIds = ["red-box", "green-box"];
    instances.setColorAt(0, new Color(0xff0000));
    instances.setColorAt(1, new Color(0x00ff00));
    const originalInstanceColor = instances.instanceColor;
    scene.add(instances);
    const harness = createRendererHarness({
      onRender: () => {
        expect((instances.material as MeshBasicMaterial).color.getHex()).toBe(0xffffff);
        expect(instances.instanceColor).toBeNull();
      },
    });

    captureDirectorRenderPass({ renderer: harness.renderer, scene, camera, renderPass: "mask", width: 2, height: 2 });

    expect(instances.material).toBe(originalMaterial);
    expect(instances.instanceColor).toBe(originalInstanceColor);
  });

  it("renders semantic category colors for characters, props, and untagged environment geometry", () => {
    const fixture = createSceneFixture();
    fixture.owner.userData.directorObjectKind = "character";

    const propOwner = new Group();
    propOwner.userData.directorObjectId = "prop-1";
    propOwner.userData.directorObjectKind = "prop";
    const propMaterial = new MeshBasicMaterial({ color: 0x00ff00 });
    const propMesh = new Mesh(new BoxGeometry(1, 1, 1), propMaterial);
    propOwner.add(propMesh);
    fixture.scene.add(propOwner);

    const environmentMaterial = new MeshBasicMaterial({ color: 0x335577 });
    const environmentMesh = new Mesh(new BoxGeometry(2, 0.1, 2), environmentMaterial);
    fixture.scene.add(environmentMesh);

    const renderedBytes = (mesh: Mesh) =>
      (mesh.material as MeshBasicMaterial).color.toArray().map((value) => Math.round(value * 255));
    const harness = createRendererHarness({
      onRender: () => {
        expect(renderedBytes(fixture.mesh)).toEqual([...DIRECTOR_SEMANTIC_PALETTE.character]);
        expect(renderedBytes(propMesh)).toEqual([...DIRECTOR_SEMANTIC_PALETTE.prop]);
        expect(renderedBytes(environmentMesh)).toEqual([...DIRECTOR_SEMANTIC_PALETTE.environment]);
        expect(fixture.helper.visible).toBe(false);
        expect(fixture.helperMesh.material).toBe(fixture.helperMaterial);
      },
    });

    const result = captureDirectorRenderPass({
      renderer: harness.renderer,
      scene: fixture.scene,
      camera,
      renderPass: "semantic",
      width: 2,
      height: 2,
    });

    expect(result.metadata).toMatchObject({
      renderPass: "semantic",
      colorSpace: "data",
      encoding: "semantic-category-rgb",
      helpersExcluded: true,
    });
    expect(result.metadata.categoryToRgb).toEqual({
      character: [150, 5, 61],
      prop: [0, 102, 200],
      environment: [4, 200, 3],
      background: [0, 0, 0],
    });
    expect(result.metadata.objectIdToRgb).toBeUndefined();
    expect(fixture.mesh.material).toBe(fixture.material);
    expect(propMesh.material).toBe(propMaterial);
    expect(environmentMesh.material).toBe(environmentMaterial);
  });

  it("restores scene, object, helper, target, clear, output, and tone state when rendering throws", () => {
    const fixture = createSceneFixture();
    const rendererDispose = vi.spyOn(WebGLRenderTarget.prototype, "dispose");
    const originalMaterial = fixture.mesh.material;
    const harness = createRendererHarness({
      onRender: () => {
        throw new Error("GPU render failed");
      },
    });
    const rendererBefore = harness.state();

    expect(() =>
      captureDirectorRenderPass({
        renderer: harness.renderer,
        scene: fixture.scene,
        camera,
        renderPass: "object-id",
        width: 2,
        height: 2,
      }),
    ).toThrow("GPU render failed");

    expect(fixture.scene.overrideMaterial).toBe(fixture.originalOverride);
    expect(fixture.scene.background).toBe(fixture.originalBackground);
    expect(fixture.mesh.material).toBe(originalMaterial);
    expect(fixture.helper.visible).toBe(true);
    expect(harness.state()).toEqual(rendererBefore);
    expect(rendererDispose).toHaveBeenCalledTimes(1);
    rendererDispose.mockRestore();
  });

  it("validates raster dimensions before touching the renderer", () => {
    const fixture = createSceneFixture();
    const renderer = {} as WebGLRenderer;
    expect(() =>
      captureDirectorRenderPass({ renderer, scene: fixture.scene, camera, renderPass: "clean", width: 0, height: 2 }),
    ).toThrow("Render width must be an integer between 1 and 16384");
    expect(() =>
      captureDirectorRenderPass({ renderer, scene: fixture.scene, camera, renderPass: "clean", width: 2, height: 1.5 }),
    ).toThrow("Render height must be an integer between 1 and 16384");
  });
});

describe("createDirectorObjectIdColorMap", () => {
  it("is insertion-order independent and collision-safe within a capture", () => {
    const forward = createDirectorObjectIdColorMap(["hero", "prop", "camera"]);
    const reversed = createDirectorObjectIdColorMap(["camera", "prop", "hero"]);
    expect(reversed).toEqual(forward);
    expect(new Set(Object.values(forward).map((rgb) => rgb.join(","))).size).toBe(3);
    expect(Object.values(forward)).not.toContainEqual([0, 0, 0]);
  });
});
