import { createHash } from "node:crypto";
import { NodeIO, getBounds, type Document, type Scene } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import {
  DIRECTOR_GENERATED_3D_CONTRACT,
  DIRECTOR_GENERATED_3D_MAX_TRIANGLES,
  generated3dNormalizationReportSchema,
  type Generated3DNormalizationReport,
} from "../../../packages/protocol/src/generated3dProtocol";

let ioPromise: Promise<NodeIO> | null = null;

async function nodeIo() {
  if (!ioPromise) {
    ioPromise = Promise.all([MeshoptDecoder.ready, draco3d.createDecoderModule()]).then(([, dracoDecoder]) =>
      new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        "draco3d.decoder": dracoDecoder,
        "meshopt.decoder": MeshoptDecoder,
      }),
    );
  }
  return ioPromise;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function tuple(value: readonly number[]): [number, number, number] {
  if (value.length < 3 || value.slice(0, 3).some((part) => !Number.isFinite(part))) {
    throw new Error("Generated GLB has non-finite scene bounds");
  }
  return [value[0]!, value[1]!, value[2]!];
}

function bounds(scene: Scene) {
  const value = getBounds(scene);
  return { min: tuple(value.min), max: tuple(value.max) };
}

function primitiveElementCount(document: Document) {
  let triangles = 0;
  let unsupported = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const count = primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      if (primitive.getMode() === 4) triangles += Math.floor(count / 3);
      else if (primitive.getMode() === 5 || primitive.getMode() === 6) triangles += Math.max(0, count - 2);
      else unsupported += 1;
    }
  }
  return { triangles, unsupported };
}

function ensureDefaultScene(document: Document) {
  const root = document.getRoot();
  const existing = root.getDefaultScene() ?? root.listScenes()[0];
  if (existing) {
    root.setDefaultScene(existing);
    return existing;
  }
  const scene = document.createScene("DirectorGeneratedAssetScene");
  root
    .listNodes()
    .filter((node) => !node.getParentNode())
    .forEach((node) => scene.addChild(node));
  root.setDefaultScene(scene);
  return scene;
}

/** Options for normalising a generated 3D GLB asset. */
export type NormalizeGenerated3DGlbOptions = {
  /** Stable identifier for the asset within the Director system. */
  stableAssetId: string;
  /** Target height in meters after scaling. */
  targetHeightMeters: number;
  /** Identifier of the provider that generated the asset. */
  providerId: string;
  /** Provider-assigned external identifier for the asset. */
  externalId: string;
};

/**
 * Normalises a generated 3D GLB asset for Director's Stage runtime.
 *
 * Validates the input as a binary glTF 2.0 file, ensures a default scene,
 * scales the asset to the target height in meters, centres it at ground
 * level, removes camera nodes and compression extensions, and produces a
 * normalisation report with warnings for any non-reversible changes.
 *
 * @param input - The raw GLB bytes to normalise.
 * @param options - Normalisation parameters including asset identity and target height.
 * @returns The normalised GLB bytes and a structured normalisation report.
 * @throws When the input is not a valid GLB, has no measurable height,
 *         contains no triangle geometry, or exceeds the triangle limit.
 */
