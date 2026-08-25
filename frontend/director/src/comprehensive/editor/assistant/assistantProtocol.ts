import type {
  DirectorAssistantChatStatus,
  DirectorPageEventWire,
  DirectorPageStateWire,
} from "../../../../../../packages/protocol/src/agentGatewayProtocol";

/** The role of a message in the chat conversation. */
export type AssistantRole = "user" | "assistant";

/** A single message in the Director Assistant chat conversation. */
export interface DirectorAssistantMessage {
  id: string;
  role: AssistantRole;
  content: string;
  commands?: DirectorAssistantCommandResult[];
}

/** The result of executing a single command from the agent's plan. */
export interface DirectorAssistantCommandResult {
  id: string;
  name: string;
  ok: boolean;
  revision: number | null;
  summary?: string;
  error?: string;
  status?: "applied" | "conflict" | "confirmation_required" | "rejected";
}

/** A confirmation required before the agent can execute a destructive or high-impact command. */
export interface DirectorAssistantConfirmation {
  action: string;
  objectIds: string[];
  sceneId: string;
  revision: number;
  summary: string;
  pendingPlanId: string;
  expiresAt?: string;
}

/** The bootstrap result from the Agent Gateway, describing service availability and the browser token. */
export interface DirectorAgentBootstrap {
  browserToken: string;
  service: string;
  gateway: "connected" | "connecting" | "disconnected";
  mcp: "connected" | "connecting" | "disconnected";
  comfyui: "connected" | "connecting" | "disconnected";
  codex: "ready" | "not-logged-in" | "missing" | "unavailable" | "unknown";
  epoch?: string;
  detail?: string;
}

/** The structured response from a chat or execute request to the Agent Gateway. */
export interface DirectorAssistantChatResponse {
  requestId: string;
  sceneId: string;
  revision: number;
  message: string;
  commands: DirectorAssistantCommandResult[];
  confirmation?: DirectorAssistantConfirmation;
  status: DirectorAssistantChatStatus;
}

export type DirectorPageState = DirectorPageStateWire;
export type DirectorPageEvent = DirectorPageEventWire;
