import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { PlaneGeometry, type Mesh } from "three";
import type { DirectorWorldWaterBody } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext, WaterLayerProps } from "../livingWorldContracts";
import { createGerstnerWaveSet, sumGerstnerAmplitudes } from "./gerstner";
import { acquireWaterEnvProbe, releaseWaterEnvProbe, type WaterEnvProbe } from "./waterEnvProbe";
import {
  acquireWorldHeightMap,
  bindWorldHeightMapUniforms,
  releaseWorldHeightMap,
  type WorldHeightMap,
} from "../surface/worldHeightMap";
import {
  createWaterSurfaceMaterial,
  writeGerstnerWaveStaticUniforms,
  writeWaterFrameUniforms,
  type WaterFrameState,
} from "./waterMaterial";
import { computeWaterDetailPhase, computeWaterSegmentsForAxis, resolveWaterOccluderHeight } from "./waterParams";

/**
 * Water sub-layer: shader-based water surfaces for `DirectorWorldWaterBody`
 * rectangles (Gerstner waves + flow-scrolled normals + depth tint + foam).
 *
 * Determinism/demand-mode contract:
 * - All motion derives from `uTime = context.worldSeconds`; identical
 *   (seed, worldSeconds) render identical pixels regardless of session
 *   history, so exports and scrubbing stay reproducible.
 * - No internal clocks: a single invalidated frame is rendered correctly
 *   because every uniform is (re)written from props before each draw.
 * - Per-frame work is uniform writes only; geometry and materials are
 *   memoized per body and disposed on unmount or when their inputs change.
 */
export default function WaterLayer({ context, waterBodies }: WaterLayerProps) {
  return (
    <group name="director-living-world-water">
      {waterBodies.map((body) => (
        <WaterBodySurface key={body.id} body={body} context={context} />
      ))}
    </group>
  );
}

const DEGREES_TO_RADIANS = Math.PI / 180;

