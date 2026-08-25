import JSZip from "jszip";
import { MathUtils } from "three";
import type { DirectorObject, DirectorProject, DirectorTransform } from "../schema/directorProject";
import {
  DIRECTOR_INTERCHANGE_CONTRACT,
  DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM,
  assertDirectorInterchangeCharacterAssets,
  createDirectorInterchangeManifest,
  createEmptyDirectorInterchangeProject,
  parseDirectorInterchangeManifest,
  readInterchangeBytes,
  stableDirectorInterchangeId,
  type DirectorInterchangeImportResult,
} from "./contract";
import { decodeUtf8Base64, encodeUtf8Base64 } from "./encoding";
import {
  directorCameraLookEuler,
  directorCameraTargetDistance,
  directorCameraTargetFromEuler,
} from "./cameraOrientation";

export const DIRECTOR_USD_ADAPTER = "director-usd-v1" as const;
/** MIME type for ASCII USDA files. */
export const DIRECTOR_USDA_MIME_TYPE = "model/vnd.usda";
/** MIME type for USDZ (zipped USD) archives. */
export const DIRECTOR_USDZ_MIME_TYPE = "model/vnd.usdz+zip";
/** The expected root USDA file path inside a USDZ archive. */
export const DIRECTOR_USDZ_ROOT_PATH = "scene.usda";
/** The Director manifest sidecar path inside a USDZ archive. */
export const DIRECTOR_USDZ_MANIFEST_PATH = "director-manifest.json";
/** Size and entry limits for USD interchange payloads. */
export const DIRECTOR_USD_LIMITS = Object.freeze({
  /** Maximum bytes for a plain USDA text layer. */
  maxTextBytes: 16 * 1024 * 1024,
  /** Maximum bytes for a USDZ archive. */
  maxArchiveBytes: 128 * 1024 * 1024,
  /** Maximum number of entries in a USDZ archive. */
  maxZipEntries: 64,
});

/** Options for exporting a Director project to USDA. */
export interface ExportDirectorUsdaOptions {
  /** When false, omit the embedded project manifest from the layer data. */
  embedProject?: boolean;
}

/** Options for importing a USDA layer into Director. */
export interface ImportDirectorUsdOptions {
  /** Optional base project to merge into. */
  baseProject?: DirectorProject;
}

function quoted(value: string) {
  return JSON.stringify(value);
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? Number(value.toFixed(9)) : fallback;
}

function tuple(values: readonly number[]) {
  return `(${values.map((value) => finite(value)).join(", ")})`;
}

function usdPrimName(id: string, fallback: string) {
  const base = (id || fallback)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1");
  return `${base || "Entity"}_${stableDirectorInterchangeId("usd", id || fallback).slice(-6)}`;
}

function customDataLines(entries: Array<[string, string | undefined]>, indentation = "        ") {
  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${indentation}string ${key} = ${quoted(value)}`);
}

function transformLines(transform: DirectorTransform, indentation = "        ") {
  return [
    `${indentation}double3 xformOp:translate = ${tuple(transform.position)}`,
    `${indentation}double3 xformOp:rotateXYZ = ${tuple(transform.rotation.map(MathUtils.radToDeg))}`,
    `${indentation}double3 xformOp:scale = ${tuple(transform.scale)}`,
    `${indentation}uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"]`,
  ];
}

/**
 * Emits an ASCII OpenUSD bridge layer. The full project manifest is custom layer
 * data, while stable IDs and editable transforms remain visible as ordinary prims.
 */
