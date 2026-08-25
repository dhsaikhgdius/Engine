import { z } from "zod";
import { directorControlPlaneFetch, resetDirectorControlPlaneCredentials } from "../api/directorControlPlaneClient";

/** Workspace scope: whole org or the local user. */
export const agentWorkspaceScopeSchema = z.enum(["org", "user"]);
export type AgentWorkspaceScope = z.infer<typeof agentWorkspaceScopeSchema>;

/** Editable prose documents. */
export const agentWorkspaceDocumentKindSchema = z.enum(["instructions", "learnings"]);
export type AgentWorkspaceDocumentKind = z.infer<typeof agentWorkspaceDocumentKindSchema>;

/** One current workspace document. */
export const agentWorkspaceDocumentSchema = z.object({
  scope: agentWorkspaceScopeSchema,
  kind: agentWorkspaceDocumentKindSchema,
  content: z.string(),
  version: z.number().int().min(0),
  updated_at: z.string().nullable(),
});
export type AgentWorkspaceDocument = z.infer<typeof agentWorkspaceDocumentSchema>;

/** One historical version row (content omitted). */
export const agentWorkspaceDocumentVersionSchema = z.object({
  scope: agentWorkspaceScopeSchema,
  kind: agentWorkspaceDocumentKindSchema,
  version: z.number().int().min(1),
  chars: z.number().int().min(0),
  saved_at: z.string(),
});
export type AgentWorkspaceDocumentVersion = z.infer<typeof agentWorkspaceDocumentVersionSchema>;

/** One skill reference row. */
export const agentWorkspaceSkillRefSchema = z.object({
  id: z.string().min(1),
  scope: agentWorkspaceScopeSchema,
  name: z.string().min(1),
  source: z.string().min(1),
  note: z.string(),
  enabled: z.boolean(),
});
export type AgentWorkspaceSkillRef = z.infer<typeof agentWorkspaceSkillRefSchema>;

/** One memory entry (user-controlled; never auto-injected into prompts). */
export const agentWorkspaceMemoryEntrySchema = z.object({
  scope: agentWorkspaceScopeSchema,
  key: z.string().min(1),
  value: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string().nullable(),
});
export type AgentWorkspaceMemoryEntry = z.infer<typeof agentWorkspaceMemoryEntrySchema>;

/** Full workspace snapshot for the settings editor. */
export const agentWorkspaceSnapshotSchema = z.object({
  documents: z.array(agentWorkspaceDocumentSchema),
  skill_refs: z.array(agentWorkspaceSkillRefSchema),
  memory: z.array(agentWorkspaceMemoryEntrySchema),
});
export type AgentWorkspaceSnapshot = z.infer<typeof agentWorkspaceSnapshotSchema>;

/** Portable workspace bundle; provider credentials are never part of it. */
export const agentWorkspaceBundleSchema = z.object({
  format: z.literal("director-agent-workspace-bundle"),
  version: z.literal(1),
  exported_at: z.string(),
  documents: z.array(
    z.object({ scope: agentWorkspaceScopeSchema, kind: agentWorkspaceDocumentKindSchema, content: z.string() }),
  ),
  skill_refs: z.array(agentWorkspaceSkillRefSchema),
  memory: z.array(
    z.object({
      scope: agentWorkspaceScopeSchema,
      key: z.string().min(1),
      value: z.unknown(),
      expires_at: z.string().nullable(),
    }),
  ),
});
export type AgentWorkspaceBundle = z.infer<typeof agentWorkspaceBundleSchema>;