function WaterBodySurface({ body, context }: { body: DirectorWorldWaterBody; context: LivingWorldFrameContext }) {
  const invalidate = useThree((state) => state.invalidate);
  const { sizeX, sizeZ, rotationDegrees, center } = body.surface;

  const segmentsX = useMemo(() => computeWaterSegmentsForAxis(sizeX, body.waveLengthM), [sizeX, body.waveLengthM]);
  const segmentsZ = useMemo(() => computeWaterSegmentsForAxis(sizeZ, body.waveLengthM), [sizeZ, body.waveLengthM]);

  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(sizeX, sizeZ, segmentsX, segmentsZ);
    // Bake the plane into the XZ ground orientation so the mesh's own
    // rotation is purely the authored surface yaw.
    plane.rotateX(-Math.PI / 2);
    return plane;
  }, [sizeX, sizeZ, segmentsX, segmentsZ]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(() => createWaterSurfaceMaterial(), []);
  useEffect(() => () => material.dispose(), [material]);

  const waves = useMemo(
    () =>
      createGerstnerWaveSet({
        worldSeed: context.seed,
        bodyId: body.id,
        waveAmplitude: body.waveAmplitude,
        waveLengthM: body.waveLengthM,
        flowSpeedMps: body.flowSpeedMps,
      }),
    [context.seed, body.id, body.waveAmplitude, body.waveLengthM, body.flowSpeedMps],
  );
  const amplitudeSum = useMemo(() => sumGerstnerAmplitudes(waves), [waves]);
  const detailPhase = useMemo(() => computeWaterDetailPhase(context.seed, body.id), [context.seed, body.id]);

  // Slow-changing uniforms: rewritten only when their sources change.
  useEffect(() => {
    material.uniforms.uColorShallow.value.set(body.colorShallow);
    material.uniforms.uColorDeep.value.set(body.colorDeep);
    writeGerstnerWaveStaticUniforms(material.uniforms, waves);
    material.uniforms.uDetailPhase.value = detailPhase;
    invalidate();
  }, [material, body.colorShallow, body.colorDeep, waves, detailPhase, invalidate]);

  // Latest-props bridge into the frame loop. Fields are mutated (not
  // replaced) so steady-state renders allocate nothing, and the layout
  // effect's invalidate() guarantees demand-mode repaints whenever any
  // water-relevant prop changes — even if no other layer requests a frame.
  const frameState = useRef<WaterFrameState>({
    context,
    body,
    waves,
    amplitudeSum,
    occluderHeight: context.groundHeight,
  });
  useLayoutEffect(() => {
    frameState.current.context = context;
    frameState.current.body = body;
    frameState.current.waves = waves;
    frameState.current.amplitudeSum = amplitudeSum;
    // Sample terrain outside the GL pass — raycasting from onBeforeRender
    // re-enters the renderer and can blank the offscreen capture.
    frameState.current.occluderHeight = resolveWaterOccluderHeight(
      body,
      context.groundHeight,
      context.sampleGroundHeight,
    );
    writeWaterFrameUniforms(material.uniforms, frameState.current);
    invalidate();
  });

  // Runs before every frameloop draw. Offscreen capture does not go through
  // here — that path is covered by the layout write and onBeforeRender.
  useFrame(() => {
    writeWaterFrameUniforms(material.uniforms, frameState.current);
  });

  // One shared environment probe across every water/river surface: acquire is
  // ref-counted so the cube target lives while any surface is mounted and is
  // disposed when the last one unmounts. Registration lets the probe hide this
  // mesh while capturing (water must not reflect itself) and average its
  // center into the capture anchor.
  const meshRef = useRef<Mesh>(null);
  const envProbeRef = useRef<WaterEnvProbe | null>(null);
  const heightMapRef = useRef<WorldHeightMap | null>(null);
  useEffect(() => {
    const probe = acquireWaterEnvProbe();
    envProbeRef.current = probe;
    const heightMap = acquireWorldHeightMap();
    heightMapRef.current = heightMap;
    const mesh = meshRef.current;
    const unregister = mesh === null ? null : probe.registerSurface(mesh);
    return () => {
      unregister?.();
      envProbeRef.current = null;
      heightMapRef.current = null;
      releaseWaterEnvProbe();
      releaseWorldHeightMap();
    };
  }, []);

  // Fires inside the GL pass for every render of this mesh — including direct
  // offscreen captures that bypass useFrame. The first surface rendered each
  // frame refreshes the shared probe when the policy demands it; afterwards
  // the env uniforms are plain per-frame uniform writes (probe blend stays 0
  // until the first capture, keeping the procedural sky as the fallback).
  const handleBeforeRender = useCallback<Mesh["onBeforeRender"]>(
    (renderer, scene, camera) => {
      writeWaterFrameUniforms(material.uniforms, frameState.current);
      const probe = envProbeRef.current;
      if (probe !== null) {
        probe.handleBeforeRender(renderer, scene, camera, frameState.current.context.worldSeconds);
        material.uniforms.uEnvMap.value = probe.getTexture();
        material.uniforms.uEnvBlend.value = probe.getEnvBlend();
      }
      const heightMap = heightMapRef.current;
      if (heightMap !== null) {
        heightMap.handleBeforeRender(renderer, scene, camera, frameState.current.context.worldSeconds);
        bindWorldHeightMapUniforms(material.uniforms, heightMap);
      }
    },
    [material],
  );

  return (
    <mesh
      ref={meshRef}
      onBeforeRender={handleBeforeRender}
      name={`director-water-${body.id}`}
      geometry={geometry}
      material={material}
      position={center}
      // Positive protocol degrees turn +Z toward +X, matching the compass
      // convention used by wind/flow directions — same sign as three's +Y yaw.
      rotation-y={rotationDegrees * DEGREES_TO_RADIANS}
      // The base plane's bounding volume ignores vertical wave displacement,
      // which would make crests pop at the frustum edge; with ≤ 8 bodies the
      // culling saving is irrelevant.
      frustumCulled={false}
    />
  );
}
