import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DIRECTOR_DCC_ENGINE_EDITOR_LAUNCH_CONTRACT,
  DIRECTOR_DCC_ENGINE_RUN_CONTRACT,
  DIRECTOR_DCC_ENGINE_RUN_MAX_OUTPUT_BYTES,
  directorDccEngineEditorLaunchSchema,
  directorDccEngineIdSchema,
  directorDccEngineRunStatusSchema,
  directorDccGodotRunSceneSchema,
  type DirectorDccEngineEditorLaunch,
  type DirectorDccEngineId,
  type DirectorDccEngineRunErrorCode,
  type DirectorDccEngineRunStatus,
} from "@director/dcc-protocol";
import { BoundedTextBuffer } from "../boundedTextBuffer";
import { DIRECTOR_ENGINE_BINARY_ENV, DIRECTOR_ENGINE_PROJECT_ENV } from "./engineBridge";
import { discoverDccRuntimeExecutable } from "./dccProviderRegistry";

/**
 * Local engine process operations behind `director_dcc`:
 *
 * - `launchEditor` opens the configured engine project in its editor GUI as a
 *   detached, fire-and-forget process.
 * - `runProject` / `runStatus` / `stopRun` run the configured project (Godot
 *   today), capture a bounded tail of interleaved stdout/stderr, and stop it
 *   with an orderly SIGTERM → SIGKILL escalation.
 *
 * Both operate strictly on the discovered engine executable and the engine
 * project named by DIRECTOR_*_PROJECT — the argument vector is fixed and a
 * request can never substitute its own script or address another project.
 * This is the Director-native equivalent of the community godot-mcp /
 * unity-mcp "launch editor / run project / get debug output" tools, without
 * opening a remote-execute surface.
 */

/** Grace period between SIGTERM and SIGKILL when stopping a run. */
const STOP_ESCALATION_MS = 2_000;

/** Structured error for engine editor-launch and run operations. */
export class DirectorDccEngineRunError extends Error {
  constructor(
    readonly code: DirectorDccEngineRunErrorCode,
    message: string,
    readonly status: number,
    /** Ordered, user-actionable recovery steps. */
    readonly recovery: string[] = [],
  ) {
    super(message);
    this.name = "DirectorDccEngineRunError";
  }
}

interface EngineRunState {
  runId: string;
  provider: DirectorDccEngineId;
  executable: string;
  projectPath: string;
  scene: string | null;
  headless: boolean;
  pid: number | null;
  state: "running" | "exited" | "stopped" | "failed";
  exitCode: number | null;
  startedAtMs: number;
  endedAtMs: number | null;
  output: BoundedTextBuffer;
  stopRequested: boolean;
  child: ReturnType<typeof spawn> | null;
}

/** Options for creating the engine run manager. */
export interface CreateDirectorDccEngineRunManagerOptions {
  /** Environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Byte budget for the captured output tail. */
  maxOutputBytes?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Spawn override for tests. */
  spawnImpl?: typeof spawn;
}

/** Manager for engine editor launches and bounded-output project runs. */
export interface DirectorDccEngineRunManager {
  /** Open the configured engine project in its editor GUI (detached). */
  launchEditor(provider: DirectorDccEngineId): Promise<DirectorDccEngineEditorLaunch>;
  /** Start the configured engine project run (Godot today). */
  runProject(
    provider: DirectorDccEngineId,
    options?: { scene?: string; headless?: boolean },
  ): Promise<DirectorDccEngineRunStatus>;
  /** Read the current or most recent run for one engine. */
  runStatus(provider: DirectorDccEngineId): DirectorDccEngineRunStatus;
  /** Stop the active run with SIGTERM → SIGKILL and report its final status. */
  stopRun(provider: DirectorDccEngineId): Promise<DirectorDccEngineRunStatus>;
}

const RUN_RECOVERY: Record<DirectorDccEngineId, string[]> = {
  godot: [
    "Set DIRECTOR_GODOT_BIN to the godot / godot4 binary (Godot 4.x).",
    "Set DIRECTOR_GODOT_PROJECT to the Godot project directory (contains project.godot).",
  ],
  unity: [
    "Set DIRECTOR_UNITY_BIN to the Unity editor binary.",
    "Set DIRECTOR_UNITY_PROJECT to the Unity project directory (contains Assets/).",
  ],
  unreal: [
    "Set DIRECTOR_UNREAL_EDITOR_BIN to UnrealEditor-Cmd or UnrealEditor.",
    "Set DIRECTOR_UNREAL_PROJECT to the Unreal project directory (contains the .uproject).",
  ],
};

async function isDirectory(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isFile() ?? false;
}

/**
 * Creates the engine run manager used by the `director_dcc`
 * `launch_engine_editor` / `run_engine_project` / `engine_run_status` /
 * `stop_engine_project` operations.
 *
 * @param options - Environment, output budget, clock, and spawn overrides.
 * @returns The manager with launch, run, status, and stop methods.
 */
