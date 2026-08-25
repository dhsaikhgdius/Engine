import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Quaternion, Vector3 } from "three";
import { z } from "zod";
import {
  applyDirectorAuthoringActions,
  type DirectorAuthoringAction,
} from "@director/agent-engine";
import {
  directorWorkbenchOperationSchema,
  type DirectorWorkbenchOperation,
} from "@director/agent-engine";
import type { DirectorProject } from "@director/project-schema";
import { directorProjectSchema } from "@director/project-schema";
import {
  DIRECTOR_PROJECT_REVISION_PATTERN,
  getDirectorProjectRevision,
} from "@director/project-schema";
import {
  DIRECTOR_CAMERA_ASPECT_RATIO_OPTIONS,
  DIRECTOR_CAMERA_SENSOR_FORMAT_OPTIONS,
  DIRECTOR_CAMERA_OPTICS_LIMITS,
  getFocalLengthFromVerticalFov,
} from "@director/project-schema";
import {
  DIRECTOR_BLEND_SCENE_IMPORT_PLAN_CONTRACT,
  directorBlendSceneImportPlanSchema,
  directorBlendSceneImportSelectionSchema,
  directorBlendSceneManifestSchema,
  type DirectorBlendSceneImportPlanV1,
  type DirectorBlendSceneImportSelection,
  type DirectorBlendSceneManifestV1,
} from "@director/dcc-protocol";
import { blenderPointToDirector } from "@director/dcc-protocol";
import { writeJsonAtomic } from "../atomicJsonFile";
import { discoverBlenderExecutable } from "./blenderBridge";
import type { DirectorDccAuthoringResponse } from "./blenderReturnImport";

const MAX_BLEND_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 256 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_WORKBENCH_PROJECT_BYTES = 20 * 1024 * 1024;
const MAX_APPLY_LEDGER_BYTES = MAX_WORKBENCH_PROJECT_BYTES + 4 * 1024 * 1024;
const DIRECTOR_BLEND_SCENE_APPLY_LEDGER_CONTRACT = "director-blend-scene-apply-ledger-v1" as const;

