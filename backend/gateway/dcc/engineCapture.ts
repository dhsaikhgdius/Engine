import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DIRECTOR_DCC_ENGINE_FRAME_CONTRACT,
  directorDccEngineFrameReceiptSchema,
  directorDccEngineIdSchema,
  directorDccGodotRunSceneSchema,
  type DirectorDccEngineFrameReceipt,
  type DirectorDccEngineId,
} from "@director/dcc-protocol";
import { DIRECTOR_ENGINE_BINARY_ENV, DIRECTOR_ENGINE_PROJECT_ENV, type DirectorDccEngineBridge } from "./engineBridge";
import { discoverDccRuntimeExecutable } from "./dccProviderRegistry";
import { DirectorDccEngineRunError } from "./engineRun";
import { runUnrealCleanFrame } from "./unrealCleanFrame";

/**
 * On-demand engine frame renders: the perception primitive that lets an agent
 * (and the workbench dock) see the engine's actual pixels between handoffs.
 *
 * - Godot renders through Movie Maker mode (`--write-movie`, two fixed-fps
 *   frames, then quit). Movie Maker needs a real rendering context, so a
 *   window appears briefly on the local machine; that is the documented cost
 *   of real pixels — headless Godot uses the dummy renderer and cannot draw.
 * - Unreal reuses the connector's offscreen `--mode render` against a prior
 *   send job's imported level (hash-verified receipt).
 * - Unity runs the connector's batch `Render` entry without `-nographics`.
 *
 * Every path spawns the discovered engine executable with a fixed argument
 * vector against the configured project — never a request-supplied script —
 * and the image bytes are re-hashed before the receipt is accepted.
 */

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 64 * 1024;

/** Caller options for one engine frame render. */
export interface DirectorDccEngineFrameRequest {
  /** Unreal: required send-job id; Unity: optional (resolves the imported scene path). */
  jobId?: string;
  /** Godot: res:// scene (defaults to the main scene); Unity: project scene path. */
  scene?: string;
  /** Unreal: Director camera id; Unity: camera object name. */
  camera?: string;
  width?: number;
  height?: number;
  /** Unreal-only: the Director timeline frame to scrub to. */
  frame?: number;
}

/** One rendered frame with its receipt and the image bytes as base64. */
export interface DirectorDccEngineFrameResult {
  receipt: DirectorDccEngineFrameReceipt;
  /** PNG bytes, base64-encoded; absent when the receipt is skipped. */
  imageBase64?: string;
}

/** Renders one engine frame on demand. */
export interface DirectorDccEngineFrameRenderer {
  render(provider: DirectorDccEngineId, request?: DirectorDccEngineFrameRequest): Promise<DirectorDccEngineFrameResult>;
}

/** Options for creating the engine frame renderer. */
export interface CreateDirectorDccEngineFrameRendererOptions {
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
  /** Engine bridge used for Unreal health (executable + project resolution). */
  engineBridge?: DirectorDccEngineBridge;
  /** Environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Milliseconds before a render process is killed. */
  timeoutMs?: number;
  /** Spawn override for tests. */
  spawnImpl?: typeof spawn;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_PROCESS_OUTPUT ? combined : combined.slice(combined.length - MAX_PROCESS_OUTPUT);
}

async function isDirectory(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isDirectory() ?? false;
}

function clampSide(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  return Math.max(64, Math.min(maximum, Math.round(value)));
}

/**
 * Creates the engine frame renderer behind the `render_engine_frame`
 * operation.
 *
 * @param options - Data directory, engine bridge, environment, and overrides.
 * @returns The renderer with a single `render` method.
 */
