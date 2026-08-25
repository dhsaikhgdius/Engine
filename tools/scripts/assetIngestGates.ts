import { basename } from "node:path";

/**
 * Game-grade quality gates for the Asset Catalog v2 ingest pipeline.
 *
 * Pure functions only (no filesystem access): callers hand in the file buffer
 * and format, and get back structured stats plus findings. GLB parsing is
 * hand-written (JSON + BIN chunk, mirroring the reader in asset-ingest.ts) so
 * no new dependencies are introduced. Texture dimensions are only decoded when
 * they are cheap to obtain: PNG width/height sit at a fixed IHDR offset, JPEG
 * needs a short SOF marker scan, KTX2 stores them in its fixed header.
 */

export type GateSeverity = "info" | "warning" | "error";
export type GateModelFormat = "glb" | "gltf" | "fbx" | "obj";
export type GateVec3 = [number, number, number];

export interface GateFinding {
  gate: string;
  severity: GateSeverity;
  message: string;
  value?: number | string;
  limit?: number;
}

export interface TextureStat {
  name: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

export type GateBoundsStatus = "ok" | "missing-min-max" | "no-position" | "not-parsed";

export interface AssetGateStats {
  format: GateModelFormat;
  fileBytes: number;
  /** null when the geometry was not parsed (fbx/obj inputs or a broken container). */
  triangleCount: number | null;
  vertexCount: number | null;
  meshCount: number | null;
  primitiveCount: number | null;
  materialCount: number | null;
  textureCount: number | null;
  textures: TextureStat[];
  extensions: string[];
  boundsM: GateVec3 | null;
  boundsStatus: GateBoundsStatus;
}

export interface AssetGateResult {
  filePath: string;
  stats: AssetGateStats;
  findings: GateFinding[];
}

export interface GateThresholds {
  maxTrianglesError: number;
  maxTrianglesWarning: number;
  maxVerticesError: number;
  maxVerticesWarning: number;
  /** Longest texture side in pixels. */
  maxTextureSizeError: number;
  maxTextureSizeWarning: number;
  maxTextureCount: number;
  maxFileBytesError: number;
  maxFileBytesWarning: number;
  /** AABB sides outside [minBoundsSideM, maxBoundsSideM] look like unit mistakes. */
  minBoundsSideM: number;
  maxBoundsSideM: number;
  /** Above this triangle count, missing Draco/meshopt compression is flagged. */
  uncompressedTriangleLimit: number;
  /** Above this total pixel count, missing KTX2/BasisU compression is flagged. */
  uncompressedTexturePixelLimit: number;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  maxTrianglesError: 500_000,
  maxTrianglesWarning: 150_000,
  maxVerticesError: 750_000,
  maxVerticesWarning: 250_000,
  maxTextureSizeError: 4096,
  maxTextureSizeWarning: 2048,
  maxTextureCount: 16,
  maxFileBytesError: 100 * 1024 * 1024,
  maxFileBytesWarning: 25 * 1024 * 1024,
  minBoundsSideM: 0.01,
  maxBoundsSideM: 200,
  uncompressedTriangleLimit: 50_000,
  uncompressedTexturePixelLimit: 16 * 1024 * 1024,
};

export function resolveGateThresholds(overrides?: Partial<GateThresholds>): GateThresholds {
  const thresholds: GateThresholds = { ...DEFAULT_GATE_THRESHOLDS };
  if (overrides) {
    for (const key of Object.keys(thresholds) as Array<keyof GateThresholds>) {
      const value = overrides[key];
      if (typeof value === "number" && Number.isFinite(value)) thresholds[key] = value;
    }
  }
  return thresholds;
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

const TRIANGLES_MODE = 4;
const TRIANGLE_STRIP_MODE = 5;
const TRIANGLE_FAN_MODE = 6;

const GEOMETRY_COMPRESSION_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression"];
const TEXTURE_COMPRESSION_EXTENSION = "KHR_texture_basisu";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asVec3(value: unknown): GateVec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value as unknown[];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

export type GlbChunkResult = { ok: true; json: unknown; bin: Buffer | null } | { ok: false; reason: string };

/**
 * Read the JSON and BIN chunks out of a binary glTF container: 12-byte header
 * (magic "glTF", version, total length) followed by 4-byte-aligned chunks.
 * Returns a reason instead of throwing so gate callers can turn container
 * damage into an error finding.
 */
export function readGlbChunks(buffer: Buffer): GlbChunkResult {
  if (buffer.length < 12) return { ok: false, reason: "缺少 12 字节 GLB 头" };
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) return { ok: false, reason: 'magic 不是 "glTF"' };
  const version = buffer.readUInt32LE(4);
  if (version !== 2) return { ok: false, reason: `不支持的 GLB 版本 ${version}(仅支持 2)` };
  const declaredLength = Math.min(buffer.readUInt32LE(8), buffer.length);
  let json: unknown;
  let jsonFound = false;
  let bin: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkLength > buffer.length) return { ok: false, reason: "GLB chunk 被截断" };
    const chunk = buffer.subarray(chunkStart, chunkStart + chunkLength);
    if (chunkType === GLB_JSON_CHUNK && !jsonFound) {
      try {
        json = JSON.parse(chunk.toString("utf8")) as unknown;
        jsonFound = true;
      } catch (error) {
        return { ok: false, reason: `JSON chunk 不可解析(${error instanceof Error ? error.message : String(error)})` };
      }
    } else if (chunkType === GLB_BIN_CHUNK && bin === null) {
      bin = chunk;
    }
    offset = chunkStart + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (!jsonFound) return { ok: false, reason: "GLB 没有 JSON chunk" };
  return { ok: true, json, bin };
}

