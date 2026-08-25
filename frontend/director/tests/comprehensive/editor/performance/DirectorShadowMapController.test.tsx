import { act, render } from "@testing-library/react";
import { BoxGeometry, DirectionalLight, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTOR_DYNAMIC_SHADOW_LAYER,
  DIRECTOR_STATIC_SHADOW_LAYER,
  DirectorShadowMapController,
} from "../../../../src/comprehensive/editor/performance/DirectorShadowMapController";

const mockUseThree = vi.hoisted(() => vi.fn());

vi.mock("@react-three/fiber", async () => {
  const actual = await vi.importActual<typeof import("@react-three/fiber")>("@react-three/fiber");
  return { ...actual, useThree: mockUseThree };
});

describe("DirectorShadowMapController", () => {
  const invalidate = vi.fn();
  let camera: PerspectiveCamera;
  let dynamicLight: DirectionalLight;
  let dynamicMaterial: MeshStandardMaterial;
  let gl: ReturnType<typeof createRendererMock>;
  let scene: Scene;
  let staticLight: DirectionalLight;
  let staticMaterial: MeshStandardMaterial;

  function createRendererMock() {
    const renderedLayers: number[] = [];
    return {
      autoClear: false,
      info: { render: { frame: 0 } },
      renderedLayers,
      shadowMap: { autoUpdate: true, needsUpdate: false },
      getActiveCubeFace: vi.fn(() => 0),
      getActiveMipmapLevel: vi.fn(() => 0),
      getRenderTarget: vi.fn(() => null),
      getScissor: vi.fn((target) => target.set(0, 0, 800, 600)),
      getScissorTest: vi.fn(() => false),
      getViewport: vi.fn((target) => target.set(0, 0, 800, 600)),
      render: vi.fn((_scene, renderCamera) => {
        renderedLayers.push(renderCamera.layers.mask);
      }),
      setRenderTarget: vi.fn(),
      setScissor: vi.fn(),
      setScissorTest: vi.fn(),
      setViewport: vi.fn(),
    };
  }

  function renderController(input?: {
    continuous?: boolean;
    dynamicRevisionToken?: unknown;
    staticRevisionToken?: unknown;
  }) {
    return render(
      <DirectorShadowMapController
        continuous={input?.continuous ?? false}
        dynamicObjectIds={new Set(["animated-prop"])}
        dynamicRevisionToken={input?.dynamicRevisionToken ?? "dynamic-1"}
        enabled
        staticRevisionToken={input?.staticRevisionToken ?? "static-1"}
      />,
    );
  }

  function renderSceneFrame() {
    const beforeRender = scene.onBeforeRender as unknown as (
      renderer: never,
      renderedScene: Scene,
      renderCamera: PerspectiveCamera,
      renderTarget: null,
    ) => void;
    beforeRender(gl as never, scene, camera, null);
  }

  beforeEach(() => {
    scene = new Scene();
    camera = new PerspectiveCamera();
    staticLight = new DirectionalLight();
    staticLight.castShadow = true;
    dynamicLight = new DirectionalLight();
    dynamicLight.castShadow = true;
    dynamicLight.userData.directorDynamicShadowLight = true;

    staticMaterial = new MeshStandardMaterial();
    const staticMesh = new Mesh(new BoxGeometry(), staticMaterial);
    staticMesh.castShadow = true;
    const character = new Group();
    character.userData = { directorObjectId: "character", directorObjectKind: "character" };
    dynamicMaterial = new MeshStandardMaterial();
    const dynamicMesh = new Mesh(new BoxGeometry(), dynamicMaterial);
    dynamicMesh.castShadow = true;
    character.add(dynamicMesh);
    scene.add(staticLight, dynamicLight, staticMesh, character);

    invalidate.mockReset();
    gl = createRendererMock();
    mockUseThree.mockReturnValue({ gl, invalidate, scene });
  });

  it("caches static casters and renders the dynamic character layer independently", () => {
    const view = renderController();

    expect(gl.shadowMap.autoUpdate).toBe(false);
    expect(staticLight.layers.isEnabled(DIRECTOR_STATIC_SHADOW_LAYER)).toBe(true);
    expect(dynamicLight.layers.isEnabled(DIRECTOR_DYNAMIC_SHADOW_LAYER)).toBe(true);

    act(renderSceneFrame);
    expect(gl.renderedLayers).toEqual([1 << DIRECTOR_STATIC_SHADOW_LAYER, 1 << DIRECTOR_DYNAMIC_SHADOW_LAYER]);

    const shader = { fragmentShader: "#include <lights_fragment_begin>", vertexShader: "", uniforms: {} };
    dynamicMaterial.onBeforeCompile(shader as never, gl as never);
    expect(shader.fragmentShader).toContain("directionalShadowMap[ 1 ]");
    expect(shader.fragmentShader).toContain("vDirectionalShadowCoord[ 1 ]");

    gl.renderedLayers.length = 0;
    act(renderSceneFrame);
    expect(gl.renderedLayers).toEqual([]);

    view.rerender(
      <DirectorShadowMapController
        continuous={false}
        dynamicObjectIds={new Set(["animated-prop"])}
        dynamicRevisionToken="dynamic-2"
        enabled
        staticRevisionToken="static-1"
      />,
    );
    act(renderSceneFrame);
    expect(gl.renderedLayers).toEqual([1 << DIRECTOR_DYNAMIC_SHADOW_LAYER]);

    gl.renderedLayers.length = 0;
    view.rerender(
      <DirectorShadowMapController
        continuous
        dynamicObjectIds={new Set(["animated-prop"])}
        dynamicRevisionToken="dynamic-2"
        enabled
        staticRevisionToken="static-1"
      />,
    );
    act(renderSceneFrame);
    act(renderSceneFrame);
    expect(gl.renderedLayers).toEqual([1 << DIRECTOR_DYNAMIC_SHADOW_LAYER, 1 << DIRECTOR_DYNAMIC_SHADOW_LAYER]);

    view.unmount();
    expect(gl.shadowMap).toEqual({ autoUpdate: true, needsUpdate: true });
    expect(staticLight.shadow.autoUpdate).toBe(true);
    expect(dynamicLight.shadow.autoUpdate).toBe(true);
  });

  it("invalidates both caches after scene graph changes", () => {
    const view = renderController();
    act(renderSceneFrame);
    gl.renderedLayers.length = 0;

    act(() => {
      scene.add(new Group());
    });
    act(renderSceneFrame);
    expect(gl.renderedLayers).toEqual([1 << DIRECTOR_STATIC_SHADOW_LAYER, 1 << DIRECTOR_DYNAMIC_SHADOW_LAYER]);

    view.unmount();
  });
});
