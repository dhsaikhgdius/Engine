import { z } from "zod";

/**
 * Stable provider identifiers used by HTTP, MCP, the editor and host connectors.
 * Keep these identifiers product-neutral: a connector may be implemented by a
 * native plug-in, a headless process, or an OpenUSD/glTF package consumer.
 */
export const directorDccProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "provider id must be a lowercase, namespaced identifier");

/** Stable provider identifier for a DCC integration. */
export type DirectorDccProviderId = z.infer<typeof directorDccProviderIdSchema>;

/** The exchange format a DCC provider can produce or consume. "blend" is native-only. */
export const directorDccExchangeFormatSchema = z.enum(["blend", "glb", "usda"]);
export type DirectorDccExchangeFormat = z.infer<typeof directorDccExchangeFormatSchema>;

/** Portable exchange formats that can be transferred across systems (excludes "blend"). */
export const directorDccPortableExchangeFormatSchema = z.enum(["glb", "usda"]);
export type DirectorDccPortableExchangeFormat = z.infer<typeof directorDccPortableExchangeFormatSchema>;

/** Capability identifiers a DCC provider can advertise. */
export const directorDccCapabilityIdSchema = z.enum([
  "scene",
  "camera",
  "animation",
  "skeleton",
  "materials",
  "stable_ids",
  "roundtrip",
  "headless",
  "live_link",
]);

export type DirectorDccCapabilityId = z.infer<typeof directorDccCapabilityIdSchema>;

/** The maturity level of a capability: native, exchange-based, or planned. */
export const directorDccCapabilityLevelSchema = z.enum(["native", "exchange", "planned"]);
export type DirectorDccCapabilityLevel = z.infer<typeof directorDccCapabilityLevelSchema>;

/** The architectural layer that supplies a capability. */
export const directorDccCapabilityLayerSchema = z.enum(["connector", "exchange-format", "director-manifest"]);
export type DirectorDccCapabilityLayer = z.infer<typeof directorDccCapabilityLayerSchema>;

/**
 * A single capability claim from a DCC provider, including its maturity level
 * and the layer that supplies it. Exchange-level animation, skeleton, and
 * materials claims must identify their supplying layer.
 */
export const directorDccCapabilitySchema = z
  .strictObject({
    id: directorDccCapabilityIdSchema,
    level: directorDccCapabilityLevelSchema,
    /**
     * Identifies the layer that actually supplies the advertised capability.
     * Optional only for backwards-compatible third-party descriptors. Built-in
     * descriptors always publish it, so Agents never infer host-native support
     * from a portable layout package.
     */
    layer: directorDccCapabilityLayerSchema.optional(),
    /** Portable formats that carry an exchange-format capability. */
    formats: z.array(directorDccPortableExchangeFormatSchema).min(1).optional(),
  })
  .superRefine((capability, context) => {
    if (
      !capability.layer &&
      capability.level === "exchange" &&
      (capability.id === "animation" || capability.id === "skeleton" || capability.id === "materials")
    ) {
      context.addIssue({
        code: "custom",
        path: ["layer"],
        message: `${capability.id} exchange claims must identify their supplying layer`,
      });
    }

    if (capability.layer === "exchange-format") {
      if (capability.level !== "exchange") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "exchange-format capabilities must use the exchange level",
        });
      }
      if (!capability.formats?.length) {
        context.addIssue({
          code: "custom",
          path: ["formats"],
          message: "exchange-format capabilities must name at least one portable format",
        });
      }
    } else if (capability.formats) {
      context.addIssue({
        code: "custom",
        path: ["formats"],
        message: "only exchange-format capabilities may name portable formats",
      });
    }

    if (capability.layer === "connector" && capability.level === "exchange") {
      context.addIssue({
        code: "custom",
        path: ["level"],
        message: "connector capabilities must be native or planned, not exchange",
      });
    }

    if (capability.layer === "director-manifest" && capability.id !== "stable_ids") {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "the current Director manifest capability vocabulary only supplies stable_ids",
      });
    }
  });

/**
 * A full DCC provider descriptor as emitted by the runtime registry.
 * Includes native installation state, executable paths, and all capability claims.
 */
