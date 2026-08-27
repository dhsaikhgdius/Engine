import { z } from "zod";
import { creativeWorkspaceAgentToolResultSchema } from "@director/agent-engine/creative";
import { creativeWorkspaceAgentRequestSchema } from "./creativeWorkspaceProtocol";
import { directorWorkbenchOperationSchema } from "@director/agent-engine/contract";
import { directorProjectSchema } from "@director/project-schema";
import { stageSceneSchema } from "@director/stage-protocol";
import { strictType } from "./strictProtocolVariant";

/**
 * Wire contracts shared by the HTTP gateway and the browser client.
 *
 * These schemas intentionally describe transport JSON, rather than the
 * browser's display model.  The browser may still adapt field names for its
 * UI, but it must decode this contract before doing so.
 */
const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nonNegativeInteger = z.number().int().nonnegative();

/** Status of a single assistant chat session. */
export const directorAssistantChatStatusSchema = z.enum([
  "completed",
  "partial",
  "conflict",
  "confirmation_required",
  "failed",
]);

/** Status of a single assistant command execution. */
export const directorAssistantCommandStatusSchema = z.enum([
  "success",
  "conflict",
  "confirmation_required",
  "failed",
  "rejected",
]);

/** A confirmation the browser must present to the user before a command executes. */
export const directorAssistantRequiredConfirmationSchema = z.strictObject({
  sceneId: nonEmptyText(160),
  revision: nonNegativeInteger,
  action: nonEmptyText(160),
  objectIds: z.array(nonEmptyText(160)).min(1).max(200),
});

const confirmationEnvelopeSchema = z.strictObject({
  error: z.string().optional(),
  requiredConfirmation: directorAssistantRequiredConfirmationSchema,
});

/** Error payload for a failed assistant command. */
export const directorAssistantCommandErrorSchema = z.looseObject({
  code: z.string().max(160).optional(),
  message: z.string().max(4_000).optional(),
  requiredConfirmation: z.union([directorAssistantRequiredConfirmationSchema, confirmationEnvelopeSchema]).optional(),
});

/** A single command within an assistant chat session, with tool, status, result, and optional error. */
export const directorAssistantCommandWireSchema = z.strictObject({
  index: nonNegativeInteger,
  tool: nonEmptyText(240),
  status: directorAssistantCommandStatusSchema,
  revision: nonNegativeInteger.nullable(),
  result: z.unknown().optional(),
  error: directorAssistantCommandErrorSchema.optional(),
});

/** A pending plan the browser may execute incrementally. */
export const directorAssistantPendingPlanWireSchema = z.strictObject({
  id: nonEmptyText(160),
  expiresAt: z.string().optional(),
  nextCommandIndex: nonNegativeInteger,
  tool: nonEmptyText(240).optional(),
});

/** A single assistant chat session with commands, summary, status, and optional pending plan. */
export const directorAssistantChatWireSchema = z.strictObject({
  requestId: nonEmptyText(160),
  sceneId: nonEmptyText(160),
  startingRevision: nonNegativeInteger.optional(),
  endingRevision: nonNegativeInteger,
  summary: z.string().max(8_000),
  status: directorAssistantChatStatusSchema,
  commands: z.array(directorAssistantCommandWireSchema).max(80),
  pendingPlan: directorAssistantPendingPlanWireSchema.optional(),
});

const gatewayConnectionStatusSchema = z.enum(["ready", "connected", "disconnected"]);
const codexGatewayStatusSchema = z.enum(["ready", "missing", "not_logged_in", "error"]);

/** Health snapshot of the agent gateway, Codex, and ComfyUI backends. */
export const directorAgentHealthWireSchema = z.looseObject({
  gateway: z.strictObject({
    status: gatewayConnectionStatusSchema,
    epoch: z.string().optional(),
  }),
  codex: z.looseObject({ status: codexGatewayStatusSchema }),
  comfyui: z.looseObject({ status: gatewayConnectionStatusSchema }),
});

/** Bootstrap payload sent from the gateway to the browser on initial connection. */
export const directorAgentBootstrapWireSchema = z.strictObject({
  browserToken: nonEmptyText(1_024),
  service: z.literal("comfyui-3d-director-agent-gateway"),
  health: directorAgentHealthWireSchema,
});

