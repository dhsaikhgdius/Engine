import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ASSET_CATALOG_SCHEMA_VERSION,
  assetCatalogIdentifierSchema,
  assetCatalogKindSchema,
  assetCatalogLibrarySchema,
  assetCatalogSourceSchema,
  assetCatalogSpatialSchema,
  type AssetCatalogFormat,
  type AssetCatalogItem,
  type AssetCatalogKind,
  type AssetCatalogLibrary,
} from "../../packages/protocol/src/assetCatalogProtocol";
import {
  DEFAULT_GATE_THRESHOLDS,
  buildGateReport,
  isGateBlocked,
  renderGateResultLines,
  resolveGateThresholds,
  runAssetGates,
  type AssetGateResult,
  type GateThresholds,
} from "./assetIngestGates";

/**
 * Unified Asset Catalog v2 ingest CLI.
 *
 * Registers model files that already live under assets/library/<library>/
 * into that library's catalog.v2.json (upsert by item id). GLB/GLTF inputs
 * get spatial bounds derived from accessor min/max; FBX/OBJ inputs are
 * registered without geometry stats. The merged document is always validated
 * against assetCatalogLibrarySchema before it is written.
 *
 * Every input runs the game-grade quality gates in assetIngestGates.ts before
 * registration; files with error findings (or warnings under --strict) are
 * skipped, the rest are still processed, and the process exits non-zero.
 *
 * Run `npx tsx tools/scripts/asset-ingest.ts --help` for usage.
 */

export type AssetCatalogProvenance = AssetCatalogItem["source"]["provenance"];
export type AssetCatalogFrontAxis = Exclude<NonNullable<AssetCatalogItem["spatial"]>["front_axis"], null>;
export type Vec3 = [number, number, number];

export type PositionBounds =
  | { status: "ok"; min: Vec3; max: Vec3 }
  | { status: "no-position-accessors" }
  | { status: "missing-min-max" };

export interface SpatialMetrics {
  bounds_m: Vec3;
  footprint_m: [number, number];
  height_m: number;
  ground_offset_y: number;
}

export interface IngestRequest {
  /** Repository root that contains assets/library. */
  rootDir: string;
  /** Model files or directories to register. */
  inputs: readonly string[];
  /** Library directory name under assets/library. */
  library: string;
  kind?: AssetCatalogKind;
  category?: string;
  name?: string;
  nameZh?: string;
  aliases?: readonly string[];
  tags?: readonly string[];
  frontAxis?: AssetCatalogFrontAxis;
  id?: string;
  thumbnail?: string;
  provider?: string;
  provenance?: AssetCatalogProvenance;
  license?: string;
  usageHint?: string;
  heightM?: number;
  groundOffsetY?: number;
  rigType?: string;
  rigBonePrefix?: string;
  rigBoneCount?: number;
  dryRun?: boolean;
  /** Escape hatch: skip the quality gates and register anyway. */
  skipGates?: boolean;
  /** Treat gate warnings as failures (blocks registration). */
  strictGates?: boolean;
  /** Gate threshold overrides; unset fields fall back to DEFAULT_GATE_THRESHOLDS. */
  gateThresholds?: Partial<GateThresholds>;
  /** When set, write the JSON gate report for all inputs to this path. */
  gateReportPath?: string;
}

export interface IngestReport {
  outPath: string;
  document: AssetCatalogLibrary;
  serialized: string;
  addedIds: string[];
  updatedIds: string[];
  warnings: string[];
  written: boolean;
  /** Gate results in input order (empty when gates were skipped). */
  gateResults: AssetGateResult[];
  /** Absolute paths of inputs the gates rejected (not registered). */
  blockedFiles: string[];
  /** Absolute path of the JSON gate report, when one was written. */
  gateReportPath: string | null;
}

export class IngestError extends Error {}

const GENERATOR = "tools/scripts/asset-ingest.ts";
const CATALOG_FILE_NAME = "catalog.v2.json";
const MODEL_FORMAT_BY_EXTENSION: Readonly<Record<string, Extract<AssetCatalogFormat, "glb" | "gltf" | "fbx" | "obj">>> =
  {
    ".glb": "glb",
    ".gltf": "gltf",
    ".fbx": "fbx",
    ".obj": "obj",
  };
