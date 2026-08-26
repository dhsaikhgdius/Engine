import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import type { DirectorEngineSceneManifestV1, DirectorEngineSceneProvider } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import {
  createEngineSceneImporter,
  type EngineSceneExtractionInput,
  type EngineSceneImporter,
} from "../../dcc/engineSceneImport";

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
  const identity = () => ({
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  });
  return {
    schemaVersion: 1,
    contract: "director-engine-scene-v1",
    packageId: `${provider}-scene-fixture`,
    provider,
    exportedAt: "2026-08-25T00:00:00.000Z",
    engineVersion: provider === "unreal" ? "5.6.1" : "6000.0.82f1",
    exporter: { name: `director-${provider}-scene-export`, version: "1.0.0" },
    source: { projectName: "Fixture", sceneName: "Set" },
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
      nodeCount: 2,
      meshCount: bundle ? 1 : 0,
      skinnedMeshCount: 0,
      materialCount: 1,
      animationClipCount: 1,
    },
    nodes: [
      { sourceId: "node-root", name: "Root", kind: "group", transform: identity() },
      { sourceId: "node-crate", name: "Crate", parentSourceId: "node-root", kind: "mesh", transform: identity() },
    ],
    cameras: [
      {
        sourceId: "camera-main",
        name: "Main Camera",
        position: [0, 1.7, 5],
        lookTarget: [0, 1.5, 0],
        verticalFovDegrees: 35,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
        apertureFStop: 2.8,
        focusDistanceM: 5,
        nearClipM: 0.1,
        farClipM: 10_000,
        renderAspectRatio: 16 / 9,
      },
    ],
    lights: [
      {
        sourceId: "light-key",
        name: "Key Spot",
        type: "spot",
        color: "#FFCC88",
        intensity: 1.25,
        position: [2, 3, 2],
        target: [0, 1, 0],
        angleDegrees: 45,
        penumbra: 0.2,
        rangeM: 20,
        castShadow: true,
      },
    ],
    animationClips: [{ name: "Idle", durationSeconds: 2.5 }],
    unsupported: [{ kind: "light", name: "Disc", reason: "Disc lights are not mapped." }],
    warnings: ["fixture warning"],
    fileHashes: bundle ? { "assets/scene.glb": digest(bundle) } : {},
    ...overrides,
  };
}

async function buildZip(
  manifest: DirectorEngineSceneManifestV1,
  files: Record<string, Buffer> = { "assets/scene.glb": DEFAULT_BUNDLE },
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(files)) zip.file(name, contents);
  return zip.generateAsync({ type: "nodebuffer" });
}

interface Harness {
  root: string;
  workspaceRoot: string;
  project: DirectorProject;
  importer: EngineSceneImporter;
  runEngineExport: ReturnType<typeof vi.fn<(input: EngineSceneExtractionInput) => Promise<void>>>;
}

