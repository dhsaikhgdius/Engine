// @vitest-environment node

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectorDccPortableExchangeFormat } from "@director/dcc-protocol";
import { directorDccProviderDescriptorSchema, getDirectorDccProviderDescriptor } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import {
  createDirectorDccExchangePackager,
  DirectorDccExchangePackageError,
  type CreateDirectorDccExchangePackagerOptions,
} from "../../dcc/dccExchangePackage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(
  overrides: Omit<Partial<CreateDirectorDccExchangePackagerOptions>, "workspaceRoot" | "dataDirectory"> = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "director-dcc-exchange-stress-"));
  roots.push(root);
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(root, "data");
  await mkdir(resolve(workspaceRoot, "assets", "library"), { recursive: true });
  await writeFile(resolve(workspaceRoot, "assets", "library", "chair.glb"), Buffer.from("glTF fixture bytes"));
  const project = createTestDirectorProject();
  project.scene.timeline = {
    version: 1,
    fps: 24,
    frameStart: 0,
    frameEnd: 120,
    currentFrame: 0,
    loop: false,
  };
  project.assets.push({
    id: "asset-chair",
    kind: "prop",
    sourceType: "model",
    fileName: "chair.glb",
    url: "/chair.glb",
  });
  project.objects.push({
    id: "chair-1",
    name: "Chair",
    kind: "prop",
    visible: true,
    locked: false,
    assetRefId: "asset-chair",
    transform: { position: [1, 0, -2], rotation: [0, 0.25, 0], scale: [1, 1, 1] },
  });
  return {
    root,
    workspaceRoot,
    dataDirectory,
    project,
    packager: createDirectorDccExchangePackager({ workspaceRoot, dataDirectory, ...overrides }),
  };
}

/** Point the fixture asset at a .gltf whose single buffer uses the given URI. */
async function useGltfWithDependencyUri(test: Awaited<ReturnType<typeof harness>>, uri: string) {
  const payload = Buffer.alloc(36);
  await writeFile(resolve(test.workspaceRoot, "assets", "library", "chair.bin"), payload);
  await writeFile(
    resolve(test.workspaceRoot, "assets", "library", "chair.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri, byteLength: payload.byteLength }],
    }),
  );
  test.project.assets[0]!.fileName = "chair.gltf";
  test.project.assets[0]!.url = "/chair.gltf";
}