export function createDirectorDccEngineFrameRenderer(
  options: CreateDirectorDccEngineFrameRendererOptions,
): DirectorDccEngineFrameRenderer {
  const dataDirectory = resolve(options.dataDirectory);
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = options.spawnImpl ?? spawn;
  const frameJobRoot = resolve(dataDirectory, "dcc-jobs", "engine-frames");

  function runProcess(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveProcess, rejectProcess) => {
      const detached = process.platform !== "win32";
      const child = spawnImpl(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, detached });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const killTree = (signal: NodeJS.Signals) => {
        if (detached && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Fall back to the direct child when the process group is gone.
          }
        }
        child.kill(signal);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        forceKillTimer = setTimeout(() => killTree("SIGKILL"), 2_000);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: string) => {
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
        if (timedOut) rejectProcess(new Error(`Engine frame render exceeded ${timeoutMs} ms.`));
        else if (code === 0) resolveProcess({ stdout, stderr });
        else rejectProcess(new Error(`Engine frame render exited with code ${code ?? "unknown"}. ${stderr || stdout}`));
      });
    });
  }

  async function resolveRuntime(provider: DirectorDccEngineId): Promise<{ executable: string; projectPath: string }> {
    const executable = await discoverDccRuntimeExecutable(provider, environment);
    if (!executable) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `No ${provider} executable was found (${DIRECTOR_ENGINE_BINARY_ENV[provider]} or well-known install paths).`,
        503,
        [`Set ${DIRECTOR_ENGINE_BINARY_ENV[provider]} to the ${provider} binary.`],
      );
    }
    const configuredProject = environment[DIRECTOR_ENGINE_PROJECT_ENV[provider]]?.trim();
    if (!configuredProject) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `${DIRECTOR_ENGINE_PROJECT_ENV[provider]} does not name the ${provider} project directory.`,
        503,
        [`Set ${DIRECTOR_ENGINE_PROJECT_ENV[provider]} to the engine project directory.`],
      );
    }
    const projectPath = await realpath(resolve(configuredProject)).catch(() => null);
    if (!projectPath || !(await isDirectory(projectPath))) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `${DIRECTOR_ENGINE_PROJECT_ENV[provider]} points at a missing directory: ${configuredProject}.`,
        503,
        [`Set ${DIRECTOR_ENGINE_PROJECT_ENV[provider]} to the engine project directory.`],
      );
    }
    return { executable, projectPath };
  }

  async function readImage(
    provider: DirectorDccEngineId,
    jobDirectory: string,
    imageAbsolute: string,
    width: number,
    height: number,
    warnings: string[],
  ): Promise<DirectorDccEngineFrameResult> {
    const bytes = await readFile(imageAbsolute).catch(() => null);
    if (!bytes || bytes.byteLength === 0) {
      throw new DirectorDccEngineRunError(
        "engine_run_failed",
        `${provider} produced no frame image at ${imageAbsolute}.`,
        502,
      );
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new DirectorDccEngineRunError(
        "engine_run_failed",
        `${provider} frame image is ${bytes.byteLength} bytes, exceeding the ${MAX_IMAGE_BYTES} byte budget; request a smaller resolution.`,
        413,
      );
    }
    const receipt = directorDccEngineFrameReceiptSchema.parse({
      contract: DIRECTOR_DCC_ENGINE_FRAME_CONTRACT,
      provider,
      status: "rendered",
      imagePath: imageAbsolute.startsWith(jobDirectory) ? imageAbsolute.slice(jobDirectory.length + 1) : imageAbsolute,
      imageSha256: createHash("sha256").update(bytes).digest("hex"),
      width,
      height,
      warnings,
    });
    return { receipt, imageBase64: bytes.toString("base64") };
  }

  async function renderGodot(request: DirectorDccEngineFrameRequest): Promise<DirectorDccEngineFrameResult> {
    const runtime = await resolveRuntime("godot");
    const scene = request.scene === undefined ? null : directorDccGodotRunSceneSchema.parse(request.scene);
    const width = clampSide(request.width, DEFAULT_WIDTH, 1_920);
    const height = clampSide(request.height, DEFAULT_HEIGHT, 1_080);
    const jobDirectory = resolve(frameJobRoot, "godot", randomUUID());
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    const moviePath = join(jobDirectory, "frame.png");
    // Movie Maker renders deterministic fixed-fps frames and requires a real
    // rendering context; a window appears briefly. Two frames give the
    // renderer one warm-up frame; the last written PNG is the receipt image.
    await runProcess(
      runtime.executable,
      [
        "--path",
        runtime.projectPath,
        "--resolution",
        `${width}x${height}`,
        "--write-movie",
        moviePath,
        "--fixed-fps",
        "24",
        "--quit-after",
        "2",
        ...(scene ? [scene] : []),
      ],
      runtime.projectPath,
    );
    const produced = (await readdir(jobDirectory).catch(() => []))
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .sort();
    const newest = produced[produced.length - 1];
    if (!newest) {
      throw new DirectorDccEngineRunError(
        "engine_run_failed",
        "Godot Movie Maker produced no PNG frame; check that the scene has an active Camera3D.",
        502,
      );
    }
    return readImage(
      "godot",
      jobDirectory,
      join(jobDirectory, newest),
      width,
      height,
      scene ? [] : ["No scene was given; the project's main scene was rendered."],
    );
  }

  async function renderUnreal(request: DirectorDccEngineFrameRequest): Promise<DirectorDccEngineFrameResult> {
    const jobId = request.jobId?.trim();
    if (!jobId) {
      throw new DirectorDccEngineRunError(
        "engine_run_invalid",
        "Unreal frame renders need job_id: the send_to_engine job whose imported level should be rendered.",
        400,
      );
    }
    if (!options.engineBridge) {
      throw new DirectorDccEngineRunError("engine_run_not_ready", "The engine bridge is not configured.", 503);
    }
    const jobDirectory = resolve(dataDirectory, "dcc-jobs", "unreal", jobId);
    const packageDirectory = resolve(dataDirectory, "dcc-jobs", "exchange", "unreal", jobId);
    if (!(await isDirectory(jobDirectory)) || !(await isDirectory(packageDirectory))) {
      throw new DirectorDccEngineRunError(
        "engine_run_unknown",
        `No unreal send job ${jobId} was found; run send_to_engine first.`,
        404,
      );
    }
    let sourceRevision: string;
    try {
      const report = JSON.parse(await readFile(resolve(jobDirectory, "report.json"), "utf8")) as {
        sourceRevision?: string;
      };
      if (typeof report.sourceRevision !== "string") throw new Error("report carries no sourceRevision");
      sourceRevision = report.sourceRevision;
    } catch (error) {
      throw new DirectorDccEngineRunError(
        "engine_run_failed",
        `The unreal job report could not be read: ${error instanceof Error ? error.message : String(error)}.`,
        502,
      );
    }
    const currentHealth = await options.engineBridge.health("unreal");
    if (!currentHealth.ready || !currentHealth.executable || !currentHealth.projectPath) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        "The unreal connector is not nativeReady; frame renders need the same readiness as send_to_engine.",
        503,
        currentHealth.recovery,
      );
    }
    const width = clampSide(request.width, DEFAULT_WIDTH, 1_920);
    const height = clampSide(request.height, DEFAULT_HEIGHT, 1_080);
    const receipt = await runUnrealCleanFrame(
      {
        executable: currentHealth.executable,
        // For unreal, health.projectPath is the .uproject file; the connector
        // entry lives under the project directory beside it.
        projectPath: currentHealth.projectPath,
        scriptPath: resolve(
          dirname(currentHealth.projectPath),
          "Plugins",
          "DirectorBridge",
          "Content",
          "Python",
          "director_headless.py",
        ),
        packageDirectory,
        jobDirectory,
        expectedPackageId: jobId,
        expectedSourceRevision: sourceRevision,
        runProcess: (executable, args, budgetMs) =>
          runProcess(executable, args, jobDirectory).then((result) => {
            void budgetMs;
            return result;
          }),
        timeoutMs,
      },
      {
        ...(request.camera ? { cameraId: request.camera } : {}),
        ...(request.frame !== undefined ? { frame: request.frame } : {}),
        width,
        height,
      },
    );
    if (receipt.status === "skipped") {
      return {
        receipt: directorDccEngineFrameReceiptSchema.parse({
          contract: DIRECTOR_DCC_ENGINE_FRAME_CONTRACT,
          provider: "unreal",
          status: "skipped",
          skipReason: receipt.skipReason,
          warnings: receipt.warnings,
        }),
      };
    }
    return readImage("unreal", jobDirectory, resolve(jobDirectory, receipt.imagePath), receipt.width, receipt.height, [
      ...receipt.warnings,
    ]);
  }

  async function renderUnity(request: DirectorDccEngineFrameRequest): Promise<DirectorDccEngineFrameResult> {
    const runtime = await resolveRuntime("unity");
    let scene = request.scene?.trim() ?? "";
    if (!scene && request.jobId?.trim()) {
      const report = JSON.parse(
        await readFile(resolve(dataDirectory, "dcc-jobs", "unity", request.jobId.trim(), "report.json"), "utf8").catch(
          () => "{}",
        ),
      ) as { scenePath?: string | null };
      scene = typeof report.scenePath === "string" ? report.scenePath : "";
    }
    if (!scene) {
      throw new DirectorDccEngineRunError(
        "engine_run_invalid",
        "Unity frame renders need scene (a project scene path) or job_id of a prior send whose imported scene should be rendered.",
        400,
      );
    }
    const width = clampSide(request.width, DEFAULT_WIDTH, 1_920);
    const height = clampSide(request.height, DEFAULT_HEIGHT, 1_080);
    const jobDirectory = resolve(frameJobRoot, "unity", randomUUID());
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    const outputPath = join(jobDirectory, "frame.png");
    // Batch mode without -nographics keeps a GPU device so Camera.Render can
    // draw; the connector's fixed Render entry writes exactly one PNG.
    await runProcess(
      runtime.executable,
      [
        "-batchmode",
        "-quit",
        "-projectPath",
        runtime.projectPath,
        "-executeMethod",
        "Director.Bridge.Editor.DirectorBridgeCli.Render",
        "-logFile",
        join(jobDirectory, "unity.log"),
        "-directorRenderOutput",
        outputPath,
        "-directorScene",
        scene,
        ...(request.camera ? ["-directorCamera", request.camera] : []),
        "-directorWidth",
        String(width),
        "-directorHeight",
        String(height),
      ],
      runtime.projectPath,
    );
    return readImage("unity", jobDirectory, outputPath, width, height, []);
  }

  async function render(
    providerInput: DirectorDccEngineId,
    request: DirectorDccEngineFrameRequest = {},
  ): Promise<DirectorDccEngineFrameResult> {
    const parsed = directorDccEngineIdSchema.safeParse(providerInput);
    if (!parsed.success) {
      throw new DirectorDccEngineRunError(
        "engine_run_invalid",
        `${JSON.stringify(String(providerInput).slice(0, 120))} is not an engine provider (unreal, unity, godot).`,
        400,
      );
    }
    if (parsed.data === "godot") return renderGodot(request);
    if (parsed.data === "unreal") return renderUnreal(request);
    return renderUnity(request);
  }

  return { render };
}
