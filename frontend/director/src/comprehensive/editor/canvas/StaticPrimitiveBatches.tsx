/**
 * Batched rendering for static primitive objects (boxes, spheres, cylinders, etc.) using
 * InstancedMesh or BatchedMesh for draw-call reduction, with material-aware partitioning.
 *
 * @module static-primitive-batches
 */

import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useLayoutEffect, useMemo } from "react";
import {
  BackSide,
  BatchedMesh,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  InstancedMesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
  type Side,
} from "three";
import { getDirectorPrimitiveMetrics } from "@director/project-schema";
import { resolveDirectorPbrMaterial, type ResolvedDirectorPbrMaterial } from "../schema/directorMaterial";
import type { DirectorObject, GeometryPrimitiveType } from "../schema/directorProject";
import {
  getDirectorObjectBatchHitIndex,
  isDirectorBatchedObjectBatchMesh,
  isDirectorInstancedObjectBatchMesh,
  type DirectorObjectBatchMesh,
} from "./directorObjectBatch";
import {
  applyCoplanarDepthBias,
  getPrimitiveCoplanarBiasRank,
  getPrimitiveCoplanarDepthBias,
} from "./importedModelDepth";

const MINIMUM_PRIMITIVE_BATCH_SIZE = 4;

/** A batch of static primitives sharing the same geometry type and material key. */
export type DirectorStaticPrimitiveBatch = {
  id: string;
  geometryType: GeometryPrimitiveType;
  material: ResolvedDirectorPbrMaterial;
  objects: DirectorObject[];
};

/** The result of partitioning static primitives into batches, including the set of batched object IDs. */
export type DirectorStaticPrimitiveBatchPartition = {
  batches: DirectorStaticPrimitiveBatch[];
  batchedObjectIds: Set<string>;
};

function canBatchStaticPrimitive(object: DirectorObject, excludedObjectIds: ReadonlySet<string>) {
  if (excludedObjectIds.has(object.id)) return false;
  if (object.kind !== "prop" || !object.geometryType || !object.visible) return false;
  if (object.assetRefId || object.nativeSource || object.isCompositeParent || object.parentObjectId) return false;
  if (object.vehicle || object.interaction || object.pivot) return false;
  if (object.referenceBindings?.length || object.animation?.keyframes.length) return false;

  const material = resolveDirectorPbrMaterial(object);
  if (material.opacity !== 1 || material.transmission !== 0) return false;
  return !Object.values(material.textures).some(Boolean);
}

function getPrimitiveBatchMaterialKey(
  geometryType: GeometryPrimitiveType,
  material: ResolvedDirectorPbrMaterial,
  scale: DirectorObject["transform"]["scale"],
) {
  return JSON.stringify([
    geometryType,
    material.metalness,
    material.roughness,
    material.emissiveColor,
    material.emissiveIntensity,
    material.ior,
    material.clearcoat,
    material.clearcoatRoughness,
    material.side,
    material.wireframe,
    material.flatShading,
    getPrimitiveCoplanarBiasRank(scale),
  ]);
}

/** Partitions eligible static primitive objects into batches keyed by geometry type and material properties. */
export function createDirectorStaticPrimitiveBatchPartition(
  objects: DirectorObject[],
  excludedObjectIds: ReadonlySet<string>,
  enabled: boolean,
): DirectorStaticPrimitiveBatchPartition {
  if (!enabled) return { batches: [], batchedObjectIds: new Set() };

  const candidatesByKey = new Map<
    string,
    Omit<DirectorStaticPrimitiveBatch, "id"> & { material: ResolvedDirectorPbrMaterial }
  >();
  for (const object of objects) {
    if (!canBatchStaticPrimitive(object, excludedObjectIds)) continue;
    const material = resolveDirectorPbrMaterial(object);
    const key = getPrimitiveBatchMaterialKey(object.geometryType!, material, object.transform.scale);
    const current = candidatesByKey.get(key);
    if (current) current.objects.push(object);
    else candidatesByKey.set(key, { geometryType: object.geometryType!, material, objects: [object] });
  }

  const batches: DirectorStaticPrimitiveBatch[] = [];
  const batchedObjectIds = new Set<string>();
  for (const candidate of candidatesByKey.values()) {
    if (candidate.objects.length < MINIMUM_PRIMITIVE_BATCH_SIZE) continue;
    const batch = { ...candidate, id: `${candidate.geometryType}-${batches.length}` };
    batches.push(batch);
    candidate.objects.forEach((object) => batchedObjectIds.add(object.id));
  }

  return { batches, batchedObjectIds };
}

function createPrimitiveGeometry(geometryType: GeometryPrimitiveType): BufferGeometry {
  let geometry: BufferGeometry;
  if (geometryType === "sphere") geometry = new SphereGeometry(0.5, 32, 16);
  else if (geometryType === "cylinder") geometry = new CylinderGeometry(0.5, 0.5, 1, 32);
  else if (geometryType === "torus") geometry = new TorusGeometry(0.375, 0.125, 16, 48);
  else if (geometryType === "cone") geometry = new ConeGeometry(0.5, 1, 32);
  else if (geometryType === "pyramid") geometry = new ConeGeometry(0.5, 1, 4);
  else geometry = new BoxGeometry(1, 1, 1);

  if (geometryType === "torus") geometry.rotateX(Math.PI / 2);
  const center = getDirectorPrimitiveMetrics(geometryType).center;
  geometry.translate(center[0], center[1], center[2]);
  return geometry;
}

