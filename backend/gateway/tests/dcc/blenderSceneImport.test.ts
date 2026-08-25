import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import type { DirectorBlendSceneManifestV1 } from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import {
  createBlenderSceneImporter,
  DirectorBlendSceneImportError,
  type BlenderSceneExtractionInput,
  type BlenderSceneImporter,
} from "../../dcc/blenderSceneImport";

const RAW_BLEND = Buffer.from("BLENDER-v300fixture-raw");
const ZSTD_BLEND = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]);
const GZIP_BLEND = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
const DEFAULT_BUNDLE = Buffer.from("deterministic Blender scene GLB fixture");

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

interface Harness {
  root: string;
  workspaceRoot: string;
  dataDirectory: string;
  project: DirectorProject;
  importer: BlenderSceneImporter;
  extractScene: (input: BlenderSceneExtractionInput) => Promise<{ stdout: string }>;
  bundle: Buffer;
}

async function createHarness(
  options: {
    maxUploadBytes?: number;
    maxExtractedBytes?: number;
    bundle?: Buffer;
    cameras?: DirectorBlendSceneManifestV1["cameras"];
    includeScene?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(resolve(tmpdir(), "director-blender-scene-import-"));
  temporaryRoots.push(root);
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(root, "data");
  const bundle = options.bundle ?? DEFAULT_BUNDLE;
  const includeScene = options.includeScene ?? true;
  const cameras = options.cameras ?? [
    {
      sourceId: "camera-main",
      name: "Main Camera",
      transform: {
        location: [2, -5, 2] as [number, number, number],
        rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      focalLengthMm: 50,
      sensorWidthMm: 36,
      sensorHeightMm: 20.25,
      sensorFit: "auto",
      renderAspectRatio: 16 / 9,
      verticalFovDegrees: 22.895192,
      apertureFStop: 2.8,
      focusDistanceM: 5,
      nearClipM: 0.1,
      farClipM: 1_000,
    },
    {
      sourceId: "camera-detail",
      name: "Detail Camera",
      transform: {
        location: [-1, -2, 1.5] as [number, number, number],
        rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
        scale: [1, 1, 1] as [number, number, number],
      },
      focalLengthMm: 300,
      sensorWidthMm: 36,
      sensorHeightMm: 24,
      sensorFit: "horizontal",
      renderAspectRatio: 2.39,
      verticalFovDegrees: (2 * Math.atan(36 / 2.39 / (2 * 300)) * 180) / Math.PI,
      apertureFStop: 4,
      focusDistanceM: 2,
      nearClipM: 0.05,
      farClipM: 500,
    },
  ];

  async function extractScene(input: BlenderSceneExtractionInput) {
    const source = await readFile(input.sourcePath);
    const packageId = `fixture-${digest(source).slice(0, 16)}`;
    if (includeScene) {
      await mkdir(resolve(input.outputDirectory, "assets"), { recursive: true });
      await writeFile(resolve(input.outputDirectory, "assets", "scene.glb"), bundle);
    }
    const manifest: DirectorBlendSceneManifestV1 = {
      schemaVersion: 1,
      contract: "director-blend-scene-v1",
      packageId,
      exportedAt: "2026-08-06T10:00:00.000Z",
      blenderVersion: "5.1.0",
      source: {
        fileName: "source.blend",
        sha256: digest(source),
        sizeBytes: source.byteLength,
      },
      coordinateSystem: {
        source: "right-handed-z-up-negative-z-camera-forward",
        destination: "right-handed-y-up-negative-z-forward",
        unit: "meter",
        linearMap: "(x,y,z)->(x,z,-y)",
      },
      timeline: {
        frameStart: 1,
        frameEnd: 48,
        currentFrame: 12,
        fps: 30_000 / 1_001,
        timebase: { rate: { numerator: 30_000, denominator: 1_001 } },
      },
      scene: {
        name: "Imported Blender Set",
        bundleFile: includeScene ? "assets/scene.glb" : null,
        objectCount: includeScene ? 3 : 0,
        meshCount: includeScene ? 2 : 0,
        materialCount: includeScene ? 2 : 0,
        actionCount: includeScene ? 1 : 0,
      },
      cameras,
      unsupported: [{ kind: "light", name: "Key", reason: "Director v1 does not import Blender lights." }],
      warnings: ["Fixture scene warning."],
      fileHashes: includeScene ? { "assets/scene.glb": digest(bundle) } : {},
    };
    await writeFile(resolve(input.outputDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(
      input.reportPath,
      JSON.stringify({
        ok: true,
        contract: "director-blend-scene-v1",
        packageId,
        manifestPath: resolve(input.outputDirectory, "manifest.json"),
        bundlePath: includeScene ? resolve(input.outputDirectory, "assets", "scene.glb") : null,
        objectCount: manifest.scene.objectCount,
        cameraCount: manifest.cameras.length,
        warningCount: manifest.warnings.length,
        unsupportedCount: manifest.unsupported.length,
        blenderVersion: manifest.blenderVersion,
      }),
      "utf8",
    );
    return { stdout: "DIRECTOR_BLEND_SCENE_RESULT:fixture" };
  }

  return {
    root,
    workspaceRoot,
    dataDirectory,
    project: createTestDirectorProject(),
    bundle,
    extractScene,
    importer: createBlenderSceneImporter({
      workspaceRoot,
      dataDirectory,
      extractScene,
      ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
      ...(options.maxExtractedBytes === undefined ? {} : { maxExtractedBytes: options.maxExtractedBytes }),
    }),
  };
}

async function ingest(harness: Harness, bytes = RAW_BLEND) {
  return harness.importer.ingestUpload("production-set.blend", chunks(bytes), harness.project, bytes.byteLength);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof DirectorBlendSceneImportError ? error.code : undefined;
}

/** Recursively reverses object key order so byte-identical JSON round trips are impossible. */
function reverseKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => reverseKeyOrder(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseKeyOrder(entry)]),
    ) as T;
  }
  return value;
}

