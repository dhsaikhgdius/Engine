/**
 * @module PBR material defaults, resolution, and merging utilities for director objects.
 */

import type { DirectorMaterialSide, DirectorObject, DirectorPbrMaterial } from "./directorProject";

/** Default PBR material values used as the base for all director objects. */
export const DEFAULT_DIRECTOR_PBR_MATERIAL = {
  baseColor: "#d7e7ff",
  metalness: 0.02,
  roughness: 0.68,
  opacity: 1,
  emissiveColor: "#000000",
  emissiveIntensity: 0,
  transmission: 0,
  ior: 1.5,
  clearcoat: 0,
  clearcoatRoughness: 0,
  side: "front",
  wireframe: false,
  flatShading: false,
} as const satisfies Required<Omit<DirectorPbrMaterial, "textures">>;

/** Fully resolved PBR material with all fields populated and no partial textures. */
export type ResolvedDirectorPbrMaterial = {
  baseColor: string;
  metalness: number;
  roughness: number;
  opacity: number;
  emissiveColor: string;
  emissiveIntensity: number;
  transmission: number;
  ior: number;
  clearcoat: number;
  clearcoatRoughness: number;
  side: DirectorMaterialSide;
  wireframe: boolean;
  flatShading: boolean;
  textures: NonNullable<DirectorPbrMaterial["textures"]>;
};

/** Resolves an object's partial material into a fully populated PBR material. */
export function resolveDirectorPbrMaterial(
  object: Pick<DirectorObject, "color" | "material">,
): ResolvedDirectorPbrMaterial {
  return {
    ...DEFAULT_DIRECTOR_PBR_MATERIAL,
    ...object.material,
    baseColor: object.material?.baseColor ?? object.color ?? DEFAULT_DIRECTOR_PBR_MATERIAL.baseColor,
    textures: { ...(object.material?.textures ?? {}) },
  };
}

/** Merges a partial material patch into an existing PBR material, preserving texture fields. */
export function mergeDirectorPbrMaterial(
  current: DirectorPbrMaterial | undefined,
  patch: Partial<DirectorPbrMaterial>,
): DirectorPbrMaterial {
  return {
    ...current,
    ...patch,
    ...(patch.textures ? { textures: { ...(current?.textures ?? {}), ...patch.textures } } : {}),
  };
}
