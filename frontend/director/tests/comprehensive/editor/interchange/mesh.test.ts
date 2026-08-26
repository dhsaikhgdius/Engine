import { createHash } from "node:crypto";
import JSZip from "jszip";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import { applyDirectorAuthoringActions } from "@director/agent-engine";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  exportDirectorProjectToObj,
  exportDirectorProjectToObjArchive,
  exportDirectorProjectToStl,
} from "../../../../src/comprehensive/editor/interchange/mesh";

function projectWithPrimitives() {
  return applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    {
      action: "add_object",
      id: "export-box",
      name: "Export Box",
      kind: "prop",
      geometry_type: "box",
      color: "#336699",
      material: { baseColor: "#336699", roughness: 0.4, metalness: 0.2, opacity: 0.9 },
      transform: { position: [1, 0, 2], rotation: [0, Math.PI / 2, 0], scale: [2, 3, 4] },
    },
    {
      action: "add_object",
      id: "export-mirror",
      name: "Export Mirror",
      kind: "prop",
      geometry_type: "pyramid",
      transform: { position: [-2, 0, 1], rotation: [0.1, 0.2, 0.3], scale: [-1, 2, 1] },
    },
  ]).project;
}

describe("Director OBJ/STL mesh export", () => {
  it("exports selected primitive geometry with stable IDs, metres/Y-up metadata, and baked negative scale", () => {
    const result = exportDirectorProjectToObj(projectWithPrimitives(), {
      objectIds: ["export-box", "export-mirror"],
      exportedAt: "2026-08-07T02:00:00.000Z",
    });

    expect(result.obj).toContain("# units meter");
    expect(result.obj).toContain("# upAxis Y");
    expect(result.obj).toContain("# directorStableId export-box");
    expect(result.obj).toContain("# directorStableId export-mirror");
    expect(result.obj.match(/^f /gm)).toHaveLength(result.reportBase.triangleCount);
    expect(result.mtl).toContain("newmtl mat_export-box");
    expect(result.reportBase).toMatchObject({
      format: "obj",
      scope: { mode: "selection", includedObjectIds: ["export-box", "export-mirror"] },
      coordinateSystem: { metersPerUnit: 1, upAxis: "Y", handedness: "right" },
    });
    expect(result.reportBase.objects.find((object) => object.stableId === "export-mirror")?.negativeScaleBaked).toBe(
      true,
    );
    expect(result.reportBase.warnings.join(" ")).toContain("Negative-scale");
  });

  it("packages OBJ, MTL, hashes, and a machine-readable loss report together", async () => {
    const archive = await exportDirectorProjectToObjArchive(projectWithPrimitives(), {
      objectIds: ["export-box"],
      exportedAt: "2026-08-07T02:00:00.000Z",
    });
    const zip = await JSZip.loadAsync(archive.bytes);
    const obj = await zip.file("director-scene.obj")!.async("uint8array");
    const manifest = JSON.parse(await zip.file("director-export.json")!.async("string"));

    expect(Object.keys(zip.files).sort()).toEqual(["director-export.json", "director-scene.mtl", "director-scene.obj"]);
    expect(manifest.files.find((file: { path: string }) => file.path === "director-scene.obj")).toMatchObject({
      byteLength: obj.byteLength,
      sha256: createHash("sha256").update(obj).digest("hex"),
    });
    expect(archive.report).toEqual(manifest);
  });

  it("materializes a linked imported model with the same normalization and transform used by the viewport", async () => {
    const project = createDefaultDirectorProject();
    project.assets.push({
      id: "asset-imported-chair",
      name: "Imported chair",
      kind: "prop",
      sourceType: "model",
      assetSource: "local",
      fileName: "chair.glb",
      url: "data:model/gltf-binary;base64,fixture",
    });
    project.objects.push({
      id: "imported-chair",
      name: "Imported chair",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "asset-imported-chair",
      transform: { position: [3, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));

    const archive = await exportDirectorProjectToObjArchive(project, {
      objectIds: ["imported-chair"],
      exportedAt: "2026-08-07T02:00:00.000Z",
      modelLoader: async (asset) => {
        expect(asset.id).toBe("asset-imported-chair");
        return root;
      },
    });
    const zip = await JSZip.loadAsync(archive.bytes);
    const obj = await zip.file("director-scene.obj")!.async("string");
    const vertices = obj
      .split("\n")
      .filter((line) => line.startsWith("v "))
      .map((line) => line.slice(2).split(" ").map(Number));

    expect(archive.report.scope.includedObjectIds).toEqual(["imported-chair"]);
    expect(archive.report.objects[0]).toMatchObject({
      stableId: "imported-chair",
      meshSource: "imported-model",
      primitiveType: null,
      assetRefId: "asset-imported-chair",
      sourceFileName: "chair.glb",
      triangleCount: 12,
    });
    expect(Math.min(...vertices.map((vertex) => vertex[0]!))).toBe(2);
    expect(Math.max(...vertices.map((vertex) => vertex[0]!))).toBe(4);
    expect(Math.min(...vertices.map((vertex) => vertex[1]!))).toBe(0);
    expect(Math.max(...vertices.map((vertex) => vertex[1]!))).toBe(2);
    expect(archive.report.warnings.join(" ")).toContain("imported model object");
  });

  it("omits gaussian splat captures from mesh export with an explicit no-triangle reason", async () => {
    const project = projectWithPrimitives();
    project.assets.push({
      id: "asset-garden-splat",
      name: "花园扫描",
      kind: "prop",
      sourceType: "model",
      assetSource: "local",
      fileName: "garden.spz",
      url: "/native-models/asset-garden/garden.spz",
    });
    project.objects.push({
      id: "garden-splat",
      name: "花园扫描",
      kind: "prop",
      visible: true,
      locked: false,
      assetRefId: "asset-garden-splat",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    const archive = await exportDirectorProjectToObjArchive(project, {
      objectIds: ["export-box", "garden-splat"],
      exportedAt: "2026-08-07T02:00:00.000Z",
    });

    expect(archive.report.scope.includedObjectIds).toEqual(["export-box"]);
    expect(archive.report.omitted).toEqual([
      {
        stableId: "garden-splat",
        name: "花园扫描",
        code: "splat_no_triangle_mesh",
        reason: "gaussian splat captures carry no triangle mesh and cannot be materialized for mesh export",
      },
    ]);
  });

  it("stamps a typed omit code on every skipped object in the loss report", async () => {
    const project = projectWithPrimitives();
    project.objects.push(
      {
        id: "hidden-box",
        name: "Hidden Box",
        kind: "prop",
        visible: false,
        locked: false,
        geometryType: "box",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: "bare-character",
        name: "Bare Character",
        kind: "character",
        visible: true,
        locked: false,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: "broken-ref",
        name: "Broken Reference",
        kind: "prop",
        visible: true,
        locked: false,
        assetRefId: "asset-that-does-not-exist",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    );

    const archive = await exportDirectorProjectToObjArchive(project, {
      objectIds: ["export-box", "hidden-box", "bare-character", "broken-ref"],
      exportedAt: "2026-08-07T02:00:00.000Z",
    });

    expect(archive.report.scope.includedObjectIds).toEqual(["export-box"]);
    expect(archive.report.omitted).toEqual([
      { stableId: "hidden-box", name: "Hidden Box", code: "hidden_object", reason: "hidden object excluded" },
      {
        stableId: "bare-character",
        name: "Bare Character",
        code: "unsupported_object_kind",
        reason: "character has no supported primitive mesh",
      },
      {
        stableId: "broken-ref",
        name: "Broken Reference",
        code: "asset_not_model",
        reason: "asset reference asset-that-does-not-exist does not resolve to a model asset",
      },
    ]);
  });

  it("distinguishes rigged characters, loader failures, and the synchronous path with typed codes", async () => {
    const project = projectWithPrimitives();
    project.assets.push(
      {
        id: "asset-rigged-hero",
        name: "Rigged hero",
        kind: "character",
        sourceType: "model",
        assetSource: "local",
        fileName: "hero.glb",
        url: "data:model/gltf-binary;base64,fixture",
      },
      {
        id: "asset-broken-model",
        name: "Broken model",
        kind: "prop",
        sourceType: "model",
        assetSource: "local",
        fileName: "broken.glb",
        url: "data:model/gltf-binary;base64,fixture",
      },
    );
    project.objects.push(
      {
        id: "rigged-hero",
        name: "Rigged hero",
        kind: "prop",
        visible: true,
        locked: false,
        assetRefId: "asset-rigged-hero",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: "broken-model",
        name: "Broken model",
        kind: "prop",
        visible: true,
        locked: false,
        assetRefId: "asset-broken-model",
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    );

    const archive = await exportDirectorProjectToObjArchive(project, {
      objectIds: ["export-box", "rigged-hero", "broken-model"],
      exportedAt: "2026-08-07T02:00:00.000Z",
      modelLoader: async () => {
        throw new Error("fixture loader failure");
      },
    });
    expect(archive.report.omitted).toEqual([
      {
        stableId: "rigged-hero",
        name: "Rigged hero",
        code: "rigged_character_requires_dcc",
        reason: "rigged character assets require pose-aware DCC export",
      },
      {
        stableId: "broken-model",
        name: "Broken model",
        code: "model_materialization_failed",
        reason: "fixture loader failure",
      },
    ]);

    const sync = exportDirectorProjectToObj(project, {
      objectIds: ["export-box", "broken-model"],
      exportedAt: "2026-08-07T02:00:00.000Z",
    });
    expect(sync.reportBase.omitted).toEqual([
      {
        stableId: "broken-model",
        name: "Broken model",
        code: "sync_export_requires_archive",
        reason: "imported model materialization is available only through the asynchronous archive exporter",
      },
    ]);
  });

  it("makes STL material loss explicit and refuses an unsupported-only scope", () => {
    const stl = exportDirectorProjectToStl(projectWithPrimitives(), {
      objectIds: ["export-box"],
      exportedAt: "2026-08-07T02:00:00.000Z",
    });
    expect(stl.stl).toMatch(/^solid director_export-box\n/);
    expect(stl.stl).toContain("endsolid director_export-box");
    expect(stl.stl).not.toContain("//");
    expect(stl.reportBase.coordinateSystem).toEqual({
      linearUnit: "meter",
      metersPerUnit: 1,
      upAxis: "Y",
      handedness: "right",
    });
    expect(stl.reportBase.warnings.join(" ")).toContain("STL omits materials");

    const project = createDefaultDirectorProject();
    expect(() =>
      exportDirectorProjectToObj(project, {
        objectIds: ["char_default_a"],
        exportedAt: "2026-08-07T02:00:00.000Z",
      }),
    ).toThrow(/no supported visible geometry/i);
  });
});
