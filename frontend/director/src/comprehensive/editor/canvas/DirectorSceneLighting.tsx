/**
 * Scene lighting and fog rendering for the Director viewport, supporting ambient, hemisphere,
 * directional, point, spot, and rect-area lights with shadow-casting limits.
 *
 * @module director-scene-lighting
 */

import { useLayoutEffect, useMemo, useRef } from "react";
import { DirectionalLight, Object3D, RectAreaLight, SpotLight, type Vector3Tuple } from "three";
import type { DirectorFogSettings, DirectorLight } from "../schema/directorProject";

const ORIGIN: Vector3Tuple = [0, 0, 0];
/** Maximum number of lights that can cast shadows concurrently in the viewport. */
export const DIRECTOR_VIEWPORT_SHADOW_LIGHT_LIMIT = 4;

function canDirectorLightCastShadow(light: DirectorLight) {
  return light.type === "directional" || light.type === "point" || light.type === "spot";
}

/** Returns true if the given Director light is eligible to cast shadows based on its type and shadow settings. */
export function isDirectorLightShadowEnabled(light: DirectorLight, shadowsEnabled: boolean) {
  return shadowsEnabled && light.visible && canDirectorLightCastShadow(light) && light.castShadow !== false;
}

/** Returns the ordered list of light IDs eligible for shadow casting, capped at the given limit. */
export function getDirectorShadowCastingLightIds(
  lights: readonly DirectorLight[],
  shadowsEnabled: boolean,
  limit = DIRECTOR_VIEWPORT_SHADOW_LIGHT_LIMIT,
) {
  if (!shadowsEnabled || limit <= 0) return [];
  return lights
    .filter((light) => isDirectorLightShadowEnabled(light, true))
    .slice(0, limit)
    .map((light) => light.id);
}

function TargetedDirectionalLight({
  layeredDynamicShadow,
  light,
  shadowMapSize,
}: {
  layeredDynamicShadow: boolean;
  light: DirectorLight;
  shadowMapSize: number;
}) {
  const target = useMemo(() => new Object3D(), []);
  const ref = useRef<DirectionalLight>(null);
  const dynamicShadowRef = useRef<DirectionalLight>(null);

  useLayoutEffect(() => {
    target.position.set(...(light.target ?? ORIGIN));
    target.updateMatrixWorld();
    if (ref.current) ref.current.target = target;
    if (dynamicShadowRef.current) dynamicShadowRef.current.target = target;
  }, [light.target, target]);

  return (
    <>
      <directionalLight
        ref={ref}
        castShadow={light.castShadow}
        color={light.color}
        intensity={light.intensity}
        name={`director-light-${light.id}`}
        position={light.position ?? [5, 8, 5]}
        shadow-mapSize-height={shadowMapSize}
        shadow-mapSize-width={shadowMapSize}
        target={target}
        userData={{ directorLightId: light.id, directorLightType: light.type }}
      />
      {layeredDynamicShadow ? (
        <directionalLight
          ref={dynamicShadowRef}
          castShadow
          color={light.color}
          intensity={0}
          name={`director-dynamic-shadow-light-${light.id}`}
          position={light.position ?? [5, 8, 5]}
          shadow-mapSize-height={shadowMapSize}
          shadow-mapSize-width={shadowMapSize}
          target={target}
          userData={{
            directorDynamicShadowLight: true,
            directorLightId: light.id,
            directorLightType: light.type,
          }}
        />
      ) : null}
      <primitive object={target} />
    </>
  );
}

function TargetedSpotLight({ light, shadowMapSize }: { light: DirectorLight; shadowMapSize: number }) {
  const target = useMemo(() => new Object3D(), []);
  const ref = useRef<SpotLight>(null);

  useLayoutEffect(() => {
    target.position.set(...(light.target ?? ORIGIN));
    target.updateMatrixWorld();
    if (ref.current) ref.current.target = target;
  }, [light.target, target]);

  return (
    <>
      <spotLight
        ref={ref}
        angle={light.angle ?? Math.PI / 6}
        castShadow={light.castShadow}
        color={light.color}
        decay={light.decay ?? 2}
        distance={light.distance ?? 0}
        intensity={light.intensity}
        name={`director-light-${light.id}`}
        penumbra={light.penumbra ?? 0.25}
        position={light.position ?? [3, 5, 3]}
        shadow-mapSize-height={shadowMapSize}
        shadow-mapSize-width={shadowMapSize}
        target={target}
        userData={{ directorLightId: light.id, directorLightType: light.type }}
      />
      <primitive object={target} />
    </>
  );
}

