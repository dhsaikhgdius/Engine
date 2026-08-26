import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import type { DirectorWorldRoad } from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { LivingWorldFrameContext, TrafficLayerProps } from "../livingWorldContracts";
import { evaluateWorldTimeOfDayHours } from "../worldTime";
import {
  buildRoadRibbon,
  buildRoadSpline,
  roadLaneOffsetM,
  sampleRoadSplineAt,
  type MutableRoadVec3,
  type RoadSpline,
} from "./roadSpline";
import {
  computeClimateRoadSurfaceAppearance,
  computeTrafficHeadlightFactor,
  trafficWeatherSpeedScale,
  type RoadSurfaceAppearance,
} from "./trafficEnvironment";
import {
  buildRoadTrafficStreams,
  planTrafficBodyVariants,
  vehicleArcPositionAt,
  type RoadTrafficStreams,
  type TrafficBodyVariantPlan,
} from "./trafficFlow";
import {
  buildVehicleGeometry,
  buildVehicleLightsGeometry,
  VEHICLE_BODY_TYPES,
  VEHICLE_COLOR_PALETTE,
} from "./vehicleGeometry";

/**
 * Ambient traffic sub-layer: instanced vehicles flowing along road splines.
 *
 * Every vehicle pose is a pure function of (seed, worldSeconds) via the
 * trafficFlow closed form — no stepped simulation, so scrubbing backwards and
 * arbitrary-order deterministic export replay identically. Matrices are
 * written both during React render (demand-frameloop captures render before
 * useFrame advances) and in useFrame, with a change guard so steady-state
 * playback performs exactly one compose per frame and zero allocations
 * (module-level scratch objects only).
 *
 * Weather threads in as pure inputs: storms/snow scale the SHARED lane speed
 * uniformly (no per-car scales, preserving the no-overtake guarantee) and
 * wetness darkens/glazes the asphalt. Headlights fade in from
 * timeOfDay-evaluated solar hours — all derived per frame from context, never
 * written back into System checkpoint state.
 */

const ROAD_SURFACE_LIFT_M = 0.02;
const ROAD_SURFACE_COLOR = 0x2b2e33;
/** Snow-covered asphalt blend target (trampled white). */
const ROAD_SNOW_COLOR = new Color(0.78, 0.81, 0.85);
/** Cosmetic suspension bounce; tiny, hashed phase per vehicle. */
const BOUNCE_HZ = 2.4;
const BOUNCE_AMPLITUDE_M = 0.012;
const TWO_PI = Math.PI * 2;
/** Below this headlight factor the lights mesh is hidden entirely. */
const HEADLIGHT_VISIBLE_EPSILON = 0.004;

const tempMatrix = new Matrix4();
const tempPosition = new Vector3();
const tempQuaternion = new Quaternion();
const tempEuler = new Euler();
const tempColor = new Color();
const UNIT_SCALE = new Vector3(1, 1, 1);
const scratchPoint: MutableRoadVec3 = [0, 0, 0];
const scratchTangent: MutableRoadVec3 = [0, 0, 0];

function composeVehicleMatrices(
  meshes: readonly InstancedMesh[],
  plan: TrafficBodyVariantPlan,
  spline: RoadSpline,
  streams: RoadTrafficStreams,
  laneOffsetM: number,
  worldSeconds: number,
): void {
  for (let index = 0; index < streams.count; index += 1) {
    const arc = vehicleArcPositionAt(streams, index, worldSeconds);
    sampleRoadSplineAt(spline, arc, scratchPoint, scratchTangent);
    const direction = streams.directions[index]!;
    const forwardX = scratchTangent[0] * direction;
    const forwardY = scratchTangent[1] * direction;
    const forwardZ = scratchTangent[2] * direction;

    // Right-hand traffic: offset toward the right of the travel direction.
    const horizontal = Math.hypot(forwardX, forwardZ);
    let lateralX = 0;
    let lateralZ = 0;
    if (horizontal > 1e-7) {
      lateralX = -forwardZ / horizontal;
      lateralZ = forwardX / horizontal;
    }

    const bounce = Math.sin(worldSeconds * TWO_PI * BOUNCE_HZ + streams.bouncePhases[index]!) * BOUNCE_AMPLITUDE_M;

    const yaw = Math.atan2(forwardX, forwardZ);
    const climb = Math.min(Math.max(forwardY, -1), 1);
    const pitch = -Math.asin(climb);

    tempEuler.set(pitch, yaw, 0, "YXZ");
    tempQuaternion.setFromEuler(tempEuler);
    tempPosition.set(
      scratchPoint[0] + lateralX * laneOffsetM,
      scratchPoint[1] + bounce,
      scratchPoint[2] + lateralZ * laneOffsetM,
    );
    tempMatrix.compose(tempPosition, tempQuaternion, UNIT_SCALE);
    // Body type only reroutes WHICH InstancedMesh receives the matrix; the
    // pose itself stays a pure function of the stream index.
    meshes[streams.bodyTypeIndices[index]!]!.setMatrixAt(plan.slots[index]!, tempMatrix);
  }
  for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
}