export function exportDirectorProjectToUsda(project: DirectorProject, options: ExportDirectorUsdaOptions = {}) {
  const manifest = createDirectorInterchangeManifest(project);
  const manifestBase64 = options.embedProject === false ? null : encodeUtf8Base64(JSON.stringify(manifest));
  const lines = [
    "#usda 1.0",
    "(",
    '    defaultPrim = "DirectorScene"',
    "    metersPerUnit = 1",
    '    upAxis = "Y"',
    "    customLayerData = {",
    `        string directorAdapter = ${quoted(DIRECTOR_USD_ADAPTER)}`,
    `        string directorContract = ${quoted(DIRECTOR_INTERCHANGE_CONTRACT)}`,
    '        string directorHandedness = "right"',
    ...(manifestBase64 ? [`        string directorManifestBase64 = ${quoted(manifestBase64)}`] : []),
    "    }",
    ")",
    "",
    'def Xform "DirectorScene" (',
    "    customData = {",
    `        string directorContract = ${quoted(DIRECTOR_INTERCHANGE_CONTRACT)}`,
    '        string directorCoordinateSystem = "meters/Y-up/right-handed"',
    "    }",
    ")",
    "{",
  ];

  project.objects.forEach((object) => {
    const id = object.id || stableDirectorInterchangeId("object", object.name);
    lines.push(
      `    def Xform ${quoted(usdPrimName(id, object.name))} (`,
      "        customData = {",
      ...customDataLines(
        [
          ["directorAdapter", DIRECTOR_USD_ADAPTER],
          ["directorContract", DIRECTOR_INTERCHANGE_CONTRACT],
          ["directorStableId", id],
          ["directorEntityType", "object"],
          ["directorKind", object.kind],
          ["directorDisplayName", object.name],
          ["directorAssetRefId", object.assetRefId],
          ["directorParentObjectId", object.parentObjectId],
        ],
        "            ",
      ),
      "        }",
      "    )",
      "    {",
      ...transformLines(object.transform),
      "    }",
      "",
    );
  });

  project.cameras.forEach((camera) => {
    const id = camera.id || stableDirectorInterchangeId("camera", camera.name);
    const cameraTransform: DirectorTransform = {
      ...camera.transform,
      rotation: directorCameraLookEuler(camera),
    };
    lines.push(
      `    def Camera ${quoted(usdPrimName(id, camera.name))} (`,
      "        customData = {",
      ...customDataLines(
        [
          ["directorAdapter", DIRECTOR_USD_ADAPTER],
          ["directorContract", DIRECTOR_INTERCHANGE_CONTRACT],
          ["directorStableId", id],
          ["directorEntityType", "camera"],
          ["directorDisplayName", camera.name],
        ],
        "            ",
      ),
      `            double directorFov = ${finite(camera.fov, 50)}`,
      "        }",
      "    )",
      "    {",
      ...transformLines(cameraTransform),
      `        float focalLength = ${finite(camera.focalLengthMm ?? 50, 50)}`,
      `        float focusDistance = ${finite(camera.focusDistanceM ?? 5, 5)}`,
      `        float fStop = ${finite(camera.apertureFStop ?? 2.8, 2.8)}`,
      `        float2 clippingRange = (${finite(camera.nearClipM ?? 0.01, 0.01)}, ${finite(
        camera.farClipM ?? 10000,
        10000,
      )})`,
      "    }",
      "",
    );
  });
  lines.push("}", "");
  return lines.join("\n");
}

/** `.usd` ASCII alias; binary USDC remains the responsibility of an OpenUSD host bridge. */
export const exportDirectorProjectToUsd = exportDirectorProjectToUsda;

function extractManifest(source: string) {
  const match = source.match(/\bstring\s+directorManifestBase64\s*=\s*"([A-Za-z0-9+/=]+)"/);
  if (!match) return null;
  try {
    return parseDirectorInterchangeManifest(JSON.parse(decodeUtf8Base64(match[1])) as unknown);
  } catch (error) {
    throw new Error(`USD Director manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseTuple(block: string, attribute: string): [number, number, number] | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`\\b${escaped}\\s*=\\s*\\(([^)]+)\\)`));
  if (!match) return null;
  const values = match[1].split(",").map((value) => Number(value.trim()));
  return values.length === 3 && values.every(Number.isFinite) ? (values as [number, number, number]) : null;
}

function parseTuple2(block: string, attribute: string): [number, number] | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`\\b${escaped}\\s*=\\s*\\(([^)]+)\\)`));
  if (!match) return null;
  const values = match[1].split(",").map((value) => Number(value.trim()));
  return values.length === 2 && values.every(Number.isFinite) ? (values as [number, number]) : null;
}

function parseString(block: string, key: string) {
  const match = block.match(new RegExp(`\\bstring\\s+${key}\\s*=\\s*"([^"\\n]*)"`));
  return match?.[1] ?? null;
}

