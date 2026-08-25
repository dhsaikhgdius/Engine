import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DIRECTOR_DCC_CONNECTOR_MANIFEST_CONTRACT,
  DIRECTOR_DCC_ENGINE_HEALTH_CONTRACT,
  DIRECTOR_DCC_ENGINE_SEND_CONTRACT,
  directorDccConnectorManifestSchema,
  directorDccEngineDiagnosticsSchema,
  directorDccEngineHealthSchema,
  directorDccEngineIdSchema,
  directorDccEngineReportSchema,
  directorDccEngineSendResultSchema,
  getDirectorDccProviderDescriptor,
  type DirectorDccConnectorManifest,
  type DirectorDccEngineDiagnostics,
  type DirectorDccEngineHealth,
  type DirectorDccEngineId,
  type DirectorDccEngineSendResult,
  type DirectorDccPortableExchangeFormat,
} from "@director/dcc-protocol";
import type { DirectorProject } from "@director/project-schema";
import type { DirectorDccExchangePackager } from "./dccExchangePackage";

/** Environment variable naming the engine editor binary, per engine. */
export const DIRECTOR_ENGINE_BINARY_ENV: Record<DirectorDccEngineId, string> = {
  unreal: "DIRECTOR_UNREAL_EDITOR_BIN",
  unity: "DIRECTOR_UNITY_BIN",
  godot: "DIRECTOR_GODOT_BIN",
};

/** Environment variable naming the engine project that hosts the Director connector. */
export const DIRECTOR_ENGINE_PROJECT_ENV: Record<DirectorDccEngineId, string> = {
  unreal: "DIRECTOR_UNREAL_PROJECT",
  unity: "DIRECTOR_UNITY_PROJECT",
  godot: "DIRECTOR_GODOT_PROJECT",
};

type EngineRuntimeProbe = {
  commands: string[];
  defaultPaths: string[];
};

const ENGINE_RUNTIME_PROBES: Record<DirectorDccEngineId, EngineRuntimeProbe> = {
  unreal: {
    commands: ["UnrealEditor-Cmd", "UnrealEditor"],
    defaultPaths: [
      "/Users/Shared/Epic Games/UE_5.6/Engine/Binaries/Mac/UnrealEditor-Cmd",
      "/Users/Shared/Epic Games/UE_5.5/Engine/Binaries/Mac/UnrealEditor-Cmd",
      "/Users/Shared/Epic Games/UE_5.4/Engine/Binaries/Mac/UnrealEditor-Cmd",
    ],
  },
  unity: {
    commands: ["Unity", "unity", "unityhub-editor"],
    defaultPaths: ["/Applications/Unity/Unity.app/Contents/MacOS/Unity"],
  },
  godot: {
    commands: ["godot", "godot4", "godot4.4", "godot4.3"],
    defaultPaths: ["/Applications/Godot.app/Contents/MacOS/Godot"],
  },
};

/** Installed-connector files checked inside the user's engine project. */
const ENGINE_PROJECT_CONNECTOR_FILES: Record<DirectorDccEngineId, string[]> = {
  unreal: [
    "Plugins/DirectorBridge/DirectorBridge.uplugin",
    "Plugins/DirectorBridge/Content/Python/director_headless.py",
  ],
  unity: ["Packages/com.director.bridge/package.json"],
  godot: ["addons/director_bridge/plugin.cfg", "addons/director_bridge/director_headless.gd"],
};

/** Fixed Unity batch-mode entry method; never taken from a request. */
const UNITY_IMPORT_METHOD = "Director.Bridge.Editor.DirectorBridgeCli.Import";

/** Fixed Godot headless entry script inside the engine project; never request-supplied. */
const GODOT_HEADLESS_ENTRY = "res://addons/director_bridge/director_headless.gd";

/** Fixed Unreal headless entry script inside the engine project; never request-supplied. */
const UNREAL_HEADLESS_ENTRY = "Plugins/DirectorBridge/Content/Python/director_headless.py";

const MAX_PROCESS_OUTPUT = 256 * 1024;
const DEFAULT_JOB_TIMEOUT_MS = 900_000;
const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TTL_MS = 15_000;

/** Machine-readable error codes for engine bridge failures. */
export type DirectorDccEngineBridgeErrorCode =
  "engine_not_ready" | "engine_job_failed" | "engine_report_invalid" | "engine_provider_invalid";

