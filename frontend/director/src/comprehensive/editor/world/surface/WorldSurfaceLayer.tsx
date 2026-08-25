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
/**
 * Scene-walk discovery cadence for asynchronously mounted model parts.
 * Throttled on the DETERMINISTIC clocks (context.frame during playback,
 * quantized worldSeconds while scrubbing) — never performance.now — so an
 * export or seek patches newly mounted meshes at the same world time on
 * every run instead of depending on how fast the machine renders.
 */
const MATERIAL_DISCOVERY_INTERVAL_FRAMES = 12;
const MATERIAL_DISCOVERY_INTERVAL_SECONDS = 0.5;

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
  const lastMaterialSyncRef = useRef<{ frame: number; timeBucket: number } | null>(null);
  // Read through a ref so syncMaterialPatches keeps a stable identity across
  // per-frame context updates; the force-sync layout effect below must only
  // re-fire on project/classification changes, not every frame.
  const contextRef = useRef(context);
  contextRef.current = context;
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
        context.climate.weather,
        context.windVector[0],
        context.windVector[2],
        context.worldSeconds,
        {
          seed: context.seed,
          gustiness: context.settings.wind?.gustiness ?? 0,
          turbulence: context.settings.wind?.turbulence ?? 0,
        },
        context.climate,
      );
      if (renderer && camera) {
        heightMapRef.current?.handleBeforeRender(renderer, scene, camera, context.worldSeconds);
      }
    },
    [context, scene, uniforms],
  );

  const syncMaterialPatches = useCallback(
    (force = false) => {
      const frame = contextRef.current.frame;
      const timeBucket = Math.floor(contextRef.current.worldSeconds / MATERIAL_DISCOVERY_INTERVAL_SECONDS);
      const last = lastMaterialSyncRef.current;
      // abs() so a playback restart (frame counter reset) still resyncs.
      if (
        !force &&
        last !== null &&
        Math.abs(frame - last.frame) < MATERIAL_DISCOVERY_INTERVAL_FRAMES &&
        timeBucket === last.timeBucket
      ) {
        return;
      }
      lastMaterialSyncRef.current = { frame, timeBucket };
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
      <WorldAmbientAudio context={context} />
    </group>
  );
}
