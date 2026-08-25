import { describe, expect, it } from "vitest";
import {
  DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT,
  DIRECTOR_DCC_PROVIDERS,
  directorDccProviderConfigSchema,
  directorDccProviderCatalogSchema,
  directorDccProviderDescriptorSchema,
  directorDccProviderIdSchema,
  directorDccProviderStatusSchema,
  getDirectorDccProviderDescriptor,
} from "../src/directorDccProviderContract";

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

describe("Director DCC provider contract", () => {
  it("keeps provider ids open for lowercase namespaced third-party connectors", () => {
    expect(directorDccProviderIdSchema.parse("studio.maya-bridge_v2")).toBe("studio.maya-bridge_v2");
    expect(directorDccProviderIdSchema.parse("vendor_42.engine-plugin")).toBe("vendor_42.engine-plugin");
    expect(directorDccProviderIdSchema.parse("  studio.custom  ")).toBe("studio.custom");

    for (const invalid of [
      "",
      "Studio.Custom",
      "studio/custom",
      "studio..custom",
      "studio-",
      ".studio",
      "studio custom",
    ]) {
      expect(directorDccProviderIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("publishes the complete validated built-in provider catalog", () => {
    expect(DIRECTOR_DCC_PROVIDERS.map(({ id }) => id)).toEqual([
      "blender",
      "maya",
      "unreal",
      "houdini",
      "cinema4d",
      "unity",
      "3dsmax",
      "godot",
    ]);

    for (const descriptor of DIRECTOR_DCC_PROVIDERS) {
      expect(directorDccProviderDescriptorSchema.parse(descriptor)).toEqual(descriptor);
      expect(descriptor.exchangeFormats).toContain(descriptor.preferredFormat);
      expect(new Set(descriptor.capabilities.map(({ id }) => id)).size).toBe(descriptor.capabilities.length);
      expect(descriptor.capabilities.every(({ layer }) => Boolean(layer))).toBe(true);
      expect(descriptor.connectorDirectory).toBe(`integrations/${descriptor.id}`);
    }

    expect(getDirectorDccProviderDescriptor("blender")).toMatchObject({
      integration: "native-roundtrip",
      preferredFormat: "blend",
      category: "dcc",
    });
    expect(getDirectorDccProviderDescriptor("unreal")).toMatchObject({
      integration: "engine-headless",
      preferredFormat: "usda",
      category: "engine",
    });
    expect(getDirectorDccProviderDescriptor("unity")).toMatchObject({
      integration: "engine-headless",
      preferredFormat: "glb",
      category: "engine",
    });
    expect(getDirectorDccProviderDescriptor("godot")).toMatchObject({
      integration: "engine-headless",
      preferredFormat: "glb",
      category: "engine",
      exchangeFormats: ["glb"],
    });
  });

  it("separates portable layout, Director manifest, and provider connector capabilities", () => {
    const exchangeOnly = DIRECTOR_DCC_PROVIDERS.filter(({ integration }) => integration === "exchange-package");
    expect(exchangeOnly.map(({ id }) => id)).toEqual(["maya", "houdini", "cinema4d", "3dsmax"]);
    for (const descriptor of exchangeOnly) {
      const byId = new Map(descriptor.capabilities.map((capability) => [capability.id, capability]));

      for (const id of ["scene", "camera"] as const) {
        expect(byId.get(id)).toEqual({
          id,
          level: "exchange",
          layer: "exchange-format",
          formats: descriptor.exchangeFormats.filter((format) => format === "glb" || format === "usda"),
        });
      }
      expect(byId.get("stable_ids")).toEqual({
        id: "stable_ids",
        level: "exchange",
        layer: "director-manifest",
      });
      for (const id of ["animation", "skeleton", "materials", "roundtrip", "headless", "live_link"] as const) {
        expect(byId.get(id)).toEqual({ id, level: "planned", layer: "connector" });
      }
    }
  });

  it("promotes only connector-backed engine capabilities and keeps fidelity claims honest", () => {
    const engines = DIRECTOR_DCC_PROVIDERS.filter(({ integration }) => integration === "engine-headless");
    expect(engines.map(({ id }) => id)).toEqual(["unreal", "unity", "godot"]);
    for (const descriptor of engines) {
      expect(descriptor.category).toBe("engine");
      expect(descriptor.connectorDirectory).toBe(`integrations/${descriptor.id}`);
      const byId = new Map(descriptor.capabilities.map((capability) => [capability.id, capability]));

      // Scene layout and cameras still travel through the portable package.
      for (const id of ["scene", "camera"] as const) {
        expect(byId.get(id)).toEqual({
          id,
          level: "exchange",
          layer: "exchange-format",
          formats: descriptor.exchangeFormats.filter((format) => format === "glb" || format === "usda"),
        });
      }
      // The Director-authored connector performs headless import/return.
      expect(byId.get("headless")).toEqual({ id: "headless", level: "native", layer: "connector" });
      expect(byId.get("roundtrip")).toEqual({ id: "roundtrip", level: "native", layer: "connector" });
      expect(byId.get("stable_ids")).toEqual({ id: "stable_ids", level: "native", layer: "director-manifest" });
      // The Unreal connector ships Gateway-baked Sequencer animation, skinned
      // GLB skeletal-mesh import, and PBR material instances; the other engine
      // connectors keep those claims planned until equivalent fixtures exist.
      const provenFidelityLevel = descriptor.id === "unreal" ? "native" : "planned";
      for (const id of ["animation", "skeleton", "materials"] as const) {
        expect(byId.get(id)).toEqual({ id, level: provenFidelityLevel, layer: "connector" });
      }
      // Unreal ships a tested preview-only live link (Gateway loopback
      // transport + connector session, disconnect/reorder/duplicate tests);
      // it is never the durable scene channel. Unity and Godot stay planned.
      const livePreviewLevel = descriptor.id === "unreal" ? "native" : "planned";
      expect(byId.get("live_link")).toEqual({ id: "live_link", level: livePreviewLevel, layer: "connector" });
    }
  });

  it("rejects capability records that confuse connector and exchange-format semantics", () => {
    const descriptor = getDirectorDccProviderDescriptor("maya");
    const base = { ...descriptor, capabilities: [{ id: "scene", level: "exchange" }] };

    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [{ id: "animation", level: "exchange" }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [{ id: "animation", level: "exchange", layer: "connector" }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [{ id: "scene", level: "exchange", layer: "exchange-format" }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [{ id: "scene", level: "native", layer: "exchange-format", formats: ["usda"] }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [{ id: "stable_ids", level: "exchange", layer: "director-manifest", formats: ["usda"] }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [{ id: "animation", level: "exchange", layer: "director-manifest" }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        capabilities: [
          { id: "scene", level: "exchange", layer: "exchange-format", formats: ["usda"] },
          { id: "scene", level: "exchange", layer: "exchange-format", formats: ["usda"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...base,
        exchangeFormats: ["glb"],
        preferredFormat: "glb",
        capabilities: [{ id: "scene", level: "exchange", layer: "exchange-format", formats: ["usda"] }],
      }).success,
    ).toBe(false);
  });

  it("keeps built-in lookup separate from the open provider-id namespace", () => {
    expect(directorDccProviderIdSchema.parse("thirdparty.pipeline")).toBe("thirdparty.pipeline");
    expect(() => getDirectorDccProviderDescriptor("thirdparty.pipeline")).toThrow(
      "Unknown Director DCC provider: thirdparty.pipeline",
    );
  });

  it("strictly validates descriptors, statuses, and discovery catalogs", () => {
    const descriptor = directorDccProviderDescriptorSchema.parse({
      id: "studio.custom",
      label: "Studio Custom",
      category: "dcc",
      integration: "exchange-package",
      preferredFormat: "glb",
      exchangeFormats: ["glb"],
      capabilities: [{ id: "scene", level: "exchange" }],
      connectorDirectory: "integrations/studio.custom",
    });
    const status = directorDccProviderStatusSchema.parse({
      provider: descriptor,
      installed: true,
      executable: "/opt/studio/custom",
      version: "1.2.3",
      nativeReady: false,
      exchangeReady: true,
      reason: null,
    });

    expect(
      directorDccProviderCatalogSchema.parse({
        contract: "director-dcc-provider-catalog-v1",
        providers: [status],
      }),
    ).toEqual({ contract: "director-dcc-provider-catalog-v1", providers: [status] });

    expect(directorDccProviderDescriptorSchema.safeParse({ ...descriptor, unexpected: true }).success).toBe(false);
    expect(directorDccProviderStatusSchema.safeParse({ ...status, unexpected: true }).success).toBe(false);
    expect(
      directorDccProviderCatalogSchema.safeParse({
        contract: "director-dcc-provider-catalog-v1",
        providers: [status],
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderDescriptorSchema.safeParse({
        ...descriptor,
        capabilities: [{ id: "arbitrary-capability", level: "native" }],
      }).success,
    ).toBe(false);
  });

  it("accepts only declarative portable exchange provider configuration", () => {
    const configuration = {
      contract: DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT,
      providers: [configuredProvider("vendor.pipeline-v2")],
    };

    expect(directorDccProviderConfigSchema.parse(configuration)).toEqual(configuration);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), nativeReady: true }],
      }).success,
    ).toBe(false);
    for (const id of ["animation", "skeleton", "materials", "roundtrip", "headless"] as const) {
      expect(
        directorDccProviderConfigSchema.safeParse({
          ...configuration,
          providers: [
            {
              ...configuredProvider(),
              capabilities: [{ id, level: "exchange" }],
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), command: ["python", "connector.py"] }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), integration: "native-roundtrip" }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), preferredFormat: "blend", exchangeFormats: ["blend"] }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), capabilities: [{ id: "scene", level: "native" }] }],
      }).success,
    ).toBe(false);
  });

  it("rejects inconsistent or duplicate configured provider claims", () => {
    const configuration = { contract: DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT };

    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), preferredFormat: "glb", exchangeFormats: ["usda"] }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [{ ...configuredProvider(), exchangeFormats: ["usda", "usda"] }],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [
          {
            ...configuredProvider(),
            capabilities: [
              { id: "scene", level: "exchange" },
              { id: "scene", level: "planned" },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [
          {
            ...configuredProvider(),
            capabilities: [{ id: "live_link", level: "exchange" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      directorDccProviderConfigSchema.safeParse({
        ...configuration,
        providers: [configuredProvider("studio.duplicate"), configuredProvider("studio.duplicate")],
      }).success,
    ).toBe(false);
  });
});