async function expectNoStagingLeftovers(test: Awaited<ReturnType<typeof harness>>) {
  const exchangeRoot = resolve(test.dataDirectory, "dcc-jobs", "exchange");
  const providers = await readdir(exchangeRoot).catch(() => [] as string[]);
  for (const provider of providers) {
    const entries = await readdir(resolve(exchangeRoot, provider));
    expect(entries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  }
}

describe("DCC exchange package stress: malformed requests", () => {
  it("rejects unknown or non-portable requested formats with a structured 422", async () => {
    const test = await harness();
    for (const formats of [["fbx"], ["blend"], ["GLB"], [""], [42 as unknown as string], ["glb", "obj"]]) {
      await expect(
        test.packager.exportPackage(test.project, {
          provider: "maya",
          formats: formats as DirectorDccPortableExchangeFormat[],
        }),
      ).rejects.toMatchObject({
        name: "DirectorDccExchangePackageError",
        code: "dcc_exchange_format_unsupported",
        status: 422,
      });
    }
    await expectNoStagingLeftovers(test);
  });

  it("deduplicates repeated requested formats instead of producing duplicate artifacts", async () => {
    const test = await harness();
    const result = await test.packager.exportPackage(test.project, {
      provider: "maya",
      formats: ["glb", "glb"] as DirectorDccPortableExchangeFormat[],
    });
    expect(result.formats.map(({ format }) => format)).toEqual(["glb"]);
  });

  it("rejects NaN, Infinity, and out-of-range frames with dcc_exchange_frame_invalid", async () => {
    const test = await harness();
    for (const frame of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 121, 1e308]) {
      await expect(
        test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"], frame }),
      ).rejects.toMatchObject({
        name: "DirectorDccExchangePackageError",
        code: "dcc_exchange_frame_invalid",
        status: 422,
      });
    }
    await expectNoStagingLeftovers(test);
  });

  it("rejects a very long unknown camera id without crashing", async () => {
    const test = await harness();
    await expect(
      test.packager.exportPackage(test.project, {
        provider: "maya",
        formats: ["usda"],
        cameraId: "camera-".repeat(4_096),
      }),
    ).rejects.toMatchObject({ code: "dcc_exchange_camera_invalid", status: 422 });
  });

  it("rejects unknown providers and provider/descriptor mismatches with dcc_exchange_provider_invalid", async () => {
    const test = await harness();
    await expect(
      test.packager.exportPackage(test.project, { provider: "definitely.not.registered" }),
    ).rejects.toMatchObject({ code: "dcc_exchange_provider_invalid", status: 422 });

    const mismatched = directorDccProviderDescriptorSchema.parse(getDirectorDccProviderDescriptor("maya"));
    await expect(
      test.packager.exportPackage(test.project, { provider: "houdini", descriptor: mismatched }),
    ).rejects.toMatchObject({ code: "dcc_exchange_provider_invalid", status: 422 });

    await expect(
      test.packager.exportPackage(test.project, {
        provider: "studio.custom",
        descriptor: { id: "studio.custom", label: "" } as never,
      }),
    ).rejects.toMatchObject({ code: "dcc_exchange_provider_invalid", status: 422 });
    await expectNoStagingLeftovers(test);
  });

  it("rejects non-positive, non-integer, NaN, and Infinity budget overrides at construction", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-dcc-exchange-budget-"));
    roots.push(root);
    const build = (budgets: Record<string, number>) =>
      createDirectorDccExchangePackager({
        workspaceRoot: resolve(root, "workspace"),
        dataDirectory: resolve(root, "data"),
        budgets,
      });
    for (const budgets of [
      { maxAssets: 0 },
      { maxAssets: -1 },
      { maxFileBytes: Number.NaN },
      { maxPackageBytes: Number.POSITIVE_INFINITY },
      { maxConcurrentExports: 1.5 },
      { maxPackageBytes: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      expect(() => build(budgets)).toThrow(/positive safe integer/i);
    }
  });
});

describe("DCC exchange package stress: glTF dependency path safety", () => {
  const hostileUris: Array<[label: string, uri: string]> = [
    ["parent traversal", "../outside.bin"],
    ["nested traversal", "sub/../../outside.bin"],
    ["absolute path", "/etc/passwd"],
    ["percent-encoded traversal", "..%2Foutside.bin"],
    ["fully encoded traversal", "%2e%2e%2foutside.bin"],
    ["scheme URI", "file:///etc/passwd"],
    ["backslash path", "..\\outside.bin"],
    ["query string", "chair.bin?x=1"],
    ["fragment", "chair.bin#frag"],
    ["encoded null byte", "chair%00.bin"],
    ["dot segment", "./chair.bin"],
    ["empty segment", "sub//chair.bin"],
    ["windows drive", "C:/outside.bin"],
  ];

  it.each(hostileUris)("skips the asset for a %s dependency URI without publishing", async (_label, uri) => {
    const test = await harness();
    await useGltfWithDependencyUri(test, uri);
    const result = await test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] });
    expect(result.assets).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/could not be safely converted/i);
    await expectNoStagingLeftovers(test);
  });

  it("skips a dependency whose symlink escapes the asset directory", async () => {
    const test = await harness();
    const outside = resolve(test.root, "outside-secret.bin");
    await writeFile(outside, Buffer.alloc(16));
    await symlink(outside, resolve(test.workspaceRoot, "assets", "library", "linked.bin"));
    await useGltfWithDependencyUri(test, "linked.bin");
    const result = await test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] });
    expect(result.assets).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/escaped its asset directory/i);
  });

  it("skips malformed and deeply nested (JSON bomb) glTF sources instead of failing the package", async () => {
    const invalidJson = await harness();
    await useGltfWithDependencyUri(invalidJson, "chair.bin");
    await writeFile(resolve(invalidJson.workspaceRoot, "assets", "library", "chair.gltf"), "not json {{{");
    const invalidResult = await invalidJson.packager.exportPackage(invalidJson.project, {
      provider: "maya",
      formats: ["usda"],
    });
    expect(invalidResult.assets).toEqual([]);
    expect(invalidResult.warnings.join(" ")).toMatch(/could not be safely converted/i);

    const bomb = await harness();
    await useGltfWithDependencyUri(bomb, "chair.bin");
    const depth = 200_000;
    await writeFile(
      resolve(bomb.workspaceRoot, "assets", "library", "chair.gltf"),
      "[".repeat(depth) + "]".repeat(depth),
    );
    const bombResult = await bomb.packager.exportPackage(bomb.project, { provider: "maya", formats: ["usda"] });
    expect(bombResult.assets).toEqual([]);
    expect(bombResult.warnings.join(" ")).toMatch(/could not be safely converted/i);
    await expectNoStagingLeftovers(bomb);
  });

  it("fails the whole package (not a skip) when glTF dependencies blow the read budget", async () => {
    const test = await harness({ budgets: { maxPackageBytes: 64 } });
    await useGltfWithDependencyUri(test, "chair.bin");
    await expect(
      test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] }),
    ).rejects.toMatchObject({ code: "dcc_exchange_budget_exceeded", status: 422 });
    await expectNoStagingLeftovers(test);
  });
});

