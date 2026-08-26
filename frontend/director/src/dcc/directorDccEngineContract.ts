import { z } from "zod";
import { DIRECTOR_PROJECT_REVISION_PATTERN } from "../comprehensive/editor/schema/directorProjectRevision";
import { directorDccEngineIdSchema } from "./directorDccEngineSpace";
import { directorUnrealCleanFrameReceiptSchema } from "./directorUnrealCleanFrameContract";
import {
  directorUnrealOmittedChannelDetailSchema,
  directorUnrealOmittedChannelIdSchema,
  directorUnrealSequencerReceiptSchema,
} from "./directorUnrealSequencerContract";
import { directorGodotImportReceiptSchema } from "./directorGodotAnimationContract";

/** Contract identifier for a Director-authored engine connector manifest. */
export const DIRECTOR_DCC_CONNECTOR_MANIFEST_CONTRACT = "director-dcc-connector-v1" as const;

/** Contract identifier for the report an engine connector writes after a headless run. */
export const DIRECTOR_DCC_ENGINE_REPORT_CONTRACT = "director-dcc-engine-report-v1" as const;

/** Contract identifier for an engine connector health check result. */
export const DIRECTOR_DCC_ENGINE_HEALTH_CONTRACT = "director-dcc-engine-health-v1" as const;

/** Contract identifier for the gateway result of a headless send-to-engine job. */
export const DIRECTOR_DCC_ENGINE_SEND_CONTRACT = "director-dcc-engine-send-v1" as const;

const nonEmpty = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
const safeRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: "path must be a safe relative path" },
  );

/**
 * The Director-authored connector manifest committed at
 * `integrations/<provider>/connector.json`. The gateway reads this file to
 * locate the fixed connector entry points; a request can never substitute its
 * own script.
 */
export const directorDccConnectorManifestSchema = z.strictObject({
  contract: z.literal(DIRECTOR_DCC_CONNECTOR_MANIFEST_CONTRACT),
  provider: directorDccEngineIdSchema,
  /** Version of the Director-authored connector source. */
  version: nonEmpty.max(60),
  /** Fixed entry points relative to the connector directory. */
  entryPoints: z.strictObject({
    health: safeRelativePathSchema,
    import: safeRelativePathSchema,
    export: safeRelativePathSchema,
  }),
  /** Human-readable host requirement, e.g. "Unreal Engine 5.3+". */
  hostRequirement: nonEmpty.max(200),
});

/** A validated engine connector manifest. */
export type DirectorDccConnectorManifest = z.infer<typeof directorDccConnectorManifestSchema>;

/**
 * Animation channels the Unity connector can decline to bake. Every declined
 * channel must be reported as a structured omission (never silently dropped):
 * - `poseValues` — semantic pose controls (bakeable on Mixamo rigs; omitted
 *   for other rig types or unresolvable skeletons).
 * - `motionBlocks` — packaged skeletal clip playback; the clip GLBs are not
 *   part of the exchange package, so playback cannot be baked host-side.
 * - `motion` — the legacy procedural gait pace selector (same clip payloads).
 * - `ik` — Director-side two-bone IK goals, not ported to the connector.
 */
export const directorDccUnityOmittedChannelIdSchema = z.enum(["poseValues", "motionBlocks", "motion", "ik"]);

/** One structured warn-and-omit record for a channel the connector skipped. */
export const directorDccUnityOmittedChannelSchema = z.strictObject({
  /** The Director entity whose channel was omitted. */
  directorId: nonEmpty.max(240),
  channel: directorDccUnityOmittedChannelIdSchema,
  /** Human-readable reason (why it could not bake, and what to do instead). */
  reason: nonEmpty.max(600),
});

/** A structured omitted-channel record from the Unity connector report. */
export type DirectorDccUnityOmittedChannel = z.infer<typeof directorDccUnityOmittedChannelSchema>;

/**
 * One structured warn-and-omit record for a Director light the Unity connector
 * declined to spawn as a GameObject. Ambient/hemisphere map to RenderSettings
 * (not omitted); unknown vocabulary types are reported here with a stable code.
 */
export const directorUnityOmittedLightSchema = z.strictObject({
  directorId: z.string().trim().min(1).max(200),
  code: z.enum(["light_type_unknown"]),
  lightType: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(600),
});