export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "ktx2";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIME_BY_IMAGE_FORMAT: Record<ImageDimensions["format"], string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  ktx2: "image/ktx2",
};

/** PNG stores IHDR width/height as big-endian uint32 at fixed offsets 16/20. */
export function parsePngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" };
}

/** JPEG needs a marker scan: skip segments until the first SOF frame header. */
export function parseJpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte before the real marker
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone markers carry no length field
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5), format: "jpeg" };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** KTX2 stores pixelWidth/pixelHeight as little-endian uint32 at offsets 20/24. */
export function parseKtx2Dimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 28 || !bytes.subarray(0, 12).equals(KTX2_IDENTIFIER)) return null;
  return { width: bytes.readUInt32LE(20), height: bytes.readUInt32LE(24), format: "ktx2" };
}

export function parseImageDimensions(bytes: Buffer): ImageDimensions | null {
  return parsePngDimensions(bytes) ?? parseJpegDimensions(bytes) ?? parseKtx2Dimensions(bytes);
}

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function decodeDataUri(uri: string): Buffer | null {
  if (!uri.startsWith("data:")) return null;
  const commaIndex = uri.indexOf(",");
  if (commaIndex < 0) return null;
  const header = uri.slice(5, commaIndex);
  const payload = uri.slice(commaIndex + 1);
  try {
    return header.endsWith(";base64") ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolve embedded image bytes (data URI or bufferView into the GLB BIN
 * chunk / a data-URI buffer). External file URIs return null on purpose:
 * dimensions are only parsed when they are cheap to obtain.
 */
function resolveImageBytes(
  image: Record<string, unknown>,
  document: Record<string, unknown>,
  bin: Buffer | null,
): Buffer | null {
  const uri = image.uri;
  if (typeof uri === "string") return decodeDataUri(uri);
  const bufferViewIndex = asIndex(image.bufferView);
  if (bufferViewIndex === null) return null;
  const bufferView = asRecord(asArray(document.bufferViews)[bufferViewIndex]);
  if (!bufferView) return null;
  const bufferIndex = asIndex(bufferView.buffer);
  const byteLength = asIndex(bufferView.byteLength);
  const byteOffset = asIndex(bufferView.byteOffset) ?? 0;
  if (bufferIndex === null || byteLength === null) return null;
  const bufferDef = asRecord(asArray(document.buffers)[bufferIndex]);
  if (!bufferDef) return null;
  const source = typeof bufferDef.uri === "string" ? decodeDataUri(bufferDef.uri) : bufferIndex === 0 ? bin : null;
  if (!source || byteOffset + byteLength > source.length) return null;
  return source.subarray(byteOffset, byteOffset + byteLength);
}

interface GltfCollectedStats {
  triangleCount: number;
  vertexCount: number;
  meshCount: number;
  primitiveCount: number;
  materialCount: number;
  textures: TextureStat[];
  extensions: string[];
  boundsM: GateVec3 | null;
  boundsStatus: Exclude<GateBoundsStatus, "not-parsed">;
  structuralFindings: GateFinding[];
}

function collectGltfStats(gltf: unknown, bin: Buffer | null): GltfCollectedStats {
  const document = asRecord(gltf) ?? {};
  const accessors = asArray(document.accessors);
  const meshes = asArray(document.meshes);
  const structuralFindings: GateFinding[] = [];

  let triangleCount = 0;
  let vertexCount = 0;
  let primitiveCount = 0;
  const positionAccessorIndexes: number[] = [];
  const countedPositionAccessors = new Set<number>();

  meshes.forEach((meshValue, meshIndex) => {
    asArray(asRecord(meshValue)?.primitives).forEach((primitiveValue, primitiveIndex) => {
      const primitive = asRecord(primitiveValue);
      if (!primitive) return;
      primitiveCount += 1;

      const positionIndex = asIndex(asRecord(primitive.attributes)?.POSITION);
      const positionCount = positionIndex !== null ? asIndex(asRecord(accessors[positionIndex])?.count) : null;
      if (positionIndex !== null && !countedPositionAccessors.has(positionIndex)) {
        countedPositionAccessors.add(positionIndex);
        positionAccessorIndexes.push(positionIndex);
        vertexCount += positionCount ?? 0; // shared accessors are counted once
      }

      const mode = primitive.mode === undefined ? TRIANGLES_MODE : primitive.mode;
      if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 6) {
        structuralFindings.push({
          gate: "primitive-mode",
          severity: "warning",
          message: `网格 ${meshIndex} 图元 ${primitiveIndex} 的 mode ${String(primitive.mode)} 非法(glTF 只允许 0-6),该图元不计入三角形统计`,
          value: String(primitive.mode),
        });
        return;
      }
      const indicesIndex = asIndex(primitive.indices);
      const elementCount =
        indicesIndex !== null ? (asIndex(asRecord(accessors[indicesIndex])?.count) ?? 0) : (positionCount ?? 0);
      if (mode === TRIANGLES_MODE) triangleCount += Math.floor(elementCount / 3);
      else if (mode === TRIANGLE_STRIP_MODE || mode === TRIANGLE_FAN_MODE) triangleCount += Math.max(0, elementCount - 2);
    });
  });

  let boundsM: GateVec3 | null = null;
  let boundsStatus: Exclude<GateBoundsStatus, "not-parsed">;
  if (positionAccessorIndexes.length === 0) {
    boundsStatus = "no-position";
  } else {
    const min: GateVec3 = [Infinity, Infinity, Infinity];
    const max: GateVec3 = [-Infinity, -Infinity, -Infinity];
    let usable = true;
    for (const accessorIndex of positionAccessorIndexes) {
      const accessor = asRecord(accessors[accessorIndex]);
      const accessorMin = asVec3(accessor?.min);
      const accessorMax = asVec3(accessor?.max);
      if (!accessorMin || !accessorMax) {
        usable = false;
        break;
      }
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], accessorMin[axis]);
        max[axis] = Math.max(max[axis], accessorMax[axis]);
      }
    }
    if (usable) {
      boundsStatus = "ok";
      boundsM = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    } else {
      boundsStatus = "missing-min-max";
    }
  }

  const textures: TextureStat[] = asArray(document.images).map((imageValue, imageIndex) => {
    const image = asRecord(imageValue) ?? {};
    const uri = typeof image.uri === "string" ? image.uri : null;
    const name =
      typeof image.name === "string" && image.name.length > 0
        ? image.name
        : uri !== null && !uri.startsWith("data:")
          ? uri
          : `image#${imageIndex}`;
    const bytes = resolveImageBytes(image, document, bin);
    const dimensions = bytes ? parseImageDimensions(bytes) : null;
    const mimeType =
      typeof image.mimeType === "string" ? image.mimeType : dimensions ? MIME_BY_IMAGE_FORMAT[dimensions.format] : null;
    return { name, mimeType, width: dimensions?.width ?? null, height: dimensions?.height ?? null };
  });

  const extensions = [
    ...new Set(
      [...asArray(document.extensionsUsed), ...asArray(document.extensionsRequired)].filter(
        (value): value is string => typeof value === "string",
      ),
    ),
  ];

  return {
    triangleCount,
    vertexCount,
    meshCount: meshes.length,
    primitiveCount,
    materialCount: asArray(document.materials).length,
    textures,
    extensions,
    boundsM,
    boundsStatus,
    structuralFindings,
  };
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function formatMetres(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function boundsMissingMessage(stats: AssetGateStats): string {
  if (stats.boundsStatus === "missing-min-max") return "POSITION accessor 缺少 min/max,无法计算包围盒";
  if (stats.boundsStatus === "no-position") return "模型没有携带 POSITION 属性的图元,无法计算包围盒";
  return `${stats.format.toUpperCase()} 输入未解析几何,无法获取包围盒`;
}

/** Apply every gate rule to the extracted stats. Pure and unit-testable. */
export function evaluateGateFindings(stats: AssetGateStats, thresholds: GateThresholds): GateFinding[] {
  const findings: GateFinding[] = [];

  if (stats.triangleCount !== null) {
    if (stats.triangleCount > thresholds.maxTrianglesError) {
      findings.push({
        gate: "triangle-budget",
        severity: "error",
        message: `三角形总数 ${formatCount(stats.triangleCount)} 超过 error 阈值 ${formatCount(thresholds.maxTrianglesError)}`,
        value: stats.triangleCount,
        limit: thresholds.maxTrianglesError,
      });
    } else if (stats.triangleCount > thresholds.maxTrianglesWarning) {
      findings.push({
        gate: "triangle-budget",
        severity: "warning",
        message: `三角形总数 ${formatCount(stats.triangleCount)} 超过 warning 阈值 ${formatCount(thresholds.maxTrianglesWarning)}`,
        value: stats.triangleCount,
        limit: thresholds.maxTrianglesWarning,
      });
    }
  }

  if (stats.vertexCount !== null) {
    if (stats.vertexCount > thresholds.maxVerticesError) {
      findings.push({
        gate: "vertex-budget",
        severity: "error",
        message: `顶点总数 ${formatCount(stats.vertexCount)} 超过 error 阈值 ${formatCount(thresholds.maxVerticesError)}`,
        value: stats.vertexCount,
        limit: thresholds.maxVerticesError,
      });
    } else if (stats.vertexCount > thresholds.maxVerticesWarning) {
      findings.push({
        gate: "vertex-budget",
        severity: "warning",
        message: `顶点总数 ${formatCount(stats.vertexCount)} 超过 warning 阈值 ${formatCount(thresholds.maxVerticesWarning)}`,
        value: stats.vertexCount,
        limit: thresholds.maxVerticesWarning,
      });
    }
  }

  for (const texture of stats.textures) {
    if (texture.width === null || texture.height === null) continue;
    const sizeLabel = `${texture.width}x${texture.height}`;
    const maxSide = Math.max(texture.width, texture.height);
    if (maxSide > thresholds.maxTextureSizeError) {
      findings.push({
        gate: "texture-size",
        severity: "error",
        message: `贴图 ${texture.name}(${sizeLabel})单边超过 error 阈值 ${thresholds.maxTextureSizeError}px`,
        value: sizeLabel,
        limit: thresholds.maxTextureSizeError,
      });
    } else if (maxSide > thresholds.maxTextureSizeWarning) {
      findings.push({
        gate: "texture-size",
        severity: "warning",
        message: `贴图 ${texture.name}(${sizeLabel})单边超过 warning 阈值 ${thresholds.maxTextureSizeWarning}px`,
        value: sizeLabel,
        limit: thresholds.maxTextureSizeWarning,
      });
    }
    if (!isPowerOfTwo(texture.width) || !isPowerOfTwo(texture.height)) {
      findings.push({
        gate: "texture-npot",
        severity: "warning",
        message: `贴图 ${texture.name}(${sizeLabel})尺寸不是 2 的幂,可能影响 mipmap 与压缩`,
        value: sizeLabel,
      });
    }
  }

  if (stats.textureCount !== null && stats.textureCount > thresholds.maxTextureCount) {
    findings.push({
      gate: "texture-count",
      severity: "warning",
      message: `贴图数量 ${stats.textureCount} 超过建议上限 ${thresholds.maxTextureCount}`,
      value: stats.textureCount,
      limit: thresholds.maxTextureCount,
    });
  }

  if (stats.fileBytes > thresholds.maxFileBytesError) {
    findings.push({
      gate: "file-size",
      severity: "error",
      message: `文件体积 ${formatMegabytes(stats.fileBytes)} MB 超过 error 阈值 ${formatMegabytes(thresholds.maxFileBytesError)} MB`,
      value: stats.fileBytes,
      limit: thresholds.maxFileBytesError,
    });
  } else if (stats.fileBytes > thresholds.maxFileBytesWarning) {
    findings.push({
      gate: "file-size",
      severity: "warning",
      message: `文件体积 ${formatMegabytes(stats.fileBytes)} MB 超过 warning 阈值 ${formatMegabytes(thresholds.maxFileBytesWarning)} MB`,
      value: stats.fileBytes,
      limit: thresholds.maxFileBytesWarning,
    });
  }

  if (stats.boundsStatus === "ok" && stats.boundsM) {
    const suspicious = stats.boundsM.some(
      (side) => side < thresholds.minBoundsSideM || side > thresholds.maxBoundsSideM,
    );
    if (suspicious) {
      findings.push({
        gate: "bounds-suspicious",
        severity: "warning",
        message: `包围盒 ${stats.boundsM.map(formatMetres).join(" × ")} m 存在小于 ${thresholds.minBoundsSideM}m 或大于 ${thresholds.maxBoundsSideM}m 的边,疑似单位错误`,
        value: stats.boundsM.map(formatMetres).join("x"),
      });
    }
  } else {
    findings.push({ gate: "bounds-missing", severity: "info", message: boundsMissingMessage(stats) });
  }

  const hasGeometryCompression = stats.extensions.some((extension) =>
    GEOMETRY_COMPRESSION_EXTENSIONS.includes(extension),
  );
  if (
    stats.triangleCount !== null &&
    stats.triangleCount > thresholds.uncompressedTriangleLimit &&
    !hasGeometryCompression
  ) {
    findings.push({
      gate: "uncompressed-geometry",
      severity: "warning",
      message: `三角形总数 ${formatCount(stats.triangleCount)} 超过 ${formatCount(thresholds.uncompressedTriangleLimit)} 且未使用 Draco/meshopt 几何压缩`,
      value: stats.triangleCount,
      limit: thresholds.uncompressedTriangleLimit,
    });
  }

  const usesCompressedTextures =
    stats.extensions.includes(TEXTURE_COMPRESSION_EXTENSION) ||
    stats.textures.some((texture) => texture.mimeType === "image/ktx2");
  const totalTexturePixels = stats.textures.reduce(
    (sum, texture) => sum + (texture.width !== null && texture.height !== null ? texture.width * texture.height : 0),
    0,
  );
  if (!usesCompressedTextures && totalTexturePixels > thresholds.uncompressedTexturePixelLimit) {
    findings.push({
      gate: "uncompressed-texture",
      severity: "warning",
      message: `贴图总像素 ${formatCount(totalTexturePixels)} 超过 ${formatCount(thresholds.uncompressedTexturePixelLimit)} 且未使用 KTX2/BasisU 贴图压缩`,
      value: totalTexturePixels,
      limit: thresholds.uncompressedTexturePixelLimit,
    });
  }

  return findings;
}

export interface RunAssetGatesInput {
  filePath: string;
  buffer: Buffer;
  format: GateModelFormat;
  thresholds?: Partial<GateThresholds>;
}

/** Extract stats from the model buffer and run every gate rule against them. */
export function runAssetGates(input: RunAssetGatesInput): AssetGateResult {
  const thresholds = resolveGateThresholds(input.thresholds);
  const structuralFindings: GateFinding[] = [];
  let stats: AssetGateStats = {
    format: input.format,
    fileBytes: input.buffer.length,
    triangleCount: null,
    vertexCount: null,
    meshCount: null,
    primitiveCount: null,
    materialCount: null,
    textureCount: null,
    textures: [],
    extensions: [],
    boundsM: null,
    boundsStatus: "not-parsed",
  };

  if (input.format === "glb" || input.format === "gltf") {
    let gltf: unknown;
    let bin: Buffer | null = null;
    let parseFailure: string | null = null;
    if (input.format === "glb") {
      const chunks = readGlbChunks(input.buffer);
      if (chunks.ok) {
        gltf = chunks.json;
        bin = chunks.bin;
      } else {
        parseFailure = chunks.reason;
      }
    } else {
      try {
        gltf = JSON.parse(input.buffer.toString("utf8")) as unknown;
      } catch (error) {
        parseFailure = `glTF JSON 不可解析(${error instanceof Error ? error.message : String(error)})`;
      }
    }
    if (parseFailure !== null) {
      structuralFindings.push({ gate: "model-parse", severity: "error", message: `模型解析失败:${parseFailure}` });
    } else {
      const collected = collectGltfStats(gltf, bin);
      structuralFindings.push(...collected.structuralFindings);
      stats = {
        ...stats,
        triangleCount: collected.triangleCount,
        vertexCount: collected.vertexCount,
        meshCount: collected.meshCount,
        primitiveCount: collected.primitiveCount,
        materialCount: collected.materialCount,
        textureCount: collected.textures.length,
        textures: collected.textures,
        extensions: collected.extensions,
        boundsM: collected.boundsM,
        boundsStatus: collected.boundsStatus,
      };
    }
  }

  return {
    filePath: input.filePath,
    stats,
    findings: [...structuralFindings, ...evaluateGateFindings(stats, thresholds)],
  };
}

export interface GateFindingCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function summarizeFindings(findings: readonly GateFinding[]): GateFindingCounts {
  const counts: GateFindingCounts = { errors: 0, warnings: 0, infos: 0 };
  for (const finding of findings) {
    if (finding.severity === "error") counts.errors += 1;
    else if (finding.severity === "warning") counts.warnings += 1;
    else counts.infos += 1;
  }
  return counts;
}

/** A file is blocked on any error finding; with strict also on any warning. */
export function isGateBlocked(result: AssetGateResult, strict: boolean): boolean {
  const counts = summarizeFindings(result.findings);
  return counts.errors > 0 || (strict && counts.warnings > 0);
}

export interface AssetGateReportFile {
  filePath: string;
  blocked: boolean;
  stats: AssetGateStats;
  findings: GateFinding[];
}

export interface AssetGateReportDocument {
  generatedAt: string;
  generator: string;
  strict: boolean;
  thresholds: GateThresholds;
  summary: {
    totalFiles: number;
    passedFiles: number;
    blockedFiles: number;
    errorCount: number;
    warningCount: number;
    infoCount: number;
  };
  files: AssetGateReportFile[];
}

export function buildGateReport(
  results: readonly AssetGateResult[],
  options: { strict: boolean; thresholds: GateThresholds; generator: string; generatedAt?: string },
): AssetGateReportDocument {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let blockedCount = 0;
  const files = results.map((result): AssetGateReportFile => {
    const counts = summarizeFindings(result.findings);
    errorCount += counts.errors;
    warningCount += counts.warnings;
    infoCount += counts.infos;
    const blocked = isGateBlocked(result, options.strict);
    if (blocked) blockedCount += 1;
    return { filePath: result.filePath, blocked, stats: result.stats, findings: result.findings };
  });
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generator: options.generator,
    strict: options.strict,
    thresholds: options.thresholds,
    summary: {
      totalFiles: results.length,
      passedFiles: results.length - blockedCount,
      blockedFiles: blockedCount,
      errorCount,
      warningCount,
      infoCount,
    },
    files,
  };
}

