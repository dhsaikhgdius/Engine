import { estimateAssetRealWorldSize } from "../api/assetSizeClient";
import { uploadBlenderModelAsset } from "../api/blenderLiveClient";

/** `.zip` is a 4D gaussian splatting frame sequence the gateway unpacks on upload. */
const LOCAL_MODEL_EXTENSION_RE = /\.(fbx|obj|glb|gltf|ply|splat|ksplat|spz|sog|zip)$/i;

/**
 * Uploads a local model file to the gateway and returns its asset reference.
 *
 * Validates the file extension against the supported formats (FBX, OBJ, GLB,
 * GLTF, and Gaussian splat formats). ZIP files are treated as 4DGS frame
 * sequences and unpacked by the gateway.
 *
 * @param file - The local file selected by the user.
 * @returns The uploaded asset's id, fileName, display name, URL, and optional splat sequence info.
 * @throws If the file extension is not supported.
 */
export async function readLocalModelFile(file: File) {
  if (!LOCAL_MODEL_EXTENSION_RE.test(file.name)) {
    throw new Error(
      "当前仅支持 FBX / OBJ / GLB / GLTF 模型文件，PLY / SPLAT / KSPLAT / SPZ / SOG 高斯泼溅文件，以及 ZIP 泼溅帧序列",
    );
  }

  const id = crypto.randomUUID();
  const uploaded = await uploadBlenderModelAsset(file, file.name, id);
  return {
    id,
    fileName: uploaded.fileName,
    name: file.name.replace(LOCAL_MODEL_EXTENSION_RE, ""),
    url: uploaded.url,
    splatSequence: uploaded.splatSequence,
  };
}

/**
 * A locally imported model has no catalog size, so its display name is the only
 * description available for a metric estimate. Estimation is advisory and never
 * throws: an unreachable, unconfigured, or failing gateway resolves to null and
 * leaves the model on the legacy display normalization rather than costing the
 * user the import.
 */
export async function estimateLocalModelSizeM(
  name: string,
  options: { signal?: AbortSignal } = {},
): Promise<number | null> {
  const description = name.trim();
  if (!description) return null;
  try {
    return await estimateAssetRealWorldSize({ name: description }, options);
  } catch {
    return null;
  }
}
