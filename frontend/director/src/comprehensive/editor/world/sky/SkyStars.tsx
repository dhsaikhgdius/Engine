import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Points, ShaderMaterial } from "three";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { createStarFieldPositions, createStarFieldTwinkleAttributes, STAR_FIELD_COUNT } from "./starField";
import { evaluateSkyLighting } from "./solar";

/**
 * Twinkling star dome.
 *
 * Star placement and per-star twinkle parameters are seeded on the CPU from
 * integer-hash streams (see starField.ts); the vertex shader only evaluates
 * `sin(phase + speed * worldSeconds)` against those baked attributes, so the
 * dome is a pure function of `(seed, settings, worldSeconds)` — no wall
 * clock, no fract(sin) shader noise. Overall opacity follows the solar
 * elevation and weather via `evaluateSkyLighting`, which already hides stars
 * at noon and under heavy cloud cover.
 */

/** Below the sun sprites (2/3) and clouds (4). */
const SKY_STARS_RENDER_ORDER = 0;

/** Point size of the brightest star, in pixels (size attenuation off). */
const STAR_BASE_POINT_SIZE = 2.6;

/** Stars fade fully below this opacity; skip the draw entirely. */
export const SKY_STARS_MIN_VISIBLE_OPACITY = 0.02;

const STAR_VERTEX_SHADER = /* glsl */ `
  attribute float aTwinklePhase;
  attribute float aTwinkleSpeed;
  attribute float aTwinkleAmount;
  attribute float aStarBrightness;

  uniform float uTime;
  uniform float uSize;

  varying float vIntensity;

  void main() {
    // CPU twin: evaluateStarTwinkle in starField.ts. Keep in sync.
    float twinkle = 1.0 - aTwinkleAmount * (0.5 + 0.5 * sin(aTwinklePhase + aTwinkleSpeed * uTime));
    vIntensity = aStarBrightness * twinkle;
    gl_PointSize = uSize * (0.6 + 0.55 * aStarBrightness);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vIntensity;

  void main() {
    float radial = length(gl_PointCoord - vec2(0.5));
    float mask = smoothstep(0.5, 0.16, radial);
    float alpha = mask * vIntensity * uOpacity;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

export interface SkyStarsProps {
  context: LivingWorldFrameContext;
}

export default function SkyStars({ context }: SkyStarsProps) {
  const { seed, settings } = context;
  const pointsRef = useRef<Points>(null);

  const geometry = useMemo(() => {
    const starGeometry = new BufferGeometry();
    starGeometry.setAttribute("position", new BufferAttribute(createStarFieldPositions(seed), 3));
    const twinkle = createStarFieldTwinkleAttributes(seed, STAR_FIELD_COUNT);
    starGeometry.setAttribute("aTwinklePhase", new BufferAttribute(twinkle.phase, 1));
    starGeometry.setAttribute("aTwinkleSpeed", new BufferAttribute(twinkle.speed, 1));
    starGeometry.setAttribute("aTwinkleAmount", new BufferAttribute(twinkle.amount, 1));
    starGeometry.setAttribute("aStarBrightness", new BufferAttribute(twinkle.brightness, 1));
    return starGeometry;
  }, [seed]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        blending: AdditiveBlending,
        depthWrite: false,
        fragmentShader: STAR_FRAGMENT_SHADER,
        transparent: true,
        uniforms: {
          uColor: { value: new Color("#dfe8ff") },
          uOpacity: { value: 0 },
          uSize: { value: STAR_BASE_POINT_SIZE },
          uTime: { value: 0 },
        },
        vertexShader: STAR_VERTEX_SHADER,
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

  const syncStarFrame = () => {
    const lighting = evaluateSkyLighting(settings, context.worldSeconds);
    material.uniforms.uOpacity.value = lighting.starsOpacity;
    material.uniforms.uTime.value = context.worldSeconds;
    if (pointsRef.current) pointsRef.current.visible = lighting.starsOpacity > SKY_STARS_MIN_VISIBLE_OPACITY;
  };

  useLayoutEffect(() => {
    syncStarFrame();
  });
  useFrame(syncStarFrame);

  return (
    <points
      args={[geometry, material]}
      frustumCulled={false}
      name="living-world-stars"
      ref={pointsRef}
      renderOrder={SKY_STARS_RENDER_ORDER}
    />
  );
}
