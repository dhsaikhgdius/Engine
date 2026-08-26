import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import {
  applyDirectorAuthoringActions,
  directorWorkbenchOperationSchema,
  type DirectorAuthoringAction,
  type DirectorWorkbenchOperation,
} from "@director/agent-engine";
import type { DirectorProject } from "@director/project-schema";
import {
  DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS,
  DIRECTOR_CAMERA_OPTICS_LIMITS,
  DIRECTOR_CAMERA_SENSOR_FORMAT_OPTIONS,
  DIRECTOR_PROJECT_REVISION_PATTERN,
  directorProjectSchema,
  getDirectorProjectRevision,
  getFocalLengthFromVerticalFov,
} from "@director/project-schema";
import {
  DIRECTOR_ENGINE_SCENE_IMPORT_PLAN_CONTRACT,
  directorEngineSceneImportPlanSchema,
  directorEngineSceneImportSelectionSchema,
  directorEngineSceneManifestSchema,
  directorEngineSceneProviderSchema,
  type DirectorEngineSceneCamera,
  type DirectorEngineSceneImportPlanV1,
  type DirectorEngineSceneImportSelection,
  type DirectorEngineSceneLight,
  type DirectorEngineSceneManifestV1,
  type DirectorEngineSceneProvider,
} from "@director/dcc-protocol";
import { writeJsonAtomic } from "../atomicJsonFile";
import type { DirectorDccAuthoringResponse } from "./blenderReturnImport";
import { discoverDccRuntimeExecutable } from "./dccProviderRegistry";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_WORKBENCH_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_PACKAGE_CACHE_ENTRIES = 32;
const MAX_APPLY_LEDGER_BYTES = MAX_WORKBENCH_PROJECT_BYTES + 4 * 1024 * 1024;
const DIRECTOR_ENGINE_SCENE_APPLY_LEDGER_CONTRACT = "director-engine-scene-apply-ledger-v1" as const;

const copiedAssetSchema = z.strictObject({
  assetId: z.string().trim().min(1).max(240),
  url: z.string().trim().min(1).max(2_048),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const applyIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/);

const successfulAuthoringResponseSchema = z.looseObject({
  success: z.literal(true),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const engineSceneApplyLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    contract: z.literal(DIRECTOR_ENGINE_SCENE_APPLY_LEDGER_CONTRACT),
    planId: z.string().trim().min(1).max(1_024),
    expectedRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    idempotencyKey: applyIdempotencyKeySchema,
    intentHash: z.string().regex(/^[0-9a-f]{64}$/),
    plan: directorEngineSceneImportPlanSchema,
    operation: directorWorkbenchOperationSchema,
    copiedAssets: z.array(copiedAssetSchema),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    authoring: successfulAuthoringResponseSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.operation.op !== "replace_project") {
      context.addIssue({ code: "custom", path: ["operation", "op"], message: "apply intent must replace_project" });
      return;
    }
    if (value.operation.expected_revision !== value.expectedRevision) {
      context.addIssue({
        code: "custom",
        path: ["operation", "expected_revision"],
        message: "apply intent revision does not match its ledger identity",
      });
    }
    if (value.operation.idempotency_key !== value.idempotencyKey) {
      context.addIssue({
        code: "custom",
        path: ["operation", "idempotency_key"],
        message: "apply intent key does not match its ledger identity",
      });
    }
    if ((value.authoring === undefined) !== (value.completedAt === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["authoring"],
        message: "completedAt and authoring must be persisted together",
      });
    }
  });

type EngineSceneApplyLedger = z.infer<typeof engineSceneApplyLedgerSchema>;

/**
 * Machine-readable error codes for engine scene import failures.
 * Each code maps to a human-readable recovery hint in the `RECOVERY` table.
 */
export type DirectorEngineSceneImportErrorCode =
  | "engine_unavailable"
  | "project_invalid"
  | "upload_invalid"
  | "upload_too_large"
  | "package_invalid"
  | "path_escape"
  | "plan_not_found"
  | "idempotency_key_conflict"
  | "stale_project_revision"
  | "conflict_unresolved"
  | "browser_target_unavailable"
  | "authoring_failed";

const RECOVERY: Record<DirectorEngineSceneImportErrorCode, string> = {
  engine_unavailable:
    "Install the engine or set DIRECTOR_UNREAL_EDITOR_BIN / DIRECTOR_UNITY_BIN, or export the scene package inside the engine and upload the .zip instead.",
  project_invalid: "Point project_dir at a readable engine project inside the workspace, then retry.",
  upload_invalid: "Choose a .zip engine scene package produced by the Director exporter and retry.",
  upload_too_large: "Reduce the engine scene package below 512 MiB, then retry.",
  package_invalid: "Re-export the scene with the Director engine exporter so hashes and manifest are regenerated.",
  path_escape: "Use only the plan and package identifiers returned by Director.",
  plan_not_found: "Upload or preview the engine scene again before applying it.",
  idempotency_key_conflict: "Use the original plan and revision for this key, or use a new key for a new intent.",
  stale_project_revision: "Preview the engine import again against the current Director project.",
  conflict_unresolved: "Resolve the listed ID or selection conflicts, rebuild the plan, then apply it.",
  browser_target_unavailable: "Open the target Director Stage and retry against the same browser target.",
  authoring_failed: "Inspect the authoring error, preview the import again, and retry after resolving it.",
};

/**
 * An error thrown when an engine scene import fails a validation, conflict,
 * or authoring check. Carries a machine-readable code, an HTTP status, and
 * a human-readable recovery hint.
 */
export class DirectorEngineSceneImportError extends Error {
  /** Machine-readable error code. */
  readonly code: DirectorEngineSceneImportErrorCode;
  /** Human-readable recovery hint. */
  readonly recovery: string;
  /** HTTP status code that best represents this error. */
  readonly status: number;

  constructor(code: DirectorEngineSceneImportErrorCode, message: string, status = 400) {
    super(message);
    this.name = "DirectorEngineSceneImportError";
    this.code = code;
    this.recovery = RECOVERY[code];
    this.status = status;
  }
}

/** A validated engine scene import package ready for plan construction. */
export interface ValidatedDirectorEngineScenePackage {
  /** The engine provider that produced the package. */
  provider: DirectorEngineSceneProvider;
  /** Absolute path to the package directory. */
  packageDirectory: string;
  /** Relative path from the job root to the package directory. */
  packageDir: string;
  /** Absolute path to the verified manifest.json. */
  manifestPath: string;
  /** SHA-256 of the manifest file bytes. */
  manifestHash: string;
  /** The parsed and validated manifest. */
  manifest: DirectorEngineSceneManifestV1;
  /** Map of relative paths to absolute, verified file paths (hash-checked). */
  files: Map<string, string>;
}

