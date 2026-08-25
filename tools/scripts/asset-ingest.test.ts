// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assetCatalogLibrarySchema, type AssetCatalogItem } from "../../packages/protocol/src/assetCatalogProtocol";
import {
  IngestError,
  deriveSpatialMetrics,
  extractPositionBounds,
  ingest,
  parseCliArguments,
  readGlbJson,
  slugifyFileStem,
  upsertCatalogItems,
} from "./asset-ingest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/** Build a minimal binary glTF container around the given JSON document. */
function buildGlb(gltfJson: object): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(gltfJson), "utf8");
  const padding = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)]);
  const glb = Buffer.alloc(12 + 8 + jsonChunk.length);
  glb.writeUInt32LE(0x46546c67, 0); // magic "glTF"
  glb.writeUInt32LE(2, 4); // container version
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonChunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16); // chunk type "JSON"
  jsonChunk.copy(glb, 20);
  return glb;
}

const twoPrimitiveGltf = {
  asset: { version: "2.0" },
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 1 } }] }],
  accessors: [
    { type: "VEC3", componentType: 5126, count: 3, min: [-0.5, 0, -0.25], max: [0.5, 1, 0.25] },
    { type: "VEC3", componentType: 5126, count: 3, min: [-1, 0.5, -0.5], max: [0.25, 2, 0.75] },
  ],
};

function makeTempLibrary(library: string): { rootDir: string; libraryDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "asset-ingest-"));
  temporaryRoots.push(rootDir);
  const libraryDir = join(rootDir, "assets", "library", library);
  mkdirSync(libraryDir, { recursive: true });
  return { rootDir, libraryDir };
}

describe("GLB bounds extraction", () => {
  it("combines the min/max of every mesh primitive POSITION accessor into one AABB", () => {
    const bounds = extractPositionBounds(readGlbJson(buildGlb(twoPrimitiveGltf), "fixture.glb"));
    expect(bounds).toEqual({ status: "ok", min: [-1, 0, -0.5], max: [0.5, 2, 0.75] });
    if (bounds.status !== "ok") throw new Error("unreachable");
    expect(deriveSpatialMetrics(bounds.min, bounds.max)).toEqual({
      bounds_m: [1.5, 2, 1.25],
      footprint_m: [1.5, 1.25],
      height_m: 2,
      ground_offset_y: 0,
    });
  });

  it("derives a positive ground offset for models authored below the origin", () => {
    expect(deriveSpatialMetrics([-1, -0.25, -1], [1, 1.75, 1])).toEqual({
      bounds_m: [2, 2, 2],
      footprint_m: [2, 2],
      height_m: 2,
      ground_offset_y: 0.25,
    });
  });

  it("reports missing min/max instead of guessing partial bounds", () => {
    const glb = buildGlb({
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ type: "VEC3", componentType: 5126, count: 3 }],
    });
    expect(extractPositionBounds(readGlbJson(glb, "fixture.glb"))).toEqual({ status: "missing-min-max" });
  });

  it("rejects buffers that are not GLB containers", () => {
    expect(() => readGlbJson(Buffer.from("not a glb at all"), "junk.glb")).toThrow(IngestError);
  });
});

describe("id slugging", () => {
  it("slugs file stems into ascii catalog ids", () => {
    expect(slugifyFileStem("ATM_low")).toBe("atm-low");
    expect(slugifyFileStem("Standing Idle")).toBe("standing-idle");
    expect(slugifyFileStem("Café--Table ")).toBe("cafe-table");
  });

  it("returns an empty slug for non-ascii stems so ingest demands an explicit --id", () => {
    expect(slugifyFileStem("保温瓶")).toBe("");
  });
});

