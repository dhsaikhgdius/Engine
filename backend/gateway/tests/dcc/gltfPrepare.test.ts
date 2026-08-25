import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { localAssetDescribe } from "../../../../packages/protocol/tests/localAssetTest";
import { prepareGltfForBlender } from "../../dcc/gltfPrepare";

localAssetDescribe("Blender glTF preparation", () => {
  let temporaryDirectory = "";

  afterEach(async () => {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("decodes a Meshopt runtime GLB into a Blender-compatible GLB", async () => {
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), "director-gltf-"));
    const source = resolve(process.cwd(), "assets", "library", "mixamo-characters", "models", "mannequin.glb");
    const output = resolve(temporaryDirectory, "mannequin.blender.glb");
    const compressed = await readFile(source);
    expect(compressed.includes(Buffer.from("EXT_meshopt_compression"))).toBe(true);

    await prepareGltfForBlender(source, output);

    const prepared = await readFile(output);
    expect(prepared.byteLength).toBeGreaterThan(1_000);
    expect(prepared.includes(Buffer.from("EXT_meshopt_compression"))).toBe(false);
  });
});
