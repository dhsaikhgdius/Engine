import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { z } from "zod";

/** Workspace rows are scoped to the whole org or to the local user. */
export const agentWorkspaceScopeSchema = z.enum(["org", "user"]);
export type AgentWorkspaceScope = z.infer<typeof agentWorkspaceScopeSchema>;

/** Editable prose documents: AGENTS.md / LEARNINGS.md equivalents. */
export const agentWorkspaceDocumentKindSchema = z.enum(["instructions", "learnings"]);
export type AgentWorkspaceDocumentKind = z.infer<typeof agentWorkspaceDocumentKindSchema>;

/** Upper bound for one workspace document, in characters. */
export const MAX_AGENT_WORKSPACE_DOCUMENT_CHARS = 65_536;
/** Number of historical versions kept per document. */
export const AGENT_WORKSPACE_DOCUMENT_VERSION_LIMIT = 50;
/** Upper bound for one serialized memory value, in characters. */
export const MAX_AGENT_WORKSPACE_MEMORY_VALUE_CHARS = 8_192;
/** Upper bound of memory entries kept per scope. */
export const MAX_AGENT_WORKSPACE_MEMORY_ENTRIES = 256;
/** Upper bound of skill references. */
export const MAX_AGENT_WORKSPACE_SKILL_REFS = 64;
/** Longest accepted memory TTL: one year. */
export const MAX_AGENT_WORKSPACE_MEMORY_TTL_SECONDS = 365 * 24 * 3_600;

const documentContentSchema = z.string().max(MAX_AGENT_WORKSPACE_DOCUMENT_CHARS);

/** Save payload for one workspace document. */
export const saveAgentWorkspaceDocumentSchema = z.strictObject({
  scope: agentWorkspaceScopeSchema,
  kind: agentWorkspaceDocumentKindSchema,
  content: documentContentSchema,
});

/** One reference to a reusable skill (repo path or URL); never executable content. */
export const agentWorkspaceSkillRefSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  scope: agentWorkspaceScopeSchema,
  name: z.string().trim().min(1).max(160),
  source: z.string().trim().min(1).max(400),
  note: z.string().max(400).default(""),
  enabled: z.boolean().default(true),
});
export type AgentWorkspaceSkillRef = z.infer<typeof agentWorkspaceSkillRefSchema>;

/** Replace payload for the skill reference list. */
export const saveAgentWorkspaceSkillRefsSchema = z.strictObject({
  skill_refs: z.array(agentWorkspaceSkillRefSchema).max(MAX_AGENT_WORKSPACE_SKILL_REFS),
});

/** Set payload for one memory entry (structured KV with optional TTL). */
export const setAgentWorkspaceMemorySchema = z.strictObject({
  scope: agentWorkspaceScopeSchema,
  key: z.string().trim().min(1).max(160),
  value: z.unknown(),
  ttl_seconds: z.number().int().min(1).max(MAX_AGENT_WORKSPACE_MEMORY_TTL_SECONDS).optional(),
});

/** Delete payload for one memory entry. */
export const deleteAgentWorkspaceMemorySchema = z.strictObject({
  scope: agentWorkspaceScopeSchema,
  key: z.string().trim().min(1).max(160),
});

/** Restore payload for one historical document version. */
export const restoreAgentWorkspaceDocumentSchema = z.strictObject({
  scope: agentWorkspaceScopeSchema,
  kind: agentWorkspaceDocumentKindSchema,
  version: z.number().int().min(1),
});

/** One current document as returned to the browser. */
export type PublicAgentWorkspaceDocument = {
  scope: AgentWorkspaceScope;
  kind: AgentWorkspaceDocumentKind;
  content: string;
  version: number;
  updated_at: string | null;
};

/** One saved historical document version. */
export type PublicAgentWorkspaceDocumentVersion = {
  scope: AgentWorkspaceScope;
  kind: AgentWorkspaceDocumentKind;
  version: number;
  chars: number;
  saved_at: string;
};

