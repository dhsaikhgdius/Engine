// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_THRESHOLDS,
  buildGateReport,
  isGateBlocked,
  isPowerOfTwo,
  parseJpegDimensions,
  parseKtx2Dimensions,
  parsePngDimensions,
  readGlbChunks,
  renderGateResultLines,
  resolveGateThresholds,
  runAssetGates,
  summarizeFindings,
  type AssetGateResult,
  type GateFinding,
} from "./assetIngestGates";

/** Build a minimal binary glTF container around the JSON (and optional BIN) chunk. */
function buildGlb(gltfJson: object, bin?: Buffer): Buffer {
  const chunk = (type: number, payload: Buffer, pad: number): Buffer => {
    const padding = (4 - (payload.length % 4)) % 4;
    const body = Buffer.concat([payload, Buffer.alloc(padding, pad)]);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(body.length, 0);
    header.writeUInt32LE(type, 4);
    return Buffer.concat([header, body]);
  };
  const chunks = [chunk(0x4e4f534a, Buffer.from(JSON.stringify(gltfJson), "utf8"), 0x20)];
  if (bin) chunks.push(chunk(0x004e4942, bin, 0x00));
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic "glTF"
  header.writeUInt32LE(2, 4); // container version
  header.writeUInt32LE(12 + chunks.reduce((sum, part) => sum + part.length, 0), 8);
  return Buffer.concat([header, ...chunks]);
}

/** PNG signature + IHDR; the parser only reads the fixed width/height offsets. */
function buildPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** SOI + dummy APP0 + SOF0 (carrying height/width) + EOI. */
function buildJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
  const sof0 = Buffer.alloc(10);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(8, 2);
  sof0[4] = 8; // sample precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, eoi]);
}

/** KTX2 identifier + header up to pixelWidth/pixelHeight. */
function buildKtx2(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(48);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32LE(width, 20);
  bytes.writeUInt32LE(height, 24);
  return bytes;
}

function pngDataUri(width: number, height: number): string {
  return `data:image/png;base64,${buildPng(width, height).toString("base64")}`;
}

/** One triangle mesh with sane 1m bounds, extendable per test. */
function simpleMeshGltf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: { version: "2.0" },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: "VEC3", componentType: 5126, count: 3, min: [0, 0, 0], max: [1, 1, 1] }],
    ...extra,
  };
}

/** Indexed mesh whose accessor counts fake an arbitrary triangle count. */
function triangleBudgetGltf(triangles: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: { version: "2.0" },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { type: "VEC3", componentType: 5126, count: 4, min: [0, 0, 0], max: [1, 1, 1] },
      { type: "SCALAR", componentType: 5125, count: triangles * 3 },
    ],
    ...extra,
  };
}

function gatesFor(gltfJson: object, options: { thresholds?: Parameters<typeof runAssetGates>[0]["thresholds"] } = {}) {
  return runAssetGates({ filePath: "/tmp/fixture.glb", buffer: buildGlb(gltfJson), format: "glb", ...options });
}

function findingsByGate(result: AssetGateResult, gate: string): GateFinding[] {
  return result.findings.filter((finding) => finding.gate === gate);
}

