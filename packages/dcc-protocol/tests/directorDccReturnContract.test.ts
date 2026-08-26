import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { DirectorTransform } from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";
import { createDefaultDirectorProject } from "../../../frontend/director/src/comprehensive/editor/store/directorStore";
import {
  blenderTransformToDirector,
  directorDccOperationSchema,
  directorTransformToBlender,
} from "../src/directorDccContract";
import { directorDccImportPlanSchema, directorDccReturnManifestSchema } from "../src/directorDccReturnContract";

function transformMatrix(transform: DirectorTransform) {
  return new Matrix4().compose(
    new Vector3(...transform.position),
    new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")),
    new Vector3(...transform.scale),
  );
}

describe("Director DCC return contract", () => {
  it("round-trips a non-trivial transform through Blender coordinates", () => {
    const source: DirectorTransform = {
      position: [1.25, 2.5, -3.75],
      rotation: [0.31, -0.72, 1.18],
      scale: [0.8, 1.4, 2.1],
    };
    const roundTrip = blenderTransformToDirector(directorTransformToBlender(source));
    const left = transformMatrix(source).elements;
    const right = transformMatrix(roundTrip).elements;
    left.forEach((value, index) => expect(right[index]).toBeCloseTo(value, 5));
  });

  it("round-trips transforms relative to a Director scene transform", () => {
    const local = {
      position: [2, 0.5, -1] as [number, number, number],
      rotation: [0.1, 0.2, -0.3] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    const scene = {
      position: [5, 1, 2] as [number, number, number],
      rotation: [0, 0.4, 0] as [number, number, number],
      scale: [1.2, 1.2, 1.2] as [number, number, number],
    };
    const roundTrip = blenderTransformToDirector(directorTransformToBlender(local, scene), scene);
    const left = transformMatrix(local).elements;
    const right = transformMatrix(roundTrip).elements;
    left.forEach((value, index) => expect(right[index]).toBeCloseTo(value, 5));
  });

  it("validates manifest hashes and rejects unsafe relative paths", () => {
    const project = createDefaultDirectorProject();
    const sourceRevision = expect.stringMatching(/^director-project-revision:/);
    const valid = {
      schemaVersion: 1,
      contract: "director-dcc-return-v1",
      packageId: "return-1",
      sourcePackageId: "source-1",
      sourceRevision: "director-project-revision:v1:sha256:" + "a".repeat(64),
      exportedAt: "2026-08-03T10:00:00.000Z",
      blenderVersion: "4.5.0",
      coordinateSystem: {
        source: "right-handed-z-up-negative-z-camera-forward",
        destination: "right-handed-y-up-negative-z-forward",
        unit: "meter",
        linearMap: "(x,y,z)->(x,z,-y)",
      },
      changes: [
        {
          kind: "mesh_replacement",
          directorId: project.objects[0]!.id,
          entityType: "object",
          meshFile: "meshes/hero.glb",
        },
      ],
      warnings: [],
      fileHashes: { "meshes/hero.glb": "b".repeat(64) },
    };
    expect(sourceRevision).toBeDefined();
    expect(directorDccReturnManifestSchema.safeParse(valid).success).toBe(true);
    expect(
      directorDccReturnManifestSchema.safeParse({
        ...valid,
        changes: [{ ...valid.changes[0], meshFile: "../hero.glb" }],
        fileHashes: { "../hero.glb": "b".repeat(64) },
      }).success,
    ).toBe(false);
    expect(directorDccReturnManifestSchema.safeParse({ ...valid, fileHashes: {} }).success).toBe(false);
  });

  it("accepts typed omittedOptics on import plans and rejects count mismatches", () => {
    const revision = "director-project-revision:v1:sha256:" + "a".repeat(64);
    const base = {
      contract: "director-dcc-import-plan-v1",
      ready: true,
      packageId: "return-1",
      packageDir: "job-1/return-package",
      manifestHash: "b".repeat(64),
      sourceRevision: revision,
      targetRevision: revision,
      operations: [],
      conflicts: [],
      warnings: ["Camera cam-1 sensor format omitted"],
      omittedOpticsCount: 1,
      omittedOptics: [
        {
          directorId: "cam-1",
          code: "sensor_format",
          field: "sensorFormat",
          reason: "Camera cam-1 sensor format 'imax65' was omitted from the return plan (warn-and-omit).",
        },
      ],
    };
    expect(directorDccImportPlanSchema.safeParse(base).success).toBe(true);
    expect(directorDccImportPlanSchema.safeParse({ ...base, omittedOpticsCount: undefined }).success).toBe(false);
    expect(directorDccImportPlanSchema.safeParse({ ...base, omittedOpticsCount: 2 }).success).toBe(false);
    expect(
      directorDccImportPlanSchema.safeParse({ ...base, omittedOptics: undefined, omittedOpticsCount: undefined })
        .success,
    ).toBe(true);
  });

  it("requires a SHA-256 for object_addition meshes and keeps new-object import opt-in", () => {
    const base = {
      schemaVersion: 1,
      contract: "director-dcc-return-v1",
      packageId: "return-additions-1",
      sourcePackageId: "source-1",
      sourceRevision: "director-project-revision:v1:sha256:" + "a".repeat(64),
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
          kind: "object_addition",
          directorId: "lamp-new",
          entityType: "object",
          name: "Desk Lamp",
          meshFile: "meshes/lamp-new.glb",
          transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
          assetLabel: "Desk Lamp (Blender)",
        },
      ],
      warnings: [],
      fileHashes: { "meshes/lamp-new.glb": "b".repeat(64) },
    };
    expect(directorDccReturnManifestSchema.safeParse(base).success).toBe(true);
    expect(directorDccReturnManifestSchema.safeParse({ ...base, fileHashes: {} }).success).toBe(false);
    // Opting into new-object import is an explicit request flag, never a default.
    expect(
      directorDccOperationSchema.parse({ op: "import_return_package", package_dir: "job-1/return-package" }),
    ).toMatchObject({ include_new_objects: false });
    expect(
      directorDccOperationSchema.parse({
        op: "import_return_package",
        package_dir: "job-1/return-package",
        include_new_objects: true,
      }),
    ).toMatchObject({ include_new_objects: true });
  });

  it("keeps Blender manifests honest about their producer and coordinate stanza", () => {
    const project = createDefaultDirectorProject();
    const blenderManifest = {
      schemaVersion: 1,
      contract: "director-dcc-return-v1",
      packageId: "return-2",
      sourcePackageId: "source-2",
      sourceRevision: "director-project-revision:v1:sha256:" + "a".repeat(64),
      exportedAt: "2026-08-03T10:00:00.000Z",
      blenderVersion: "4.5.0",
      coordinateSystem: {
        source: "right-handed-z-up-negative-z-camera-forward",
        destination: "right-handed-y-up-negative-z-forward",
        unit: "meter",
        linearMap: "(x,y,z)->(x,z,-y)",
      },
      changes: [
        {
          kind: "transform_update",
          directorId: project.objects[0]!.id,
          entityType: "object",
          transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      ],
      warnings: [],
      fileHashes: {},
    };
    expect(directorDccReturnManifestSchema.safeParse(blenderManifest).success).toBe(true);
    // A Blender package cannot drop blenderVersion or claim the canonical stanza.
    expect(directorDccReturnManifestSchema.safeParse({ ...blenderManifest, blenderVersion: undefined }).success).toBe(
      false,
    );
    expect(
      directorDccReturnManifestSchema.safeParse({
        ...blenderManifest,
        coordinateSystem: {
          source: "right-handed-y-up-negative-z-forward",
          destination: "right-handed-y-up-negative-z-forward",
          unit: "meter",
          linearMap: "identity",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts engine return manifests in canonical Director space with host provenance", () => {
    const project = createDefaultDirectorProject();
    const engineManifest = {
      schemaVersion: 1,
      contract: "director-dcc-return-v1",
      packageId: "return-3",
      sourcePackageId: "5f6b0f1e-8a4e-4f57-9d2b-0f30a1b2c3d4",
      sourceRevision: "director-project-revision:v1:sha256:" + "a".repeat(64),
      exportedAt: "2026-08-03T10:00:00.000Z",
      provider: "godot",
      hostVersion: "4.3.stable",
      connectorVersion: "0.1.0",
      coordinateSystem: {
        source: "right-handed-y-up-negative-z-forward",
        destination: "right-handed-y-up-negative-z-forward",
        unit: "meter",
        linearMap: "identity",
      },
      changes: [
        {
          kind: "transform_update",
          directorId: project.objects[0]!.id,
          entityType: "object",
          transform: { location: [1, 2, 3], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      ],
      warnings: [],
      fileHashes: {},
    };
    expect(directorDccReturnManifestSchema.safeParse(engineManifest).success).toBe(true);
    // Engine packages must carry the host version and the canonical stanza.
    expect(directorDccReturnManifestSchema.safeParse({ ...engineManifest, hostVersion: undefined }).success).toBe(
      false,
    );
    expect(
      directorDccReturnManifestSchema.safeParse({
        ...engineManifest,
        coordinateSystem: {
          source: "right-handed-z-up-negative-z-camera-forward",
          destination: "right-handed-y-up-negative-z-forward",
          unit: "meter",
          linearMap: "(x,y,z)->(x,z,-y)",
        },
      }).success,
    ).toBe(false);
    expect(directorDccReturnManifestSchema.safeParse({ ...engineManifest, provider: "maya" }).success).toBe(false);
  });

  it("accepts dry-run and revision-guarded apply operations", () => {
    const plan = {
      contract: "director-dcc-import-plan-v1",
      ready: true,
      packageId: "return-1",
      packageDir: "job-1/return-package",
      manifestHash: "c".repeat(64),
      sourceRevision: "director-project-revision:v1:sha256:" + "d".repeat(64),
      targetRevision: "director-project-revision:v1:sha256:" + "d".repeat(64),
      operations: [],
      conflicts: [],
      warnings: [],
    };
    expect(
      directorDccOperationSchema.parse({ op: "import_return_package", package_dir: "job-1/return-package" }),
    ).toMatchObject({ dry_run: true });
    expect(
      directorDccOperationSchema.safeParse({
        op: "apply_import_plan",
        plan,
        expected_revision: plan.targetRevision,
        idempotency_key: "return-1",
      }).success,
    ).toBe(true);
    expect(
      directorDccOperationSchema.parse({
        op: "preview_blend_scene_import",
        package_dir: "blend-job-1/package",
      }),
    ).toMatchObject({ op: "preview_blend_scene_import" });
    expect(
      directorDccOperationSchema.safeParse({
        op: "apply_blend_scene_import",
        plan_id: "blend-job-1/default",
        expected_revision: plan.targetRevision,
        idempotency_key: "blend-import-1",
      }).success,
    ).toBe(true);
    expect(
      directorDccOperationSchema.safeParse({
        op: "apply_blend_scene_import",
        plan_id: "../escape",
        expected_revision: plan.targetRevision,
        idempotency_key: "blend-import-escape",
      }).success,
    ).toBe(false);
  });
});
