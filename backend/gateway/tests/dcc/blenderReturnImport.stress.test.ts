import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import type { DirectorProject, DirectorTransform } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { directorTransformToBlender, directorDccImportPlanSchema } from "@director/dcc-protocol";
import type { DirectorDccImportPlanV1, DirectorDccReturnManifestV1 } from "@director/dcc-protocol";
import { DirectorDccImportError, createBlenderReturnImporter } from "../../dcc/blenderReturnImport";

/**
 * Adversarial stress tests for the Blender return-import boundary. Every test
 * here runs host-free (no Blender install): the contract itself is the unit
 * under test. Covered: SHA-256 tampering, manifest truncation, path escapes,
 * duplicate and overlong ids, illegal enums, mirrored (negative-scale)
 * hierarchies, plan forgery on apply, and concurrent plan/apply races.
 */

function digest(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function worldTransform(project: DirectorProject): DirectorTransform {
  return {
    position: project.scene.position,
    rotation: project.scene.rotation,
    scale: [project.scene.scale, project.scene.scale, project.scene.scale],
  };
}

function matrixOf(transform: DirectorTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
}

interface StressFixtureOptions {
  /** Extra changes appended after the default mesh_replacement for the chair. */
  extraChanges?: DirectorDccReturnManifestV1["changes"];
  /** Replace the default changes entirely. */
  changes?: DirectorDccReturnManifestV1["changes"];
  /** Mutate (or replace) the manifest object right before it is written. */
  mutateManifest?: (manifest: Record<string, unknown>) => Record<string, unknown> | void;
  /** Extra file hash entries stamped verbatim into the manifest. */
  extraFileHashes?: Record<string, string>;
  /** Skip writing the chair mesh change/file (manifest carries only custom changes). */
  omitMesh?: boolean;
}

async function stressFixture(options: StressFixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "director-dcc-stress-"));
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(workspaceRoot, "data");
  const jobRoot = resolve(dataDirectory, "dcc-jobs", "blender");
  const jobDirectory = resolve(jobRoot, "job-1");
  const packageDirectory = resolve(jobDirectory, "return-package");
  await mkdir(resolve(packageDirectory, "meshes"), { recursive: true });

  const exportProject = createTestDirectorProject();
  exportProject.assets.push({
    id: "asset-chair",
    kind: "prop",
    sourceType: "model",
    fileName: "chair.glb",
    url: "/models/chair.glb",
    assetSource: "library",
  });
  exportProject.objects.push({
    id: "chair",
    name: "Chair",
    kind: "prop",
    visible: true,
    locked: false,
    assetRefId: "asset-chair",
    transform: { position: [1, 0, 2], rotation: [0, 0.25, 0], scale: [1, 1, 1] },
  });
  const exportRevision = getDirectorProjectRevision(exportProject);
  const world = worldTransform(exportProject);
  const chairBlender = directorTransformToBlender(
    exportProject.objects.find((object) => object.id === "chair")!.transform,
    world,
  );

  const mesh = new TextEncoder().encode("deterministic fake glb stress fixture");
  const meshPath = resolve(packageDirectory, "meshes", "chair.glb");
  if (!options.omitMesh) await writeFile(meshPath, mesh);

  const defaultChanges: DirectorDccReturnManifestV1["changes"] = options.omitMesh
    ? []
    : [
        {
          kind: "mesh_replacement",
          directorId: "chair",
          entityType: "object",
          meshFile: "meshes/chair.glb",
          transform: chairBlender,
          assetLabel: "Chair refined",
        },
      ];
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    contract: "director-dcc-return-v1",
    packageId: "stress-package-1",
    sourcePackageId: "source-package-1",
    sourceRevision: exportRevision,
    exportedAt: "2026-08-25T10:00:00.000Z",
    blenderVersion: "5.1.2",
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,z,-y)",
    },
    changes: options.changes ?? [...defaultChanges, ...(options.extraChanges ?? [])],
    warnings: [],
    fileHashes: {
      ...(options.omitMesh ? {} : { "meshes/chair.glb": digest(mesh) }),
      ...options.extraFileHashes,
    },
  };
  const written = options.mutateManifest?.(manifest) ?? manifest;
  const manifestPath = resolve(packageDirectory, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(written, null, 2), "utf8");

  return {
    root,
    workspaceRoot,
    dataDirectory,
    jobRoot,
    packageDirectory,
    manifestPath,
    meshPath,
    mesh,
    world,
    project: structuredClone(exportProject),
    exportRevision,
    importer: createBlenderReturnImporter({ workspaceRoot, dataDirectory }),
  };
}

