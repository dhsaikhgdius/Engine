import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT,
  DIRECTOR_DCC_PROVIDERS,
  directorDccEngineIdSchema,
  directorDccProviderCatalogSchema,
  directorDccProviderConfigSchema,
  directorDccProviderDescriptorSchema,
  directorDccProviderIdSchema,
  directorDccProviderStatusSchema,
  getDirectorDccProviderDescriptor,
  type DirectorDccEngineId,
  type DirectorDccProviderCatalog,
  type DirectorDccConfiguredProvider,
  type DirectorDccProviderDescriptor,
  type DirectorDccProviderId,
  type DirectorDccProviderStatus,
} from "@director/dcc-protocol";
import type { BlenderBridge } from "./blenderBridge";
import type { DirectorDccEngineBridge } from "./engineBridge";
import { GODOT_DEFAULT_EXECUTABLE_PATHS, GODOT_EXECUTABLE_COMMANDS } from "./godotProbe";

/**
 * A pluggable adapter that vends a DCC provider's descriptor and live status.
 * Built-in providers (Blender) and exchange-only configured providers both
 * implement this interface.
 */
export interface DirectorDccProviderAdapter {
  /** The provider descriptor (id, label, capabilities, exchange formats). */
  readonly descriptor: DirectorDccProviderDescriptor;
  /** Probe the provider's installation and return its current status. */
  status(): Promise<DirectorDccProviderStatus>;
}

/**
 * A registry of DCC provider adapters. Adapters are registered once; the
 * registry can then discover the full provider catalog and query individual
 * provider status on demand.
 */
export interface DirectorDccProviderRegistry {
  /** Register an adapter; throws if the provider id is already registered. */
  register(adapter: DirectorDccProviderAdapter): void;
  /** Look up a registered adapter by provider id, or null if not found. */
  get(provider: DirectorDccProviderId): DirectorDccProviderAdapter | null;
  /** Query the live status of a registered provider, or null if not found. */
  status(provider: DirectorDccProviderId): Promise<DirectorDccProviderStatus | null>;
  /** Build the full provider catalog from all registered adapters. */
  discover(): Promise<DirectorDccProviderCatalog>;
}

