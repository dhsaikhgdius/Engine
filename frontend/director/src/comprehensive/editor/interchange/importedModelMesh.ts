import { Euler, Matrix4, Mesh, Quaternion, Vector3, type Material, type Object3D } from "three";
import type { DirectorAssetRef, DirectorObject, DirectorProject } from "../schema/directorProject";
import { isDirectorSplatAssetFileName } from "../loaders/splatFormats";
import {
  DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
  getImportedModelNormalization,
  getPreciseImportedModelBounds,
} from "../runtime/importedModelGeometry";

/** A single triangle in world space, with its face normal. */
export interface DirectorMeshTriangle {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  normal: [number, number, number];
}

/** The result of materializing an imported model's mesh for export. */
export interface DirectorMaterializedModelMesh {
  /** All visible triangles, transformed to world space. */
  triangles: DirectorMeshTriangle[];
  /** Whether any triangle winding was reversed because of negative scale. */
  negativeScaleBaked: boolean;
  /** Whether the model contains skinned meshes (poses are baked). */
  skinned: boolean;
  /** The number of visible mesh nodes found. */
  meshCount: number;
}

function transformMatrix(position: readonly number[], rotation: readonly number[], scale: readonly number[]) {
  return new Matrix4().compose(
    new Vector3(position[0], position[1], position[2]),
    new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ")),
    new Vector3(scale[0], scale[1], scale[2]),
  );
}

function objectWorldMatrix(project: DirectorProject, object: DirectorObject) {
  const scene = project.scene;
  return transformMatrix(scene.position, scene.rotation, [scene.scale, scene.scale, scene.scale]).multiply(
    transformMatrix(object.transform.position, object.transform.rotation, object.transform.scale),
  );
}

function materialIsVisible(material: Material | Material[] | undefined) {
  if (!material) return true;
  return (Array.isArray(material) ? material : [material]).some((entry) => entry.visible);
}

function hierarchyIsVisible(object: Object3D, root: Object3D) {
  let current: Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function triangleIndices(mesh: Mesh) {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position) return [];
  const index = geometry.index;
  const available = index?.count ?? position.count;
  const start = Math.max(0, Math.min(available, Math.floor(geometry.drawRange.start || 0)));
  const requested = Number.isFinite(geometry.drawRange.count) ? Math.max(0, geometry.drawRange.count) : available;
  const end = Math.min(available, start + requested);
  const output: Array<[number, number, number]> = [];
  for (let cursor = start; cursor + 2 < end; cursor += 3) {
    output.push([
      index ? index.getX(cursor) : cursor,
      index ? index.getX(cursor + 1) : cursor + 1,
      index ? index.getX(cursor + 2) : cursor + 2,
    ]);
  }
  return output;
}

function appendMeshTriangles(mesh: Mesh, baseMatrix: Matrix4, triangles: DirectorMeshTriangle[], maxTriangles: number) {
  const indices = triangleIndices(mesh);
  const instance = mesh as Mesh & {
    isInstancedMesh?: boolean;
    count?: number;
    getMatrixAt?: (index: number, matrix: Matrix4) => void;
  };
  const instanceCount = instance.isInstancedMesh ? Math.max(0, instance.count ?? 0) : 1;
  let negativeScaleBaked = false;
  const instanceMatrix = new Matrix4();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();

  for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
    const matrix = baseMatrix.clone();
    if (instance.isInstancedMesh) {
      instance.getMatrixAt?.(instanceIndex, instanceMatrix);
      matrix.multiply(instanceMatrix);
    }
    const reverse = matrix.determinant() < 0;
    negativeScaleBaked ||= reverse;
    for (const [ia, ib, ic] of indices) {
      if (triangles.length >= maxTriangles) {
        throw new Error(`materialized imported model exceeds the ${maxTriangles} triangle limit`);
      }
      mesh.getVertexPosition(ia, a).applyMatrix4(matrix);
      mesh.getVertexPosition(ib, b).applyMatrix4(matrix);
      mesh.getVertexPosition(ic, c).applyMatrix4(matrix);
      const left = a.clone();
      const middle = (reverse ? c : b).clone();
      const right = (reverse ? b : c).clone();
      const normal = new Vector3().subVectors(middle, left).cross(new Vector3().subVectors(right, left));
      if (normal.lengthSq() <= 1e-16) continue;
      normal.normalize();
      triangles.push({
        a: [left.x, left.y, left.z],
        b: [middle.x, middle.y, middle.z],
        c: [right.x, right.y, right.z],
        normal: [normal.x, normal.y, normal.z],
      });
    }
  }
  return negativeScaleBaked;
}

