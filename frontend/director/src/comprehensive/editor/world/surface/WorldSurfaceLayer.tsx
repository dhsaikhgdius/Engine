import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { MeshBasicMaterial, PlaneGeometry, type Camera, type Material, type Mesh, type WebGLRenderer } from "three";
import type { DirectorObject } from "../../schema/directorProject";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { acquireWorldHeightMap, releaseWorldHeightMap, type WorldHeightMap } from "./worldHeightMap";
import {
  createWorldSurfaceUniforms,
  restorePatchedWorldSurfaceMaterials,
  syncWorldSurfaceMaterials,
  writeWorldSurfaceUniforms,
} from "./worldMaterialPatch";
import { collectWorldVegetationObjectIds } from "./worldSurfaceResponse";
import WorldAmbientAudio from "./worldAmbientAudio";

/**
 * Living-world surface response: wetness/snow/vegetation sway on scene
 * materials, a camera-centred height map for rain occlusion + shoreline
 * foam, and a seeded ambient bed. Lazy-loaded with the other world layers.
 *
 * Uniforms are written during layout AND in onBeforeRender so offscreen
 * capture (which skips useFrame) still sees the current weather.
 */

const disableRaycast: Mesh["raycast"] = () => undefined;
const MATERIAL_DISCOVERY_INTERVAL_MS = 500;

export default function WorldSurfaceLayer({
  captureHeightMap,
  context,
  evaluatedObjects,
}: {
  captureHeightMap: boolean;
  context: LivingWorldFrameContext;
  evaluatedObjects: DirectorObject[];
}) {
  const invalidate = useThree((state) => state.invalidate);
  const scene = useThree((state) => state.scene);
  const uniforms = useMemo(() => createWorldSurfaceUniforms(), []);
  const vegetationIds = useMemo(() => collectWorldVegetationObjectIds(evaluatedObjects), [evaluatedObjects]);
  const patchedRef = useRef(new Set<Material>());
  const patched = patchedRef.current;
  const lastMaterialSyncAtMsRef = useRef(Number.NEGATIVE_INFINITY);
  const heightMapRef = useRef<WorldHeightMap | null>(null);
  const meshRef = useRef<Mesh>(null);

  const geometry = useMemo(() => new PlaneGeometry(0.01, 0.01), []);
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        colorWrite: false,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        transparent: true,
        opacity: 0,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useEffect(() => {
    if (!captureHeightMap) return undefined;
    heightMapRef.current = acquireWorldHeightMap();
    return () => {
      heightMapRef.current = null;
      releaseWorldHeightMap();
    };
  }, [captureHeightMap]);

  useEffect(
    () => () => {
      restorePatchedWorldSurfaceMaterials(patched);
      patched.clear();
    },
    [patched],
  );

  const syncUniformsFromContext = useCallback(
    (renderer?: WebGLRenderer, camera?: Camera) => {
      writeWorldSurfaceUniforms(
        uniforms,
        context.settings.weather,
        context.windVector[0],
        context.windVector[2],
        context.worldSeconds,
      );
      if (renderer && camera) {
        heightMapRef.current?.handleBeforeRender(renderer, scene, camera, context.worldSeconds);
      }
    },
    [context, scene, uniforms],
  );

  const syncMaterialPatches = useCallback(
    (force = false) => {
      const now = performance.now();
      if (!force && now - lastMaterialSyncAtMsRef.current < MATERIAL_DISCOVERY_INTERVAL_MS) return;
      lastMaterialSyncAtMsRef.current = now;
      syncWorldSurfaceMaterials(scene, uniforms, vegetationIds, patched);
    },
    [patched, scene, uniforms, vegetationIds],
  );

  useLayoutEffect(() => {
    syncUniformsFromContext();
    invalidate();
  }, [invalidate, syncUniformsFromContext]);

  useLayoutEffect(() => {
    // Project edits and vegetation classification changes patch immediately.
    // The frame loop below only discovers asynchronously mounted model parts.
    syncMaterialPatches(true);
    invalidate();
  }, [invalidate, syncMaterialPatches]);

  useFrame(() => {
    syncUniformsFromContext();
    syncMaterialPatches();
  });

  const handleBeforeRender = useCallback<Mesh["onBeforeRender"]>(
    (renderer, _scene, camera) => {
      syncUniformsFromContext(renderer, camera);
      syncMaterialPatches();
    },
    [syncMaterialPatches, syncUniformsFromContext],
  );

  return (
    <group name="living-world-surface">
      <mesh
        ref={meshRef}
        frustumCulled={false}
        geometry={geometry}
        material={material}
        name="living-world-surface-sync"
        onBeforeRender={handleBeforeRender}
        raycast={disableRaycast}
        renderOrder={-1000}
      />
      <WorldAmbientAudio seed={context.seed} weather={context.settings.weather} windVector={context.windVector} />
    </group>
  );
}
