// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import type { DirectorEngineSceneManifestV1, DirectorEngineSceneProvider } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { createEngineSceneImporter, type EngineSceneImporter } from "../../dcc/engineSceneImport";

const DEFAULT_BUNDLE = Buffer.from("deterministic engine scene GLB fixture");

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

function buildManifest(
  provider: DirectorEngineSceneProvider,
  bundle: Buffer | null,
  overrides: Partial<DirectorEngineSceneManifestV1> = {},
): DirectorEngineSceneManifestV1 {
  return {
    schemaVersion: 1,
    contract: "director-engine-scene-v1",
    packageId: `${provider}-scene-stress`,
    provider,
    exportedAt: "2026-08-25T00:00:00.000Z",
    engineVersion: provider === "unreal" ? "5.6.1" : "6000.0.82f1",
    exporter: { name: `director-${provider}-scene-export`, version: "1.0.0" },
    source: { projectName: "Stress", sceneName: "Set" },
    coordinateSystem:
      provider === "unreal"
        ? {
            source: "left-handed-z-up-x-forward-centimeter",
            destination: "right-handed-y-up-negative-z-forward",
            unit: "meter",
            linearMap: "(x,y,z)->(y,z,-x)*0.01",
          }
        : {
            source: "left-handed-y-up-z-forward-meter",
            destination: "right-handed-y-up-negative-z-forward",
            unit: "meter",
            linearMap: "(x,y,z)->(-x,y,z)",
          },
    timeline: { frameStart: 0, frameEnd: 0, currentFrame: 0, fps: 30 },
    scene: {
      name: "Set",
      bundleFile: bundle ? "assets/scene.glb" : null,
      nodeCount: 0,
      meshCount: bundle ? 1 : 0,
      skinnedMeshCount: 0,
      materialCount: 1,
      animationClipCount: 0,
    },
    nodes: [],
    cameras: [
      {
        sourceId: "camera-main",
        name: "Main Camera",
        position: [0, 1.7, 5],
        lookTarget: [0, 1.5, 0],
        verticalFovDegrees: 35,
        nearClipM: 0.1,
        farClipM: 10_000,
        renderAspectRatio: 16 / 9,
      },
    ],
    lights: [],
    animationClips: [],
    unsupported: [],
    warnings: [],
    fileHashes: bundle ? { "assets/scene.glb": digest(bundle) } : {},
    ...overrides,
  };
}