/** Bake a generic imported prop/scene model exactly as the viewport places it. */
export function materializeDirectorImportedModelMesh(
  project: DirectorProject,
  object: DirectorObject,
  asset: DirectorAssetRef,
  root: Object3D,
  maxTriangles: number,
): DirectorMaterializedModelMesh {
  if (object.kind === "character" || asset.kind === "character") {
    throw new Error("rigged character assets require pose-aware DCC export");
  }
  if (isDirectorSplatAssetFileName(asset.fileName)) {
    throw new Error("gaussian splat captures carry no triangle mesh and cannot be materialized for mesh export");
  }
  root.updateMatrixWorld(true);
  const normalization = getImportedModelNormalization(
    getPreciseImportedModelBounds(root),
    DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
    asset.modelNormalization ?? "auto",
    object.placementMode === "grounded",
    asset.realWorldSizeM,
  );
  const normalizationMatrix = new Matrix4().compose(
    new Vector3(...normalization.position),
    new Quaternion(),
    new Vector3(normalization.scale, normalization.scale, normalization.scale),
  );
  const stageMatrix = objectWorldMatrix(project, object).multiply(normalizationMatrix);
  const triangles: DirectorMeshTriangle[] = [];
  let negativeScaleBaked = false;
  let skinned = false;
  let meshCount = 0;

  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !hierarchyIsVisible(mesh, root) || !materialIsVisible(mesh.material)) return;
    meshCount += 1;
    skinned ||= Boolean((mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh);
    const matrix = stageMatrix.clone().multiply(mesh.matrixWorld);
    negativeScaleBaked ||= appendMeshTriangles(mesh, matrix, triangles, maxTriangles);
  });

  if (!meshCount) throw new Error("model contains no visible mesh nodes");
  if (!triangles.length) throw new Error("model contains no non-degenerate visible triangles");
  return { triangles, negativeScaleBaked, skinned, meshCount };
}

/**
 * Loads a Three.js Object3D from a Director asset reference.
 *
 * Dispatches to the correct loader based on the file extension.
 * Gaussian splat captures are rejected because they carry no triangle mesh.
 *
 * @param asset - The asset reference to load.
 * @returns The loaded Three.js object hierarchy.
 * @throws If the file format is unsupported or the asset is a splat.
 */
export async function loadDirectorImportedModelObject(asset: DirectorAssetRef): Promise<Object3D> {
  if (isDirectorSplatAssetFileName(asset.fileName)) {
    throw new Error("gaussian splat captures carry no triangle mesh and cannot be materialized for mesh export");
  }
  if (/\.fbx$/i.test(asset.fileName)) {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    return new FBXLoader().loadAsync(asset.url);
  }
  if (/\.obj$/i.test(asset.fileName)) {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    return new OBJLoader().loadAsync(asset.url);
  }
  if (/\.(glb|gltf)$/i.test(asset.fileName)) {
    const [{ GLTFLoader }, { configureDirectorGLTFLoader }] = await Promise.all([
      import("three/examples/jsm/loaders/GLTFLoader.js"),
      import("../runtime/gltfLoader"),
    ]);
    return (await configureDirectorGLTFLoader(new GLTFLoader()).loadAsync(asset.url)).scene;
  }
  throw new Error(`unsupported imported model extension: ${asset.fileName}`);
}
