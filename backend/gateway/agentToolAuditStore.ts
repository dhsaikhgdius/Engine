import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FILM_ROLE_IDS } from "../../packages/protocol/src/filmRoles";
import { writeJsonAtomic } from "./atomicJsonFile";

/** Entry points that can invoke Director tools, in audit-tag form. */
export const AGENT_TOOL_SOURCES = ["ui", "mcp", "http", "cli"] as const;

/** One audited tool-invocation entry point. */
export type AgentToolSource = (typeof AGENT_TOOL_SOURCES)[number];

/**
 * Type guard for {@link AgentToolSource} values.
 *
 * @param value - The value to test.
 */
export function isAgentToolSource(value: unknown): value is AgentToolSource {
  return typeof value === "string" && AGENT_TOOL_SOURCES.some((source) => source === value);
}

/** Closed set of audited tool-invocation outcomes. */
export const AGENT_TOOL_AUDIT_OUTCOMES = ["allowed", "rejected", "success", "error"] as const;

/**
 * Caller-supplied fields of one audit record. The audit trail stores redacted
 * summaries only — tool, operation, ids, and outcome — never raw tool inputs,
 * which may contain credentials or data URLs.
 */
export const agentToolAuditEntrySchema = z.strictObject({
  /** The tool name, e.g. `director_workbench`. */
  tool: z.string().trim().min(1).max(120),
  /** The operation (`input.op`, with a nested `request.action`/`command.action` suffix when present). */
  operation: z.string().trim().min(1).max(200).optional(),
  /** The film role the call was governed by, or `null` for unrestricted. */
  role: z.enum(FILM_ROLE_IDS).nullable().default(null),
  /** Which entry point invoked the tool. */
  source: z.enum(AGENT_TOOL_SOURCES),
  /** The invocation outcome. `rejected` means the shared policy denied it. */
  outcome: z.enum(AGENT_TOOL_AUDIT_OUTCOMES),
  /** The caller session id when one was supplied. */
  session_id: z.string().trim().min(1).max(160).optional(),
  /** Machine-readable rejection/error code when the call did not succeed. */
  code: z.string().trim().min(1).max(120).optional(),
  /** The idempotency key present on the tool input, when any. */
  idempotency_key: z.string().trim().min(1).max(240).optional(),
  /** The observed revision before the call, when known. Never invented. */
  revision_before: z.union([z.string().max(240), z.number()]).optional(),
  /** The resulting revision after the call, when known. Never invented. */
  revision_after: z.union([z.string().max(240), z.number()]).optional(),
});

/** Caller-supplied fields of one audit record. */
export type AgentToolAuditEntry = z.input<typeof agentToolAuditEntrySchema>;

/** One persisted tool-invocation audit record. */
export const agentToolAuditRecordSchema = agentToolAuditEntrySchema.extend({
  /** Unique record id. */
  id: z.string().min(1),
  /** ISO timestamp the record was written. */
  timestamp: z.iso.datetime(),
});

/** One persisted tool-invocation audit record. */
export type AgentToolAuditRecord = z.infer<typeof agentToolAuditRecordSchema>;

const persistedAuditFileSchema = z.looseObject({
  version: z.literal(1),
  records: z.array(z.unknown()),
});

/** Default cap on retained audit records so the file cannot grow unbounded. */
export const DEFAULT_AGENT_TOOL_AUDIT_MAX_RECORDS = 2000;

/**
 * Unified tool-invocation audit trail shared by every Director tool entry
 * point (HTTP, MCP, CLI, and UI ingest).
 *
 * Records are appended in memory and persisted as one atomic JSON file under
 * the gateway data directory (`agent-tool-audit.json`), following the same
 * JSON + {@link writeJsonAtomic} persistence style as the production job
 * store. Retention is capped so the file stays bounded.
 */
export class AgentToolAuditStore {
  private records: AgentToolAuditRecord[] = [];
  private loadPromise: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    readonly dataDirectory: string,
    readonly maxRecords = DEFAULT_AGENT_TOOL_AUDIT_MAX_RECORDS,
  ) {}

  /** Absolute path of the persisted audit file. */
  get filePath() {
    return join(this.dataDirectory, "agent-tool-audit.json");
  }

  private async ensureLoaded() {
    this.loadPromise ??= (async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      } catch {
        return; // A missing or corrupt file starts an empty trail.
      }
      const parsed = persistedAuditFileSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const candidate of parsed.data.records) {
        const record = agentToolAuditRecordSchema.safeParse(candidate);
        if (record.success) this.records.push(record.data);
      }
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
      }
    })();
    await this.loadPromise;
  }

  /**
   * Appends one validated audit record and persists the trail atomically.
   * Writes are serialized so concurrent recorders never lose an entry.
   *
   * @param entry - The caller-supplied audit fields.
   * @returns The persisted record with generated id and timestamp.
   */
  async record(entry: AgentToolAuditEntry): Promise<AgentToolAuditRecord> {
    const record = agentToolAuditRecordSchema.parse({
      ...agentToolAuditEntrySchema.parse(entry),
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    let release!: () => void;
    const preceding = this.writeTail;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      await this.ensureLoaded();
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
      }
      await writeJsonAtomic(this.filePath, { version: 1, records: this.records });
      return structuredClone(record);
    } finally {
      release();
    }
  }

  /**
   * Lists audit records oldest-first, optionally filtered by session id and
   * capped to the newest `limit` entries.
   *
   * @param filter - Optional session filter and result limit.
   */
  async list(filter: { sessionId?: string; limit?: number } = {}): Promise<AgentToolAuditRecord[]> {
    await this.ensureLoaded();
    let selected = filter.sessionId
      ? this.records.filter((record) => record.session_id === filter.sessionId)
      : [...this.records];
    if (filter.limit !== undefined && filter.limit >= 0 && selected.length > filter.limit) {
      selected = selected.slice(-filter.limit);
    }
    return structuredClone(selected);
  }
}

/**
 * Best-effort audit write: an unavailable audit trail must never fail the
 * user-facing tool request. Failures are logged and swallowed.
 *
 * @param store - The audit store, or undefined when auditing is not wired.
 * @param entry - The audit fields to record.
 */
export function recordAgentToolAuditSafely(store: AgentToolAuditStore | undefined, entry: AgentToolAuditEntry) {
  if (!store) return;
  void store.record(entry).catch((error: unknown) => {
    console.warn(`Agent tool audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