async function buildZip(
  manifest: DirectorEngineSceneManifestV1 | string,
  files: Record<string, Buffer> = { "assets/scene.glb": DEFAULT_BUNDLE },
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("manifest.json", typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) zip.file(name, contents);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

interface Harness {
  root: string;
  workspaceRoot: string;
  dataDirectory: string;
  jobRoot: string;
  project: DirectorProject;
  importer: EngineSceneImporter;
}

async function createHarness(
  options: { maxUploadBytes?: number; maxExtractedBytes?: number } = {},
): Promise<Harness> {
  const root = await mkdtemp(resolve(tmpdir(), "director-engine-scene-stress-"));
  temporaryRoots.push(root);
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(root, "data");
  await mkdir(workspaceRoot, { recursive: true });
  const importer = createEngineSceneImporter({
    workspaceRoot,
    dataDirectory,
    environment: { PATH: "" },
    maxUploadBytes: options.maxUploadBytes,
    maxExtractedBytes: options.maxExtractedBytes,
  });
  return {
    root,
    workspaceRoot,
    dataDirectory,
    jobRoot: resolve(dataDirectory, "dcc-jobs", "engine-import"),
    project: createTestDirectorProject(),
    importer,
  };
}

/** Write an extracted package directly into the job root and return its packageDir. */
async function writePackage(
  harness: Harness,
  manifest: DirectorEngineSceneManifestV1 | string | Record<string, unknown>,
  files: Record<string, Buffer> = { "assets/scene.glb": DEFAULT_BUNDLE },
  jobId = "stress-job",
): Promise<string> {
  const packageDirectory = resolve(harness.jobRoot, jobId, "package");
  await mkdir(resolve(packageDirectory, "assets"), { recursive: true });
  await writeFile(
    resolve(packageDirectory, "manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  for (const [name, contents] of Object.entries(files)) {
    const destination = resolve(packageDirectory, name);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, contents);
  }
  return `${jobId}/package`;
}

describe("engine scene import stress: malformed manifests", () => {
  it("rejects manifests with missing fields, wrong contracts, and illegal enums", async () => {
    const harness = await createHarness();
    const base = buildManifest("unity", DEFAULT_BUNDLE);

    const cases: Array<Record<string, unknown>> = [
      (({ contract: _drop, ...rest }) => rest)(base as unknown as Record<string, unknown>),
      { ...base, contract: "director-engine-scene-v2" },
      { ...base, schemaVersion: 2 },
      { ...base, provider: "godot" },
      { ...base, provider: "blender" },
      { ...base, nodes: [{ sourceId: "n", name: "n", kind: "hologram", transform: base.nodes[0]?.transform }] },
      { ...base, extraField: true },
    ];
    for (const manifest of cases) {
      const packageDir = await writePackage(harness, manifest, { "assets/scene.glb": DEFAULT_BUNDLE }, digest(JSON.stringify(manifest)).slice(0, 12));
      await expect(harness.importer.validatePackage("unity", packageDir)).rejects.toMatchObject({
        code: "package_invalid",
      });
    }
  });

  it("rejects non-finite numbers that JSON can smuggle in as 1e999", async () => {
    const harness = await createHarness();
    const raw = JSON.stringify(buildManifest("unity", DEFAULT_BUNDLE)).replace(
      '"position":[0,1.7,5]',
      '"position":[1e999,1.7,5]',
    );
    expect(raw).toContain("1e999");
    const packageDir = await writePackage(harness, raw);
    await expect(harness.importer.validatePackage("unity", packageDir)).rejects.toMatchObject({
      code: "package_invalid",
    });
  });

  it("rejects oversized strings, oversized arrays, and manifests above the byte cap", async () => {
    const harness = await createHarness();
    const longId = buildManifest("unity", DEFAULT_BUNDLE, { packageId: "p".repeat(4_096) });
    await expect(
      harness.importer.validatePackage("unity", await writePackage(harness, longId, undefined, "long-id")),
    ).rejects.toMatchObject({ code: "package_invalid" });

    const manyWarnings = buildManifest("unity", DEFAULT_BUNDLE, {
      warnings: Array.from({ length: 20_001 }, (_, index) => `w${index}`),
    });
    await expect(
      harness.importer.validatePackage("unity", await writePackage(harness, manyWarnings, undefined, "many-warnings")),
    ).rejects.toMatchObject({ code: "package_invalid" });

    const oversized = JSON.stringify(
      buildManifest("unity", DEFAULT_BUNDLE, { warnings: ["x".repeat(1_999)] }),
    ).replace('"x', `"${"x".repeat(9 * 1024 * 1024)}`);
    await expect(
      harness.importer.validatePackage("unity", await writePackage(harness, oversized, undefined, "oversized")),
    ).rejects.toMatchObject({ code: "package_invalid", message: expect.stringMatching(/no larger than/) });
  });

  it("rejects a deeply nested JSON bomb without crashing the process", async () => {
    const harness = await createHarness();
    const depth = 200_000;
    const bomb = "[".repeat(depth) + "]".repeat(depth);
    const packageDir = await writePackage(harness, bomb, {}, "nested-bomb");
    await expect(harness.importer.validatePackage("unity", packageDir)).rejects.toMatchObject({
      code: "package_invalid",
    });
  });

  it("rejects cross-provider coordinate-system claims and provider mismatches", async () => {
    const harness = await createHarness();
    const lyingCoordinates = {
      ...buildManifest("unity", DEFAULT_BUNDLE),
      coordinateSystem: buildManifest("unreal", DEFAULT_BUNDLE).coordinateSystem,
    };
    await expect(
      harness.importer.validatePackage("unity", await writePackage(harness, lyingCoordinates, undefined, "lying-coords")),
    ).rejects.toMatchObject({ code: "package_invalid" });

    const unrealManifest = buildManifest("unreal", DEFAULT_BUNDLE);
    await expect(
      harness.importer.validatePackage("unity", await writePackage(harness, unrealManifest, undefined, "cross")),
    ).rejects.toMatchObject({ code: "package_invalid", status: 409 });
  });

  it("rejects degenerate cameras: zero FOV (orthographic-style), coincident look target, inverted clip planes", async () => {
    const harness = await createHarness();
    const base = buildManifest("unity", DEFAULT_BUNDLE);
    const camera = base.cameras[0]!;
    const cases: Array<Partial<typeof camera>> = [
      { verticalFovDegrees: 0 },
      { verticalFovDegrees: 180 },
      { lookTarget: [...camera.position] as [number, number, number] },
      { nearClipM: 10, farClipM: 10 },
      { nearClipM: -1 },
    ];
    for (const [index, override] of cases.entries()) {
      const manifest = { ...base, cameras: [{ ...camera, ...override }] };
      await expect(
        harness.importer.validatePackage(
          "unity",
          await writePackage(harness, manifest, undefined, `camera-${index}`),
        ),
      ).rejects.toMatchObject({ code: "package_invalid" });
    }
  });

  it("rejects structural lies: bundle without hash, geometry without bundle, duplicate and self-parenting nodes", async () => {
    const harness = await createHarness();
    const identity = {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    const base = buildManifest("unity", DEFAULT_BUNDLE);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bundle without hash entry", { ...base, fileHashes: {} }],
      [
        "geometry without a bundle",
        { ...base, scene: { ...base.scene, bundleFile: null }, fileHashes: {} },
      ],
      [
        "duplicate node sourceId",
        {
          ...base,
          scene: { ...base.scene, nodeCount: 2 },
          nodes: [
            { sourceId: "twin", name: "A", kind: "group", transform: identity },
            { sourceId: "twin", name: "B", kind: "group", transform: identity },
          ],
        },
      ],
      [
        "self-parenting node",
        {
          ...base,
          scene: { ...base.scene, nodeCount: 1 },
          nodes: [{ sourceId: "loop", name: "Loop", parentSourceId: "loop", kind: "group", transform: identity }],
        },
      ],
      [
        "duplicate camera sourceId",
        { ...base, cameras: [base.cameras[0]!, { ...base.cameras[0]! }] },
      ],
    ];
    for (const [label, manifest] of cases) {
      await expect(
        harness.importer.validatePackage(
          "unity",
          await writePackage(harness, manifest, undefined, digest(label).slice(0, 12)),
        ),
        label,
      ).rejects.toMatchObject({ code: "package_invalid" });
    }
  });

  it("rejects invalid providers with the structured engine_provider_invalid code", async () => {
    const harness = await createHarness();
    for (const provider of ["godot", "blender", "", "../unity", "UNITY"]) {
      await expect(
        harness.importer.ingestUpload(
          provider as DirectorEngineSceneProvider,
          "scene.zip",
          chunks(Buffer.from("unused")),
          harness.project,
        ),
      ).rejects.toMatchObject({ code: "engine_provider_invalid", status: 400 });
      await expect(
        harness.importer.validatePackage(provider as DirectorEngineSceneProvider, "job/package"),
      ).rejects.toMatchObject({ code: "engine_provider_invalid" });
    }
  });
});

describe("engine scene import stress: integrity", () => {
  it("rejects truncated files and hash-mismatched files against the manifest", async () => {
    const harness = await createHarness();
    const packageDir = await writePackage(harness, buildManifest("unity", DEFAULT_BUNDLE), {
      "assets/scene.glb": DEFAULT_BUNDLE,
    });
    await truncate(resolve(harness.jobRoot, packageDir, "assets", "scene.glb"), 8);
    await expect(harness.importer.validatePackage("unity", packageDir)).rejects.toMatchObject({
      code: "package_invalid",
      message: expect.stringMatching(/SHA-256 mismatch/),
    });

    const empty = await writePackage(harness, buildManifest("unity", DEFAULT_BUNDLE), {
      "assets/scene.glb": Buffer.alloc(0),
    }, "empty-file");
    await expect(harness.importer.validatePackage("unity", empty)).rejects.toMatchObject({
      code: "package_invalid",
    });
  });

  it("rejects manifests whose fileHashes reference missing or traversal paths", async () => {
    const harness = await createHarness();
    const missing = buildManifest("unity", DEFAULT_BUNDLE, {
      fileHashes: { "assets/scene.glb": digest(DEFAULT_BUNDLE), "assets/ghost.bin": digest("ghost") },
    });
    await expect(
      harness.importer.validatePackage("unity", await writePackage(harness, missing, undefined, "missing-file")),
    ).rejects.toMatchObject({ code: "package_invalid", message: expect.stringMatching(/missing/i) });

    for (const [index, hostilePath] of ["../escape.glb", "/etc/passwd", "assets/../../escape.glb", "a\\b.glb"].entries()) {
      const manifest = JSON.parse(JSON.stringify(buildManifest("unity", DEFAULT_BUNDLE))) as Record<string, unknown>;
      (manifest.fileHashes as Record<string, string>)[hostilePath] = digest("escape");
      await expect(
        harness.importer.validatePackage(
          "unity",
          await writePackage(harness, manifest, undefined, `hostile-${index}`),
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(package_invalid|path_escape)$/) });
    }
  });

  it("detects post-preview tampering: manifest swaps 409 and payload tampering fails hash re-verification", async () => {
    const swapped = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await swapped.importer.ingestUpload("unity", "scene.zip", chunks(zip), swapped.project);
    const revision = getDirectorProjectRevision(swapped.project);
    const otherManifest = buildManifest("unity", DEFAULT_BUNDLE, { packageId: "unity-swapped" });
    await writeFile(
      resolve(swapped.jobRoot, upload.packagePath, "manifest.json"),
      JSON.stringify(otherManifest),
    );
    await expect(
      swapped.importer.applyImportPlan(upload.plan.planId, swapped.project, revision, "stress-swap-0001", vi.fn()),
    ).rejects.toMatchObject({ code: "package_invalid", status: 409 });

    const tampered = await createHarness();
    const tamperedUpload = await tampered.importer.ingestUpload(
      "unity",
      "scene.zip",
      chunks(await buildZip(buildManifest("unity", DEFAULT_BUNDLE))),
      tampered.project,
    );
    await writeFile(
      resolve(tampered.jobRoot, tamperedUpload.packagePath, "assets", "scene.glb"),
      Buffer.from("tampered after preview, same manifest still cached"),
    );
    const applyAuthoring = vi.fn(async () => ({ success: true }));
    await expect(
      tampered.importer.applyImportPlan(
        tamperedUpload.plan.planId,
        tampered.project,
        getDirectorProjectRevision(tampered.project),
        "stress-tamper-0001",
        applyAuthoring,
      ),
    ).rejects.toMatchObject({ code: "package_invalid" });
    expect(applyAuthoring).not.toHaveBeenCalled();
  });

  it("rejects immutable asset collisions where the destination bytes do not match the pinned hash", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);
    const assetOperation = upload.plan.operations.find((op) => op.op === "create_scene_asset");
    if (assetOperation?.op !== "create_scene_asset") throw new Error("expected a create_scene_asset operation");
    const collisionDirectory = resolve(
      harness.workspaceRoot,
      "assets",
      "generated",
      "dcc-import",
      assetOperation.hash.slice(0, 20),
    );
    await mkdir(collisionDirectory, { recursive: true });
    await writeFile(resolve(collisionDirectory, `${assetOperation.assetId}.glb`), Buffer.from("poisoned bytes"));
    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        harness.project,
        getDirectorProjectRevision(harness.project),
        "stress-collision-01",
        vi.fn(async () => ({ success: true })),
      ),
    ).rejects.toMatchObject({ code: "package_invalid", status: 409, message: expect.stringMatching(/collision/i) });
  });

  it("re-importing the same package into the merged project reports duplicate director_id conflicts", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);
    let mergedProject: DirectorProject | null = null;
    await harness.importer.applyImportPlan(
      upload.plan.planId,
      harness.project,
      getDirectorProjectRevision(harness.project),
      "stress-dup-000001",
      vi.fn(async (operation) => {
        if (operation.op === "replace_project") mergedProject = operation.project;
        return { success: true };
      }),
    );
    expect(mergedProject).not.toBeNull();

    const replan = await harness.importer.buildImportPlan("unity", upload.packagePath, mergedProject!);
    expect(replan.ready).toBe(false);
    const collisionCodes = replan.conflicts.map((conflict) => conflict.code);
    expect(collisionCodes).toContain("id_collision");
    // Scene asset/object, camera rig pair, and camera itself all collide.
    expect(replan.conflicts.length).toBeGreaterThanOrEqual(3);
    await expect(
      harness.importer.applyImportPlan(
        replan.planId,
        mergedProject!,
        getDirectorProjectRevision(mergedProject!),
        "stress-dup-000002",
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "conflict_unresolved", status: 409 });
  });

  it("rejects tampered plan files and tampered apply ledgers", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);
    const revision = getDirectorProjectRevision(harness.project);

    const planPath = resolve(harness.jobRoot, upload.plan.planId);
    await writeFile(planPath, JSON.stringify({ ...upload.plan, packageId: "forged" }));
    await expect(
      harness.importer.applyImportPlan(upload.plan.planId, harness.project, revision, "stress-forge-0001", vi.fn()),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(package_invalid|plan_not_found)$/) });

    // Restore a valid plan, apply it, then corrupt the persisted ledger.
    const fresh = await harness.importer.buildImportPlan("unity", upload.packagePath, harness.project);
    const applyKey = "stress-ledger-0001";
    await harness.importer.applyImportPlan(
      fresh.planId,
      harness.project,
      revision,
      applyKey,
      vi.fn(async () => ({ success: true })),
    );
    const ledgerPath = resolve(
      harness.dataDirectory,
      "dcc-ledgers",
      "engine-scene-import",
      `${digest(applyKey)}.json`,
    );
    await writeFile(ledgerPath, "{ corrupted");
    await expect(
      harness.importer.applyImportPlan(fresh.planId, harness.project, revision, applyKey, vi.fn()),
    ).rejects.toMatchObject({ code: "package_invalid" });
  });

  it("rejects malformed idempotency keys before touching any plan state", async () => {
    const harness = await createHarness();
    for (const key of ["", "short", "has spaces in key", "-starts-with-dash", "key/with/slash", "k".repeat(200)]) {
      await expect(
        harness.importer.applyImportPlan(
          "job/plans/plan.json",
          harness.project,
          getDirectorProjectRevision(harness.project),
          key,
          vi.fn(),
        ),
      ).rejects.toMatchObject({ code: "authoring_failed" });
    }
  });
});

