import { Mesh, SkinnedMesh, type BufferGeometry, type Material, type Object3D } from "three";

/**
 * Architectural GLBs (large walls + flush window frames) often author two
 * coplanar surfaces that share one Blender/glTF material. A size-based
 * polygon offset keeps the larger wall behind the trim.
 *
 * Offsets are absolute in metres of bounding radius so a one-mesh wall object
 * and a one-mesh panel object still separate when they are not in the same
 * graph. Materials are cloned per slot — otherwise the last mesh wins and
 * every red wall shares the last ornament's bias.
 *
 * Reversed-Z flips the window-space depth, so the bias sign must flip with it.
 */
const COPLANAR_BIAS_REFERENCE_RADIUS = 0.25;
const COPLANAR_BIAS_MAX_STEPS = 8;
const COPLANAR_OFFSET_UNITS_PER_STEP = 8;
const PRIMITIVE_BIAS_REFERENCE_AREA = 0.25;
const PRIMITIVE_BIAS_RANK_SCALE = 2;

/**
 * Applies size-based polygon offset to every coplanar mesh surface in the
 * imported model tree, so larger walls render behind flush trim details.
 * Materials are cloned per slot to avoid sharing bias state across meshes.
 *
 * @param root - The root Object3D to traverse.
 * @param reversedDepthBuffer - Whether the renderer uses a reversed depth buffer.
 */
export function stabilizeImportedModelCoplanarDepth(root: Object3D, reversedDepthBuffer = false) {
  const surfaces = collectCoplanarSurfaces(root);
  if (!surfaces.length) return;

  const sign = reversedDepthBuffer ? -1 : 1;
  for (const surface of surfaces) {
    applyCoplanarDepthBias(surface.material, biasForRadius(surface.radius, sign));
  }
}

function collectCoplanarSurfaces(root: Object3D) {
  const surfaces: Array<{ material: Material; radius: number }> = [];
  root.traverse((child) => {
    if (!(child instanceof Mesh) || !child.geometry || child instanceof SkinnedMesh) return;
    const detached = detachMeshMaterials(child);
    if (!detached.length) return;
    detached.forEach((material, materialIndex) => {
      surfaces.push({
        material,
        radius: radiusForMaterialSlot(child.geometry, materialIndex, detached.length),
      });
    });
  });
  return surfaces;
}

function detachMeshMaterials(mesh: Mesh): Material[] {
  const source = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
  const detached = source
    .filter((material): material is Material => Boolean(material))
    .map((material) => {
      const clone = material.clone();
      clone.polygonOffset = material.polygonOffset;
      clone.polygonOffsetFactor = material.polygonOffsetFactor;
      clone.polygonOffsetUnits = material.polygonOffsetUnits;
      return clone;
    });
  if (!detached.length) return [];
  mesh.material = Array.isArray(mesh.material) ? detached : detached[0]!;
  return detached;
}

function radiusForMaterialSlot(geometry: BufferGeometry, materialIndex: number, materialCount: number) {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const fallback = geometry.boundingSphere?.radius ?? 1;
  if (materialCount <= 1 || geometry.groups.length === 0) return fallback;

  const position = geometry.getAttribute("position");
  const groups = geometry.groups.filter((group) => group.materialIndex === materialIndex);
  if (!position || groups.length === 0) return fallback;

  const index = geometry.getIndex();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const visit = (vertexIndex: number) => {
    const x = position.getX(vertexIndex);
    const y = position.getY(vertexIndex);
    const z = position.getZ(vertexIndex);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  };

  for (const group of groups) {
    const end = group.start + group.count;
    if (index) {
      for (let cursor = group.start; cursor < end; cursor += 1) visit(index.getX(cursor));
    } else {
      for (let cursor = group.start; cursor < end; cursor += 1) visit(cursor);
    }
  }

  if (!Number.isFinite(minX)) return fallback;
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5;
}

function biasForRadius(radius: number, sign: number) {
  const steps = Math.min(
    COPLANAR_BIAS_MAX_STEPS,
    Math.max(0, Math.log2(Math.max(radius, COPLANAR_BIAS_REFERENCE_RADIUS) / COPLANAR_BIAS_REFERENCE_RADIUS)),
  );
  return {
    factor: sign * steps,
    units: sign * steps * COPLANAR_OFFSET_UNITS_PER_STEP,
  };
}

/**
 * Applies a pre-computed polygon offset bias to a material.
 *
 * @param material - The material to modify.
 * @param bias - The factor and units values for the polygon offset.
 */
export function applyCoplanarDepthBias(material: Material, bias: { factor: number; units: number }) {
  const active = bias.factor !== 0 || bias.units !== 0;
  material.polygonOffset = active;
  material.polygonOffsetFactor = bias.factor;
  material.polygonOffsetUnits = bias.units;
}

/**
 * Largest face area of a primitive, used to push large walls behind flush door slabs.
 *
 * @param scale - The object's scale as [x, y, z].
 * @returns The area of the two largest axes.
 */
export function getPrimitiveSlabFaceArea(scale: readonly [number, number, number]) {
  const extents = [Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])].sort((left, right) => left - right);
  return (extents[1] ?? 0) * (extents[2] ?? 0);
}

/**
 * Returns a logarithmic rank based on the primitive's largest face area,
 * used to order coplanar depth biases for primitives.
 *
 * @param scale - The object's scale as [x, y, z].
 * @returns An integer rank; larger values indicate larger primitives.
 */
export function getPrimitiveCoplanarBiasRank(scale: readonly [number, number, number]) {
  const area = Math.max(getPrimitiveSlabFaceArea(scale), PRIMITIVE_BIAS_REFERENCE_AREA);
  return Math.round(Math.log2(area) * PRIMITIVE_BIAS_RANK_SCALE);
}

/**
 * Computes a polygon offset bias for a primitive based on its scale.
 * Larger primitives get a larger bias so they render behind smaller coplanar ones.
 *
 * @param scale - The object's scale as [x, y, z].
 * @param reversedDepthBuffer - Whether the renderer uses a reversed depth buffer.
 * @returns The factor and units values for the polygon offset.
 */
export function getPrimitiveCoplanarDepthBias(scale: readonly [number, number, number], reversedDepthBuffer = false) {
  const sign = reversedDepthBuffer ? -1 : 1;
  const area = getPrimitiveSlabFaceArea(scale);
  const steps = Math.min(
    COPLANAR_BIAS_MAX_STEPS,
    Math.max(0, Math.log2(Math.max(area, PRIMITIVE_BIAS_REFERENCE_AREA) / PRIMITIVE_BIAS_REFERENCE_AREA)),
  );
  return {
    factor: sign * steps,
    units: sign * steps * COPLANAR_OFFSET_UNITS_PER_STEP,
  };
}