/**
 * An error thrown by the engine bridge, carrying an HTTP status, a
 * machine-readable code, and structured not-ready diagnostics when relevant.
 */
export class DirectorDccEngineBridgeError extends Error {
  constructor(
    readonly code: DirectorDccEngineBridgeErrorCode,
    message: string,
    readonly status: number,
    /** Structured diagnostics for engine_not_ready failures. */
    readonly diagnostics?: DirectorDccEngineDiagnostics,
  ) {
    super(message);
    this.name = "DirectorDccEngineBridgeError";
  }
}

/** Options for a single headless send-to-engine job. */
export interface DirectorDccEngineSendOptions {
  provider: DirectorDccEngineId;
  formats?: DirectorDccPortableExchangeFormat[];
  cameraId?: string;
  frame?: number;
}

/**
 * The provider-neutral engine connector runtime, modeled on BlenderBridge:
 * probe install and version, run a versioned connector health check, and
 * execute headless send-to-host jobs through fixed connector entry points.
 */
export interface DirectorDccEngineBridge {
  /** Run (or reuse the cached) health probe for one engine. */
  health(provider: DirectorDccEngineId): Promise<DirectorDccEngineHealth>;
  /** Structured diagnostics derived from the current health state. */
  diagnostics(provider: DirectorDccEngineId): Promise<DirectorDccEngineDiagnostics>;
  /**
   * Export the live project as an exchange package and import it into the
   * engine through the fixed headless connector entry point.
   * Throws `engine_not_ready` with structured diagnostics when the connector
   * health check fails.
   */
  send(project: DirectorProject, options: DirectorDccEngineSendOptions): Promise<DirectorDccEngineSendResult>;
  /** The private job root that holds this engine's headless job artifacts. */
  jobRoot(provider: DirectorDccEngineId): string;
}

/** A minimal process runner so tests can fake engine executions. */
export type EngineProcessRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

/** Configuration for creating the engine bridge. */
export interface CreateDirectorDccEngineBridgeOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Directory under which DCC job data is persisted. */
  dataDirectory: string;
  /** The exchange packager used to build the portable package for the engine. */
  exchangePackager: DirectorDccExchangePackager;
  /** Optional environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Optional process runner override for tests. */
  runProcess?: EngineProcessRunner;
  /** Optional host version probe override for tests. */
  probeHostVersion?: (provider: DirectorDccEngineId, executable: string) => Promise<string | null>;
  /** Maximum time in milliseconds for a headless engine job. */
  jobTimeoutMs?: number;
  /** Health result cache lifetime in milliseconds (0 disables caching). */
  healthTtlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_PROCESS_OUTPUT ? combined : combined.slice(combined.length - MAX_PROCESS_OUTPUT);
}

async function defaultRunProcess(
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
        rejectProcess(new Error(`Engine job exceeded ${timeoutMs} ms.`));
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
      else rejectProcess(new Error(`Engine process exited with code ${code ?? "unknown"}. ${stderr || stdout}`));
    });
  });
}