const KINDS = assetCatalogKindSchema.options;
const PROVENANCES = assetCatalogSourceSchema.shape.provenance.options;
const FRONT_AXES = assetCatalogSpatialSchema.shape.front_axis.unwrap().options;
/** min.y magnitudes at or below this are treated as already ground-contacting. */
const GROUND_CONTACT_EPSILON_M = 1e-6;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

const HELP_TEXT = `Director Asset Catalog v2 ingest tool

Usage:
  npx tsx tools/scripts/asset-ingest.ts <files-or-dirs...> --library <dir-name> [options]

Registers .glb/.gltf/.fbx/.obj files that already live under
assets/library/<library>/ into that library's ${CATALOG_FILE_NAME} (upsert by
item id, sorted by category/name/id, validated against the Asset Catalog v2
schema). GLB/GLTF inputs get spatial bounds derived from accessor min/max;
FBX/OBJ inputs are registered without geometry stats. Existing catalog.json
files are never touched.

Options:
  --library <name>           Required. Library directory name under assets/library.
  --kind <kind>              ${KINDS.join("|")} (default: prop).
  --category <text>          Catalog category (default: other).
  --name <text>              Display name (single input only; default: file stem).
  --name-zh <text>           Chinese display name (single input only).
  --aliases <a,b,c>          Comma-separated aliases.
  --tags <a,b,c>             Comma-separated tags.
  --front-axis <axis>        ${FRONT_AXES.join("|")} authored front axis.
  --id <id>                  Item id (single input only; default: <library>:<file-stem-slug>).
  --thumbnail <url>          Preview thumbnail URL (single input only).
  --provider <text>          Source provider (default: director).
  --provenance <value>       ${PROVENANCES.join("|")} (default: bundled).
  --license <text>           License identifier (default: null).
  --usage-hint <text>        One-sentence Agent-facing usage hint (single input only).
  --height-m <number>        Known height in metres, overrides computed (single input only).
  --ground-offset-y <number> Known ground offset in metres, overrides computed (single input only).
  --rig-type <text>          Rig type (e.g. mixamo); enables the rig block.
  --rig-bone-prefix <text>   Rig bone name prefix (requires --rig-type).
  --rig-bone-count <int>     Rig bone count (requires --rig-type).
  --dry-run                  Validate and print the merged catalog without writing.
  --help, -h                 Show this help.

Quality gates (run per input before registration; see assetIngestGates.ts):
  Each file gets a health check (triangle/vertex budgets, texture size and
  count, file size, bounds sanity, compression hints). Files with [ERROR]
  findings (or [WARN] findings under --strict) are not written to the catalog;
  the rest are still processed and the process exits non-zero.

  --report <path>            Write a JSON health report for all inputs (per-file
                             findings, summary counts, timestamp).
  --strict                   Treat gate warnings as failures.
  --skip-gates               Escape hatch: skip the gates and register anyway
                             (cannot be combined with --report).
  --max-triangles <int>      Triangle error budget (default ${DEFAULT_GATE_THRESHOLDS.maxTrianglesError}).
  --max-vertices <int>       Vertex error budget (default ${DEFAULT_GATE_THRESHOLDS.maxVerticesError}).
  --max-texture-size <int>   Texture side error limit in px (default ${DEFAULT_GATE_THRESHOLDS.maxTextureSizeError}).
  --max-texture-count <int>  Texture count warning limit (default ${DEFAULT_GATE_THRESHOLDS.maxTextureCount}).
  --max-file-mb <number>     File size error limit in MB (default ${DEFAULT_GATE_THRESHOLDS.maxFileBytesError / (1024 * 1024)}).

Examples:
  npx tsx tools/scripts/asset-ingest.ts assets/library/model-library/便利生活/ATM_low.fbx \\
    --library model-library --id model-library:atm --name ATM --name-zh 自动取款机 \\
    --category structure --thumbnail /model-library/便利生活/缩略图/自动取款机.svg
  npx tsx tools/scripts/asset-ingest.ts assets/library/flick-stage-props/animals \\
    --library flick-stage-props --tags animal --dry-run`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value as unknown[];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/** Round to micrometres so derived metrics stay short and diffable. */