describe("DCC exchange package stress: volume and concurrency", () => {
  it("reports budget violations and busy states with distinct structured codes", async () => {
    const total = await harness({ budgets: { maxPackageBytes: 1 } });
    await expect(
      total.packager.exportPackage(total.project, { provider: "maya", formats: ["usda"] }),
    ).rejects.toMatchObject({ code: "dcc_exchange_budget_exceeded", status: 422 });

    const notReady = await harness();
    await expect(
      notReady.packager.exportPackage(notReady.project, { provider: "maya", exchangeReady: false }),
    ).rejects.toMatchObject({ code: "dcc_exchange_unavailable", status: 409 });
  });

  it("releases the concurrency slot after a failed export", async () => {
    const test = await harness({ budgets: { maxConcurrentExports: 1 } });
    await expect(
      test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"], cameraId: "missing" }),
    ).rejects.toMatchObject({ code: "dcc_exchange_camera_invalid" });
    await expect(
      test.packager.exportPackage(test.project, { provider: "maya", formats: ["usda"] }),
    ).resolves.toMatchObject({ provider: "maya" });
  });

  it("isolates parallel exports: distinct job ids, package directories, and digests per provider", async () => {
    const test = await harness({ budgets: { maxConcurrentExports: 8 } });
    const providers = ["maya", "houdini", "cinema4d", "unreal"] as const;
    const results = await Promise.all(
      providers.map((provider) => test.packager.exportPackage(test.project, { provider, formats: ["usda"] })),
    );
    const jobIds = new Set(results.map((result) => result.jobId));
    const packagePaths = new Set(results.map((result) => result.packagePath));
    expect(jobIds.size).toBe(providers.length);
    expect(packagePaths.size).toBe(providers.length);
    for (const [index, result] of results.entries()) {
      expect(result.provider).toBe(providers[index]);
      expect(result.packagePath).toContain(providers[index]);
      expect(result.sourceRevision).toBe(results[0]!.sourceRevision);
    }
    await expectNoStagingLeftovers(test);
  });

  it("throws the raw budget error class for oversized packages so HTTP layers can map it", async () => {
    const test = await harness({ budgets: { maxFileBytes: 4 } });
    const failure = await test.packager
      .exportPackage(test.project, { provider: "maya", formats: ["usda"] })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DirectorDccExchangePackageError);
    expect(failure).toMatchObject({ status: 422, code: "dcc_exchange_budget_exceeded" });
  });
});

describe("DCC exchange package stress: format honesty per engine", () => {
  it("rejects portable formats an engine does not advertise (godot is GLB-only)", async () => {
    const test = await harness();
    await expect(
      test.packager.exportPackage(test.project, {
        provider: "godot",
        formats: ["usda"] as DirectorDccPortableExchangeFormat[],
      }),
    ).rejects.toMatchObject({ code: "dcc_exchange_format_unsupported", status: 422 });
  });

  it("orders default formats by the provider's declared preference", async () => {
    const test = await harness();
    const unreal = await test.packager.exportPackage(test.project, { provider: "unreal" });
    expect(unreal.formats.map(({ format }) => format)).toEqual(["usda", "glb"]);
    const unity = await test.packager.exportPackage(test.project, { provider: "unity" });
    expect(unity.formats.map(({ format }) => format)).toEqual(["glb", "usda"]);
    const godot = await test.packager.exportPackage(test.project, { provider: "godot" });
    expect(godot.formats.map(({ format }) => format)).toEqual(["glb"]);
  });

  it("rejects descriptors that advertise no portable format at all", async () => {
    const test = await harness();
    const blendOnly = directorDccProviderDescriptorSchema.parse({
      id: "studio.native",
      label: "Studio Native",
      category: "dcc",
      integration: "exchange-package",
      preferredFormat: "blend",
      exchangeFormats: ["blend"],
      capabilities: [{ id: "scene", level: "exchange" }],
      connectorDirectory: "integrations/studio.native",
    });
    await expect(
      test.packager.exportPackage(test.project, { provider: blendOnly.id, descriptor: blendOnly }),
    ).rejects.toMatchObject({ code: "dcc_exchange_format_unsupported", status: 422 });
  });
});
