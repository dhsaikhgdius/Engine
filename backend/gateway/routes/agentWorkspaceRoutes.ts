import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  agentWorkspaceBundleSchema,
  agentWorkspaceDocumentKindSchema,
  agentWorkspaceScopeSchema,
  deleteAgentWorkspaceMemorySchema,
  restoreAgentWorkspaceDocumentSchema,
  saveAgentWorkspaceDocumentSchema,
  saveAgentWorkspaceSkillRefsSchema,
  setAgentWorkspaceMemorySchema,
  type AgentWorkspaceStore,
} from "../agents/agentWorkspaceStore";
import {
  agentWorkspaceSessionOverrideSchema,
  composeAgentWorkspacePrompt,
} from "../agents/agentWorkspacePrompt";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type AgentWorkspaceRouteDependencies = {
  readBody: (request: IncomingMessage) => Promise<unknown>;
  json: JsonWriter;
  store: AgentWorkspaceStore;
};

const documentSelectorSchema = z.strictObject({
  scope: agentWorkspaceScopeSchema,
  kind: agentWorkspaceDocumentKindSchema,
});

function storeError(error: unknown) {
  return error instanceof Error ? error.message : "Agent 工作区请求失败";
}

/**
 * `/api/agent/workspace/*` — SQL-backed in-product agent workspace
 * (roadmap M4): documents with version history, skill references, memory
 * entries with TTL, the export/import bundle, and the merged harness prompt.
 * All endpoints sit behind gateway authentication.
 */
export async function handleAgentWorkspaceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: AgentWorkspaceRouteDependencies,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/agent/workspace")) return false;
  const { readBody, json, store } = dependencies;

  if (request.method === "GET" && url.pathname === "/api/agent/workspace") {
    json(response, 200, { workspace: store.snapshot() });
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/agent/workspace/document") {
    const parsed = saveAgentWorkspaceDocumentSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "工作区文档参数无效", code: "invalid_request" });
      return true;
    }
    json(response, 200, { document: store.saveDocument(parsed.data.scope, parsed.data.kind, parsed.data.content) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/workspace/document/versions") {
    const parsed = documentSelectorSchema.safeParse({
      scope: url.searchParams.get("scope"),
      kind: url.searchParams.get("kind"),
    });
    if (!parsed.success) {
      json(response, 400, { error: "工作区文档参数无效", code: "invalid_request" });
      return true;
    }
    json(response, 200, { versions: store.listDocumentVersions(parsed.data.scope, parsed.data.kind) });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/workspace/document/restore") {
    const parsed = restoreAgentWorkspaceDocumentSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "工作区版本参数无效", code: "invalid_request" });
      return true;
    }
    const document = store.restoreDocumentVersion(parsed.data.scope, parsed.data.kind, parsed.data.version);
    if (!document) {
      json(response, 404, { error: "该历史版本不存在", code: "version_not_found" });
      return true;
    }
    json(response, 200, { document });
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/agent/workspace/skill-refs") {
    const parsed = saveAgentWorkspaceSkillRefsSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "技能引用参数无效", code: "invalid_request" });
      return true;
    }
    try {
      json(response, 200, { skill_refs: store.replaceSkillRefs(parsed.data.skill_refs) });
    } catch (error) {
      json(response, 400, { error: storeError(error), code: "invalid_request" });
    }
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/agent/workspace/memory") {
    const parsed = setAgentWorkspaceMemorySchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "记忆条目参数无效", code: "invalid_request" });
      return true;
    }
    try {
      json(response, 200, {
        entry: store.setMemory(parsed.data.scope, parsed.data.key, parsed.data.value, parsed.data.ttl_seconds),
      });
    } catch (error) {
      json(response, 400, { error: storeError(error), code: "invalid_request" });
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/workspace/memory/delete") {
    const parsed = deleteAgentWorkspaceMemorySchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "记忆条目参数无效", code: "invalid_request" });
      return true;
    }
    json(response, 200, { deleted: store.deleteMemory(parsed.data.scope, parsed.data.key) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/workspace/export") {
    json(response, 200, store.exportBundle());
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/agent/workspace/import") {
    const parsed = agentWorkspaceBundleSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      json(response, 400, { error: "工作区 bundle 格式无效", code: "invalid_request" });
      return true;
    }
    try {
      json(response, 200, { workspace: store.importBundle(parsed.data) });
    } catch (error) {
      json(response, 400, { error: storeError(error), code: "invalid_request" });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/agent/workspace/prompt") {
    const override = agentWorkspaceSessionOverrideSchema.safeParse(
      url.searchParams.get("session_override") ?? undefined,
    );
    if (!override.success) {
      json(response, 400, { error: "会话覆盖内容超过长度上限", code: "invalid_request" });
      return true;
    }
    const snapshot = store.snapshot();
    json(
      response,
      200,
      composeAgentWorkspacePrompt(
        { documents: snapshot.documents, skill_refs: snapshot.skill_refs },
        override.data,
      ),
    );
    return true;
  }

  json(response, 404, { error: "未知的 Agent 工作区接口", code: "not_found" });
  return true;
}