/** A validated Unity omitted-light record. */
export type DirectorUnityOmittedLight = z.infer<typeof directorUnityOmittedLightSchema>;

/**
 * Unity-specific details block the `com.director.bridge` connector appends to
 * its run report. Every field is an observed fact about the finished import —
 * not a capability claim — so the Gateway and Agents can audit what the
 * connector actually produced without parsing Unity project files.
 */
export const directorDccUnityEngineReportDetailsSchema = z
  .strictObject({
    /** Project-relative Timeline asset path, or null when no shots/animation mapped. */
    timelinePath: z.string().trim().min(1).max(1_024).nullable(),
    /** Render pipeline the material fallback targeted during the run. */
    renderPipeline: z.enum(["built-in", "urp", "hdrp", "custom"]),
    /** Whether a glTF ScriptedImporter produced prefabs for GLB payloads. */
    gltfImporterAvailable: z.boolean(),
    /** Lights created from the manifest with director_id markers. */
    importedLightCount: z.number().int().nonnegative(),
    /**
     * Count of Director lights the connector declined to spawn as GameObjects.
     * Optional: connector builds before typed omittedLights omit this field.
     */
    omittedLightCount: z.number().int().nonnegative().max(100_000).optional(),
    /**
     * Typed warn-and-omit records for lights Unity cannot spawn (unknown type
     * today). Optional for older connectors; when present, length must equal
     * omittedLightCount.
     */
    omittedLights: z.array(directorUnityOmittedLightSchema).max(1_024).optional(),
    /** AnimationClips baked from Director keyframe/trajectory channels. */
    bakedAnimationClipCount: z.number().int().nonnegative(),
    /** Humanoid Avatars built from Mixamo-compatible skinned payloads. */
    humanoidAvatarCount: z.number().int().nonnegative(),
    /** Generic Avatars built where Humanoid mapping was not possible. */
    genericAvatarCount: z.number().int().nonnegative(),
    /** Materials created from Director PBR manifest fallback. */
    materialFallbackCount: z.number().int().nonnegative(),
    /**
     * Texture slots successfully bound onto those fallback materials from
     * hashed package assets. Optional: connector 0.3.0 reports predate this
     * count (textures still bind when present).
     */
    appliedTextureCount: z.number().int().nonnegative().optional(),
    /**
     * Characters posed from Director semantic pose controls (static controls
     * applied to the imported skeleton, keyframed controls baked to clips).
     * Optional: connector 0.2.x reports predate pose baking.
     */
    posedCharacterCount: z.number().int().nonnegative().optional(),
    /**
     * Structured warn-and-omit records for animation channels the connector
     * declined to bake. Optional: connector 0.2.x reports predate this field
     * and carried free-text warnings only.
     */
    omittedChannels: z.array(directorDccUnityOmittedChannelSchema).max(4_096).optional(),
  })
  .superRefine((receipt, context) => {
    if (receipt.omittedLights !== undefined) {
      const count = receipt.omittedLightCount ?? receipt.omittedLights.length;
      if (receipt.omittedLightCount !== undefined && receipt.omittedLights.length !== receipt.omittedLightCount) {
        context.addIssue({
          code: "custom",
          path: ["omittedLights"],
          message: "omittedLights length must equal omittedLightCount",
        });
      } else if (receipt.omittedLightCount === undefined && receipt.omittedLights.length !== count) {
        context.addIssue({
          code: "custom",
          path: ["omittedLightCount"],
          message: "omittedLightCount is required when omittedLights is present",
        });
      }
    }
  });

/** Unity-specific details block of an engine connector run report. */
export type DirectorDccUnityEngineReportDetails = z.infer<typeof directorDccUnityEngineReportDetailsSchema>;

/**
 * One structured warn-and-omit record for animation channels the Unreal
 * Sequencer bake cannot carry (Control-Rig-style pose values, motion clips,
 * character rig state). World transforms are still baked; these channels are
 * reported instead of being silently flattened. The optional `details` list
 * names the affected controls/clips per channel with a reason, so the
 * frontend can list exactly what was omitted. Control Rig lossless
 * round-trip stays planned; these records never imply it shipped.
 */