const copiedAssetSchema = z.strictObject({
  assetId: z.string().trim().min(1).max(240),
  url: z.string().trim().min(1).max(2_048),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

const blendApplyIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/);

const successfulAuthoringResponseSchema = z.looseObject({
  success: z.literal(true),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const blendSceneApplyLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    contract: z.literal(DIRECTOR_BLEND_SCENE_APPLY_LEDGER_CONTRACT),
    planId: z.string().trim().min(1).max(1_024),
    expectedRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    idempotencyKey: blendApplyIdempotencyKeySchema,
    intentHash: z.string().regex(/^[0-9a-f]{64}$/),
    plan: directorBlendSceneImportPlanSchema,
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

type BlendSceneApplyLedger = z.infer<typeof blendSceneApplyLedgerSchema>;

const extractorReportSchema = z.strictObject({
  ok: z.literal(true),
  contract: z.literal("director-blend-scene-v1"),
  packageId: z.string().trim().min(1),
  manifestPath: z.string().trim().min(1),
  bundlePath: z.string().nullable(),
  objectCount: z.number().int().nonnegative(),
  cameraCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  unsupportedCount: z.number().int().nonnegative(),
  blenderVersion: z.string().trim().min(1),
});

/**
 * Machine-readable error codes for Blender scene import failures.
 * Each code maps to a human-readable recovery hint in the `RECOVERY` table.
 */
export type DirectorBlendSceneImportErrorCode =
  | "blender_unavailable"
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

const RECOVERY: Record<DirectorBlendSceneImportErrorCode, string> = {
  blender_unavailable: "Install Blender or set DIRECTOR_BLENDER_BIN, then upload the scene again.",
  upload_invalid: "Choose a readable .blend file saved by Blender and retry.",
  upload_too_large: "Reduce or pack the Blender scene below 512 MiB, then retry.",
  package_invalid: "Upload the .blend again so Director can regenerate and verify its import package.",
  path_escape: "Use only the plan and package identifiers returned by Director.",
  plan_not_found: "Upload or preview the Blender scene again before applying it.",
  idempotency_key_conflict: "Use the original plan and revision for this key, or use a new key for a new intent.",
  stale_project_revision: "Preview the Blender import again against the current Director project.",
  conflict_unresolved: "Resolve the listed ID or selection conflicts, rebuild the plan, then apply it.",
  browser_target_unavailable: "Open the target Director Stage and retry against the same browser target.",
  authoring_failed: "Inspect the authoring error, preview the import again, and retry after resolving it.",
};

/**
 * An error thrown when a Blender scene import fails a validation, conflict,
 * or authoring check. Carries a machine-readable code, an HTTP status, and
 * a human-readable recovery hint.
 */
export class DirectorBlendSceneImportError extends Error {
  /** Machine-readable error code. */
  readonly code: DirectorBlendSceneImportErrorCode;
  /** Human-readable recovery hint. */
  readonly recovery: string;
  /** HTTP status code that best represents this error. */
  readonly status: number;

  constructor(code: DirectorBlendSceneImportErrorCode, message: string, status = 400) {
    super(message);
    this.name = "DirectorBlendSceneImportError";
    this.code = code;
    this.recovery = RECOVERY[code];
    this.status = status;
  }
}

/** A validated Blender scene import package ready for plan construction. */
export interface ValidatedDirectorBlendScenePackage {
  /** Absolute path to the package directory. */
  packageDirectory: string;
  /** Relative path from the job root to the package directory. */
  packageDir: string;
  /** Absolute path to the verified manifest.json. */
  manifestPath: string;
  /** SHA-256 of the manifest file bytes. */
  manifestHash: string;
  /** The parsed and validated manifest. */
  manifest: DirectorBlendSceneManifestV1;
  /** Map of relative paths to absolute, verified file paths (hash-checked). */
  files: Map<string, string>;
}

/** Input passed to the Blender scene extraction subprocess. */
export interface BlenderSceneExtractionInput {
  /** Absolute path to the source `.blend` file. */
  sourcePath: string;
  /** Directory where extracted assets are written. */
  outputDirectory: string;
  /** Path where the extraction report JSON is written. */
  reportPath: string;
  /** The job directory used as the Blender process working directory. */
  jobDirectory: string;
}

/** The result of a successful Blender scene upload and ingestion. */
export interface BlenderSceneImportUploadResult {
  /** Unique job identifier. */
  jobId: string;
  /** Relative path to the extracted package directory. */
  packagePath: string;
  /** The parsed and validated manifest. */
  manifest: DirectorBlendSceneManifestV1;
  /** The initial import plan built from the uploaded scene. */
  plan: DirectorBlendSceneImportPlanV1;
}

/**
 * A Blender scene importer ingests `.blend` uploads, extracts scene data,
 * builds import plans, and applies them through the Director authoring surface.
 */
export interface BlenderSceneImporter {
  /** Ingest a `.blend` upload, extract the scene, and return an initial plan. */
  ingestUpload(
    fileName: string,
    source: AsyncIterable<Uint8Array>,
    project: DirectorProject,
    declaredBytes?: number,
  ): Promise<BlenderSceneImportUploadResult>;
  /** Validate an extracted package directory and hash-check every file. */
  validatePackage(packageDir: string): Promise<ValidatedDirectorBlendScenePackage>;
  /** Build an import plan from a validated package and live project. */
  buildImportPlan(
    packageDir: string,
    project: DirectorProject,
    selection?: DirectorBlendSceneImportSelection,
  ): Promise<DirectorBlendSceneImportPlanV1>;
  /** Apply a validated import plan, copying assets and issuing authoring actions. */
  applyImportPlan(
    planId: string,
    project: DirectorProject,
    expectedRevision: string,
    idempotencyKey: string,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ): Promise<{
    plan: DirectorBlendSceneImportPlanV1;
    authoring: DirectorDccAuthoringResponse | null;
    copiedAssets: Array<{ assetId: string; url: string; hash: string }>;
  }>;
}

/** Configuration for creating a Blender scene importer. */
export interface CreateBlenderSceneImporterOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
  /** Optional explicit path to the Blender executable. */
  blenderExecutable?: string;
  /** Maximum time in milliseconds before the Blender extraction process is killed. */
  timeoutMs?: number;
  /** Maximum allowed byte size for uploaded `.blend` files. */
  maxUploadBytes?: number;
  /** Maximum allowed total byte size for extracted package assets. */
  maxExtractedBytes?: number;
  /** Optional override for the scene extraction subprocess (defaults to the built-in Blender call). */
  extractScene?: (input: BlenderSceneExtractionInput) => Promise<{ stdout?: string }>;
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

function safeSegment(value: string, fallback = "blender-scene"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
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
  return new Promise((resolveProcess, rejectProcess) => {
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached,
    });
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
      if (timedOut) rejectProcess(new Error(`Blender scene inspection exceeded ${timeoutMs} ms.`));
      else if (code === 0) resolveProcess({ stdout, stderr });
      else
        rejectProcess(new Error(`Blender scene inspection exited with code ${code ?? "unknown"}. ${stderr || stdout}`));
    });
  });
}