export async function normalizeGenerated3DGlb(input: Uint8Array, options: NormalizeGenerated3DGlbOptions) {
  if (input.byteLength < 20 || Buffer.from(input.subarray(0, 4)).toString("ascii") !== "glTF") {
    throw new Error("Generated model is not a binary glTF 2.0 file");
  }
  const io = await nodeIo();
  const document = await io.readBinary(input);
  const root = document.getRoot();
  const scene = ensureDefaultScene(document);
  const sourceBounds = bounds(scene);
  const sourceHeight = sourceBounds.max[1] - sourceBounds.min[1];
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 1e-6) {
    throw new Error("Generated GLB has no measurable Y-axis height");
  }
  const { triangles, unsupported } = primitiveElementCount(document);
  if (!triangles) throw new Error("Generated GLB contains no triangle mesh geometry");
  if (triangles > DIRECTOR_GENERATED_3D_MAX_TRIANGLES) {
    throw new Error(`Generated GLB exceeds the ${DIRECTOR_GENERATED_3D_MAX_TRIANGLES} triangle limit`);
  }

  const warnings: string[] = [];
  if (unsupported)
    warnings.push(`${unsupported} non-triangle primitive(s) remain outside the normalized triangle count.`);
  if (root.listAnimations().length)
    warnings.push("Animation clips are retained but are not promoted as Stage timeline actions.");
  if (root.listSkins().length)
    warnings.push("Skin data is retained but generated assets are promoted as props, not characters.");
  const extraScenes = root.listScenes().filter((candidate) => candidate !== scene);
  if (extraScenes.length) {
    warnings.push(`${extraScenes.length} non-default scene(s) were removed during single-asset normalization.`);
    extraScenes.forEach((candidate) => candidate.dispose());
  }

  let removedCameraCount = 0;
  for (const node of root.listNodes()) {
    if (!node.getCamera()) continue;
    node.setCamera(null);
    removedCameraCount += 1;
  }
  root.listCameras().forEach((camera) => camera.dispose());
  if (removedCameraCount)
    warnings.push(`${removedCameraCount} provider camera(s) were removed from the promoted asset.`);

  const decodedCompressionExtensions: Array<"EXT_meshopt_compression" | "KHR_draco_mesh_compression"> = [];
  for (const extension of root.listExtensionsUsed()) {
    if (
      extension.extensionName === "EXT_meshopt_compression" ||
      extension.extensionName === "KHR_draco_mesh_compression"
    ) {
      decodedCompressionExtensions.push(extension.extensionName);
      extension.dispose();
    }
  }

  const appliedScale = options.targetHeightMeters / sourceHeight;
  const wrapper = document
    .createNode(options.stableAssetId)
    .setScale([appliedScale, appliedScale, appliedScale])
    .setTranslation([
      -((sourceBounds.min[0] + sourceBounds.max[0]) / 2) * appliedScale,
      -sourceBounds.min[1] * appliedScale,
      -((sourceBounds.min[2] + sourceBounds.max[2]) / 2) * appliedScale,
    ])
    .setExtras({
      director: {
        contract: DIRECTOR_GENERATED_3D_CONTRACT,
        stableAssetId: options.stableAssetId,
        providerId: options.providerId,
        externalId: options.externalId,
        normalizedToMeters: true,
        groundedAtY: 0,
      },
    });
  for (const child of [...scene.listChildren()]) wrapper.addChild(child);
  scene.addChild(wrapper);
  scene.setName("DirectorGeneratedAssetScene");
  root.setDefaultScene(scene);
  const asset = root.getAsset();
  asset.generator = [asset.generator, "Director generated 3D normalizer v1"].filter(Boolean).join("; ");

  const normalizedBounds = bounds(scene);
  const normalized = await io.writeBinary(document);
  const reportBase = {
    contract: DIRECTOR_GENERATED_3D_CONTRACT,
    adapter: "director-generated-3d-normalizer-v1" as const,
    stableAssetId: options.stableAssetId,
    sourceSha256: sha256(input),
    normalizedSha256: sha256(normalized),
    coordinateSystem: {
      linearUnit: "meter" as const,
      metersPerUnit: 1 as const,
      upAxis: "Y" as const,
      handedness: "right" as const,
    },
    targetHeightMeters: options.targetHeightMeters,
    appliedScale,
    sourceBounds,
    normalizedBounds,
    nodeCount: root.listNodes().length,
    meshCount: root.listMeshes().length,
    materialCount: root.listMaterials().length,
    triangleCount: triangles,
    animationCount: root.listAnimations().length,
    skinCount: root.listSkins().length,
    removedCameraCount,
    decodedCompressionExtensions,
    warnings,
  };
  const report: Generated3DNormalizationReport = generated3dNormalizationReportSchema.parse(reportBase);
  return { bytes: normalized, report };
}