describe("GLB stats extraction", () => {
  it("counts triangles per primitive (indices, positions, strip/fan modes) and dedupes shared vertex accessors", () => {
    const result = gatesFor({
      asset: { version: "2.0" },
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, indices: 1 }, // 36 indices -> 12 triangles
            { attributes: { POSITION: 2 } }, // mode defaults to TRIANGLES: 6 positions -> 2
            { attributes: { POSITION: 2 }, mode: 5 }, // strip on the shared accessor: 6 - 2 -> 4
            { attributes: { POSITION: 3 }, mode: 1 }, // lines contribute no triangles
          ],
        },
      ],
      accessors: [
        { type: "VEC3", componentType: 5126, count: 8, min: [0, 0, 0], max: [1, 1, 1] },
        { type: "SCALAR", componentType: 5123, count: 36 },
        { type: "VEC3", componentType: 5126, count: 6, min: [0, 0, 0], max: [2, 1, 1] },
        { type: "VEC3", componentType: 5126, count: 4, min: [0, 0, 0], max: [1, 1, 2] },
      ],
      materials: [{ name: "a" }, { name: "b" }],
    });
    expect(result.stats.triangleCount).toBe(18);
    expect(result.stats.vertexCount).toBe(18); // 8 + 6 + 4, shared accessor counted once
    expect(result.stats.meshCount).toBe(1);
    expect(result.stats.primitiveCount).toBe(4);
    expect(result.stats.materialCount).toBe(2);
    expect(result.stats.boundsM).toEqual([2, 1, 2]);
    expect(result.stats.boundsStatus).toBe("ok");
    expect(result.findings).toEqual([]);
  });

  it("flags invalid primitive modes and keeps them out of the triangle count", () => {
    const result = gatesFor({
      asset: { version: "2.0" },
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }, { attributes: { POSITION: 0 }, mode: 7 }] }],
      accessors: [{ type: "VEC3", componentType: 5126, count: 6, min: [0, 0, 0], max: [1, 1, 1] }],
    });
    expect(result.stats.triangleCount).toBe(2);
    const modeFindings = findingsByGate(result, "primitive-mode");
    expect(modeFindings).toHaveLength(1);
    expect(modeFindings[0].severity).toBe("warning");
    expect(modeFindings[0].value).toBe("7");
  });

  it("collects extensionsUsed and extensionsRequired without duplicates", () => {
    const result = gatesFor(
      simpleMeshGltf({
        extensionsUsed: ["KHR_draco_mesh_compression", "KHR_texture_basisu"],
        extensionsRequired: ["KHR_draco_mesh_compression"],
      }),
    );
    expect(result.stats.extensions).toEqual(["KHR_draco_mesh_compression", "KHR_texture_basisu"]);
  });

  it("turns container damage into a model-parse error finding instead of throwing", () => {
    const result = runAssetGates({ filePath: "/tmp/junk.glb", buffer: Buffer.from("not a glb"), format: "glb" });
    expect(findingsByGate(result, "model-parse")[0]?.severity).toBe("error");
    expect(result.stats.triangleCount).toBeNull();
    expect(result.stats.boundsStatus).toBe("not-parsed");
    expect(isGateBlocked(result, false)).toBe(true);
  });

  it("parses plain glTF JSON buffers too", () => {
    const buffer = Buffer.from(JSON.stringify(simpleMeshGltf()), "utf8");
    const result = runAssetGates({ filePath: "/tmp/fixture.gltf", buffer, format: "gltf" });
    expect(result.stats.triangleCount).toBe(1);
    expect(result.stats.vertexCount).toBe(3);
  });

  it("reads the BIN chunk alongside the JSON chunk", () => {
    const bin = Buffer.from([1, 2, 3, 4, 5]);
    const chunks = readGlbChunks(buildGlb(simpleMeshGltf(), bin));
    expect(chunks.ok).toBe(true);
    if (!chunks.ok) throw new Error("unreachable");
    expect(chunks.bin?.subarray(0, 5)).toEqual(bin);
  });
});

describe("image dimension parsers", () => {
  it("reads PNG width/height from the fixed IHDR offsets", () => {
    expect(parsePngDimensions(buildPng(300, 200))).toEqual({ width: 300, height: 200, format: "png" });
    expect(parsePngDimensions(Buffer.from("nope"))).toBeNull();
  });

  it("scans JPEG markers until the SOF frame header", () => {
    expect(parseJpegDimensions(buildJpeg(511, 257))).toEqual({ width: 511, height: 257, format: "jpeg" });
    expect(parseJpegDimensions(buildPng(4, 4))).toBeNull();
  });

  it("reads KTX2 pixel dimensions from the fixed header", () => {
    expect(parseKtx2Dimensions(buildKtx2(1024, 512))).toEqual({ width: 1024, height: 512, format: "ktx2" });
    expect(parseKtx2Dimensions(buildJpeg(4, 4))).toBeNull();
  });

  it("classifies powers of two", () => {
    expect([1, 2, 1024, 4096].every(isPowerOfTwo)).toBe(true);
    expect([0, -2, 3, 300, 1.5].some(isPowerOfTwo)).toBe(false);
  });
});