export function createDirectorDccEngineRunManager(
  options: CreateDirectorDccEngineRunManagerOptions = {},
): DirectorDccEngineRunManager {
  const environment = options.environment ?? process.env;
  const maxOutputBytes = options.maxOutputBytes ?? DIRECTOR_DCC_ENGINE_RUN_MAX_OUTPUT_BYTES;
  const now = options.now ?? Date.now;
  const spawnImpl = options.spawnImpl ?? spawn;
  const runs = new Map<DirectorDccEngineId, EngineRunState>();

  function parseProvider(provider: DirectorDccEngineId): DirectorDccEngineId {
    const parsed = directorDccEngineIdSchema.safeParse(provider);
    if (!parsed.success) {
      throw new DirectorDccEngineRunError(
        "engine_run_invalid",
        `${JSON.stringify(String(provider).slice(0, 120))} is not an engine provider (unreal, unity, godot).`,
        400,
      );
    }
    return parsed.data;
  }

  async function resolveRuntime(provider: DirectorDccEngineId): Promise<{ executable: string; projectPath: string }> {
    const executable = await discoverDccRuntimeExecutable(provider, environment);
    if (!executable) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `No ${provider} executable was found (${DIRECTOR_ENGINE_BINARY_ENV[provider]} or well-known install paths).`,
        503,
        RUN_RECOVERY[provider],
      );
    }
    const configuredProject = environment[DIRECTOR_ENGINE_PROJECT_ENV[provider]]?.trim();
    if (!configuredProject) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `${DIRECTOR_ENGINE_PROJECT_ENV[provider]} does not name the ${provider} project directory.`,
        503,
        RUN_RECOVERY[provider],
      );
    }
    const projectPath = await realpath(resolve(configuredProject)).catch(() => null);
    if (!projectPath || !(await isDirectory(projectPath))) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `${DIRECTOR_ENGINE_PROJECT_ENV[provider]} points at a missing directory: ${configuredProject}.`,
        503,
        RUN_RECOVERY[provider],
      );
    }
    if (provider === "godot" && !(await isFile(join(projectPath, "project.godot")))) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        `No project.godot file was found in ${projectPath}.`,
        503,
        RUN_RECOVERY[provider],
      );
    }
    return { executable, projectPath };
  }

  /**
   * The Unreal probe prefers the console binary (UnrealEditor-Cmd); the GUI
   * editor is its sibling without the -Cmd suffix. Fall back with a warning
   * when the sibling does not exist.
   */
  async function editorExecutableFor(
    provider: DirectorDccEngineId,
    executable: string,
    warnings: string[],
  ): Promise<string> {
    if (provider !== "unreal") return executable;
    const name = basename(executable);
    if (!name.includes("UnrealEditor-Cmd")) return executable;
    const sibling = join(dirname(executable), name.replace("UnrealEditor-Cmd", "UnrealEditor"));
    if (await isFile(sibling)) return sibling;
    warnings.push(
      "UnrealEditor-Cmd is the console binary and no UnrealEditor sibling was found; the editor may open without a GUI.",
    );
    return executable;
  }

  async function editorArgumentsFor(provider: DirectorDccEngineId, projectPath: string): Promise<string[]> {
    if (provider === "godot") return ["--editor", "--path", projectPath];
    if (provider === "unity") return ["-projectPath", projectPath];
    // Unreal opens a .uproject file; require exactly one, mirroring the
    // engine-scene extraction rule.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);
    const projects = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".uproject"))
      .map((entry) => join(projectPath, entry.name));
    if (projects.length !== 1) {
      throw new DirectorDccEngineRunError(
        "engine_run_not_ready",
        projects.length === 0
          ? `No .uproject file was found in ${projectPath}.`
          : `Multiple .uproject files were found in ${projectPath}; keep exactly one.`,
        503,
        RUN_RECOVERY.unreal,
      );
    }
    return [projects[0]!];
  }

  async function launchEditor(provider: DirectorDccEngineId): Promise<DirectorDccEngineEditorLaunch> {
    const parsedProvider = parseProvider(provider);
    const runtime = await resolveRuntime(parsedProvider);
    const warnings: string[] = [];
    const executable = await editorExecutableFor(parsedProvider, runtime.executable, warnings);
    await access(executable);
    const engineArguments = await editorArgumentsFor(parsedProvider, runtime.projectPath);
    const child = spawnImpl(executable, engineArguments, {
      cwd: runtime.projectPath,
      stdio: "ignore",
      detached: true,
      shell: false,
    });
    const pid = child.pid;
    if (!pid) {
      throw new DirectorDccEngineRunError(
        "engine_run_failed",
        `${parsedProvider} editor process did not start.`,
        502,
        RUN_RECOVERY[parsedProvider],
      );
    }
    // Fire-and-forget: the editor belongs to the user, not the gateway.
    child.unref();
    return directorDccEngineEditorLaunchSchema.parse({
      contract: DIRECTOR_DCC_ENGINE_EDITOR_LAUNCH_CONTRACT,
      provider: parsedProvider,
      executable,
      projectPath: runtime.projectPath,
      pid,
      launchedAtMs: now(),
      warnings,
    });
  }

  function statusOf(state: EngineRunState): DirectorDccEngineRunStatus {
    return directorDccEngineRunStatusSchema.parse({
      contract: DIRECTOR_DCC_ENGINE_RUN_CONTRACT,
      provider: state.provider,
      runId: state.runId,
      executable: state.executable,
      projectPath: state.projectPath,
      scene: state.scene,
      headless: state.headless,
      pid: state.pid,
      state: state.state,
      exitCode: state.exitCode,
      startedAtMs: state.startedAtMs,
      endedAtMs: state.endedAtMs,
      output: state.output.toString(),
      outputTruncated: state.output.wasTruncated,
    });
  }

  async function runProject(
    provider: DirectorDccEngineId,
    runOptions: { scene?: string; headless?: boolean } = {},
  ): Promise<DirectorDccEngineRunStatus> {
    const parsedProvider = parseProvider(provider);
    if (parsedProvider !== "godot") {
      throw new DirectorDccEngineRunError(
        "engine_run_unsupported",
        `${parsedProvider} project runs are not supported yet: Unity play mode and Unreal -game runs need engine-side support Director does not claim. Use launch_engine_editor to open the project, or send_to_engine for the headless handoff.`,
        501,
        ["Run the project inside the engine editor after launch_engine_editor.", "Use send_to_engine for the reviewed headless round trip."],
      );
    }
    const active = runs.get(parsedProvider);
    if (active && active.state === "running") {
      throw new DirectorDccEngineRunError(
        "engine_run_active",
        `A ${parsedProvider} run is already active (run ${active.runId}); stop it first with stop_engine_project.`,
        409,
      );
    }
    const scene = runOptions.scene === undefined ? null : directorDccGodotRunSceneSchema.parse(runOptions.scene);
    const runtime = await resolveRuntime(parsedProvider);
    const engineArguments = [
      "--path",
      runtime.projectPath,
      ...(runOptions.headless ? ["--headless"] : []),
      ...(scene ? [scene] : []),
    ];
    const output = new BoundedTextBuffer(maxOutputBytes);
    const child = spawnImpl(runtime.executable, engineArguments, {
      cwd: runtime.projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    const state: EngineRunState = {
      runId: `${parsedProvider}-run-${randomUUID()}`,
      provider: parsedProvider,
      executable: runtime.executable,
      projectPath: runtime.projectPath,
      scene,
      headless: runOptions.headless === true,
      pid: child.pid ?? null,
      state: "running",
      exitCode: null,
      startedAtMs: now(),
      endedAtMs: null,
      output,
      stopRequested: false,
      child,
    };
    if (!child.pid) {
      state.state = "failed";
      state.endedAtMs = now();
      state.child = null;
      runs.set(parsedProvider, state);
      throw new DirectorDccEngineRunError(
        "engine_run_failed",
        `${parsedProvider} run process did not start.`,
        502,
        RUN_RECOVERY[parsedProvider],
      );
    }
    child.stdout?.on("data", (chunk: Buffer) => output.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.append(chunk));
    child.on("error", (error: Error) => {
      output.append(`\n[director] run process error: ${error.message}\n`);
      if (state.state === "running") {
        state.state = "failed";
        state.endedAtMs = now();
        state.child = null;
      }
    });
    child.on("close", (code, signal) => {
      if (state.state === "running") {
        state.state = state.stopRequested ? "stopped" : code === 0 ? "exited" : "failed";
      }
      state.exitCode = code ?? null;
      if (signal) output.append(`\n[director] run terminated by ${signal}\n`);
      state.endedAtMs = now();
      state.child = null;
    });
    runs.set(parsedProvider, state);
    return statusOf(state);
  }

  function runStatus(provider: DirectorDccEngineId): DirectorDccEngineRunStatus {
    const parsedProvider = parseProvider(provider);
    const state = runs.get(parsedProvider);
    if (!state) {
      throw new DirectorDccEngineRunError(
        "engine_run_unknown",
        `No ${parsedProvider} project run has been started; start one with run_engine_project.`,
        404,
      );
    }
    return statusOf(state);
  }

  async function stopRun(provider: DirectorDccEngineId): Promise<DirectorDccEngineRunStatus> {
    const parsedProvider = parseProvider(provider);
    const state = runs.get(parsedProvider);
    if (!state) {
      throw new DirectorDccEngineRunError(
        "engine_run_unknown",
        `No ${parsedProvider} project run has been started; start one with run_engine_project.`,
        404,
      );
    }
    const child = state.child;
    if (state.state !== "running" || !child?.pid) return statusOf(state);
    state.stopRequested = true;
    const killTree = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when the process group is gone.
        }
      }
      child.kill(signal);
    };
    await new Promise<void>((resolveStop) => {
      const escalation = setTimeout(() => killTree("SIGKILL"), STOP_ESCALATION_MS);
      child.once("close", () => {
        clearTimeout(escalation);
        resolveStop();
      });
      killTree("SIGTERM");
    });
    return statusOf(state);
  }

  return { launchEditor, runProject, runStatus, stopRun };
}