/** A one-time confirmation token the browser sends back to authorize a command. */
export const directorAssistantConfirmationTokenWireSchema = z.strictObject({
  confirmationToken: nonEmptyText(1_024),
});

/** Snapshot of the Director page UI state: selection, active panel, view mode, playback, and camera. */
export const directorPageStateWireSchema = z.strictObject({
  selectedObjectIds: z.array(z.string()).optional(),
  activePanel: z.enum(["scene", "character", "prop", "camera", "timeline"]).optional(),
  viewMode: z.enum(["director", "camera"]).optional(),
  playing: z.boolean().optional(),
  currentFrame: z.number().finite().optional(),
  viewportCamera: z
    .strictObject({
      fov: z.number().finite().positive(),
      position: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
      target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    })
    .optional(),
});

/** A single page state event with sequence number, scene id, revision, and state snapshot. */
export const directorPageEventWireSchema = z.strictObject({
  sequence: nonNegativeInteger,
  sceneId: nonEmptyText(160),
  revision: nonNegativeInteger,
  tabId: nonEmptyText(160),
  createdAt: z.string(),
  state: directorPageStateWireSchema,
});

/** A batch of page state events with an epoch identifier. */
export const directorPageEventsWireSchema = z.strictObject({
  epoch: nonEmptyText(160),
  events: z.array(directorPageEventWireSchema).max(1_000),
});

/** Generic gateway error envelope. */
export const gatewayErrorWireSchema = z.looseObject({
  error: z.string().max(4_000).optional(),
  message: z.string().max(4_000).optional(),
  code: z.string().max(160).optional(),
});

/** Types of events the Stage agent can emit to the browser. */
export const stageAgentEventTypeSchema = z.enum(["play", "focus", "capture"]);
/** An event from the Stage agent targeting a specific object. */
export const stageAgentEventWireSchema = z.strictObject({
  type: stageAgentEventTypeSchema,
  objectId: z.string().max(200).optional(),
});

/** A parsed Stage agent event. */
export type StageAgentEventWire = z.infer<typeof stageAgentEventWireSchema>;

/** Identity and routing target for an agent connection: token, client, instance, scene, and creative scope. */
export const directorAgentTargetWireSchema = z.strictObject({
  token: nonEmptyText(240),
  client_id: nonEmptyText(160),
  instance_id: nonEmptyText(160),
  scene_id: nonEmptyText(160),
  creative_scope_id: nonEmptyText(160),
  contract_version: z.literal(2),
});

/** Parsed agent target wire. */
export type DirectorAgentTargetWire = z.infer<typeof directorAgentTargetWireSchema>;

/**
 * Compares two agent targets for exact equality.
 *
 * @param left - First target, nullable.
 * @param right - Second target, nullable.
 * @returns `true` when both are non-null and all fields match exactly.
 */
export function sameDirectorAgentTarget(
  left: DirectorAgentTargetWire | null | undefined,
  right: DirectorAgentTargetWire | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.token === right.token &&
    left.client_id === right.client_id &&
    left.instance_id === right.instance_id &&
    left.scene_id === right.scene_id &&
    left.creative_scope_id === right.creative_scope_id &&
    left.contract_version === right.contract_version,
  );
}

/**
 * Validates that a response target matches both the expected and current targets.
 *
 * @param expected - The target the request was sent to.
 * @param current - The current live target (may be null if disconnected).
 * @param response - The target the response came from.
 * @returns `true` when both the current and response targets match the expected target.
 */
export function isCurrentDirectorAgentTargetResponse(
  expected: DirectorAgentTargetWire,
  current: DirectorAgentTargetWire | null | undefined,
  response: DirectorAgentTargetWire | null | undefined,
): boolean {
  return sameDirectorAgentTarget(expected, current) && sameDirectorAgentTarget(expected, response);
}