function TargetedRectAreaLight({ light }: { light: DirectorLight }) {
  const ref = useRef<RectAreaLight>(null);

  useLayoutEffect(() => {
    ref.current?.lookAt?.(...(light.target ?? ORIGIN));
    ref.current?.updateMatrixWorld?.();
  }, [light.target]);

  return (
    <rectAreaLight
      ref={ref}
      color={light.color}
      height={light.height ?? 2}
      intensity={light.intensity}
      name={`director-light-${light.id}`}
      position={light.position ?? [0, 4, 2]}
      userData={{ directorLightId: light.id, directorLightType: light.type }}
      width={light.width ?? 2}
    />
  );
}

/** Renders all visible Director lights in the scene, assigning shadow-casting capability to eligible lights. */
export function DirectorSceneLighting({
  lights,
  shadowsEnabled,
  shadowMapSize,
}: {
  lights: DirectorLight[];
  shadowsEnabled: boolean;
  shadowMapSize: number;
}) {
  const shadowCastingLightIds = useMemo(
    () => new Set(getDirectorShadowCastingLightIds(lights, shadowsEnabled)),
    [lights, shadowsEnabled],
  );
  const layeredDirectionalLightId = useMemo(
    () => lights.find((light) => light.type === "directional" && shadowCastingLightIds.has(light.id))?.id ?? null,
    [lights, shadowCastingLightIds],
  );

  return (
    <>
      {lights
        .filter((light) => light.visible)
        .map((light) => {
          if (light.type === "ambient") {
            return (
              <ambientLight
                key={light.id}
                color={light.color}
                intensity={light.intensity}
                name={`director-light-${light.id}`}
                userData={{ directorLightId: light.id, directorLightType: light.type }}
              />
            );
          }
          if (light.type === "hemisphere") {
            return (
              <hemisphereLight
                key={light.id}
                color={light.color}
                groundColor={light.groundColor ?? "#303744"}
                intensity={light.intensity}
                name={`director-light-${light.id}`}
                position={light.position ?? [0, 5, 0]}
                userData={{ directorLightId: light.id, directorLightType: light.type }}
              />
            );
          }
          if (light.type === "directional") {
            return (
              <TargetedDirectionalLight
                key={light.id}
                layeredDynamicShadow={light.id === layeredDirectionalLightId}
                light={{ ...light, castShadow: shadowCastingLightIds.has(light.id) }}
                shadowMapSize={shadowMapSize}
              />
            );
          }
          if (light.type === "point") {
            return (
              <pointLight
                key={light.id}
                castShadow={shadowCastingLightIds.has(light.id)}
                color={light.color}
                decay={light.decay ?? 2}
                distance={light.distance ?? 0}
                intensity={light.intensity}
                name={`director-light-${light.id}`}
                position={light.position ?? [0, 3, 0]}
                shadow-mapSize-height={shadowMapSize}
                shadow-mapSize-width={shadowMapSize}
                userData={{ directorLightId: light.id, directorLightType: light.type }}
              />
            );
          }
          if (light.type === "spot") {
            return (
              <TargetedSpotLight
                key={light.id}
                light={{ ...light, castShadow: shadowCastingLightIds.has(light.id) }}
                shadowMapSize={shadowMapSize}
              />
            );
          }
          return <TargetedRectAreaLight key={light.id} light={light} />;
        })}
    </>
  );
}

/** Applies fog to the scene based on Director fog settings, supporting linear and exponential modes. */
export function DirectorSceneFog({ fog }: { fog?: DirectorFogSettings }) {
  if (!fog?.enabled) return null;
  if (fog.mode === "exponential") return <fogExp2 attach="fog" args={[fog.color, fog.density]} />;
  return <fog attach="fog" args={[fog.color, fog.near, fog.far]} />;
}
