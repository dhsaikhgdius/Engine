import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DirectorProject, DirectorTransform } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { directorTransformToBlender, directorWorldPointToBlender } from "@director/dcc-protocol";
import type { DirectorDccReturnManifestV1 } from "@director/dcc-protocol";
import {
  DirectorDccImportError,
  buildDirectorDccImportPlan,
  createBlenderReturnImporter,
} from "../../dcc/blenderReturnImport";

function digest(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function addProp(project: DirectorProject) {
  project.assets.push({
    id: "asset-chair",
    kind: "prop",
    sourceType: "model",
    fileName: "chair.glb",
    url: "/models/chair.glb",
    assetSource: "library",
  });
  project.objects.push({
    id: "chair",
    name: "Chair",
    kind: "prop",
    visible: true,
    locked: false,
    assetRefId: "asset-chair",
    transform: { position: [1, 0, 2], rotation: [0, 0.25, 0], scale: [1, 1, 1] },
  });
}

function addTable(project: DirectorProject) {
  project.objects.push({
    id: "table",
    name: "Table",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: { position: [2, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
}

function worldTransform(project: DirectorProject): DirectorTransform {
  return {
    position: project.scene.position,
    rotation: project.scene.rotation,
    scale: [project.scene.scale, project.scene.scale, project.scene.scale],
  };
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

interface FixtureOptions {
  stale?: boolean;
  unknown?: boolean;
  badHash?: boolean;
  /** Write the export-time scene.director-dcc.json snapshot into the job directory. */
  baseline?: boolean;
  /** Add a second primitive object to the export state (and snapshot). */
  withTable?: boolean;
  /** Add a Blender-side transform_update change for the table to the return manifest. */
  tableChange?: boolean;
  /** Add an object_addition change (a new Blender object with a fresh director_id). */
  addition?: boolean;
  /** Add a second object_addition change so skip/opt-in intent can diverge per object. */
  secondAddition?: boolean;
  /** Use a directorId for the addition that already exists in the live project. */
  additionIdCollision?: boolean;
  /** Director-side edits applied to the live project after the export. */
  mutateLive?: (project: DirectorProject) => void;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "director-dcc-return-"));
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(workspaceRoot, "data");
  const jobDirectory = resolve(dataDirectory, "dcc-jobs", "blender", "job-1");
  const packageDirectory = resolve(jobDirectory, "return-package");
  await mkdir(resolve(packageDirectory, "meshes"), { recursive: true });

  const exportProject = createTestDirectorProject();
  addProp(exportProject);
  if (options.withTable) addTable(exportProject);
  const exportRevision = getDirectorProjectRevision(exportProject);
  const world = worldTransform(exportProject);
  const chairBlender = directorTransformToBlender(
    exportProject.objects.find((object) => object.id === "chair")!.transform,
    world,
  );
  const tableBlender = options.withTable
    ? directorTransformToBlender(exportProject.objects.find((object) => object.id === "table")!.transform, world)
    : null;

  const mesh = new TextEncoder().encode("deterministic fake glb fixture");
  await writeFile(resolve(packageDirectory, "meshes", "chair.glb"), mesh);

  const changes: DirectorDccReturnManifestV1["changes"] = [
    {
      kind: "mesh_replacement",
      directorId: options.unknown ? "deleted-object" : "chair",
      entityType: "object",
      meshFile: "meshes/chair.glb",
      transform: chairBlender,
      assetLabel: "Chair refined",
    },
  ];
  if (options.tableChange) {
    changes.push({
      kind: "transform_update",
      directorId: "table",
      entityType: "object",
      transform: directorTransformToBlender({ position: [3, 0, -1], rotation: [0, 0, 0], scale: [1, 1, 1] }, world),
    });
  }
  const additionMesh = new TextEncoder().encode("fresh blender lamp glb fixture");
  const secondAdditionMesh = new TextEncoder().encode("fresh blender shade glb fixture");
  if (options.addition) {
    await writeFile(resolve(packageDirectory, "meshes", "lamp-new.glb"), additionMesh);
    changes.push({
      kind: "object_addition",
      directorId: options.additionIdCollision ? "table" : "lamp-new",
      entityType: "object",
      name: "Desk Lamp",
      meshFile: "meshes/lamp-new.glb",
      transform: directorTransformToBlender({ position: [0, 1, -2], rotation: [0, 0, 0], scale: [1, 1, 1] }, world),
      assetLabel: "Desk Lamp (Blender)",
    });
  }
  if (options.secondAddition) {
    await writeFile(resolve(packageDirectory, "meshes", "shade-new.glb"), secondAdditionMesh);
    changes.push({
      kind: "object_addition",
      directorId: "shade-new",
      entityType: "object",
      name: "Lamp Shade",
      meshFile: "meshes/shade-new.glb",
      transform: directorTransformToBlender({ position: [0, 1.4, -2], rotation: [0, 0, 0], scale: [1, 1, 1] }, world),
      assetLabel: "Lamp Shade (Blender)",
    });
  }
  const manifest: DirectorDccReturnManifestV1 = {
    schemaVersion: 1,
    contract: "director-dcc-return-v1",
    packageId: "return-package-1",
    sourcePackageId: "source-package-1",
    sourceRevision: options.stale ? (`director-project-revision:v1:sha256:${"0".repeat(64)}` as const) : exportRevision,
    exportedAt: "2026-08-03T10:00:00.000Z",
    blenderVersion: "4.5.0",
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,z,-y)",
    },
    changes,
    warnings: ["fixture warning"],
    fileHashes: {
      "meshes/chair.glb": options.badHash ? "f".repeat(64) : digest(mesh),
      ...(options.addition ? { "meshes/lamp-new.glb": digest(additionMesh) } : {}),
      ...(options.secondAddition ? { "meshes/shade-new.glb": digest(secondAdditionMesh) } : {}),
    },
  };
  await writeFile(resolve(packageDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  if (options.baseline) {
    const snapshot = {
      schemaVersion: 1,
      contract: "director-dcc-scene-v1",
      packageId: "source-package-1",
      sourceRevision: exportRevision,
      objects: [
        {
          id: "chair",
          name: "Chair",
          kind: "prop",
          visible: true,
          assetRefId: "asset-chair",
          transform: chairBlender,
          animation: [],
        },
        ...(tableBlender
          ? [
              {
                id: "table",
                name: "Table",
                kind: "prop",
                visible: true,
                geometryType: "box",
                transform: tableBlender,
                animation: [],
              },
            ]
          : []),
      ],
      cameras: [],
    };
    await writeFile(resolve(jobDirectory, "scene.director-dcc.json"), JSON.stringify(snapshot, null, 2), "utf8");
  }

  const project = structuredClone(exportProject);
  options.mutateLive?.(project);

  return {
    root,
    workspaceRoot,
    dataDirectory,
    packageDirectory,
    project,
    exportRevision,
    manifest,
    importer: createBlenderReturnImporter({ workspaceRoot, dataDirectory }),
  };
}

describe("Blender return import", () => {
  it("validates hashes and builds a stable-ID mesh/transform plan", async () => {
    const setup = await fixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    expect(plan.warnings).toContain("fixture warning");
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: "link_refined_asset", objectId: "chair", glbPath: "meshes/chair.glb" }),
        expect.objectContaining({
          op: "update_transform",
          entityType: "object",
          objectId: "chair",
          transform: expect.objectContaining({ position: [1, 0, 2] }),
        }),
      ]),
    );
  });

  it("returns blocking plans for stale revisions without a snapshot and for unknown stable IDs", async () => {
    const stale = await fixture({ stale: true });
    const stalePlan = await stale.importer.buildImportPlan("job-1/return-package", stale.project);
    expect(stalePlan.ready).toBe(false);
    expect(stalePlan.conflicts[0]).toMatchObject({ directorId: "project", code: "stale_source_revision" });

    const unknown = await fixture({ unknown: true });
    const unknownPlan = await unknown.importer.buildImportPlan("job-1/return-package", unknown.project);
    expect(unknownPlan.ready).toBe(false);
    expect(unknownPlan.operations).toContainEqual(
      expect.objectContaining({ op: "skip", directorId: "deleted-object" }),
    );
    expect(unknownPlan.conflicts).toContainEqual(
      expect.objectContaining({ code: "unknown_director_id", directorId: "deleted-object" }),
    );
  });

  it("rejects path traversal and hash mismatches", async () => {
    const setup = await fixture({ badHash: true });
    await expect(setup.importer.validatePackage("../../outside")).rejects.toMatchObject({ code: "path_escape" });
    await expect(setup.importer.validatePackage("job-1/return-package")).rejects.toMatchObject({
      code: "package_invalid",
    });
  });

  it("copies immutable assets then applies one revision-guarded author batch", async () => {
    const setup = await fixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true, result: { changed: true } });
    const result = await setup.importer.applyImportPlan(
      plan,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "blender-return-1",
      applyAuthoring,
    );
    expect(result.copiedAssets).toHaveLength(1);
    expect(
      await readFile(resolve(setup.workspaceRoot, "assets", "generated", result.copiedAssets[0]!.url.slice(1)), "utf8"),
    ).toBe("deterministic fake glb fixture");
    expect(applyAuthoring).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "author",
        expected_revision: getDirectorProjectRevision(setup.project),
        idempotency_key: "blender-return-1",
        actions: expect.arrayContaining([
          expect.objectContaining({ action: "upsert_asset" }),
          expect.objectContaining({ action: "update_object", object_id: "chair", force: true }),
        ]),
      }),
    );
  });

  it("rejects apply when the live project revision has moved", async () => {
    const setup = await fixture();
    const plan = buildDirectorDccImportPlan(
      {
        packageDir: "job-1/return-package",
        manifest: setup.manifest,
        manifestHash: digest("manifest"),
      },
      setup.project,
    );
    await expect(
      setup.importer.applyImportPlan(
        plan,
        setup.project,
        "director-project-revision:v1:sha256:" + "1".repeat(64),
        "stale",
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(DirectorDccImportError);
  });

  it("merges per object when unrelated Director edits moved the project revision", async () => {
    const setup = await fixture({
      baseline: true,
      withTable: true,
      mutateLive: (project) => {
        project.scene.backgroundColor = "#0f1722";
        project.objects.find((object) => object.id === "table")!.transform.position = [8, 0, 8];
      },
    });
    const liveRevision = getDirectorProjectRevision(setup.project);
    expect(liveRevision).not.toBe(setup.exportRevision);

    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.warnings.join("\n")).toMatch(/merges per stable director_id/i);
    expect(plan.operations).toContainEqual(expect.objectContaining({ op: "link_refined_asset", objectId: "chair" }));

    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(plan, setup.project, liveRevision, "merge-1", applyAuthoring);
    expect(result.copiedAssets).toHaveLength(1);
    expect(applyAuthoring).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: expect.arrayContaining([expect.objectContaining({ action: "update_object", object_id: "chair" })]),
      }),
    );
  });

  it("flags only objects edited on both sides and applies the rest after an explicit skip", async () => {
    const setup = await fixture({
      baseline: true,
      withTable: true,
      tableChange: true,
      mutateLive: (project) => {
        project.objects.find((object) => object.id === "chair")!.transform.position = [5, 0, 5];
      },
    });
    const liveRevision = getDirectorProjectRevision(setup.project);

    const conflicted = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(conflicted.ready).toBe(false);
    expect(conflicted.conflicts).toEqual([
      expect.objectContaining({ directorId: "chair", code: "stale_source_revision" }),
    ]);
    expect(conflicted.operations).toContainEqual(expect.objectContaining({ op: "skip", directorId: "chair" }));
    expect(conflicted.operations).toContainEqual(
      expect.objectContaining({ op: "update_transform", objectId: "table" }),
    );

    const skipPlan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      skipDirectorIds: ["chair"],
    });
    expect(skipPlan.ready).toBe(true);
    expect(skipPlan.conflicts).toEqual([]);
    expect(skipPlan.operations).toContainEqual(expect.objectContaining({ op: "skip", directorId: "chair" }));
    expect(skipPlan.operations).not.toContainEqual(expect.objectContaining({ op: "link_refined_asset" }));

    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(
      skipPlan,
      setup.project,
      liveRevision,
      "skip-apply-1",
      applyAuthoring,
    );
    expect(result.copiedAssets).toEqual([]);
    const operation = applyAuthoring.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    expect(operation.actions).toEqual([expect.objectContaining({ action: "update_object", object_id: "table" })]);
  });

  it("lists new Blender objects as reviewable skips unless include_new_objects opts in", async () => {
    const setup = await fixture({ addition: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.operations).not.toContainEqual(expect.objectContaining({ op: "create_prop" }));
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        op: "skip",
        directorId: "lamp-new",
        reason: expect.stringContaining("include_new_objects"),
      }),
    );
  });

  it("plans create_prop with hash and Director-space transform when new objects are opted in", async () => {
    const setup = await fixture({ addition: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      includeNewObjects: true,
    });
    expect(plan.ready).toBe(true);
    const createProp = plan.operations.find((operation) => operation.op === "create_prop");
    expect(createProp).toMatchObject({
      objectId: "lamp-new",
      name: "Desk Lamp",
      assetLabel: "Desk Lamp (Blender)",
      glbPath: "meshes/lamp-new.glb",
      hash: setup.manifest.fileHashes["meshes/lamp-new.glb"],
    });
    const position = (createProp as { transform: { position: [number, number, number] } }).transform.position;
    expect(position[0]).toBeCloseTo(0, 6);
    expect(position[1]).toBeCloseTo(1, 6);
    expect(position[2]).toBeCloseTo(-2, 6);
  });

  it("conflicts additions whose director_id already exists in the live project", async () => {
    const setup = await fixture({ addition: true, additionIdCollision: true, withTable: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      includeNewObjects: true,
    });
    expect(plan.ready).toBe(false);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ directorId: "table", code: "duplicate_director_id" }),
    );
    expect(plan.operations).not.toContainEqual(expect.objectContaining({ op: "create_prop" }));
  });

  it("applies an opted-in addition as one immutable asset copy plus upsert_asset and add_object", async () => {
    const setup = await fixture({ addition: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      includeNewObjects: true,
    });
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(
      plan,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "addition-apply-1",
      applyAuthoring,
    );
    const additionAsset = result.copiedAssets.find(
      (asset) => asset.hash === setup.manifest.fileHashes["meshes/lamp-new.glb"],
    );
    expect(additionAsset).toBeDefined();
    expect(
      await readFile(resolve(setup.workspaceRoot, "assets", "generated", additionAsset!.url.slice(1)), "utf8"),
    ).toBe("fresh blender lamp glb fixture");
    const operation = applyAuthoring.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    expect(operation.actions).toContainEqual(
      expect.objectContaining({
        action: "upsert_asset",
        asset: expect.objectContaining({ kind: "prop", name: "Desk Lamp (Blender)" }),
      }),
    );
    expect(operation.actions).toContainEqual(
      expect.objectContaining({
        action: "add_object",
        id: "lamp-new",
        name: "Desk Lamp",
        kind: "prop",
        transform: expect.objectContaining({
          position: [expect.closeTo(0, 6), expect.closeTo(1, 6), expect.closeTo(-2, 6)],
        }),
      }),
    );
    const upsertIndex = operation.actions.findIndex(
      (action) =>
        action.action === "upsert_asset" && (action.asset as { name?: string }).name === "Desk Lamp (Blender)",
    );
    const addIndex = operation.actions.findIndex((action) => action.action === "add_object");
    expect(upsertIndex).toBeGreaterThanOrEqual(0);
    expect(addIndex).toBeGreaterThan(upsertIndex);
  });

  it("keeps a submitted plan's addition opt-in across the server-side rebuild on apply", async () => {
    const setup = await fixture({ addition: true });
    const optedOut = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const applyOptedOut = vi.fn().mockResolvedValue({ success: true });
    await setup.importer.applyImportPlan(
      optedOut,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "addition-optout-1",
      applyOptedOut,
    );
    const optedOutOperation = applyOptedOut.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    expect(optedOutOperation.actions).not.toContainEqual(expect.objectContaining({ action: "add_object" }));
  });

  it("honours per-object intent: one addition skipped on request while another is opted in", async () => {
    const setup = await fixture({ addition: true, secondAddition: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      includeNewObjects: true,
      skipDirectorIds: ["lamp-new"],
    });
    expect(plan.ready).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        op: "skip",
        directorId: "lamp-new",
        reason: expect.stringContaining("skip_director_ids"),
      }),
    );
    expect(plan.operations).toContainEqual(expect.objectContaining({ op: "create_prop", objectId: "shade-new" }));
    expect(plan.operations).not.toContainEqual(expect.objectContaining({ op: "create_prop", objectId: "lamp-new" }));
  });

  it("keeps mixed skip/opt-in addition intent across the server-side rebuild on apply", async () => {
    const setup = await fixture({ addition: true, secondAddition: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      includeNewObjects: true,
      skipDirectorIds: ["lamp-new"],
    });
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(
      plan,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "addition-mixed-1",
      applyAuthoring,
    );
    const operation = applyAuthoring.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    const additions = operation.actions.filter((action) => action.action === "add_object");
    expect(additions).toEqual([expect.objectContaining({ id: "shade-new", name: "Lamp Shade" })]);
    // Only the opted-in mesh is copied into the immutable import directory.
    const copiedHashes = result.copiedAssets.map((asset) => asset.hash);
    expect(copiedHashes).toContain(setup.manifest.fileHashes["meshes/shade-new.glb"]);
    expect(copiedHashes).not.toContain(setup.manifest.fileHashes["meshes/lamp-new.glb"]);
  });

  it("ignores tampered operation payloads: the applied actions come from the server-side rebuild", async () => {
    const setup = await fixture({ addition: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project, {
      includeNewObjects: true,
    });
    // A client resubmits the plan with edited operation payloads (a teleported
    // transform and a forged hash). The plan only locks identity and intent, so
    // the rebuild against the validated package must win over these edits.
    const tampered = structuredClone(plan);
    for (const operation of tampered.operations) {
      if (operation.op === "create_prop") {
        operation.transform = { position: [999, 999, 999], rotation: [0, 0, 0], scale: [1, 1, 1] };
        operation.hash = "e".repeat(64);
      }
      if (operation.op === "update_transform") {
        operation.transform = { position: [-999, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
      }
    }
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(
      tampered,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "tampered-1",
      applyAuthoring,
    );
    const operation = applyAuthoring.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    const addObject = operation.actions.find((action) => action.action === "add_object") as {
      transform: { position: [number, number, number] };
    };
    expect(addObject.transform.position[0]).toBeCloseTo(0, 6);
    expect(addObject.transform.position[1]).toBeCloseTo(1, 6);
    expect(addObject.transform.position[2]).toBeCloseTo(-2, 6);
    // The copied asset carries the manifest hash, not the forged one.
    expect(result.copiedAssets.map((asset) => asset.hash)).toContain(setup.manifest.fileHashes["meshes/lamp-new.glb"]);
    expect(result.copiedAssets.map((asset) => asset.hash)).not.toContain("e".repeat(64));
  });

  it("applies a plan whose JSON key order differs from the server serialization", async () => {
    const setup = await fixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const permuted = reverseKeyOrder(JSON.parse(JSON.stringify(plan)) as typeof plan);
    expect(JSON.stringify(permuted)).not.toBe(JSON.stringify(plan));

    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(
      permuted,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "permuted-1",
      applyAuthoring,
    );
    expect(result.copiedAssets).toHaveLength(1);
    expect(applyAuthoring).toHaveBeenCalledTimes(1);
  });
});

function addRichEntities(project: DirectorProject) {
  project.cameras.push({
    id: "cam-1",
    name: "Camera 1",
    fov: 40,
    focalLengthMm: 35,
    apertureFStop: 2.8,
    focusDistanceM: 3,
    nearClipM: 0.1,
    farClipM: 500,
    transform: { position: [0, 1.6, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
  });
  project.activeCameraId = "cam-1";
  project.lights = [
    {
      id: "light-1",
      name: "Key light",
      type: "point",
      visible: true,
      locked: false,
      color: "#ffaa00",
      intensity: 40,
      position: [2, 3, 1],
    },
  ];
  project.assets.push({
    id: "asset-hero",
    kind: "character",
    sourceType: "model",
    fileName: "hero.glb",
    url: "/models/hero.glb",
    assetSource: "library",
  });
  project.objects.push({
    id: "hero",
    name: "Hero",
    kind: "character",
    visible: true,
    locked: false,
    assetRefId: "asset-hero",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    characterRig: { rigType: "mixamo", posePresetId: null, controls: { "head.yaw": 0, "leftElbow.bend": 10 } },
  });
}

interface RichFixtureOptions {
  /** Write the export-time scene.director-dcc.json snapshot (with optics/lights/pose baselines). */
  baseline?: boolean;
  /** Director-side edits applied to the live project after the export. */
  mutateLive?: (project: DirectorProject) => void;
  /** Aim the pose_update at the prop instead of the rigged character. */
  poseTargetsProp?: boolean;
}

/** A return package carrying camera_update, light_update, and pose_update changes. */
async function richFixture(options: RichFixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "director-dcc-return-rich-"));
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(workspaceRoot, "data");
  const jobDirectory = resolve(dataDirectory, "dcc-jobs", "blender", "job-1");
  const packageDirectory = resolve(jobDirectory, "return-package");
  await mkdir(packageDirectory, { recursive: true });

  const exportProject = createTestDirectorProject();
  addProp(exportProject);
  addRichEntities(exportProject);
  const exportRevision = getDirectorProjectRevision(exportProject);
  const world = worldTransform(exportProject);
  const camera = exportProject.cameras[0]!;
  const cameraBlender = directorTransformToBlender(camera.transform, world);
  const heroBlender = directorTransformToBlender(
    exportProject.objects.find((object) => object.id === "hero")!.transform,
    world,
  );
  const movedCameraBlender = directorTransformToBlender(
    { position: [0, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
    world,
  );
  const heroRootMotionBlender = directorTransformToBlender(
    { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    world,
  );

  const manifest: DirectorDccReturnManifestV1 = {
    schemaVersion: 1,
    contract: "director-dcc-return-v1",
    packageId: "return-package-rich-1",
    sourcePackageId: "source-package-1",
    sourceRevision: exportRevision,
    exportedAt: "2026-08-25T10:00:00.000Z",
    blenderVersion: "4.5.0",
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,z,-y)",
    },
    changes: [
      {
        kind: "camera_update",
        directorId: "cam-1",
        entityType: "camera",
        transform: movedCameraBlender,
        // 400mm and f/0.5 are outside Director's authoring limits and must be
        // baked to the nearest limit with a warning, never silently dropped.
        optics: { focalLengthMm: 400, apertureFStop: 0.5, focusDistanceM: 1.5 },
      },
      {
        kind: "light_update",
        directorId: "light-1",
        entityType: "light",
        // Blender wire space (Z-up): converts back to Director [4, 3, 1].
        properties: { position: [4, -1, 3], intensity: 60, color: "#00FF88" },
      },
      {
        kind: "pose_update",
        directorId: options.poseTargetsProp ? "chair" : "hero",
        entityType: "object",
        controls: { "head.yaw": 500, "leftElbow.bend": 20 },
        transform: heroRootMotionBlender,
      },
    ],
    warnings: [],
    fileHashes: {},
  };
  await writeFile(resolve(packageDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  if (options.baseline) {
    const snapshot = {
      schemaVersion: 1,
      contract: "director-dcc-scene-v1",
      packageId: "source-package-1",
      sourceRevision: exportRevision,
      objects: [
        {
          id: "chair",
          transform: directorTransformToBlender(
            exportProject.objects.find((object) => object.id === "chair")!.transform,
            world,
          ),
          assetRefId: "asset-chair",
        },
        {
          id: "hero",
          transform: heroBlender,
          assetRefId: "asset-hero",
          poseControls: { "head.yaw": 0, "leftElbow.bend": 10 },
        },
      ],
      cameras: [
        {
          id: "cam-1",
          transform: cameraBlender,
          target: directorWorldPointToBlender(camera.target, world),
          focalLengthMm: 35,
          apertureFStop: 2.8,
          focusDistanceM: 3,
          nearClipM: 0.1,
          farClipM: 500,
          sensorFormat: "fullFrame",
        },
      ],
      lights: [
        {
          id: "light-1",
          position: directorWorldPointToBlender([2, 3, 1], world),
          color: "#ffaa00",
          intensity: 40,
        },
      ],
    };
    await writeFile(resolve(jobDirectory, "scene.director-dcc.json"), JSON.stringify(snapshot, null, 2), "utf8");
  }

  const project = structuredClone(exportProject);
  options.mutateLive?.(project);

  return {
    root,
    project,
    exportRevision,
    manifest,
    importer: createBlenderReturnImporter({ workspaceRoot, dataDirectory }),
  };
}

describe("Blender return import: camera optics, lights, and pose controls", () => {
  it("plans clamped optics, converted light patches, and a portable pose sample with root motion", async () => {
    const setup = await richFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    expect(plan.conflicts).toEqual([]);

    expect(plan.operations).toContainEqual({
      op: "update_camera_optics",
      objectId: "cam-1",
      optics: { focal_length_mm: 200, aperture_f_stop: 0.7, focus_distance_m: 1.5 },
    });
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        op: "update_transform",
        entityType: "camera",
        objectId: "cam-1",
        transform: expect.objectContaining({ position: [0, 2, 6] }),
      }),
    );
    expect(plan.warnings.join("\n")).toMatch(/focal length.*baked to 200/);
    expect(plan.warnings.join("\n")).toMatch(/aperture.*baked to 0\.7/);

    const lightOperation = plan.operations.find((operation) => operation.op === "update_light");
    expect(lightOperation).toMatchObject({ lightId: "light-1", patch: { intensity: 60, color: "#00ff88" } });
    const patchPosition = (lightOperation as { patch: { position: [number, number, number] } }).patch.position;
    expect(patchPosition[0]).toBeCloseTo(4, 6);
    expect(patchPosition[1]).toBeCloseTo(3, 6);
    expect(patchPosition[2]).toBeCloseTo(1, 6);

    expect(plan.operations).toContainEqual({
      op: "set_character_pose",
      objectId: "hero",
      controls: [
        { control: "head.yaw", value: 90 },
        { control: "leftElbow.bend", value: 20 },
      ],
    });
    expect(plan.warnings.join("\n")).toMatch(/head\.yaw.*baked to 90/);
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        op: "update_transform",
        entityType: "object",
        objectId: "hero",
        transform: expect.objectContaining({ position: [1, 0, 0] }),
      }),
    );
  });

  it("rejects a pose sample aimed at an object without a Director character rig", async () => {
    const setup = await richFixture({ poseTargetsProp: true });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(false);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ directorId: "chair", code: "entity_type_mismatch" }),
    );
  });

  it("applies one atomic update_camera plus forced light and pose actions", async () => {
    const setup = await richFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    await setup.importer.applyImportPlan(
      plan,
      setup.project,
      getDirectorProjectRevision(setup.project),
      "rich-apply-1",
      applyAuthoring,
    );
    const operation = applyAuthoring.mock.calls[0]![0] as { actions: Array<Record<string, unknown>> };
    const cameraActions = operation.actions.filter((action) => action.action === "update_camera");
    expect(cameraActions).toHaveLength(1);
    expect(cameraActions[0]).toMatchObject({
      camera_id: "cam-1",
      patch: expect.objectContaining({
        position: [0, 2, 6],
        focal_length_mm: 200,
        aperture_f_stop: 0.7,
        focus_distance_m: 1.5,
      }),
    });
    expect(operation.actions).toContainEqual(
      expect.objectContaining({
        action: "update_light",
        light_id: "light-1",
        patch: expect.objectContaining({ intensity: 60, color: "#00ff88" }),
        force: true,
      }),
    );
    expect(operation.actions).toContainEqual(
      expect.objectContaining({
        action: "set_character_pose_controls",
        object_id: "hero",
        controls: [
          { control: "head.yaw", value: 90 },
          { control: "leftElbow.bend", value: 20 },
        ],
        mode: "replace",
        force: true,
      }),
    );
    expect(operation.actions).toContainEqual(
      expect.objectContaining({ action: "update_object", object_id: "hero", force: true }),
    );
  });

  it("conflicts each entity edited on both sides when merging through the export snapshot", async () => {
    const setup = await richFixture({
      baseline: true,
      mutateLive: (project) => {
        project.cameras[0]!.focalLengthMm = 50;
        project.lights![0]!.intensity = 75;
        project.objects.find((object) => object.id === "hero")!.characterRig!.controls["head.yaw"] = 30;
      },
    });
    expect(getDirectorProjectRevision(setup.project)).not.toBe(setup.exportRevision);

    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(false);
    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ directorId: "cam-1", code: "stale_source_revision" }),
        expect.objectContaining({ directorId: "light-1", code: "stale_source_revision" }),
        expect.objectContaining({ directorId: "hero", code: "stale_source_revision" }),
      ]),
    );
    expect(plan.conflicts).toHaveLength(3);
  });

  it("merges cleanly through the export snapshot when only unrelated Director state moved", async () => {
    const setup = await richFixture({
      baseline: true,
      mutateLive: (project) => {
        project.scene.backgroundColor = "#101418";
      },
    });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.conflicts).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.operations).toContainEqual(expect.objectContaining({ op: "update_camera_optics", objectId: "cam-1" }));
    expect(plan.operations).toContainEqual(expect.objectContaining({ op: "update_light", lightId: "light-1" }));
    expect(plan.operations).toContainEqual(expect.objectContaining({ op: "set_character_pose", objectId: "hero" }));
  });
});