/** Server-to-browser websocket messages consumed by the live Director workbench. */
const browserCommandCancelReasonSchema = z.enum(["timeout", "target_unavailable", "superseded"]);
/** Inbound messages the server sends to the browser via WebSocket. */
export const directorGatewayInboundMessageSchema = z.discriminatedUnion("type", [
  strictType("target-bound", { target: directorAgentTargetWireSchema }),
  strictType("state", {
    scene: stageSceneSchema,
    source: z.string().max(160).optional(),
    events: z.array(stageAgentEventWireSchema).max(500).optional(),
  }),
  strictType("capture-request", {
    requestId: nonEmptyText(160),
    cameraId: z.string().max(200).optional(),
  }),
  strictType("workbench-state", {
    project: directorProjectSchema,
    source: z.string().max(160).optional(),
  }),
  strictType("workbench-command-request", {
    requestId: nonEmptyText(160),
    target: directorAgentTargetWireSchema,
    input: directorWorkbenchOperationSchema,
  }),
  strictType("workbench-command-cancel", {
    requestId: nonEmptyText(160),
    target: directorAgentTargetWireSchema,
    reason: browserCommandCancelReasonSchema,
  }),
  strictType("creative-workspace-command-request", {
    requestId: nonEmptyText(160),
    target: directorAgentTargetWireSchema,
    input: creativeWorkspaceAgentRequestSchema,
  }),
  strictType("creative-workspace-command-cancel", {
    requestId: nonEmptyText(160),
    target: directorAgentTargetWireSchema,
    reason: browserCommandCancelReasonSchema,
  }),
  /**
   * Possession write-depth honesty: sole-possession auto-fill receipts and
   * ambiguity/scope rejection payloads for the bound Stage tab's notification
   * layer (humans debugging Agent possession writes).
   */
  strictType("possession-write-feedback", {
    code: z.enum(["possession_write_filled", "possession_target_ambiguous", "possession_scope_violation"]),
    possession: z.record(z.string(), z.unknown()),
    error: z.string().max(4_000).optional(),
  }),
]);

/** Browser-to-server result for one validated workbench operation. */
export const directorWorkbenchCommandResponseWireSchema = strictType("workbench-command-response", {
  requestId: nonEmptyText(160),
  target: directorAgentTargetWireSchema,
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(4_000).optional(),
  stageScene: stageSceneSchema.optional(),
  project: directorProjectSchema.optional(),
  captureDataUrl: z.string().max(16_800_000).optional(),
});

/** Browser-to-server result for one Canvas/Video observe or mutation. */
export const directorCreativeWorkspaceCommandResponseWireSchema = strictType("creative-workspace-command-response", {
  requestId: nonEmptyText(160),
  target: directorAgentTargetWireSchema,
  success: z.boolean(),
  result: creativeWorkspaceAgentToolResultSchema.optional(),
  error: z.string().max(4_000).optional(),
}).superRefine((value, context) => {
  if (value.success && value.result === undefined) {
    context.addIssue({ code: "custom", path: ["result"], message: "successful responses require a result" });
  }
  if (!value.success && !value.error) {
    context.addIssue({ code: "custom", path: ["error"], message: "failed responses require an error" });
  }
});

/** A parsed assistant chat session. */
export type DirectorAssistantChatWire = z.infer<typeof directorAssistantChatWireSchema>;
/** A parsed assistant command. */
export type DirectorAssistantCommandWire = z.infer<typeof directorAssistantCommandWireSchema>;
/** A parsed required confirmation. */
export type DirectorAssistantRequiredConfirmation = z.infer<typeof directorAssistantRequiredConfirmationSchema>;
/** Chat session status values. */
export type DirectorAssistantChatStatus = z.infer<typeof directorAssistantChatStatusSchema>;
/** Parsed agent gateway health snapshot. */
export type DirectorAgentHealthWire = z.infer<typeof directorAgentHealthWireSchema>;
/** Parsed page UI state snapshot. */
export type DirectorPageStateWire = z.infer<typeof directorPageStateWireSchema>;
/** A parsed page state event. */
export type DirectorPageEventWire = z.infer<typeof directorPageEventWireSchema>;
/** A parsed server-to-browser inbound message. */
export type DirectorGatewayInboundMessage = z.infer<typeof directorGatewayInboundMessageSchema>;
/** A parsed workbench command response from browser to server. */
export type DirectorWorkbenchCommandResponseWire = z.infer<typeof directorWorkbenchCommandResponseWireSchema>;
/** A parsed creative workspace command response from browser to server. */
export type DirectorCreativeWorkspaceCommandResponseWire = z.infer<
  typeof directorCreativeWorkspaceCommandResponseWireSchema
>;