function parseNumber(block: string, key: string) {
  const match = block.match(
    new RegExp(`\\b(?:double|float)\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*([-+0-9.eE]+)`),
  );
  const value = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function parseDirectorPrims(source: string) {
  const matches = [...source.matchAll(/^ {4}def\s+(Xform|Camera)\s+"([^"]+)"/gm)];
  return matches.map((match, index) => ({
    type: match[1] as "Xform" | "Camera",
    primName: match[2],
    block: source.slice(match.index!, matches[index + 1]?.index ?? source.length),
  }));
}

function normalizeKind(value: string | null): DirectorObject["kind"] {
  return value === "character" || value === "scene" || value === "prop" || value === "camera" || value === "panorama"
    ? value
    : "prop";
}

/**
 * Imports a Director project from a USDA ASCII layer.
 *
 * Parses Director custom data and prims, reconstructing objects and cameras
 * with their stable IDs. If an embedded manifest is present, it is validated
 * and used as the base project.
 *
 * @param source - The USDA text content.
 * @param options - Import options including optional base project.
 * @returns The imported project and any warnings.
 */
export function importDirectorProjectFromUsda(
  source: string,
  options: ImportDirectorUsdOptions = {},
): DirectorInterchangeImportResult {
  if (new TextEncoder().encode(source).byteLength > DIRECTOR_USD_LIMITS.maxTextBytes) {
    throw new Error("USDA layer exceeds the Director interchange size limit");
  }
  if (!/^#usda\s+1\.0\b/.test(source.trimStart())) throw new Error("USD bridge requires an ASCII #usda 1.0 layer");
  if (!/\bmetersPerUnit\s*=\s*1(?:\.0+)?\b/.test(source) || !/\bupAxis\s*=\s*"Y"/.test(source)) {
    throw new Error("USD bridge requires metres and Y-up metadata");
  }
  const handedness = source.match(/\bstring\s+directorHandedness\s*=\s*"([^"]+)"/)?.[1];
  if (handedness && handedness !== DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM.handedness) {
    throw new Error("USD bridge requires a right-handed coordinate system");
  }
  const manifest = extractManifest(source);
  const project = structuredClone(manifest?.project ?? options.baseProject ?? createEmptyDirectorInterchangeProject());
  const warnings: string[] = [];
  const importedIds = new Set<string>();

  parseDirectorPrims(source).forEach(({ type, primName, block }) => {
    const adapter = parseString(block, "directorAdapter");
    const contract = parseString(block, "directorContract");
    const id = parseString(block, "directorStableId");
    const entityType = parseString(block, "directorEntityType");
    if (adapter !== DIRECTOR_USD_ADAPTER || contract !== DIRECTOR_INTERCHANGE_CONTRACT || !id) return;
    if (importedIds.has(id)) {
      warnings.push(`Duplicate USD stable ID ${id} was ignored.`);
      return;
    }
    importedIds.add(id);
    const position = parseTuple(block, "xformOp:translate") ?? [0, 0, 0];
    const rotationDegrees = parseTuple(block, "xformOp:rotateXYZ") ?? [0, 0, 0];
    const scale = parseTuple(block, "xformOp:scale") ?? [1, 1, 1];
    const transform: DirectorTransform = {
      position,
      rotation: rotationDegrees.map(MathUtils.degToRad) as DirectorTransform["rotation"],
      scale,
    };
    const displayName = parseString(block, "directorDisplayName") ?? primName;
    if (entityType === "object" && type === "Xform") {
      const existing = project.objects.find((object) => object.id === id);
      if (existing) {
        existing.name = displayName;
        existing.transform = transform;
      } else {
        project.objects.push({
          id,
          name: displayName,
          kind: normalizeKind(parseString(block, "directorKind")),
          visible: true,
          locked: false,
          transform,
          ...(parseString(block, "directorAssetRefId")
            ? { assetRefId: parseString(block, "directorAssetRefId")! }
            : {}),
          ...(parseString(block, "directorParentObjectId")
            ? { parentObjectId: parseString(block, "directorParentObjectId")! }
            : {}),
        });
      }
      return;
    }
    if (entityType === "camera" && type === "Camera") {
      const fov = parseNumber(block, "directorFov") ?? 50;
      const existing = project.cameras.find((camera) => camera.id === id);
      const clippingRange = parseTuple2(block, "clippingRange");
      const nearClipM = clippingRange?.[0] ?? parseNumber(block, "clippingRange:min");
      const farClipM = clippingRange?.[1] ?? parseNumber(block, "clippingRange:max");
      const focusDistanceM = parseNumber(block, "focusDistance");
      const targetDistance = existing
        ? directorCameraTargetDistance(existing.transform.position, existing.target, focusDistanceM ?? 1)
        : (focusDistanceM ?? 1);
      const target = directorCameraTargetFromEuler(transform.position, transform.rotation, targetDistance);
      if (existing) {
        existing.name = displayName;
        existing.transform = transform;
        existing.target = target;
        existing.fov = fov;
        existing.focalLengthMm = parseNumber(block, "focalLength") ?? existing.focalLengthMm;
        existing.focusDistanceM = focusDistanceM ?? existing.focusDistanceM;
        existing.apertureFStop = parseNumber(block, "fStop") ?? existing.apertureFStop;
        existing.nearClipM = nearClipM ?? existing.nearClipM;
        existing.farClipM = farClipM ?? existing.farClipM;
      } else {
        project.cameras.push({
          id,
          name: displayName,
          fov,
          focalLengthMm: parseNumber(block, "focalLength") ?? undefined,
          focusDistanceM: focusDistanceM ?? undefined,
          apertureFStop: parseNumber(block, "fStop") ?? undefined,
          nearClipM: nearClipM ?? 0.01,
          farClipM: farClipM ?? 10_000,
          transform,
          targetMode: "manual",
          target,
        });
      }
    }
  });
  if (!manifest && !options.baseProject && importedIds.size === 0) {
    warnings.push("USD contains no Director stable-ID prims; an empty project was created.");
  }
  if (!project.activeCameraId || !project.cameras.some((camera) => camera.id === project.activeCameraId)) {
    project.activeCameraId = project.cameras[0]?.id ?? null;
  }
  assertDirectorInterchangeCharacterAssets(project);
  return { project, warnings };
}

export const importDirectorProjectFromUsd = importDirectorProjectFromUsda;

function assertSafeZipEntry(path: string) {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`Unsafe USDZ entry path: ${path}`);
  }
}