async function expectImportError(promise: Promise<unknown>, code: string, status?: number) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DirectorDccImportError);
  const typed = error as DirectorDccImportError;
  expect(typed.code).toBe(code);
  if (status !== undefined) expect(typed.status).toBe(status);
  expect(typed.recovery.length).toBeGreaterThan(0);
  return typed;
}

describe("return-import stress: SHA-256 tampering and truncation", () => {
  it("hard-fails when a manifest hash entry is flipped by one hex digit", async () => {
    const setup = await stressFixture({
      mutateManifest: (manifest) => {
        const hashes = manifest.fileHashes as Record<string, string>;
        const key = "meshes/chair.glb";
        const original = hashes[key]!;
        hashes[key] = (original[0] === "0" ? "1" : "0") + original.slice(1);
      },
    });
    const error = await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
    expect(error.message).toMatch(/SHA-256 mismatch/);
  });

  it("hard-fails when the mesh file is truncated after export", async () => {
    const setup = await stressFixture();
    await truncate(setup.meshPath, Math.floor(setup.mesh.byteLength / 2));
    const error = await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
    expect(error.message).toMatch(/SHA-256 mismatch/);
  });

  it("hard-fails when extra bytes are appended to a hashed mesh", async () => {
    const setup = await stressFixture();
    await appendFile(setup.meshPath, "trailing-garbage");
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a truncated manifest.json as invalid JSON, not a crash", async () => {
    const setup = await stressFixture();
    const bytes = await readFile(setup.manifestPath);
    await writeFile(setup.manifestPath, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
    const error = await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
    expect(error.message).toMatch(/not valid JSON/);
  });

  it("rejects an empty manifest.json", async () => {
    const setup = await stressFixture();
    await writeFile(setup.manifestPath, "");
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a manifest whose contract literal was rewritten", async () => {
    const setup = await stressFixture({
      mutateManifest: (manifest) => {
        manifest.contract = "director-dcc-return-v2";
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("re-validates instead of serving a cached package after the manifest is tampered", async () => {
    const setup = await stressFixture();
    const first = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(first.ready).toBe(true);
    // Tamper: swap the packageId while keeping everything else intact. A
    // manifest-hash-keyed cache must notice and re-run full validation.
    const manifest = JSON.parse(await readFile(setup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.packageId = "stress-package-forged";
    manifest.fileHashes = { "meshes/chair.glb": "0".repeat(64) };
    await writeFile(setup.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await expectImportError(
      setup.importer.buildImportPlan("job-1/return-package", setup.project),
      "package_invalid",
    );
  });

  it("fails apply when the mesh bytes are swapped between plan build and apply", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    await writeFile(setup.meshPath, "post-plan mesh replacement attack");
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    await expectImportError(
      setup.importer.applyImportPlan(plan, setup.project, plan.targetRevision, "stress-swap-1", applyAuthoring),
      "package_invalid",
    );
    expect(applyAuthoring).not.toHaveBeenCalled();
  });
});

describe("return-import stress: path escapes", () => {
  it("rejects a parent-directory package path", async () => {
    const setup = await stressFixture();
    await expectImportError(setup.importer.validatePackage("../../../etc"), "path_escape", 403);
  });

  it("rejects an absolute package path outside the job root", async () => {
    const setup = await stressFixture();
    await expectImportError(setup.importer.validatePackage("/etc"), "path_escape", 403);
  });

  it("rejects manifest hash keys that traverse with ../", async () => {
    const setup = await stressFixture({
      extraFileHashes: { "../outside.glb": "0".repeat(64) },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects manifest hash keys that are absolute paths", async () => {
    const setup = await stressFixture({
      extraFileHashes: { "/tmp/outside.glb": "0".repeat(64) },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects manifest hash keys that use backslashes", async () => {
    const setup = await stressFixture({
      extraFileHashes: { "meshes\\evil.glb": "0".repeat(64) },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a hashed file that is a symlink escaping the package root", async () => {
    const setup = await stressFixture();
    const outside = resolve(setup.root, "outside.glb");
    await writeFile(outside, setup.mesh);
    const linked = resolve(setup.packageDirectory, "meshes", "linked.glb");
    await symlink(outside, linked);
    const manifest = JSON.parse(await readFile(setup.manifestPath, "utf8")) as {
      fileHashes: Record<string, string>;
    };
    manifest.fileHashes["meshes/linked.glb"] = digest(setup.mesh);
    await writeFile(setup.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "path_escape", 403);
  });

  it("rejects a package directory that is a symlink escaping the job root", async () => {
    const setup = await stressFixture();
    const escaped = resolve(setup.root, "escaped-package");
    await mkdir(escaped, { recursive: true });
    await writeFile(resolve(escaped, "manifest.json"), "{}", "utf8");
    await symlink(escaped, resolve(setup.jobRoot, "job-1", "linked-package"));
    await expectImportError(setup.importer.validatePackage("job-1/linked-package"), "path_escape", 403);
  });

  it("rejects a package path that resolves to a file instead of a directory", async () => {
    const setup = await stressFixture();
    await expectImportError(
      setup.importer.validatePackage("job-1/return-package/manifest.json"),
      "package_invalid",
    );
  });

  it("rejects an unknown package directory with a structured 404", async () => {
    const setup = await stressFixture();
    await expectImportError(setup.importer.validatePackage("job-1/nope"), "package_invalid", 404);
  });
});

describe("return-import stress: id, enum, and size boundaries", () => {
  it("rejects a directorId beyond 200 characters", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      changes: [
        {
          kind: "transform_update",
          directorId: "x".repeat(201),
          entityType: "object",
          transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      ],
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects an empty-string directorId", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      changes: [
        {
          kind: "transform_update",
          directorId: "",
          entityType: "object",
          transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      ],
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects duplicate changes for the same entity", async () => {
    const transform = { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
    const setup = await stressFixture({
      omitMesh: true,
      changes: [
        { kind: "transform_update", directorId: "chair", entityType: "object", transform: { ...transform } },
        { kind: "transform_update", directorId: "chair", entityType: "object", transform: { ...transform } },
      ],
    });
    const error = await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
    expect(error.message).toMatch(/duplicate return change/);
  });

  it("rejects an illegal sensor format enum", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      changes: [
        {
          kind: "camera_update",
          directorId: "cam-1",
          entityType: "camera",
          optics: { sensorFormat: "imax-1570" as never },
        },
      ],
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects non-finite optics values", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      mutateManifest: (manifest) => {
        manifest.changes = [
          {
            kind: "camera_update",
            directorId: "cam-1",
            entityType: "camera",
            optics: { focalLengthMm: "Infinity" },
          },
        ];
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects pose updates with unknown control keys", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      mutateManifest: (manifest) => {
        manifest.changes = [
          {
            kind: "pose_update",
            directorId: "hero",
            entityType: "object",
            controls: { "tail.wag": 1 },
          },
        ];
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a camera_update carrying neither transform nor optics", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      mutateManifest: (manifest) => {
        manifest.changes = [{ kind: "camera_update", directorId: "cam-1", entityType: "camera" }];
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a Blender manifest without blenderVersion", async () => {
    const setup = await stressFixture({
      mutateManifest: (manifest) => {
        delete manifest.blenderVersion;
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a Blender manifest with the canonical (engine) coordinate stanza", async () => {
    const setup = await stressFixture({
      mutateManifest: (manifest) => {
        manifest.coordinateSystem = {
          source: "right-handed-y-up-negative-z-forward",
          destination: "right-handed-y-up-negative-z-forward",
          unit: "meter",
          linearMap: "identity",
        };
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("rejects a manifest with more than 20000 changes", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      mutateManifest: (manifest) => {
        manifest.changes = Array.from({ length: 20_001 }, (_, index) => ({
          kind: "transform_update",
          directorId: `obj-${index}`,
          entityType: "object",
          transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        }));
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  }, 30_000);

  it("rejects a single warning string beyond 2000 characters", async () => {
    const setup = await stressFixture({
      mutateManifest: (manifest) => {
        manifest.warnings = ["w".repeat(2_001)];
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });

  it("accepts an empty changes array and produces an empty ready plan", async () => {
    const setup = await stressFixture({ omitMesh: true, changes: [] });
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.adjustments).toEqual([]);
  });

  it("rejects a zero-scale transform at the schema boundary", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      mutateManifest: (manifest) => {
        manifest.changes = [
          {
            kind: "transform_update",
            directorId: "chair",
            entityType: "object",
            transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 0, 1] },
          },
        ];
      },
    });
    await expectImportError(setup.importer.validatePackage("job-1/return-package"), "package_invalid");
  });
});

describe("return-import stress: mirrored (negative-scale) hierarchies", () => {
  it("round-trips a mirrored transform through the Blender wire space losslessly", async () => {
    const mirrored: DirectorTransform = { position: [1, 0, 2], rotation: [0, 0.25, 0], scale: [-1, 1, 1] };
    const setup = await stressFixture({ omitMesh: true, changes: [] });
    const wire = directorTransformToBlender(mirrored, setup.world);
    const manifest = JSON.parse(await readFile(setup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.changes = [
      { kind: "transform_update", directorId: "chair", entityType: "object", transform: wire },
    ];
    await writeFile(setup.manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    const operation = plan.operations.find((candidate) => candidate.op === "update_transform");
    expect(operation).toBeDefined();
    const applied = (operation as { transform: DirectorTransform }).transform;
    applied.position.forEach((value) => expect(Number.isFinite(value)).toBe(true));
    applied.rotation.forEach((value) => expect(Number.isFinite(value)).toBe(true));
    applied.scale.forEach((value) => expect(Number.isFinite(value)).toBe(true));
    // The decomposition may express the mirror on a different axis, so assert
    // matrix equivalence instead of raw component equality.
    const expected = matrixOf(mirrored);
    const received = matrixOf(applied);
    expected.elements.forEach((value, index) => {
      expect(received.elements[index]).toBeCloseTo(value, 6);
    });
  });
});

describe("return-import stress: structured adjustments", () => {
  it("reports every limit bake as a structured adjustment alongside the prose warning", async () => {
    const setup = await stressFixture({
      omitMesh: true,
      changes: [
        {
          kind: "camera_update",
          directorId: "cam-1",
          entityType: "camera",
          optics: { focalLengthMm: 400, apertureFStop: 0.5 },
        },
        {
          kind: "light_update",
          directorId: "light-1",
          entityType: "light",
          properties: { intensity: 100 },
        },
      ],
    });
    setup.project.cameras.push({
      id: "cam-1",
      name: "Camera 1",
      fov: 40,
      transform: { position: [0, 1.6, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      target: [0, 1, 0],
    });
    setup.project.lights = [
      {
        id: "light-1",
        name: "Key",
        type: "point",
        visible: true,
        locked: false,
        color: "#ffffff",
        intensity: 10,
        position: [0, 2, 0],
      },
    ];
    // The project changed after export (entities added), so rebuild against
    // the live revision by rewriting sourceRevision to match.
    const manifest = JSON.parse(await readFile(setup.manifestPath, "utf8")) as Record<string, unknown>;
    manifest.sourceRevision = getDirectorProjectRevision(setup.project);
    await writeFile(setup.manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    expect(plan.ready).toBe(true);
    expect(plan.adjustments).toEqual([
      {
        directorId: "cam-1",
        field: "focal_length_mm",
        code: "baked_to_limit",
        requested: 400,
        applied: 200,
        min: 12,
        max: 200,
      },
      expect.objectContaining({ directorId: "cam-1", field: "aperture_f_stop", code: "baked_to_limit" }),
    ]);
    // In-range light intensity must not fabricate an adjustment.
    expect(plan.adjustments.some((entry) => entry.directorId === "light-1")).toBe(false);
    for (const adjustment of plan.adjustments) {
      expect(plan.warnings.join("\n")).toContain(`baked to ${adjustment.applied}`);
    }
  });

  it("parses legacy plans without adjustments and defaults them to an empty list", () => {
    const legacy = {
      contract: "director-dcc-import-plan-v1",
      ready: true,
      packageId: "legacy",
      packageDir: "job-1/return-package",
      manifestHash: "0".repeat(64),
      sourceRevision: `director-project-revision:v1:sha256:${"0".repeat(64)}`,
      targetRevision: `director-project-revision:v1:sha256:${"0".repeat(64)}`,
      operations: [],
      conflicts: [],
      warnings: [],
    };
    const parsed = directorDccImportPlanSchema.parse(legacy);
    expect(parsed.adjustments).toEqual([]);
  });
});

describe("return-import stress: apply-time forgery and races", () => {
  it("rejects apply when the submitted manifestHash was tampered", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const forged: DirectorDccImportPlanV1 = { ...plan, manifestHash: "f".repeat(64) };
    await expectImportError(
      setup.importer.applyImportPlan(
        forged,
        setup.project,
        plan.targetRevision,
        "stress-forged-hash",
        vi.fn().mockResolvedValue({ success: true }),
      ),
      "package_invalid",
      409,
    );
  });

  it("rejects apply when the submitted packageId was tampered", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const forged: DirectorDccImportPlanV1 = { ...plan, packageId: "stress-package-other" };
    await expectImportError(
      setup.importer.applyImportPlan(
        forged,
        setup.project,
        plan.targetRevision,
        "stress-forged-package",
        vi.fn().mockResolvedValue({ success: true }),
      ),
      "package_invalid",
      409,
    );
  });

  it("rejects apply when the expected revision does not match the live project", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    await expectImportError(
      setup.importer.applyImportPlan(
        plan,
        setup.project,
        `director-project-revision:v1:sha256:${"1".repeat(64)}`,
        "stress-stale-revision",
        vi.fn().mockResolvedValue({ success: true }),
      ),
      "stale_project_revision",
      409,
    );
  });

  it("rejects a plan that claims ready while carrying conflicts at the schema boundary", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const forged = {
      ...plan,
      conflicts: [{ directorId: "chair", code: "unknown_director_id", reason: "forged conflict" }],
    };
    await expect(
      setup.importer.applyImportPlan(
        forged as DirectorDccImportPlanV1,
        setup.project,
        plan.targetRevision,
        "stress-ready-conflict",
        vi.fn().mockResolvedValue({ success: true }),
      ),
    ).rejects.toThrow(/ready plans cannot contain conflicts/);
  });

  it("ignores forged create_prop operations that the package cannot justify", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const forged: DirectorDccImportPlanV1 = {
      ...plan,
      operations: [
        ...plan.operations,
        {
          op: "create_prop",
          objectId: "smuggled",
          name: "Smuggled",
          assetId: "asset-smuggled",
          assetLabel: "Smuggled",
          glbPath: "meshes/chair.glb",
          hash: digest(setup.mesh),
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    };
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const result = await setup.importer.applyImportPlan(
      forged,
      setup.project,
      plan.targetRevision,
      "stress-smuggle",
      applyAuthoring,
    );
    // The server-side rebuild derives operations from the validated package
    // only; the smuggled prop cannot survive.
    expect(result.plan.operations.some((operation) => operation.op === "create_prop")).toBe(false);
    const operation = applyAuthoring.mock.calls[0]![0] as { actions: Array<{ action: string; id?: string }> };
    expect(operation.actions.some((action) => action.action === "add_object")).toBe(false);
  });

  it("keeps 16 concurrent plan builds deterministic and identical", async () => {
    const setup = await stressFixture();
    const plans = await Promise.all(
      Array.from({ length: 16 }, () => setup.importer.buildImportPlan("job-1/return-package", setup.project)),
    );
    const serialized = plans.map((plan) => JSON.stringify(plan));
    expect(new Set(serialized).size).toBe(1);
    expect(plans[0]!.ready).toBe(true);
  });

  it("keeps concurrent applies safe: every outcome is success or a structured error", async () => {
    const setup = await stressFixture();
    const plan = await setup.importer.buildImportPlan("job-1/return-package", setup.project);
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        setup.importer
          .applyImportPlan(plan, setup.project, plan.targetRevision, `stress-concurrent-${index}`, applyAuthoring)
          .then(
            (result) => ({ ok: true as const, result }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
      ),
    );
    const succeeded = outcomes.filter((outcome) => outcome.ok);
    expect(succeeded.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      if (!outcome.ok) expect(outcome.error).toBeInstanceOf(DirectorDccImportError);
    }
    // The immutable copied asset must hold exactly the hashed mesh bytes.
    const copied = succeeded[0]!.result.copiedAssets;
    expect(copied).toHaveLength(1);
    const copiedPath = resolve(
      setup.workspaceRoot,
      "assets",
      "generated",
      "dcc-import",
      copied[0]!.url.replace("/dcc-import/", ""),
    );
    expect(digest(await readFile(copiedPath))).toBe(copied[0]!.hash);
  });
});
