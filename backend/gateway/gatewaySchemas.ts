import { z } from "zod";
import { DIRECTOR_AGENT_IDS } from "@director/agent-engine";
import { creativeWorkspaceModeSchema } from "../../packages/protocol/src/creativeWorkspaceProtocol";
import { directorWorkbenchOperationSchema } from "@director/agent-engine";
import {
  directorCreativeWorkspaceCommandResponseWireSchema,
  directorWorkbenchCommandResponseWireSchema,
} from "../../packages/protocol/src/agentGatewayProtocol";
export {
  productionOperationSchema,
  productionRecordSchema,
  productionSceneCreateRequestSchema,
  productionSceneProjectUpdateRequestSchema,
  productionSceneSeedSchema,
  productionUpdateRequestSchema,
} from "../../packages/protocol/src/directorProductionProtocol";
export type { ProductionOperation, ProductionRecord } from "../../packages/protocol/src/directorProductionProtocol";

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Zod schema for the assistant plan request body. */
export const assistantPlanRequestSchema = z.strictObject({
  agent: z.enum(DIRECTOR_AGENT_IDS),
  message: nonEmptyText(8_000),
  session_id: nonEmptyText(160).optional(),
});
/** Inferred type for {@link assistantPlanRequestSchema}. */
export type AssistantPlanRequest = z.infer<typeof assistantPlanRequestSchema>;

/** Zod schema for the assistant apply (confirm/execute plan) request body. */
export const assistantApplyRequestSchema = z.strictObject({
  plan_id: nonEmptyText(160),
  confirmed: z.boolean().optional(),
});
/** Inferred type for {@link assistantApplyRequestSchema}. */
export type AssistantApplyRequest = z.infer<typeof assistantApplyRequestSchema>;

/** Zod schema for all WebSocket terminal messages. */
export const terminalMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    role: z.literal("director-ui"),
    visible: z.boolean().optional(),
    client_id: nonEmptyText(160),
    instance_id: nonEmptyText(160),
    scene_id: nonEmptyText(160),
    creative_scope_id: nonEmptyText(160),
    contract_version: z.literal(2),
    /** Active UI surface; older v2 clients may omit capability metadata. */
    workspace: creativeWorkspaceModeSchema.optional(),
    /** True only after the mounted Stage WebGL canvas owns the capture lease. */
    capture_ready: z.boolean().optional(),
    /** Structural hash of the tab's bundled workbench contract; older tabs omit it. */
    contract_fingerprint: nonEmptyText(160).optional(),
  }),
  z.strictObject({
    type: z.literal("term.open"),
    agent: z.enum(DIRECTOR_AGENT_IDS),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.strictObject({ type: z.literal("term.input"), data: z.string().max(32_768) }),
  z.strictObject({
    type: z.literal("term.resize"),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.strictObject({
    type: z.literal("capture-response"),
    requestId: nonEmptyText(160),
    dataUrl: z.string().max(16_800_000).nullable(),
  }),
  directorWorkbenchCommandResponseWireSchema,
  directorCreativeWorkspaceCommandResponseWireSchema,
]);

/** Zod schema for workbench command requests sent from the gateway to browser tabs. */
export const workbenchCommandRequestSchema = z.strictObject({
  input: directorWorkbenchOperationSchema,
  session_id: nonEmptyText(160).optional(),
});

/** Inferred type for all WebSocket terminal messages. */
export type TerminalMessage = z.infer<typeof terminalMessageSchema>;