async function createHarness(
  options: { maxUploadBytes?: number; environment?: NodeJS.ProcessEnv } = {},
): Promise<Harness> {
  const root = await mkdtemp(resolve(tmpdir(), "director-engine-scene-import-"));
  temporaryRoots.push(root);
  const workspaceRoot = resolve(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const runEngineExport = vi.fn(async (input: EngineSceneExtractionInput) => {
    const manifest = buildManifest(input.provider, DEFAULT_BUNDLE);
    await mkdir(resolve(input.outputDirectory, "assets"), { recursive: true });
    await writeFile(resolve(input.outputDirectory, "assets", "scene.glb"), DEFAULT_BUNDLE);
    await writeFile(resolve(input.outputDirectory, "manifest.json"), JSON.stringify(manifest));
  });
  const importer = createEngineSceneImporter({
    workspaceRoot,
    dataDirectory: resolve(root, "data"),
    environment: options.environment ?? { PATH: "" },
    maxUploadBytes: options.maxUploadBytes,
    runEngineExport,
  });
  return { root, workspaceRoot, project: createTestDirectorProject(), importer, runEngineExport };
}

describe("engine scene import", () => {
  it("ingests an uploaded package into a ready plan with scene, camera, and light operations", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload(
      "unity",
      "director-engine-scene.zip",
      chunks(zip),
      harness.project,
      zip.byteLength,
    );

    expect(upload.provider).toBe("unity");
    expect(upload.archiveSha256).toBe(digest(zip));
    expect(upload.plan.ready).toBe(true);
    expect(upload.plan.conflicts).toEqual([]);
    const ops = upload.plan.operations;
    expect(ops.find((op) => op.op === "create_scene_asset")).toMatchObject({
      glbPath: "assets/scene.glb",
      hash: digest(DEFAULT_BUNDLE),
    });
    expect(ops.find((op) => op.op === "create_scene_object")).toMatchObject({
      name: "Set",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(ops.find((op) => op.op === "create_camera")).toMatchObject({
      sourceId: "camera-main",
      position: [0, 1.7, 5],
      target: [0, 1.5, 0],
      sensorFormat: "fullFrame",
      apertureFStop: 2.8,
    });
    const light = ops.find((op) => op.op === "create_light");
    expect(light).toMatchObject({
      sourceId: "light-key",
      type: "spot",
      color: "#ffcc88",
      intensity: 1.25,
      distance: 20,
      penumbra: 0.2,
      castShadow: true,
    });
    if (light?.op !== "create_light") throw new Error("expected a create_light operation");
    expect(light.angle).toBeCloseTo((45 * Math.PI) / 180 / 2, 6);
    expect(upload.plan.warnings).toEqual(
      expect.arrayContaining(["fixture warning", "light Disc: Disc lights are not mapped."]),
    );
  });

  it("rejects non-zip uploads, unsafe zip entries, and oversized uploads", async () => {
    const harness = await createHarness();
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(Buffer.from("not a zip")), harness.project),
    ).rejects.toMatchObject({ code: "upload_invalid" });

    // Rename the stored bundle path at the byte level ("assets/scene.glb" ->
    // "../../escape.glb", same length) to simulate a hostile archive. JSZip
    // strips "../" from entry names while parsing, so containment falls to the
    // manifest validator: the traversal path and the now-missing hashed file
    // are both rejected before anything outside the package is touched.
    const hostile = Buffer.from(await buildZip(buildManifest("unity", DEFAULT_BUNDLE)));
    const original = Buffer.from("assets/scene.glb");
    const traversalName = Buffer.from("../../escape.glb");
    expect(traversalName.length).toBe(original.length);
    for (let offset = hostile.indexOf(original); offset !== -1; offset = hostile.indexOf(original, offset + 1)) {
      traversalName.copy(hostile, offset);
    }
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(hostile), harness.project),
    ).rejects.toMatchObject({ code: "package_invalid" });

    const bounded = await createHarness({ maxUploadBytes: 64 });
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    await expect(
      bounded.importer.ingestUpload("unity", "scene.zip", chunks(zip), bounded.project),
    ).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
  });

  it("rejects hash mismatches and provider mismatches", async () => {
    const harness = await createHarness();
    const tampered = await buildZip(buildManifest("unity", DEFAULT_BUNDLE), {
      "assets/scene.glb": Buffer.from("tampered GLB bytes"),
    });
    await expect(
      harness.importer.ingestUpload("unity", "scene.zip", chunks(tampered), harness.project),
    ).rejects.toMatchObject({ code: "package_invalid" });

    const unityPackage = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    await expect(
      harness.importer.ingestUpload("unreal", "scene.zip", chunks(unityPackage), harness.project),
    ).rejects.toMatchObject({ code: "package_invalid", status: 409 });
  });

  it("filters operations through the selection and reports unknown ids as conflicts", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);

    const cameraOnly = await harness.importer.buildImportPlan("unity", upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: ["camera-main"],
      lightSourceIds: [],
    });
    expect(cameraOnly.ready).toBe(true);
    expect(cameraOnly.operations.map((op) => op.op)).toEqual(["create_camera"]);

    const unknownLight = await harness.importer.buildImportPlan("unity", upload.packagePath, harness.project, {
      includeScene: true,
      cameraSourceIds: [],
      lightSourceIds: ["light-missing"],
    });
    expect(unknownLight.ready).toBe(false);
    expect(unknownLight.conflicts).toContainEqual(
      expect.objectContaining({ sourceId: "light-missing", code: "unsupported_scene" }),
    );

    const empty = await harness.importer.buildImportPlan("unity", upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: [],
      lightSourceIds: [],
    });
    expect(empty.ready).toBe(false);
    expect(empty.conflicts).toContainEqual(expect.objectContaining({ code: "empty_selection" }));
  });

  it("stamps typed omitted records for unsupported elements, flattening, clips, rigs, and camera roll", async () => {
    const harness = await createHarness();
    const manifest = buildManifest("unity", DEFAULT_BUNDLE);
    const zip = await buildZip({ ...manifest, scene: { ...manifest.scene, skinnedMeshCount: 1 } });
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);

    expect(upload.plan.omitted).toEqual([
      { sourceId: "Disc", kind: "light", code: "unsupported_object", reason: "Disc lights are not mapped." },
      { sourceId: "scene", code: "hierarchy_flattened", reason: expect.stringContaining("one flattened Director") },
      {
        sourceId: "camera-main",
        code: "camera_roll",
        reason: expect.stringContaining("camera roll on Main Camera"),
      },
      { sourceId: "scene", code: "animation_clips", reason: expect.stringContaining("exported frame") },
      { sourceId: "scene", code: "skinned_mesh_rigs", reason: expect.stringContaining("character rig system") },
    ]);
    expect(upload.plan.omittedCount).toBe(upload.plan.omitted?.length);
    // Every typed record keeps a matching free-text warning for humans.
    for (const record of upload.plan.omitted ?? []) {
      expect(upload.plan.warnings.some((warning) => warning.includes(record.reason))).toBe(true);
    }

    const lightOnly = await harness.importer.buildImportPlan("unity", upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: [],
      lightSourceIds: ["light-key"],
    });
    expect(lightOnly.omitted?.map((record) => `${record.code}:${record.sourceId}`)).toEqual([
      "unsupported_object:Disc",
      "animation_clips:scene",
      "skinned_mesh_rigs:scene",
    ]);
    expect(lightOnly.omittedCount).toBe(3);
  });

  it("applies the plan as one revision/idempotency-guarded replace_project and replays the receipt", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);
    const revision = getDirectorProjectRevision(harness.project);
    const applyAuthoring = vi.fn(async (_operation: DirectorWorkbenchOperation) => ({
      success: true,
      result: { idempotency: { key: "engine-import-001", replayed: false } },
    }));

    const result = await harness.importer.applyImportPlan(
      upload.plan.planId,
      harness.project,
      revision,
      "engine-import-001",
      applyAuthoring,
    );

    expect(applyAuthoring).toHaveBeenCalledTimes(1);
    const operation = applyAuthoring.mock.calls[0]![0];
    expect(operation).toMatchObject({
      op: "replace_project",
      expected_revision: revision,
      idempotency_key: "engine-import-001",
    });
    if (operation.op !== "replace_project") throw new Error("expected one atomic replace_project operation");
    const importedAsset = operation.project.assets.find((asset) => asset.id === result.copiedAssets[0]?.assetId);
    expect(importedAsset).toMatchObject({
      kind: "scene",
      sourceType: "model",
      assetSource: "local",
      modelNormalization: "preserve",
      url: result.copiedAssets[0]?.url,
    });
    expect(operation.project.objects).toContainEqual(
      expect.objectContaining({ kind: "scene", assetRefId: importedAsset?.id }),
    );
    expect(operation.project.cameras).toContainEqual(expect.objectContaining({ name: "Main Camera" }));
    expect(operation.project.lights).toContainEqual(
      expect.objectContaining({ name: "Key Spot", type: "spot", intensity: 1.25, castShadow: true }),
    );
    expect(
      await readFile(resolve(harness.workspaceRoot, "assets", "generated", result.copiedAssets[0]!.url.slice(1))),
    ).toEqual(DEFAULT_BUNDLE);

    const replay = await harness.importer.applyImportPlan(
      upload.plan.planId,
      harness.project,
      revision,
      "engine-import-001",
      vi.fn(async () => {
        throw new Error("completed receipt must not invoke browser authoring");
      }),
    );
    expect(replay.authoring).toEqual(result.authoring);

    await expect(
      harness.importer.applyImportPlan(
        `${upload.plan.planId.split("/")[0]}/plans/other.json`,
        harness.project,
        revision,
        "engine-import-001",
        applyAuthoring,
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict", status: 409 });
  });

  it("rejects stale revisions without invoking browser authoring", async () => {
    const harness = await createHarness();
    const zip = await buildZip(buildManifest("unity", DEFAULT_BUNDLE));
    const upload = await harness.importer.ingestUpload("unity", "scene.zip", chunks(zip), harness.project);
    const applyAuthoring = vi.fn();
    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        harness.project,
        `director-project-revision:v1:sha256:${"1".repeat(64)}`,
        "engine-import-002",
        applyAuthoring,
      ),
    ).rejects.toMatchObject({ code: "stale_project_revision", status: 409 });
    expect(applyAuthoring).not.toHaveBeenCalled();
  });

  it("runs the discovered engine headlessly for extraction and validates the produced package", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-engine-runtime-"));
    temporaryRoots.push(root);
    const fakeUnity = resolve(root, "Unity");
    await writeFile(fakeUnity, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const harness = await createHarness({ environment: { PATH: "", DIRECTOR_UNITY_BIN: fakeUnity } });
    const projectDirectory = resolve(harness.workspaceRoot, "UnityProject");
    await mkdir(resolve(projectDirectory, "Assets"), { recursive: true });

    const result = await harness.importer.ingestProject(
      "unity",
      projectDirectory,
      harness.project,
      "Assets/Scenes/Main.unity",
    );

    expect(harness.runEngineExport).toHaveBeenCalledTimes(1);
    expect(harness.runEngineExport.mock.calls[0]![0]).toMatchObject({
      provider: "unity",
      executable: fakeUnity,
      scene: "Assets/Scenes/Main.unity",
    });
    expect(result.plan.ready).toBe(true);
    expect(result.archiveSha256).toBeNull();
    expect(result.manifest.provider).toBe("unity");
  });

  it("reports engine_unavailable and project_invalid for the native extraction path", async () => {
    const harness = await createHarness();
    const projectDirectory = resolve(harness.workspaceRoot, "UnrealProject");
    await mkdir(projectDirectory, { recursive: true });
    await expect(harness.importer.ingestProject("unreal", projectDirectory, harness.project)).rejects.toMatchObject({
      code: "engine_unavailable",
      status: 503,
    });
    expect(harness.runEngineExport).not.toHaveBeenCalled();

    const outside = await mkdtemp(resolve(tmpdir(), "director-engine-outside-"));
    temporaryRoots.push(outside);
    await expect(harness.importer.ingestProject("unreal", outside, harness.project)).rejects.toMatchObject({
      code: "project_invalid",
    });
  });
});
