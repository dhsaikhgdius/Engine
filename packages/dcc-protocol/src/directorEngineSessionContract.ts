import { z } from "zod";
import { directorDccTransformSchema } from "./directorDccSharedContract";
import { directorEngineSceneProviderSchema } from "./directorEngineSceneImportContract";

/** Whether Director authors the scene or reviews an engine-owned scene. */
export const directorEngineSessionAuthoritySchema = z.enum(["director", "engine"]);

/** A validated engine-session authority mode. */
export type DirectorEngineSessionAuthority = z.infer<typeof directorEngineSessionAuthoritySchema>;

/** Commands supported by persistent game-engine editor sessions. */
export const directorEngineSessionCommandNameSchema = z.enum(["capture_frame", "execute_code", "sync_scene"]);

/** A validated persistent editor command name. */
export type DirectorEngineSessionCommandName = z.infer<typeof directorEngineSessionCommandNameSchema>;

/** Language selected by the connector from its engine provider. */
export const directorEngineSessionCodeLanguageSchema = z.enum(["csharp", "gdscript", "python"]);

/** One engine-owned entity projected into Director's review view. */
export const directorEngineSessionSnapshotEntitySchema = z.strictObject({
  directorId: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(240),
  entityType: z.enum(["object", "camera", "light"]),
  transform: directorDccTransformSchema,
  fovDegrees: z.number().finite().positive().max(179).optional(),
});

/** A validated review-view entity from a live engine scene. */
export type DirectorEngineSessionSnapshotEntity = z.infer<typeof directorEngineSessionSnapshotEntitySchema>;

/** A bounded engine-owned scene snapshot used for repeated review syncs. */
export const directorEngineSessionSceneSnapshotSchema = z.strictObject({
  provider: directorEngineSceneProviderSchema,
  scenePath: z.string().trim().min(1).max(1_024).nullable(),
  capturedAt: z.string().datetime(),
  entities: z.array(directorEngineSessionSnapshotEntitySchema).max(4_096),
});

/** A validated live engine scene snapshot. */
export type DirectorEngineSessionSceneSnapshot = z.infer<typeof directorEngineSessionSceneSnapshotSchema>;

const commandIdSchema = z.string().uuid();

/** Sequence payloads delivered to an already-open engine editor. */
export const directorEngineSessionCommandPayloadSchema = z.discriminatedUnion("command", [
  z.strictObject({
    kind: z.literal("editor_command"),
    commandId: commandIdSchema,
    command: z.literal("capture_frame"),
    camera: z.string().trim().min(1).max(240).optional(),
    width: z.number().int().min(64).max(1_920),
    height: z.number().int().min(64).max(1_080),
  }),
  z.strictObject({
    kind: z.literal("editor_command"),
    commandId: commandIdSchema,
    command: z.literal("execute_code"),
    language: directorEngineSessionCodeLanguageSchema,
    code: z.string().min(1).max(100_000),
  }),
  z.strictObject({
    kind: z.literal("editor_command"),
    commandId: commandIdSchema,
    command: z.literal("sync_scene"),
  }),
]);

/** A validated command payload sent to an editor connector. */
export type DirectorEngineSessionCommandPayload = z.infer<typeof directorEngineSessionCommandPayloadSchema>;

/** Connector results for capture, code execution, and scene review sync. */
export const directorEngineSessionCommandResultSchema = z.union([
  z.strictObject({
    commandId: commandIdSchema,
    command: z.literal("capture_frame"),
    status: z.literal("completed"),
    mimeType: z.literal("image/png"),
    imageBase64: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024),
    width: z.number().int().min(64).max(1_920),
    height: z.number().int().min(64).max(1_080),
  }),
  z.strictObject({
    commandId: commandIdSchema,
    command: z.literal("execute_code"),
    status: z.literal("completed"),
    output: z.string().max(128 * 1024),
  }),
  z.strictObject({
    commandId: commandIdSchema,
    command: z.literal("sync_scene"),
    status: z.literal("completed"),
    snapshot: directorEngineSessionSceneSnapshotSchema,
  }),
  z.strictObject({
    commandId: commandIdSchema,
    command: directorEngineSessionCommandNameSchema,
    status: z.literal("failed"),
    error: z.string().trim().min(1).max(4_000),
  }),
]);

/** A validated result returned by an engine editor connector. */
export type DirectorEngineSessionCommandResult = z.infer<typeof directorEngineSessionCommandResultSchema>;