describe("Blender scene import service", () => {
  it.each([
    ["raw", RAW_BLEND],
    ["Zstandard", ZSTD_BLEND],
    ["gzip", GZIP_BLEND],
  ])("streams and inspects a recognized %s Blender container", async (_label, bytes) => {
    const harness = await createHarness();
    const result = await harness.importer.ingestUpload(
      "production-set.blend",
      chunks(bytes.subarray(0, 3), bytes.subarray(3)),
      harness.project,
      bytes.byteLength,
    );

    expect(result.manifest.source).toMatchObject({ sha256: digest(bytes), sizeBytes: bytes.byteLength });
    expect(result.packagePath).toMatch(/^blend-[0-9a-f-]+\/package$/);
    expect(result.plan).toMatchObject({ ready: true, packageDir: result.packagePath });
    expect(result.plan.operations.filter((operation) => operation.op === "create_camera")).toHaveLength(2);
    expect(
      await readFile(resolve(harness.dataDirectory, "dcc-jobs", "blender-import", result.jobId, "source.blend")),
    ).toEqual(bytes);
  });

  it("rejects invalid names, signatures, declared lengths, and streamed overflow before preview", async () => {
    const harness = await createHarness({ maxUploadBytes: 24 });

    await expect(harness.importer.ingestUpload("scene.txt", chunks(RAW_BLEND), harness.project)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "upload_invalid",
    );
    await expect(
      harness.importer.ingestUpload("scene.blend", chunks(Buffer.from("not-a-blend")), harness.project),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "upload_invalid");
    await expect(
      harness.importer.ingestUpload("scene.blend", chunks(RAW_BLEND), harness.project, RAW_BLEND.byteLength - 1),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "upload_invalid");
    await expect(
      harness.importer.ingestUpload("scene.blend", chunks(RAW_BLEND), harness.project, 25),
    ).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
    await expect(
      harness.importer.ingestUpload(
        "scene.blend",
        chunks(RAW_BLEND.subarray(0, 12), Buffer.alloc(32, 7)),
        harness.project,
      ),
    ).rejects.toMatchObject({ code: "upload_too_large", status: 413 });
  });

  it("rejects an extracted package that exceeds the configured output budget", async () => {
    const harness = await createHarness({ maxExtractedBytes: 8 });
    await expect(ingest(harness)).rejects.toMatchObject({ code: "package_invalid", status: 413 });
  });

  it("rebuilds a deterministic selection plan and reports empty, unknown-camera, and ID conflicts", async () => {
    const harness = await createHarness();
    const upload = await ingest(harness);
    const cameraOnly = await harness.importer.buildImportPlan(upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: ["camera-detail"],
    });

    expect(cameraOnly.ready).toBe(true);
    expect(cameraOnly.selection).toEqual({ includeScene: false, cameraSourceIds: ["camera-detail"] });
    expect(cameraOnly.operations).toEqual([
      expect.objectContaining({
        op: "create_camera",
        sourceId: "camera-detail",
        focalLengthMm: expect.closeTo(172.497, 3),
        aspectRatio: "2.39:1",
      }),
    ]);
    expect(cameraOnly.warnings.join("\n")).toMatch(/preserve Blender's vertical field of view/i);
    expect(cameraOnly.warnings.join("\n")).toMatch(/camera roll and lens shift/i);

    const sameSelection = await harness.importer.buildImportPlan(upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: ["camera-detail"],
    });
    expect(sameSelection).toEqual(cameraOnly);

    const empty = await harness.importer.buildImportPlan(upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: [],
    });
    expect(empty).toMatchObject({
      ready: false,
      conflicts: [expect.objectContaining({ code: "empty_selection", sourceId: "selection" })],
    });

    const unknown = await harness.importer.buildImportPlan(upload.packagePath, harness.project, {
      includeScene: false,
      cameraSourceIds: ["deleted-camera"],
    });
    expect(unknown).toMatchObject({
      ready: false,
      conflicts: [expect.objectContaining({ code: "unsupported_scene", sourceId: "deleted-camera" })],
    });

    const defaultPlan = upload.plan;
    const sceneAsset = defaultPlan.operations.find((operation) => operation.op === "create_scene_asset");
    const sceneObject = defaultPlan.operations.find((operation) => operation.op === "create_scene_object");
    const firstCamera = defaultPlan.operations.find((operation) => operation.op === "create_camera");
    expect(sceneAsset?.op).toBe("create_scene_asset");
    expect(sceneObject?.op).toBe("create_scene_object");
    expect(firstCamera?.op).toBe("create_camera");
    if (
      sceneAsset?.op !== "create_scene_asset" ||
      sceneObject?.op !== "create_scene_object" ||
      firstCamera?.op !== "create_camera"
    ) {
      throw new Error("fixture import plan is incomplete");
    }
    expect(firstCamera.position).toEqual([2, 2, 5]);
    expect(firstCamera.target).toEqual([2, -3, 5]);
    const colliding = structuredClone(harness.project);
    colliding.assets.push({
      id: sceneAsset.assetId,
      kind: "scene",
      sourceType: "model",
      fileName: "existing.glb",
      url: "/existing.glb",
    });
    colliding.objects.push({
      id: sceneObject.objectId,
      name: "Existing",
      kind: "scene",
      visible: true,
      locked: false,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    colliding.cameras.push({
      id: firstCamera.cameraId,
      name: "Existing Camera",
      fov: 45,
      focalLengthMm: 35,
      sensorFormat: "fullFrame",
      aspectRatio: "16:9",
      handheldShake: "off",
      action: { mode: "still" },
      transform: { position: [0, 1, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      targetObjectId: null,
      target: [0, 1, 0],
      lastCaptureUrl: null,
      captures: [],
    });
    const collision = await harness.importer.buildImportPlan(upload.packagePath, colliding);
    expect(collision.ready).toBe(false);
    expect(collision.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "id_collision", reason: expect.stringContaining(sceneAsset.assetId) }),
        expect.objectContaining({ code: "id_collision", reason: expect.stringContaining(sceneObject.objectId) }),
        expect.objectContaining({ code: "id_collision", reason: expect.stringContaining(firstCamera.cameraId) }),
      ]),
    );
  });

  it("builds a ready camera-only plan when the Blender scene has no renderable geometry", async () => {
    const harness = await createHarness({ includeScene: false });
    const upload = await ingest(harness);

    expect(upload.manifest.scene.bundleFile).toBeNull();
    expect(upload.plan.ready).toBe(true);
    expect(upload.plan.selection).toEqual({
      includeScene: false,
      cameraSourceIds: ["camera-main", "camera-detail"],
    });
    expect(upload.plan.operations.every((operation) => operation.op === "create_camera")).toBe(true);
    expect(upload.plan.conflicts).toEqual([]);
  });

  it("copies the verified GLB and applies the complete scene as one revision/idempotency-guarded replace_project", async () => {
    const harness = await createHarness();
    const upload = await ingest(harness);
    const revision = getDirectorProjectRevision(harness.project);
    const applyAuthoring = vi.fn(async (_operation: DirectorWorkbenchOperation) => ({
      success: true,
      result: { idempotency: { key: "blend-import-001", replayed: false } },
    }));

    const result = await harness.importer.applyImportPlan(
      upload.plan.planId,
      harness.project,
      revision,
      "blend-import-001",
      applyAuthoring,
    );

    expect(applyAuthoring).toHaveBeenCalledTimes(1);
    const operation = applyAuthoring.mock.calls[0]![0];
    expect(operation).toMatchObject({
      op: "replace_project",
      expected_revision: revision,
      idempotency_key: "blend-import-001",
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
    expect(operation.project.cameras).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Main Camera", focalLengthMm: 50 }),
        expect.objectContaining({ name: "Detail Camera", focalLengthMm: expect.closeTo(172.497, 3) }),
      ]),
    );
    expect(operation.project.assets).not.toBe(harness.project.assets);
    expect(harness.project.assets).toEqual([]);
    expect(result.copiedAssets).toHaveLength(1);
    expect(result.authoring?.result).toEqual({
      idempotency: { key: "blend-import-001", replayed: false },
    });
    expect(
      await readFile(resolve(harness.workspaceRoot, "assets", "generated", result.copiedAssets[0]!.url.slice(1))),
    ).toEqual(harness.bundle);
  });

  it("replays the persisted byte-equivalent intent before revision checks when the first HTTP outcome is lost", async () => {
    const harness = await createHarness();
    const upload = await ingest(harness);
    const revision = getDirectorProjectRevision(harness.project);
    let committedProject: DirectorProject | undefined;
    let originalOperation: DirectorWorkbenchOperation | undefined;
    const lostResponse = vi.fn(async (operation: DirectorWorkbenchOperation) => {
      if (operation.op !== "replace_project") throw new Error("expected replace_project");
      originalOperation = structuredClone(operation);
      committedProject = structuredClone(operation.project);
      throw new Error("HTTP response was lost after browser commit");
    });

    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        harness.project,
        revision,
        "blend-lost-response-001",
        lostResponse,
      ),
    ).rejects.toThrow(/response was lost/i);
    expect(originalOperation).toBeDefined();
    expect(committedProject).toBeDefined();

    const restartedImporter = createBlenderSceneImporter({
      workspaceRoot: harness.workspaceRoot,
      dataDirectory: harness.dataDirectory,
      extractScene: harness.extractScene,
    });
    const replayAuthoring = vi.fn(async (operation: DirectorWorkbenchOperation) => ({
      success: true,
      result: {
        idempotency_key: operation.op === "replace_project" ? operation.idempotency_key : undefined,
        idempotency_replayed: true,
      },
    }));
    const replay = await restartedImporter.applyImportPlan(
      upload.plan.planId,
      committedProject!,
      revision,
      "blend-lost-response-001",
      replayAuthoring,
    );

    expect(replayAuthoring).toHaveBeenCalledTimes(1);
    expect(replayAuthoring).toHaveBeenCalledWith(originalOperation);
    expect(replay.authoring).toMatchObject({
      success: true,
      result: { idempotency_key: "blend-lost-response-001", idempotency_replayed: true },
    });
  });

  it("returns a completed apply receipt without authoring again and rejects key reuse for another intent", async () => {
    const harness = await createHarness();
    const upload = await ingest(harness);
    const revision = getDirectorProjectRevision(harness.project);
    let committedProject: DirectorProject | undefined;
    const firstAuthoring = vi.fn(async (operation: DirectorWorkbenchOperation) => {
      if (operation.op !== "replace_project") throw new Error("expected replace_project");
      committedProject = structuredClone(operation.project);
      return {
        success: true,
        result: { idempotency_key: "blend-completed-receipt-001", idempotency_replayed: false },
      };
    });
    const first = await harness.importer.applyImportPlan(
      upload.plan.planId,
      harness.project,
      revision,
      "blend-completed-receipt-001",
      firstAuthoring,
    );
    const mustNotAuthor = vi.fn(async () => {
      throw new Error("completed receipt must not invoke browser authoring");
    });

    const replay = await harness.importer.applyImportPlan(
      upload.plan.planId,
      committedProject!,
      revision,
      "blend-completed-receipt-001",
      mustNotAuthor,
    );
    expect(mustNotAuthor).not.toHaveBeenCalled();
    expect(replay).toEqual(first);

    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        committedProject!,
        getDirectorProjectRevision(committedProject!),
        "blend-completed-receipt-001",
        mustNotAuthor,
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict", status: 409 });
    await expect(
      harness.importer.applyImportPlan(
        "another-job/plans/another-plan.json",
        committedProject!,
        revision,
        "blend-completed-receipt-001",
        mustNotAuthor,
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict", status: 409 });
    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        committedProject!,
        revision,
        "blend-another-intent-001",
        mustNotAuthor,
      ),
    ).rejects.toMatchObject({ code: "stale_project_revision", status: 409 });
    expect(mustNotAuthor).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and unresolved plans without invoking browser authoring", async () => {
    const harness = await createHarness();
    const upload = await ingest(harness);
    const applyAuthoring = vi.fn();

    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        harness.project,
        `director-project-revision:v1:sha256:${"1".repeat(64)}`,
        "stale-explicit",
        applyAuthoring,
      ),
    ).rejects.toMatchObject({ code: "stale_project_revision", status: 409 });

    const movedProject = structuredClone(harness.project);
    movedProject.scene.backgroundColor = "#ffffff";
    await expect(
      harness.importer.applyImportPlan(
        upload.plan.planId,
        movedProject,
        getDirectorProjectRevision(movedProject),
        "stale-plan",
        applyAuthoring,
      ),
    ).rejects.toMatchObject({ code: "stale_project_revision", status: 409 });

    const conflicting = structuredClone(harness.project);
    const sceneAsset = upload.plan.operations.find((operation) => operation.op === "create_scene_asset");
    if (sceneAsset?.op !== "create_scene_asset") throw new Error("fixture scene asset operation is missing");
    conflicting.assets.push({
      id: sceneAsset.assetId,
      kind: "scene",
      sourceType: "model",
      fileName: "collision.glb",
      url: "/collision.glb",
    });
    const conflictPlan = await harness.importer.buildImportPlan(upload.packagePath, conflicting);
    await expect(
      harness.importer.applyImportPlan(
        conflictPlan.planId,
        conflicting,
        getDirectorProjectRevision(conflicting),
        "unresolved",
        applyAuthoring,
      ),
    ).rejects.toMatchObject({ code: "conflict_unresolved", status: 409 });
    expect(applyAuthoring).not.toHaveBeenCalled();
  });

  it("detects source, bundle, and stored-plan tampering before a replace_project mutation", async () => {
    const sourceTamper = await createHarness();
    const sourceUpload = await ingest(sourceTamper);
    const sourcePath = resolve(
      sourceTamper.dataDirectory,
      "dcc-jobs",
      "blender-import",
      sourceUpload.jobId,
      "source.blend",
    );
    await writeFile(sourcePath, Buffer.concat([RAW_BLEND, Buffer.from("tampered")]));
    await expect(sourceTamper.importer.validatePackage(sourceUpload.packagePath)).rejects.toMatchObject({
      code: "package_invalid",
    });

    const bundleTamper = await createHarness();
    const bundleUpload = await ingest(bundleTamper);
    await writeFile(
      resolve(
        bundleTamper.dataDirectory,
        "dcc-jobs",
        "blender-import",
        bundleUpload.packagePath,
        "assets",
        "scene.glb",
      ),
      "tampered bundle",
    );
    const bundleAuthoring = vi.fn();
    await expect(
      bundleTamper.importer.applyImportPlan(
        bundleUpload.plan.planId,
        bundleTamper.project,
        getDirectorProjectRevision(bundleTamper.project),
        "bundle-tamper",
        bundleAuthoring,
      ),
    ).rejects.toMatchObject({ code: "package_invalid" });
    expect(bundleAuthoring).not.toHaveBeenCalled();

    const planTamper = await createHarness();
    const planUpload = await ingest(planTamper);
    const planPath = resolve(planTamper.dataDirectory, "dcc-jobs", "blender-import", planUpload.plan.planId);
    const stored = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
    stored.planId = "another-job/plans/forged.json";
    await writeFile(planPath, JSON.stringify(stored), "utf8");
    const planAuthoring = vi.fn();
    await expect(
      planTamper.importer.applyImportPlan(
        planUpload.plan.planId,
        planTamper.project,
        getDirectorProjectRevision(planTamper.project),
        "plan-tamper",
        planAuthoring,
      ),
    ).rejects.toMatchObject({ code: "package_invalid" });
    expect(planAuthoring).not.toHaveBeenCalled();
  });

  it("applies a stored plan whose JSON key order differs from the server serialization", async () => {
    const harness = await createHarness();
    const upload = await ingest(harness);
    const planPath = resolve(harness.dataDirectory, "dcc-jobs", "blender-import", upload.plan.planId);
    const stored = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
    const permuted = reverseKeyOrder(stored);
    expect(JSON.stringify(permuted)).not.toBe(JSON.stringify(stored));
    await writeFile(planPath, JSON.stringify(permuted), "utf8");

    const applyAuthoring = vi.fn(async (_operation: DirectorWorkbenchOperation) => ({ success: true }));
    const result = await harness.importer.applyImportPlan(
      upload.plan.planId,
      harness.project,
      getDirectorProjectRevision(harness.project),
      "blend-permuted-001",
      applyAuthoring,
    );
    expect(applyAuthoring).toHaveBeenCalledTimes(1);
    expect(result.copiedAssets).toHaveLength(1);
    expect(result.plan.operations).toEqual(upload.plan.operations);
  });
});
