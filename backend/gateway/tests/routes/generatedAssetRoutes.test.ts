import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { handleGeneratedAssetRoute } from "../../routes/generatedAssetRoutes";

const temporaryRoots: string[] = [];

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function response() {
  const writeHead = vi.fn();
  const end = vi.fn();
  return { value: { writeHead, end } as unknown as ServerResponse, writeHead, end };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("serves immutable generated GLBs from the generated asset root", async () => {
  const generatedRoot = await mkdtemp(resolve(tmpdir(), "director-generated-assets-"));
  temporaryRoots.push(generatedRoot);
  const directory = resolve(generatedRoot, "dcc-import", "package-hash");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("glTF generated fixture");
  await writeFile(resolve(directory, "hero.glb"), bytes);
  const output = response();

  expect(
    await handleGeneratedAssetRoute(
      request("GET"),
      output.value,
      new URL("http://test/dcc-import/package-hash/hero.glb"),
      generatedRoot,
    ),
  ).toBe(true);
  expect(output.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({
      "content-type": "model/gltf-binary",
      "cache-control": "public, max-age=31536000, immutable",
    }),
  );
  expect(output.end).toHaveBeenCalledWith(bytes);
});

it("serves content-addressed generated 3D models and thumbnails before gateway auth", async () => {
  const generatedRoot = await mkdtemp(resolve(tmpdir(), "director-generated-assets-"));
  temporaryRoots.push(generatedRoot);
  const digest = "a".repeat(64);
  const directory = resolve(generatedRoot, "generated-3d", digest);
  await mkdir(directory, { recursive: true });
  const model = Buffer.from("glTF generated model");
  const thumbnail = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(resolve(directory, "model.glb"), model);
  await writeFile(resolve(directory, "thumbnail.png"), thumbnail);

  const modelOutput = response();
  expect(
    await handleGeneratedAssetRoute(
      request("GET"),
      modelOutput.value,
      new URL(`http://test/generated-3d/${digest}/model.glb`),
      generatedRoot,
    ),
  ).toBe(true);
  expect(modelOutput.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({ "content-type": "model/gltf-binary" }),
  );
  expect(modelOutput.end).toHaveBeenCalledWith(model);

  const thumbnailOutput = response();
  await handleGeneratedAssetRoute(
    request("GET"),
    thumbnailOutput.value,
    new URL(`http://test/generated-3d/${digest}/thumbnail.png`),
    generatedRoot,
  );
  expect(thumbnailOutput.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-type": "image/png" }));
  expect(thumbnailOutput.end).toHaveBeenCalledWith(thumbnail);
});

it("serves uploaded native model sources to Blender", async () => {
  const generatedRoot = await mkdtemp(resolve(tmpdir(), "director-generated-assets-"));
  temporaryRoots.push(generatedRoot);
  const directoryId = "asset-bWl4YW1vOngtYm90";
  const directory = resolve(generatedRoot, "native-models", directoryId);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from("native OBJ fixture");
  await writeFile(resolve(directory, "hero chair.obj"), bytes);
  const output = response();

  expect(
    await handleGeneratedAssetRoute(
      request("GET"),
      output.value,
      new URL(`http://test/native-models/${directoryId}/hero%20chair.obj`),
      generatedRoot,
    ),
  ).toBe(true);
  expect(output.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({ "content-type": "text/plain; charset=utf-8" }),
  );
  expect(output.end).toHaveBeenCalledWith(bytes);
});

it("serves gaussian splat captures, sequence frames, and the sequence manifest", async () => {
  const generatedRoot = await mkdtemp(resolve(tmpdir(), "director-generated-assets-"));
  temporaryRoots.push(generatedRoot);
  const directoryId = "asset-Y2FwdHVyZTpkYW5jZQ";
  const directory = resolve(generatedRoot, "native-models", directoryId);
  await mkdir(resolve(directory, "frames"), { recursive: true });
  const splat = Buffer.from("spz capture fixture");
  const frame = Buffer.from("spz frame fixture");
  const manifest = Buffer.from('{"format":"director-splat-sequence@1"}');
  await writeFile(resolve(directory, "garden.spz"), splat);
  await writeFile(resolve(directory, "frames", "frame-00001.spz"), frame);
  await writeFile(resolve(directory, "dance.4dgs.json"), manifest);

  const splatOutput = response();
  expect(
    await handleGeneratedAssetRoute(
      request("GET"),
      splatOutput.value,
      new URL(`http://test/native-models/${directoryId}/garden.spz`),
      generatedRoot,
    ),
  ).toBe(true);
  expect(splatOutput.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({ "content-type": "application/octet-stream" }),
  );
  expect(splatOutput.end).toHaveBeenCalledWith(splat);

  const frameOutput = response();
  await handleGeneratedAssetRoute(
    request("GET"),
    frameOutput.value,
    new URL(`http://test/native-models/${directoryId}/frames/frame-00001.spz`),
    generatedRoot,
  );
  expect(frameOutput.end).toHaveBeenCalledWith(frame);

  const manifestOutput = response();
  await handleGeneratedAssetRoute(
    request("GET"),
    manifestOutput.value,
    new URL(`http://test/native-models/${directoryId}/dance.4dgs.json`),
    generatedRoot,
  );
  expect(manifestOutput.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({ "content-type": "application/json; charset=utf-8" }),
  );
  expect(manifestOutput.end).toHaveBeenCalledWith(manifest);
});

it.each([
  ["POST", "/dcc-import/package-hash/hero.glb", 405],
  ["GET", "/dcc-import/package-hash/hero.txt", 400],
  ["GET", "/dcc-import/package-hash%2F..%2Fhero.glb", 400],
  ["GET", "/native-models/asset-abc/frames/nested/frame-00001.spz", 400],
  ["GET", "/native-models/asset-abc/other/frame-00001.spz", 400],
  ["GET", "/native-models/asset-abc/manifest.json", 400],
] as const)("rejects unsafe generated asset requests", async (method, pathname, status) => {
  const output = response();
  expect(
    await handleGeneratedAssetRoute(request(method), output.value, new URL(`http://test${pathname}`), "unused"),
  ).toBe(true);
  expect(output.writeHead).toHaveBeenCalledWith(status, expect.any(Object));
});

it("ignores unrelated routes", async () => {
  const output = response();
  expect(await handleGeneratedAssetRoute(request("GET"), output.value, new URL("http://test/health"), "unused")).toBe(
    false,
  );
  expect(output.writeHead).not.toHaveBeenCalled();
});
