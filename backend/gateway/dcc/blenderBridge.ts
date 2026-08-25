import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../atomicJsonFile";
import {
  buildDirectorDccScenePackage,
  type DirectorDccScenePackage,
  type DirectorDccAssetResolution,
} from "@director/dcc-protocol";
import type {
  DirectorAssetRef,
  DirectorProject,
} from "@director/project-schema";
import { prepareGltfForBlender } from "./gltfPrepare";

const blenderReportSchema = z.strictObject({
  ok: z.literal(true),
  contract: z.literal("director-dcc-scene-v1"),
  packageId: z.string(),
  blendPath: z.string(),
  previewPath: z.string().nullable(),
  objectCount: z.number().int().nonnegative(),
  cameraCount: z.number().int().nonnegative(),
  /** Optional: reports from bridge scripts predating light export omit it. */
  lightCount: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()),
  blenderVersion: z.string(),
});

// Cap process output to avoid unbounded memory growth during long-running exports.
const MAX_PROCESS_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

/** Health and capability report for the local Blender installation. */
export interface BlenderBridgeStatus {
  /** Whether Blender is installed and reachable. */
  available: boolean;
  /** Resolved absolute path to the Blender binary, or null when unavailable. */
  executable: string | null;
  /** Human-readable version string from `blender --version`, or null when unavailable. */
  version: string | null;
  /** The DCC scene contract this bridge implements. */
  contract: "director-dcc-scene-v1";
  /** Human-readable reason when Blender is not available. */
  reason?: string;
}

/** Per-export overrides applied to the scene package. */
export interface BlenderExportOptions {
  /** When true, render a preview PNG from the active camera. */
  renderPreview?: boolean;
  /** Override the active camera by Director camera id. */
  cameraId?: string;
  /** Override the timeline frame at which the scene is evaluated. */
  frame?: number;
}

/** The result of a successful Blender export job. */
export interface BlenderExportResult {
  /** Unique job identifier. */
  jobId: string;
  /** Absolute path to the serialized DCC scene package JSON. */
  packagePath: string;
  /** Absolute path to the exported `.blend` file. */
  blendPath: string;
  /** Absolute path to the Blender bridge report JSON. */
  reportPath: string;
  /** Absolute path to the rendered preview PNG, or null when not requested. */
  previewPath: string | null;
  /** Project revision at export time. */
  sourceRevision: string;
  /** Number of exported 3D objects. */
  objectCount: number;
  /** Number of exported cameras. */
  cameraCount: number;
  /** Number of Director lights created as Blender light objects. */
  lightCount: number;
  /** Non-fatal warnings from the Blender bridge. */
  warnings: string[];
  /** The Blender version used for the export. */
  blenderVersion: string;
  /** Tail of Blender's stdout (last 80 non-empty lines, excluding the bridge result). */
  stdout: string;
}

/**
 * A managed Blender subprocess bridge that exports a Director project to a
 * `.blend` scene through the Python interchange script.
 */
export interface BlenderBridge {
  /** Probe the local Blender installation and return its status. */
  status(): Promise<BlenderBridgeStatus>;
  /** Export a Director project to a `.blend` file and return the result. */
  exportBlend(project: DirectorProject, options?: BlenderExportOptions): Promise<BlenderExportResult>;
}