export const directorDccProviderDescriptorSchema = z
  .strictObject({
    id: directorDccProviderIdSchema,
    label: z.string().trim().min(1).max(80),
    category: z.enum(["dcc", "engine"]),
    /**
     * How Director integrates with the provider:
     * - `native-roundtrip` — an in-process bridge drives the host end to end (Blender).
     * - `engine-headless` — a Director-authored connector runs fixed headless
     *   entry points inside the user's engine installation; scene content still
     *   travels through the portable exchange package.
     * - `exchange-package` — Director only prepares/consumes the portable package.
     */
    integration: z.enum(["native-roundtrip", "engine-headless", "exchange-package"]),
    preferredFormat: directorDccExchangeFormatSchema,
    exchangeFormats: z.array(directorDccExchangeFormatSchema).min(1),
    capabilities: z.array(directorDccCapabilitySchema).min(1),
    connectorDirectory: z.string().trim().min(1).max(240),
  })
  .superRefine((descriptor, context) => {
    if (!descriptor.exchangeFormats.includes(descriptor.preferredFormat)) {
      context.addIssue({
        code: "custom",
        path: ["preferredFormat"],
        message: "preferredFormat must also appear in exchangeFormats",
      });
    }

    const seenCapabilities = new Set<DirectorDccCapabilityId>();
    descriptor.capabilities.forEach((capability, index) => {
      if (seenCapabilities.has(capability.id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "id"],
          message: `duplicate capability ${capability.id}`,
        });
      }
      seenCapabilities.add(capability.id);

      capability.formats?.forEach((format, formatIndex) => {
        if (!descriptor.exchangeFormats.includes(format)) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index, "formats", formatIndex],
            message: `${format} is not declared in provider exchangeFormats`,
          });
        }
      });
    });
  });

/** Type of a full DCC provider descriptor with runtime installation state. */
export type DirectorDccProviderDescriptor = z.infer<typeof directorDccProviderDescriptorSchema>;

/** Runtime status of a single DCC provider, including installation and readiness flags. */
export const directorDccProviderStatusSchema = z.strictObject({
  provider: directorDccProviderDescriptorSchema,
  installed: z.boolean(),
  executable: z.string().nullable(),
  version: z.string().nullable(),
  nativeReady: z.boolean(),
  exchangeReady: z.boolean(),
  reason: z.string().nullable(),
});

/** Inferred type of a DCC provider status record. */
export type DirectorDccProviderStatus = z.infer<typeof directorDccProviderStatusSchema>;

/** A catalog of all installed DCC providers with their runtime statuses. */
export const directorDccProviderCatalogSchema = z.strictObject({
  contract: z.literal("director-dcc-provider-catalog-v1"),
  providers: z.array(directorDccProviderStatusSchema),
});

/** Inferred type of the DCC provider catalog. */
export type DirectorDccProviderCatalog = z.infer<typeof directorDccProviderCatalogSchema>;

/**
 * Declarative, exchange-only provider configuration accepted by the gateway.
 *
 * This is intentionally narrower than DirectorDccProviderDescriptor: a local
 * configuration file cannot provide executable paths, commands, connector
 * modules, native readiness, or capability-layer claims. Those runtime values
 * are derived by the trusted registry implementation.
 */
export const DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT = "director-dcc-provider-config-v1" as const;

const directorDccConfiguredCapabilitySchema = z.strictObject({
  id: directorDccCapabilityIdSchema,
  level: z.enum(["exchange", "planned"]),
});

/**
 * A user-configured DCC provider for exchange-only integrations.
 * Narrower than the full runtime descriptor — no executable paths or native readiness.
 */
export const directorDccConfiguredProviderSchema = z
  .strictObject({
    id: directorDccProviderIdSchema,
    label: z.string().trim().min(1).max(80),
    category: z.enum(["dcc", "engine"]),
    integration: z.literal("exchange-package"),
    preferredFormat: directorDccPortableExchangeFormatSchema,
    exchangeFormats: z.array(directorDccPortableExchangeFormatSchema).min(1).max(2),
    capabilities: z
      .array(directorDccConfiguredCapabilitySchema)
      .min(1)
      .max(directorDccCapabilityIdSchema.options.length),
  })
  .superRefine((provider, context) => {
    if (!provider.exchangeFormats.includes(provider.preferredFormat)) {
      context.addIssue({
        code: "custom",
        path: ["preferredFormat"],
        message: "preferredFormat must also appear in exchangeFormats",
      });
    }

    const seenFormats = new Set<DirectorDccPortableExchangeFormat>();
    provider.exchangeFormats.forEach((format, index) => {
      if (seenFormats.has(format)) {
        context.addIssue({
          code: "custom",
          path: ["exchangeFormats", index],
          message: `duplicate exchange format ${format}`,
        });
      }
      seenFormats.add(format);
    });

    const seenCapabilities = new Set<DirectorDccCapabilityId>();
    provider.capabilities.forEach((capability, index) => {
      if (seenCapabilities.has(capability.id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "id"],
          message: `duplicate capability ${capability.id}`,
        });
      }
      seenCapabilities.add(capability.id);

      if (
        capability.level === "exchange" &&
        capability.id !== "scene" &&
        capability.id !== "camera" &&
        capability.id !== "stable_ids"
      ) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "level"],
          message: `${capability.id} is not supplied by the current portable layout package`,
        });
      }
    });
  });

