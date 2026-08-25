import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  type IUniform,
  type Mesh,
  type PointLight,
  type Texture,
} from "three";
import type {
  DirectorWorldEffect,
  WorldEffectKind,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import type { EffectsLayerProps, LivingWorldFrameContext } from "../livingWorldContracts";
import {
  getEffectParticleCount,
  getEffectRenderPasses,
  getWindTurbulenceMultiplier,
  type EffectRenderPassSpec,
} from "./effectPresets";
import {
  buildEffectSystemConfig,
  buildParticleIndexArray,
  buildWeatherSystemConfig,
  getEffectSystemSeedHash,
  type EffectSystemConfig,
} from "./effectSystemConfig";
import { buildEffectShaderSource } from "./effectShaders";
import {
  FIRE_LIGHT_COLOR,
  FIRE_SHADOW_BIAS,
  FIRE_SHADOW_CAMERA_NEAR,
  FIRE_SHADOW_MAP_SIZE,
  computeFireLightState,
  selectFireLightEffects,
  selectShadowCastingFireId,
  type FireLightEnvironment,
} from "./fireLights";
import { evaluateFireBurnFactor } from "./fireSystem";
import { evaluateEffectsSceneLighting, type EffectsSceneLighting } from "./sceneLighting";
import { getSoftParticleTexture } from "./softParticleTexture";
import {
  acquireWorldHeightMap,
  bindWorldHeightMapUniforms,
  createWorldHeightMapSampleUniforms,
  releaseWorldHeightMap,
  type WorldHeightMap,
} from "../surface/worldHeightMap";

/**
 * Effects sub-layer: stateless analytic GPU particles.
 *
 * One instanced unit quad per active effect; every particle is evaluated in
 * the vertex shader from (uSeed, aParticleIndex, uTime), so the layer renders
 * correctly for a single invalidated frame with no accumulated state —
 * per-frame CPU work is uniform writes only. Most kinds draw one pass; fire
 * draws the shared geometry twice (occluding body + additive glow, see
 * `getEffectRenderPasses`), with both materials sharing ONE uniforms object.
 *
 * Uniforms are mutated in the render loop and immediately before each draw.
 * React render also performs the initial write for deterministic direct
 * captures, but ambient animation never needs React reconciliation.
 *
 * Camera-following precipitation is the exception: its uOrigin is written in
 * `Object3D.onBeforeRender`, NOT in useFrame. Offscreen shot capture and the
 * PiP camera preview render through temporary cameras via direct
 * `gl.render(scene, camera)` calls without a frameloop tick, so a useFrame
 * writer would leave the rain volume parked at the last viewport camera
 * position. onBeforeRender receives the camera actually rendering each draw,
 * which keeps the volume centred for every consumer. Camera state is
 * deterministic per exported frame, so determinism holds.
 */

/**
 * Draw after opaque scene and default-order transparents (e.g. water).
 * Fire's glow pass draws at base + 1 (see FIRE_RENDER_PASSES), so weather
 * stays on top of every effect pass.
 */
const EFFECT_RENDER_ORDER = 20;
const WEATHER_RENDER_ORDER = 22;

/** Particles are visual-only; keep editor picking rays from hitting them. */
const disableRaycast: Mesh["raycast"] = () => undefined;

interface EffectParticleUniforms {
  [name: string]: IUniform;
  uTime: IUniform<number>;
  uSeed: IUniform<Vector2>;
  uOrigin: IUniform<Vector3>;
  uIntensity: IUniform<number>;
  uSizeScale: IUniform<number>;
  uSpeedScale: IUniform<number>;
  /** MEAN wind velocity x windInfluence; gusts are integrated in-shader. */
  uWind: IUniform<Vector3>;
  /** Wind gustiness (0-1); drives the closed-form gust integral. */
  uGustiness: IUniform<number>;
  uEmitterMode: IUniform<number>;
  uEmitterExtents: IUniform<Vector3>;
  uLifetime: IUniform<Vector2>;
  uVelocityBase: IUniform<Vector3>;
  uVelocitySpread: IUniform<Vector3>;
  uGravity: IUniform<Vector3>;
  uTurbulence: IUniform<number>;
  uTurbFrequency: IUniform<Vector2>;
  uSize: IUniform<Vector2>;
  uSpin: IUniform<number>;
  uStretch: IUniform<number>;
  /** Max upright wobble (rad) for directional sprites; 0 = free rotation. */
  uUpright: IUniform<number>;
  uPulse: IUniform<number>;
  /** Fraction of particles rendered as ground splash rings (weather rain). */
  uSplash: IUniform<number>;
  /** Splash plane height (project space) for the ripple sub-mode. */
  uGroundY: IUniform<number>;
  /** Fire weather suppression factor (1 = dry burn); see fireSystem.ts. */
  uBurn: IUniform<number>;
  uWrapExtents: IUniform<Vector3>;
  uTint: IUniform<Vector3>;
  uTintFlag: IUniform<number>;
  /**
   * Scene-light tint (chromaticity x normalized level) from the CPU solar
   * model; only the scattering-lit shader variants read them. uNightBoost is
   * the firefly emission multiplier (day 0.35 → night 1).
   */
  uSceneLightColor: IUniform<Vector3>;
  uSceneLightLevel: IUniform<number>;
  uNightBoost: IUniform<number>;
  uMap: IUniform<Texture>;
  /** Scene-fog uniforms (three defaults); the renderer refreshes them when `material.fog` is set. */
  fogColor: IUniform<Color>;
  fogDensity: IUniform<number>;
  fogNear: IUniform<number>;
  fogFar: IUniform<number>;
  uOcclusionMap: IUniform<Texture | null>;
  uOcclusionOrigin: IUniform<Vector3>;
  uOcclusionSize: IUniform<number>;
  uOcclusionBlend: IUniform<number>;
}

const QUAD_POSITIONS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

function createParticleGeometry(count: number): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(QUAD_INDEX);
  geometry.setAttribute("position", new Float32BufferAttribute(QUAD_POSITIONS, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(QUAD_UVS, 2));
  geometry.setAttribute("aParticleIndex", new InstancedBufferAttribute(buildParticleIndexArray(count), 1));
  geometry.instanceCount = count;
  return geometry;
}

interface EffectMaterialSet {
  passes: readonly EffectRenderPassSpec[];
  /** One material per pass, all sharing the single `uniforms` object. */
  materials: ShaderMaterial[];
  uniforms: EffectParticleUniforms;
}

function createEffectMaterialSet(kind: WorldEffectKind): EffectMaterialSet {
  const uniforms: EffectParticleUniforms = {
    uTime: { value: 0 },
    uSeed: { value: new Vector2() },
    uOrigin: { value: new Vector3() },
    uIntensity: { value: 1 },
    uSizeScale: { value: 1 },
    uSpeedScale: { value: 1 },
    uWind: { value: new Vector3() },
    uGustiness: { value: 0 },
    uEmitterMode: { value: 0 },
    uEmitterExtents: { value: new Vector3(0.1, 0.1, 0.1) },
    uLifetime: { value: new Vector2(1, 2) },
    uVelocityBase: { value: new Vector3() },
    uVelocitySpread: { value: new Vector3() },
    uGravity: { value: new Vector3() },
    uTurbulence: { value: 0 },
    uTurbFrequency: { value: new Vector2() },
    uSize: { value: new Vector2(0.1, 0.1) },
    uSpin: { value: 0 },
    uStretch: { value: 0 },
    uUpright: { value: 0 },
    uPulse: { value: 0 },
    uSplash: { value: 0 },
    uGroundY: { value: 0 },
    uBurn: { value: 1 },
    uWrapExtents: { value: new Vector3() },
    uTint: { value: new Vector3(1, 1, 1) },
    uTintFlag: { value: 0 },
    uSceneLightColor: { value: new Vector3(1, 1, 1) },
    uSceneLightLevel: { value: 1 },
    uNightBoost: { value: 1 },
    uMap: { value: getSoftParticleTexture() },
    fogColor: { value: new Color(0xffffff) },
    fogDensity: { value: 0.00025 },
    fogNear: { value: 1 },
    fogFar: { value: 2000 },
    ...createWorldHeightMapSampleUniforms(),
  };
  const passes = getEffectRenderPasses(kind);
  const materials = passes.map((pass) => {
    const source = buildEffectShaderSource(kind, pass.id);
    return new ShaderMaterial({
      uniforms,
      vertexShader: source.vertexShader,
      fragmentShader: source.fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: pass.blending === "additive" ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      // Opt-in scene fog: three compiles USE_FOG and refreshes the fog
      // uniforms only when this is set AND the scene carries a fog.
      fog: pass.sceneFog,
    });
  });
  return { passes, materials, uniforms };
}

/** Mutation-only uniform sync; no allocations, safe to run every render. */
function writeParticleUniforms(
  uniforms: EffectParticleUniforms,
  config: EffectSystemConfig,
  context: LivingWorldFrameContext,
  lighting: EffectsSceneLighting,
  origin: readonly [number, number, number] | null,
): void {
  const preset = config.preset;
  uniforms.uTime.value = context.worldSeconds;
  uniforms.uSeed.value.set(config.seed[0], config.seed[1]);
  if (origin) uniforms.uOrigin.value.set(origin[0], origin[1], origin[2]);
  // Fire-family systems couple to the weather: rain smothers flames and
  // embers via the pure burn factor (see fireSystem.ts). Particle COUNT
  // stays fixed so geometry never reallocates on a weather change; alpha
  // (uIntensity) and sprite size carry the visible suppression.
  const fireFamily = config.kind === "fire" || config.kind === "sparks";
  const burn = fireFamily ? evaluateFireBurnFactor(context.settings.weather, config.seedHash, context.worldSeconds) : 1;
  uniforms.uBurn.value = burn;
  uniforms.uIntensity.value = config.intensity * burn;
  uniforms.uSizeScale.value = config.kind === "fire" ? config.sizeScale * (0.55 + 0.45 * burn) : config.sizeScale;
  uniforms.uSpeedScale.value = config.speedScale;
  // uWind carries the MEAN wind (gusts integrate in-shader in closed form,
  // so a gust bends new trajectory segments without teleporting old ones).
  const wind = context.settings.wind;
  const windRadians = (wind.directionDegrees * Math.PI) / 180;
  const meanWind = wind.speedMps * config.windInfluence;
  uniforms.uWind.value.set(Math.sin(windRadians) * meanWind, 0, Math.cos(windRadians) * meanWind);
  uniforms.uGustiness.value = wind.gustiness;
  uniforms.uEmitterMode.value = config.emitter.mode;
  uniforms.uEmitterExtents.value.set(config.emitter.extents[0], config.emitter.extents[1], config.emitter.extents[2]);
  uniforms.uLifetime.value.set(preset.lifetimeSeconds[0], preset.lifetimeSeconds[1]);
  uniforms.uVelocityBase.value.set(preset.velocityBase[0], preset.velocityBase[1], preset.velocityBase[2]);
  uniforms.uVelocitySpread.value.set(preset.velocitySpread[0], preset.velocitySpread[1], preset.velocitySpread[2]);
  uniforms.uGravity.value.set(preset.gravity[0], preset.gravity[1], preset.gravity[2]);
  // Gusty wind shakes wind-coupled media (smoke, dust, snow) harder.
  const windSpeedNow = Math.hypot(context.windVector[0], context.windVector[2]);
  uniforms.uTurbulence.value =
    preset.turbulence * getWindTurbulenceMultiplier(wind.turbulence, windSpeedNow, config.windInfluence);
  uniforms.uTurbFrequency.value.set(preset.turbulenceFrequency[0], preset.turbulenceFrequency[1]);
  uniforms.uSize.value.set(preset.sizeRange[0], preset.sizeRange[1]);
  uniforms.uSpin.value = preset.spinRadPerSec;
  uniforms.uStretch.value = preset.velocityStretch;
  uniforms.uUpright.value = preset.uprightWobbleRad;
  uniforms.uPulse.value = preset.pulseHz;
  uniforms.uSplash.value = config.splashFraction;
  uniforms.uGroundY.value = context.groundHeight;
  if (config.wrapExtents) {
    uniforms.uWrapExtents.value.set(config.wrapExtents[0], config.wrapExtents[1], config.wrapExtents[2]);
  } else {
    uniforms.uWrapExtents.value.set(0, 0, 0);
  }
  if (config.tint) {
    uniforms.uTint.value.set(config.tint[0], config.tint[1], config.tint[2]);
    uniforms.uTintFlag.value = 1;
  } else {
    uniforms.uTintFlag.value = 0;
  }
  // Written for every kind; only the lit/firefly shader variants declare and
  // read the matching uniforms, the rest silently ignore the extra entries.
  uniforms.uSceneLightColor.value.set(lighting.tintColor[0], lighting.tintColor[1], lighting.tintColor[2]);
  uniforms.uSceneLightLevel.value = lighting.tintLevel;
  uniforms.uNightBoost.value = lighting.fireflyNightBoost;
}

/** Object3D.onBeforeRender default is a no-op; restore it on cleanup. */
const noopOnBeforeRender: Mesh["onBeforeRender"] = () => undefined;

function ParticlePassMesh({
  context,
  followCamera,
  geometry,
  material,
  name,
  renderOrder,
  syncUniforms,
  uniforms,
}: {
  context: LivingWorldFrameContext;
  followCamera: boolean;
  geometry: InstancedBufferGeometry;
  material: ShaderMaterial;
  name: string;
  renderOrder: number;
  syncUniforms: () => void;
  uniforms: EffectParticleUniforms;
}) {
  const meshRef = useRef<Mesh>(null);
  const cameraScratch = useMemo(() => new Vector3(), []);
  const heightMapRef = useRef<WorldHeightMap | null>(null);

  useEffect(() => {
    if (!followCamera) return undefined;
    const map = acquireWorldHeightMap();
    heightMapRef.current = map;
    return () => {
      heightMapRef.current = null;
      releaseWorldHeightMap();
    };
  }, [followCamera]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return undefined;
    mesh.onBeforeRender = (renderer, scene, camera) => {
      syncUniforms();
      if (!followCamera) return;
      // Camera-followed uOrigin must use the camera ACTUALLY rendering
      // (viewport, PiP preview, or offscreen capture).
      cameraScratch.setFromMatrixPosition(camera.matrixWorld);
      // Convert to project space in case the scene root carries a transform;
      // matrixWorld is fresh here (renderer updates world matrices first).
      mesh.worldToLocal(cameraScratch);
      uniforms.uOrigin.value.copy(cameraScratch);
      const map = heightMapRef.current;
      if (map) {
        map.handleBeforeRender(renderer, scene, camera, context.worldSeconds);
        bindWorldHeightMapUniforms(uniforms, map);
      }
    };
    return () => {
      mesh.onBeforeRender = noopOnBeforeRender;
    };
  }, [cameraScratch, context, followCamera, syncUniforms, uniforms]);

  return (
    <mesh
      ref={meshRef}
      frustumCulled={false}
      geometry={geometry}
      material={material}
      name={name}
      raycast={disableRaycast}
      renderOrder={renderOrder}
    />
  );
}