function hasBlendContainerSignature(header: Uint8Array): boolean {
  const bytes = Buffer.from(header);
  const raw =
    bytes.length >= 12 &&
    bytes.subarray(0, 7).toString("ascii") === "BLENDER" &&
    [0x5f, 0x2d].includes(bytes[7]!) &&
    [0x76, 0x56].includes(bytes[8]!) &&
    /^\d{3}$/.test(bytes.subarray(9, 12).toString("ascii"));
  const zstd = bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return raw || zstd || gzip;
}

async function writeUpload(
  source: AsyncIterable<Uint8Array>,
  temporaryPath: string,
  maximumBytes: number,
): Promise<{ hash: string; size: number; header: Uint8Array }> {
  const file = await open(temporaryPath, "wx", 0o600);
  const digest = createHash("sha256");
  const header = Buffer.alloc(12);
  let headerBytes = 0;
  let size = 0;
  try {
    for await (const value of source) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maximumBytes) {
        throw new DirectorBlendSceneImportError(
          "upload_too_large",
          `Blender scene exceeds the ${maximumBytes} byte upload limit.`,
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
        if (bytesWritten <= 0) throw new Error("Blender upload write made no forward progress.");
        offset += bytesWritten;
      }
    }
  } finally {
    await file.close();
  }
  if (size <= 0 || !hasBlendContainerSignature(header.subarray(0, headerBytes))) {
    throw new DirectorBlendSceneImportError(
      "upload_invalid",
      "Upload is not a recognized raw, Zstandard, or gzip Blender scene container.",
    );
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

function sourceIds(project: DirectorProject): Set<string> {
  return new Set([
    ...project.assets.map((item) => item.id),
    ...project.objects.map((item) => item.id),
    ...project.cameras.map((item) => item.id),
    ...(project.storyboard?.shots.map((item) => item.id) ?? []),
    ...(project.production?.takes.flatMap((take) => [take.id, ...take.entityTracks.map((track) => track.id)]) ?? []),
    ...(project.production?.sequences.flatMap((sequence) => [sequence.id, ...sequence.shots.map((shot) => shot.id)]) ??
      []),
  ]);
}

function cameraOperation(
  camera: DirectorBlendSceneManifestV1["cameras"][number],
  packageKey: string,
): Extract<DirectorBlendSceneImportPlanV1["operations"][number], { op: "create_camera" }> {
  const position = blenderPointToDirector(camera.transform.location);
  const blenderRotation = new Quaternion(...camera.transform.rotationQuaternion).normalize();
  const blenderForward = new Vector3(0, 0, -1).applyQuaternion(blenderRotation);
  // Camera forward is a semantic Blender local -Z axis. Convert that world
  // direction directly instead of conjugating it like a generic object basis.
  const directorForward = new Vector3(blenderForward.x, blenderForward.z, -blenderForward.y).normalize();
  const distance = clamp(camera.focusDistanceM, 0.01, 10_000);
  const targetVector = directorForward.multiplyScalar(distance).add(new Vector3(...position));
  const key = sha256(`${packageKey}\0${camera.sourceId}`).slice(0, 14);
  const sensorFormat = closestSensorFormat(camera.sensorWidthMm, camera.sensorHeightMm);
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
  return {
    op: "create_camera",
    sourceId: camera.sourceId,
    cameraId: `blend-camera-${key}`,
    objectId: `blend-camera-rig-${key}`,
    name: camera.name,
    position,
    target: [targetVector.x, targetVector.y, targetVector.z],
    focalLengthMm: clamp(focalLengthMm, 12, 200),
    sensorFormat,
    apertureFStop: clamp(camera.apertureFStop, 0.7, 64),
    focusDistanceM: distance,
    nearClipM,
    farClipM,
    aspectRatio,
  };
}

/**
 * Creates a Blender scene importer that ingests `.blend` uploads, runs the
 * Blender extraction subprocess, validates the resulting package, builds
 * import plans, and applies them through the Director authoring surface.
 *
 * The importer enforces upload size limits, validates the Blender container
 * signature, runs the extractor with a timeout, and idempotently applies
 * import plans with a persistent ledger for crash recovery.
 *
 * @param options - Workspace, data directory, Blender path, and budget overrides.
 * @returns An importer with ingest, validate, build, and apply methods.
 */
export function createBlenderSceneImporter(options: CreateBlenderSceneImporterOptions): BlenderSceneImporter {
  const workspaceRoot = resolve(options.workspaceRoot);
  const jobRoot = resolve(options.dataDirectory, "dcc-jobs", "blender-import");
  const applyLedgerRoot = resolve(options.dataDirectory, "dcc-ledgers", "blender-scene-import");
  const generatedImportRoot = resolve(workspaceRoot, "assets", "generated", "dcc-import");
  const extractorPath = resolve(
    workspaceRoot,
    "integrations",
    "blender",
    "interchange",
    "director_scene_export.py",
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumBytes = options.maxUploadBytes ?? MAX_BLEND_BYTES;
  const maximumExtractedBytes = options.maxExtractedBytes ?? MAX_EXTRACTED_PACKAGE_BYTES;
  const previewPackageCache = new Map<string, ValidatedDirectorBlendScenePackage>();
  const applyLocks = new Map<string, Promise<void>>();
  let extractionActive = false;
  const extractionQueue: Array<() => void> = [];

  async function acquireExtractionSlot(): Promise<() => void> {
    if (extractionActive) await new Promise<void>((resolveWaiter) => extractionQueue.push(resolveWaiter));
    extractionActive = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = extractionQueue.shift();
      if (next) next();
      else extractionActive = false;
    };
  }

  function applyIntentHash(
    value: Pick<
      BlendSceneApplyLedger,
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

  async function loadApplyLedger(idempotencyKey: string): Promise<BlendSceneApplyLedger | null> {
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
      throw new DirectorBlendSceneImportError("package_invalid", "Stored Blender apply ledger is not a safe file.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      throw new DirectorBlendSceneImportError("package_invalid", "Stored Blender apply ledger is not valid JSON.");
    }
    const parsed = blendSceneApplyLedgerSchema.safeParse(payload);
    if (!parsed.success || parsed.data.intentHash !== applyIntentHash(parsed.data)) {
      throw new DirectorBlendSceneImportError("package_invalid", "Stored Blender apply ledger failed validation.");
    }
    return parsed.data;
  }

  async function persistApplyLedger(value: BlendSceneApplyLedger): Promise<BlendSceneApplyLedger> {
    const parsed = blendSceneApplyLedgerSchema.safeParse(value);
    if (!parsed.success || parsed.data.intentHash !== applyIntentHash(parsed.data)) {
      throw new DirectorBlendSceneImportError("authoring_failed", "Blender apply intent could not be validated.", 500);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(parsed.data);
    } catch {
      throw new DirectorBlendSceneImportError("authoring_failed", "Blender apply receipt is not JSON-safe.", 500);
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_APPLY_LEDGER_BYTES) {
      throw new DirectorBlendSceneImportError("authoring_failed", "Blender apply ledger exceeds its safe size.", 413);
    }
    await mkdir(applyLedgerRoot, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(applyLedgerPath(value.idempotencyKey), parsed.data);
    await chmod(applyLedgerPath(value.idempotencyKey), 0o600).catch(() => undefined);
    return parsed.data;
  }

  function assertApplyLedgerIdentity(
    ledger: BlendSceneApplyLedger,
    planId: string,
    expectedRevision: string,
    idempotencyKey: string,
  ): void {
    if (
      ledger.planId !== planId ||
      ledger.expectedRevision !== expectedRevision ||
      ledger.idempotencyKey !== idempotencyKey
    ) {
      throw new DirectorBlendSceneImportError(
        "idempotency_key_conflict",
        `Idempotency key "${idempotencyKey}" already belongs to a different Blender import intent.`,
        409,
      );
    }
  }

  async function executeApplyLedger(
    ledger: BlendSceneApplyLedger,
    applyAuthoring: (operation: DirectorWorkbenchOperation) => Promise<DirectorDccAuthoringResponse | null>,
  ) {
    if (ledger.authoring) {
      return { plan: ledger.plan, authoring: ledger.authoring, copiedAssets: ledger.copiedAssets };
    }
    const authoring = await applyAuthoring(ledger.operation);
    if (!authoring) {
      throw new DirectorBlendSceneImportError(
        "browser_target_unavailable",
        "No live Director browser accepted the import.",
        503,
      );
    }
    if (!authoring.success) {
      throw new DirectorBlendSceneImportError(
        "authoring_failed",
        authoring.error ?? "Director rejected the Blender scene import.",
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

  async function defaultExtractScene(input: BlenderSceneExtractionInput): Promise<{ stdout?: string }> {
    const executable = await discoverBlenderExecutable(options.blenderExecutable);
    if (!executable) {
      throw new DirectorBlendSceneImportError(
        "blender_unavailable",
        "Blender executable was not found for scene inspection.",
        503,
      );
    }
    await access(extractorPath);
    const result = await runProcess(
      executable,
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--disable-liboverride-auto-resync",
        input.sourcePath,
        "--python-exit-code",
        "23",
        "--python",
        extractorPath,
        "--",
        "--source-blend",
        input.sourcePath,
        "--output-dir",
        input.outputDirectory,
        "--report",
        input.reportPath,
      ],
      timeoutMs,
      input.jobDirectory,
    );
    return { stdout: result.stdout };
  }

  const extractScene = options.extractScene ?? defaultExtractScene;

  async function resolvePackageDirectory(input: string): Promise<{ absolute: string; relative: string }> {
    const trimmed = input.trim();
    const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(jobRoot, trimmed);
    if (!isInside(jobRoot, candidate)) {
      throw new DirectorBlendSceneImportError("path_escape", `Blender import package escaped ${jobRoot}.`, 403);
    }
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new DirectorBlendSceneImportError(
        "package_invalid",
        `Blender import package does not exist: ${trimmed}.`,
        404,
      );
    }
    const canonicalRoot = await realpath(jobRoot).catch(() => jobRoot);
    if (!isInside(canonicalRoot, canonical) || !(await stat(canonical)).isDirectory()) {
      throw new DirectorBlendSceneImportError("path_escape", "Blender import package escaped its job root.", 403);
    }
    return { absolute: canonical, relative: posixRelative(canonicalRoot, canonical) };
  }

  async function validatePackage(packageDir: string): Promise<ValidatedDirectorBlendScenePackage> {
    const directory = await resolvePackageDirectory(packageDir);
    const manifestPath = resolve(directory.absolute, "manifest.json");
    const canonicalManifest = await realpath(manifestPath).catch(() => null);
    if (!canonicalManifest || !isInside(directory.absolute, canonicalManifest)) {
      throw new DirectorBlendSceneImportError("package_invalid", "Blender scene package is missing manifest.json.");
    }
    const manifestStat = await stat(canonicalManifest);
    if (!manifestStat.isFile() || manifestStat.size <= 0 || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new DirectorBlendSceneImportError(
        "package_invalid",
        `Blender scene manifest must be a non-empty file no larger than ${MAX_MANIFEST_BYTES} bytes.`,
      );
    }
    const manifestBytes = await readFile(canonicalManifest);
    let unknownManifest: unknown;
    try {
      unknownManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
    } catch {
      throw new DirectorBlendSceneImportError("package_invalid", "Blender scene manifest is not valid JSON.");
    }
    const parsed = directorBlendSceneManifestSchema.safeParse(unknownManifest);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DirectorBlendSceneImportError(
        "package_invalid",
        `Invalid Blender scene manifest at ${issue?.path.join(".") || "manifest"}: ${issue?.message ?? "invalid value"}.`,
      );
    }
    const files = new Map<string, string>();
    let extractedBytes = 0;
    for (const [relativePath, expectedHash] of Object.entries(parsed.data.fileHashes)) {
      const candidate = resolve(directory.absolute, relativePath);
      if (!isInside(directory.absolute, candidate)) {
        throw new DirectorBlendSceneImportError(
          "path_escape",
          `Manifest file escaped package root: ${relativePath}.`,
          403,
        );
      }
      const canonical = await realpath(candidate).catch(() => null);
      const fileStat = canonical ? await stat(canonical).catch(() => null) : null;
      if (!canonical || !isInside(directory.absolute, canonical) || !fileStat?.isFile()) {
        throw new DirectorBlendSceneImportError("package_invalid", `Manifest file is missing: ${relativePath}.`);
      }
      extractedBytes += fileStat.size;
      if (fileStat.size <= 0 || extractedBytes > maximumExtractedBytes) {
        throw new DirectorBlendSceneImportError(
          "package_invalid",
          `Blender extracted assets must be non-empty and total no more than ${maximumExtractedBytes} bytes.`,
          413,
        );
      }
      if ((await sha256File(canonical)) !== expectedHash) {
        throw new DirectorBlendSceneImportError("package_invalid", `SHA-256 mismatch for ${relativePath}.`);
      }
      files.set(relativePath, canonical);
    }
    const sourcePath = resolve(directory.absolute, "..", "source.blend");
    const canonicalSource = await realpath(sourcePath).catch(() => null);
    if (
      !canonicalSource ||
      !isInside(resolve(directory.absolute, ".."), canonicalSource) ||
      (await sha256File(canonicalSource)) !== parsed.data.source.sha256 ||
      (await stat(canonicalSource)).size !== parsed.data.source.sizeBytes
    ) {
      throw new DirectorBlendSceneImportError(
        "package_invalid",
        "The snapshotted source.blend no longer matches its manifest.",
      );
    }
    return {
      packageDirectory: directory.absolute,
      packageDir: directory.relative,
      manifestPath: canonicalManifest,
      manifestHash: sha256(manifestBytes),
      manifest: parsed.data,
      files,
    };
  }

  function buildPlan(
    validated: ValidatedDirectorBlendScenePackage,
    project: DirectorProject,
    selectionInput?: DirectorBlendSceneImportSelection,
  ): DirectorBlendSceneImportPlanV1 {
    const manifest = validated.manifest;
    const selection = directorBlendSceneImportSelectionSchema.parse(
      selectionInput ?? {
        includeScene: Boolean(manifest.scene.bundleFile),
        cameraSourceIds: manifest.cameras.map((item) => item.sourceId),
      },
    );
    const selectedCameraIds = new Set(selection.cameraSourceIds);
    const knownCameraIds = new Set(manifest.cameras.map((item) => item.sourceId));
    const operations: DirectorBlendSceneImportPlanV1["operations"] = [];
    const conflicts: DirectorBlendSceneImportPlanV1["conflicts"] = [];
    const warnings = [
      ...manifest.warnings,
      ...manifest.unsupported.map((item) => `${item.kind} ${item.name}: ${item.reason}`),
    ];
    const packageKey = manifest.source.sha256.slice(0, 20);
    const assetId = `blend-scene-asset-${packageKey}`;
    const objectId = `blend-scene-object-${packageKey}`;
    const existing = sourceIds(project);

    for (const sourceId of selection.cameraSourceIds) {
      if (!knownCameraIds.has(sourceId)) {
        conflicts.push({
          sourceId,
          code: "unsupported_scene",
          reason: `Camera ${sourceId} is not present in the validated Blender scene package.`,
        });
      }
    }
    if (!selection.includeScene && selection.cameraSourceIds.length === 0) {
      conflicts.push({
        sourceId: "selection",
        code: "empty_selection",
        reason: "Select the scene or at least one camera.",
      });
    }
    if (selection.includeScene) {
      if (!manifest.scene.bundleFile) {
        conflicts.push({
          sourceId: "scene",
          code: "unsupported_scene",
          reason: "The Blender scene contains no renderable geometry bundle.",
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
      if (Math.abs(operation.focalLengthMm - camera.focalLengthMm) > 0.05) {
        warnings.push(
          `Camera ${camera.name} uses ${operation.focalLengthMm} mm in Director to preserve Blender's vertical field of view with the nearest supported sensor gate.`,
        );
      }
    }
    if (manifest.scene.actionCount > 0) {
      warnings.push(
        `${manifest.scene.actionCount} Blender action(s) remain embedded in the GLB; Director v1 imports the scene at the current frame and does not map them onto its editable timeline.`,
      );
    }
    if (selection.cameraSourceIds.length) {
      warnings.push("Blender camera roll and lens shift are not represented by Director's target-based camera model.");
    }
    const selectionHash = sha256(JSON.stringify(selection)).slice(0, 16);
    const jobId = validated.packageDir.split("/")[0]!;
    return directorBlendSceneImportPlanSchema.parse({
      contract: DIRECTOR_BLEND_SCENE_IMPORT_PLAN_CONTRACT,
      planId: `${jobId}/plans/${selectionHash}.json`,
      ready: conflicts.length === 0,
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

  async function persistPlan(plan: DirectorBlendSceneImportPlanV1): Promise<void> {
    const path = resolve(jobRoot, plan.planId);
    if (!isInside(jobRoot, path))
      throw new DirectorBlendSceneImportError("path_escape", "Plan ID escaped its job root.", 403);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path, plan);
    await chmod(path, 0o600).catch(() => undefined);
  }

  async function validatePackageReusingPreview(packageDir: string): Promise<ValidatedDirectorBlendScenePackage> {
    const directory = await resolvePackageDirectory(packageDir);
    const cached = previewPackageCache.get(directory.relative);
    if (cached) {
      // Reuse the upload/preview validation instead of re-hashing every extracted
      // file; a manifest re-hash still detects a replaced package, and each GLB
      // copy is verified against its manifest hash again before use.
      const manifestHash = await sha256File(cached.manifestPath).catch(() => null);
      if (manifestHash === cached.manifestHash) return cached;
      previewPackageCache.delete(directory.relative);
    }
    const validated = await validatePackage(directory.relative);
    previewPackageCache.set(validated.packageDir, validated);
    return validated;
  }

  async function buildImportPlan(
    packageDir: string,
    project: DirectorProject,
    selection?: DirectorBlendSceneImportSelection,
  ): Promise<DirectorBlendSceneImportPlanV1> {
    const validated = await validatePackageReusingPreview(packageDir);
    const plan = buildPlan(validated, project, selection);
    await persistPlan(plan);
    return plan;
  }

  async function ingestUpload(
    fileName: string,
    source: AsyncIterable<Uint8Array>,
    project: DirectorProject,
    declaredBytes?: number,
  ): Promise<BlenderSceneImportUploadResult> {
    const normalizedName = fileName.trim();
    if (!normalizedName.toLowerCase().endsWith(".blend") || normalizedName.includes("\0")) {
      throw new DirectorBlendSceneImportError("upload_invalid", "Blender scene filename must end in .blend.");
    }
    if (
      declaredBytes !== undefined &&
      (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > maximumBytes)
    ) {
      throw new DirectorBlendSceneImportError(
        declaredBytes > maximumBytes ? "upload_too_large" : "upload_invalid",
        `Invalid Blender scene Content-Length ${String(declaredBytes)}.`,
        declaredBytes > maximumBytes ? 413 : 400,
      );
    }
    const jobId = `blend-${randomUUID()}`;
    const jobDirectory = resolve(jobRoot, jobId);
    const temporaryPath = resolve(jobDirectory, "source.blend.partial");
    const sourcePath = resolve(jobDirectory, "source.blend");
    const outputDirectory = resolve(jobDirectory, "package");
    const reportPath = resolve(jobDirectory, "report.json");
    const releaseExtractionSlot = await acquireExtractionSlot();
    try {
      await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
      await chmod(jobDirectory, 0o700).catch(() => undefined);
      const uploaded = await writeUpload(source, temporaryPath, maximumBytes);
      if (declaredBytes !== undefined && uploaded.size !== declaredBytes) {
        throw new DirectorBlendSceneImportError(
          "upload_invalid",
          `Blender upload size ${uploaded.size} does not match Content-Length ${declaredBytes}.`,
        );
      }
      await rename(temporaryPath, sourcePath);
      await chmod(sourcePath, 0o600).catch(() => undefined);
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await extractScene({ sourcePath, outputDirectory, reportPath, jobDirectory });
      const reportUnknown = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
      const report = extractorReportSchema.safeParse(reportUnknown);
      if (!report.success) {
        throw new DirectorBlendSceneImportError(
          "package_invalid",
          "Blender extractor did not produce a valid success report.",
        );
      }
      const validated = await validatePackage(`${jobId}/package`);
      previewPackageCache.set(validated.packageDir, validated);
      if (validated.manifest.source.sha256 !== uploaded.hash || validated.manifest.source.sizeBytes !== uploaded.size) {
        throw new DirectorBlendSceneImportError(
          "package_invalid",
          "Blender extractor reported a different source file.",
        );
      }
      const plan = buildPlan(validated, project);
      await persistPlan(plan);
      return { jobId, packagePath: validated.packageDir, manifest: validated.manifest, plan };
    } catch (error) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof DirectorBlendSceneImportError) throw error;
      throw new DirectorBlendSceneImportError(
        "package_invalid",
        `Blender could not inspect ${safeSegment(normalizedName)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      releaseExtractionSlot();
    }
  }

  async function loadPlan(planId: string): Promise<DirectorBlendSceneImportPlanV1> {
    const candidate = resolve(jobRoot, planId);
    if (!isInside(jobRoot, candidate))
      throw new DirectorBlendSceneImportError("path_escape", "Plan ID escaped its job root.", 403);
    const canonical = await realpath(candidate).catch(() => null);
    const canonicalRoot = await realpath(jobRoot).catch(() => jobRoot);
    if (!canonical || !isInside(canonicalRoot, canonical)) {
      throw new DirectorBlendSceneImportError(
        "plan_not_found",
        `Blender scene import plan was not found: ${planId}.`,
        404,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(canonical, "utf8")) as unknown;
    } catch {
      throw new DirectorBlendSceneImportError("plan_not_found", "Blender scene import plan is not valid JSON.", 404);
    }
    const parsed = directorBlendSceneImportPlanSchema.safeParse(payload);
    if (!parsed.success || parsed.data.planId !== planId) {
      throw new DirectorBlendSceneImportError("package_invalid", "Stored Blender import plan failed validation.");
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
    if (!blendApplyIdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new DirectorBlendSceneImportError("authoring_failed", "Blender import idempotency key is invalid.");
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
        throw new DirectorBlendSceneImportError(
          "stale_project_revision",
          `Expected ${expectedRevision}, but the live project is ${currentRevision}.`,
          409,
        );
      }
      if (!stored.ready || stored.conflicts.length) {
        throw new DirectorBlendSceneImportError(
          "conflict_unresolved",
          "The Blender scene import plan contains conflicts.",
          409,
        );
      }
      const validated = await validatePackageReusingPreview(stored.packageDir);
      if (validated.manifest.packageId !== stored.packageId || validated.manifestHash !== stored.manifestHash) {
        throw new DirectorBlendSceneImportError("package_invalid", "Blender scene package changed after preview.", 409);
      }
      // The stored plan pins identity (packageId/manifestHash/targetRevision) and
      // the selection; the applied operations always come from a server-side
      // rebuild against the validated package and the live project.
      const plan = buildPlan(validated, project, stored.selection);
      if (!plan.ready || plan.conflicts.length) {
        throw new DirectorBlendSceneImportError(
          "conflict_unresolved",
          "Rebuilding the Blender scene plan against the live project produced conflicts.",
          409,
        );
      }

      const copiedAssets: Array<{ assetId: string; url: string; hash: string }> = [];
      const copied = new Map<string, { fileName: string; url: string }>();
      for (const operation of plan.operations) {
        if (operation.op !== "create_scene_asset") continue;
        const sourcePath = validated.files.get(operation.glbPath);
        if (!sourcePath)
          throw new DirectorBlendSceneImportError("package_invalid", `Scene GLB is missing: ${operation.glbPath}.`);
        const immutableDirectory = operation.hash.slice(0, 20);
        const destinationDirectory = resolve(generatedImportRoot, immutableDirectory);
        const fileName = `${safeSegment(operation.assetId)}.glb`;
        const destination = resolve(destinationDirectory, fileName);
        if (!isInside(generatedImportRoot, destination)) {
          throw new DirectorBlendSceneImportError(
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
          throw new DirectorBlendSceneImportError(
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
            throw new DirectorBlendSceneImportError(
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
              throw new DirectorBlendSceneImportError(
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
            throw new DirectorBlendSceneImportError(
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
        }
      }
      const merged = applyDirectorAuthoringActions(project, actions).project;
      const parsedProject = directorProjectSchema.safeParse(merged);
      if (!parsedProject.success) {
        const issue = parsedProject.error.issues[0];
        throw new DirectorBlendSceneImportError(
          "authoring_failed",
          `Merged Blender scene project is invalid at ${issue?.path.join(".") || "project"}: ${issue?.message ?? "invalid value"}.`,
        );
      }
      const wireBytes = Buffer.byteLength(JSON.stringify(parsedProject.data), "utf8");
      if (wireBytes > MAX_WORKBENCH_PROJECT_BYTES) {
        throw new DirectorBlendSceneImportError(
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
        contract: DIRECTOR_BLEND_SCENE_APPLY_LEDGER_CONTRACT,
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

  return { ingestUpload, validatePackage, buildImportPlan, applyImportPlan };
}
