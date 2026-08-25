/**
 * PBR material rendering for Director objects, including texture loading, material override,
 * and imported material cloning with automatic Standard-to-Physical upgrade.
 *
 * @module director-pbr-material
 */

import { useLoader } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import {
  BackSide,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  SRGBColorSpace,
  TextureLoader,
  type Color,
  type Material,
  type Object3D,
  type Texture,
} from "three";
import type {
  DirectorAssetRef,
  DirectorMaterialSide,
  DirectorMaterialTextureSlot,
  DirectorObject,
  DirectorPbrMaterial,
} from "../schema/directorProject";
import { DIRECTOR_MATERIAL_TEXTURE_SLOTS } from "../schema/directorProject";
import { resolveDirectorPbrMaterial, type ResolvedDirectorPbrMaterial } from "../schema/directorMaterial";

type LoadedMaterialTextures = Partial<Record<DirectorMaterialTextureSlot, Texture>>;

function materialSide(side: DirectorMaterialSide) {
  if (side === "back") return BackSide;
  if (side === "double") return DoubleSide;
  return FrontSide;
}

function textureEntries(material: ResolvedDirectorPbrMaterial, assets: DirectorAssetRef[]) {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return DIRECTOR_MATERIAL_TEXTURE_SLOTS.flatMap((slot) => {
    const assetId = material.textures[slot];
    const asset = assetId ? assetsById.get(assetId) : undefined;
    return asset?.sourceType === "image" ? [{ slot, url: asset.url }] : [];
  });
}

function configureLoadedTextures(
  entries: Array<{ slot: DirectorMaterialTextureSlot; url: string }>,
  loaded: Texture[],
): LoadedMaterialTextures {
  return Object.fromEntries(
    entries.map((entry, index) => {
      const texture = loaded[index];
      if (texture) {
        texture.colorSpace =
          entry.slot === "baseColorMapAssetId" || entry.slot === "emissiveMapAssetId" ? SRGBColorSpace : NoColorSpace;
        texture.needsUpdate = true;
      }
      return [entry.slot, texture];
    }),
  ) as LoadedMaterialTextures;
}

function physicalMaterialProps(material: ResolvedDirectorPbrMaterial, textures: LoadedMaterialTextures) {
  const alphaMap = textures.alphaMapAssetId;
  return {
    alphaMap,
    aoMap: textures.aoMapAssetId,
    clearcoat: material.clearcoat,
    clearcoatRoughness: material.clearcoatRoughness,
    color: material.baseColor,
    emissive: material.emissiveColor,
    emissiveIntensity: material.emissiveIntensity,
    emissiveMap: textures.emissiveMapAssetId,
    flatShading: material.flatShading,
    ior: material.ior,
    map: textures.baseColorMapAssetId,
    metalness: material.metalness,
    metalnessMap: textures.metalnessMapAssetId,
    normalMap: textures.normalMapAssetId,
    opacity: material.opacity,
    roughness: material.roughness,
    roughnessMap: textures.roughnessMapAssetId,
    side: materialSide(material.side),
    transmission: material.transmission,
    transparent: material.opacity < 1 || material.transmission > 0 || Boolean(alphaMap),
    wireframe: material.wireframe,
  };
}

function standardMaterialProps(material: ResolvedDirectorPbrMaterial, textures: LoadedMaterialTextures) {
  const {
    clearcoat: _clearcoat,
    clearcoatRoughness: _clearcoatRoughness,
    ior: _ior,
    transmission: _transmission,
    ...props
  } = physicalMaterialProps(material, textures);
  return props;
}

function requiresPhysicalMaterial(material: ResolvedDirectorPbrMaterial) {
  return material.transmission > 0 || material.clearcoat > 0;
}

function TexturedObjectMaterial({
  depthBias,
  entries,
  material,
}: {
  depthBias?: { polygonOffset: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number };
  entries: Array<{ slot: DirectorMaterialTextureSlot; url: string }>;
  material: ResolvedDirectorPbrMaterial;
}) {
  const loaded = useLoader(
    TextureLoader,
    entries.map((entry) => entry.url),
  );
  const textures = useMemo(() => configureLoadedTextures(entries, loaded), [entries, loaded]);
  return requiresPhysicalMaterial(material) ? (
    <meshPhysicalMaterial {...physicalMaterialProps(material, textures)} {...depthBias} />
  ) : (
    <meshStandardMaterial {...standardMaterialProps(material, textures)} {...depthBias} />
  );
}

/** Renders a PBR material for a Director object, selecting Physical or Standard based on material properties. */
export function DirectorObjectPbrMaterial({
  assets,
  depthBias,
  object,
}: {
  assets: DirectorAssetRef[];
  depthBias?: { factor: number; units: number };
  object: DirectorObject;
}) {
  const material = resolveDirectorPbrMaterial(object);
  const entries = useMemo(() => textureEntries(material, assets), [assets, material]);
  const offsetProps =
    depthBias && (depthBias.factor !== 0 || depthBias.units !== 0)
      ? {
          polygonOffset: true,
          polygonOffsetFactor: depthBias.factor,
          polygonOffsetUnits: depthBias.units,
        }
      : undefined;
  if (entries.length) return <TexturedObjectMaterial entries={entries} material={material} depthBias={offsetProps} />;
  return requiresPhysicalMaterial(material) ? (
    <meshPhysicalMaterial {...physicalMaterialProps(material, {})} {...(offsetProps ?? {})} />
  ) : (
    <meshStandardMaterial {...standardMaterialProps(material, {})} {...(offsetProps ?? {})} />
  );
}