function ParticleSystemMesh({
  config,
  context,
  getLighting,
  origin,
  renderOrder,
}: {
  config: EffectSystemConfig;
  context: LivingWorldFrameContext;
  getLighting: () => EffectsSceneLighting;
  /** null = follow the render camera (weather precipitation). */
  origin: readonly [number, number, number] | null;
  renderOrder: number;
}) {
  const geometry = useMemo(() => createParticleGeometry(config.count), [config.count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const { passes, materials, uniforms } = useMemo(() => createEffectMaterialSet(config.kind), [config.kind]);
  useEffect(() => () => materials.forEach((material) => material.dispose()), [materials]);

  const syncUniforms = useCallback(() => {
    writeParticleUniforms(uniforms, config, context, getLighting(), origin);
  }, [config, context, getLighting, origin, uniforms]);
  syncUniforms();
  useFrame(syncUniforms);

  const followCamera = origin === null;
  return (
    <>
      {passes.map((pass, index) => (
        <ParticlePassMesh
          key={pass.id}
          context={context}
          followCamera={followCamera}
          geometry={geometry}
          material={materials[index]}
          name={pass.id === "main" ? `world-effect-${config.id}` : `world-effect-${config.id}-${pass.id}`}
          renderOrder={renderOrder + pass.renderOrderOffset}
          syncUniforms={syncUniforms}
          uniforms={uniforms}
        />
      ))}
    </>
  );
}

function WorldEffectParticles({
  context,
  effect,
  getLighting,
  origin,
}: {
  context: LivingWorldFrameContext;
  effect: DirectorWorldEffect;
  getLighting: () => EffectsSceneLighting;
  origin: readonly [number, number, number];
}) {
  const config = useMemo(() => buildEffectSystemConfig(effect, context.seed), [effect, context.seed]);
  if (config.count <= 0) return null;
  return (
    <ParticleSystemMesh
      config={config}
      context={context}
      getLighting={getLighting}
      origin={origin}
      renderOrder={EFFECT_RENDER_ORDER}
    />
  );
}

function WeatherPrecipitation({
  context,
  getLighting,
}: {
  context: LivingWorldFrameContext;
  getLighting: () => EffectsSceneLighting;
}) {
  const config = useMemo(
    () => buildWeatherSystemConfig(context.settings.weather, context.seed),
    [context.settings.weather, context.seed],
  );
  if (!config) return null;
  return (
    <ParticleSystemMesh
      config={config}
      context={context}
      getLighting={getLighting}
      origin={null}
      renderOrder={WEATHER_RENDER_ORDER}
    />
  );
}

/**
 * Per-frame fire light environment: burn suppression from the weather block
 * plus the evaluated wind speed for gutter deepening. Pure per frame — both
 * inputs are deterministic functions of (settings, worldSeconds).
 */
function getFireLightEnvironment(effect: DirectorWorldEffect, context: LivingWorldFrameContext): FireLightEnvironment {
  const seedHash = getEffectSystemSeedHash(context.seed, effect.seedOffset, effect.id);
  return {
    burnFactor: evaluateFireBurnFactor(context.settings.weather, seedHash, context.worldSeconds),
    windSpeedMps: Math.hypot(context.windVector[0], context.windVector[2]),
  };
}

function FireEffectLight({
  castShadow,
  context,
  effect,
  origin,
}: {
  /** True only for the single budgeted caster (see selectShadowCastingFireId). */
  castShadow: boolean;
  context: LivingWorldFrameContext;
  effect: DirectorWorldEffect;
  origin: readonly [number, number, number];
}) {
  const state = computeFireLightState(effect, context.seed, context.worldSeconds, getFireLightEnvironment(effect, context));
  const lightRef = useRef<PointLight>(null);
  useFrame(() => {
    const light = lightRef.current;
    if (!light) return;
    light.intensity = computeFireLightState(
      effect,
      context.seed,
      context.worldSeconds,
      getFireLightEnvironment(effect, context),
    ).intensity;
  });
  // Shadow props are set unconditionally (every PointLight owns a shadow
  // object); only castShadow gates the six-face cube render, and the flag
  // itself stays inert unless the renderer enables shadow maps. The far
  // plane matches the light cutoff (constant per effect), so the shadow
  // volume never outlives the light's reach.
  return (
    <pointLight
      ref={lightRef}
      castShadow={castShadow}
      color={FIRE_LIGHT_COLOR}
      decay={2}
      distance={state.distance}
      intensity={state.intensity}
      name={`world-effect-light-${effect.id}`}
      position={[origin[0], origin[1] + state.offsetY, origin[2]]}
      shadow-bias={FIRE_SHADOW_BIAS}
      shadow-camera-far={state.distance}
      shadow-camera-near={FIRE_SHADOW_CAMERA_NEAR}
      shadow-mapSize={[FIRE_SHADOW_MAP_SIZE, FIRE_SHADOW_MAP_SIZE]}
    />
  );
}

export default function EffectsLayer({ context, effects }: EffectsLayerProps) {
  const invalidate = useThree((state) => state.invalidate);

  // Demand-frameloop safety net: uniform mutation is invisible to R3F, so a
  // pure time scrub with an otherwise static scene must still repaint.
  useEffect(() => {
    invalidate();
  });

  const activeEffects = useMemo(
    () => effects.filter((entry) => getEffectParticleCount(entry.effect.kind, entry.effect.intensity) > 0),
    [effects],
  );
  const fireLights = useMemo(() => selectFireLightEffects(effects), [effects]);
  const shadowFireId = useMemo(() => selectShadowCastingFireId(effects), [effects]);
  const lightingCacheRef = useRef({
    lighting: evaluateEffectsSceneLighting(context.settings, context.worldSeconds),
    settings: context.settings,
    worldSeconds: context.worldSeconds,
  });
  // One solar evaluation per frame, lazily shared by every particle pass.
  const getLighting = useCallback(() => {
    const cache = lightingCacheRef.current;
    if (cache.settings !== context.settings || cache.worldSeconds !== context.worldSeconds) {
      cache.settings = context.settings;
      cache.worldSeconds = context.worldSeconds;
      cache.lighting = evaluateEffectsSceneLighting(context.settings, context.worldSeconds);
    }
    return cache.lighting;
  }, [context]);

  return (
    <group name="living-world-effects">
      {activeEffects.map((entry) => (
        <WorldEffectParticles
          key={entry.effect.id}
          context={context}
          effect={entry.effect}
          getLighting={getLighting}
          origin={entry.origin}
        />
      ))}
      {fireLights.map((entry) => (
        <FireEffectLight
          key={entry.effect.id}
          castShadow={entry.effect.id === shadowFireId}
          context={context}
          effect={entry.effect}
          origin={entry.origin}
        />
      ))}
      <WeatherPrecipitation context={context} getLighting={getLighting} />
    </group>
  );
}
