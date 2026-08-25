import { readdir } from "node:fs/promises";
import { posix, win32 } from "node:path";

/**
 * Optional environment variable naming a custom Unity Hub editor root
 * (the directory that contains one sub-directory per installed editor
 * version). Unity Hub lets users relocate this root, so the fixed
 * per-platform defaults below cannot always see the installed editors.
 */
export const DIRECTOR_UNITY_HUB_EDITORS_ENV = "DIRECTOR_UNITY_HUB_EDITORS";

/** Filesystem listing used by the probe; injectable for host-free tests. */
export type UnityProbeDirectoryLister = (path: string) => Promise<string[]>;

/** Options for {@link discoverUnityEditorExecutableCandidates}. */
export interface DiscoverUnityEditorCandidatesOptions {
  /** Environment to read overrides and Windows/HOME roots from (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Platform the candidates are generated for (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Directory lister override for tests (defaults to `fs.readdir`). */
  listDirectory?: UnityProbeDirectoryLister;
}

/**
 * The editor executable path inside one Unity Hub per-version directory.
 * macOS keeps the app bundle, Linux and Windows use the flat Editor layout.
 */
const HUB_EDITOR_SUBPATHS: Record<string, string[]> = {
  darwin: ["Unity.app/Contents/MacOS/Unity"],
  linux: ["Editor/Unity"],
  win32: ["Editor/Unity.exe"],
};

/**
 * Fixed non-Hub editor locations per platform: the legacy macOS installer
 * layout, the game-ci/containerized Linux layouts, and the legacy Windows
 * installer layout.
 */
export const UNITY_STATIC_EDITOR_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/Unity/Unity.app/Contents/MacOS/Unity"],
  linux: ["/opt/unity/Editor/Unity", "/opt/Unity/Editor/Unity"],
  win32: ["C:\\Program Files\\Unity\\Editor\\Unity.exe"],
};

function pathModuleFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function hubEditorRoots(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const path = pathModuleFor(platform);
  const roots: string[] = [];
  const configured = environment[DIRECTOR_UNITY_HUB_EDITORS_ENV]?.trim();
  if (configured) roots.push(configured);
  if (platform === "darwin") {
    roots.push("/Applications/Unity/Hub/Editor");
  } else if (platform === "win32") {
    const programFiles = environment.PROGRAMFILES?.trim() || "C:\\Program Files";
    roots.push(path.join(programFiles, "Unity", "Hub", "Editor"));
  } else {
    const home = environment.HOME?.trim();
    if (home) roots.push(path.join(home, "Unity", "Hub", "Editor"));
  }
  return [...new Set(roots)];
}

interface ParsedUnityVersion {
  numbers: [number, number, number];
  channelRank: number;
  revision: number;
}

const UNITY_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:([abfpx])(\d+))?/;
const UNITY_CHANNEL_RANKS: Record<string, number> = { a: 0, b: 1, x: 2, f: 3, p: 4 };

function parseUnityVersion(directoryName: string): ParsedUnityVersion | null {
  const match = UNITY_VERSION_PATTERN.exec(directoryName.trim());
  if (!match) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    channelRank: match[4] ? (UNITY_CHANNEL_RANKS[match[4]] ?? 0) : 0,
    revision: match[5] ? Number(match[5]) : 0,
  };
}

/**
 * Orders two Unity Hub editor version directory names newest-first, so the
 * probe prefers the most recent install when several editors coexist.
 * Non-version directory names sort last in stable name order.
 *
 * @param left - One version directory name (e.g. `2022.3.45f1`).
 * @param right - The other version directory name (e.g. `6000.0.32f1`).
 * @returns A comparator value for `Array.prototype.sort`.
 */
export function compareUnityEditorVersionsDesc(left: string, right: string): number {
  const leftParsed = parseUnityVersion(left);
  const rightParsed = parseUnityVersion(right);
  if (!leftParsed && !rightParsed) return left.localeCompare(right);
  if (!leftParsed) return 1;
  if (!rightParsed) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (leftParsed.numbers[index] !== rightParsed.numbers[index]) {
      return rightParsed.numbers[index]! - leftParsed.numbers[index]!;
    }
  }
  if (leftParsed.channelRank !== rightParsed.channelRank) return rightParsed.channelRank - leftParsed.channelRank;
  return rightParsed.revision - leftParsed.revision;
}

async function defaultListDirectory(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Produces the ordered default Unity editor executable candidates for one
 * platform: Unity Hub per-version installs first (newest version first,
 * honoring the {@link DIRECTOR_UNITY_HUB_EDITORS_ENV} root override), then
 * the fixed legacy/containerized locations. The caller remains responsible
 * for checking that a candidate actually exists, mirroring how
 * `DIRECTOR_UNITY_BIN` and PATH lookups are validated in the engine bridge.
 *
 * @param options - Environment, platform, and directory-lister overrides.
 * @returns Absolute candidate paths, most preferred first.
 */
export async function discoverUnityEditorExecutableCandidates(
  options: DiscoverUnityEditorCandidatesOptions = {},
): Promise<string[]> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const listDirectory = options.listDirectory ?? defaultListDirectory;
  const path = pathModuleFor(platform);
  const editorSubpaths = HUB_EDITOR_SUBPATHS[platform] ?? HUB_EDITOR_SUBPATHS.linux!;

  const candidates: string[] = [];
  for (const root of hubEditorRoots(environment, platform)) {
    let versionDirectories: string[];
    try {
      versionDirectories = await listDirectory(root);
    } catch {
      continue;
    }
    for (const versionDirectory of [...versionDirectories].sort(compareUnityEditorVersionsDesc)) {
      for (const editorSubpath of editorSubpaths) {
        candidates.push(path.join(root, versionDirectory, ...editorSubpath.split("/")));
      }
    }
  }
  candidates.push(...(UNITY_STATIC_EDITOR_PATHS[platform] ?? UNITY_STATIC_EDITOR_PATHS.linux!));
  return [...new Set(candidates)];
}