describe("gate rules", () => {
  it("errors above the triangle budget and warns between warning and error thresholds", () => {
    const heavy = gatesFor(triangleBudgetGltf(500_001));
    expect(findingsByGate(heavy, "triangle-budget")[0]).toMatchObject({
      severity: "error",
      value: 500_001,
      limit: DEFAULT_GATE_THRESHOLDS.maxTrianglesError,
    });

    const warm = gatesFor(triangleBudgetGltf(150_003, { extensionsUsed: ["KHR_draco_mesh_compression"] }));
    expect(findingsByGate(warm, "triangle-budget")[0]).toMatchObject({ severity: "warning", value: 150_003 });
    expect(findingsByGate(warm, "uncompressed-geometry")).toEqual([]); // draco suppresses the hint
  });

  it("applies vertex budget overrides", () => {
    const result = gatesFor(simpleMeshGltf(), { thresholds: { maxVerticesError: 2 } });
    expect(findingsByGate(result, "vertex-budget")[0]).toMatchObject({ severity: "error", value: 3, limit: 2 });
  });

  it("warns on non-power-of-two textures embedded in the BIN chunk", () => {
    const png = buildPng(300, 300);
    const result = runAssetGates({
      filePath: "/tmp/npot.glb",
      buffer: buildGlb(
        simpleMeshGltf({
          buffers: [{ byteLength: png.length }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
          images: [{ name: "diffuse", mimeType: "image/png", bufferView: 0 }],
        }),
        png,
      ),
      format: "glb",
    });
    expect(result.stats.textures).toEqual([{ name: "diffuse", mimeType: "image/png", width: 300, height: 300 }]);
    expect(findingsByGate(result, "texture-npot")[0]).toMatchObject({ severity: "warning", value: "300x300" });
    expect(findingsByGate(result, "texture-size")).toEqual([]);
  });

  it("errors above 4096px, warns above 2048px, and reads data-URI images", () => {
    const oversized = gatesFor(simpleMeshGltf({ images: [{ uri: pngDataUri(8192, 8192) }] }));
    expect(findingsByGate(oversized, "texture-size")[0]).toMatchObject({ severity: "error", value: "8192x8192", limit: 4096 });
    expect(findingsByGate(oversized, "texture-npot")).toEqual([]);

    const large = gatesFor(simpleMeshGltf({ images: [{ uri: pngDataUri(3000, 3000) }] }));
    expect(findingsByGate(large, "texture-size")[0]).toMatchObject({ severity: "warning", limit: 2048 });
    expect(findingsByGate(large, "texture-npot")).toHaveLength(1);
  });

  it("parses JPEG data URIs for the texture gates", () => {
    const uri = `data:image/jpeg;base64,${buildJpeg(640, 480).toString("base64")}`;
    const result = gatesFor(simpleMeshGltf({ images: [{ uri }] }));
    expect(result.stats.textures[0]).toMatchObject({ width: 640, height: 480 });
    expect(findingsByGate(result, "texture-npot")).toHaveLength(1);
  });

  it("warns when the texture count exceeds the limit and skips unparsable external files", () => {
    const images = Array.from({ length: 17 }, (_, index) => ({ uri: `textures/map-${index}.png` }));
    const result = gatesFor(simpleMeshGltf({ images }));
    expect(result.stats.textures.every((texture) => texture.width === null)).toBe(true);
    expect(findingsByGate(result, "texture-count")[0]).toMatchObject({ severity: "warning", value: 17, limit: 16 });
    expect(findingsByGate(result, "texture-npot")).toEqual([]);
  });

  it("gates the file size with configurable error and warning thresholds", () => {
    expect(findingsByGate(gatesFor(simpleMeshGltf(), { thresholds: { maxFileBytesError: 16 } }), "file-size")[0]).toMatchObject(
      { severity: "error", limit: 16 },
    );
    expect(
      findingsByGate(gatesFor(simpleMeshGltf(), { thresholds: { maxFileBytesWarning: 16 } }), "file-size")[0],
    ).toMatchObject({ severity: "warning", limit: 16 });
    expect(findingsByGate(gatesFor(simpleMeshGltf()), "file-size")).toEqual([]);
  });

  it("flags suspicious bounds (unit mistakes) and reports missing bounds as info", () => {
    const huge = gatesFor(simpleMeshGltf({ accessors: [{ type: "VEC3", componentType: 5126, count: 3, min: [0, 0, 0], max: [300, 1, 1] }] }));
    expect(findingsByGate(huge, "bounds-suspicious")[0]?.severity).toBe("warning");

    const flat = gatesFor(simpleMeshGltf({ accessors: [{ type: "VEC3", componentType: 5126, count: 3, min: [0, 0, 0], max: [10, 0, 10] }] }));
    expect(findingsByGate(flat, "bounds-suspicious")).toHaveLength(1);

    const noMinMax = gatesFor(simpleMeshGltf({ accessors: [{ type: "VEC3", componentType: 5126, count: 3 }] }));
    expect(noMinMax.stats.boundsStatus).toBe("missing-min-max");
    expect(findingsByGate(noMinMax, "bounds-missing")[0]?.severity).toBe("info");

    const fbx = runAssetGates({ filePath: "/tmp/model.fbx", buffer: Buffer.from("fbx bytes"), format: "fbx" });
    expect(fbx.stats.triangleCount).toBeNull();
    expect(fbx.findings).toEqual([
      { gate: "bounds-missing", severity: "info", message: "FBX 输入未解析几何,无法获取包围盒" },
    ]);
    expect(isGateBlocked(fbx, true)).toBe(false); // info never blocks, even under strict
  });

  it("hints at missing geometry compression above 50k triangles", () => {
    const result = gatesFor(triangleBudgetGltf(60_000));
    expect(findingsByGate(result, "uncompressed-geometry")[0]).toMatchObject({
      severity: "warning",
      value: 60_000,
      limit: DEFAULT_GATE_THRESHOLDS.uncompressedTriangleLimit,
    });
  });

  it("hints at missing texture compression above 16M pixels unless BasisU/KTX2 is used", () => {
    const images = [{ uri: pngDataUri(4096, 4096) }, { uri: pngDataUri(2, 2) }];
    const plain = gatesFor(simpleMeshGltf({ images }));
    expect(findingsByGate(plain, "uncompressed-texture")[0]).toMatchObject({ severity: "warning", value: 16_777_220 });

    const basis = gatesFor(simpleMeshGltf({ images, extensionsUsed: ["KHR_texture_basisu"] }));
    expect(findingsByGate(basis, "uncompressed-texture")).toEqual([]);

    const ktx = buildKtx2(8192, 8192);
    const viaMime = runAssetGates({
      filePath: "/tmp/ktx.glb",
      buffer: buildGlb(
        simpleMeshGltf({
          buffers: [{ byteLength: ktx.length }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: ktx.length }],
          images: [{ mimeType: "image/ktx2", bufferView: 0 }],
        }),
        ktx,
      ),
      format: "glb",
    });
    expect(findingsByGate(viaMime, "uncompressed-texture")).toEqual([]);
    expect(findingsByGate(viaMime, "texture-size")[0]?.severity).toBe("error"); // size gate still applies
  });

  it("resolves partial threshold overrides against the defaults", () => {
    const thresholds = resolveGateThresholds({ maxTrianglesError: 10 });
    expect(thresholds.maxTrianglesError).toBe(10);
    expect(thresholds.maxVerticesError).toBe(DEFAULT_GATE_THRESHOLDS.maxVerticesError);
  });
});