function resolveMaterialSide(side: ResolvedDirectorPbrMaterial["side"]): Side {
  if (side === "back") return BackSide;
  if (side === "double") return DoubleSide;
  return FrontSide;
}

/** Returns the shared material properties for a batched primitive material, excluding texture-related fields. */
export function getDirectorStaticPrimitiveMaterialProps(material: ResolvedDirectorPbrMaterial) {
  return {
    color: "#ffffff",
    emissive: material.emissiveColor,
    emissiveIntensity: material.emissiveIntensity,
    flatShading: material.flatShading,
    metalness: material.metalness,
    roughness: material.roughness,
    side: resolveMaterialSide(material.side),
    wireframe: material.wireframe,
  };
}

function createBatchMaterial(material: ResolvedDirectorPbrMaterial) {
  const props = getDirectorStaticPrimitiveMaterialProps(material);
  if (material.clearcoat > 0) {
    return new MeshPhysicalMaterial({
      ...props,
      clearcoat: material.clearcoat,
      clearcoatRoughness: material.clearcoatRoughness,
      ior: material.ior,
    });
  }
  return new MeshStandardMaterial(props);
}

/** Creates a BatchedMesh or InstancedMesh for a static primitive batch, applying transforms and colors. */
export function createDirectorStaticPrimitiveRenderMesh(
  batch: DirectorStaticPrimitiveBatch,
  supportsMultiDraw: boolean,
  reversedDepthBuffer = true,
): DirectorObjectBatchMesh {
  const sourceGeometry = createPrimitiveGeometry(batch.geometryType);
  const material = createBatchMaterial(batch.material);
  const representative = batch.objects[0];
  if (representative) {
    applyCoplanarDepthBias(
      material,
      getPrimitiveCoplanarDepthBias(representative.transform.scale, reversedDepthBuffer),
    );
  }
  let mesh: DirectorObjectBatchMesh;

  if (supportsMultiDraw) {
    const vertexCount = sourceGeometry.getAttribute("position").count;
    const indexCount = sourceGeometry.getIndex()?.count ?? vertexCount;
    const batched = new BatchedMesh(batch.objects.length, vertexCount, indexCount, material);
    const geometryId = batched.addGeometry(sourceGeometry);
    batch.objects.forEach(() => batched.addInstance(geometryId));
    batched.perObjectFrustumCulled = true;
    // Every material in this path is opaque. Sorting does not change pixels,
    // while skipping it avoids ordering thousands of city instances for each
    // main, shadow, height-map, and environment-probe camera.
    batched.sortObjects = false;
    sourceGeometry.dispose();
    mesh = batched;
  } else {
    mesh = new InstancedMesh(sourceGeometry, material, batch.objects.length);
  }

  const transform = new Object3D();
  const color = new Color();
  batch.objects.forEach((object, index) => {
    transform.position.fromArray(object.transform.position);
    transform.rotation.fromArray(object.transform.rotation);
    transform.scale.fromArray(object.transform.scale);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    mesh.setColorAt(index, color.set(resolveDirectorPbrMaterial(object).baseColor));
  });
  if (isDirectorInstancedObjectBatchMesh(mesh)) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  mesh.computeBoundingSphere();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.name = `director-primitive-batch-${batch.id}`;
  mesh.userData = {
    directorInstanceObjectIds: batch.objects.map((object) => object.id),
    directorObjectKind: "prop",
    directorStaticPrimitiveBatch: true,
  };
  return mesh;
}

/** Disposes the geometry and materials of a static primitive render mesh, handling both BatchedMesh and InstancedMesh. */
export function disposeDirectorStaticPrimitiveRenderMesh(mesh: DirectorObjectBatchMesh): void {
  if (isDirectorBatchedObjectBatchMesh(mesh)) BatchedMesh.prototype.dispose.call(mesh);
  else {
    mesh.geometry.dispose();
    InstancedMesh.prototype.dispose.call(mesh);
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  materials.forEach((material) => material.dispose());
}

function StaticPrimitiveBatch({
  batch,
  onSelect,
  supportsMultiDraw,
}: {
  batch: DirectorStaticPrimitiveBatch;
  onSelect: (object: DirectorObject) => void;
  supportsMultiDraw: boolean;
}) {
  const reversedDepthBuffer = useThree((state) => state.gl.capabilities.reversedDepthBuffer === true);
  const mesh = useMemo(
    () => createDirectorStaticPrimitiveRenderMesh(batch, supportsMultiDraw, reversedDepthBuffer),
    [batch, reversedDepthBuffer, supportsMultiDraw],
  );
  useLayoutEffect(() => () => disposeDirectorStaticPrimitiveRenderMesh(mesh), [mesh]);

  return (
    <primitive
      object={mesh}
      name={mesh.name}
      dispose={null}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        event.stopPropagation();
        const hitIndex = getDirectorObjectBatchHitIndex(event);
        if (hitIndex === null) return;
        const object = batch.objects[hitIndex];
        if (object) onSelect(object);
      }}
    />
  );
}

/** Renders a list of static primitive batches with click-to-select on individual instances. */
export function StaticPrimitiveBatches({
  batches,
  onSelect,
}: {
  batches: DirectorStaticPrimitiveBatch[];
  onSelect: (object: DirectorObject) => void;
}) {
  const supportsMultiDraw = useThree((state) => state.gl.extensions.has("WEBGL_multi_draw"));
  return batches.map((batch) => (
    <StaticPrimitiveBatch key={batch.id} batch={batch} onSelect={onSelect} supportsMultiDraw={supportsMultiDraw} />
  ));
}
