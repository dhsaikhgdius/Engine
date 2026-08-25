import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  type AmbientLight,
  type DirectionalLight,
  type HemisphereLight,
  type Points,
  type PointsMaterial,
} from "three";
import type { DirectorProject } from "../../schema/directorProject";
import { useDirectorStore } from "../../store/directorStore";
import type { SkyLayerProps } from "../livingWorldContracts";
import WorldAmbientClockDriver from "../worldClock";
import { evaluateLightningState } from "./lightning";
import { AtmosphereSky } from "./AtmosphereSky";
import { createStarFieldPositions } from "./starField";
import { evaluateSkyLighting, getWorldSkyLightScale } from "./solar";

/**
 * Sky sub-layer: time-of-day sun position, Nishita sky dome, stars, and
 * weather-driven ambient lighting mood. Everything rendered here is a pure
 * function of `(settings, seed, worldSeconds)` via solar.ts / lightning.ts.
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

export default function SkyLayer({ context }: SkyLayerProps) {
  const { seed, settings, worldSeconds, isPlaying } = context;
  const panoramaBackdropActive = useDirectorStore(selectPanoramaBackdropActive);
  const authoredLitLightCount = useDirectorStore(selectAuthoredLitLightCount);
  const skyLightScale = getWorldSkyLightScale(authoredLitLightCount);

  const lighting = evaluateSkyLighting(settings, worldSeconds);
  const lightning = evaluateLightningState(seed, worldSeconds, settings.weather);

  const drivesSky = settings.timeOfDay.drivesSky;
  const showSkyDome = drivesSky && !panoramaBackdropActive;
  const starPositions = useMemo(() => createStarFieldPositions(seed), [seed]);

  const starFieldRef = useRef<Points>(null);
  const starMaterialRef = useRef<PointsMaterial>(null);
  const sunLightRef = useRef<DirectionalLight>(null);
  const ambientLightRef = useRef<HemisphereLight>(null);
  const lightningFillRef = useRef<AmbientLight>(null);
  const lightningKeyRef = useRef<DirectionalLight>(null);

  const syncSkyFrame = () => {
    const frameLighting = evaluateSkyLighting(settings, context.worldSeconds);
    const frameLightning = evaluateLightningState(seed, context.worldSeconds, settings.weather);

    if (starFieldRef.current) starFieldRef.current.visible = frameLighting.starsOpacity > 0.02;
    if (starMaterialRef.current) starMaterialRef.current.opacity = frameLighting.starsOpacity;

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
      {showSkyDome ? (
        <points
          ref={starFieldRef}
          key={seed}
          name="living-world-stars"
          frustumCulled={false}
          visible={lighting.starsOpacity > 0.02}
        >
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[starPositions, 3]} />
          </bufferGeometry>
          <pointsMaterial
            ref={starMaterialRef}
            blending={AdditiveBlending}
            color="#dfe8ff"
            depthWrite={false}
            opacity={lighting.starsOpacity}
            size={1.8}
            sizeAttenuation={false}
            toneMapped={false}
            transparent
          />
        </points>
      ) : null}
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
      {settings.weather.preset === "storm" ? (
        <>
          <ambientLight
            ref={lightningFillRef}
            color="#cdd9ff"
            intensity={1.1 * lightning.intensity}
            name="living-world-lightning-fill"
            visible={lightning.active}
          />
          <directionalLight
            ref={lightningKeyRef}
            color="#e8eeff"
            intensity={2.2 * lightning.intensity}
            name="living-world-lightning-key"
            position={[60, 140, -40]}
            visible={lightning.active}
          />
        </>
      ) : null}
    </group>
  );
}
