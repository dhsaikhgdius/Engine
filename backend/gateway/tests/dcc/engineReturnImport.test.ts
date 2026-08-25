import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DirectorProject } from "@director/project-schema";
import { getDirectorProjectRevision } from "@director/project-schema";
import {
  directorTransformToCanonicalDcc,
  directorWorldPointToCanonical,
  type DirectorDccReturnManifestV1,
  type DirectorTransform,
} from "@director/dcc-protocol";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { createDccReturnImporter } from "../../dcc/blenderReturnImport";

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

function addTable(project: DirectorProject) {
  project.objects.push({
    id: "table",
    name: "Table",
    kind: "prop",
    visible: true,
    locked: false,
    geometryType: "box",
    transform: { position: [2, 0, -1], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
  });
}

interface EngineFixtureOptions {
  stale?: boolean;
  /** Write the exchange package manifest so stale merges have a baseline. */
  exchangeBaseline?: boolean;
  /** Director-side edits applied to the live project after the export. */
  mutateLive?: (project: DirectorProject) => void;
  /** Return change transform for the table (defaults to a real move). */
  tableReturnPosition?: [number, number, number];
}

async function engineFixture(options: EngineFixtureOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "director-engine-return-"));
  const workspaceRoot = resolve(root, "workspace");
  const dataDirectory = resolve(workspaceRoot, "data");
  const packageId = randomUUID();
  const jobDirectory = resolve(dataDirectory, "dcc-jobs", "unreal", packageId);
  const packageDirectory = resolve(jobDirectory, "return");
  await mkdir(packageDirectory, { recursive: true });

  const exportProject = createTestDirectorProject();
  // A non-identity scene transform proves canonical wire transforms are
  // composed and inverted against the Director scene transform.
  exportProject.scene.position = [1, 0, -2];
  exportProject.scene.rotation = [0, Math.PI / 6, 0];
  exportProject.scene.scale = 2;
  addTable(exportProject);
  const exportRevision = getDirectorProjectRevision(exportProject);
  const exportWorld = worldTransform(exportProject);

  const tableReturnPosition = options.tableReturnPosition ?? ([4, 1, -1] as [number, number, number]);
  const changes: DirectorDccReturnManifestV1["changes"] = [
    {
      kind: "transform_update",
      directorId: "table",
      entityType: "object",
      transform: directorTransformToCanonicalDcc(
        { position: tableReturnPosition, rotation: [0, 0.5, 0], scale: [1, 1, 1] },
        exportWorld,
      ),
    },
  ];
  const manifest: DirectorDccReturnManifestV1 = {
    schemaVersion: 1,
    contract: "director-dcc-return-v1",
    packageId: `unreal-return-${packageId}`,
    sourcePackageId: packageId,
    sourceRevision: options.stale ? (`director-project-revision:v1:sha256:${"0".repeat(64)}` as const) : exportRevision,
    exportedAt: "2026-08-20T10:00:00.000Z",
    provider: "unreal",
    hostVersion: "Unreal Engine 5.6.1",
    connectorVersion: "0.1.0",
    coordinateSystem: {
      source: "right-handed-y-up-negative-z-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "identity",
    },
    changes,
    warnings: [],
    fileHashes: {},
  };
  await writeFile(resolve(packageDirectory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  if (options.exchangeBaseline) {
    const exchangeDirectory = resolve(dataDirectory, "dcc-jobs", "exchange", "unreal", packageId);
    await mkdir(exchangeDirectory, { recursive: true });
    const exchangeManifest = {
      contract: "director-dcc-exchange-package-v1",
      packageId,
      provider: "unreal",
      sourceRevision: manifest.sourceRevision,
      createdAt: "2026-08-20T09:00:00Z",
      coordinateSystem: {
        linearUnit: "meter",
        metersPerUnit: 1,
        upAxis: "Y",
        handedness: "right",
        cameraForward: "-Z",
      },
      project: exportProject,
      formats: [],
      assets: [],
      warnings: [],
    };
    await writeFile(resolve(exchangeDirectory, "manifest.json"), JSON.stringify(exchangeManifest, null, 2), "utf8");
  }

  const project = structuredClone(exportProject);
  options.mutateLive?.(project);

  return {
    workspaceRoot,
    dataDirectory,
    packageId,
    project,
    exportProject,
    exportRevision,
    manifest,
    packageDir: `${packageId}/return`,
    importer: createDccReturnImporter({ workspaceRoot, dataDirectory, provider: "unreal" }),
  };
}

describe("engine return import (canonical wire space)", () => {
  it("builds a plan that inverts the Director scene transform from canonical wire transforms", async () => {
    const setup = await engineFixture();
    const plan = await setup.importer.buildImportPlan(setup.packageDir, setup.project);
    expect(plan.ready).toBe(true);
    const update = plan.operations.find((operation) => operation.op === "update_transform");
    expect(update).toMatchObject({ entityType: "object", objectId: "table" });
    const transform = (update as { transform: DirectorTransform }).transform;
    expect(transform.position[0]).toBeCloseTo(4, 6);
    expect(transform.position[1]).toBeCloseTo(1, 6);
    expect(transform.position[2]).toBeCloseTo(-1, 6);
    expect(transform.rotation[1]).toBeCloseTo(0.5, 6);
  });

  it("rejects packages produced by a different connector provider", async () => {
    const setup = await engineFixture();
    const blenderImporter = createDccReturnImporter({
      workspaceRoot: setup.workspaceRoot,
      dataDirectory: setup.dataDirectory,
      provider: "blender",
    });
    // The package lives under the unreal job root, so the blender importer
    // must not even resolve it.
    await expect(blenderImporter.validatePackage(setup.packageDir)).rejects.toMatchObject({
      code: expect.stringMatching(/package_invalid|path_escape/),
    });
  });

  it("blocks stale revisions without an exchange baseline and merges with one", async () => {
    const withoutBaseline = await engineFixture({ stale: true });
    const blockedPlan = await withoutBaseline.importer.buildImportPlan(
      withoutBaseline.packageDir,
      withoutBaseline.project,
    );
    expect(blockedPlan.ready).toBe(false);
    expect(blockedPlan.conflicts[0]).toMatchObject({ directorId: "project", code: "stale_source_revision" });

    const merged = await engineFixture({
      exchangeBaseline: true,
      mutateLive: (project) => {
        project.scene.backgroundColor = "#101820";
      },
    });
    // Unrelated Director edit moved the revision; the exchange manifest is the baseline.
    const liveRevision = getDirectorProjectRevision(merged.project);
    expect(liveRevision).not.toBe(merged.exportRevision);
    const mergedPlan = await merged.importer.buildImportPlan(merged.packageDir, merged.project);
    expect(mergedPlan.ready).toBe(true);
    expect(mergedPlan.warnings.join("\n")).toMatch(/merges per stable director_id/i);
    expect(mergedPlan.operations).toContainEqual(expect.objectContaining({ op: "update_transform", objectId: "table" }));
  });

  it("conflicts only when the same entity changed in Director and in the engine", async () => {
    const setup = await engineFixture({
      exchangeBaseline: true,
      mutateLive: (project) => {
        project.objects.find((object) => object.id === "table")!.transform.position = [9, 0, 9];
      },
    });
    const plan = await setup.importer.buildImportPlan(setup.packageDir, setup.project);
    expect(plan.ready).toBe(false);
    expect(plan.conflicts).toEqual([expect.objectContaining({ directorId: "table", code: "stale_source_revision" })]);

    const skipped = await setup.importer.buildImportPlan(setup.packageDir, setup.project, {
      skipDirectorIds: ["table"],
    });
    expect(skipped.ready).toBe(true);
    expect(skipped.operations).toContainEqual(expect.objectContaining({ op: "skip", directorId: "table" }));
  });

  it("applies a ready engine plan through one revision-guarded author batch", async () => {
    const setup = await engineFixture();
    const plan = await setup.importer.buildImportPlan(setup.packageDir, setup.project);
    const applyAuthoring = vi.fn().mockResolvedValue({ success: true });
    const revision = getDirectorProjectRevision(setup.project);
    const result = await setup.importer.applyImportPlan(plan, setup.project, revision, "engine-apply-1", applyAuthoring);
    expect(result.copiedAssets).toEqual([]);
    expect(applyAuthoring).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "author",
        expected_revision: revision,
        idempotency_key: "engine-apply-1",
        actions: [expect.objectContaining({ action: "update_object", object_id: "table", force: true })],
      }),
    );
  });

  it("camera targets in exchange baselines use canonical world points", () => {
    // Guard the helper the engine baseline path depends on: identity scene
    // transforms keep world points identical on the canonical wire.
    const world: DirectorTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    expect(directorWorldPointToCanonical([1.5, 2, -3], world)).toEqual([1.5, 2, -3]);
  });
});