function standardMaterialToPhysical(source: Material) {
  if (source instanceof MeshPhysicalMaterial) return source.clone();
  if (source instanceof MeshStandardMaterial) {
    const material = new MeshPhysicalMaterial({
      alphaMap: source.alphaMap,
      aoMap: source.aoMap,
      color: source.color,
      emissive: source.emissive,
      emissiveIntensity: source.emissiveIntensity,
      emissiveMap: source.emissiveMap,
      flatShading: source.flatShading,
      map: source.map,
      metalness: source.metalness,
      metalnessMap: source.metalnessMap,
      normalMap: source.normalMap,
      opacity: source.opacity,
      roughness: source.roughness,
      roughnessMap: source.roughnessMap,
      side: source.side,
      transparent: source.transparent,
      vertexColors: source.vertexColors,
      wireframe: source.wireframe,
    });
    material.name = source.name;
    material.depthTest = source.depthTest;
    material.depthWrite = source.depthWrite;
    return material;
  }

  const sourceWithSurface = source as Material & { color?: Color; map?: Texture | null };
  const material = new MeshPhysicalMaterial({ map: sourceWithSurface.map ?? null });
  if (sourceWithSurface.color?.isColor) material.color.copy(sourceWithSurface.color);
  material.name = source.name;
  material.opacity = source.opacity;
  material.side = source.side;
  material.transparent = source.transparent;
  return material;
}

/** Clones all materials on an imported object tree, upgrading Standard materials to Physical without changing the source. */
export function cloneDirectorImportedMaterials(root: Object3D) {
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => standardMaterialToPhysical(material))
      : standardMaterialToPhysical(mesh.material);
  });
}

function applyOverrideToMaterial(
  material: Material,
  resolved: ResolvedDirectorPbrMaterial,
  textures: LoadedMaterialTextures,
) {
  if (!(material instanceof MeshStandardMaterial)) return;
  const properties = physicalMaterialProps(resolved, textures);
  material.color.set(properties.color);
  material.emissive.set(properties.emissive);
  material.emissiveIntensity = properties.emissiveIntensity;
  material.map = properties.map ?? null;
  material.normalMap = properties.normalMap ?? null;
  material.roughnessMap = properties.roughnessMap ?? null;
  material.metalnessMap = properties.metalnessMap ?? null;
  material.emissiveMap = properties.emissiveMap ?? null;
  material.aoMap = properties.aoMap ?? null;
  material.alphaMap = properties.alphaMap ?? null;
  material.metalness = properties.metalness;
  material.roughness = properties.roughness;
  material.opacity = properties.opacity;
  material.side = properties.side;
  material.transparent = properties.transparent;
  material.wireframe = properties.wireframe;
  material.flatShading = properties.flatShading;
  if (material instanceof MeshPhysicalMaterial) {
    material.transmission = properties.transmission;
    material.ior = properties.ior;
    material.clearcoat = properties.clearcoat;
    material.clearcoatRoughness = properties.clearcoatRoughness;
  }
  material.needsUpdate = true;
}

function ImportedMaterialOverrideEffect({
  material,
  object,
  textures,
}: {
  material: ResolvedDirectorPbrMaterial;
  object: Object3D;
  textures: LoadedMaterialTextures;
}) {
  useLayoutEffect(() => {
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((entry) => applyOverrideToMaterial(entry, material, textures));
    });
  }, [material, object, textures]);
  return null;
}

function TexturedImportedMaterialOverride({
  entries,
  material,
  object,
}: {
  entries: Array<{ slot: DirectorMaterialTextureSlot; url: string }>;
  material: ResolvedDirectorPbrMaterial;
  object: Object3D;
}) {
  const loaded = useLoader(
    TextureLoader,
    entries.map((entry) => entry.url),
  );
  const textures = useMemo(() => configureLoadedTextures(entries, loaded), [entries, loaded]);
  return <ImportedMaterialOverrideEffect material={material} object={object} textures={textures} />;
}

/** Overrides material properties on an imported object tree with a Director PBR material, applying textures if present. */
export function DirectorImportedMaterialOverride({
  assets,
  material,
  object,
}: {
  assets: DirectorAssetRef[];
  material: DirectorPbrMaterial;
  object: Object3D;
}) {
  const resolved = resolveDirectorPbrMaterial({ material });
  const entries = useMemo(() => textureEntries(resolved, assets), [assets, resolved]);
  if (entries.length) {
    return <TexturedImportedMaterialOverride entries={entries} material={resolved} object={object} />;
  }
  return <ImportedMaterialOverrideEffect material={resolved} object={object} textures={{}} />;
}