export const directorUnrealOmittedAnimationChannelsSchema = z.strictObject({
  directorId: z.string().trim().min(1).max(200),
  entityType: z.enum(["object", "camera"]),
  channels: directorUnrealOmittedChannelIdSchema.array().min(1).max(8),
  /** Per-channel control names and reasons. Optional: connector 0.3.x echoes predate this field. */
  details: z.array(directorUnrealOmittedChannelDetailSchema).max(8).optional(),
});

/** A validated structured omitted-channel record. */
export type DirectorUnrealOmittedAnimationChannels = z.infer<typeof directorUnrealOmittedAnimationChannelsSchema>;

/**
 * Director light types, mirroring `DIRECTOR_LIGHT_TYPES` in the project
 * schema (`directorProjectOptions.json`).
 */
export const directorUnrealLightTypeSchema = z.enum([
  "ambient",
  "hemisphere",
  "directional",
  "point",
  "spot",
  "rect-area",
]);

/**
 * One structured warn-and-omit record for a Director light the Unreal
 * connector declined to spawn. Directional, point, spot, and rect-area
 * lights map to Unreal light actors; ambient and hemisphere lights have no
 * single-actor Unreal equivalent and are reported here instead of being
 * silently dropped.
 */
export const directorUnrealOmittedLightSchema = z.strictObject({
  directorId: z.string().trim().min(1).max(200),
  lightType: directorUnrealLightTypeSchema,
  reason: z.string().trim().min(1).max(600),
});

/** A validated structured omitted-light record. */
export type DirectorUnrealOmittedLight = z.infer<typeof directorUnrealOmittedLightSchema>;

/**
 * The receipt an engine connector writes after a headless import run. The
 * gateway schema-validates this file; a malformed or `ok:false` report fails
 * the job with structured diagnostics.
 */
export const directorDccEngineReportSchema = z
  .strictObject({
    ok: z.literal(true),
    contract: z.literal(DIRECTOR_DCC_ENGINE_REPORT_CONTRACT),
    provider: directorDccEngineIdSchema,
    hostVersion: nonEmpty.max(200),
    connectorVersion: nonEmpty.max(60),
    /** The exchange package id this run consumed. */
    packageId: nonEmpty.max(240),
    sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
    importedObjectCount: z.number().int().nonnegative(),
    importedCameraCount: z.number().int().nonnegative(),
    /** Host-side scene path (e.g. `/Game/Director/...`, `Assets/Director/...`, `res://director/...`). */
    scenePath: z.string().trim().min(1).max(1_024).nullable(),
    /** Relative directory of an echoed return package when the connector produced one. */
    returnPackageDir: safeRelativePathSchema.nullable(),
    warnings: z.array(z.string().max(2_000)).max(20_000),
    /** Unreal-only: Sequencer receipt read back from the authored LevelSequence. */
    sequencer: directorUnrealSequencerReceiptSchema.optional(),
    /** Unreal-only: number of skinned GLB payloads imported as skeletal meshes. */
    importedSkeletalMeshCount: z.number().int().nonnegative().optional(),
    /** Unreal-only: number of Director PBR materials applied as material instances. */
    appliedMaterialCount: z.number().int().nonnegative().optional(),
    /** Unreal-only: number of bundled texture files imported and bound to material-instance texture parameters. */
    appliedTextureCount: z.number().int().nonnegative().optional(),
    /** Unreal-only: Director lights spawned as Unreal light actors tagged `director_light_id:` (not `director_id`). */
    importedLightCount: z.number().int().nonnegative().optional(),
    /** Unreal-only: Director lights the connector declined to spawn (warn-and-omit). */
    omittedLights: z.array(directorUnrealOmittedLightSchema).max(1_024).optional(),
    /** Unreal-only: pose/rig channels the bake omitted, echoed from the verified sidecar. */
    omittedAnimationChannels: z.array(directorUnrealOmittedAnimationChannelsSchema).max(2_048).optional(),
    /** Unity connector details; only the unity provider may write this block. */
    unity: directorDccUnityEngineReportDetailsSchema.optional(),
    /** Godot-only: import receipt read back from the saved scene and animation resources. */
    godot: directorGodotImportReceiptSchema.optional(),
  })
  .superRefine((report, context) => {
    if (report.unity && report.provider !== "unity") {
      context.addIssue({
        code: "custom",
        path: ["unity"],
        message: "only unity connector reports may carry the unity details block",
      });
    }
    if (report.godot && report.provider !== "godot") {
      context.addIssue({
        code: "custom",
        path: ["godot"],
        message: "only godot connector reports may carry the godot details block",
      });
    }
  });