function RoadSurface({
  road,
  spline,
  context,
}: {
  road: DirectorWorldRoad;
  spline: RoadSpline;
  context: LivingWorldFrameContext;
}) {
  const geometry = useMemo(() => {
    const ribbon = buildRoadRibbon(spline, road.widthM, ROAD_SURFACE_LIFT_M);
    const built = new BufferGeometry();
    built.setAttribute("position", new BufferAttribute(ribbon.positions, 3));
    built.setAttribute("normal", new BufferAttribute(ribbon.normals, 3));
    built.setAttribute("uv", new BufferAttribute(ribbon.uvs, 2));
    built.setIndex(new BufferAttribute(ribbon.indices, 1));
    built.computeBoundingBox();
    built.computeBoundingSphere();
    built.name = `director-road-surface-${road.id}`;
    return built;
  }, [road.id, road.widthM, spline]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useMemo(
    () => new MeshStandardMaterial({ color: ROAD_SURFACE_COLOR, roughness: 1, metalness: 0 }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  // The road owns its weather appearance (the surface patcher skips
  // living-world-road-* meshes): wet asphalt darkens and glazes, snow blends
  // toward white. Driven by the evaluated climate so an evolving cycle wets
  // and dries the asphalt continuously; the change guard keeps a static
  // climate at zero per-frame material writes.
  const lastAppearanceRef = useRef<RoadSurfaceAppearance | null>(null);
  const syncAppearance = () => {
    const appearance = computeClimateRoadSurfaceAppearance(context.climate);
    const last = lastAppearanceRef.current;
    if (
      last !== null &&
      last.colorScale === appearance.colorScale &&
      last.roughness === appearance.roughness &&
      last.snowMix === appearance.snowMix
    ) {
      return;
    }
    lastAppearanceRef.current = appearance;
    material.color
      .setHex(ROAD_SURFACE_COLOR)
      .multiplyScalar(appearance.colorScale)
      .lerp(ROAD_SNOW_COLOR, appearance.snowMix);
    material.roughness = appearance.roughness;
  };
  // First paint before the frameloop starts (e.g. while scrubbing paused).
  useLayoutEffect(() => {
    syncAppearance();
  });
  useFrame(syncAppearance);

  return <mesh geometry={geometry} material={material} name={`living-world-road-${road.id}`} receiveShadow />;
}

function RoadVehicles({
  road,
  spline,
  context,
}: {
  road: DirectorWorldRoad;
  spline: RoadSpline;
  context: LivingWorldFrameContext;
}) {
  // Weather scales the whole lane uniformly; the hashed 0.85..1.15 band and
  // slot offsets are untouched, so gaps and ordering replay identically.
  // This reads the AUTHORED weather block deliberately: vehicle positions
  // are a closed form of `speed * worldSeconds`, so a time-varying climate
  // scale would teleport every car whenever the ramp moved. Making traffic
  // slow inside an evolving storm needs an integrated arc-length clock
  // (like the wetness integrator) — out of scope for a view-layer scale.
  const laneSpeedScale = trafficWeatherSpeedScale(context.settings.weather);
  const streams = useMemo(
    () =>
      buildRoadTrafficStreams(
        { id: road.id, seedOffset: road.seedOffset, vehicleCount: road.vehicleCount, speedKph: road.speedKph },
        context.seed,
        spline.totalLengthM,
        laneSpeedScale,
      ),
    [road.id, road.seedOffset, road.vehicleCount, road.speedKph, context.seed, spline.totalLengthM, laneSpeedScale],
  );

  // Body type is a cosmetic hash: it reroutes a vehicle into the sedan or
  // SUV InstancedMesh but never touches arc offsets or the shared lane speed.
  // The plan is keyed on road identity WITHOUT the weather scale (the hash
  // ignores it), so an intensity drag rebuilds `streams` per tick without
  // reallocating the InstancedMesh GPU buffers below.
  const plan = useMemo(
    () =>
      planTrafficBodyVariants(
        buildRoadTrafficStreams(
          { id: road.id, seedOffset: road.seedOffset, vehicleCount: road.vehicleCount, speedKph: road.speedKph },
          context.seed,
          spline.totalLengthM,
        ),
      ),
    [road.id, road.seedOffset, road.vehicleCount, road.speedKph, context.seed, spline.totalLengthM],
  );

  const geometries = useMemo(() => VEHICLE_BODY_TYPES.map((bodyType) => buildVehicleGeometry(bodyType)), []);
  useEffect(
    () => () => {
      for (const geometry of geometries) geometry.dispose();
    },
    [geometries],
  );

  // White base with vertex colors: the per-instance palette tint passes
  // through body panels while glass/skirt/wheel vertex colors stay dark.
  const material = useMemo(
    () => new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.25, vertexColors: true }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  const meshes = useMemo(
    () =>
      geometries.map((geometry, body) => {
        const instanced = new InstancedMesh(geometry, material, plan.counts[body]!);
        instanced.frustumCulled = false; // vehicles circulate the whole spline
        instanced.instanceMatrix.setUsage(DynamicDrawUsage);
        instanced.castShadow = true;
        instanced.receiveShadow = false;
        instanced.name = `living-world-traffic-vehicles-${road.id}-${VEHICLE_BODY_TYPES[body]}`;
        return instanced;
      }),
    [geometries, material, plan, road.id],
  );
  // InstancedMesh.dispose releases instance buffers; geometry/material are
  // owned by the effects above.
  useEffect(
    () => () => {
      for (const mesh of meshes) mesh.dispose();
    },
    [meshes],
  );

  // Emissive light clusters (shared across body types) reuse each body
  // mesh's instanceMatrix attribute, so one compose drives body + lights and
  // the GPU uploads a single buffer per body type.
  const lightsGeometry = useMemo(() => buildVehicleLightsGeometry(), []);
  useEffect(() => () => lightsGeometry.dispose(), [lightsGeometry]);
  const lightsMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => lightsMaterial.dispose(), [lightsMaterial]);
  const lightsMeshes = useMemo(
    () =>
      meshes.map((bodyMesh, body) => {
        const instanced = new InstancedMesh(lightsGeometry, lightsMaterial, bodyMesh.count);
        instanced.frustumCulled = false;
        instanced.castShadow = false;
        instanced.receiveShadow = false;
        instanced.instanceMatrix = bodyMesh.instanceMatrix;
        instanced.name = `living-world-traffic-lights-${road.id}-${VEHICLE_BODY_TYPES[body]}`;
        instanced.visible = false;
        return instanced;
      }),
    [lightsGeometry, lightsMaterial, meshes, road.id],
  );
  useEffect(
    () => () => {
      for (const mesh of lightsMeshes) mesh.dispose();
    },
    [lightsMeshes],
  );

  // Palette colors are static per (seed, road, count): write them whenever the
  // mesh or streams identity changes, during render so captures see them.
  useMemo(() => {
    for (let index = 0; index < streams.count; index += 1) {
      tempColor.setHex(VEHICLE_COLOR_PALETTE[streams.colorIndices[index]!]!);
      meshes[streams.bodyTypeIndices[index]!]!.setColorAt(plan.slots[index]!, tempColor);
    }
    for (const mesh of meshes) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [meshes, plan, streams]);

  const laneOffsetM = roadLaneOffsetM(road.widthM);

  // One compose per observable change; render-phase write keeps single
  // invalidated frames (demand frameloop, deterministic capture) correct.
  const lastComposeRef = useRef<{
    meshes: readonly InstancedMesh[];
    spline: RoadSpline;
    streams: RoadTrafficStreams;
    laneOffsetM: number;
    seconds: number;
    headlightFactor: number;
  } | null>(null);
  const composeIfNeeded = () => {
    const hours = evaluateWorldTimeOfDayHours(context.settings.timeOfDay, context.worldSeconds);
    const headlightFactor = computeTrafficHeadlightFactor(hours);
    const last = lastComposeRef.current;
    if (
      last &&
      last.meshes === meshes &&
      last.spline === spline &&
      last.streams === streams &&
      last.laneOffsetM === laneOffsetM &&
      last.seconds === context.worldSeconds &&
      last.headlightFactor === headlightFactor
    ) {
      return;
    }
    composeVehicleMatrices(meshes, plan, spline, streams, laneOffsetM, context.worldSeconds);
    lightsMaterial.opacity = headlightFactor;
    for (const lightsMesh of lightsMeshes) {
      lightsMesh.visible = headlightFactor > HEADLIGHT_VISIBLE_EPSILON;
    }
    lastComposeRef.current = {
      meshes,
      spline,
      streams,
      laneOffsetM,
      seconds: context.worldSeconds,
      headlightFactor,
    };
  };
  composeIfNeeded();
  useFrame(() => {
    composeIfNeeded();
  });

  return (
    <>
      {meshes.map((mesh) => (
        <primitive key={mesh.name} object={mesh} dispose={null} />
      ))}
      {lightsMeshes.map((mesh) => (
        <primitive key={mesh.name} object={mesh} dispose={null} />
      ))}
    </>
  );
}

function RoadTraffic({ road, context }: { road: DirectorWorldRoad; context: LivingWorldFrameContext }) {
  const spline = useMemo(() => buildRoadSpline(road.points, road.loop), [road.points, road.loop]);
  return (
    <>
      {road.showSurface ? <RoadSurface road={road} spline={spline} context={context} /> : null}
      {road.vehicleCount > 0 ? <RoadVehicles road={road} spline={spline} context={context} /> : null}
    </>
  );
}

export default function TrafficLayer({ context, roads }: TrafficLayerProps) {
  return (
    <group name="living-world-traffic">
      {roads.map((road) => (
        <RoadTraffic key={road.id} road={road} context={context} />
      ))}
    </group>
  );
}
