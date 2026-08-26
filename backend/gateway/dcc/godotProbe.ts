import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { directorGodotConnectorHealthSchema, type DirectorGodotConnectorHealth } from "@director/dcc-protocol";

/**
 * Godot-namespaced probe helpers for the provider-neutral engine bridge.
 *
 * Everything Godot-specific about readiness lives here: executable discovery
 * defaults for macOS, Linux, and Windows, the Godot 4.x version gate, the
 * enabled-addon check inside the configured project, and the fixed-entry
 * `--mode health` JSON probe. `nativeReady` for Godot requires all of:
 * connector source, a Godot 4 executable, the enabled addon inside
 * `DIRECTOR_GODOT_PROJECT`, and a valid connector health JSON line.
 */

/** PATH command names probed for a Godot 4 executable (Windows PATH needs the .exe names). */
export const GODOT_EXECUTABLE_COMMANDS: readonly string[] = Object.freeze([
  "godot",
  "godot4",
  "godot4.5",
  "godot4.4",
  "godot4.3",
  "godot4.2",
  "godot.exe",
  "godot4.exe",
]);

/**
 * Well-known absolute install locations probed when no environment variable
 * points at the executable. Covers macOS (.app bundle), Linux distribution,
 * Flatpak, and Snap layouts, plus the conventional Windows locations; Windows
 * portable unzips should use `DIRECTOR_GODOT_BIN` instead.
 */
export const GODOT_DEFAULT_EXECUTABLE_PATHS: readonly string[] = Object.freeze([
  // macOS
  "/Applications/Godot.app/Contents/MacOS/Godot",
  // Linux distribution packages and manual installs
  "/usr/bin/godot4",
  "/usr/bin/godot",
  "/usr/local/bin/godot4",
  "/usr/local/bin/godot",
  "/opt/godot/godot4",
  "/opt/godot/godot",
  // Flatpak and Snap exports
  "/var/lib/flatpak/exports/bin/org.godotengine.Godot",
  "/snap/bin/godot4",
  "/snap/bin/godot",
  // Windows (installer-less portable builds usually need DIRECTOR_GODOT_BIN)
  "C:\\Program Files\\Godot\\Godot.exe",
  "C:\\Program Files\\Godot\\godot4.exe",
]);

/** The fixed Godot headless entry script inside the engine project; never request-supplied. */
export const GODOT_HEADLESS_ENTRY = "res://addons/director_bridge/director_headless.gd";

/** Maximum time for the fixed-entry `--mode health` probe. */
export const GODOT_CONNECTOR_HEALTH_TIMEOUT_MS = 60_000;

/**
 * Maximum bytes for one candidate health JSON line. The genuine health line
 * is under 200 bytes; a connector (or wrapper script) that floods stdout with
 * an enormous JSON blob is treated as unhealthy instead of being parsed.
 */
export const GODOT_HEALTH_LINE_MAX_BYTES = 4_096;

/**
 * Parses the major version out of a Godot version string.
 *
 * Accepts both the raw `godot --version` shape (`4.3.stable.official.77dcf97d8`)
 * and the connector health shape (`Godot 4.3.2`).
 *
 * @param version - The version string to parse.
 * @returns The major version number, or null when the string has no leading version.
 */