/** A validated engine connector run report. */
export type DirectorDccEngineReport = z.infer<typeof directorDccEngineReportSchema>;

/** Individual checks that make up an engine connector health probe. */
export const directorDccEngineHealthCheckIdSchema = z.enum([
  "executable",
  "host_version",
  "connector_manifest",
  "connector_entry",
  "engine_project",
  "project_connector",
  /** The engine project has the Director connector enabled (Godot: `[editor_plugins]`). */
  "project_plugin_enabled",
  /** The fixed connector entry answered a `--mode health` probe with valid JSON. */
  "connector_health",
]);

/** Identifier of one engine health check. */
export type DirectorDccEngineHealthCheckId = z.infer<typeof directorDccEngineHealthCheckIdSchema>;

/**
 * The result of an engine connector health probe. `ready` is true only when
 * every check passed: the Director-authored connector files exist, the host
 * executable was found and versioned, and the configured engine project
 * contains the installed connector.
 */
export const directorDccEngineHealthSchema = z.strictObject({
  contract: z.literal(DIRECTOR_DCC_ENGINE_HEALTH_CONTRACT),
  provider: directorDccEngineIdSchema,
  ready: z.boolean(),
  executable: z.string().nullable(),
  hostVersion: z.string().nullable(),
  connectorVersion: z.string().nullable(),
  /** Workspace-relative connector source directory. */
  connectorDirectory: nonEmpty.max(240),
  /** The configured engine project path, or null when not configured. */
  projectPath: z.string().nullable(),
  checks: z.array(
    z.strictObject({
      id: directorDccEngineHealthCheckIdSchema,
      ok: z.boolean(),
      detail: z.string().max(2_000),
    }),
  ),
  warnings: z.array(z.string().max(2_000)),
  recovery: z.array(z.string().max(2_000)),
});

/** A validated engine connector health result. */
export type DirectorDccEngineHealth = z.infer<typeof directorDccEngineHealthSchema>;

/**
 * Structured diagnostics returned when a native engine operation is not
 * available. Agents should follow `recovery` instead of retrying blindly.
 */
export const directorDccEngineDiagnosticsSchema = z.strictObject({
  provider: directorDccEngineIdSchema,
  mode: z.enum(["native", "exchange"]),
  ready: z.boolean(),
  warnings: z.array(z.string().max(2_000)),
  recovery: z.array(z.string().max(2_000)),
});

/** Structured not-ready diagnostics for an engine operation. */
export type DirectorDccEngineDiagnostics = z.infer<typeof directorDccEngineDiagnosticsSchema>;

/**
 * The gateway result of a completed headless send-to-engine job: the exchange
 * package that was produced plus the schema-validated host report.
 */
export const directorDccEngineSendResultSchema = z.strictObject({
  contract: z.literal(DIRECTOR_DCC_ENGINE_SEND_CONTRACT),
  jobId: z.string().uuid(),
  provider: directorDccEngineIdSchema,
  packagePath: nonEmpty.max(2_048),
  manifestPath: nonEmpty.max(2_048),
  manifestSha256: sha256Schema,
  packageDigest: sha256Schema,
  sourceRevision: z.string().regex(DIRECTOR_PROJECT_REVISION_PATTERN),
  reportPath: nonEmpty.max(2_048),
  report: directorDccEngineReportSchema,
  /** Absolute path of the echoed return package directory, when produced. */
  returnPackagePath: z.string().nullable(),
  /**
   * Unreal-only: pose/rig channels the Gateway bake omitted (warn-and-omit),
   * computed from the Gateway's own sidecar so an outdated connector can never
   * silently flatten them out of the result.
   */
  omittedAnimationChannels: z.array(directorUnrealOmittedAnimationChannelsSchema).max(2_048).optional(),
  /** Unreal-only: the optional clean-frame render receipt (rendered or skipped with reason). */
  cleanFrame: directorUnrealCleanFrameReceiptSchema.optional(),
  warnings: z.array(z.string().max(2_000)),
});

/** The result of a completed headless send-to-engine job. */
export type DirectorDccEngineSendResult = z.infer<typeof directorDccEngineSendResultSchema>;