function roundMetric(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

export function slugifyFileStem(stem: string): string {
  return stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]+/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new IngestError(`${label}: glTF JSON is unreadable (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Read the JSON chunk out of a binary glTF container: 12-byte header
 * (magic "glTF", version, total length) followed by 4-byte-aligned chunks.
 */
export function readGlbJson(buffer: Buffer, label: string): unknown {
  if (buffer.length < 12) throw new IngestError(`${label}: not a GLB container (missing 12-byte header)`);
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new IngestError(`${label}: not a GLB container (bad magic)`);
  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new IngestError(`${label}: unsupported GLB version ${version}; expected 2`);
  const declaredLength = Math.min(buffer.readUInt32LE(8), buffer.length);
  let offset = 12;
  while (offset + 8 <= declaredLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkLength > buffer.length) throw new IngestError(`${label}: truncated GLB chunk`);
    if (chunkType === GLB_JSON_CHUNK) {
      return parseJsonBytes(buffer.subarray(chunkStart, chunkStart + chunkLength), label);
    }
    offset = chunkStart + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  throw new IngestError(`${label}: GLB has no JSON chunk`);
}

/**
 * Union the min/max of every POSITION accessor referenced by mesh primitives.
 * Bounds are reported unavailable if any referenced accessor lacks min/max,
 * because a partial union would understate the real AABB.
 */
export function extractPositionBounds(gltf: unknown): PositionBounds {
  const document = asRecord(gltf);
  const meshes = asArray(document?.meshes);
  const accessors = asArray(document?.accessors);
  const positionAccessorIndexes: number[] = [];
  const seen = new Set<number>();
  for (const mesh of meshes) {
    for (const primitive of asArray(asRecord(mesh)?.primitives)) {
      const position = asRecord(asRecord(primitive)?.attributes)?.POSITION;
      if (typeof position === "number" && Number.isInteger(position) && !seen.has(position)) {
        seen.add(position);
        positionAccessorIndexes.push(position);
      }
    }
  }
  if (positionAccessorIndexes.length === 0) return { status: "no-position-accessors" };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const accessorIndex of positionAccessorIndexes) {
    const accessor = asRecord(accessors[accessorIndex]);
    const accessorMin = asVec3(accessor?.min);
    const accessorMax = asVec3(accessor?.max);
    if (!accessorMin || !accessorMax) return { status: "missing-min-max" };
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], accessorMin[axis]);
      max[axis] = Math.max(max[axis], accessorMax[axis]);
    }
  }
  return { status: "ok", min, max };
}

export function deriveSpatialMetrics(min: Vec3, max: Vec3): SpatialMetrics | null {
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (size.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const bounds: Vec3 = [roundMetric(size[0]), roundMetric(size[1]), roundMetric(size[2])];
  return {
    bounds_m: bounds,
    footprint_m: [bounds[0], bounds[2]],
    height_m: bounds[1],
    ground_offset_y: Math.abs(min[1]) <= GROUND_CONTACT_EPSILON_M ? 0 : roundMetric(-min[1]),
  };
}

/** Replace items by id (or append), then sort by category, name, id. */
export function upsertCatalogItems(
  existingItems: readonly AssetCatalogItem[],
  incomingItems: readonly AssetCatalogItem[],
): { items: AssetCatalogItem[]; addedIds: string[]; updatedIds: string[] } {
  const items = [...existingItems];
  const indexById = new Map(items.map((item, index) => [item.id, index]));
  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  for (const item of incomingItems) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, items.length);
      items.push(item);
      addedIds.push(item.id);
    } else {
      items[existingIndex] = item;
      updatedIds.push(item.id);
    }
  }
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  items.sort((a, b) => byText(a.category, b.category) || byText(a.name, b.name) || byText(a.id, b.id));
  return { items, addedIds, updatedIds };
}

/** Rebuild an item with the canonical schema key order for stable diffs. */
export function canonicalizeCatalogItem(item: AssetCatalogItem): AssetCatalogItem {
  return {
    id: item.id,
    name: item.name,
    name_zh: item.name_zh,
    aliases: [...item.aliases],
    category: item.category,
    tags: [...item.tags],
    kind: item.kind,
    files: item.files.map((file) => ({ format: file.format, url: file.url, bytes: file.bytes, sha256: file.sha256 })),
    primary_format: item.primary_format,
    preview: { kind: item.preview.kind, thumbnail_url: item.preview.thumbnail_url },
    spatial: item.spatial
      ? {
          bounds_m: item.spatial.bounds_m ? [...item.spatial.bounds_m] : null,
          footprint_m: item.spatial.footprint_m ? [...item.spatial.footprint_m] : null,
          height_m: item.spatial.height_m,
          ground_offset_y: item.spatial.ground_offset_y,
          front_axis: item.spatial.front_axis,
        }
      : null,
    rig: item.rig ? { type: item.rig.type, bone_prefix: item.rig.bone_prefix, bone_count: item.rig.bone_count } : null,
    motion: item.motion
      ? {
          duration_s: item.motion.duration_s,
          frame_count: item.motion.frame_count,
          source_fps: item.motion.source_fps,
          default_loop: item.motion.default_loop,
          recommended_root_motion: item.motion.recommended_root_motion,
        }
      : null,
    source: {
      provider: item.source.provider,
      provenance: item.source.provenance,
      source_url: item.source.source_url,
      license: item.source.license,
      license_url: item.source.license_url,
    },
    usage_hint: item.usage_hint,
  };
}

export function validateCatalogDocument(document: unknown, label: string): AssetCatalogLibrary {
  const result = assetCatalogLibrarySchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.length > 0 ? issue.path.join(".") : "(document)"}: ${issue.message}`)
      .join("\n");
    throw new IngestError(`${label} failed Asset Catalog v2 validation:\n${details}`);
  }
  return result.data;
}

