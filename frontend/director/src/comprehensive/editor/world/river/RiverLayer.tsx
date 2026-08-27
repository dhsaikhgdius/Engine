/**
 * RiverLayer: renders authored world rivers as flow-aligned ribbon meshes.
 * Geometry (with per-vertex flow tangents, slope, curvature, and width
 * factors) is rebuilt only when the river definition changes; per-frame
 * water motion is uniform-only via writeRiverFrameUniforms inside useFrame.
 * Shares the pooled water environment probe with lake water bodies so
 * reflections stay consistent across all water surfaces.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, type Mesh } from "three";
import type {
  DirectorWorldRiver,
  DirectorWorldWaterBody,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext, RiverLayerProps } from "../livingWorldContracts";
import { acquireWaterEnvProbe, releaseWaterEnvProbe, type WaterEnvProbe } from "../water/waterEnvProbe";
import { computeWaterEnvBlendScale } from "../water/waterParams";
import { buildRiverRibbonData } from "./riverGeometry";
import { createRiverSurfaceMaterial, resolveRiverOccluderHeight, writeRiverFrameUniforms } from "./riverMaterial";

function createRiverGeometry(id: string, river: DirectorWorldRiver) {
  const data = buildRiverRibbonData(river);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(data.normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(data.uvs, 2));
  geometry.setAttribute("aFlowTangent", new BufferAttribute(data.flowTangents, 3));
  geometry.setAttribute("aSlope", new BufferAttribute(data.slopes, 1));
  geometry.setAttribute("aCurvature", new BufferAttribute(data.curvatures, 1));
  geometry.setAttribute("aWidthFactor", new BufferAttribute(data.widthFactors, 1));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = `director-river-ribbon-${id}`;
  return geometry;
}

function RiverSurface({ body, context }: { body: DirectorWorldWaterBody; context: LivingWorldFrameContext }) {
  // RiverLayer receives only bodies filtered by LivingWorldLayer.
  const river = body.river!;
  const geometry = useMemo(() => createRiverGeometry(body.id, river), [body.id, river]);
  const material = useMemo(() => createRiverSurfaceMaterial(body), [body]);

  const occluderHeight = resolveRiverOccluderHeight(body, context.groundHeight, context.sampleGroundHeight);
  const occluderHeightRef = useRef(occluderHeight);
  occluderHeightRef.current = occluderHeight;

  // Demand-rendered captures may not advance useFrame before the direct render;
  // write from React as well so arbitrary-frame export always sees current data.
  writeRiverFrameUniforms(material, body, context, occluderHeight);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(() => {
    writeRiverFrameUniforms(material, body, context, occluderHeightRef.current);
  });

  // Shared environment probe (one per app, ref-counted with WaterLayer): the
  // ribbon registers so captures hide it and its spline midpoint joins the
  // probe anchor; it releases on unmount.
  const meshRef = useRef<Mesh>(null);
  const envProbeRef = useRef<WaterEnvProbe | null>(null);
  useEffect(() => {
    const probe = acquireWaterEnvProbe();
    envProbeRef.current = probe;
    const mesh = meshRef.current;
    const unregister = mesh === null ? null : probe.registerSurface(mesh);
    return () => {
      unregister?.();
      envProbeRef.current = null;
      releaseWaterEnvProbe();
    };
  }, []);

  // Fires for every render of this mesh, including direct offscreen captures.
  // Blend stays 0 until the probe's first capture (procedural sky fallback).
  const handleBeforeRender = useCallback<Mesh["onBeforeRender"]>(
    (renderer, scene, camera) => {
      writeRiverFrameUniforms(material, body, context, occluderHeightRef.current);
      const probe = envProbeRef.current;
      if (probe === null) return;
      probe.handleBeforeRender(renderer, scene, camera, context.worldSeconds);
      material.uniforms.uEnvMap.value = probe.getTexture();
      // Agitated water (storm churn, strong wind) breaks the mirror up: the
      // probe blend recedes toward the weather-dimmed procedural sky.
      material.uniforms.uEnvBlend.value =
        probe.getEnvBlend() *
        computeWaterEnvBlendScale(Math.hypot(context.windVector[0], context.windVector[2]), context.settings.weather);
    },
    [material, body, context],
  );

  return (
    <mesh
      ref={meshRef}
      onBeforeRender={handleBeforeRender}
      frustumCulled={false}
      geometry={geometry}
      material={material}
      name={`living-world-river-${body.id}`}
      renderOrder={2}
    />
  );
}

/**
 * Curved river ribbons are separate from rectangular water bodies because
 * their flow direction varies per vertex. The shader consumes the spline
 * tangent attribute, keeping ripples, highlights and foam aligned through bends.
 */
export default function RiverLayer({ context, rivers }: RiverLayerProps) {
  return (
    <>
      {rivers.map((body) => (
        <RiverSurface body={body} context={context} key={body.id} />
      ))}
    </>
  );
}