async function workspaceRequest(path: string, init: RequestInit = {}, retryUnauthorized = true): Promise<unknown> {
  const response = await directorControlPlaneFetch(path, init);
  if (response.status === 401 && retryUnauthorized) {
    resetDirectorControlPlaneCredentials();
    return workspaceRequest(path, init, false);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Agent 工作区请求失败（HTTP ${response.status}）`);
  }
  return body;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
}

/** Loads the full workspace snapshot. */
export async function fetchAgentWorkspace(): Promise<AgentWorkspaceSnapshot> {
  const body = (await workspaceRequest("/api/agent/workspace")) as { workspace?: unknown };
  return agentWorkspaceSnapshotSchema.parse(body.workspace);
}

/** Saves one document; the gateway bumps the version and appends history. */
export async function saveAgentWorkspaceDocument(
  scope: AgentWorkspaceScope,
  kind: AgentWorkspaceDocumentKind,
  content: string,
): Promise<AgentWorkspaceDocument> {
  const body = (await workspaceRequest(
    "/api/agent/workspace/document",
    jsonInit("PUT", { scope, kind, content }),
  )) as { document?: unknown };
  return agentWorkspaceDocumentSchema.parse(body.document);
}

/** Lists version history for one document, newest first. */
export async function listAgentWorkspaceDocumentVersions(
  scope: AgentWorkspaceScope,
  kind: AgentWorkspaceDocumentKind,
): Promise<AgentWorkspaceDocumentVersion[]> {
  const body = (await workspaceRequest(
    `/api/agent/workspace/document/versions?scope=${scope}&kind=${kind}`,
  )) as { versions?: unknown };
  return z.array(agentWorkspaceDocumentVersionSchema).parse(body.versions ?? []);
}

/** Restores one historical version as a new current version. */
export async function restoreAgentWorkspaceDocumentVersion(
  scope: AgentWorkspaceScope,
  kind: AgentWorkspaceDocumentKind,
  version: number,
): Promise<AgentWorkspaceDocument> {
  const body = (await workspaceRequest(
    "/api/agent/workspace/document/restore",
    jsonInit("POST", { scope, kind, version }),
  )) as { document?: unknown };
  return agentWorkspaceDocumentSchema.parse(body.document);
}

/** Replaces the skill reference list. */
export async function saveAgentWorkspaceSkillRefs(
  skillRefs: readonly AgentWorkspaceSkillRef[],
): Promise<AgentWorkspaceSkillRef[]> {
  const body = (await workspaceRequest(
    "/api/agent/workspace/skill-refs",
    jsonInit("PUT", { skill_refs: skillRefs }),
  )) as { skill_refs?: unknown };
  return z.array(agentWorkspaceSkillRefSchema).parse(body.skill_refs ?? []);
}

/** Creates or overwrites one memory entry with an optional TTL. */
export async function setAgentWorkspaceMemoryEntry(
  scope: AgentWorkspaceScope,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<AgentWorkspaceMemoryEntry> {
  const body = (await workspaceRequest(
    "/api/agent/workspace/memory",
    jsonInit("PUT", { scope, key, value, ...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}) }),
  )) as { entry?: unknown };
  return agentWorkspaceMemoryEntrySchema.parse(body.entry);
}

/** Deletes one memory entry. */
export async function deleteAgentWorkspaceMemoryEntry(scope: AgentWorkspaceScope, key: string): Promise<boolean> {
  const body = (await workspaceRequest(
    "/api/agent/workspace/memory/delete",
    jsonInit("POST", { scope, key }),
  )) as { deleted?: unknown };
  return body.deleted === true;
}

/** Exports the portable workspace bundle for clone workflows. */
export async function exportAgentWorkspaceBundle(): Promise<AgentWorkspaceBundle> {
  return agentWorkspaceBundleSchema.parse(await workspaceRequest("/api/agent/workspace/export"));
}

/** Imports a workspace bundle and returns the resulting snapshot. */
export async function importAgentWorkspaceBundle(bundle: unknown): Promise<AgentWorkspaceSnapshot> {
  const parsed = agentWorkspaceBundleSchema.parse(bundle);
  const body = (await workspaceRequest("/api/agent/workspace/import", jsonInit("POST", parsed))) as {
    workspace?: unknown;
  };
  return agentWorkspaceSnapshotSchema.parse(body.workspace);
}