export function serializeCatalogDocument(document: AssetCatalogLibrary): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function walkModelFiles(directory: string): string[] {
  const collected: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...walkModelFiles(entryPath));
    else if (entry.isFile() && extname(entry.name).toLowerCase() in MODEL_FORMAT_BY_EXTENSION) {
      collected.push(entryPath);
    }
  }
  return collected;
}

function collectModelFiles(inputs: readonly string[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const push = (filePath: string): void => {
    if (!seen.has(filePath)) {
      seen.add(filePath);
      files.push(filePath);
    }
  };
  for (const input of inputs) {
    const absolute = resolve(input);
    if (!existsSync(absolute)) throw new IngestError(`Input not found: ${input}`);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const filePath of walkModelFiles(absolute)) push(filePath);
    } else if (stats.isFile()) {
      if (!(extname(absolute).toLowerCase() in MODEL_FORMAT_BY_EXTENSION)) {
        throw new IngestError(`Unsupported input file: ${input} (expected .glb, .gltf, .fbx, or .obj)`);
      }
      push(absolute);
    } else {
      throw new IngestError(`Input is neither a file nor a directory: ${input}`);
    }
  }
  return files;
}

function defaultItemId(library: string, stem: string, fileName: string): string {
  const slug = slugifyFileStem(stem);
  if (!slug) {
    throw new IngestError(`${fileName}: cannot derive an ASCII id slug from the file name; pass --id explicitly`);
  }
  return `${library}:${slug}`;
}