async function isFile(path: string) {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function discoverOnPath(commands: readonly string[], environment: NodeJS.ProcessEnv) {
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const command of commands) {
      const candidate = resolve(directory, command);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function discoverEngineExecutable(provider: DirectorDccEngineId, environment: NodeJS.ProcessEnv) {
  const configured = environment[DIRECTOR_ENGINE_BINARY_ENV[provider]]?.trim();
  const probe = ENGINE_RUNTIME_PROBES[provider];
  const candidates = [configured, ...probe.defaultPaths].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return discoverOnPath(probe.commands, environment);
}

const unrealBuildVersionCandidates = (executable: string) => [
  // Engine/Binaries/<Platform>/UnrealEditor-Cmd -> Engine/Build/Build.version
  resolve(dirname(executable), "..", "..", "Build", "Build.version"),
  // Mac .app bundle binaries sit one directory deeper.
  resolve(dirname(executable), "..", "..", "..", "Build", "Build.version"),
];

async function defaultProbeHostVersion(
  provider: DirectorDccEngineId,
  executable: string,
  runProcess: EngineProcessRunner,
): Promise<string | null> {
  if (provider === "unreal") {
    // Reading Build.version is fast and avoids booting the editor for a probe.
    for (const candidate of unrealBuildVersionCandidates(executable)) {
      try {
        const parsed = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
        const major = parsed.MajorVersion;
        const minor = parsed.MinorVersion;
        const patch = parsed.PatchVersion;
        if (typeof major === "number" && typeof minor === "number") {
          return `Unreal Engine ${major}.${minor}${typeof patch === "number" ? `.${patch}` : ""}`;
        }
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }
  const args = provider === "unity" ? ["-version"] : ["--version"];
  try {
    const { stdout } = await runProcess(executable, args, DEFAULT_VERSION_PROBE_TIMEOUT_MS);
    const firstLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ?? null;
  } catch {
    return null;
  }
}

interface EngineProjectResolution {
  ok: boolean;
  projectPath: string | null;
  projectDirectory: string | null;
  detail: string;
}

async function resolveEngineProject(
  provider: DirectorDccEngineId,
  environment: NodeJS.ProcessEnv,
): Promise<EngineProjectResolution> {
  const environmentVariable = DIRECTOR_ENGINE_PROJECT_ENV[provider];
  const configured = environment[environmentVariable]?.trim();
  if (!configured) {
    return {
      ok: false,
      projectPath: null,
      projectDirectory: null,
      detail: `${environmentVariable} is not set.`,
    };
  }
  const projectPath = resolve(configured);
  if (provider === "unreal") {
    if (!projectPath.toLowerCase().endsWith(".uproject") || !(await isFile(projectPath))) {
      return {
        ok: false,
        projectPath,
        projectDirectory: null,
        detail: `${environmentVariable} must point to an existing .uproject file.`,
      };
    }
    return { ok: true, projectPath, projectDirectory: dirname(projectPath), detail: projectPath };
  }
  if (!(await isDirectory(projectPath))) {
    return {
      ok: false,
      projectPath,
      projectDirectory: null,
      detail: `${environmentVariable} must point to an existing project directory.`,
    };
  }
  const marker =
    provider === "unity"
      ? resolve(projectPath, "ProjectSettings", "ProjectVersion.txt")
      : resolve(projectPath, "project.godot");
  if (!(await isFile(marker))) {
    return {
      ok: false,
      projectPath,
      projectDirectory: null,
      detail: `${projectPath} is not a ${provider === "unity" ? "Unity" : "Godot"} project (missing ${relative(projectPath, marker)}).`,
    };
  }
  return { ok: true, projectPath, projectDirectory: projectPath, detail: projectPath };
}

async function checkInstalledConnector(
  provider: DirectorDccEngineId,
  projectDirectory: string,
): Promise<{ ok: boolean; detail: string }> {
  for (const relativePath of ENGINE_PROJECT_CONNECTOR_FILES[provider]) {
    const candidate = resolve(projectDirectory, relativePath);
    if (!(await isFile(candidate))) {
      return { ok: false, detail: `Missing installed Director connector file: ${relativePath}.` };
    }
  }
  return { ok: true, detail: `Director connector is installed in ${projectDirectory}.` };
}

const ENGINE_RECOVERY_HINTS: Record<DirectorDccEngineId, Record<string, string>> = {
  unreal: {
    executable: "Set DIRECTOR_UNREAL_EDITOR_BIN to the UnrealEditor-Cmd binary of a licensed Unreal Engine install.",
    engine_project: "Set DIRECTOR_UNREAL_PROJECT to the .uproject file that should receive Director scenes.",
    project_connector:
      "Copy integrations/unreal/plugins/DirectorBridge into <Project>/Plugins and enable it (with the Python Editor Script Plugin) in the Unreal editor.",
  },
  unity: {
    executable: "Set DIRECTOR_UNITY_BIN to the Unity editor binary that matches the target project.",
    engine_project: "Set DIRECTOR_UNITY_PROJECT to the Unity project directory that should receive Director scenes.",
    project_connector:
      "Copy integrations/unity/com.director.bridge into <Project>/Packages (or reference it from Packages/manifest.json).",
  },
  godot: {
    executable: "Set DIRECTOR_GODOT_BIN to the godot / godot4 binary (Godot 4.2 or newer).",
    engine_project: "Set DIRECTOR_GODOT_PROJECT to the Godot project directory that should receive Director scenes.",
    project_connector:
      "Copy integrations/godot/addons/director_bridge into <Project>/addons and enable the plugin in Project Settings.",
  },
};

function quoteForUnrealScriptArgument(path: string): string {
  return `"${path.replaceAll('"', "")}"`;
}

/**
 * Creates the provider-neutral engine bridge for Unreal, Unity, and Godot.
 *
 * The bridge never reports `ready` unless the Director-authored connector
 * source exists in the workspace, the engine executable is found and
 * versioned, and the configured engine project contains the installed
 * connector. Headless jobs always run fixed connector entry points into a
 * private job directory; a request can never supply its own script.
 *
 * @param options - Workspace, data directory, exchange packager, and test overrides.
 * @returns The engine bridge.
 */
export function createDirectorDccEngineBridge(options: CreateDirectorDccEngineBridgeOptions): DirectorDccEngineBridge {
  const workspaceRoot = resolve(options.workspaceRoot);
  const dataDirectory = resolve(options.dataDirectory);
  const environment = options.environment ?? process.env;
  const runProcess = options.runProcess ?? defaultRunProcess;
  const probeHostVersion =
    options.probeHostVersion ??
    ((provider: DirectorDccEngineId, executable: string) => defaultProbeHostVersion(provider, executable, runProcess));
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const healthTtlMs = options.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  const now = options.now ?? Date.now;
  const healthCache = new Map<DirectorDccEngineId, { at: number; health: DirectorDccEngineHealth }>();

  function connectorDirectory(provider: DirectorDccEngineId) {
    return resolve(workspaceRoot, "integrations", provider);
  }

  async function readConnectorManifest(
    provider: DirectorDccEngineId,
  ): Promise<{ manifest: DirectorDccConnectorManifest | null; detail: string }> {
    const manifestPath = resolve(connectorDirectory(provider), "connector.json");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      return { manifest: null, detail: `Connector manifest is missing: ${manifestPath}.` };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return { manifest: null, detail: "Connector manifest is not valid JSON." };
    }
    const parsed = directorDccConnectorManifestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { manifest: null, detail: `Connector manifest is invalid: ${parsed.error.issues[0]?.message ?? ""}` };
    }
    if (parsed.data.contract !== DIRECTOR_DCC_CONNECTOR_MANIFEST_CONTRACT || parsed.data.provider !== provider) {
      return { manifest: null, detail: "Connector manifest does not describe this provider." };
    }
    return { manifest: parsed.data, detail: `connector ${parsed.data.version} (${parsed.data.hostRequirement})` };
  }

  async function runHealth(provider: DirectorDccEngineId): Promise<DirectorDccEngineHealth> {
    const checks: DirectorDccEngineHealth["checks"] = [];
    const warnings: string[] = [];
    const recovery: string[] = [];
    const hints = ENGINE_RECOVERY_HINTS[provider];
    const descriptor = getDirectorDccProviderDescriptor(provider);

    const { manifest, detail: manifestDetail } = await readConnectorManifest(provider);
    checks.push({ id: "connector_manifest", ok: Boolean(manifest), detail: manifestDetail });
    if (!manifest) {
      warnings.push(`Director ${descriptor.label} connector manifest is unavailable.`);
      recovery.push(`Restore integrations/${provider}/connector.json from the Director repository.`);
    }

    let entriesOk = Boolean(manifest);
    if (manifest) {
      const rootDirectory = connectorDirectory(provider);
      for (const entry of Object.values(manifest.entryPoints)) {
        const candidate = resolve(rootDirectory, entry);
        if (!isInside(rootDirectory, candidate) || !(await isFile(candidate))) {
          entriesOk = false;
          checks.push({ id: "connector_entry", ok: false, detail: `Connector entry point is missing: ${entry}.` });
          warnings.push(`Director ${descriptor.label} connector source is incomplete (${entry}).`);
          recovery.push(`Restore integrations/${provider} from the Director repository.`);
          break;
        }
      }
      if (entriesOk) {
        checks.push({ id: "connector_entry", ok: true, detail: "All connector entry points are present." });
      }
    }

    const executable = await discoverEngineExecutable(provider, environment);
    checks.push({
      id: "executable",
      ok: Boolean(executable),
      detail: executable ?? `${descriptor.label} executable was not found.`,
    });
    if (!executable) {
      warnings.push(`${descriptor.label} executable was not detected.`);
      recovery.push(hints.executable!);
    }

    let hostVersion: string | null = null;
    if (executable) {
      hostVersion = await probeHostVersion(provider, executable);
      checks.push({
        id: "host_version",
        ok: Boolean(hostVersion),
        detail: hostVersion ?? `${descriptor.label} version probe failed.`,
      });
      if (!hostVersion) {
        warnings.push(`${descriptor.label} was found but its version probe failed.`);
        recovery.push(hints.executable!);
      }
    }

    const project = await resolveEngineProject(provider, environment);
    checks.push({ id: "engine_project", ok: project.ok, detail: project.detail });
    if (!project.ok) {
      warnings.push(`No ${descriptor.label} project is configured for the Director connector.`);
      recovery.push(hints.engine_project!);
    }

    let projectConnectorOk = false;
    if (project.ok && project.projectDirectory) {
      const installed = await checkInstalledConnector(provider, project.projectDirectory);
      projectConnectorOk = installed.ok;
      checks.push({ id: "project_connector", ok: installed.ok, detail: installed.detail });
      if (!installed.ok) {
        warnings.push(`The Director connector is not installed in the configured ${descriptor.label} project.`);
        recovery.push(hints.project_connector!);
      }
    }

    const ready =
      Boolean(manifest) && entriesOk && Boolean(executable) && Boolean(hostVersion) && project.ok && projectConnectorOk;
    if (!ready && !recovery.includes(`Portable ${descriptor.exchangeFormats.join("/")} exchange remains available.`)) {
      recovery.push(`Portable ${descriptor.exchangeFormats.join("/")} exchange remains available.`);
    }

    return directorDccEngineHealthSchema.parse({
      contract: DIRECTOR_DCC_ENGINE_HEALTH_CONTRACT,
      provider,
      ready,
      executable,
      hostVersion,
      connectorVersion: manifest?.version ?? null,
      connectorDirectory: `integrations/${provider}`,
      projectPath: project.projectPath,
      checks,
      warnings,
      recovery: [...new Set(recovery)],
    });
  }

  async function health(providerInput: DirectorDccEngineId): Promise<DirectorDccEngineHealth> {
    const provider = directorDccEngineIdSchema.parse(providerInput);
    const cached = healthCache.get(provider);
    if (cached && healthTtlMs > 0 && now() - cached.at < healthTtlMs) return cached.health;
    const result = await runHealth(provider);
    healthCache.set(provider, { at: now(), health: result });
    return result;
  }

  async function diagnostics(provider: DirectorDccEngineId): Promise<DirectorDccEngineDiagnostics> {
    const current = await health(provider);
    return directorDccEngineDiagnosticsSchema.parse({
      provider: current.provider,
      mode: current.ready ? "native" : "exchange",
      ready: current.ready,
      warnings: current.warnings,
      recovery: current.recovery,
    });
  }

  function jobRoot(provider: DirectorDccEngineId) {
    return resolve(dataDirectory, "dcc-jobs", directorDccEngineIdSchema.parse(provider));
  }

  function engineArguments(
    provider: DirectorDccEngineId,
    projectResolution: { projectPath: string; projectDirectory: string },
    packageDirectory: string,
    reportPath: string,
    returnDirectory: string,
    logPath: string,
  ): string[] {
    if (provider === "unreal") {
      const script = resolve(projectResolution.projectDirectory, UNREAL_HEADLESS_ENTRY);
      const scriptArguments = [
        quoteForUnrealScriptArgument(script),
        "--mode",
        "import",
        "--package",
        quoteForUnrealScriptArgument(packageDirectory),
        "--report",
        quoteForUnrealScriptArgument(reportPath),
        "--return-dir",
        quoteForUnrealScriptArgument(returnDirectory),
      ].join(" ");
      return [
        projectResolution.projectPath,
        `-ExecutePythonScript=${scriptArguments}`,
        "-unattended",
        "-nopause",
        "-nosplash",
        "-nullrhi",
        "-stdout",
      ];
    }
    if (provider === "unity") {
      return [
        "-batchmode",
        "-nographics",
        "-quit",
        "-projectPath",
        projectResolution.projectDirectory,
        "-executeMethod",
        UNITY_IMPORT_METHOD,
        "-logFile",
        logPath,
        "-directorPackage",
        packageDirectory,
        "-directorReport",
        reportPath,
        "-directorReturnDir",
        returnDirectory,
      ];
    }
    return [
      "--headless",
      "--path",
      projectResolution.projectDirectory,
      "--script",
      GODOT_HEADLESS_ENTRY,
      "--",
      "--mode",
      "import",
      "--package",
      packageDirectory,
      "--report",
      reportPath,
      "--return-dir",
      returnDirectory,
    ];
  }

  async function send(
    project: DirectorProject,
    sendOptions: DirectorDccEngineSendOptions,
  ): Promise<DirectorDccEngineSendResult> {
    const provider = directorDccEngineIdSchema.parse(sendOptions.provider);
    const currentHealth = await health(provider);
    if (!currentHealth.ready || !currentHealth.executable || !currentHealth.projectPath) {
      throw new DirectorDccEngineBridgeError(
        "engine_not_ready",
        `${provider} native connector is not ready; portable exchange export remains available.`,
        409,
        await diagnostics(provider),
      );
    }
    const projectDirectory = provider === "unreal" ? dirname(currentHealth.projectPath) : currentHealth.projectPath;

    const exchange = await options.exchangePackager.exportPackage(project, {
      provider,
      formats: sendOptions.formats,
      cameraId: sendOptions.cameraId,
      frame: sendOptions.frame,
    });

    const providerJobRoot = jobRoot(provider);
    const jobDirectory = resolve(providerJobRoot, exchange.jobId);
    if (!isInside(providerJobRoot, jobDirectory)) {
      throw new DirectorDccEngineBridgeError("engine_job_failed", "Engine job path escaped the job root.", 500);
    }
    await mkdir(jobDirectory, { recursive: true });
    const reportPath = resolve(jobDirectory, "report.json");
    const returnDirectory = resolve(jobDirectory, "return");
    const logPath = resolve(jobDirectory, "host.log");

    const args = engineArguments(
      provider,
      { projectPath: currentHealth.projectPath, projectDirectory },
      exchange.packagePath,
      reportPath,
      returnDirectory,
      logPath,
    );
    try {
      await runProcess(currentHealth.executable, args, jobTimeoutMs);
    } catch (error) {
      throw new DirectorDccEngineBridgeError(
        "engine_job_failed",
        `${provider} headless import failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }

    let rawReport: unknown;
    try {
      rawReport = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    } catch {
      throw new DirectorDccEngineBridgeError(
        "engine_report_invalid",
        `${provider} connector did not write a readable report.json.`,
        502,
      );
    }
    if (
      rawReport &&
      typeof rawReport === "object" &&
      !Array.isArray(rawReport) &&
      (rawReport as Record<string, unknown>).ok === false
    ) {
      const message = (rawReport as Record<string, unknown>).error;
      throw new DirectorDccEngineBridgeError(
        "engine_job_failed",
        `${provider} connector reported a failure: ${typeof message === "string" ? message : "unknown error"}`,
        502,
      );
    }
    const parsedReport = directorDccEngineReportSchema.safeParse(rawReport);
    if (!parsedReport.success) {
      throw new DirectorDccEngineBridgeError(
        "engine_report_invalid",
        `${provider} connector report failed validation: ${parsedReport.error.issues[0]?.message ?? "invalid"}`,
        502,
      );
    }
    const report = parsedReport.data;
    if (report.provider !== provider || report.packageId !== exchange.jobId) {
      throw new DirectorDccEngineBridgeError(
        "engine_report_invalid",
        `${provider} connector report does not match the exchange package that was sent.`,
        502,
      );
    }
    if (report.sourceRevision !== exchange.sourceRevision) {
      throw new DirectorDccEngineBridgeError(
        "engine_report_invalid",
        `${provider} connector report references a different source revision.`,
        502,
      );
    }

    let returnPackagePath: string | null = null;
    if (report.returnPackageDir) {
      const candidate = resolve(jobDirectory, report.returnPackageDir);
      if (isInside(jobDirectory, candidate) && (await isDirectory(candidate))) {
        returnPackagePath = candidate;
      }
    }

    return directorDccEngineSendResultSchema.parse({
      contract: DIRECTOR_DCC_ENGINE_SEND_CONTRACT,
      jobId: exchange.jobId,
      provider,
      packagePath: exchange.packagePath,
      manifestPath: exchange.manifestPath,
      manifestSha256: exchange.manifestSha256,
      packageDigest: exchange.packageDigest,
      sourceRevision: exchange.sourceRevision,
      reportPath,
      report,
      returnPackagePath,
      warnings: [...exchange.warnings, ...report.warnings],
    });
  }

  return { health, diagnostics, send, jobRoot };
}