export function parseGodotMajorVersion(version: string): number | null {
  const match = /(?:^|[^\d.])(\d+)\.\d/.exec(version.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(major) ? major : null;
}

/** The addon path that must be enabled in the Godot project settings. */
const GODOT_PLUGIN_CFG = "res://addons/director_bridge/plugin.cfg";

/**
 * Checks that the Director Bridge addon is enabled in the Godot project's
 * `project.godot` (`[editor_plugins] enabled=PackedStringArray(...)`).
 * Detecting the copied addon files alone is only `installed`; readiness
 * additionally requires this enabled entry.
 *
 * @param projectDirectory - The configured Godot project directory.
 * @returns Whether the addon is enabled, plus a human-readable detail.
 */
export async function checkGodotAddonEnabled(projectDirectory: string): Promise<{ ok: boolean; detail: string }> {
  const projectFile = resolve(projectDirectory, "project.godot");
  let contents: string;
  try {
    contents = await readFile(projectFile, "utf8");
  } catch {
    return { ok: false, detail: `Could not read ${projectFile}.` };
  }
  const enabledSection = /\[editor_plugins\][^[]*/.exec(contents)?.[0] ?? "";
  if (enabledSection.includes(GODOT_PLUGIN_CFG)) {
    return { ok: true, detail: `Director Bridge is enabled in project.godot (${GODOT_PLUGIN_CFG}).` };
  }
  return {
    ok: false,
    detail:
      "Director Bridge is copied into the project but not enabled; " +
      "enable it in Project → Project Settings → Plugins (project.godot [editor_plugins]).",
  };
}

/** The result of the fixed-entry connector health probe. */
export interface GodotConnectorHealthProbeResult {
  ok: boolean;
  detail: string;
  /** The validated health line when the probe succeeded. */
  health: DirectorGodotConnectorHealth | null;
}

/** Minimal process-runner shape shared with the engine bridge. */
export type GodotHealthProcessRunner = (
  executable: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

/** Builds the fixed argument array for the `--mode health` probe. */
export function godotHealthProbeArguments(projectDirectory: string): string[] {
  return ["--headless", "--path", projectDirectory, "--script", GODOT_HEADLESS_ENTRY, "--", "--mode", "health"];
}

function extractHealthLine(stdout: string): DirectorGodotConnectorHealth | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}") && line.length <= GODOT_HEALTH_LINE_MAX_BYTES);
  // Godot prints engine banners before script output; scan from the last line.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    const validated = directorGodotConnectorHealthSchema.safeParse(parsed);
    if (validated.success) return validated.data;
  }
  return null;
}

/**
 * Runs the fixed Godot headless entry in `--mode health` and validates the
 * JSON line it prints. The probe enforces Godot 4.x (the connector reports the
 * engine's own version info) and cross-checks the installed addon's connector
 * version against the workspace connector manifest, so a stale addon copy in
 * the user's project fails readiness instead of failing mid-job.
 *
 * @param options - Executable, project directory, expected connector version, and runner.
 * @returns The probe outcome with a human-readable detail.
 */
export async function probeGodotConnectorHealth(options: {
  executable: string;
  projectDirectory: string;
  expectedConnectorVersion: string | null;
  runProcess: GodotHealthProcessRunner;
  timeoutMs?: number;
}): Promise<GodotConnectorHealthProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await options.runProcess(
      options.executable,
      godotHealthProbeArguments(options.projectDirectory),
      options.timeoutMs ?? GODOT_CONNECTOR_HEALTH_TIMEOUT_MS,
    ));
  } catch (error) {
    return {
      ok: false,
      detail: `Godot connector health probe failed to run: ${error instanceof Error ? error.message : String(error)}`,
      health: null,
    };
  }
  const health = extractHealthLine(stdout);
  if (!health) {
    return {
      ok: false,
      detail: "Godot connector health probe did not print a valid health JSON line.",
      health: null,
    };
  }
  const major = parseGodotMajorVersion(health.hostVersion);
  if (major !== 4) {
    return {
      ok: false,
      detail: `Director requires Godot 4.x; the connector reported "${health.hostVersion}".`,
      health,
    };
  }
  if (options.expectedConnectorVersion && health.connectorVersion !== options.expectedConnectorVersion) {
    return {
      ok: false,
      detail:
        `The installed addon reports connector ${health.connectorVersion} but the workspace ` +
        `connector is ${options.expectedConnectorVersion}; update the addon copy in the project.`,
      health,
    };
  }
  return {
    ok: true,
    detail: `Connector health OK (${health.hostVersion}, connector ${health.connectorVersion}).`,
    health,
  };
}