function readExistingCatalogItems(outPath: string, library: string): AssetCatalogItem[] {
  if (!existsSync(outPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf8")) as unknown;
  } catch (error) {
    throw new IngestError(
      `Existing ${outPath} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it before ingesting`,
    );
  }
  const document = validateCatalogDocument(parsed, `Existing ${outPath}`);
  if (document.library !== library) {
    throw new IngestError(`Existing ${outPath} belongs to library "${document.library}", not "${library}"`);
  }
  return [...document.items];
}

interface FileIngestContext {
  request: IngestRequest;
  libraryDir: string;
  warnings: string[];
}

function buildItemForFile(filePath: string, buffer: Buffer, context: FileIngestContext): AssetCatalogItem {
  const { request, libraryDir, warnings } = context;
  const fileName = basename(filePath);
  const extension = extname(fileName).toLowerCase();
  const format = MODEL_FORMAT_BY_EXTENSION[extension];
  const stem = fileName.slice(0, fileName.length - extension.length);

  const relativeToLibrary = relative(libraryDir, filePath);
  if (relativeToLibrary.startsWith("..") || isAbsolute(relativeToLibrary)) {
    throw new IngestError(
      `${fileName}: file must already live under assets/library/${request.library}/ (got ${filePath}); this tool registers files in place and never copies them`,
    );
  }
  // Vite serves publicDir (assets/library) at the web root; keep raw UTF-8.
  const url = `/${request.library}/${relativeToLibrary.split(sep).join("/")}`;

  const sha256 = createHash("sha256").update(buffer).digest("hex");

  let metrics: SpatialMetrics | null = null;
  if (format === "glb" || format === "gltf") {
    const gltf = format === "glb" ? readGlbJson(buffer, fileName) : parseJsonBytes(buffer, fileName);
    const bounds = extractPositionBounds(gltf);
    if (bounds.status === "ok") {
      metrics = deriveSpatialMetrics(bounds.min, bounds.max);
      if (!metrics) warnings.push(`${fileName}: POSITION min/max describe a degenerate box; spatial bounds left null`);
    } else if (bounds.status === "missing-min-max") {
      warnings.push(`${fileName}: POSITION accessors lack min/max; spatial bounds left null`);
    } else {
      warnings.push(`${fileName}: no mesh primitives with POSITION accessors; spatial bounds left null`);
    }
  } else {
    warnings.push(`${fileName}: ${format} geometry is not parsed; registered without spatial bounds`);
  }

  const heightM = request.heightM ?? metrics?.height_m ?? null;
  const groundOffsetY = request.groundOffsetY ?? metrics?.ground_offset_y ?? null;
  const frontAxis = request.frontAxis ?? null;
  const spatial: AssetCatalogItem["spatial"] =
    metrics || heightM !== null || groundOffsetY !== null || frontAxis !== null
      ? {
          bounds_m: metrics?.bounds_m ?? null,
          footprint_m: metrics?.footprint_m ?? null,
          height_m: heightM,
          ground_offset_y: groundOffsetY,
          front_axis: frontAxis,
        }
      : null;

  const rig: AssetCatalogItem["rig"] = request.rigType
    ? {
        type: request.rigType,
        bone_prefix: request.rigBonePrefix ?? null,
        bone_count: request.rigBoneCount ?? null,
      }
    : null;

  const id = request.id ?? defaultItemId(request.library, stem, fileName);
  if (!assetCatalogIdentifierSchema.safeParse(id).success) {
    throw new IngestError(
      `${fileName}: item id "${id}" is invalid; use letters, digits, dot, underscore, colon, dash (starting with a letter or digit)`,
    );
  }

  return {
    id,
    name: request.name?.trim() || stem,
    name_zh: request.nameZh?.trim() || null,
    aliases: (request.aliases ?? []).map((alias) => alias.trim()).filter((alias) => alias.length > 0),
    category: request.category?.trim() || "other",
    tags: (request.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    kind: request.kind ?? "prop",
    files: [{ format, url, bytes: buffer.length, sha256 }],
    primary_format: format,
    preview: { kind: "image", thumbnail_url: request.thumbnail?.trim() || null },
    spatial,
    rig,
    motion: null,
    source: {
      provider: request.provider?.trim() || "director",
      provenance: request.provenance ?? "bundled",
      source_url: null,
      license: request.license?.trim() || null,
      license_url: null,
    },
    usage_hint: request.usageHint?.trim() || null,
  };
}

export function ingest(request: IngestRequest): IngestReport {
  const warnings: string[] = [];
  const rootDir = resolve(request.rootDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.library)) {
    throw new IngestError(`--library must be a plain directory name under assets/library (got "${request.library}")`);
  }
  const libraryDir = join(rootDir, "assets", "library", request.library);
  if (!existsSync(libraryDir) || !statSync(libraryDir).isDirectory()) {
    throw new IngestError(
      `Library directory not found: ${join("assets", "library", request.library)}; create it (or pick an existing library) first`,
    );
  }
  if (!request.rigType && (request.rigBonePrefix !== undefined || request.rigBoneCount !== undefined)) {
    throw new IngestError("--rig-bone-prefix and --rig-bone-count require --rig-type");
  }
  if (request.skipGates === true && request.gateReportPath !== undefined) {
    throw new IngestError("--report needs the quality gates to run; drop either --skip-gates or --report");
  }

  const modelFiles = collectModelFiles(request.inputs);
  if (modelFiles.length === 0) {
    throw new IngestError("No supported model files (.glb/.gltf/.fbx/.obj) found in the given inputs");
  }
  if (modelFiles.length > 1) {
    const singleInputFlags: Array<[string, unknown]> = [
      ["--id", request.id],
      ["--name", request.name],
      ["--name-zh", request.nameZh],
      ["--thumbnail", request.thumbnail],
      ["--usage-hint", request.usageHint],
      ["--height-m", request.heightM],
      ["--ground-offset-y", request.groundOffsetY],
    ];
    const conflicting = singleInputFlags.filter(([, value]) => value !== undefined).map(([flag]) => flag);
    if (conflicting.length > 0) {
      throw new IngestError(`${conflicting.join(", ")} apply to a single input file; got ${modelFiles.length} files`);
    }
  }

  const skipGates = request.skipGates === true;
  const strictGates = request.strictGates === true;
  const thresholds = resolveGateThresholds(request.gateThresholds);
  const gateResults: AssetGateResult[] = [];
  const blockedFiles: string[] = [];
  const context: FileIngestContext = { request, libraryDir, warnings };
  const incoming: AssetCatalogItem[] = [];
  const idsInRun = new Set<string>();
  for (const filePath of modelFiles) {
    const buffer = readFileSync(filePath);
    if (!skipGates) {
      const format = MODEL_FORMAT_BY_EXTENSION[extname(filePath).toLowerCase()];
      const gateResult = runAssetGates({ filePath, buffer, format, thresholds });
      gateResults.push(gateResult);
      if (isGateBlocked(gateResult, strictGates)) {
        blockedFiles.push(filePath);
        continue;
      }
    }
    const item = buildItemForFile(filePath, buffer, context);
    if (idsInRun.has(item.id)) {
      throw new IngestError(`Two inputs derive the same item id "${item.id}"; ingest them separately with explicit --id values`);
    }
    idsInRun.add(item.id);
    incoming.push(item);
  }

  let gateReportPath: string | null = null;
  if (request.gateReportPath !== undefined) {
    gateReportPath = resolve(request.gateReportPath);
    const reportDocument = buildGateReport(gateResults, { strict: strictGates, thresholds, generator: GENERATOR });
    mkdirSync(dirname(gateReportPath), { recursive: true });
    writeFileSync(gateReportPath, `${JSON.stringify(reportDocument, null, 2)}\n`, "utf8");
  }

  const outPath = join(libraryDir, CATALOG_FILE_NAME);
  const existingItems = readExistingCatalogItems(outPath, request.library);
  const { items, addedIds, updatedIds } = upsertCatalogItems(existingItems, incoming);
  const document: AssetCatalogLibrary = {
    schema_version: ASSET_CATALOG_SCHEMA_VERSION,
    library: request.library,
    generator: GENERATOR,
    items: items.map(canonicalizeCatalogItem),
  };
  validateCatalogDocument(document, `Merged catalog for library "${request.library}"`);
  const serialized = serializeCatalogDocument(document);
  // Never touch the catalog when every input was rejected by the gates.
  const written = request.dryRun !== true && incoming.length > 0;
  if (written) writeFileSync(outPath, serialized, "utf8");
  return {
    outPath,
    document,
    serialized,
    addedIds,
    updatedIds,
    warnings,
    written,
    gateResults,
    blockedFiles,
    gateReportPath,
  };
}

export type CliOptions = Omit<IngestRequest, "rootDir" | "inputs" | "library"> & {
  help: boolean;
  inputs: string[];
  library?: string;
};

function parseChoice<T extends string>(value: string, choices: readonly T[], flag: string): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new IngestError(`${flag} must be one of: ${choices.join(", ")} (got "${value}")`);
}