describe("blocking, report, and console rendering", () => {
  it("blocks on errors always and on warnings only under strict", () => {
    const warned = gatesFor(triangleBudgetGltf(60_000));
    expect(summarizeFindings(warned.findings)).toEqual({ errors: 0, warnings: 1, infos: 0 });
    expect(isGateBlocked(warned, false)).toBe(false);
    expect(isGateBlocked(warned, true)).toBe(true);

    const failed = gatesFor(triangleBudgetGltf(600_000));
    expect(isGateBlocked(failed, false)).toBe(true);
  });

  it("builds a JSON report with summary counts, thresholds, and a timestamp", () => {
    const results = [gatesFor(triangleBudgetGltf(600_000)), gatesFor(simpleMeshGltf())];
    const report = buildGateReport(results, {
      strict: false,
      thresholds: DEFAULT_GATE_THRESHOLDS,
      generator: "test-generator",
      generatedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(report.generatedAt).toBe("2026-08-13T00:00:00.000Z");
    expect(report.generator).toBe("test-generator");
    expect(report.thresholds.maxTrianglesError).toBe(500_000);
    expect(report.summary).toEqual({
      totalFiles: 2,
      passedFiles: 1,
      blockedFiles: 1,
      errorCount: 1,
      warningCount: 1,
      infoCount: 0,
    });
    expect(report.files.map((file) => file.blocked)).toEqual([true, false]);
    expect(report.files[0].findings[0].gate).toBe("triangle-budget");

    const defaultStamp = buildGateReport([], { strict: true, thresholds: DEFAULT_GATE_THRESHOLDS, generator: "x" });
    expect(defaultStamp.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("renders aligned Chinese console lines with severity prefixes and a verdict", () => {
    const failed = gatesFor(triangleBudgetGltf(600_000));
    const lines = renderGateResultLines(failed);
    expect(lines[0]).toBe("资产体检:fixture.glb");
    expect(lines[1]).toContain("三角形 600,000");
    expect(lines.some((line) => line.trimStart().startsWith("[ERROR]"))).toBe(true);
    expect(lines.some((line) => line.trimStart().startsWith("[WARN]"))).toBe(true);
    expect(lines[lines.length - 1]).toContain("未通过");

    const clean = renderGateResultLines(gatesFor(simpleMeshGltf()));
    expect(clean[clean.length - 1]).toContain("通过");

    const strictLines = renderGateResultLines(gatesFor(triangleBudgetGltf(60_000)), { strict: true });
    expect(strictLines[strictLines.length - 1]).toContain("未通过");
  });
});