const SEVERITY_TAGS: Record<GateSeverity, string> = { error: "[ERROR]", warning: "[WARN]", info: "[INFO]" };

/**
 * Render one file's gate result as aligned Chinese console lines:
 * a header, one stats line, one line per finding, and a verdict line.
 */
export function renderGateResultLines(result: AssetGateResult, options?: { strict?: boolean }): string[] {
  const strict = options?.strict === true;
  const stats = result.stats;
  const lines: string[] = [`资产体检:${basename(result.filePath)}`];

  const statsParts: string[] = [];
  if (stats.triangleCount !== null) statsParts.push(`三角形 ${formatCount(stats.triangleCount)}`);
  if (stats.vertexCount !== null) statsParts.push(`顶点 ${formatCount(stats.vertexCount)}`);
  if (stats.meshCount !== null) statsParts.push(`网格 ${stats.meshCount}`);
  if (stats.primitiveCount !== null) statsParts.push(`图元 ${stats.primitiveCount}`);
  if (stats.materialCount !== null) statsParts.push(`材质 ${stats.materialCount}`);
  if (stats.textureCount !== null) statsParts.push(`贴图 ${stats.textureCount}`);
  statsParts.push(`体积 ${formatMegabytes(stats.fileBytes)} MB`);
  lines.push(`  ${statsParts.join(" | ")}`);

  const gateWidth = result.findings.reduce((width, finding) => Math.max(width, finding.gate.length), 0);
  for (const finding of result.findings) {
    lines.push(`  ${SEVERITY_TAGS[finding.severity].padEnd(7)} ${finding.gate.padEnd(gateWidth)}  ${finding.message}`);
  }

  const counts = summarizeFindings(result.findings);
  const detail = `${counts.errors} error / ${counts.warnings} warning / ${counts.infos} info`;
  lines.push(
    isGateBlocked(result, strict) ? `  结论:未通过(${detail}),该文件不会写入 catalog` : `  结论:通过(${detail})`,
  );
  return lines;
}