export function parseCliArguments(argv: readonly string[]): CliOptions {
  const options: CliOptions = { help: false, inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const readValue = (flag: string): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new IngestError(`${flag} requires a value`);
      return value;
    };
    const readList = (flag: string): string[] =>
      readValue(flag)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    const readNumber = (flag: string): number => {
      const value = Number(readValue(flag));
      if (!Number.isFinite(value)) throw new IngestError(`${flag} must be a finite number`);
      return value;
    };
    const readPositiveNumber = (flag: string): number => {
      const value = readNumber(flag);
      if (value <= 0) throw new IngestError(`${flag} must be a positive number`);
      return value;
    };
    const readPositiveInteger = (flag: string): number => {
      const value = readPositiveNumber(flag);
      if (!Number.isInteger(value)) throw new IngestError(`${flag} must be a positive integer`);
      return value;
    };
    const setGateThreshold = (key: keyof GateThresholds, value: number): void => {
      options.gateThresholds = { ...options.gateThresholds, [key]: value };
    };

    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--strict") options.strictGates = true;
    else if (argument === "--skip-gates") options.skipGates = true;
    else if (argument === "--report") options.gateReportPath = readValue(argument);
    else if (argument === "--max-triangles") setGateThreshold("maxTrianglesError", readPositiveInteger(argument));
    else if (argument === "--max-vertices") setGateThreshold("maxVerticesError", readPositiveInteger(argument));
    else if (argument === "--max-texture-size") setGateThreshold("maxTextureSizeError", readPositiveInteger(argument));
    else if (argument === "--max-texture-count") setGateThreshold("maxTextureCount", readPositiveInteger(argument));
    else if (argument === "--max-file-mb") setGateThreshold("maxFileBytesError", readPositiveNumber(argument) * 1024 * 1024);
    else if (argument === "--library") options.library = readValue(argument);
    else if (argument === "--kind") options.kind = parseChoice(readValue(argument), KINDS, argument);
    else if (argument === "--category") options.category = readValue(argument);
    else if (argument === "--name") options.name = readValue(argument);
    else if (argument === "--name-zh") options.nameZh = readValue(argument);
    else if (argument === "--aliases") options.aliases = readList(argument);
    else if (argument === "--tags") options.tags = readList(argument);
    else if (argument === "--front-axis") options.frontAxis = parseChoice(readValue(argument), FRONT_AXES, argument);
    else if (argument === "--id") options.id = readValue(argument);
    else if (argument === "--thumbnail") options.thumbnail = readValue(argument);
    else if (argument === "--provider") options.provider = readValue(argument);
    else if (argument === "--provenance") options.provenance = parseChoice(readValue(argument), PROVENANCES, argument);
    else if (argument === "--license") options.license = readValue(argument);
    else if (argument === "--usage-hint") options.usageHint = readValue(argument);
    else if (argument === "--height-m") {
      const value = readNumber(argument);
      if (value < 0) throw new IngestError("--height-m must be zero or positive");
      options.heightM = value;
    } else if (argument === "--ground-offset-y") options.groundOffsetY = readNumber(argument);
    else if (argument === "--rig-type") options.rigType = readValue(argument);
    else if (argument === "--rig-bone-prefix") options.rigBonePrefix = readValue(argument);
    else if (argument === "--rig-bone-count") {
      const value = readNumber(argument);
      if (!Number.isInteger(value) || value <= 0) throw new IngestError("--rig-bone-count must be a positive integer");
      options.rigBoneCount = value;
    } else if (argument.startsWith("--")) throw new IngestError(`Unknown option: ${argument} (run --help for usage)`);
    else options.inputs.push(argument);
  }
  return options;
}