interface DirectorStoredZipEntry {
  name: string;
  data: Uint8Array;
}

interface DirectorStoredZipRecord extends DirectorStoredZipEntry {
  nameBytes: Uint8Array;
  crc32: number;
  localHeaderOffset: number;
}

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = 0x0314;
const ZIP_DOS_DATE_1980_01_01 = 0x0021;
const ZIP_PADDING_FIELD_ID = 12_345;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1) >>> 0;
    table[index] = value;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  bytes.forEach((byte) => {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  });
  return (value ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[], byteLength: number) {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.byteLength;
  });
  return output;
}

function createZipPadding(byteLength: number) {
  if (byteLength === 0) return new Uint8Array();
  const extra = new Uint8Array(byteLength);
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  view.setUint16(0, ZIP_PADDING_FIELD_ID, true);
  view.setUint16(2, byteLength - 4, true);
  return extra;
}

/**
 * USDZ is a deliberately constrained ZIP profile: entries are stored without
 * compression and each file's payload starts at a 64-byte archive offset.
 * General ZIP writers (including JSZip) do not expose local-header padding, so
 * this small deterministic writer owns the two required records directly.
 */
function createAlignedStoredZip(entries: readonly DirectorStoredZipEntry[]) {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const records: DirectorStoredZipRecord[] = [];
  let offset = 0;

  entries.forEach((entry) => {
    const nameBytes = encoder.encode(entry.name);
    const unalignedDataOffset = offset + 30 + nameBytes.byteLength;
    let extraByteLength = (64 - (unalignedDataOffset % 64)) % 64;
    if (extraByteLength > 0 && extraByteLength < 4) extraByteLength += 64;
    const extra = createZipPadding(extraByteLength);
    const localHeader = new Uint8Array(30);
    const view = new DataView(localHeader.buffer);
    const checksum = crc32(entry.data);

    view.setUint32(0, ZIP_LOCAL_FILE_SIGNATURE, true);
    view.setUint16(4, ZIP_VERSION, true);
    view.setUint16(6, ZIP_UTF8_FLAG, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, ZIP_DOS_DATE_1980_01_01, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, entry.data.byteLength, true);
    view.setUint32(22, entry.data.byteLength, true);
    view.setUint16(26, nameBytes.byteLength, true);
    view.setUint16(28, extra.byteLength, true);

    const localHeaderOffset = offset;
    parts.push(localHeader, nameBytes, extra, entry.data);
    offset += localHeader.byteLength + nameBytes.byteLength + extra.byteLength + entry.data.byteLength;
    records.push({ ...entry, nameBytes, crc32: checksum, localHeaderOffset });
  });

  const centralDirectoryOffset = offset;
  records.forEach((record) => {
    const centralHeader = new Uint8Array(46);
    const view = new DataView(centralHeader.buffer);
    view.setUint32(0, ZIP_CENTRAL_FILE_SIGNATURE, true);
    view.setUint16(4, ZIP_UNIX_VERSION, true);
    view.setUint16(6, ZIP_VERSION, true);
    view.setUint16(8, ZIP_UTF8_FLAG, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, ZIP_DOS_DATE_1980_01_01, true);
    view.setUint32(16, record.crc32, true);
    view.setUint32(20, record.data.byteLength, true);
    view.setUint32(24, record.data.byteLength, true);
    view.setUint16(28, record.nameBytes.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0x81a40000, true);
    view.setUint32(42, record.localHeaderOffset, true);
    parts.push(centralHeader, record.nameBytes);
    offset += centralHeader.byteLength + record.nameBytes.byteLength;
  });

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, ZIP_END_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, records.length, true);
  endView.setUint16(10, records.length, true);
  endView.setUint32(12, offset - centralDirectoryOffset, true);
  endView.setUint32(16, centralDirectoryOffset, true);
  endView.setUint16(20, 0, true);
  parts.push(end);
  offset += end.byteLength;

  return concatBytes(parts, offset);
}