/** Input passed to the headless engine export subprocess. */
export interface EngineSceneExtractionInput {
  /** The engine provider to run. */
  provider: DirectorEngineSceneProvider;
  /** Absolute path to the engine executable. */
  executable: string;
  /** Absolute path to the engine project directory. */
  projectDirectory: string;
  /** Optional scene / level identifier inside the project. */
  scene?: string;
  /** Directory where the exported package is written. */
  outputDirectory: string;
  /** The job directory used as the process working directory. */
  jobDirectory: string;
  /** Milliseconds before the engine process is killed. */
  timeoutMs: number;
}

/** The result of a successful engine scene package ingestion. */
export interface EngineSceneImportUploadResult {
  /** Unique job identifier. */
  jobId: string;
  /** The engine provider that produced the package. */
  provider: DirectorEngineSceneProvider;
  /** Relative path to the extracted package directory. */
  packagePath: string;
  /** SHA-256 of the uploaded package archive (upload path only). */
  archiveSha256: string | null;
  /** The parsed and validated manifest. */
  manifest: DirectorEngineSceneManifestV1;
  /** The initial import plan built from the ingested scene. */
  plan: DirectorEngineSceneImportPlanV1;
}

/**
 * An engine scene importer ingests director-engine-scene-v1 packages exported
 * from Unreal Engine or Unity — either as uploaded .zip archives (portable,
 * headless-verifiable path) or by running the installed engine headlessly
 * against a local project (native path) — validates them, builds import
 * plans, and applies them through the Director authoring surface.
 */
export interface EngineSceneImporter {
  /** Ingest a .zip package upload, extract it, and return an initial plan. */
  ingestUpload(
    provider: DirectorEngineSceneProvider,
    fileName: string,
    source: AsyncIterable<Uint8Array>,
    project: DirectorProject,
    declaredBytes?: number,
  ): Promise<EngineSceneImportUploadResult>;
  /** Run the installed engine headlessly against a local project to export and ingest a package. */
  ingestProject(
    provider: DirectorEngineSceneProvider,
    projectDir: string,
    project: DirectorProject,
    scene?: string,
  ): Promise<EngineSceneImportUploadResult>;
  /** Validate an extracted package directory and hash-check every file. */
  validatePackage(
    provider: DirectorEngineSceneProvider,
    packageDir: string,
  ): Promise<ValidatedDirectorEngineScenePackage>;
  /** Build an import plan from a validated package and live project. */
  buildImportPlan(
    provider: DirectorEngineSceneProvider,
    packageDir: string,
    project: DirectorProject,
    selection?: DirectorEngineSceneImportSelection,
  ): Promise<DirectorEngineSceneImportPlanV1>;
  /** Apply a validated import plan, copying assets and issuing authoring actions. */
  applyImportPlan(
    planId: string,
    project: DirectorProject,
    expectedRevision: string,
    idempotencyKey: string,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ): Promise<{
    plan: DirectorEngineSceneImportPlanV1;
    authoring: DirectorDccAuthoringResponse | null;
    copiedAssets: Array<{ assetId: string; url: string; hash: string }>;
  }>;
}