describe("upsert merge", () => {
  it("replaces items by id and keeps category/name/id ordering", () => {
    const base = (id: string, name: string, category: string): AssetCatalogItem => ({
      id,
      name,
      name_zh: null,
      aliases: [],
      category,
      tags: [],
      kind: "prop",
      files: [{ format: "glb", url: `/lib/${id}.glb`, bytes: 1, sha256: "0".repeat(64) }],
      primary_format: "glb",
      preview: { kind: "image", thumbnail_url: null },
      spatial: null,
      rig: null,
      motion: null,
      source: { provider: "director", provenance: "bundled", source_url: null, license: null, license_url: null },
      usage_hint: null,
    });
    const existing = [base("lib:a", "Alpha", "structure"), base("lib:b", "Beta", "basic")];
    const { items, addedIds, updatedIds } = upsertCatalogItems(existing, [
      base("lib:a", "Alpha v2", "basic"),
      base("lib:c", "Gamma", "nature"),
    ]);
    expect(addedIds).toEqual(["lib:c"]);
    expect(updatedIds).toEqual(["lib:a"]);
    expect(items.map((item) => item.id)).toEqual(["lib:a", "lib:b", "lib:c"]);
    expect(items[0].name).toBe("Alpha v2");
  });

  it("ingests, then upserts by id on a second run, writing stable diffable JSON", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "Box Prop.glb"), buildGlb(twoPrimitiveGltf));
    writeFileSync(join(libraryDir, "chair.glb"), buildGlb(twoPrimitiveGltf));

    const first = ingest({
      rootDir,
      inputs: [join(libraryDir, "Box Prop.glb")],
      library: "test-lib",
      category: "structure",
      name: "Box",
    });
    expect(first.addedIds).toEqual(["test-lib:box-prop"]);
    expect(first.document.items[0].files[0].url).toBe("/test-lib/Box Prop.glb");
    expect(first.document.items[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.document.items[0].files[0].bytes).toBe(buildGlb(twoPrimitiveGltf).length);
    expect(first.document.items[0].spatial).toEqual({
      bounds_m: [1.5, 2, 1.25],
      footprint_m: [1.5, 1.25],
      height_m: 2,
      ground_offset_y: 0,
      front_axis: null,
    });

    const second = ingest({ rootDir, inputs: [join(libraryDir, "chair.glb")], library: "test-lib", category: "furniture" });
    expect(second.addedIds).toEqual(["test-lib:chair"]);
    expect(second.document.items.map((item) => item.id)).toEqual(["test-lib:chair", "test-lib:box-prop"]);

    const third = ingest({
      rootDir,
      inputs: [join(libraryDir, "Box Prop.glb")],
      library: "test-lib",
      category: "basic",
      name: "Box v2",
    });
    expect(third.addedIds).toEqual([]);
    expect(third.updatedIds).toEqual(["test-lib:box-prop"]);
    expect(third.document.items).toHaveLength(2);
    expect(third.document.items[0]).toMatchObject({ id: "test-lib:box-prop", name: "Box v2", category: "basic" });

    const onDisk = readFileSync(join(libraryDir, "catalog.v2.json"), "utf8");
    expect(onDisk.startsWith('{\n  "schema_version": 2,')).toBe(true);
    expect(onDisk.endsWith("}\n")).toBe(true);
    expect(assetCatalogLibrarySchema.parse(JSON.parse(onDisk)).items).toHaveLength(2);
  });
});

describe("schema validation failure", () => {
  it("throws before writing when the merged catalog violates the v2 schema", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "wave.glb"), buildGlb(twoPrimitiveGltf));
    // kind=motion without motion metadata trips the schema superRefine.
    expect(() => ingest({ rootDir, inputs: [join(libraryDir, "wave.glb")], library: "test-lib", kind: "motion" })).toThrow(
      IngestError,
    );
    expect(() => ingest({ rootDir, inputs: [join(libraryDir, "wave.glb")], library: "test-lib", kind: "motion" })).toThrow(
      /motion items must describe motion metadata/,
    );
    expect(existsSync(join(libraryDir, "catalog.v2.json"))).toBe(false);
  });
});

