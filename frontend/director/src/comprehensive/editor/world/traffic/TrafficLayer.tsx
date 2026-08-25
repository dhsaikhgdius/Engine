import { useEffect, useMemo, useRef } from "react";
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
import type {
  DirectorWorldRoad,
  DirectorWorldWeather,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
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
  computeRoadSurfaceAppearance,
  computeTrafficHeadlightFactor,
  trafficWeatherSpeedScale,
} from "./trafficEnvironment";
import { buildRoadTrafficStreams, vehicleArcPositionAt, type RoadTrafficStreams } from "./trafficFlow";
import { buildVehicleGeometry, buildVehicleLightsGeometry, VEHICLE_COLOR_PALETTE } from "./vehicleGeometry";

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
  mesh: InstancedMesh,
  spline: RoadSpline,
  streams: RoadTrafficStreams,
  laneOffsetM: number,
  worldSeconds: number,
): void {
  const count = Math.min(mesh.count, streams.count);
  for (let index = 0; index < count; index += 1) {
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
    mesh.setMatrixAt(index, tempMatrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

function RoadSurface({
  road,
  spline,
  weather,
}: {
  road: DirectorWorldRoad;
  spline: RoadSpline;
  weather: DirectorWorldWeather;
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
  // toward white. Pure function of authored weather — no per-frame work.
  const appearance = computeRoadSurfaceAppearance(weather);
  useMemo(() => {
    material.color
      .setHex(ROAD_SURFACE_COLOR)
      .multiplyScalar(appearance.colorScale)
      .lerp(ROAD_SNOW_COLOR, appearance.snowMix);
    material.roughness = appearance.roughness;
  }, [material, appearance.colorScale, appearance.roughness, appearance.snowMix]);

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

  const geometry = useMemo(() => buildVehicleGeometry(), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // White base with vertex colors: the per-instance palette tint passes
  // through body panels while glass/skirt/wheel vertex colors stay dark.
  const material = useMemo(
    () => new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.25, vertexColors: true }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  const mesh = useMemo(() => {
    const instanced = new InstancedMesh(geometry, material, road.vehicleCount);
    instanced.frustumCulled = false; // vehicles circulate the whole spline
    instanced.instanceMatrix.setUsage(DynamicDrawUsage);
    instanced.castShadow = true;
    instanced.receiveShadow = false;
    instanced.name = `living-world-traffic-vehicles-${road.id}`;
    return instanced;
  }, [geometry, material, road.id, road.vehicleCount]);
  // InstancedMesh.dispose releases instance buffers; geometry/material are
  // owned by the effects above.
  useEffect(() => () => mesh.dispose(), [mesh]);

  // Emissive light clusters share the vehicle instanceMatrix attribute, so
  // one compose drives both meshes and the GPU uploads a single buffer.
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
  const lightsMesh = useMemo(() => {
    const instanced = new InstancedMesh(lightsGeometry, lightsMaterial, road.vehicleCount);
    instanced.frustumCulled = false;
    instanced.castShadow = false;
    instanced.receiveShadow = false;
    instanced.instanceMatrix = mesh.instanceMatrix;
    instanced.name = `living-world-traffic-lights-${road.id}`;
    instanced.visible = false;
    return instanced;
  }, [lightsGeometry, lightsMaterial, mesh, road.id, road.vehicleCount]);
  useEffect(() => () => lightsMesh.dispose(), [lightsMesh]);

  // Palette colors are static per (seed, road, count): write them whenever the
  // mesh or streams identity changes, during render so captures see them.
  useMemo(() => {
    for (let index = 0; index < Math.min(mesh.count, streams.count); index += 1) {
      tempColor.setHex(VEHICLE_COLOR_PALETTE[streams.colorIndices[index]!]!);
      mesh.setColorAt(index, tempColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [mesh, streams]);

  const laneOffsetM = roadLaneOffsetM(road.widthM);

  // One compose per observable change; render-phase write keeps single
  // invalidated frames (demand frameloop, deterministic capture) correct.
  const lastComposeRef = useRef<{
    mesh: InstancedMesh;
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
      last.mesh === mesh &&
      last.spline === spline &&
      last.streams === streams &&
      last.laneOffsetM === laneOffsetM &&
      last.seconds === context.worldSeconds &&
      last.headlightFactor === headlightFactor
    ) {
      return;
    }
    composeVehicleMatrices(mesh, spline, streams, laneOffsetM, context.worldSeconds);
    lightsMaterial.opacity = headlightFactor;
    lightsMesh.visible = headlightFactor > HEADLIGHT_VISIBLE_EPSILON;
    lastComposeRef.current = {
      mesh,
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
      <primitive object={mesh} dispose={null} />
      <primitive object={lightsMesh} dispose={null} />
    </>
  );
}

function RoadTraffic({ road, context }: { road: DirectorWorldRoad; context: LivingWorldFrameContext }) {
  const spline = useMemo(() => buildRoadSpline(road.points, road.loop), [road.points, road.loop]);
  return (
    <>
      {road.showSurface ? <RoadSurface road={road} spline={spline} weather={context.settings.weather} /> : null}
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
