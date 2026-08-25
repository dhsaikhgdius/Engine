import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assistantApplyRequestSchema,
  assistantPlanRequestSchema,
  type AssistantApplyRequest,
  type AssistantPlanRequest,
} from "../gatewaySchemas";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type AssistantRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  plan: (payload: AssistantPlanRequest, response: ServerResponse) => Promise<void>;
  apply: (payload: AssistantApplyRequest, response: ServerResponse) => Promise<void>;
};

/** Owns request decoding for the planner/apply HTTP surface. */
export async function handleAssistantRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AssistantRouteDependencies,
): Promise<boolean> {
  if (request.method === "POST" && url.pathname === "/api/assistant/plan") {
    const payload = assistantPlanRequestSchema.safeParse(await dependencies.readBody(request));
    if (!payload.success) {
      dependencies.json(response, 400, {
        error: "agent 必须是 codex 或 claude，且场景请求不能超过 8000 个字符",
        code: "invalid_request",
      });
      return true;
    }
    await dependencies.plan(payload.data, response);
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/assistant/apply") {
    const payload = assistantApplyRequestSchema.safeParse(await dependencies.readBody(request));
    if (!payload.success) {
      dependencies.json(response, 400, { success: false, error: "计划请求格式无效", code: "invalid_request" });
      return true;
    }
    await dependencies.apply(payload.data, response);
    return true;
  }
  return false;
}