describe("quality gates integration", () => {
  /** Indexed mesh whose accessor counts fake an arbitrary triangle count. */
  const budgetGltf = (triangles: number): object => ({
    asset: { version: "2.0" },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { type: "VEC3", componentType: 5126, count: 4, min: [0, 0, 0], max: [1, 1, 1] },
      { type: "SCALAR", componentType: 5125, count: triangles * 3 },
    ],
  });

  it("keeps gate-failing files out of the catalog but still registers the rest", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "heavy.glb"), buildGlb(budgetGltf(600_000)));
    writeFileSync(join(libraryDir, "ok.glb"), buildGlb(twoPrimitiveGltf));

    const report = ingest({ rootDir, inputs: [libraryDir], library: "test-lib" });
    expect(report.blockedFiles).toEqual([join(libraryDir, "heavy.glb")]);
    expect(report.addedIds).toEqual(["test-lib:ok"]);
    expect(report.written).toBe(true);
    expect(report.gateResults).toHaveLength(2);
    expect(
      report.gateResults[0].findings.some((finding) => finding.gate === "triangle-budget" && finding.severity === "error"),
    ).toBe(true);
    const onDisk = assetCatalogLibrarySchema.parse(JSON.parse(readFileSync(join(libraryDir, "catalog.v2.json"), "utf8")));
    expect(onDisk.items.map((item) => item.id)).toEqual(["test-lib:ok"]);
  });

  it("never creates the catalog when every input is blocked", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "heavy.glb"), buildGlb(budgetGltf(600_000)));
    const report = ingest({ rootDir, inputs: [join(libraryDir, "heavy.glb")], library: "test-lib" });
    expect(report.written).toBe(false);
    expect(report.addedIds).toEqual([]);
    expect(report.blockedFiles).toHaveLength(1);
    expect(existsSync(join(libraryDir, "catalog.v2.json"))).toBe(false);
  });

  it("blocks warning-level files only under strictGates", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "warm.glb"), buildGlb(budgetGltf(200_000)));
    const lax = ingest({ rootDir, inputs: [join(libraryDir, "warm.glb")], library: "test-lib" });
    expect(lax.blockedFiles).toEqual([]);
    expect(lax.addedIds).toEqual(["test-lib:warm"]);

    const strictLib = makeTempLibrary("strict-lib");
    writeFileSync(join(strictLib.libraryDir, "warm.glb"), buildGlb(budgetGltf(200_000)));
    const strict = ingest({
      rootDir: strictLib.rootDir,
      inputs: [join(strictLib.libraryDir, "warm.glb")],
      library: "strict-lib",
      strictGates: true,
    });
    expect(strict.blockedFiles).toEqual([join(strictLib.libraryDir, "warm.glb")]);
    expect(existsSync(join(strictLib.libraryDir, "catalog.v2.json"))).toBe(false);
  });

  it("honours per-request gate threshold overrides", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "box.glb"), buildGlb(twoPrimitiveGltf));
    const report = ingest({
      rootDir,
      inputs: [join(libraryDir, "box.glb")],
      library: "test-lib",
      gateThresholds: { maxTrianglesError: 1 },
    });
    expect(report.blockedFiles).toHaveLength(1);
    expect(report.gateResults[0].findings[0]).toMatchObject({
      gate: "triangle-budget",
      severity: "error",
      value: 2,
      limit: 1,
    });
  });

  it("writes a valid JSON gate report with summary counts and a timestamp", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "heavy.glb"), buildGlb(budgetGltf(600_000)));
    writeFileSync(join(libraryDir, "ok.glb"), buildGlb(twoPrimitiveGltf));
    const reportPath = join(rootDir, "reports", "gate-report.json");

    const report = ingest({ rootDir, inputs: [libraryDir], library: "test-lib", gateReportPath: reportPath });
    expect(report.gateReportPath).toBe(reportPath);
    const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as {
      generatedAt: string;
      summary: Record<string, number>;
      files: Array<{ filePath: string; blocked: boolean; findings: unknown[] }>;
    };
    expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.summary).toMatchObject({ totalFiles: 2, blockedFiles: 1, passedFiles: 1 });
    expect(parsed.files.map((file) => file.blocked)).toEqual([true, false]);
  });

  it("skips the gates entirely with skipGates and registers anyway", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "heavy.glb"), buildGlb(budgetGltf(600_000)));
    const report = ingest({ rootDir, inputs: [join(libraryDir, "heavy.glb")], library: "test-lib", skipGates: true });
    expect(report.gateResults).toEqual([]);
    expect(report.blockedFiles).toEqual([]);
    expect(report.addedIds).toEqual(["test-lib:heavy"]);
    expect(existsSync(join(libraryDir, "catalog.v2.json"))).toBe(true);
  });

  it("rejects --report combined with --skip-gates", () => {
    const { rootDir, libraryDir } = makeTempLibrary("test-lib");
    writeFileSync(join(libraryDir, "box.glb"), buildGlb(twoPrimitiveGltf));
    expect(() =>
      ingest({
        rootDir,
        inputs: [join(libraryDir, "box.glb")],
        library: "test-lib",
        skipGates: true,
        gateReportPath: join(rootDir, "gate-report.json"),
      }),
    ).toThrow(/--skip-gates/);
  });
});