/** Configuration for creating the DCC provider registry. */
export interface CreateDirectorDccProviderRegistryOptions {
  /** The Blender bridge used to probe the Blender adapter. */
  blender: BlenderBridge;
  /**
   * Optional engine bridge. When provided, the Unreal/Unity/Godot adapters
   * report `nativeReady` from the versioned connector health check instead of
   * always false. Detecting an installed executable never implies readiness.
   */
  engines?: Pick<DirectorDccEngineBridge, "health">;
  /** Optional environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
}

/** Environment variable pointing to a JSON provider configuration file. */
export const DIRECTOR_DCC_PROVIDER_CONFIG_ENV = "DIRECTOR_DCC_PROVIDER_CONFIG";
/** Default maximum byte size for provider configuration files. */
export const DEFAULT_DIRECTOR_DCC_PROVIDER_CONFIG_MAX_BYTES = 1024 * 1024;

/** Options for loading configured DCC provider descriptors from a JSON file. */
export interface LoadConfiguredDirectorDccProvidersOptions {
  /** Absolute or relative workspace root path. */
  workspaceRoot: string;
  /** Optional environment override (defaults to `process.env`). */
  environment?: NodeJS.ProcessEnv;
  /** Maximum allowed byte size for the configuration file. */
  maxConfigBytes?: number;
}

type RuntimeProbe = {
  environmentVariable: string;
  commands: string[];
  paths: string[];
};

const RUNTIME_PROBES: Partial<Record<DirectorDccProviderId, RuntimeProbe>> = {
  maya: {
    environmentVariable: "DIRECTOR_MAYA_BIN",
    commands: ["maya", "mayapy"],
    paths: [
      "/Applications/Autodesk/maya2026/Maya.app/Contents/bin/maya",
      "/Applications/Autodesk/maya2025/Maya.app/Contents/bin/maya",
      "/Applications/Autodesk/maya2024/Maya.app/Contents/bin/maya",
    ],
  },
  unreal: {
    environmentVariable: "DIRECTOR_UNREAL_EDITOR_BIN",
    commands: ["UnrealEditor", "UnrealEditor-Cmd"],
    paths: [],
  },
  houdini: {
    environmentVariable: "DIRECTOR_HOUDINI_BIN",
    commands: ["hython", "houdini"],
    paths: ["/Applications/Houdini/Houdini.app/Contents/MacOS/houdini"],
  },
  cinema4d: {
    environmentVariable: "DIRECTOR_CINEMA4D_BIN",
    commands: ["Commandline", "Cinema 4D"],
    paths: [
      "/Applications/Maxon Cinema 4D 2026/Cinema 4D.app/Contents/MacOS/Cinema 4D",
      "/Applications/Maxon Cinema 4D 2025/Cinema 4D.app/Contents/MacOS/Cinema 4D",
    ],
  },
  unity: {
    environmentVariable: "DIRECTOR_UNITY_BIN",
    commands: ["Unity"],
    paths: ["/Applications/Unity/Unity.app/Contents/MacOS/Unity"],
  },
  "3dsmax": {
    environmentVariable: "DIRECTOR_3DSMAX_BIN",
    commands: ["3dsmax", "3dsmax.exe"],
    paths: [],
  },
  godot: {
    environmentVariable: "DIRECTOR_GODOT_BIN",
    // macOS, Linux, Flatpak/Snap, and Windows locations live in godotProbe.ts.
    commands: [...GODOT_EXECUTABLE_COMMANDS],
    paths: [...GODOT_DEFAULT_EXECUTABLE_PATHS],
  },
};

async function isFile(path: string) {
  try {
    await access(path);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
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

async function discoverRuntime(probe: RuntimeProbe, environment: NodeJS.ProcessEnv) {
  const configured = environment[probe.environmentVariable]?.trim();
  const candidates = [configured, ...probe.paths].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return discoverOnPath(probe.commands, environment);
}

function exchangeAdapter(
  descriptor: DirectorDccProviderDescriptor,
  environment: NodeJS.ProcessEnv,
): DirectorDccProviderAdapter {
  return {
    descriptor,
    async status() {
      const probe = RUNTIME_PROBES[descriptor.id];
      const executable = probe ? await discoverRuntime(probe, environment) : null;
      return directorDccProviderStatusSchema.parse({
        provider: descriptor,
        installed: Boolean(executable),
        executable,
        version: null,
        nativeReady: false,
        exchangeReady: true,
        reason: executable
          ? `${descriptor.label} was detected. Native automation requires its Director connector; portable ${descriptor.exchangeFormats.join("/")} exchange is ready.`
          : `${descriptor.label} was not detected. Portable ${descriptor.exchangeFormats.join("/")} exchange can still be prepared.`,
      });
    },
  };
}

function engineAdapter(
  descriptor: DirectorDccProviderDescriptor,
  provider: DirectorDccEngineId,
  engines: Pick<DirectorDccEngineBridge, "health">,
): DirectorDccProviderAdapter {
  return {
    descriptor,
    async status() {
      const health = await engines.health(provider);
      const reason = health.ready
        ? `${descriptor.label} Director connector ${health.connectorVersion ?? ""} passed its versioned health check; headless send/receive is available. Capability maturity in discover remains authoritative.`.replace(
            /\s{2,}/g,
            " ",
          )
        : (health.warnings[0] ??
          `${descriptor.label} native connector is not ready; portable ${descriptor.exchangeFormats.join("/")} exchange is available.`);
      return directorDccProviderStatusSchema.parse({
        provider: descriptor,
        installed: Boolean(health.executable),
        executable: health.executable,
        version: health.hostVersion,
        nativeReady: health.ready,
        exchangeReady: true,
        reason,
      });
    },
  };
}

function pathIsWithin(parent: string, candidate: string) {
  const difference = relative(parent, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function configuredDescriptor(provider: DirectorDccConfiguredProvider): DirectorDccProviderDescriptor {
  return directorDccProviderDescriptorSchema.parse({
    ...provider,
    capabilities: provider.capabilities.map((capability) => {
      if (capability.level === "planned") {
        return { ...capability, layer: "connector" as const };
      }
      if (capability.id === "stable_ids") {
        return { ...capability, layer: "director-manifest" as const };
      }
      return {
        ...capability,
        layer: "exchange-format" as const,
        formats: [...provider.exchangeFormats],
      };
    }),
    connectorDirectory: `integrations/dcc-providers/${provider.id}`,
  });
}

/**
 * Loads a declarative provider catalog from one explicitly configured JSON
 * file. The loader never scans directories or imports code, and both the
 * configuration directory and resolved file must remain under
 * workspace/integrations.
 */
export async function loadConfiguredDirectorDccProviderDescriptors(
  options: LoadConfiguredDirectorDccProvidersOptions,
): Promise<DirectorDccProviderDescriptor[]> {
  const environment = options.environment ?? process.env;
  const configuredPath = environment[DIRECTOR_DCC_PROVIDER_CONFIG_ENV]?.trim();
  if (!configuredPath) return [];

  const maxConfigBytes = options.maxConfigBytes ?? DEFAULT_DIRECTOR_DCC_PROVIDER_CONFIG_MAX_BYTES;
  if (!Number.isSafeInteger(maxConfigBytes) || maxConfigBytes <= 0) {
    throw new Error("DCC provider configuration byte limit must be a positive safe integer.");
  }

  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const requestedConfigRoot = resolve(workspaceRoot, "integrations");
  const configRoot = await realpath(requestedConfigRoot).catch(() => {
    throw new Error(
      `${DIRECTOR_DCC_PROVIDER_CONFIG_ENV} is set, but the trusted workspace integrations directory does not exist.`,
    );
  });
  if (!pathIsWithin(workspaceRoot, configRoot)) {
    throw new Error("The workspace integrations directory resolves outside the workspace root.");
  }
  if (configRoot !== requestedConfigRoot) {
    throw new Error("The trusted workspace integrations directory must not be a symbolic link.");
  }

  const requestedPath = isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(workspaceRoot, configuredPath);
  if (!pathIsWithin(requestedConfigRoot, requestedPath)) {
    throw new Error(`${DIRECTOR_DCC_PROVIDER_CONFIG_ENV} must point to a JSON file under workspace/integrations.`);
  }
  if (extname(requestedPath).toLowerCase() !== ".json") {
    throw new Error(`${DIRECTOR_DCC_PROVIDER_CONFIG_ENV} must point to a .json file.`);
  }

  const configPath = await realpath(requestedPath).catch(() => {
    throw new Error(`DCC provider configuration file does not exist: ${requestedPath}`);
  });
  if (!pathIsWithin(configRoot, configPath)) {
    throw new Error("DCC provider configuration resolves outside the trusted workspace integrations directory.");
  }

  const metadata = await stat(configPath);
  if (!metadata.isFile()) throw new Error("DCC provider configuration must be a regular file.");
  if (metadata.size > maxConfigBytes) {
    throw new Error(`DCC provider configuration exceeds the ${maxConfigBytes}-byte safety limit.`);
  }

  const bytes = await readFile(configPath);
  if (bytes.byteLength > maxConfigBytes) {
    throw new Error(`DCC provider configuration exceeds the ${maxConfigBytes}-byte safety limit.`);
  }

  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`DCC provider configuration is not valid JSON: ${configPath}`);
  }
  const configuration = directorDccProviderConfigSchema.parse(input);
  if (configuration.contract !== DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT) {
    throw new Error("Unsupported DCC provider configuration contract.");
  }
  return configuration.providers.map(configuredDescriptor);
}

/**
 * Registers safe exchange-only adapters after validating the entire catalog.
 * Registration is all-or-nothing with respect to id collisions.
 */
export async function registerConfiguredDirectorDccProviders(
  registry: DirectorDccProviderRegistry,
  options: LoadConfiguredDirectorDccProvidersOptions,
) {
  const descriptors = await loadConfiguredDirectorDccProviderDescriptors(options);
  for (const descriptor of descriptors) {
    if (registry.get(descriptor.id)) {
      throw new Error(`Configured DCC provider ${descriptor.id} conflicts with an already registered provider.`);
    }
  }

  for (const descriptor of descriptors) {
    registry.register({
      descriptor,
      async status() {
        return directorDccProviderStatusSchema.parse({
          provider: descriptor,
          installed: false,
          executable: null,
          version: null,
          nativeReady: false,
          exchangeReady: true,
          reason: `${descriptor.label} is configured for portable ${descriptor.exchangeFormats.join("/")} exchange only; no executable or native connector is loaded.`,
        });
      },
    });
  }
  return descriptors;
}

/**
 * Creates the DCC provider registry, pre-populated with the Blender adapter
 * and exchange-only adapters for every provider declared in the protocol.
 *
 * The Blender adapter is wired through the provided BlenderBridge so its
 * real installation status is reflected. All other providers start as
 * exchange-only adapters that report availability based on runtime probing.
 *
 * @param options - The Blender bridge and optional environment override.
 * @returns A registry with all built-in providers registered.
 */
export function createDirectorDccProviderRegistry(
  options: CreateDirectorDccProviderRegistryOptions,
): DirectorDccProviderRegistry {
  const adapters = new Map<DirectorDccProviderId, DirectorDccProviderAdapter>();
  const environment = options.environment ?? process.env;

  async function readAdapterStatus(adapter: DirectorDccProviderAdapter) {
    const status = directorDccProviderStatusSchema.parse(await adapter.status());
    if (status.provider.id !== adapter.descriptor.id) {
      throw new Error(
        `DCC adapter reported provider ${status.provider.id}, but it is registered as ${adapter.descriptor.id}.`,
      );
    }
    return status;
  }

  const registry: DirectorDccProviderRegistry = {
    register(adapter) {
      const descriptor = directorDccProviderDescriptorSchema.parse(adapter.descriptor);
      if (adapters.has(descriptor.id)) throw new Error(`DCC provider ${descriptor.id} is already registered.`);
      adapters.set(descriptor.id, {
        descriptor,
        status: adapter.status.bind(adapter),
      });
    },
    get(provider) {
      return adapters.get(directorDccProviderIdSchema.parse(provider)) ?? null;
    },
    async status(provider) {
      const adapter = registry.get(provider);
      return adapter ? readAdapterStatus(adapter) : null;
    },
    async discover() {
      const providers = await Promise.all([...adapters.values()].map(readAdapterStatus));
      return directorDccProviderCatalogSchema.parse({
        contract: "director-dcc-provider-catalog-v1",
        providers,
      });
    },
  };

  const blenderDescriptor = getDirectorDccProviderDescriptor("blender");
  registry.register({
    descriptor: blenderDescriptor,
    async status() {
      const status = await options.blender.status();
      return directorDccProviderStatusSchema.parse({
        provider: blenderDescriptor,
        installed: Boolean(status.executable),
        executable: status.executable,
        version: status.version,
        nativeReady: status.available,
        exchangeReady: true,
        reason: status.reason ?? null,
      });
    },
  });

  for (const descriptor of DIRECTOR_DCC_PROVIDERS) {
    if (descriptor.id === "blender") continue;
    const engineId = directorDccEngineIdSchema.safeParse(descriptor.id);
    if (options.engines && engineId.success) {
      registry.register(engineAdapter(descriptor, engineId.data, options.engines));
    } else {
      registry.register(exchangeAdapter(descriptor, environment));
    }
  }
  return registry;
}
