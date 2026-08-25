import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT,
  DIRECTOR_DCC_PROVIDERS,
  directorDccProviderCatalogSchema,
  directorDccProviderDescriptorSchema,
  directorDccProviderStatusSchema,
  type DirectorDccProviderDescriptor,
  type DirectorDccProviderStatus,
} from "@director/dcc-protocol";
import type { BlenderBridge, BlenderBridgeStatus } from "../../dcc/blenderBridge";
import {
  createDirectorDccProviderRegistry,
  DIRECTOR_DCC_PROVIDER_CONFIG_ENV,
  loadConfiguredDirectorDccProviderDescriptors,
  registerConfiguredDirectorDccProviders,
  type DirectorDccProviderAdapter,
} from "../../dcc/dccProviderRegistry";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function blenderBridge(status: Partial<BlenderBridgeStatus> = {}): BlenderBridge {
  return {
    status: vi.fn().mockResolvedValue({
      available: false,
      executable: null,
      version: null,
      contract: "director-dcc-scene-v1",
      reason: "Blender is unavailable in this test.",
      ...status,
    }),
    exportBlend: vi.fn(),
  };
}

function customDescriptor(id = "studio.custom"): DirectorDccProviderDescriptor {
  return directorDccProviderDescriptorSchema.parse({
    id,
    label: "Studio Custom",
    category: "dcc",
    integration: "exchange-package",
    preferredFormat: "glb",
    exchangeFormats: ["glb", "usda"],
    capabilities: [
      { id: "scene", level: "exchange" },
      { id: "camera", level: "exchange" },
    ],
    connectorDirectory: `integrations/${id}`,
  });
}

function customStatus(
  descriptor: DirectorDccProviderDescriptor,
  patch: Partial<Omit<DirectorDccProviderStatus, "provider">> = {},
): DirectorDccProviderStatus {
  return directorDccProviderStatusSchema.parse({
    provider: descriptor,
    installed: true,
    executable: "/opt/studio/custom",
    version: "1.0.0",
    nativeReady: false,
    exchangeReady: true,
    reason: null,
    ...patch,
  });
}

async function temporaryFile(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "director-dcc-provider-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, "provider fixture\n", { mode: 0o700 });
  return { directory, path };
}

async function temporaryWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "director-dcc-config-workspace-"));
  temporaryDirectories.push(root);
  const integrationsDirectory = join(root, "integrations");
  await mkdir(integrationsDirectory, { recursive: true });
  return { root, integrationsDirectory };
}

function configuredProvider(id = "studio.openusd") {
  return {
    id,
    label: "Studio OpenUSD",
    category: "dcc" as const,
    integration: "exchange-package" as const,
    preferredFormat: "usda" as const,
    exchangeFormats: ["usda", "glb"] as const,
    capabilities: [
      { id: "scene" as const, level: "exchange" as const },
      { id: "camera" as const, level: "exchange" as const },
      { id: "stable_ids" as const, level: "exchange" as const },
      { id: "live_link" as const, level: "planned" as const },
    ],
  };
}

async function writeProviderConfig(directory: string, providers = [configuredProvider()]) {
  const path = join(directory, "dcc-providers.json");
  await writeFile(path, JSON.stringify({ contract: DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT, providers }), "utf8");
  return path;
}