describe("gate CLI flags", () => {
  it("parses the gate flags into request fields", () => {
    const options = parseCliArguments([
      "model.glb",
      "--library",
      "lib",
      "--strict",
      "--report",
      "out/report.json",
      "--max-triangles",
      "100000",
      "--max-vertices",
      "200000",
      "--max-texture-size",
      "1024",
      "--max-texture-count",
      "8",
      "--max-file-mb",
      "10",
    ]);
    expect(options.strictGates).toBe(true);
    expect(options.gateReportPath).toBe("out/report.json");
    expect(options.gateThresholds).toEqual({
      maxTrianglesError: 100000,
      maxVerticesError: 200000,
      maxTextureSizeError: 1024,
      maxTextureCount: 8,
      maxFileBytesError: 10 * 1024 * 1024,
    });
    expect(parseCliArguments(["--skip-gates"]).skipGates).toBe(true);
  });

  it("rejects non-positive or fractional threshold overrides", () => {
    expect(() => parseCliArguments(["--max-triangles", "0"])).toThrow(IngestError);
    expect(() => parseCliArguments(["--max-triangles", "1.5"])).toThrow(IngestError);
    expect(() => parseCliArguments(["--max-file-mb", "-3"])).toThrow(IngestError);
  });
});

describe("generated catalogs on disk", () => {
  it("model-library catalog.v2.json parses with the v2 schema and matches SHA256SUMS", () => {
    const catalogPath = join(repoRoot, "assets", "library", "model-library", "catalog.v2.json");
    const catalog = assetCatalogLibrarySchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")));
    expect(catalog.library).toBe("model-library");
    expect(catalog.items).toHaveLength(6);
    const checksums = new Map(
      readFileSync(join(repoRoot, "assets", "library", "model-library", "SHA256SUMS"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => [line.slice(66), line.slice(0, 64)] as const),
    );
    for (const item of catalog.items) {
      for (const file of item.files) {
        const relativePath = file.url.replace("/model-library/", "");
        expect(file.sha256, `sha256 of ${relativePath}`).toBe(checksums.get(relativePath));
      }
    }
  });

  it("director-characters catalog.v2.json parses with the v2 schema and carries the rig", () => {
    const catalogPath = join(repoRoot, "assets", "library", "director-characters", "catalog.v2.json");
    const catalog = assetCatalogLibrarySchema.parse(JSON.parse(readFileSync(catalogPath, "utf8")));
    expect(catalog.library).toBe("director-characters");
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]).toMatchObject({
      id: "director:hero",
      kind: "character",
      rig: { type: "mixamo", bone_prefix: "mixamorig", bone_count: 65 },
      spatial: { height_m: 1.78, ground_offset_y: 0 },
    });
    expect(catalog.items[0].files[0].url).toBe("/director-characters/models/Standing Idle.fbx");
  });
});
