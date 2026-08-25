import { useLayoutEffect } from "react";
import { useThree } from "@react-three/fiber";
import { ACESFilmicToneMapping } from "three";

/**
 * Live Stage look: keep the R3F / capture ACES display transform. A global
 * AgX swap retints every authored material, which is the wrong default for
 * a film set that already has its own lights and textures.
 */
export const DIRECTOR_VIEWPORT_TONE_MAPPING = ACESFilmicToneMapping;

export const DIRECTOR_VIEWPORT_TONE_MAPPING_EXPOSURE = 1;

/**
 * Applies the Stage's display tone mapping. Capture paths snapshot and
 * restore renderer state, so this only owns the interactive framebuffer.
 */
export function DirectorViewportLook() {
  const { gl } = useThree();

  useLayoutEffect(() => {
    const previousMapping = gl.toneMapping;
    const previousExposure = gl.toneMappingExposure;
    gl.toneMapping = DIRECTOR_VIEWPORT_TONE_MAPPING;
    if (!Number.isFinite(gl.toneMappingExposure) || gl.toneMappingExposure === 1) {
      gl.toneMappingExposure = DIRECTOR_VIEWPORT_TONE_MAPPING_EXPOSURE;
    }
    return () => {
      gl.toneMapping = previousMapping;
      gl.toneMappingExposure = previousExposure;
    };
  }, [gl]);

  return null;
}