/** Configuration for creating a Blender bridge. */
export interface CreateBlenderBridgeOptions {
  /** Absolute or relative path to the workspace root. */
  workspaceRoot: string;
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
  /** Optional explicit path to the Blender executable. */
  blenderExecutable?: string;
  /** Maximum time in milliseconds before the Blender process is killed. */
  timeoutMs?: number;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function findOnPath(command: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves the absolute path to a usable Blender binary by checking, in order:
 * the caller-supplied path, the `DIRECTOR_BLENDER_BIN` environment variable,
 * the macOS default `/Applications/Blender.app/…` location, and `$PATH`.
 *
 * @param configured - Optional explicit path to try first.
 * @returns The absolute path to the Blender executable, or null if no usable binary was found.
 */
export async function discoverBlenderExecutable(configured?: string): Promise<string | null> {
  const candidates = [
    configured,
    process.env.DIRECTOR_BLENDER_BIN,
    "/Applications/Blender.app/Contents/MacOS/Blender",
    await findOnPath("blender"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate;
  return null;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_PROCESS_OUTPUT ? combined : combined.slice(combined.length - MAX_PROCESS_OUTPUT);
}

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (!settled) {
        settled = true;
        rejectProcess(new Error(`Blender job exceeded ${timeoutMs} ms.`));
      }
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
      if (!settled) {
        settled = true;
        rejectProcess(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolveProcess({ stdout, stderr });
      else rejectProcess(new Error(`Blender exited with code ${code ?? "unknown"}. ${stderr || stdout}`));
    });
  });
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function decodeLocalAssetUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return null;
  try {
    const decoded = decodeURIComponent(trimmed.split(/[?#]/, 1)[0]!);
    if (
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      decoded
        .slice(1)
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    )
      return null;
    return decoded;
  } catch {
    return null;
  }
}

interface LocalAssetMount {
  canonicalRoot: string | null;
  filesystemRoot: string;
  label: string;
  urlPrefix: string;
}

async function createLocalAssetMount(
  filesystemRoot: string,
  urlPrefix: string,
  label: string,
): Promise<LocalAssetMount> {
  return {
    filesystemRoot,
    canonicalRoot: await realpath(filesystemRoot).catch(() => null),
    urlPrefix,
    label,
  };
}

async function createLocalAssetMounts(workspaceRoot: string): Promise<LocalAssetMount[]> {
  const libraryRoot = resolve(workspaceRoot, "assets", "library");
  const generatedImportRoot = resolve(workspaceRoot, "assets", "generated", "dcc-import");
  return Promise.all([
    createLocalAssetMount(generatedImportRoot, "/dcc-import/", "assets/generated/dcc-import"),
    createLocalAssetMount(generatedImportRoot, "/assets/generated/dcc-import/", "assets/generated/dcc-import"),
    createLocalAssetMount(libraryRoot, "/assets/library/", "assets/library"),
    createLocalAssetMount(libraryRoot, "/", "assets/library"),
  ]);
}

async function resolveMountedModel(mounts: LocalAssetMount[], url: string): Promise<DirectorDccAssetResolution> {
  const decoded = decodeLocalAssetUrl(url);
  if (!decoded) {
    return { status: "unsupported", message: "Only safe local library or DCC import URLs are supported." };
  }
  const mount = mounts.find(({ urlPrefix }) => decoded.startsWith(urlPrefix));
  if (!mount) return { status: "unsupported", message: "Asset URL does not match an allowed local asset root." };
  const relativeUrl = decoded.slice(mount.urlPrefix.length);
  const candidate = resolve(mount.filesystemRoot, relativeUrl);
  if (!isInside(mount.filesystemRoot, candidate)) {
    return { status: "unsupported", message: `Asset path escaped ${mount.label}.` };
  }
  if (![".glb", ".gltf"].includes(extname(candidate).toLowerCase())) {
    return { status: "unsupported", message: "Bridge v1 accepts GLB or glTF model assets only." };
  }
  if (!mount.canonicalRoot) {
    return { status: "missing", message: `Asset root does not exist: ${mount.label}.` };
  }
  try {
    const canonical = await realpath(candidate);
    if (!isInside(mount.canonicalRoot, canonical)) {
      return { status: "unsupported", message: `Asset symlink escaped ${mount.label}.` };
    }
    if (!(await stat(canonical)).isFile()) return { status: "missing", message: "Resolved asset is not a file." };
    return { status: "resolved", sourcePath: canonical };
  } catch {
    return { status: "missing", message: `Asset file does not exist under ${mount.label}: ${decoded}` };
  }
}

/**
 * Resolves a browser asset URL to an allowed, canonical local model path for DCC export.
 *
 * Only GLB/glTF files under the workspace `assets/library` or `assets/generated/dcc-import`
 * directories are allowed; symlinks are resolved and checked against their canonical root.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param url - A browser-side asset URL (e.g. `/assets/library/model.glb`).
 * @returns A resolution record with status and, on success, the canonical source path.
 */
export async function resolveDccModelAsset(workspaceRoot: string, url: string): Promise<DirectorDccAssetResolution> {
  return resolveMountedModel(await createLocalAssetMounts(resolve(workspaceRoot)), url);
}

async function resolveAssetMap(workspaceRoot: string, assets: DirectorAssetRef[]) {
  const mounts = await createLocalAssetMounts(workspaceRoot);
  const entries = await Promise.all(
    assets.map(async (asset) => [asset.id, await resolveMountedModel(mounts, asset.url)] as const),
  );
  return new Map(entries);
}

function reportStdout(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("DIRECTOR_DCC_RESULT:"))
    .slice(-80)
    .join("\n");
}

async function prepareAssetsForBlender(scenePackage: DirectorDccScenePackage, jobDirectory: string) {
  const sources = Array.from(
    new Set(scenePackage.objects.map((object) => object.sourcePath).filter((path): path is string => Boolean(path))),
  );
  if (!sources.length) return;
  const assetDirectory = resolve(jobDirectory, "assets");
  await mkdir(assetDirectory, { recursive: true });
  const prepared = new Map<string, string>();
  for (const [index, sourcePath] of sources.entries()) {
    const destination = resolve(assetDirectory, `asset-${String(index + 1).padStart(3, "0")}.glb`);
    try {
      await prepareGltfForBlender(sourcePath, destination);
      prepared.set(sourcePath, destination);
    } catch (error) {
      scenePackage.warnings.push(
        `Could not prepare ${sourcePath} for Blender; the original GLB will be attempted. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  scenePackage.objects.forEach((object) => {
    if (object.sourcePath && prepared.has(object.sourcePath)) object.sourcePath = prepared.get(object.sourcePath)!;
  });
  scenePackage.assets.forEach((asset) => {
    if (asset.sourcePath && prepared.has(asset.sourcePath)) asset.sourcePath = prepared.get(asset.sourcePath)!;
  });
}

/**
 * Creates a managed Blender subprocess bridge that exports Director projects
 * to `.blend` files through the Python interchange script.
 *
 * Assets are resolved from the workspace library and generated DCC-import
 * directories; only safe local GLB/glTF paths are passed to Blender.
 *
 * @param options - Workspace, data directory, and optional Blender executable path.
 * @returns A BlenderBridge instance with status and export methods.
 */
export function createBlenderBridge(options: CreateBlenderBridgeOptions): BlenderBridge {
  const workspaceRoot = resolve(options.workspaceRoot);
  const jobRoot = resolve(options.dataDirectory, "dcc-jobs", "blender");
  const bridgeScript = resolve(workspaceRoot, "integrations", "blender", "interchange", "director_bridge.py");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async status() {
      const executable = await discoverBlenderExecutable(options.blenderExecutable);
      if (!executable) {
        return {
          available: false,
          executable: null,
          version: null,
          contract: "director-dcc-scene-v1",
          reason: "Blender was not found. Set DIRECTOR_BLENDER_BIN or install Blender.app.",
        };
      }
      try {
        const { stdout } = await runProcess(executable, ["--version"], 10_000);
        return {
          available: true,
          executable,
          version: stdout.split(/\r?\n/, 1)[0]?.trim() || "Blender",
          contract: "director-dcc-scene-v1",
        };
      } catch (error) {
        return {
          available: false,
          executable,
          version: null,
          contract: "director-dcc-scene-v1",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async exportBlend(project, exportOptions = {}) {
      const executable = await discoverBlenderExecutable(options.blenderExecutable);
      if (!executable) throw new Error("Blender was not found. Set DIRECTOR_BLENDER_BIN or install Blender.app.");
      const assetMap = await resolveAssetMap(workspaceRoot, project.assets);
      const scenePackage = buildDirectorDccScenePackage(project, {
        resolveAsset: (asset) => assetMap.get(asset.id) ?? { status: "missing", message: "Asset was not resolved." },
        cameraId: exportOptions.cameraId,
        frame: exportOptions.frame,
      });
      const jobId = randomUUID();
      const jobDirectory = resolve(jobRoot, jobId);
      if (!isInside(jobRoot, jobDirectory)) throw new Error("Generated DCC job path escaped the job root.");
      await mkdir(jobDirectory, { recursive: true });
      const packagePath = resolve(jobDirectory, "scene.director-dcc.json");
      const blendPath = resolve(jobDirectory, "scene.blend");
      const reportPath = resolve(jobDirectory, "report.json");
      const previewPath = exportOptions.renderPreview ? resolve(jobDirectory, "preview.png") : null;
      await prepareAssetsForBlender(scenePackage, jobDirectory);
      await writeJsonAtomic(packagePath, scenePackage);

      const args = [
        "--background",
        "--factory-startup",
        "--python",
        bridgeScript,
        "--",
        "--package",
        packagePath,
        "--output-blend",
        blendPath,
        "--report",
        reportPath,
        ...(previewPath ? ["--preview", previewPath] : []),
      ];
      const processResult = await runProcess(executable, args, timeoutMs);
      const rawReport = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
      if (
        rawReport &&
        typeof rawReport === "object" &&
        !Array.isArray(rawReport) &&
        (rawReport as Record<string, unknown>).ok === false
      ) {
        const message = (rawReport as Record<string, unknown>).error;
        throw new Error(`Blender bridge failed: ${typeof message === "string" ? message : "unknown Blender error"}`);
      }
      const report = blenderReportSchema.parse(rawReport);
      await access(blendPath);
      if (previewPath) await access(previewPath);
      return {
        jobId,
        packagePath,
        blendPath,
        reportPath,
        previewPath,
        sourceRevision: scenePackage.sourceRevision,
        objectCount: report.objectCount,
        cameraCount: report.cameraCount,
        lightCount: report.lightCount ?? 0,
        warnings: report.warnings,
        blenderVersion: report.blenderVersion,
        stdout: reportStdout(processResult.stdout),
      };
    },
  };
}