/** Inferred type of a configured exchange-only provider. */
export type DirectorDccConfiguredProvider = z.infer<typeof directorDccConfiguredProviderSchema>;

/** The top-level configuration contract for exchange-only DCC providers. */
export const directorDccProviderConfigSchema = z
  .strictObject({
    contract: z.literal(DIRECTOR_DCC_PROVIDER_CONFIG_CONTRACT),
    providers: z.array(directorDccConfiguredProviderSchema).max(64),
  })
  .superRefine((configuration, context) => {
    const seenProviders = new Set<DirectorDccProviderId>();
    configuration.providers.forEach((provider, index) => {
      if (seenProviders.has(provider.id)) {
        context.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: `duplicate provider ${provider.id}`,
        });
      }
      seenProviders.add(provider.id);
    });
  });

/** Inferred type of the provider configuration file. */
export type DirectorDccProviderConfig = z.infer<typeof directorDccProviderConfigSchema>;

function exchangeProvider(
  id: DirectorDccProviderId,
  label: string,
  category: DirectorDccProviderDescriptor["category"],
  preferredFormat: Exclude<DirectorDccExchangeFormat, "blend">,
  exchangeFormats: Array<Exclude<DirectorDccExchangeFormat, "blend">>,
): DirectorDccProviderDescriptor {
  return directorDccProviderDescriptorSchema.parse({
    id,
    label,
    category,
    integration: "exchange-package",
    preferredFormat,
    exchangeFormats,
    capabilities: [
      { id: "scene", level: "exchange", layer: "exchange-format", formats: exchangeFormats },
      { id: "camera", level: "exchange", layer: "exchange-format", formats: exchangeFormats },
      { id: "animation", level: "planned", layer: "connector" },
      { id: "skeleton", level: "planned", layer: "connector" },
      { id: "materials", level: "planned", layer: "connector" },
      { id: "stable_ids", level: "exchange", layer: "director-manifest" },
      { id: "roundtrip", level: "planned", layer: "connector" },
      { id: "headless", level: "planned", layer: "connector" },
      { id: "live_link", level: "planned", layer: "connector" },
    ],
    connectorDirectory: `integrations/${id}`,
  });
}

function engineProvider(
  id: DirectorDccProviderId,
  label: string,
  preferredFormat: Exclude<DirectorDccExchangeFormat, "blend">,
  exchangeFormats: Array<Exclude<DirectorDccExchangeFormat, "blend">>,
): DirectorDccProviderDescriptor {
  return directorDccProviderDescriptorSchema.parse({
    id,
    label,
    category: "engine",
    integration: "engine-headless",
    preferredFormat,
    exchangeFormats,
    capabilities: [
      // Scene layout and cameras still travel through the portable package;
      // the connector performs the host-side import but the format carries them.
      { id: "scene", level: "exchange", layer: "exchange-format", formats: exchangeFormats },
      { id: "camera", level: "exchange", layer: "exchange-format", formats: exchangeFormats },
      // Animation, skeletons, and materials stay planned until a version-tested
      // acceptance suite validates the host-side work end to end.
      { id: "animation", level: "planned", layer: "connector" },
      { id: "skeleton", level: "planned", layer: "connector" },
      { id: "materials", level: "planned", layer: "connector" },
      // The Director manifest and connector preserve stable director:id
      // metadata on both directions of the handoff.
      { id: "stable_ids", level: "native", layer: "director-manifest" },
      // Headless import/return round trip is performed by the Director-authored
      // connector; runtime availability is still gated by nativeReady.
      { id: "roundtrip", level: "native", layer: "connector" },
      { id: "headless", level: "native", layer: "connector" },
      // No live preview transport ships yet; see MULTI_DCC_INTEGRATION.md.
      { id: "live_link", level: "planned", layer: "connector" },
    ],
    connectorDirectory: `integrations/${id}`,
  });
}

