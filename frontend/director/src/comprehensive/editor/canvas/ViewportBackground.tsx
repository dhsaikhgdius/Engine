/**
 * Viewport background rendering with panorama texture support (equirectangular or backdrop dome),
 * environment map configuration, and error fallback UI.
 *
 * @module viewport-background
 */

import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  EquirectangularReflectionMapping,
  LinearFilter,
  SRGBColorSpace,
  Texture,
  TextureLoader,
} from "three";
import type { DirectorAssetRef, PanoramaProjectionMode } from "../schema/directorProject";
import { getPanoramaRotationRadians } from "./panoramaMath";

type PanoramaTextureState =
  | { status: "idle" }
  | { status: "loading"; projectionMode: PanoramaProjectionMode; url: string }
  | { status: "ready"; projectionMode: PanoramaProjectionMode; texture: Texture; url: string }
  | { status: "error"; error: Error; projectionMode: PanoramaProjectionMode; url: string };

const DEFAULT_ENVIRONMENT_ROTATION: [number, number, number] = [0, 0, 0];

/** Configures a loaded panorama texture with the correct color space, mapping, and wrapping for the given projection mode. */
export function configurePanoramaTexture(texture: Texture, projectionMode: PanoramaProjectionMode = "equirectangular") {
  texture.colorSpace = SRGBColorSpace;
  if (projectionMode === "equirectangular") {
    texture.mapping = EquirectangularReflectionMapping;
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
  } else {
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.repeat.set(-1, 1);
    texture.offset.set(1, 0);
  }
  texture.needsUpdate = true;
  return texture;
}

function toTextureLoadError(error: unknown) {
  if (error instanceof Error) return error;
  return new Error("全景图纹理加载失败");
}

function usePanoramaTexture(url: string | null, projectionMode: PanoramaProjectionMode): PanoramaTextureState {
  const [state, setState] = useState<PanoramaTextureState>({ status: "idle" });

  useEffect(() => {
    if (!url) {
      setState({ status: "idle" });
      return undefined;
    }

    let cancelled = false;
    setState({ status: "loading", projectionMode, url });

    let texture: Texture | null = null;

    try {
      texture = new TextureLoader().load(
        url,
        (loadedTexture) => {
          if (cancelled) {
            loadedTexture.dispose();
            return;
          }

          setState({
            status: "ready",
            projectionMode,
            texture: configurePanoramaTexture(loadedTexture, projectionMode),
            url,
          });
        },
        undefined,
        (error) => {
          if (!cancelled) {
            setState({ status: "error", error: toTextureLoadError(error), projectionMode, url });
          }
        },
      );
    } catch (error) {
      setState({ status: "error", error: toTextureLoadError(error), projectionMode, url });
    }

    return () => {
      cancelled = true;
      texture?.dispose();
    };
  }, [projectionMode, url]);

  return state;
}

/** Sets the scene background color or panorama texture, manages environment maps, and renders a backdrop dome or error card. */
export function ViewportBackground({
  backgroundColor,
  environmentEnabled = false,
  environmentIntensity = 0.5,
  environmentRotation = DEFAULT_ENVIRONMENT_ROTATION,
  environmentUsePanorama = true,
  panoramaAsset,
  panoramaRadius,
  panoramaYaw,
}: {
  backgroundColor: string;
  environmentEnabled?: boolean;
  environmentIntensity?: number;
  environmentRotation?: [number, number, number];
  environmentUsePanorama?: boolean;
  panoramaAsset?: DirectorAssetRef | null;
  panoramaRadius: number;
  panoramaYaw: number;
}) {
  const { gl, scene } = useThree();
  const projectionMode = panoramaAsset?.projectionMode ?? "equirectangular";
  const requestedUrl = panoramaAsset?.url ?? null;
  const textureState = usePanoramaTexture(requestedUrl, projectionMode);
  const textureMatchesRequest =
    textureState.status === "ready" &&
    textureState.url === requestedUrl &&
    textureState.projectionMode === projectionMode;
  const safeRadius = Math.max(10, panoramaRadius);
  const rotationY = getPanoramaRotationRadians(panoramaYaw);
  const fallbackColor = useMemo(() => new Color(backgroundColor), [backgroundColor]);

  useLayoutEffect(() => {
    const nextBackground =
      textureMatchesRequest && projectionMode === "equirectangular" ? textureState.texture : fallbackColor;
    const previousBackground = scene.background;
    const previousEnvironment = scene.environment;
    const nextEnvironment =
      environmentEnabled && environmentUsePanorama && textureMatchesRequest && projectionMode === "equirectangular"
        ? textureState.texture
        : undefined;

    scene.background = nextBackground;
    scene.backgroundBlurriness = 0;
    scene.backgroundIntensity = 1;
    scene.backgroundRotation.set(0, textureMatchesRequest && projectionMode === "equirectangular" ? rotationY : 0, 0);
    if (nextEnvironment) {
      scene.environment = nextEnvironment;
      scene.environmentIntensity = environmentIntensity;
      scene.environmentRotation?.set(
        environmentRotation[0],
        environmentRotation[1] + rotationY,
        environmentRotation[2],
      );
    }
    gl.setClearColor(fallbackColor, 1);

    return () => {
      // Texture ownership belongs to usePanoramaTexture. Detach our exact
      // background before that hook disposes it; do not overwrite a newer
      // background installed by another viewport instance during remount.
      if (scene.background === nextBackground) scene.background = previousBackground;
      if (nextEnvironment && scene.environment === nextEnvironment) scene.environment = previousEnvironment;
    };
  }, [
    environmentEnabled,
    environmentIntensity,
    environmentRotation,
    environmentUsePanorama,
    fallbackColor,
    gl,
    projectionMode,
    requestedUrl,
    rotationY,
    scene,
    textureMatchesRequest,
    textureState,
  ]);

  return (
    <>
      {textureMatchesRequest && projectionMode === "backdrop" ? (
        <mesh frustumCulled={false} name="panorama-backdrop-dome" renderOrder={-1000} rotation={[0, rotationY, 0]}>
          <sphereGeometry args={[safeRadius, 96, 64]} />
          <meshBasicMaterial depthWrite={false} map={textureState.texture} side={BackSide} toneMapped={false} />
        </mesh>
      ) : null}
      {textureState.status === "error" &&
      textureState.url === requestedUrl &&
      textureState.projectionMode === projectionMode ? (
        <Html center>
          <div className="viewport-error-card" role="status">
            <strong>全景图加载失败</strong>
            <span>请重新导入 JPG / PNG / WEBP 图片</span>
          </div>
        </Html>
      ) : null}
    </>
  );
}
