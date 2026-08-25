import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  Color,
  InstancedBufferAttribute,
  Matrix4,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  type InstancedMesh,
  type Mesh,
} from "three";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import {
  createSkyCloudPlacements,
  getSkyCloudDriftRadians,
  getSkyCloudPalette,
  getSkyCloudPosition,
  SKY_CLOUD_MAX_QUAD_COUNT,
} from "./cloudField";
import { getCloudSpriteTexture } from "./skySpriteTextures";
import { evaluateSkyWeatherMood } from "./skyWeather";
import { evaluateSkyLighting } from "./solar";

/**
 * Instanced billboard clouds on the sky dome shell.
 *
 * One InstancedMesh renders every cloud quad; the vertex shader turns each
 * instance into a cylindrical billboard (rotating around +Y only, so cloud
 * bases stay level while always facing the camera). Placement, drift, and
 * shading all come from the pure cloudField module, keeping this component a
 * thin deterministic view of `(seed, settings, worldSeconds)`.
 */

/** Above stars (0) and the sun sprites (2/3), well below precipitation (22). */
const SKY_CLOUDS_RENDER_ORDER = 4;

/** Base opacity of a full-weight quad; per-quad weights scale it down. */
export const SKY_CLOUD_BASE_OPACITY = 0.42;

/** Hard ceiling after the weather opacity scale, so decks never go opaque-white. */
export const SKY_CLOUD_MAX_OPACITY = 0.92;

/**
 * Drift is quantized into buckets so instance matrices are rewritten a few
 * times per second instead of every frame. At the worst-case 40 m/s wind a
 * bucket step moves a far-shell quad ~1.3 m — invisible at 800 m+ distances —
 * and the bucket index stays a pure function of `worldSeconds`.
 */
const SKY_CLOUD_DRIFT_BUCKET_SECONDS = 0.25;

/** Vertical squash of each quad: wider than tall reads as a cloud bank. */
const SKY_CLOUD_QUAD_ASPECT = 0.58;

/** Clouds are visual-only; keep editor picking rays from hitting them. */
const disableRaycast: Mesh["raycast"] = () => undefined;

const scratchMatrix = new Matrix4();

const CLOUD_VERTEX_SHADER = /* glsl */ `
  attribute float aCloudWeight;

  varying vec2 vUv;
  varying float vWeight;

  void main() {
    vUv = uv;
    vWeight = aCloudWeight;
    vec3 anchor = vec3(0.0);
    vec2 quadScale = vec2(1.0);
    #ifdef USE_INSTANCING
      anchor = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      quadScale = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
    #endif
    vec3 worldAnchor = (modelMatrix * vec4(anchor, 1.0)).xyz;
    // Cylindrical billboard: face the camera in the horizontal plane only.
    vec3 toCamera = cameraPosition - worldAnchor;
    toCamera.y = 0.0;
    float planarDistance = length(toCamera);
    vec3 forward = planarDistance > 1e-4 ? toCamera / planarDistance : vec3(0.0, 0.0, 1.0);
    vec3 right = vec3(forward.z, 0.0, -forward.x);
    vec3 worldPosition = worldAnchor + right * (position.x * quadScale.x) + vec3(0.0, position.y * quadScale.y, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uTopColor;
  uniform vec3 uBottomColor;
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vWeight;

  void main() {
    float mask = texture2D(uMap, vUv).a;
    float alpha = mask * uOpacity * vWeight;
    if (alpha < 0.004) discard;
    // Two-tone vertical gradient: sunlit crowns over shaded bases.
    vec3 color = mix(uBottomColor, uTopColor, smoothstep(0.18, 0.85, vUv.y));
    gl_FragColor = vec4(color, alpha);
  }
`;

export interface SkyCloudsProps {
  context: LivingWorldFrameContext;
}

export default function SkyClouds({ context }: SkyCloudsProps) {
  const { seed, settings } = context;
  const meshRef = useRef<InstancedMesh>(null);
  const lastDriftSampleSecondsRef = useRef<number | null>(null);

  // Preset + intensity raise the effective cover, so an overcast or storm
  // sky fills with clusters even when the authored cover slider sits low.
  const mood = useMemo(
    () => evaluateSkyWeatherMood(settings.weather),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.weather.preset, settings.weather.intensity, settings.weather.cloudCover],
  );
  const quads = useMemo(
    () => createSkyCloudPlacements(seed, mood.effectiveCloudCover),
    [seed, mood.effectiveCloudCover],
  );

  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(1, 1);
    plane.setAttribute("aCloudWeight", new InstancedBufferAttribute(new Float32Array(SKY_CLOUD_MAX_QUAD_COUNT), 1));
    return plane;
  }, []);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        blending: NormalBlending,
        depthWrite: false,
        fragmentShader: CLOUD_FRAGMENT_SHADER,
        transparent: true,
        uniforms: {
          uBottomColor: { value: new Color(0.6, 0.66, 0.76) },
          uMap: { value: getCloudSpriteTexture() },
          uOpacity: { value: SKY_CLOUD_BASE_OPACITY },
          uTopColor: { value: new Color(1, 1, 1) },
        },
        vertexShader: CLOUD_VERTEX_SHADER,
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

  const syncCloudFrame = useCallback(
    (force = false) => {
      const palette = getSkyCloudPalette(evaluateSkyLighting(settings, context.worldSeconds), settings.weather);
      (material.uniforms.uTopColor.value as Color).setRGB(...palette.top);
      (material.uniforms.uBottomColor.value as Color).setRGB(...palette.bottom);
      material.uniforms.uOpacity.value = Math.min(SKY_CLOUD_MAX_OPACITY, SKY_CLOUD_BASE_OPACITY * mood.cloudOpacityScale);

      const driftSampleSeconds =
        Math.floor(context.worldSeconds / SKY_CLOUD_DRIFT_BUCKET_SECONDS) * SKY_CLOUD_DRIFT_BUCKET_SECONDS;
      if (!force && lastDriftSampleSecondsRef.current === driftSampleSeconds) return;
      lastDriftSampleSecondsRef.current = driftSampleSeconds;

      const mesh = meshRef.current;
      if (!mesh) return;
      const driftRadians = getSkyCloudDriftRadians(settings.wind, driftSampleSeconds);
      const weights = geometry.getAttribute("aCloudWeight") as InstancedBufferAttribute;
      quads.forEach((quad, index) => {
        const [x, y, z] = getSkyCloudPosition(quad, driftRadians);
        // Heavy weather widens each puff so clusters merge into banks.
        const size = quad.size * mood.cloudSizeScale;
        scratchMatrix.makeScale(size, size * SKY_CLOUD_QUAD_ASPECT, 1);
        scratchMatrix.setPosition(x, y, z);
        mesh.setMatrixAt(index, scratchMatrix);
        weights.setX(index, quad.opacityWeight);
      });
      mesh.count = quads.length;
      mesh.instanceMatrix.needsUpdate = true;
      weights.needsUpdate = true;
    },
    [context, geometry, material, mood, quads, settings],
  );

  // Palette stays live every frame; instance transforms remain bucketed at
  // four updates per second, independent of React render frequency.
  useLayoutEffect(() => {
    syncCloudFrame(true);
  }, [syncCloudFrame]);
  useFrame(() => syncCloudFrame());

  if (quads.length === 0) return null;

  return (
    <instancedMesh
      args={[geometry, material, SKY_CLOUD_MAX_QUAD_COUNT]}
      frustumCulled={false}
      name="living-world-clouds"
      raycast={disableRaycast}
      ref={meshRef}
      renderOrder={SKY_CLOUDS_RENDER_ORDER}
    />
  );
}
