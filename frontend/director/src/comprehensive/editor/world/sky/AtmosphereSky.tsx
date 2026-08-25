import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BackSide,
  ClampToEdgeWrapping,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { evaluateWorldTimeOfDayHours } from "../worldTime";
import {
  ATMOSPHERE_LUT_HEIGHT,
  ATMOSPHERE_LUT_WIDTH,
  packAtmosphereLutRgba,
  type AtmosphereSolution,
} from "./atmosphere";
import { ATMOSPHERE_SKY_FRAGMENT_SHADER, ATMOSPHERE_SKY_VERTEX_SHADER } from "./atmosphereSkyShaders";
import { evaluateSkyWeatherMood } from "./skyWeather";
import { evaluateSkyAtmosphere, evaluateSkyLighting, getSolarDirectionForHours } from "./solar";

const SKY_BOX_EXTENT = 4200;
const ATMOSPHERE_SKY_RENDER_ORDER = -1000;

/** CPU LUT row 0 is the zenith; Three must not flip it on upload. */
export const ATMOSPHERE_LUT_FLIP_Y = false;

/**
 * The CPU bake stores physical radiance (noon zenith ≈ 0.1). ACES of that
 * value is a gray void; this gain matches the LUT to a display-referred sky
 * and to MeshStandardMaterial IBL without a second AgX pass.
 */
export const ATMOSPHERE_GPU_EXPOSURE = 4;

/** Sky IBL strength on authored PBR. Below a full HDRI so gold roofs hold. */
export const ATMOSPHERE_ENVIRONMENT_INTENSITY = 0.55;

/** Film sets do not get a default alpine matte. */
export function atmosphereSkyRidgeAmplitude(): number {
  return 0;
}

/** Shader wisps follow authored cover only — never a leftover haze floor. */
export function atmosphereSkyCloudAmount(cloudCover: number): number {
  return Math.min(1, Math.max(0, cloudCover));
}

function uploadLut(texture: DataTexture, solution: AtmosphereSolution) {
  const data = texture.image.data as Float32Array;
  packAtmosphereLutRgba(solution.lut, data, ATMOSPHERE_GPU_EXPOSURE);
  texture.needsUpdate = true;
}

/** Bake the first LUT into the texture so IBL is never a black map on mount. */
export function createAtmosphereEnvironmentTexture(solution: AtmosphereSolution) {
  const texture = new DataTexture(
    new Float32Array(ATMOSPHERE_LUT_WIDTH * ATMOSPHERE_LUT_HEIGHT * 4),
    ATMOSPHERE_LUT_WIDTH,
    ATMOSPHERE_LUT_HEIGHT,
    RGBAFormat,
    FloatType,
  );
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = ATMOSPHERE_LUT_FLIP_Y;
  texture.userData.directorAtmosphereEnvironment = true;
  uploadLut(texture, solution);
  return texture;
}

export function AtmosphereSky({ context }: { context: LivingWorldFrameContext }) {
  const materialRef = useRef<ShaderMaterial>(null);
  const lastSolutionRef = useRef<AtmosphereSolution | null>(null);
  const sunDir = useMemo(() => new Vector3(), []);
  const sunColor = useMemo(() => new Vector3(1, 1, 1), []);
  const windDir = useMemo(() => new Vector2(0, 1), []);
  const { scene } = useThree();
  const { settings } = context;
  const lutTexture = useMemo(() => {
    const solution = evaluateSkyAtmosphere(settings, context.worldSeconds);
    lastSolutionRef.current = solution;
    return createAtmosphereEnvironmentTexture(solution);
    // First bake only; later sun/weather changes rewrite the same texture in sync().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uniforms = useMemo(
    () => ({
      skyLUT: { value: lutTexture },
      sunDir: { value: sunDir },
      sunColor: { value: sunColor },
      sunIntensity: { value: 1 },
      cloudAmount: { value: 0 },
      cloudDarken: { value: 1 },
      time: { value: 0 },
      windDir: { value: windDir },
    }),
    [lutTexture, sunColor, sunDir, windDir],
  );

  const sync = (seconds: number) => {
    const lighting = evaluateSkyLighting(settings, seconds);
    const solution = evaluateSkyAtmosphere(settings, seconds);
    if (lastSolutionRef.current !== solution) {
      uploadLut(lutTexture, solution);
      lastSolutionRef.current = solution;
    }
    const material = materialRef.current;
    if (!material) return;
    const hours = evaluateWorldTimeOfDayHours(settings.timeOfDay, seconds);
    const trueSun = getSolarDirectionForHours(hours);
    sunDir.set(trueSun[0], trueSun[1], trueSun[2]);
    sunColor.set(solution.sunColor[0], solution.sunColor[1], solution.sunColor[2]);
    material.uniforms.sunIntensity.value = Math.max(lighting.sunIntensity, 0.08);
    // Shader clouds follow the preset-floored effective cover: an overcast
    // or storm sky closes its deck even at a low authored cover slider.
    const mood = evaluateSkyWeatherMood(settings.weather);
    material.uniforms.cloudAmount.value = atmosphereSkyCloudAmount(mood.effectiveCloudCover);
    material.uniforms.cloudDarken.value = mood.cloudShaderDarkening;
    material.uniforms.time.value = seconds;
    const windRadians = (settings.wind.directionDegrees * Math.PI) / 180;
    windDir.set(Math.sin(windRadians), Math.cos(windRadians));
    if (scene.environment !== lutTexture) scene.environment = lutTexture;
    scene.environmentIntensity = ATMOSPHERE_ENVIRONMENT_INTENSITY;
  };

  useLayoutEffect(() => {
    sync(context.worldSeconds);
    return () => {
      if (scene.environment === lutTexture) scene.environment = null;
      lutTexture.dispose();
    };
  }, [lutTexture, scene]);

  useFrame(() => {
    sync(context.worldSeconds);
  });

  return (
    <mesh
      frustumCulled={false}
      name="living-world-atmosphere-sky"
      renderOrder={ATMOSPHERE_SKY_RENDER_ORDER}
      scale={[SKY_BOX_EXTENT, SKY_BOX_EXTENT, SKY_BOX_EXTENT]}
    >
      <boxGeometry args={[1, 1, 1]} />
      <shaderMaterial
        ref={materialRef}
        lights={false}
        depthTest
        depthWrite={false}
        fog={false}
        fragmentShader={ATMOSPHERE_SKY_FRAGMENT_SHADER}
        side={BackSide}
        toneMapped
        transparent={false}
        uniforms={uniforms}
        vertexShader={ATMOSPHERE_SKY_VERTEX_SHADER}
      />
    </mesh>
  );
}