/**
 * Exports a Director project to a USDZ archive.
 *
 * Produces a spec-compliant ZIP with 64-byte-aligned stored entries
 * containing the USDA root layer and the Director manifest sidecar.
 *
 * @param project - The Director project to export.
 * @param options - Export options.
 * @returns The USDZ archive bytes.
 */
export async function exportDirectorProjectToUsdz(project: DirectorProject, options: ExportDirectorUsdaOptions = {}) {
  const encoder = new TextEncoder();
  return createAlignedStoredZip([
    { name: DIRECTOR_USDZ_ROOT_PATH, data: encoder.encode(exportDirectorProjectToUsda(project, options)) },
    {
      name: DIRECTOR_USDZ_MANIFEST_PATH,
      data: encoder.encode(`${JSON.stringify(createDirectorInterchangeManifest(project), null, 2)}\n`),
    },
  ]);
}

/**
 * Imports a Director project from a USDZ archive.
 *
 * Opens the ZIP, validates entry paths, finds the USDA root layer,
 * and delegates to {@link importDirectorProjectFromUsda}. Falls back
 * to any `.usda` entry if the canonical root path is absent.
 *
 * @param source - The USDZ archive bytes.
 * @param options - Import options.
 * @returns The imported project and any warnings.
 */
export async function importDirectorProjectFromUsdz(
  source: Uint8Array | ArrayBuffer | Blob,
  options: ImportDirectorUsdOptions = {},
) {
  const bytes = await readInterchangeBytes(source);
  if (bytes.byteLength > DIRECTOR_USD_LIMITS.maxArchiveBytes) {
    throw new Error("USDZ archive exceeds the Director interchange size limit");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    throw new Error("USDZ archive could not be opened or failed its CRC check");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > DIRECTOR_USD_LIMITS.maxZipEntries) throw new Error("USDZ archive contains too many entries");
  entries.forEach((entry) => {
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName;
    assertSafeZipEntry(originalName ?? entry.name);
  });
  const root = zip.file(DIRECTOR_USDZ_ROOT_PATH) ?? entries.find((entry) => entry.name.toLowerCase().endsWith(".usda"));
  if (!root) throw new Error("USDZ archive contains no USDA root layer");
  let baseProject = options.baseProject;
  const manifestEntry = zip.file(DIRECTOR_USDZ_MANIFEST_PATH);
  if (manifestEntry) {
    const value = await manifestEntry.async("string");
    if (new TextEncoder().encode(value).byteLength > DIRECTOR_USD_LIMITS.maxTextBytes) {
      throw new Error("USDZ Director manifest exceeds the size limit");
    }
    try {
      baseProject = parseDirectorInterchangeManifest(JSON.parse(value) as unknown).project;
    } catch (error) {
      throw new Error(`USDZ Director manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const usda = await root.async("string");
  return importDirectorProjectFromUsda(usda, { ...options, baseProject });
}