/** Configuration for creating an engine scene importer. */
export interface CreateEngineSceneImporterOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
  /** Optional environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Maximum time in milliseconds before a headless engine export is killed. */
  timeoutMs?: number;
  /** Maximum allowed byte size for uploaded .zip packages. */
  maxUploadBytes?: number;
  /** Maximum allowed total byte size for extracted package assets. */
  maxExtractedBytes?: number;
  /** Optional override for the headless engine export subprocess (used by tests). */
  runEngineExport?: (input: EngineSceneExtractionInput) => Promise<void>;
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function posixRelative(parent: string, child: string): string {
  return relative(parent, child).split(sep).join("/");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function safeSegment(value: string, fallback = "engine-scene"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function isSafeZipEntryName(name: string): boolean {
  if (!name || name.length > 1_024) return false;
  if (name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || name.includes("\0")) return false;
  return name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasZipSignature(header: Uint8Array): boolean {
  return header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
}

async function writeUpload(
  source: AsyncIterable<Uint8Array>,
  temporaryPath: string,
  maximumBytes: number,
): Promise<{ hash: string; size: number; header: Uint8Array }> {
  const file = await open(temporaryPath, "wx", 0o600);
  const digest = createHash("sha256");
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let size = 0;
  try {
    for await (const value of source) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maximumBytes) {
        throw new DirectorEngineSceneImportError(
          "upload_too_large",
          `Engine scene package exceeds the ${maximumBytes} byte upload limit.`,
          413,
        );
      }
      if (headerBytes < header.length) {
        const copyLength = Math.min(header.length - headerBytes, chunk.length);
        chunk.copy(header, headerBytes, 0, copyLength);
        headerBytes += copyLength;
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten <= 0) throw new Error("Engine package upload write made no forward progress.");
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
  if (size <= 0 || !hasZipSignature(header.subarray(0, headerBytes))) {
    throw new DirectorEngineSceneImportError("upload_invalid", "Upload is not a recognized .zip engine scene package.");
  }
  return { hash: digest.digest("hex"), size, header: header.subarray(0, headerBytes) };
}

function closestSensorFormat(width: number, height: number) {
  return DIRECTOR_CAMERA_SENSOR_FORMAT_OPTIONS.reduce((best, candidate) => {
    const candidateError =
      Math.abs(candidate.width - width) / Math.max(width, 1) +
      Math.abs(candidate.height - height) / Math.max(height, 1);
    const bestError =
      Math.abs(best.width - width) / Math.max(width, 1) + Math.abs(best.height - height) / Math.max(height, 1);
    return candidateError < bestError ? candidate : best;
  }).id;
}

function closestAspectRatio(ratio: number) {
  return DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS.reduce((best, candidate) =>
    Math.abs(candidate.value - ratio) < Math.abs(best.value - ratio) ? candidate : best,
  ).id;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function existingDirectorIds(project: DirectorProject): Set<string> {
  return new Set([
    ...project.assets.map((item) => item.id),
    ...project.objects.map((item) => item.id),
    ...project.cameras.map((item) => item.id),
    ...(project.lights?.map((item) => item.id) ?? []),
    ...(project.storyboard?.shots.map((item) => item.id) ?? []),
    ...(project.production?.takes.flatMap((take) => [take.id, ...take.entityTracks.map((track) => track.id)]) ?? []),
    ...(project.production?.sequences.flatMap((sequence) => [sequence.id, ...sequence.shots.map((shot) => shot.id)]) ??
      []),
  ]);
}

function cameraOperation(
  camera: DirectorEngineSceneCamera,
  packageKey: string,
): Extract<DirectorEngineSceneImportPlanV1["operations"][number], { op: "create_camera" }> {
  const key = sha256(`${packageKey}\0camera\0${camera.sourceId}`).slice(0, 14);
  const sensorFormat =
    camera.sensorWidthMm !== undefined && camera.sensorHeightMm !== undefined
      ? closestSensorFormat(camera.sensorWidthMm, camera.sensorHeightMm)
      : "super35";
  const aspectRatio = closestAspectRatio(camera.renderAspectRatio);
  const focalLengthMm = getFocalLengthFromVerticalFov(camera.verticalFovDegrees, aspectRatio, sensorFormat);
  const nearClipM = clamp(
    camera.nearClipM,
    DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM.min,
    DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM.max,
  );
  const farClipM = Math.max(
    clamp(camera.farClipM, DIRECTOR_CAMERA_OPTICS_LIMITS.farClipM.min, DIRECTOR_CAMERA_OPTICS_LIMITS.farClipM.max),
    nearClipM + DIRECTOR_CAMERA_OPTICS_LIMITS.nearClipM.min,
  );
  const [px, py, pz] = camera.position;
  const [tx, ty, tz] = camera.lookTarget;
  const targetDistance = Math.hypot(tx - px, ty - py, tz - pz);
  return {
    op: "create_camera",
    sourceId: camera.sourceId,
    cameraId: `engine-camera-${key}`,
    objectId: `engine-camera-rig-${key}`,
    name: camera.name,
    position: [px, py, pz],
    target: [tx, ty, tz],
    focalLengthMm: clamp(focalLengthMm, 12, 200),
    sensorFormat,
    apertureFStop: clamp(camera.apertureFStop ?? 2.8, 0.7, 64),
    focusDistanceM: clamp(camera.focusDistanceM ?? targetDistance, 0.01, 10_000),
    nearClipM,
    farClipM,
    aspectRatio,
  };
}

function lightOperation(
  light: DirectorEngineSceneLight,
  packageKey: string,
): Extract<DirectorEngineSceneImportPlanV1["operations"][number], { op: "create_light" }> {
  const key = sha256(`${packageKey}\0light\0${light.sourceId}`).slice(0, 14);
  return {
    op: "create_light",
    sourceId: light.sourceId,
    lightId: `engine-light-${key}`,
    name: light.name,
    type: light.type,
    color: light.color.toLowerCase(),
    intensity: clamp(light.intensity, 0, 100),
    ...(light.position ? { position: light.position } : {}),
    ...(light.target ? { target: light.target } : {}),
    ...(light.rangeM !== undefined ? { distance: clamp(light.rangeM, 0, 1_000_000) } : {}),
    ...(light.angleDegrees !== undefined
      ? { angle: clamp((light.angleDegrees * Math.PI) / 180 / 2, 0.001, Math.PI / 2) }
      : {}),
    ...(light.penumbra !== undefined ? { penumbra: clamp(light.penumbra, 0, 1) } : {}),
    ...(light.widthM !== undefined ? { width: light.widthM } : {}),
    ...(light.heightM !== undefined ? { height: light.heightM } : {}),
    ...(light.castShadow !== undefined ? { castShadow: light.castShadow } : {}),
  };
}

async function findUnrealProjectFile(projectDirectory: string): Promise<string> {
  const entries = await readdir(projectDirectory, { withFileTypes: true }).catch(() => null);
  const projects = (entries ?? [])
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uproject"))
    .map((entry) => resolve(projectDirectory, entry.name));
  if (projects.length !== 1) {
    throw new DirectorEngineSceneImportError(
      "project_invalid",
      projects.length === 0
        ? `No .uproject file was found in ${projectDirectory}.`
        : `Multiple .uproject files were found in ${projectDirectory}; keep exactly one.`,
    );
  }
  return projects[0]!;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_PROCESS_OUTPUT ? combined : combined.slice(combined.length - MAX_PROCESS_OUTPUT);
}

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveProcess, rejectProcess) => {
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, detached });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killProcessTree = (signal: NodeJS.Signals) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when the process group is already gone.
        }
      }
      child.kill(signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree("SIGTERM");
      forceKillTimer = setTimeout(() => killProcessTree("SIGKILL"), 2_000);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (!settled) {
        settled = true;
        rejectProcess(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      settled = true;
      if (timedOut) rejectProcess(new Error(`Engine scene export exceeded ${timeoutMs} ms.`));
      else if (code === 0) resolveProcess({ stdout, stderr });
      else rejectProcess(new Error(`Engine scene export exited with code ${code ?? "unknown"}. ${stderr || stdout}`));
    });
  });
}

/**
 * Creates an engine scene importer that ingests director-engine-scene-v1
 * packages from Unreal Engine and Unity, validates them, builds import plans,
 * and applies them through the Director authoring surface.
 *
 * Uploaded .zip packages are the portable, headless-verifiable path and work
 * without any engine installed. When the engine executable is discoverable
 * (DIRECTOR_UNREAL_EDITOR_BIN / DIRECTOR_UNITY_BIN, well-known paths, or
 * PATH), `ingestProject` can additionally run the engine headlessly against a
 * local project to produce the same package.
 *
 * @param options - Workspace, data directory, and budget overrides.
 * @returns An importer with ingest, validate, build, and apply methods.
 */