/** One memory entry as returned to the browser. */
export type PublicAgentWorkspaceMemoryEntry = {
  scope: AgentWorkspaceScope;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

/** Full workspace snapshot for the settings editor. */
export type AgentWorkspaceSnapshot = {
  documents: PublicAgentWorkspaceDocument[];
  skill_refs: AgentWorkspaceSkillRef[];
  memory: PublicAgentWorkspaceMemoryEntry[];
};

/** Portable workspace bundle for clone workflows. Never includes provider credentials. */
export const agentWorkspaceBundleSchema = z.strictObject({
  format: z.literal("director-agent-workspace-bundle"),
  version: z.literal(1),
  exported_at: z.string(),
  documents: z
    .array(
      z.strictObject({
        scope: agentWorkspaceScopeSchema,
        kind: agentWorkspaceDocumentKindSchema,
        content: documentContentSchema,
      }),
    )
    .max(4),
  skill_refs: z.array(agentWorkspaceSkillRefSchema).max(MAX_AGENT_WORKSPACE_SKILL_REFS),
  memory: z
    .array(
      z.strictObject({
        scope: agentWorkspaceScopeSchema,
        key: z.string().trim().min(1).max(160),
        value: z.unknown(),
        expires_at: z.string().nullable(),
      }),
    )
    .max(MAX_AGENT_WORKSPACE_MEMORY_ENTRIES * 2),
});
export type AgentWorkspaceBundle = z.infer<typeof agentWorkspaceBundleSchema>;

const STORE_FILE = "agent-workspace.sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_workspace_documents (
  scope TEXT NOT NULL CHECK (scope IN ('org','user')),
  kind TEXT NOT NULL CHECK (kind IN ('instructions','learnings')),
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, kind)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_workspace_document_versions (
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (scope, kind, version)
) STRICT;
CREATE TABLE IF NOT EXISTS agent_workspace_skill_refs (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org','user')),
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agent_workspace_memory (
  scope TEXT NOT NULL CHECK (scope IN ('org','user')),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at_ms INTEGER,
  PRIMARY KEY (scope, key)
) STRICT;
`;

const DOCUMENT_ORDER: readonly [AgentWorkspaceScope, AgentWorkspaceDocumentKind][] = [
  ["org", "instructions"],
  ["user", "instructions"],
  ["org", "learnings"],
  ["user", "learnings"],
];

function isoAt(ms: number) {
  return new Date(ms).toISOString();
}

/**
 * Durable SQLite store for the in-product agent workspace (roadmap M4):
 * instructions and learnings documents with version history, skill
 * references, and structured memory entries with TTL.
 *
 * Memory entries are user-controlled data. They are intentionally not part of
 * any prompt composition — see `agentWorkspacePrompt.ts` — and only leave the
 * store through explicit reads or the export bundle.
 */
export class AgentWorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  /**
   * Opens (or creates) the workspace database under the data directory.
   *
   * @param dataDirectory - Director data directory (`DIRECTOR_DATA_DIRECTORY`). Must exist.
   * @param options.now - Clock override for tests, in epoch milliseconds.
   * @param options.path - Full database path override (":memory:" for tests).
   */
  constructor(dataDirectory: string, options: { now?: () => number; path?: string } = {}) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.path ?? resolve(dataDirectory, STORE_FILE));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  /** Closes the underlying database. Further calls throw. */
  close() {
    this.db.close();
  }

  // ---- Documents ----

  /** Returns the current document, or an empty version-0 document when never saved. */
  getDocument(scope: AgentWorkspaceScope, kind: AgentWorkspaceDocumentKind): PublicAgentWorkspaceDocument {
    const row = this.db
      .prepare("SELECT content, version, updated_at FROM agent_workspace_documents WHERE scope = ? AND kind = ?")
      .get(scope, kind) as { content: string; version: number; updated_at: string } | undefined;
    if (!row) return { scope, kind, content: "", version: 0, updated_at: null };
    return { scope, kind, content: row.content, version: Number(row.version), updated_at: row.updated_at };
  }

  /**
   * Saves a document, bumping its version and appending to version history.
   * Saving identical content is a no-op that returns the current row.
   */
  saveDocument(
    scope: AgentWorkspaceScope,
    kind: AgentWorkspaceDocumentKind,
    content: string,
  ): PublicAgentWorkspaceDocument {
    const current = this.getDocument(scope, kind);
    if (current.version > 0 && current.content === content) return current;
    const version = current.version + 1;
    const savedAt = isoAt(this.now());
    this.db
      .prepare(
        `INSERT INTO agent_workspace_documents (scope, kind, content, version, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope, kind) DO UPDATE SET content = excluded.content,
           version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(scope, kind, content, version, savedAt);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_workspace_document_versions (scope, kind, version, content, saved_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(scope, kind, version, content, savedAt);
    this.db
      .prepare("DELETE FROM agent_workspace_document_versions WHERE scope = ? AND kind = ? AND version <= ?")
      .run(scope, kind, version - AGENT_WORKSPACE_DOCUMENT_VERSION_LIMIT);
    return { scope, kind, content, version, updated_at: savedAt };
  }

  /** Lists saved versions of one document, newest first, without content. */
  listDocumentVersions(
    scope: AgentWorkspaceScope,
    kind: AgentWorkspaceDocumentKind,
  ): PublicAgentWorkspaceDocumentVersion[] {
    const rows = this.db
      .prepare(
        `SELECT version, length(content) AS chars, saved_at
         FROM agent_workspace_document_versions WHERE scope = ? AND kind = ? ORDER BY version DESC`,
      )
      .all(scope, kind) as { version: number; chars: number; saved_at: string }[];
    return rows.map((row) => ({
      scope,
      kind,
      version: Number(row.version),
      chars: Number(row.chars),
      saved_at: row.saved_at,
    }));
  }

  /** Returns the content of one historical version, or `null` when unknown. */
  getDocumentVersion(scope: AgentWorkspaceScope, kind: AgentWorkspaceDocumentKind, version: number): string | null {
    const row = this.db
      .prepare("SELECT content FROM agent_workspace_document_versions WHERE scope = ? AND kind = ? AND version = ?")
      .get(scope, kind, version) as { content: string } | undefined;
    return row ? row.content : null;
  }

  /**
   * Restores a historical version by saving its content as a new version, so
   * history is never rewritten.
   *
   * @returns The new current document, or `null` when the version is unknown.
   */
  restoreDocumentVersion(
    scope: AgentWorkspaceScope,
    kind: AgentWorkspaceDocumentKind,
    version: number,
  ): PublicAgentWorkspaceDocument | null {
    const content = this.getDocumentVersion(scope, kind, version);
    if (content === null) return null;
    return this.saveDocument(scope, kind, content);
  }

  // ---- Skill references ----

  /** Lists all skill references, org scope first, then by name. */
  listSkillRefs(): AgentWorkspaceSkillRef[] {
    const rows = this.db
      .prepare("SELECT id, scope, name, source, note, enabled FROM agent_workspace_skill_refs ORDER BY scope, name, id")
      .all() as { id: string; scope: string; name: string; source: string; note: string; enabled: number }[];
    return rows.map((row) =>
      agentWorkspaceSkillRefSchema.parse({
        id: row.id,
        scope: row.scope,
        name: row.name,
        source: row.source,
        note: row.note,
        enabled: Boolean(row.enabled),
      }),
    );
  }

  /** Replaces the full skill reference list atomically. */
  replaceSkillRefs(skillRefs: readonly AgentWorkspaceSkillRef[]): AgentWorkspaceSkillRef[] {
    const seen = new Set<string>();
    for (const ref of skillRefs) {
      if (seen.has(ref.id)) throw new Error(`Duplicate skill reference id ${ref.id}`);
      seen.add(ref.id);
    }
    const savedAt = isoAt(this.now());
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM agent_workspace_skill_refs");
      const insert = this.db.prepare(
        `INSERT INTO agent_workspace_skill_refs (id, scope, name, source, note, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const ref of skillRefs) {
        insert.run(ref.id, ref.scope, ref.name, ref.source, ref.note, ref.enabled ? 1 : 0, savedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listSkillRefs();
  }

  // ---- Memory ----

  private purgeExpiredMemory() {
    this.db
      .prepare("DELETE FROM agent_workspace_memory WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?")
      .run(this.now());
  }

  /** Lists unexpired memory entries. Expired rows are purged first. */
  listMemory(): PublicAgentWorkspaceMemoryEntry[] {
    this.purgeExpiredMemory();
    const rows = this.db
      .prepare(
        "SELECT scope, key, value_json, created_at, updated_at, expires_at_ms FROM agent_workspace_memory ORDER BY scope, key",
      )
      .all() as {
      scope: string;
      key: string;
      value_json: string;
      created_at: string;
      updated_at: string;
      expires_at_ms: number | null;
    }[];
    return rows.map((row) => ({
      scope: agentWorkspaceScopeSchema.parse(row.scope),
      key: row.key,
      value: JSON.parse(row.value_json) as unknown,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at_ms === null ? null : isoAt(Number(row.expires_at_ms)),
    }));
  }

  /**
   * Creates or overwrites one memory entry.
   *
   * @param scope - Workspace scope.
   * @param key - Stable entry key.
   * @param value - Any JSON value; serialized size is bounded.
   * @param ttlSeconds - Optional TTL. Omitted means the entry never expires.
   */
  setMemory(
    scope: AgentWorkspaceScope,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): PublicAgentWorkspaceMemoryEntry {
    this.purgeExpiredMemory();
    const serialized = JSON.stringify(value === undefined ? null : value);
    if (serialized.length > MAX_AGENT_WORKSPACE_MEMORY_VALUE_CHARS) {
      throw new Error(`Memory value exceeds ${MAX_AGENT_WORKSPACE_MEMORY_VALUE_CHARS} serialized characters`);
    }
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_workspace_memory WHERE scope = ? AND key <> ?")
      .get(scope, key) as { n: number };
    if (Number(countRow.n) >= MAX_AGENT_WORKSPACE_MEMORY_ENTRIES) {
      throw new Error(`Memory scope ${scope} already holds ${MAX_AGENT_WORKSPACE_MEMORY_ENTRIES} entries`);
    }
    const nowMs = this.now();
    const nowIso = isoAt(nowMs);
    const expiresAtMs = ttlSeconds === undefined ? null : nowMs + ttlSeconds * 1_000;
    this.db
      .prepare(
        `INSERT INTO agent_workspace_memory (scope, key, value_json, created_at, updated_at, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, key) DO UPDATE SET value_json = excluded.value_json,
           updated_at = excluded.updated_at, expires_at_ms = excluded.expires_at_ms`,
      )
      .run(scope, key, serialized, nowIso, nowIso, expiresAtMs);
    const row = this.db
      .prepare("SELECT created_at FROM agent_workspace_memory WHERE scope = ? AND key = ?")
      .get(scope, key) as { created_at: string };
    return {
      scope,
      key,
      value: JSON.parse(serialized) as unknown,
      created_at: row.created_at,
      updated_at: nowIso,
      expires_at: expiresAtMs === null ? null : isoAt(expiresAtMs),
    };
  }

  /** Deletes one memory entry. Returns whether a row was removed. */
  deleteMemory(scope: AgentWorkspaceScope, key: string): boolean {
    const result = this.db.prepare("DELETE FROM agent_workspace_memory WHERE scope = ? AND key = ?").run(scope, key);
    return Number(result.changes) > 0;
  }

  // ---- Snapshot and bundle ----

  /** Full editor snapshot: current documents, skill refs, and unexpired memory. */
  snapshot(): AgentWorkspaceSnapshot {
    return {
      documents: DOCUMENT_ORDER.map(([scope, kind]) => this.getDocument(scope, kind)),
      skill_refs: this.listSkillRefs(),
      memory: this.listMemory(),
    };
  }

  /**
   * Exports the workspace as a portable JSON bundle for clone workflows.
   * Model/provider credentials are never part of the workspace, so the bundle
   * cannot leak them; TTLs export as absolute `expires_at` timestamps.
   */
  exportBundle(): AgentWorkspaceBundle {
    return agentWorkspaceBundleSchema.parse({
      format: "director-agent-workspace-bundle",
      version: 1,
      exported_at: isoAt(this.now()),
      documents: DOCUMENT_ORDER.map(([scope, kind]) => this.getDocument(scope, kind))
        .filter((document) => document.version > 0)
        .map((document) => ({ scope: document.scope, kind: document.kind, content: document.content })),
      skill_refs: this.listSkillRefs(),
      memory: this.listMemory().map((entry) => ({
        scope: entry.scope,
        key: entry.key,
        value: entry.value,
        expires_at: entry.expires_at,
      })),
    });
  }

  /**
   * Imports a bundle, replacing skill refs and memory and saving each bundled
   * document as a new version (existing version history is preserved).
   * Already-expired memory entries are dropped.
   */
  importBundle(bundle: AgentWorkspaceBundle): AgentWorkspaceSnapshot {
    for (const document of bundle.documents) {
      this.saveDocument(document.scope, document.kind, document.content);
    }
    this.replaceSkillRefs(bundle.skill_refs);
    this.db.exec("DELETE FROM agent_workspace_memory");
    const nowMs = this.now();
    for (const entry of bundle.memory) {
      if (entry.expires_at !== null) {
        const expiresMs = Date.parse(entry.expires_at);
        if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
        this.setMemory(entry.scope, entry.key, entry.value, Math.ceil((expiresMs - nowMs) / 1_000));
      } else {
        this.setMemory(entry.scope, entry.key, entry.value);
      }
    }
    return this.snapshot();
  }
}
