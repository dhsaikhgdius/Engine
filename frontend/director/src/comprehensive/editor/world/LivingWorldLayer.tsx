import { lazy, Suspense, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import type { DirectorObject } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { resolveDirectorSceneAnchor } from "../canvas/sceneOverlays";
import { getWorldSecondsForFrame } from "./worldTime";
import { getWorldWindVector, writeWorldWindVector } from "./worldWind";
import { evaluateWorldClimate, isWorldWeatherEvolving } from "./worldClimate";
import { getWorldAmbientOffsetSeconds, WORLD_AMBIENT_CLOCK_FRAME_PRIORITY } from "./worldClock";
import { useWorldGroundSampler } from "./worldGround";
import type { LivingWorldFrameContext, ResolvedWorldEffect } from "./livingWorldContracts";
import SkyLayer from "./sky/SkyLayer";

/**
 * Living World orchestrator.
 *
 * Mounts inside the SceneRoot group, so every sub-layer works in project
 * space. Optional systems stay lazy so projects without water or wildlife
 * pay nothing. Sky lighting is eager: a shared Suspense fallback of `null`
 * used to hold the sun, hemisphere, and IBL off-screen until every other
 * world chunk arrived, so the first view of a loaded set was unlit. Water and
 * river use separate Suspense boundaries so switching a lake off a river
 * ribbon does not unmount the rest of the world while the new chunk loads.
 *
 * Ownership: this file resolves shared frame context (time, wind, anchors)
 * and mounts sub-layers. Visual and simulation logic belongs to the layer
 * modules under effects/, water/, sky/, and wildlife/.
 */
/** Multiplies the evaluated wind by the climate gain; a gain of 1 is a no-op. */
function applyClimateWindGain(windVector: [number, number, number], gain: number): void {
  if (gain === 1) return;
  windVector[0] *= gain;
  windVector[1] *= gain;
  windVector[2] *= gain;
}

const EffectsLayer = lazy(() => import("./effects/EffectsLayer"));
const WaterLayer = lazy(() => import("./water/WaterLayer"));
const RiverLayer = lazy(() => import("./river/RiverLayer"));
const WildlifeLayer = lazy(() => import("./wildlife/WildlifeLayer"));
const TrafficLayer = lazy(() => import("./traffic/TrafficLayer"));
const WorldSurfaceLayer = lazy(() => import("./surface/WorldSurfaceLayer"));

export function LivingWorldLayer({
  evaluatedObjects,
  frame,
  fps,
  isPlaying = false,
}: {
  /** Frame-evaluated objects from SceneRoot so bound anchors follow animation. */
  evaluatedObjects: DirectorObject[];
  frame: number;
  fps: number;
  isPlaying?: boolean;
}) {
  const world = useDirectorStore((state) => state.project.world);
  const groundHeight = useDirectorStore((state) => state.project.scene.groundHeight);
  const enabled = world?.settings.enabled === true;
  const settings = world?.settings;
  const timelineSeconds = getWorldSecondsForFrame(frame, fps);
  const sampleGroundHeight = useWorldGroundSampler();

  const context = useMemo<LivingWorldFrameContext | null>(() => {
    if (!enabled || !settings) return null;
    const worldSeconds = timelineSeconds + getWorldAmbientOffsetSeconds();
    const climate = evaluateWorldClimate(settings, worldSeconds);
    const windVector = getWorldWindVector(settings.wind, worldSeconds);
    applyClimateWindGain(windVector, climate.windGain);
    return {
      worldSeconds,
      frame,
      fps,
      isPlaying,
      seed: settings.seed,
      settings,
      climate,
      windVector,
      groundHeight,
      ...(sampleGroundHeight ? { sampleGroundHeight } : {}),
    };
  }, [enabled, fps, frame, groundHeight, isPlaying, sampleGroundHeight, settings, timelineSeconds]);

  // Ambient time is mutable render state, not application state. Updating the
  // stable context here keeps every GPU/simulation layer current without
  // reconciling the whole Living World React tree at display refresh rate.
  // The climate is evaluated exactly once per frame here; sub-layers read it.
  useFrame(() => {
    if (!context) return;
    context.worldSeconds = timelineSeconds + getWorldAmbientOffsetSeconds();
    context.climate = evaluateWorldClimate(context.settings, context.worldSeconds);
    writeWorldWindVector(context.windVector, context.settings.wind, context.worldSeconds);
    applyClimateWindGain(context.windVector, context.climate.windGain);
  }, WORLD_AMBIENT_CLOCK_FRAME_PRIORITY + 1);

  const objectsById = useMemo(() => new Map(evaluatedObjects.map((object) => [object.id, object])), [evaluatedObjects]);

  const resolvedEffects = useMemo<ResolvedWorldEffect[]>(() => {
    if (!enabled || !world) return [];
    const resolved: ResolvedWorldEffect[] = [];
    world.effects.forEach((effect) => {
      if (!effect.visible) return;
      const origin = resolveDirectorSceneAnchor(effect.anchor, objectsById);
      if (origin) resolved.push({ effect, origin });
    });
    return resolved;
  }, [enabled, objectsById, world]);

  if (!world || !context) return null;

  const visibleWaterBodies = world.waterBodies.filter((body) => body.visible && !body.river);
  const visibleRivers = world.waterBodies.filter((body) => body.visible && body.river);
  const visibleWildlife = world.wildlife.filter((group) => group.visible);
  // Pre-roads world blocks may lack the collection until reparsed from disk.
  const visibleRoads = (world.roads ?? []).filter((road) => road.visible);
  const weatherPreset = context.settings.weather.preset;
  // An evolving cycle can reach precipitation at any worldSeconds, so the
  // weather-capable layers stay mounted whenever evolution is on.
  const weatherEvolving = isWorldWeatherEvolving(context.settings);
  const captureHeightMap =
    visibleWaterBodies.length > 0 ||
    visibleRivers.length > 0 ||
    weatherEvolving ||
    weatherPreset === "rain" ||
    weatherPreset === "storm" ||
    weatherPreset === "snow";

  return (
    <>
      <SkyLayer context={context} />
      <Suspense fallback={null}>
        <WorldSurfaceLayer captureHeightMap={captureHeightMap} context={context} evaluatedObjects={evaluatedObjects} />
      </Suspense>
      {resolvedEffects.length > 0 || weatherEvolving || context.settings.weather.preset !== "clear" ? (
        <Suspense fallback={null}>
          <EffectsLayer context={context} effects={resolvedEffects} />
        </Suspense>
      ) : null}
      {visibleWaterBodies.length > 0 ? (
        <Suspense fallback={null}>
          <WaterLayer context={context} waterBodies={visibleWaterBodies} />
        </Suspense>
      ) : null}
      {visibleRivers.length > 0 ? (
        <Suspense fallback={null}>
          <RiverLayer context={context} rivers={visibleRivers} />
        </Suspense>
      ) : null}
      {visibleWildlife.length > 0 ? (
        <Suspense fallback={null}>
          <WildlifeLayer context={context} groups={visibleWildlife} />
        </Suspense>
      ) : null}
      {visibleRoads.length > 0 ? (
        <Suspense fallback={null}>
          <TrafficLayer context={context} roads={visibleRoads} />
        </Suspense>
      ) : null}
    </>
  );
}