describe("engine scene import stress: path and symlink safety", () => {
  it("rejects plan ids and package dirs that escape the job root", async () => {
    const harness = await createHarness();
    const revision = getDirectorProjectRevision(harness.project);
    for (const planId of ["../../../etc/passwd", "/etc/passwd", "..", "job/../../escape.json"]) {
      await expect(
        harness.importer.applyImportPlan(planId, harness.project, revision, "stress-escape-0001", vi.fn()),
      ).rejects.toMatchObject({ code: "path_escape", status: 403 });
    }
    for (const packageDir of ["../outside", "/etc", "..", "job/../.."]) {
      await expect(harness.importer.buildImportPlan("unity", packageDir, harness.project)).rejects.toMatchObject({
        code: "path_escape",
        status: 403,
      });
    }
    await expect(harness.importer.buildImportPlan("unity", "no-such-job/package", harness.project)).rejects.toMatchObject(
      { code: "package_invalid", status: 404 },
    );
  });

  it("rejects packages that reach outside through symlinks", async () => {
    const harness = await createHarness();
    const outside = resolve(harness.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(resolve(outside, "secret.glb"), DEFAULT_BUNDLE);

    // A hashed file that is a symlink escaping the package root.
    const linkedFile = await writePackage(harness, buildManifest("unity", DEFAULT_BUNDLE), {}, "symlink-file");
    await symlink(
      resolve(outside, "secret.glb"),
      resolve(harness.jobRoot, "symlink-file", "package", "assets", "scene.glb"),
    );
    await expect(harness.importer.validatePackage("unity", linkedFile)).rejects.toMatchObject({
      code: "package_invalid",
    });

    // manifest.json itself is a symlink escaping the package root.
    await writeFile(resolve(outside, "manifest.json"), JSON.stringify(buildManifest("unity", DEFAULT_BUNDLE)));
    const manifestLinkDirectory = resolve(harness.jobRoot, "symlink-manifest", "package");
    await mkdir(resolve(manifestLinkDirectory, "assets"), { recursive: true });
    await writeFile(resolve(manifestLinkDirectory, "assets", "scene.glb"), DEFAULT_BUNDLE);
    await symlink(resolve(outside, "manifest.json"), resolve(manifestLinkDirectory, "manifest.json"));
    await expect(harness.importer.validatePackage("unity", "symlink-manifest/package")).rejects.toMatchObject({
      code: "package_invalid",
    });

    // The package directory itself is a symlink escaping the job root.
    await mkdir(resolve(outside, "package", "assets"), { recursive: true });
    await writeFile(resolve(outside, "package", "manifest.json"), JSON.stringify(buildManifest("unity", DEFAULT_BUNDLE)));
    await writeFile(resolve(outside, "package", "assets", "scene.glb"), DEFAULT_BUNDLE);
    await mkdir(resolve(harness.jobRoot, "symlink-dir"), { recursive: true });
    await symlink(resolve(outside, "package"), resolve(harness.jobRoot, "symlink-dir", "package"));
    await expect(harness.importer.validatePackage("unity", "symlink-dir/package")).rejects.toMatchObject({
      code: "path_escape",
      status: 403,
    });
  });
});

describe("engine scene import stress: volume and concurrency", () => {
  it("rejects zips with too many entries with a 413", async () => {
    const harness = await createHarness();
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify(buildManifest("unity", null, { scene: { name: "Set", bundleFile: null, nodeCount: 0, meshCount: 0, skinnedMeshCount: 0, materialCount: 0, animationClipCount: 0 } })));
    for (let index = 0; index < 4_100; index += 1) zip.file(`assets/f${index}.bin`, Buffer.from([index % 256]));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(
      harness.importer.ingestUpload("unity", "many-entries.zip", chunks(bytes), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid", status: 413 });
  });

  it("rejects a decompression bomb during streaming extraction without materializing it", async () => {
    const harness = await createHarness({ maxExtractedBytes: 256 * 1024 });
    // 64 MiB of zeros compresses to a few KiB; the budget is 256 KiB.
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE), {
      "assets/scene.glb": DEFAULT_BUNDLE,
      "assets/bomb.bin": Buffer.alloc(64 * 1024 * 1024),
    });
    expect(zip.byteLength).toBeLessThan(256 * 1024);
    await expect(
      harness.importer.ingestUpload("unity", "bomb.zip", chunks(zip), harness.project),
    ).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
  });

  it("rejects Content-Length lies, oversized declarations, and malformed declared sizes", async () => {
    const harness = await createHarness({ maxUploadBytes: 1024 * 1024 });
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project, zip.byteLength - 1),
    ).rejects.toMatchObject({ code: "upload_invalid" });
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project, 2 * 1024 * 1024),
    ).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
    for (const declared of [0, -1, 1.5, Number.NaN]) {
      await expect(
        harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project, declared),
      ).rejects.toMatchObject({ code: "upload_invalid", status: 400 });
    }
  });

  it("rejects empty uploads, non-zip filenames, and zip-signature forgeries", async () => {
    const harness = await createHarness();
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid" });
    await expect(
      harness.importer.ingestUpload("unity", "scene.tar.gz", chunks(Buffer.from("x")), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid" });
    await expect(
      harness.importer.ingestUpload("unity", "scene\0.zip", chunks(Buffer.from("x")), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid" });
    const forged = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("garbage after signature")]);
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(forged), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid" });
  });

  it("keeps parallel ingestions isolated: unique jobs, matching plans, no cross-contamination", async () => {
    const harness = await createHarness();
    const uploads = await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const manifest = buildManifest(index % 2 === 0 ? "unity" : "unreal", DEFAULT_BUNDLE, {
          packageId: `stress-parallel-${index}`,
        });
        return buildZip(manifest).then((zip) =>
          harness.importer.ingestUpload(
            index % 2 === 0 ? "unity" : "unreal",
            `scene-${index}.zip`,
            chunks(zip),
            harness.project,
          ),
        );
      }),
    );
    const jobIds = new Set(uploads.map((upload) => upload.jobId));
    expect(jobIds.size).toBe(uploads.length);
    for (const [index, upload] of uploads.entries()) {
      expect(upload.manifest.packageId).toBe(`stress-parallel-${index}`);
      expect(upload.plan.packageDir).toBe(upload.packagePath);
      expect(upload.plan.ready).toBe(true);
    }
  });

  it("failed ingestion never wedges the ingestion queue", async () => {
    const harness = await createHarness();
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(Buffer.from("not a zip")), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid" });
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project),
    ).resolves.toMatchObject({ provider: "unity" });
  });

  it("serializes concurrent applies with the same idempotency key into one authoring call", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);
    const revision = getDirectorProjectRevision(harness.project);
    const applyAuthoring = vi.fn(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      return { success: true, result: { receipt: "stress" } };
    });
    const [first, second] = await Promise.all([
      harness.importer.applyImportPlan(upload.plan.planId, harness.project, revision, "stress-race-00001", applyAuthoring),
      harness.importer.applyImportPlan(upload.plan.planId, harness.project, revision, "stress-race-00001", applyAuthoring),
    ]);
    expect(applyAuthoring).toHaveBeenCalledTimes(1);
    expect(first.authoring).toEqual(second.authoring);
  });

  it("survives preview-cache eviction: plans made before 32+ newer previews still apply", async () => {
    const harness = await createHarness();
    const firstZip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE, { packageId: "stress-evict-first" }));
    const first = await harness.importer.ingestUpload("unity", "first.zip", chunks(firstZip), harness.project);

    for (let index = 0; index < 33; index += 1) {
      const filler = await buildZip(buildManifest("unity", DEFAULT_BUNDLE, { packageId: `stress-filler-${index}` }));
      await harness.importer.ingestUpload("unity", `filler-${index}.zip`, chunks(filler), harness.project);
    }

    const result = await harness.importer.applyImportPlan(
      first.plan.planId,
      harness.project,
      getDirectorProjectRevision(harness.project),
      "stress-evict-00001",
      vi.fn(async () => ({ success: true })),
    );
    expect(result.copiedAssets).toHaveLength(1);
  });
});
