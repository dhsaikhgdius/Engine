/**
 * Split static/dynamic shadow mapping for the Stage: static scenery renders
 * its shadow map once (re-rendered only when the scene revision changes)
 * while dynamic objects get a small per-frame map, and a patched three.js
 * lights_fragment_begin chunk composites both directional maps in the
 * shader. This keeps large authored scenes from paying a full shadow pass
 * every frame. The patch is keyed so material programs cache correctly, and
 * all renderer state is restored after each bake.
 */
import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import {
  Material,
  MeshBasicMaterial,
  ShaderChunk,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from "three";
import { claimDirectorPrimaryCompositeRenderPass } from "./renderBudget";

export const DIRECTOR_STATIC_SHADOW_LAYER = 28;
export const DIRECTOR_DYNAMIC_SHADOW_LAYER = 29;

const DIRECTIONAL_SHADOW_LINE =
  "\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;";
const LAYERED_DIRECTIONAL_SHADOW_LINE = `${DIRECTIONAL_SHADOW_LINE}
		#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;
		#endif`;
const LAYERED_LIGHTS_FRAGMENT_BEGIN = ShaderChunk.lights_fragment_begin.replace(
  DIRECTIONAL_SHADOW_LINE,
  LAYERED_DIRECTIONAL_SHADOW_LINE,
);
const LAYERED_SHADOW_PROGRAM_KEY = "director-layered-directional-shadow-v1";

type ShadowState = {
  autoUpdate: boolean;
  needsUpdate: boolean;
};

type ShadowCarrier = Object3D & {
  castShadow?: boolean;
  isLight?: boolean;
  shadow?: ShadowState;
};

type RenderableObject = Object3D & {
  castShadow?: boolean;
  isLine?: boolean;
  isMesh?: boolean;
  isPoints?: boolean;
  material?: Material | Material[];
};

type ReceiverMaterial = Material & {
  isMeshLambertMaterial?: boolean;
  isMeshPhongMaterial?: boolean;
  isMeshStandardMaterial?: boolean;
  isMeshToonMaterial?: boolean;
};

type MaterialPatch = {
  customProgramCacheKey: Material["customProgramCacheKey"];
  material: Material;
  onBeforeCompile: Material["onBeforeCompile"];
};

type SceneBeforeRender = (
  renderer: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  renderTarget: WebGLRenderTarget | null,
) => void;

function isLayeredShadowReceiver(material: Material): material is ReceiverMaterial {
  const receiver = material as ReceiverMaterial;
  return Boolean(
    receiver.isMeshLambertMaterial ||
    receiver.isMeshPhongMaterial ||
    receiver.isMeshStandardMaterial ||
    receiver.isMeshToonMaterial,
  );
}

function isRenderableObject(object: Object3D): object is RenderableObject {
  const renderable = object as RenderableObject;
  return Boolean(renderable.isMesh || renderable.isLine || renderable.isPoints);
}

function isDynamicShadowCaster(object: Object3D, dynamicObjectIds: ReadonlySet<string>) {
  let current: Object3D | null = object;
  while (current) {
    if (current.userData.directorDynamicShadowCaster === true) return true;
    if (current.userData.directorObjectKind === "character") return true;
    if (dynamicObjectIds.has(current.userData.directorObjectId as string)) return true;
    if (current.name.startsWith("living-world-wildlife") || current.name.startsWith("living-world-traffic")) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function patchReceiverMaterial(material: Material, patches: Map<Material, MaterialPatch>) {
  if (!isLayeredShadowReceiver(material) || patches.has(material)) return;

  const originalOnBeforeCompile = material.onBeforeCompile;
  const originalProgramCacheKey = material.customProgramCacheKey;
  patches.set(material, {
    customProgramCacheKey: originalProgramCacheKey,
    material,
    onBeforeCompile: originalOnBeforeCompile,
  });
  material.onBeforeCompile = (parameters, renderer) => {
    originalOnBeforeCompile.call(material, parameters, renderer);
    parameters.fragmentShader = parameters.fragmentShader.replace(
      "#include <lights_fragment_begin>",
      LAYERED_LIGHTS_FRAGMENT_BEGIN,
    );
  };
  material.customProgramCacheKey = () => `${originalProgramCacheKey.call(material)}:${LAYERED_SHADOW_PROGRAM_KEY}`;
  material.needsUpdate = true;
}

function restoreReceiverMaterials(patches: Map<Material, MaterialPatch>) {
  for (const patch of patches.values()) {
    patch.material.onBeforeCompile = patch.onBeforeCompile;
    patch.material.customProgramCacheKey = patch.customProgramCacheKey;
    patch.material.needsUpdate = true;
  }
  patches.clear();
}

function getMaterials(object: RenderableObject) {
  if (!object.material) return [];
  return Array.isArray(object.material) ? object.material : [object.material];
}

/**
 * Renders static casters into persistent native light maps and moving actors
 * into one independent directional map. The PBR receiver shader multiplies
 * both visibility terms, so the main scene keeps full-resolution shadows
 * without submitting the static environment to the shadow pass every frame.
 */
export function DirectorShadowMapController({
  continuous,
  dynamicObjectIds,
  dynamicRevisionToken,
  enabled,
  staticRevisionToken,
}: {
  continuous: boolean;
  dynamicObjectIds: ReadonlySet<string>;
  dynamicRevisionToken: unknown;
  enabled: boolean;
  staticRevisionToken: unknown;
}) {
  const { gl, invalidate, scene } = useThree();
  const continuousRef = useRef(continuous);
  const dynamicObjectIdsRef = useRef(dynamicObjectIds);
  const staticDirtyRef = useRef(true);
  const dynamicDirtyRef = useRef(true);
  const graphDirtyRef = useRef(true);

  continuousRef.current = continuous;
  dynamicObjectIdsRef.current = dynamicObjectIds;

  useLayoutEffect(() => {
    staticDirtyRef.current = true;
    graphDirtyRef.current = true;
    invalidate();
  }, [invalidate, staticRevisionToken]);

  useLayoutEffect(() => {
    dynamicDirtyRef.current = true;
    graphDirtyRef.current = true;
    invalidate();
  }, [dynamicObjectIds, dynamicRevisionToken, invalidate]);

  useLayoutEffect(() => {
    if (!enabled) {
      gl.shadowMap.autoUpdate = true;
      gl.shadowMap.needsUpdate = true;
      return;
    }

    const prepassTarget = new WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
    const prepassMaterial = new MeshBasicMaterial({ colorWrite: false, depthTest: false, depthWrite: false });
    const previousViewport = new Vector4();
    const previousScissor = new Vector4();
    const layerObjects = new Set<Object3D>();
    const materialPatches = new Map<Material, MaterialPatch>();
    const shadowStates = new Map<ShadowCarrier, ShadowState>();
    const observed = new Set<Object3D>();
    let staticShadows: ShadowState[] = [];
    let dynamicShadows: ShadowState[] = [];
    let hasLayeredDirectionalLight = false;
    let renderingPrepass = false;

    gl.shadowMap.autoUpdate = false;

    const restoreShadowState = (light: ShadowCarrier) => {
      const saved = shadowStates.get(light);
      if (!saved || !light.shadow) return;
      light.shadow.autoUpdate = saved.autoUpdate;
      light.shadow.needsUpdate = saved.needsUpdate;
      shadowStates.delete(light);
    };

    const syncScene = () => {
      for (const object of layerObjects) {
        object.layers.disable(DIRECTOR_STATIC_SHADOW_LAYER);
        object.layers.disable(DIRECTOR_DYNAMIC_SHADOW_LAYER);
      }
      layerObjects.clear();

      const currentShadowLights = new Set<ShadowCarrier>();
      staticShadows = [];
      dynamicShadows = [];
      hasLayeredDirectionalLight = false;

      scene.traverse((object) => {
        const light = object as ShadowCarrier;
        if (!light.isLight || !light.castShadow || !light.shadow) return;
        currentShadowLights.add(light);
        if (!shadowStates.has(light)) {
          shadowStates.set(light, {
            autoUpdate: light.shadow.autoUpdate,
            needsUpdate: light.shadow.needsUpdate,
          });
        }
        light.shadow.autoUpdate = false;
        const dynamicLight = light.userData.directorDynamicShadowLight === true;
        const layer = dynamicLight ? DIRECTOR_DYNAMIC_SHADOW_LAYER : DIRECTOR_STATIC_SHADOW_LAYER;
        light.layers.enable(layer);
        layerObjects.add(light);
        if (dynamicLight) {
          dynamicShadows.push(light.shadow);
          hasLayeredDirectionalLight = true;
        } else {
          staticShadows.push(light.shadow);
        }
      });

      for (const light of [...shadowStates.keys()]) {
        if (!currentShadowLights.has(light)) restoreShadowState(light);
      }

      if (!hasLayeredDirectionalLight) restoreReceiverMaterials(materialPatches);
      scene.traverse((object) => {
        if (!isRenderableObject(object)) return;
        if (hasLayeredDirectionalLight) {
          for (const material of getMaterials(object)) patchReceiverMaterial(material, materialPatches);
        }
        if (!object.castShadow) return;
        const layer = isDynamicShadowCaster(object, dynamicObjectIdsRef.current)
          ? DIRECTOR_DYNAMIC_SHADOW_LAYER
          : DIRECTOR_STATIC_SHADOW_LAYER;
        object.layers.enable(layer);
        layerObjects.add(object);
      });
      graphDirtyRef.current = false;
    };

    const runShadowLayerPass = (camera: Camera, layer: number, targetShadows: ShadowState[]) => {
      if (!targetShadows.length) return;
      for (const shadow of [...staticShadows, ...dynamicShadows]) shadow.needsUpdate = false;
      for (const shadow of targetShadows) shadow.needsUpdate = true;

      const previousTarget = gl.getRenderTarget();
      const previousCubeFace = gl.getActiveCubeFace();
      const previousMipmapLevel = gl.getActiveMipmapLevel();
      const previousAutoClear = gl.autoClear;
      const previousScissorTest = gl.getScissorTest();
      const previousOverrideMaterial = scene.overrideMaterial;
      const previousCameraLayers = camera.layers.mask;
      gl.getViewport(previousViewport);
      gl.getScissor(previousScissor);

      gl.shadowMap.needsUpdate = true;
      camera.layers.set(layer);
      scene.overrideMaterial = prepassMaterial;
      gl.autoClear = true;
      gl.setRenderTarget(prepassTarget);
      gl.setScissorTest(false);
      try {
        gl.render(scene, camera);
      } finally {
        camera.layers.mask = previousCameraLayers;
        scene.overrideMaterial = previousOverrideMaterial;
        gl.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
        gl.setViewport(previousViewport);
        gl.setScissor(previousScissor);
        gl.setScissorTest(previousScissorTest);
        gl.autoClear = previousAutoClear;
      }
    };

    const previousSceneBeforeRender = scene.onBeforeRender;
    const previousSceneCallback = previousSceneBeforeRender as unknown as SceneBeforeRender;
    const handleSceneBeforeRender: SceneBeforeRender = (renderer, renderedScene, camera, renderTarget) => {
      previousSceneCallback.call(scene, renderer, renderedScene, camera, renderTarget);
      if (renderingPrepass || !claimDirectorPrimaryCompositeRenderPass(renderer.info)) return;
      if (graphDirtyRef.current) syncScene();

      renderingPrepass = true;
      try {
        if (staticDirtyRef.current) {
          runShadowLayerPass(camera, DIRECTOR_STATIC_SHADOW_LAYER, staticShadows);
          staticDirtyRef.current = false;
        }
        if (dynamicDirtyRef.current || continuousRef.current) {
          runShadowLayerPass(camera, DIRECTOR_DYNAMIC_SHADOW_LAYER, dynamicShadows);
          dynamicDirtyRef.current = false;
        }
      } finally {
        renderingPrepass = false;
      }
    };
    const sceneBeforeRenderHook = handleSceneBeforeRender as unknown as Scene["onBeforeRender"];
    scene.onBeforeRender = sceneBeforeRenderHook;

    const markGraphDirty = () => {
      graphDirtyRef.current = true;
      staticDirtyRef.current = true;
      dynamicDirtyRef.current = true;
      invalidate();
    };
    const observeSubtree = (root: Object3D) => {
      root.traverse((object) => {
        if (observed.has(object)) return;
        observed.add(object);
        object.addEventListener("childadded", onChildAdded);
        object.addEventListener("childremoved", onChildRemoved);
      });
    };
    const unobserveSubtree = (root: Object3D) => {
      root.traverse((object) => {
        observed.delete(object);
        object.removeEventListener("childadded", onChildAdded);
        object.removeEventListener("childremoved", onChildRemoved);
      });
    };
    function onChildAdded(event: { child: Object3D }) {
      observeSubtree(event.child);
      markGraphDirty();
    }
    function onChildRemoved(event: { child: Object3D }) {
      unobserveSubtree(event.child);
      markGraphDirty();
    }

    observeSubtree(scene);
    syncScene();
    invalidate();

    return () => {
      if (scene.onBeforeRender === sceneBeforeRenderHook) scene.onBeforeRender = previousSceneBeforeRender;
      for (const object of observed) {
        object.removeEventListener("childadded", onChildAdded);
        object.removeEventListener("childremoved", onChildRemoved);
      }
      for (const object of layerObjects) {
        object.layers.disable(DIRECTOR_STATIC_SHADOW_LAYER);
        object.layers.disable(DIRECTOR_DYNAMIC_SHADOW_LAYER);
      }
      for (const light of [...shadowStates.keys()]) restoreShadowState(light);
      restoreReceiverMaterials(materialPatches);
      prepassMaterial.dispose();
      prepassTarget.dispose();
      gl.shadowMap.autoUpdate = true;
      gl.shadowMap.needsUpdate = true;
    };
  }, [enabled, gl, invalidate, scene]);

  return null;
}
