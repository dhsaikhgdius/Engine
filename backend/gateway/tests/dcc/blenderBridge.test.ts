import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildDirectorDccScenePackage } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { resolveDccModelAsset } from "../../dcc/blenderBridge";

const temporaryRoots: string[] = [];

async function assetFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "director-blender-assets-"));
  temporaryRoots.push(root);
  const physicalWorkspace = resolve(root, "physical-workspace");
  const aliasWorkspace = resolve(root, "workspace-alias");
  const libraryRoot = resolve(physicalWorkspace, "assets", "library");
  const generatedRoot = resolve(physicalWorkspace, "assets", "generated", "dcc-import");
  await Promise.all([
    mkdir(resolve(libraryRoot, "models"), { recursive: true }),
    mkdir(resolve(generatedRoot, "return-hash"), { recursive: true }),
  ]);
  await symlink(physicalWorkspace, aliasWorkspace, "dir");
  return { root, physicalWorkspace, aliasWorkspace, libraryRoot, generatedRoot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Blender bridge local asset resolution", () => {
  it("compares canonical roots so an aliased workspace does not look like a path escape", async () => {
    const setup = await assetFixture();
    const model = resolve(setup.libraryRoot, "models", "chair.glb");
    await writeFile(model, "library fixture");

    await expect(resolveDccModelAsset(setup.aliasWorkspace, "/models/chair.glb")).resolves.toEqual({
      status: "resolved",
      sourcePath: await realpath(model),
    });
    await expect(resolveDccModelAsset(setup.aliasWorkspace, "/assets/library/models/chair.glb")).resolves.toEqual({
      status: "resolved",
      sourcePath: await realpath(model),
    });
  });

  it("resolves an immutable Blender return asset for a subsequent DCC export", async () => {
    const setup = await assetFixture();
    const returnedModel = resolve(setup.generatedRoot, "return-hash", "chair-refined.glb");
    await writeFile(returnedModel, "returned GLB fixture");
    const resolution = await resolveDccModelAsset(
      setup.aliasWorkspace,
      "/dcc-import/return-hash/chair-refined.glb?immutable=1",
    );

    const project = createTestDirectorProject();
    project.assets.push({
      id: "asset-chair-refined",
      kind: "prop",
      sourceType: "model",
      fileName: "chair-refined.glb",
      url: "/dcc-import/return-hash/chair-refined.glb",
      assetSource: "local",
    });
    project.objects.push({
      id: "chair",
      name: "Chair refined",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "asset-chair-refined",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const scenePackage = buildDirectorDccScenePackage(project, { resolveAsset: () => resolution });

    expect(resolution).toEqual({ status: "resolved", sourcePath: await realpath(returnedModel) });
    expect(scenePackage.assets).toContainEqual(
      expect.objectContaining({
        id: "asset-chair-refined",
        status: "resolved",
        sourcePath: await realpath(returnedModel),
      }),
    );
    expect(scenePackage.objects).toContainEqual(
      expect.objectContaining({ id: "chair", sourcePath: await realpath(returnedModel) }),
    );
  });

  it.each([
    "/models/%2e%2e/%2e%2e/outside.glb",
    "/dcc-import/%2e%2e/outside.glb",
    "/models/%5c..%5coutside.glb",
    "//outside.test/model.glb",
  ])("rejects unsafe local asset URL %s", async (url) => {
    const setup = await assetFixture();
    await expect(resolveDccModelAsset(setup.aliasWorkspace, url)).resolves.toMatchObject({ status: "unsupported" });
  });

  it("rejects symlinks escaping either allowed asset root", async () => {
    const setup = await assetFixture();
    const outside = resolve(setup.root, "outside.glb");
    await writeFile(outside, "outside fixture");
    await Promise.all([
      symlink(outside, resolve(setup.libraryRoot, "models", "escaped.glb")),
      symlink(outside, resolve(setup.generatedRoot, "return-hash", "escaped.glb")),
    ]);

    await expect(resolveDccModelAsset(setup.aliasWorkspace, "/models/escaped.glb")).resolves.toMatchObject({
      status: "unsupported",
      message: expect.stringContaining("symlink escaped assets/library"),
    });
    await expect(
      resolveDccModelAsset(setup.aliasWorkspace, "/dcc-import/return-hash/escaped.glb"),
    ).resolves.toMatchObject({
      status: "unsupported",
      message: expect.stringContaining("symlink escaped assets/generated/dcc-import"),
    });
  });
});