describe("Director DCC provider registry", () => {
  it("registers every built-in provider and returns a schema-valid discovery catalog in stable order", async () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });
    const catalog = await registry.discover();

    expect(directorDccProviderCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.contract).toBe("director-dcc-provider-catalog-v1");
    expect(catalog.providers.map(({ provider }) => provider.id)).toEqual(DIRECTOR_DCC_PROVIDERS.map(({ id }) => id));
    expect(catalog.providers.find(({ provider }) => provider.id === "blender")).toMatchObject({
      installed: false,
      nativeReady: false,
      exchangeReady: true,
    });
    expect(catalog.providers.filter(({ provider }) => provider.id !== "blender")).toEqual(
      expect.arrayContaining([expect.objectContaining({ installed: false, nativeReady: false, exchangeReady: true })]),
    );
  });

  it("wraps Blender bridge status without overstating native readiness", async () => {
    const bridge = blenderBridge({
      available: true,
      executable: "/Applications/Blender.app/Contents/MacOS/Blender",
      version: "Blender 4.5.1",
      reason: undefined,
    });
    const registry = createDirectorDccProviderRegistry({ blender: bridge, environment: { PATH: "" } });

    await expect(registry.status("blender")).resolves.toMatchObject({
      provider: { id: "blender", integration: "native-roundtrip" },
      installed: true,
      executable: "/Applications/Blender.app/Contents/MacOS/Blender",
      version: "Blender 4.5.1",
      nativeReady: true,
      exchangeReady: true,
      reason: null,
    });
    expect(bridge.status).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate registration for built-in and third-party providers", () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });
    const descriptor = customDescriptor();
    const adapter = { descriptor, status: vi.fn().mockResolvedValue(customStatus(descriptor)) };

    expect(() => registry.register({ ...adapter, descriptor: DIRECTOR_DCC_PROVIDERS[0]! })).toThrow(
      "DCC provider blender is already registered.",
    );
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow("DCC provider studio.custom is already registered.");
  });

  it("supports a third-party class adapter in the open provider namespace", async () => {
    class StudioAdapter implements DirectorDccProviderAdapter {
      readonly descriptor = customDescriptor("vendor.pipeline-v2");
      calls = 0;

      async status() {
        this.calls += 1;
        return customStatus(this.descriptor, { executable: null, installed: false, version: null });
      }
    }

    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });
    const adapter = new StudioAdapter();
    registry.register(adapter);

    expect(registry.get("vendor.pipeline-v2")?.descriptor).toEqual(adapter.descriptor);
    await expect(registry.status("vendor.pipeline-v2")).resolves.toMatchObject({
      provider: { id: "vendor.pipeline-v2" },
      installed: false,
      exchangeReady: true,
    });
    expect(adapter.calls).toBe(1);
    await expect(registry.status("not.registered")).resolves.toBeNull();
  });

  it("prefers an explicit provider environment variable over PATH discovery", async () => {
    const configured = await temporaryFile("configured-3dsmax");
    const onPath = await temporaryFile("3dsmax");
    const registry = createDirectorDccProviderRegistry({
      blender: blenderBridge(),
      environment: {
        PATH: [onPath.directory, "/unused"].join(delimiter),
        DIRECTOR_3DSMAX_BIN: configured.path,
      },
    });

    await expect(registry.status("3dsmax")).resolves.toMatchObject({
      installed: true,
      executable: configured.path,
      nativeReady: false,
      exchangeReady: true,
      reason: expect.stringContaining("was detected"),
    });
  });

  it("falls back from a missing configured executable to provider commands on PATH", async () => {
    const onPath = await temporaryFile("3dsmax");
    const registry = createDirectorDccProviderRegistry({
      blender: blenderBridge(),
      environment: {
        PATH: onPath.directory,
        DIRECTOR_3DSMAX_BIN: join(onPath.directory, "missing-explicit-binary"),
      },
    });

    await expect(registry.status("3dsmax")).resolves.toMatchObject({
      installed: true,
      executable: onPath.path,
      version: null,
      nativeReady: false,
      exchangeReady: true,
    });
  });

  it("strictly validates third-party status payloads during status and discover", async () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });
    const descriptor = customDescriptor("studio.invalid-status");
    registry.register({
      descriptor,
      async status() {
        return { ...customStatus(descriptor), unexpected: true } as DirectorDccProviderStatus;
      },
    });

    await expect(registry.status(descriptor.id)).rejects.toThrow(/unrecognized key/i);
    await expect(registry.discover()).rejects.toThrow(/unrecognized key/i);
  });

  it("rejects a third-party status that impersonates another provider", async () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });
    const descriptor = customDescriptor("studio.expected");
    const reportedDescriptor = customDescriptor("studio.other");
    registry.register({ descriptor, status: vi.fn().mockResolvedValue(customStatus(reportedDescriptor)) });

    await expect(registry.status(descriptor.id)).rejects.toThrow(/reported provider studio\.other.*studio\.expected/i);
    await expect(registry.discover()).rejects.toThrow(/reported provider studio\.other.*studio\.expected/i);
  });

  it("validates provider ids before registry lookup", async () => {
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });
    expect(() => registry.get("Studio/Invalid")).toThrow(/provider id must be a lowercase, namespaced identifier/i);
    await expect(registry.status("Studio/Invalid")).rejects.toThrow(
      /provider id must be a lowercase, namespaced identifier/i,
    );
  });

  it("does not scan or access the workspace when provider configuration is not explicit", async () => {
    const missingWorkspace = join(tmpdir(), "director-workspace-that-does-not-exist");
    await expect(
      loadConfiguredDirectorDccProviderDescriptors({ workspaceRoot: missingWorkspace, environment: {} }),
    ).resolves.toEqual([]);
  });

  it("registers a strictly validated exchange-only provider from workspace/integrations", async () => {
    const workspace = await temporaryWorkspace();
    await writeProviderConfig(workspace.integrationsDirectory, [configuredProvider("vendor.pipeline-v2")]);
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });

    const descriptors = await registerConfiguredDirectorDccProviders(registry, {
      workspaceRoot: workspace.root,
      environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: "integrations/dcc-providers.json" },
    });

    expect(descriptors).toEqual([
      expect.objectContaining({
        id: "vendor.pipeline-v2",
        integration: "exchange-package",
        preferredFormat: "usda",
        exchangeFormats: ["usda", "glb"],
        connectorDirectory: "integrations/dcc-providers/vendor.pipeline-v2",
      }),
    ]);
    expect(descriptors[0]?.capabilities).toEqual([
      { id: "scene", level: "exchange", layer: "exchange-format", formats: ["usda", "glb"] },
      { id: "camera", level: "exchange", layer: "exchange-format", formats: ["usda", "glb"] },
      { id: "stable_ids", level: "exchange", layer: "director-manifest" },
      { id: "live_link", level: "planned", layer: "connector" },
    ]);
    await expect(registry.status("vendor.pipeline-v2")).resolves.toMatchObject({
      provider: { id: "vendor.pipeline-v2" },
      installed: false,
      executable: null,
      version: null,
      nativeReady: false,
      exchangeReady: true,
      reason: expect.stringContaining("exchange only"),
    });
    expect((await registry.discover()).providers.at(-1)?.provider.id).toBe("vendor.pipeline-v2");
  });

  it("rejects executable and native fields in configured provider JSON", async () => {
    const workspace = await temporaryWorkspace();
    const unsafeProvider = {
      ...configuredProvider(),
      nativeReady: true,
      command: ["python", "connector.py"],
    };
    await writeProviderConfig(workspace.integrationsDirectory, [unsafeProvider]);

    await expect(
      loadConfiguredDirectorDccProviderDescriptors({
        workspaceRoot: workspace.root,
        environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: "integrations/dcc-providers.json" },
      }),
    ).rejects.toThrow(/unrecognized key/i);
  });

  it("rejects configuration paths outside workspace/integrations, including escaping symlinks", async () => {
    const workspace = await temporaryWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "director-dcc-config-outside-"));
    temporaryDirectories.push(outside);
    const outsideConfig = await writeProviderConfig(outside);

    await expect(
      loadConfiguredDirectorDccProviderDescriptors({
        workspaceRoot: workspace.root,
        environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: outsideConfig },
      }),
    ).rejects.toThrow(/under workspace\/integrations/i);

    const symlinkPath = join(workspace.integrationsDirectory, "escaped.json");
    await symlink(outsideConfig, symlinkPath);
    await expect(
      loadConfiguredDirectorDccProviderDescriptors({
        workspaceRoot: workspace.root,
        environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: "integrations/escaped.json" },
      }),
    ).rejects.toThrow(/outside the trusted workspace integrations directory/i);
  });

  it("rejects a workspace integrations root redirected by a symbolic link", async () => {
    const root = await mkdtemp(join(tmpdir(), "director-dcc-symlinked-config-root-"));
    temporaryDirectories.push(root);
    const redirectedConfig = join(root, "redirected-integrations");
    await mkdir(redirectedConfig);
    await writeProviderConfig(redirectedConfig);
    await symlink(redirectedConfig, join(root, "integrations"));

    await expect(
      loadConfiguredDirectorDccProviderDescriptors({
        workspaceRoot: root,
        environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: "integrations/dcc-providers.json" },
      }),
    ).rejects.toThrow(/integrations directory must not be a symbolic link/i);
  });

  it("preflights every configured id and leaves the registry unchanged on a built-in collision", async () => {
    const workspace = await temporaryWorkspace();
    await writeProviderConfig(workspace.integrationsDirectory, [
      configuredProvider("studio.safe"),
      configuredProvider("blender"),
    ]);
    const registry = createDirectorDccProviderRegistry({ blender: blenderBridge(), environment: { PATH: "" } });

    await expect(
      registerConfiguredDirectorDccProviders(registry, {
        workspaceRoot: workspace.root,
        environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: "integrations/dcc-providers.json" },
      }),
    ).rejects.toThrow(/blender.*already registered/i);
    expect(registry.get("studio.safe")).toBeNull();
    expect((await registry.discover()).providers.map(({ provider }) => provider.id)).toEqual(
      DIRECTOR_DCC_PROVIDERS.map(({ id }) => id),
    );
  });

  it("enforces a bounded configuration file size", async () => {
    const workspace = await temporaryWorkspace();
    await writeProviderConfig(workspace.integrationsDirectory);

    await expect(
      loadConfiguredDirectorDccProviderDescriptors({
        workspaceRoot: workspace.root,
        environment: { [DIRECTOR_DCC_PROVIDER_CONFIG_ENV]: "integrations/dcc-providers.json" },
        maxConfigBytes: 32,
      }),
    ).rejects.toThrow(/32-byte safety limit/i);
  });
});