function main(): void {
  const { help, library, inputs, ...rest } = parseCliArguments(process.argv.slice(2));
  if (help) {
    console.log(HELP_TEXT);
    return;
  }
  if (!library) throw new IngestError("--library is required; run with --help for usage");
  if (inputs.length === 0) throw new IngestError("Pass at least one model file or directory; run with --help for usage");
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const report = ingest({ ...rest, rootDir, inputs, library });
  for (const gateResult of report.gateResults) {
    for (const line of renderGateResultLines(gateResult, { strict: rest.strictGates === true })) console.log(line);
  }
  if (rest.skipGates === true) console.warn("已跳过资产门禁(--skip-gates):输入未经质量检查即登记");
  if (report.gateReportPath !== null) {
    console.log(`体检报告已写入 ${relative(process.cwd(), report.gateReportPath) || report.gateReportPath}`);
  }
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  const outLabel = relative(process.cwd(), report.outPath) || report.outPath;
  const summary = `${report.addedIds.length} added, ${report.updatedIds.length} updated, ${report.document.items.length} total`;
  if (report.written) {
    console.log(`Wrote ${outLabel}: ${summary}`);
  } else if (rest.dryRun === true) {
    process.stdout.write(report.serialized);
    console.error(`Dry run; ${outLabel} not written (${summary})`);
  } else {
    console.error(`${outLabel} not written: no inputs passed the quality gates`);
  }
  if (report.blockedFiles.length > 0) {
    const blockedNames = report.blockedFiles.map((filePath) => basename(filePath)).join(", ");
    console.error(`${report.blockedFiles.length} 个文件未通过资产门禁,已跳过登记:${blockedNames}`);
    process.exitCode = 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
