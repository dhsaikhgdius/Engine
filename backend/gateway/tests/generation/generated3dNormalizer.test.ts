import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { normalizeGenerated3DGlb } from "../../generation/generated3dNormalizer";

async function sourceGlb() {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor("positions")
    .setType(Accessor.Type.VEC3)
    .setArray(new Float32Array([-1, 2, -1, 1, 2, -1, 0, 4, 1]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positions);
  const mesh = document.createMesh("ProviderMesh").addPrimitive(primitive);
  const camera = document.createCamera("ProviderCamera");
  const scene = document
    .createScene("ProviderScene")
    .addChild(document.createNode("MeshNode").setMesh(mesh))
    .addChild(document.createNode("CameraNode").setCamera(camera));
  document.getRoot().setDefaultScene(scene);
  return new NodeIO().writeBinary(document);
}

describe("generated 3D GLB normalization", () => {
  it("validates, centers, grounds, scales, strips cameras, and reports exact geometry", async () => {
    const result = await normalizeGenerated3DGlb(await sourceGlb(), {
      stableAssetId: "generated3d:job-1",
      targetHeightMeters: 2,
      providerId: "meshy",
      externalId: "meshy:text-preview:provider-1",
    });
    expect(Buffer.from(result.bytes.subarray(0, 4)).toString("ascii")).toBe("glTF");
    expect(result.report).toMatchObject({
      stableAssetId: "generated3d:job-1",
      targetHeightMeters: 2,
      appliedScale: 1,
      meshCount: 1,
      triangleCount: 1,
      removedCameraCount: 1,
      normalizedBounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    });
    expect(result.report.normalizedSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-GLB and geometry without measurable height", async () => {
    await expect(
      normalizeGenerated3DGlb(new TextEncoder().encode("not glb"), {
        stableAssetId: "generated3d:bad",
        targetHeightMeters: 1,
        providerId: "tripo",
        externalId: "tripo:task:bad",
      }),
    ).rejects.toThrow(/not a binary glTF/);
  });
});