export function createEngineSceneImporter(options: CreateEngineSceneImporterOptions): EngineSceneImporter {
  const workspaceRoot = resolve(options.workspaceRoot);
  const environment = options.environment ?? process.env;
  const jobRoot = resolve(options.dataDirectory, "dcc-jobs", "engine-import");
  const applyLedgerRoot = resolve(options.dataDirectory, "dcc-ledgers", "engine-scene-import");
  const generatedImportRoot = resolve(workspaceRoot, "assets", "generated", "dcc-import");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const maximumExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_PACKAGE_BYTES;
  const previewPackageCache = new Map<string, ValidatedDirectorEngineScenePackage>();
  const applyLocks = new Map<string, Promise<void>>();
  let ingestionActive = false;
  const ingestionQueue: Array<() => void> = [];

  async function acquireIngestionSlot(): Promise<() => void> {
    if (ingestionActive) await new Promise<void>((resolveWaiter) => ingestionQueue.push(resolveWaiter));
    ingestionActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = ingestionQueue.shift();
      if (next) next();
      else ingestionActive = false;
    };
  }

  function applyIntentHash(
    value: Pick<
      EngineSceneApplyLedger,
      "planId" | "expectedRevision" | "idempotencyKey" | "plan" | "operation" | "copiedAssets"
    >,
  ): string {
    return sha256(
      JSON.stringify([
        value.planId,
        value.expectedRevision,
        value.idempotencyKey,
        value.plan,
        value.operation,
        value.copiedAssets,
      ]),
    );
  }

  function applyLedgerPath(idempotencyKey: string): string {
    return resolve(applyLedgerRoot, `${sha256(idempotencyKey)}.json`);
  }

  async function withApplyLock<T>(idempotencyKey: string, action: () => Promise<T>): Promise<T> {
    const previous = applyLocks.get(idempotencyKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    applyLocks.set(idempotencyKey, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (applyLocks.get(idempotencyKey) === queued) applyLocks.delete(idempotencyKey);
    }
  }

  async function loadApplyLedger(idempotencyKey: string): Promise<EngineSceneApplyLedger | null> {
    const path = applyLedgerPath(idempotencyKey);
    const fileStat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!fileStat) return null;
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      fileStat.size <= 0 ||
      fileStat.size > MAX_APPLY_LEDGER_BYTES
    ) {
      throw new DirectorEngineSceneImportError("package_invalid", "Stored engine apply ledger is not a safe file.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      throw new DirectorEngineSceneImportError("package_invalid", "Stored engine apply ledger is not valid JSON.");
    }
    const parsed = engineSceneApplyLedgerSchema.safeParse(payload);
    if (!parsed.success || parsed.data.intentHash !== applyIntentHash(parsed.data)) {
      throw new DirectorEngineSceneImportError("package_invalid", "Stored engine apply ledger failed validation.");
    }
    return parsed.data;
  }

  async function persistApplyLedger(value: EngineSceneApplyLedger): Promise<EngineSceneApplyLedger> {
    const parsed = engineSceneApplyLedgerSchema.safeParse(value);
    if (!parsed.success || parsed.data.intentHash !== applyIntentHash(parsed.data)) {
      throw new DirectorEngineSceneImportError("authoring_failed", "Engine apply intent could not be validated.", 500);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(parsed.data);
    } catch {
      throw new DirectorEngineSceneImportError("authoring_failed", "Engine apply receipt is not JSON-safe.", 500);
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_APPLY_LEDGER_BYTES) {
      throw new DirectorEngineSceneImportError("authoring_failed", "Engine apply ledger exceeds its safe size.", 413);
    }
    await mkdir(applyLedgerRoot, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(applyLedgerPath(value.idempotencyKey), parsed.data);
    await chmod(applyLedgerPath(value.idempotencyKey), 0o600).catch(() => undefined);
    return parsed.data;
  }

  function assertApplyLedgerIdentity(
    ledger: EngineSceneApplyLedger,
    planId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): void {
    if (
      ledger.planId !== planId ||
      ledger.expectedRevision !== expectedRevision ||
      ledger.idempotencyKey !== idempotencyKey
    ) {
      throw new DirectorEngineSceneImportError(
        "idempotency_key_conflict",
        `Idempotency key "${idempotencyKey}" already belongs to a different engine import intent.`,
        409,
      );
    }
  }

  async function executeApplyLedger(
    ledger: EngineSceneApplyLedger,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ) {
    if (ledger.authoring) {
      return { plan: ledger.plan, authoring: ledger.authoring, copiedAssets: ledger.copiedAssets };
    }
    const authoring = await applyAuthoring(ledger.operation);
    if (!authoring) {
      throw new DirectorEngineSceneImportError(
        "browser_target_unavailable",
        "No live Director browser accepted the import.",
        503,
      );
    }
    if (!authoring.success) {
      throw new DirectorEngineSceneImportError(
        "authoring_failed",
        authoring.error ?? "Director rejected the engine scene import.",
        409,
      );
    }
    const completed = await persistApplyLedger({
      ...ledger,
      completedAt: new Date().toISOString(),
      authoring: successfulAuthoringResponseSchema.parse(authoring),
    });
    return { plan: completed.plan, authoring: completed.authoring!, copiedAssets: completed.copiedAssets };
  }

  async function resolvePackageDirectory(input: string): Promise<{ absolute: string; relative: string }> {
    const trimmed = input.trim();
    const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(jobRoot, trimmed);
    if (!isInside(jobRoot, candidate)) {
      throw new DirectorEngineSceneImportError("path_escape", `Engine import package escaped ${jobRoot}.`, 403);
    }
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new DirectorEngineSceneImportError(
        "package_invalid",
        `Engine import package does not exist: ${trimmed}.`,
        404,
      );
    }
    const canonicalRoot = await realpath(jobRoot).catch(() => jobRoot);
    if (!isInside(canonicalRoot, canonical) || !(await stat(canonical)).isDirectory()) {
      throw new DirectorEngineSceneImportError("path_escape", "Engine import package escaped its job root.", 403);
    }
    return { absolute: canonical, relative: posixRelative(canonicalRoot, canonical) };
  }

  async function validatePackage(
    provider: DirectorEngineSceneProvider,
    packageDir: string,
  ): Promise<ValidatedDirectorEngineScenePackage> {
    const parsedProvider = directorEngineSceneProviderSchema.parse(provider);
    const directory = await resolvePackageDirectory(packageDir);
    const manifestPath = resolve(directory.absolute, "manifest.json");
    const canonicalManifest = await realpath(manifestPath).catch(() => null);
    if (!canonicalManifest || !isInside(directory.absolute, canonicalManifest)) {
      throw new DirectorEngineSceneImportError("package_invalid", "Engine scene package is missing manifest.json.");
    }
    const manifestStat = await stat(canonicalManifest);
    if (!manifestStat.isFile() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new DirectorEngineSceneImportError(
        "package_invalid",
        `Engine scene manifest must be a non-empty file no larger than ${MAX_MANIFEST_BYTES} bytes.`,
      );
    }
    const manifestBytes = await readFile(canonicalManifest);
    let unknownManifest: unknown;
    try {
      unknownManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    } catch {
      throw new DirectorEngineSceneImportError("package_invalid", "Engine scene manifest is not valid JSON.");
    }
    const parsed = directorEngineSceneManifestSchema.safeParse(unknownManifest);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DirectorEngineSceneImportError(
        "package_invalid",
        `Invalid engine scene manifest at ${issue?.path.join(".") || "manifest"}: ${issue?.message ?? "invalid value"}.`,
      );
    }
    if (parsed.data.provider !== parsedProvider) {
      throw new DirectorEngineSceneImportError(
        "package_invalid",
        `Engine scene package was produced by ${parsed.data.provider}, not ${parsedProvider}.`,
        409,
      );
    }
    const files = new Map<string, string>();
    let extractedBytes = 0;
    for (const [relativePath, expectedHash] of Object.entries(parsed.data.fileHashes)) {
      const candidate = resolve(directory.absolute, relativePath);
      if (!isInside(directory.absolute, candidate)) {
        throw new DirectorEngineSceneImportError(
          "path_escape",
          `Manifest file escaped package root: ${relativePath}.`,
          403,
        );
      }
      const canonical = await realpath(candidate).catch(() => null);
      const fileStat = canonical ? await stat(canonical).catch(() => null) : null;
      if (!canonical || !isInside(directory.absolute, canonical) || !fileStat?.isFile()) {
        throw new DirectorEngineSceneImportError("package_invalid", `Manifest file is missing: ${relativePath}.`);
      }
      extractedBytes += fileStat.size;
      if (fileStat.size <= 0 || extractedBytes > maximumExtractedBytes) {
        throw new DirectorEngineSceneImportError(
          "package_invalid",
          `Engine package assets must be non-empty and total no more than ${maximumExtractedBytes} bytes.`,
          413,
        );
      }
      if ((await sha256File(canonical)) !== expectedHash) {
        throw new DirectorEngineSceneImportError("package_invalid", `SHA-256 mismatch for ${relativePath}.`);
      }
      files.set(relativePath, canonical);
    }
    return {
      provider: parsedProvider,
      packageDirectory: directory.absolute,
      packageDir: directory.relative,
      manifestPath: canonicalManifest,
      manifestHash: sha256(manifestBytes),
      manifest: parsed.data,
      files,
    };
  }

  function buildPlan(
    validated: ValidatedDirectorEngineScenePackage,
    project: DirectorProject,
    selectionInput?: DirectorEngineSceneImportSelection,
  ): DirectorEngineSceneImportPlanV1 {
    const manifest = validated.manifest;
    const selection = directorEngineSceneImportSelectionSchema.parse(
      selectionInput ?? {
        includeScene: Boolean(manifest.scene.bundleFile),
        cameraSourceIds: manifest.cameras.map((item) => item.sourceId),
        lightSourceIds: manifest.lights.map((item) => item.sourceId),
      },
    );
    const selectedCameraIds = new Set(selection.cameraSourceIds);
    const selectedLightIds = new Set(selection.lightSourceIds);
    const knownCameraIds = new Set(manifest.cameras.map((item) => item.sourceId));
    const knownLightIds = new Set(manifest.lights.map((item) => item.sourceId));
    const operations: DirectorEngineSceneImportPlanV1["operations"] = [];
    const conflicts: DirectorEngineSceneImportPlanV1["conflicts"] = [];
    const warnings = [
      ...manifest.warnings,
      ...manifest.unsupported.map((item) => `${item.kind} ${item.name}: ${item.reason}`),
    ];
    const packageKey = sha256(`${manifest.provider}\0${manifest.packageId}\0${validated.manifestHash}`).slice(0, 20);
    const assetId = `engine-scene-asset-${packageKey}`;
    const objectId = `engine-scene-object-${packageKey}`;
    const existing = existingDirectorIds(project);

    for (const sourceId of selection.cameraSourceIds) {
      if (!knownCameraIds.has(sourceId)) {
        conflicts.push({
          sourceId,
          code: "unsupported_scene",
          reason: `Camera ${sourceId} is not present in the validated engine scene package.`,
        });
      }
    }
    for (const sourceId of selection.lightSourceIds) {
      if (!knownLightIds.has(sourceId)) {
        conflicts.push({
          sourceId,
          code: "unsupported_scene",
          reason: `Light ${sourceId} is not present in the validated engine scene package.`,
        });
      }
    }
    if (!selection.includeScene && selection.cameraSourceIds.length === 0 && selection.lightSourceIds.length === 0) {
      conflicts.push({
        sourceId: "selection",
        code: "empty_selection",
        reason: "Select the scene, at least one camera, or at least one light.",
      });
    }
    if (selection.includeScene) {
      if (!manifest.scene.bundleFile) {
        conflicts.push({
          sourceId: "scene",
          code: "unsupported_scene",
          reason: "The engine scene contains no renderable geometry bundle.",
        });
      } else {
        const bundleHash = manifest.fileHashes[manifest.scene.bundleFile]!;
        operations.push({
          op: "create_scene_asset",
          assetId,
          label: manifest.scene.name,
          glbPath: manifest.scene.bundleFile,
          hash: bundleHash,
        });
        operations.push({
          op: "create_scene_object",
          objectId,
          name: manifest.scene.name,
          assetId,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        });
        for (const id of [assetId, objectId]) {
          if (existing.has(id)) {
            conflicts.push({ sourceId: "scene", code: "id_collision", reason: `Director ID ${id} already exists.` });
          }
        }
      }
    }
    for (const camera of manifest.cameras) {
      if (!selectedCameraIds.has(camera.sourceId)) continue;
      const operation = cameraOperation(camera, packageKey);
      operations.push(operation);
      for (const id of [operation.cameraId, operation.objectId]) {
        if (existing.has(id)) {
          conflicts.push({
            sourceId: camera.sourceId,
            code: "id_collision",
            reason: `Director ID ${id} already exists.`,
          });
        }
      }
      if (operation.focalLengthMm === 12 || operation.focalLengthMm === 200) {
        warnings.push(`Camera ${camera.name} focal length was clamped to Director's 12–200 mm range.`);
      }
    }
    for (const light of manifest.lights) {
      if (!selectedLightIds.has(light.sourceId)) continue;
      const operation = lightOperation(light, packageKey);
      operations.push(operation);
      if (existing.has(operation.lightId)) {
        conflicts.push({
          sourceId: light.sourceId,
          code: "id_collision",
          reason: `Director ID ${operation.lightId} already exists.`,
        });
      }
    }
    if (manifest.scene.animationClipCount > 0) {
      warnings.push(
        `${manifest.scene.animationClipCount} animation clip(s) remain embedded in the GLB; Director v1 imports the scene at the exported frame and does not map them onto its editable timeline.`,
      );
    }
    if (manifest.scene.skinnedMeshCount > 0) {
      warnings.push(
        `${manifest.scene.skinnedMeshCount} skinned mesh(es) keep their skeletons inside the GLB bundle; Director does not rebind them to its character rig system on import.`,
      );
    }
    if (selection.cameraSourceIds.length) {
      warnings.push("Engine camera roll is not represented by Director's target-based camera model.");
    }
    const selectionHash = sha256(JSON.stringify(selection)).slice(0, 16);
    const jobId = validated.packageDir.split("/")[0]!;
    return directorEngineSceneImportPlanSchema.parse({
      contract: DIRECTOR_ENGINE_SCENE_IMPORT_PLAN_CONTRACT,
      planId: `${jobId}/plans/${selectionHash}.json`,
      ready: conflicts.length === 0,
      provider: manifest.provider,
      packageId: manifest.packageId,
      packageDir: validated.packageDir,
      manifestHash: validated.manifestHash,
      targetRevision: getDirectorProjectRevision(project),
      selection,
      operations,
      conflicts,
      warnings,
    });
  }

  async function persistPlan(plan: DirectorEngineSceneImportPlanV1): Promise<void> {
    const path = resolve(jobRoot, plan.planId);
    if (!isInside(jobRoot, path))
      throw new DirectorEngineSceneImportError("path_escape", "Plan ID escaped its job root.", 403);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path, plan);
    await chmod(path, 0o600).catch(() => undefined);
  }

  // Bounded LRU so a long-lived gateway cannot grow the preview cache without
  // limit under sustained ingestion load; evicted entries simply re-validate.
  function rememberPreviewPackage(validated: ValidatedDirectorEngineScenePackage): void {
    previewPackageCache.delete(validated.packageDir);
    previewPackageCache.set(validated.packageDir, validated);
    while (previewPackageCache.size > MAX_PREVIEW_PACKAGE_CACHE_ENTRIES) {
      const oldest = previewPackageCache.keys().next().value;
      if (oldest === undefined) break;
      previewPackageCache.delete(oldest);
    }
  }

  async function validatePackageReusingPreview(
    provider: DirectorEngineSceneProvider,
    packageDir: string,
  ): Promise<ValidatedDirectorEngineScenePackage> {
    const directory = await resolvePackageDirectory(packageDir);
    const cached = previewPackageCache.get(directory.relative);
    if (cached && cached.provider === provider) {
      const manifestHash = await sha256File(cached.manifestPath).catch(() => null);
      if (manifestHash === cached.manifestHash) {
        rememberPreviewPackage(cached);
        return cached;
      }
      previewPackageCache.delete(directory.relative);
    }
    const validated = await validatePackage(provider, directory.relative);
    rememberPreviewPackage(validated);
    return validated;
  }

  async function buildImportPlan(
    provider: DirectorEngineSceneProvider,
    packageDir: string,
    project: DirectorProject,
    selection?: DirectorEngineSceneImportSelection,
  ): Promise<DirectorEngineSceneImportPlanV1> {
    const validated = await validatePackageReusingPreview(provider, packageDir);
    const plan = buildPlan(validated, project, selection);
    await persistPlan(plan);
    return plan;
  }

  async function extractZipPackage(zipPath: string, outputDirectory: string): Promise<void> {
    const bytes = await readFile(zipPath);
    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(bytes);
    } catch {
      throw new DirectorEngineSceneImportError("upload_invalid", "Engine scene package is not a readable zip file.");
    }
    const entries = Object.values(archive.files);
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new DirectorEngineSceneImportError(
        "upload_invalid",
        `Engine scene package contains ${entries.length} entries, exceeding the limit of ${MAX_ZIP_ENTRIES}.`,
        413,
      );
    }
    let extractedBytes = 0;
    for (const entry of entries) {
      if (entry.dir) continue;
      if (!isSafeZipEntryName(entry.name)) {
        throw new DirectorEngineSceneImportError(
          "upload_invalid",
          `Engine scene package entry has an unsafe path: ${entry.name.slice(0, 200)}.`,
        );
      }
      const destination = resolve(outputDirectory, entry.name);
      if (!isInside(outputDirectory, destination)) {
        throw new DirectorEngineSceneImportError("path_escape", "Engine scene package entry escaped its root.", 403);
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      // Stream the inflation so a decompression bomb is rejected as soon as
      // the cumulative budget is crossed, instead of first materializing an
      // arbitrarily large decompressed entry in memory.
      const budgetGuard = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          extractedBytes += chunk.byteLength;
          if (extractedBytes > maximumExtractedBytes) {
            callback(
              new DirectorEngineSceneImportError(
                "upload_too_large",
                `Engine scene package expands beyond the ${maximumExtractedBytes} byte extraction budget.`,
                413,
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          entry.nodeStream("nodebuffer"),
          budgetGuard,
          createWriteStream(destination, { flags: "wx", mode: 0o600 }),
        );
      } catch (error) {
        if (error instanceof DirectorEngineSceneImportError) throw error;
        throw new DirectorEngineSceneImportError(
          "upload_invalid",
          `Engine scene package entry could not be extracted: ${entry.name.slice(0, 200)}.`,
        );
      }
    }
  }

  async function finishIngestion(
    jobId: string,
    provider: DirectorEngineSceneProvider,
    archiveSha256: string | null,
    project: DirectorProject,
  ): Promise<EngineSceneImportUploadResult> {
    const validated = await validatePackage(provider, `${jobId}/package`);
    rememberPreviewPackage(validated);
    const plan = buildPlan(validated, project);
    await persistPlan(plan);
    return { jobId, provider, packagePath: validated.packageDir, archiveSha256, manifest: validated.manifest, plan };
  }

  async function ingestUpload(
    provider: DirectorEngineSceneProvider,
    fileName: string,
    source: AsyncIterable<Uint8Array>,
    project: DirectorProject,
    declaredBytes?: number,
  ): Promise<EngineSceneImportUploadResult> {
    const parsedProvider = directorEngineSceneProviderSchema.parse(provider);
    const normalizedName = fileName.trim();
    if (!normalizedName.toLowerCase().endsWith(".zip") || normalizedName.includes("\0")) {
      throw new DirectorEngineSceneImportError("upload_invalid", "Engine scene package filename must end in .zip.");
    }
    if (
      declaredBytes !== undefined &&
      (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > maximumBytes)
    ) {
      throw new DirectorEngineSceneImportError(
        declaredBytes > maximumBytes ? "upload_too_large" : "upload_invalid",
        `Invalid engine scene package Content-Length ${String(declaredBytes)}.`,
        declaredBytes > maximumBytes ? 413 : 400,
      );
    }
    const jobId = `${parsedProvider}-${randomUUID()}`;
    const jobDirectory = resolve(jobRoot, jobId);
    const temporaryPath = resolve(jobDirectory, "source.zip.partial");
    const sourcePath = resolve(jobDirectory, "source.zip");
    const outputDirectory = resolve(jobDirectory, "package");
    const releaseIngestionSlot = await acquireIngestionSlot();
    try {
      await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
      await chmod(jobDirectory, 0o700).catch(() => undefined);
      const uploaded = await writeUpload(source, temporaryPath, maximumBytes);
      if (declaredBytes !== undefined && uploaded.size !== declaredBytes) {
        throw new DirectorEngineSceneImportError(
          "upload_invalid",
          `Engine package upload size ${uploaded.size} does not match Content-Length ${declaredBytes}.`,
        );
      }
      await rename(temporaryPath, sourcePath);
      await chmod(sourcePath, 0o600).catch(() => undefined);
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await extractZipPackage(sourcePath, outputDirectory);
      return await finishIngestion(jobId, parsedProvider, uploaded.hash, project);
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof DirectorEngineSceneImportError) throw error;
      throw new DirectorEngineSceneImportError(
        "package_invalid",
        `Director could not ingest ${safeSegment(normalizedName)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      releaseIngestionSlot();
    }
  }

  async function defaultRunEngineExport(input: EngineSceneExtractionInput): Promise<void> {
    if (input.provider === "unreal") {
      const projectFile = await findUnrealProjectFile(input.projectDirectory);
      const scriptPath = resolve(workspaceRoot, "integrations", "unreal", "interchange", "director_scene_export.py");
      await access(scriptPath);
      const scriptArguments = [
        scriptPath,
        "--output-dir",
        input.outputDirectory,
        ...(input.scene ? ["--scene", input.scene] : []),
      ]
        .map((value) => `"${value}"`)
        .join(" ");
      await runProcess(
        input.executable,
        [
          projectFile,
          "-run=pythonscript",
          `-script=${scriptArguments}`,
          "-unattended",
          "-nosplash",
          "-nullrhi",
          "-stdout",
        ],
        input.timeoutMs,
        input.jobDirectory,
      );
      return;
    }
    const connectorSource = resolve(workspaceRoot, "integrations", "unity", "interchange", "DirectorSceneExport.cs");
    await access(connectorSource);
    const connectorDestination = resolve(
      input.projectDirectory,
      "Assets",
      "Editor",
      "DirectorInterchange",
      "DirectorSceneExport.cs",
    );
    const [sourceHash, destinationHash] = await Promise.all([
      sha256File(connectorSource),
      sha256File(connectorDestination).catch(() => null),
    ]);
    if (sourceHash !== destinationHash) {
      await mkdir(dirname(connectorDestination), { recursive: true });
      await copyFile(connectorSource, connectorDestination);
    }
    await runProcess(
      input.executable,
      [
        "-batchmode",
        "-nographics",
        "-quit",
        "-projectPath",
        input.projectDirectory,
        "-executeMethod",
        "DirectorInterchange.DirectorSceneExport.ExportFromCommandLine",
        "-logFile",
        resolve(input.jobDirectory, "unity.log"),
        "-directorOutputDir",
        input.outputDirectory,
        ...(input.scene ? ["-directorScene", input.scene] : []),
      ],
      input.timeoutMs,
      input.jobDirectory,
    );
  }

  const runEngineExport = options.runEngineExport ?? defaultRunEngineExport;

  async function resolveEngineProjectDirectory(projectDir: string): Promise<string> {
    const trimmed = projectDir.trim();
    const configuredRoot = environment.DIRECTOR_ENGINE_PROJECT_ROOT?.trim();
    const roots = [workspaceRoot, ...(configuredRoot ? [resolve(configuredRoot)] : [])];
    const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot, trimmed);
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new DirectorEngineSceneImportError("project_invalid", `Engine project does not exist: ${trimmed}.`, 404);
    }
    const canonicalRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
    if (!canonicalRoots.some((root) => isInside(root, canonical))) {
      throw new DirectorEngineSceneImportError(
        "project_invalid",
        "Engine project must live inside the workspace or DIRECTOR_ENGINE_PROJECT_ROOT.",
        403,
      );
    }
    if (!(await stat(canonical)).isDirectory()) {
      throw new DirectorEngineSceneImportError("project_invalid", "Engine project path is not a directory.");
    }
    return canonical;
  }

  async function ingestProject(
    provider: DirectorEngineSceneProvider,
    projectDir: string,
    project: DirectorProject,
    scene?: string,
  ): Promise<EngineSceneImportUploadResult> {
    const parsedProvider = directorEngineSceneProviderSchema.parse(provider);
    const projectDirectory = await resolveEngineProjectDirectory(projectDir);
    const executable = await discoverDccRuntimeExecutable(parsedProvider, environment);
    if (!executable) {
      throw new DirectorEngineSceneImportError(
        "engine_unavailable",
        parsedProvider === "unreal"
          ? "Unreal Editor was not found. Set DIRECTOR_UNREAL_EDITOR_BIN or install Unreal Engine, or export the package inside the engine and upload the .zip."
          : "Unity was not found. Set DIRECTOR_UNITY_BIN or install Unity, or export the package inside the engine and upload the .zip.",
        503,
      );
    }
    const jobId = `${parsedProvider}-${randomUUID()}`;
    const jobDirectory = resolve(jobRoot, jobId);
    const outputDirectory = resolve(jobDirectory, "package");
    const releaseIngestionSlot = await acquireIngestionSlot();
    try {
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await runEngineExport({
        provider: parsedProvider,
        executable,
        projectDirectory,
        scene,
        outputDirectory,
        jobDirectory,
        timeoutMs,
      });
      return await finishIngestion(jobId, parsedProvider, null, project);
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof DirectorEngineSceneImportError) throw error;
      throw new DirectorEngineSceneImportError(
        "package_invalid",
        `Headless ${parsedProvider} export failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    } finally {
      releaseIngestionSlot();
    }
  }

  async function loadPlan(planId: string): Promise<DirectorEngineSceneImportPlanV1> {
    const candidate = resolve(jobRoot, planId);
    if (!isInside(jobRoot, candidate))
      throw new DirectorEngineSceneImportError("path_escape", "Plan ID escaped its job root.", 403);
    const canonical = await realpath(candidate).catch(() => null);
    const canonicalRoot = await realpath(jobRoot).catch(() => jobRoot);
    if (!canonical || !isInside(canonicalRoot, canonical)) {
      throw new DirectorEngineSceneImportError(
        "plan_not_found",
        `Engine scene import plan was not found: ${planId}.`,
        404,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(canonical, "utf8")) as unknown;
    } catch {
      throw new DirectorEngineSceneImportError("plan_not_found", "Engine scene import plan is not valid JSON.", 404);
    }
    const parsed = directorEngineSceneImportPlanSchema.safeParse(payload);
    if (!parsed.success || parsed.data.planId !== planId) {
      throw new DirectorEngineSceneImportError("package_invalid", "Stored engine import plan failed validation.");
    }
    return parsed.data;
  }

  async function applyImportPlan(
    planId: string,
    project: DirectorProject,
    expectedRevision: string,
    idempotencyKey: string,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ) {
    if (!applyIdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new DirectorEngineSceneImportError("authoring_failed", "Engine import idempotency key is invalid.");
    }
    return withApplyLock(idempotencyKey, async () => {
      const prior = await loadApplyLedger(idempotencyKey);
      if (prior) {
        assertApplyLedgerIdentity(prior, planId, expectedRevision, idempotencyKey);
        return executeApplyLedger(prior, applyAuthoring);
      }

      const stored = await loadPlan(planId);
      const currentRevision = getDirectorProjectRevision(project);
      if (expectedRevision !== currentRevision || stored.targetRevision !== currentRevision) {
        throw new DirectorEngineSceneImportError(
          "stale_project_revision",
          `Expected ${expectedRevision}, but the live project is ${currentRevision}.`,
          409,
        );
      }
      if (!stored.ready || stored.conflicts.length) {
        throw new DirectorEngineSceneImportError(
          "conflict_unresolved",
          "The engine scene import plan contains conflicts.",
          409,
        );
      }
      const validated = await validatePackageReusingPreview(stored.provider, stored.packageDir);
      if (validated.manifest.packageId !== stored.packageId || validated.manifestHash !== stored.manifestHash) {
        throw new DirectorEngineSceneImportError("package_invalid", "Engine scene package changed after preview.", 409);
      }
      // The stored plan pins identity (provider/packageId/manifestHash/targetRevision)
      // and the selection; the applied operations always come from a server-side
      // rebuild against the validated package and the live project.
      const plan = buildPlan(validated, project, stored.selection);
      if (!plan.ready || plan.conflicts.length) {
        throw new DirectorEngineSceneImportError(
          "conflict_unresolved",
          "Rebuilding the engine scene plan against the live project produced conflicts.",
          409,
        );
      }

      const copiedAssets: Array<{ assetId: string; url: string; hash: string }> = [];
      const copied = new Map<string, { fileName: string; url: string }>();
      for (const operation of plan.operations) {
        if (operation.op !== "create_scene_asset") continue;
        const sourcePath = validated.files.get(operation.glbPath);
        if (!sourcePath)
          throw new DirectorEngineSceneImportError("package_invalid", `Scene GLB is missing: ${operation.glbPath}.`);
        const immutableDirectory = operation.hash.slice(0, 20);
        const destinationDirectory = resolve(generatedImportRoot, immutableDirectory);
        const fileName = `${safeSegment(operation.assetId)}.glb`;
        const destination = resolve(destinationDirectory, fileName);
        if (!isInside(generatedImportRoot, destination)) {
          throw new DirectorEngineSceneImportError(
            "path_escape",
            "Generated scene asset escaped its storage root.",
            500,
          );
        }
        await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
        const [canonicalGeneratedRoot, canonicalDestinationDirectory] = await Promise.all([
          realpath(generatedImportRoot),
          realpath(destinationDirectory),
        ]);
        if (!isInside(canonicalGeneratedRoot, canonicalDestinationDirectory)) {
          throw new DirectorEngineSceneImportError(
            "path_escape",
            "Generated asset directory escaped its storage root.",
            500,
          );
        }
        const existingDestination = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existingDestination) {
          if (!existingDestination.isFile() || (await sha256File(destination)) !== operation.hash) {
            throw new DirectorEngineSceneImportError(
              "package_invalid",
              `Immutable asset collision for ${operation.assetId}.`,
              409,
            );
          }
        } else {
          const temporaryDestination = resolve(destinationDirectory, `.${fileName}.${randomUUID()}.partial`);
          try {
            await copyFile(sourcePath, temporaryDestination);
            await chmod(temporaryDestination, 0o600).catch(() => undefined);
            if ((await sha256File(temporaryDestination)) !== operation.hash) {
              throw new DirectorEngineSceneImportError(
                "package_invalid",
                `Copied scene asset failed verification: ${fileName}.`,
                500,
              );
            }
            await rename(temporaryDestination, destination);
          } finally {
            await rm(temporaryDestination, { force: true }).catch(() => undefined);
          }
        }
        const url = `/dcc-import/${immutableDirectory}/${fileName}`;
        copied.set(operation.assetId, { fileName, url });
        copiedAssets.push({ assetId: operation.assetId, url, hash: operation.hash });
      }

      const actions: DirectorAuthoringAction[] = [];
      for (const operation of plan.operations) {
        if (operation.op === "create_scene_asset") {
          const prepared = copied.get(operation.assetId);
          if (!prepared)
            throw new DirectorEngineSceneImportError(
              "package_invalid",
              `Prepared asset ${operation.assetId} is missing.`,
            );
          actions.push({
            action: "upsert_asset",
            asset: {
              id: operation.assetId,
              kind: "scene",
              sourceType: "model",
              fileName: prepared.fileName,
              name: operation.label,
              url: prepared.url,
              assetSource: "local",
              modelNormalization: "preserve",
            },
          });
        } else if (operation.op === "create_scene_object") {
          actions.push({
            action: "add_object",
            id: operation.objectId,
            name: operation.name,
            kind: "scene",
            asset_id: operation.assetId,
            transform: operation.transform,
          });
        } else if (operation.op === "create_camera") {
          actions.push({
            action: "add_camera",
            id: operation.cameraId,
            object_id: operation.objectId,
            name: operation.name,
            position: operation.position,
            target: operation.target,
            focal_length_mm: operation.focalLengthMm,
            sensor_format: operation.sensorFormat,
            aperture_f_stop: operation.apertureFStop,
            focus_distance_m: operation.focusDistanceM,
            near_clip_m: operation.nearClipM,
            far_clip_m: operation.farClipM,
            aspect_ratio: operation.aspectRatio,
            activate: false,
          });
        } else if (operation.op === "create_light") {
          actions.push({
            action: "add_light",
            light: {
              id: operation.lightId,
              name: operation.name,
              type: operation.type,
              visible: true,
              locked: false,
              color: operation.color,
              intensity: operation.intensity,
              ...(operation.position ? { position: operation.position } : {}),
              ...(operation.target ? { target: operation.target } : {}),
              ...(operation.distance !== undefined ? { distance: operation.distance } : {}),
              ...(operation.angle !== undefined ? { angle: operation.angle } : {}),
              ...(operation.penumbra !== undefined ? { penumbra: operation.penumbra } : {}),
              ...(operation.width !== undefined ? { width: operation.width } : {}),
              ...(operation.height !== undefined ? { height: operation.height } : {}),
              ...(operation.castShadow !== undefined ? { castShadow: operation.castShadow } : {}),
            },
          });
        }
      }
      const merged = applyDirectorAuthoringActions(project, actions).project;
      const parsedProject = directorProjectSchema.safeParse(merged);
      if (!parsedProject.success) {
        const issue = parsedProject.error.issues[0];
        throw new DirectorEngineSceneImportError(
          "authoring_failed",
          `Merged engine scene project is invalid at ${issue?.path.join(".") || "project"}: ${issue?.message ?? "invalid value"}.`,
        );
      }
      const wireBytes = Buffer.byteLength(JSON.stringify(parsedProject.data), "utf8");
      if (wireBytes > MAX_WORKBENCH_PROJECT_BYTES) {
        throw new DirectorEngineSceneImportError(
          "authoring_failed",
          `Merged project is ${wireBytes} bytes and exceeds the safe browser authoring payload budget.`,
          413,
        );
      }
      const operation = directorWorkbenchOperationSchema.parse({
        op: "replace_project",
        project: parsedProject.data,
        expected_revision: expectedRevision,
        idempotency_key: idempotencyKey,
      });
      const pendingInput = {
        schemaVersion: 1 as const,
        contract: DIRECTOR_ENGINE_SCENE_APPLY_LEDGER_CONTRACT,
        planId,
        expectedRevision,
        idempotencyKey,
        intentHash: "",
        plan,
        operation,
        copiedAssets,
        createdAt: new Date().toISOString(),
      };
      const pending = await persistApplyLedger({
        ...pendingInput,
        intentHash: applyIntentHash(pendingInput),
      });
      return executeApplyLedger(pending, applyAuthoring);
    });
  }

  return { ingestUpload, ingestProject, validatePackage, buildImportPlan, applyImportPlan };
}