/**
 * Unreal Engine descriptor. Split from the shared `engineProvider()` literal
 * because the Unreal connector ships deeper host-side coverage than the other
 * engine connectors; the shared helper must keep its conservative claims.
 * Every native claim below is backed by host-free golden fixtures
 * (`backend/gateway/tests/dcc/unreal*.test.ts`) and remains gated at runtime
 * by the engine bridge health check (`nativeReady`).
 */
const UNREAL_PROVIDER_DESCRIPTOR: DirectorDccProviderDescriptor = directorDccProviderDescriptorSchema.parse({
  id: "unreal",
  label: "Unreal Engine",
  category: "engine",
  integration: "engine-headless",
  preferredFormat: "usda",
  exchangeFormats: ["usda", "glb"],
  capabilities: [
    // Scene layout and cameras still travel through the portable package;
    // the connector performs the host-side import but the format carries them.
    { id: "scene", level: "exchange", layer: "exchange-format", formats: ["usda", "glb"] },
    { id: "camera", level: "exchange", layer: "exchange-format", formats: ["usda", "glb"] },
    // Time-sampled transform and camera animation is baked by the Gateway
    // (canonical evaluators) and keyed into LevelSequence tracks by the
    // connector. Control-Rig-style pose channels stay warn-and-omit.
    { id: "animation", level: "native", layer: "connector" },
    // Skinned GLB payloads import as skeletal meshes in bind pose with
    // director_id tags; non-skinned character payloads warn-and-omit.
    { id: "skeleton", level: "native", layer: "connector" },
    // Director PBR parameters map to material instances on the parent
    // DirectorPbr materials; unsupported channels warn-and-omit.
    { id: "materials", level: "native", layer: "connector" },
    { id: "stable_ids", level: "native", layer: "director-manifest" },
    { id: "roundtrip", level: "native", layer: "connector" },
    { id: "headless", level: "native", layer: "connector" },
    // A preview-only loopback protocol exists in the connector, but no
    // durable gateway transport ships yet, so the claim stays planned.
    { id: "live_link", level: "planned", layer: "connector" },
  ],
  connectorDirectory: "integrations/unreal",
});

/**
 * Product capability catalog. Runtime installation state is deliberately kept
 * out of this table and is supplied by the gateway registry.
 */
export const DIRECTOR_DCC_PROVIDERS: readonly DirectorDccProviderDescriptor[] = Object.freeze([
  directorDccProviderDescriptorSchema.parse({
    id: "blender",
    label: "Blender",
    category: "dcc",
    integration: "native-roundtrip",
    preferredFormat: "blend",
    exchangeFormats: ["blend", "usda", "glb"],
    capabilities: [
      { id: "scene", level: "native", layer: "connector" },
      { id: "camera", level: "native", layer: "connector" },
      { id: "animation", level: "native", layer: "connector" },
      { id: "skeleton", level: "native", layer: "connector" },
      { id: "materials", level: "native", layer: "connector" },
      { id: "stable_ids", level: "native", layer: "director-manifest" },
      { id: "roundtrip", level: "native", layer: "connector" },
      { id: "headless", level: "native", layer: "connector" },
      { id: "live_link", level: "planned", layer: "connector" },
    ],
    connectorDirectory: "integrations/blender",
  }),
  exchangeProvider("maya", "Autodesk Maya", "dcc", "usda", ["usda", "glb"]),
  UNREAL_PROVIDER_DESCRIPTOR,
  exchangeProvider("houdini", "SideFX Houdini", "dcc", "usda", ["usda", "glb"]),
  exchangeProvider("cinema4d", "Cinema 4D", "dcc", "usda", ["usda", "glb"]),
  engineProvider("unity", "Unity", "glb", ["glb", "usda"]),
  exchangeProvider("3dsmax", "Autodesk 3ds Max", "dcc", "usda", ["usda", "glb"]),
  engineProvider("godot", "Godot", "glb", ["glb"]),
]);

/**
 * Look up the built-in descriptor for a known DCC provider.
 *
 * @param provider - The provider identifier to look up.
 * @returns The frozen provider descriptor.
 * @throws If the provider is not in the built-in catalog.
 */
export function getDirectorDccProviderDescriptor(provider: DirectorDccProviderId) {
  const descriptor = DIRECTOR_DCC_PROVIDERS.find((candidate) => candidate.id === provider);
  if (!descriptor) throw new Error(`Unknown Director DCC provider: ${provider}`);
  return descriptor;
}
