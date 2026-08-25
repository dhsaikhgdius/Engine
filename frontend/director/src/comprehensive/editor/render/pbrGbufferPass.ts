import {
  Color,
  MeshBasicMaterial,
  NoBlending,
  NormalBlending,
  ShadowMaterial,
  type Material,
  type Mesh,
  type Texture,
} from "three";
import {
  captureDirectorObjectBatchColorState,
  clearDirectorObjectBatchColors,
  isDirectorObjectBatchMesh,
  restoreDirectorObjectBatchColors,
  type DirectorObjectBatchColorState,
} from "../canvas/directorObjectBatch";

/** Named PBR material channels captured as separate grayscale or RGB passes. */
export const DIRECTOR_PBR_GBUFFER_PASSES = ["albedo", "roughness", "metalness", "emissive", "ao", "shadow"] as const;

export type DirectorPbrGbufferPass = (typeof DIRECTOR_PBR_GBUFFER_PASSES)[number];

/** A mesh whose material is eligible for PBR G-buffer extraction. */
export type DirectorPbrGbufferMesh = Mesh & { material: Material | Material[] };

type PbrSourceMaterial = Material & {
  alphaMap?: Texture | null;
  alphaTest?: number;
  aoMap?: Texture | null;
  aoMapIntensity?: number;
  color?: Color;
  emissive?: Color;
  emissiveIntensity?: number;
  emissiveMap?: Texture | null;
  map?: Texture | null;
  metalness?: number;
  metalnessMap?: Texture | null;
  opacity?: number;
  roughness?: number;
  roughnessMap?: Texture | null;
  vertexColors?: boolean;
};

interface OriginalPbrMeshState {
  mesh: DirectorPbrGbufferMesh;
  material: Material | Material[];
  batchColorState?: DirectorObjectBatchColorState;
}

function copyRasterState(source: PbrSourceMaterial, target: MeshBasicMaterial | ShadowMaterial): void {
  if (target instanceof MeshBasicMaterial) {
    target.alphaMap = source.alphaMap ?? null;
  }
  target.alphaTest = source.alphaTest ?? 0;
  target.blending = NoBlending;
  target.colorWrite = source.colorWrite;
  target.depthFunc = source.depthFunc;
  target.depthTest = source.depthTest;
  target.depthWrite = source.depthWrite;
  target.opacity = source.opacity ?? 1;
  target.polygonOffset = source.polygonOffset;
  target.polygonOffsetFactor = source.polygonOffsetFactor;
  target.polygonOffsetUnits = source.polygonOffsetUnits;
  target.side = source.side;
  target.transparent = source.transparent;
  target.visible = source.visible;
  target.toneMapped = false;
}

function setScalarChannel(material: MeshBasicMaterial, channel: "r" | "g" | "b", aoIntensity?: number): void {
  material.onBeforeCompile = (shader) => {
    const expression =
      aoIntensity === undefined
        ? `diffuseColor.rgb = vec3(diffuseColor.${channel});`
        : `diffuseColor.rgb = vec3(1.0 + (diffuseColor.${channel} - 1.0) * ${aoIntensity.toFixed(8)});`;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>\n${expression}`,
    );
  };
  material.customProgramCacheKey = () => `director-gbuffer-${material.userData.directorGbufferPass}`;
}

function createBasicPassMaterial(source: PbrSourceMaterial, pass: Exclude<DirectorPbrGbufferPass, "shadow">) {
  const material = new MeshBasicMaterial({ fog: false });
  copyRasterState(source, material);
  material.userData.directorGbufferPass = pass;

  if (pass === "albedo") {
    material.color.copy(source.color ?? new Color(0xffffff));
    material.map = source.map ?? null;
    material.vertexColors = source.vertexColors ?? false;
    return material;
  }
  if (pass === "roughness") {
    material.color.setScalar(source.roughness ?? 1);
    material.map = source.roughnessMap ?? null;
    setScalarChannel(material, "g");
    return material;
  }
  if (pass === "metalness") {
    material.color.setScalar(source.metalness ?? 0);
    material.map = source.metalnessMap ?? null;
    setScalarChannel(material, "b");
    return material;
  }
  if (pass === "emissive") {
    material.color.copy(source.emissive ?? new Color(0x000000));
    material.color.multiplyScalar(source.emissiveIntensity ?? 1);
    material.map = source.emissiveMap ?? null;
    return material;
  }

  material.color.setScalar(1);
  material.map = source.aoMap ?? null;
  setScalarChannel(material, "r", source.aoMapIntensity ?? 1);
  return material;
}

function createPassMaterial(source: Material, pass: DirectorPbrGbufferPass): Material {
  const pbrSource = source as PbrSourceMaterial;
  if (pass !== "shadow") return createBasicPassMaterial(pbrSource, pass);

  const material = new ShadowMaterial({ color: 0x000000, opacity: 1 });
  copyRasterState(pbrSource, material);
  // Composite the black shadow opacity over the pass's white clear color so
  // RGB itself is a usable white-to-black matte. NoBlending would leave every
  // receiver black and hide the actual shadow strength in alpha only.
  material.blending = NormalBlending;
  material.transparent = true;
  material.userData.directorGbufferPass = pass;
  return material;
}

/**
 * Type guard for the PBR G-buffer pass enum.
 *
 * @param value - A string to test.
 * @returns Whether the value is a valid PBR G-buffer pass name.
 */
export function isDirectorPbrGbufferPass(value: string): value is DirectorPbrGbufferPass {
  return DIRECTOR_PBR_GBUFFER_PASSES.includes(value as DirectorPbrGbufferPass);
}

/**
 * Swaps every mesh's material to a temporary material that isolates one PBR
 * channel. The returned scope restores original materials and disposes of the
 * temporary ones, even when rendering throws.
 *
 * @param meshes - The meshes whose materials to replace.
 * @param pass - Which PBR channel to extract.
 * @returns A scope whose `restore()` reverts all materials and cleans up.
 */
export function applyDirectorPbrGbufferPass(
  meshes: DirectorPbrGbufferMesh[],
  pass: DirectorPbrGbufferPass,
): { restore: () => void } {
  const disposableMaterials: Material[] = [];
  const originals: OriginalPbrMeshState[] = meshes.map((mesh) => {
    const material = mesh.material;
    const replacements = (Array.isArray(material) ? material : [material]).map((source) => {
      const replacement = createPassMaterial(source, pass);
      disposableMaterials.push(replacement);
      return replacement;
    });
    mesh.material = Array.isArray(material) ? replacements : replacements[0]!;

    if (!isDirectorObjectBatchMesh(mesh)) return { mesh, material };
    const batchColorState = captureDirectorObjectBatchColorState(mesh);
    if (pass !== "albedo") clearDirectorObjectBatchColors(mesh);
    return { mesh, material, batchColorState };
  });

  return {
    restore: () => {
      originals.forEach(({ mesh, material, batchColorState }) => {
        mesh.material = material;
        if (batchColorState && isDirectorObjectBatchMesh(mesh)) {
          restoreDirectorObjectBatchColors(mesh, batchColorState);
        }
      });
      disposableMaterials.forEach((material) => material.dispose());
    },
  };
}
