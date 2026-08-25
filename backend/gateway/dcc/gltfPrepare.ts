import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";

let ioPromise: Promise<NodeIO> | null = null;

async function getNodeIo() {
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

/**
 * Parse and reserialize a runtime GLB with the official glTF Transform SDK.
 * Decoder-only dependencies cause Meshopt/Draco geometry to be emitted as
 * ordinary glTF buffers, which Blender can import without optional codecs.
 */
export async function prepareGltfForBlender(inputPath: string, outputPath: string): Promise<void> {
  const io = await getNodeIo();
  const document = await io.read(inputPath);
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (
      extension.extensionName === "EXT_meshopt_compression" ||
      extension.extensionName === "KHR_draco_mesh_compression"
    ) {
      extension.dispose();
    }
  }
  await io.write(outputPath, document);
}
