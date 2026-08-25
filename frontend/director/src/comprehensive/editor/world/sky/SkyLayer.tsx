import { useLayoutEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { AmbientLight, DirectionalLight, HemisphereLight } from "three";
import type { DirectorProject } from "../../schema/directorProject";
import { useDirectorStore } from "../../store/directorStore";
import type { SkyLayerProps } from "../livingWorldContracts";
import { isWorldWeatherEvolving } from "../worldClimate";
import WorldAmbientClockDriver from "../worldClock";
import { evaluateLightningState, getLightningBoltAnchor } from "./lightning";
import { AtmosphereSky } from "./AtmosphereSky";
import SkyClouds from "./SkyClouds";
import SkyLightningBolt from "./SkyLightningBolt";
import SkyStars from "./SkyStars";
import { evaluateSkyLighting, getWorldSkyLightScale } from "./solar";

/**
 * Sky sub-layer: time-of-day sun position, Nishita sky dome, billboard
 * clouds, stars, and weather-driven ambient lighting mood. Everything
 * rendered here is a pure function of `(settings, seed, worldSeconds)` via
 * solar.ts / lightning.ts.
 *
 * Light-list contract: while `timeOfDay.drivesSky` is off this layer renders
 * no dome and no day/night lights — the project's authored light list stays
 * untouched. The only exception is storm lightning, a transient weather
 * overlay that may flash regardless of `drivesSky`.
 *
 * Fog stays on the authored scene fog control. This layer must not inject
 * aerial haze onto kilometre-scale film sets.
 */

const SUN_LIGHT_DISTANCE = 180;

/** Authored lights that actually contribute; drives the fill-vs-key decision. */
const selectAuthoredLitLightCount = (state: { project: DirectorProject }): number =>
  (state.project.lights ?? []).filter((light) => light.visible && light.intensity > 0).length;

const selectPanoramaBackdropActive = (state: { project: DirectorProject }): boolean => {
  const environment = state.project.scene.environment;
  return Boolean(state.project.panoramaAssetId) || (environment?.enabled === true && environment.usePanorama);
};

/**
 * Whether the sky dome (and its dome-only companions: stars, billboard
 * clouds) may mount. `drivesSky` off means the authored look owns the sky;
 * an active panorama/HDRI backdrop also hides the dome so the two never
 * fight over the background.
 *
 * @param drivesSky - The project's `timeOfDay.drivesSky` flag.
 * @param panoramaBackdropActive - True when a panorama/HDRI backdrop renders.
 * @returns True when the dome may render.
 */
export function shouldShowSkyDome(drivesSky: boolean, panoramaBackdropActive: boolean): boolean {
  return drivesSky && !panoramaBackdropActive;
}

export default function SkyLayer({ context }: SkyLayerProps) {
  const { seed, settings, worldSeconds, isPlaying } = context;
  const panoramaBackdropActive = useDirectorStore(selectPanoramaBackdropActive);
  const authoredLitLightCount = useDirectorStore(selectAuthoredLitLightCount);
  const skyLightScale = getWorldSkyLightScale(authoredLitLightCount);

  // Weather comes from the evaluated climate: static mode reads the authored
  // block verbatim, an evolving cycle blends the lighting tables and gates
  // lightning on the evaluated storm segment.
  const lighting = evaluateSkyLighting(settings, worldSeconds, context.climate);
  const lightning = evaluateLightningState(seed, worldSeconds, context.climate.weather);

  const drivesSky = settings.timeOfDay.drivesSky;
  const showSkyDome = shouldShowSkyDome(drivesSky, panoramaBackdropActive);

  const sunLightRef = useRef<DirectionalLight>(null);
  const ambientLightRef = useRef<HemisphereLight>(null);
  const lightningFillRef = useRef<AmbientLight>(null);
  const lightningKeyRef = useRef<DirectionalLight>(null);

  const syncSkyFrame = () => {
    const frameLighting = evaluateSkyLighting(settings, context.worldSeconds, context.climate);
    const frameLightning = evaluateLightningState(seed, context.worldSeconds, context.climate.weather);

    const sunLight = sunLightRef.current;
    if (sunLight) {
      sunLight.color.setRGB(...frameLighting.sunColor);
      sunLight.intensity = frameLighting.sunIntensity * skyLightScale;
      sunLight.position.set(
        frameLighting.sunDirection[0] * SUN_LIGHT_DISTANCE,
        frameLighting.sunDirection[1] * SUN_LIGHT_DISTANCE,
        frameLighting.sunDirection[2] * SUN_LIGHT_DISTANCE,
      );
    }
    const ambientLight = ambientLightRef.current;
    if (ambientLight) {
      ambientLight.color.setRGB(...frameLighting.ambientColor);
      ambientLight.groundColor.setRGB(...frameLighting.groundColor);
      ambientLight.intensity = frameLighting.ambientIntensity * skyLightScale;
    }

    if (lightningFillRef.current) {
      lightningFillRef.current.visible = frameLightning.active;
      lightningFillRef.current.intensity = 1.1 * frameLightning.intensity;
    }
    if (lightningKeyRef.current) {
      lightningKeyRef.current.visible = frameLightning.active;
      lightningKeyRef.current.intensity = 2.2 * frameLightning.intensity;
      if (frameLightning.active && frameLightning.strikeWindowIndex !== undefined) {
        // The flash key shines from where the visible channel hangs, so set
        // shadows and highlights agree with the bolt the camera sees.
        const anchor = getLightningBoltAnchor(seed, frameLightning.strikeWindowIndex);
        lightningKeyRef.current.position.set(anchor[0], anchor[1], anchor[2]);
      }
    }
  };

  useLayoutEffect(() => {
    syncSkyFrame();
  });
  useFrame(syncSkyFrame);

  return (
    <group name="living-world-sky">
      <WorldAmbientClockDriver isPlaying={isPlaying} />
      {showSkyDome ? <AtmosphereSky context={context} /> : null}
      {showSkyDome ? <SkyStars context={context} /> : null}
      {showSkyDome ? <SkyClouds context={context} /> : null}
      {drivesSky ? (
        <>
          {/* Shadows stay owned by the authored light list; a second shadow
              caster would fight it and blow the per-view shadow budget. */}
          <directionalLight
            ref={sunLightRef}
            color={lighting.sunColor}
            intensity={lighting.sunIntensity * skyLightScale}
            name="living-world-sun"
            position={[
              lighting.sunDirection[0] * SUN_LIGHT_DISTANCE,
              lighting.sunDirection[1] * SUN_LIGHT_DISTANCE,
              lighting.sunDirection[2] * SUN_LIGHT_DISTANCE,
            ]}
          />
          <hemisphereLight
            ref={ambientLightRef}
            color={lighting.ambientColor}
            groundColor={lighting.groundColor}
            intensity={lighting.ambientIntensity * skyLightScale}
            name="living-world-sky-ambient"
            position={[0, 50, 0]}
          />
        </>
      ) : null}
      {settings.weather.preset === "storm" || isWorldWeatherEvolving(settings) ? (
        <>
          <ambientLight
            ref={lightningFillRef}
            color="#cdd9ff"
            intensity={1.1 * lightning.intensity}
            name="living-world-lightning-fill"
            visible={lightning.active}
          />
          {/* Placeholder position; syncSkyFrame re-aims the key from the
              active strike's channel anchor every frame. */}
          <directionalLight
            ref={lightningKeyRef}
            color="#e8eeff"
            intensity={2.2 * lightning.intensity}
            name="living-world-lightning-key"
            position={[60, 140, -40]}
            visible={lightning.active}
          />
          <SkyLightningBolt context={context} />
        </>
      ) : null}
    </group>
  );
}
