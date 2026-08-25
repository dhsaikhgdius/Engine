import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { asRecord as record } from "../../../packages/protocol/src/primitives";

/**
 * Control surfaces that can reach the gateway `/api/tools/*` boundary.
 *
 * The source is derived from the trusted per-surface `session_id` conventions
 * that every first-party client already sends:
 *
 * - `browser-ui` / `ui-*` — the Director browser UI (`runRemoteTool`)
 * - `mcp-*` — the MCP server (`backend/gateway/mcp-server.ts`), which forwards
 *   every tool call over HTTP with its `mcp-<pid>-<uuid>` session id
 * - `cli-*` — the Stage CLI (`tools/scripts/stage-cli.mjs`, default `cli-default`)
 * - `dsh-*` — the DeepSeek Harness plugin (`packages/dsh-plugin-workbench`),
 *   which prefixes the harness session id with `dsh-`
 * - `http-*` — direct HTTP callers (gateway default session `http-default`)
 * - anything else — `unknown`
 *
 * No spoofable client header is consulted; a caller lying about its session
 * prefix can only mislabel its own audit rows, never bypass the role policy.
 */
export const TOOL_INVOCATION_AUDIT_SOURCES = ["ui", "mcp", "http", "cli", "dsh", "unknown"] as const;

/** One control surface tag for an audited tool invocation. */
export type ToolInvocationAuditSource = (typeof TOOL_INVOCATION_AUDIT_SOURCES)[number];

const MAX_ERROR_LENGTH = 500;
const MAX_IN_MEMORY_RECORDS = 2_000;

/** Zod schema for one persisted audit record line. */
export const toolInvocationAuditRecordSchema = z.strictObject({
  id: z.string().min(1).max(80),
  timestamp: z.string().min(1).max(40),
  source: z.enum(TOOL_INVOCATION_AUDIT_SOURCES),
  tool: z.string().min(1).max(80),
  operation: z.string().min(1).max(200).nullable(),
  role: z.string().min(1).max(80).nullable(),
  session_id: z.string().min(1).max(160).nullable(),
  revision_before: z.string().min(1).max(240).nullable(),
  revision_after: z.string().min(1).max(240).nullable(),
  idempotency_key: z.string().min(1).max(240).nullable(),
  outcome: z.enum(["succeeded", "rejected", "failed"]),
  http_status: z.number().int().min(100).max(599),
  error_code: z.string().min(1).max(160).nullable(),
  error: z.string().min(1).max(MAX_ERROR_LENGTH).nullable(),
});

/** One audited gateway tool invocation. */
export type ToolInvocationAuditRecord = z.infer<typeof toolInvocationAuditRecordSchema>;

/** A record without the store-assigned `id` and `timestamp`. */
export type ToolInvocationAuditEntry = Omit<ToolInvocationAuditRecord, "id" | "timestamp">;

/** Query filters for {@link ToolInvocationAuditStore.list}. */
export type ToolInvocationAuditQuery = {
  session_id?: string;
  source?: ToolInvocationAuditSource;
  tool?: string;
  /** Page size (default 50, capped at 200). */
  limit?: number;
  /** Cursor: return records strictly older than the record with this id. */
  after?: string;
};

/**
 * Derives the control-surface tag from a tool request `session_id`.
 *
 * @param sessionId - The session id from the tool envelope, or null/undefined.
 */
export function deriveToolInvocationSource(sessionId: string | null | undefined): ToolInvocationAuditSource {
  const value = sessionId?.trim() ?? "";
  if (!value) return "unknown";
  if (value === "browser-ui" || value.startsWith("ui-")) return "ui";
  if (value.startsWith("mcp-")) return "mcp";
  if (value.startsWith("cli-")) return "cli";
  if (value.startsWith("dsh-")) return "dsh";
  if (value.startsWith("http-")) return "http";
  return "unknown";
}

const DATA_URL_PATTERN = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[a-z0-9-]+)*;base64,[a-z0-9+/=_-]+/gi;
const SECRET_PATTERN =
  /\b(api[_-]?key|access[_-]?token|token|secret|authorization|bearer|password)\b\s*[:=]\s*[^\s"',;]+/gi;

/**
 * Redacts embedded data URLs and credential-looking assignments from an
 * error message, then truncates it to the persisted maximum length.
 *
 * @param value - The raw error text.
 * @returns The redacted text, or null when empty.
 */
export function redactToolAuditText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const redacted = value
    .replace(DATA_URL_PATTERN, "[data-url-redacted]")
    .replace(SECRET_PATTERN, "$1=[redacted]")
    .trim();
  if (!redacted) return null;
  return redacted.length > MAX_ERROR_LENGTH ? `${redacted.slice(0, MAX_ERROR_LENGTH - 1)}…` : redacted;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Extracts the operation name from a tool input: the top-level `op` plus a
 * nested action when the operation carries one (`author.<action>`,
 * `production.<action>`, `pipeline.<action>`, `execute.<operation.op>`, …).
 *
 * @param input - The raw tool input payload.
 */
export function toolInvocationOperation(input: unknown): string | null {
  const values = record(input);
  const op = typeof values?.op === "string" && values.op.trim() ? values.op : null;
  if (!values || !op) return null;
  const nestedAction = record(values.command)?.action ?? record(values.request)?.action ?? values.action;
  if (typeof nestedAction === "string" && nestedAction.trim()) return `${op}.${nestedAction}`.slice(0, 200);
  const executedOp = record(values.operation)?.op;
  if (op === "execute" && typeof executedOp === "string" && executedOp.trim()) {
    return `${op}.${executedOp}`.slice(0, 200);
  }
  return op.slice(0, 200);
}

function inputIdempotencyKey(input: unknown): string | null {
  const values = record(input);
  if (!values) return null;
  return (
    boundedText(values.idempotency_key, 240) ??
    boundedText(record(values.command)?.idempotency_key, 240) ??
    boundedText(record(values.request)?.idempotency_key, 240)
  );
}

function revisionText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.slice(0, 240);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Builds one audit entry from a finished (or rejected) gateway tool response.
 *
 * Only small structured fields are extracted — never the scene, project, or
 * capture payloads — so audit rows stay bounded regardless of response size.
 *
 * @param input.tool - The tool name.
 * @param input.toolInput - The raw tool input (used for operation/key extraction only).
 * @param input.sessionId - The effective session id from the tool envelope.
 * @param input.role - The film role governing the request, or null.
 * @param input.httpStatus - The HTTP status written to the client.
 * @param input.body - The response body written to the client.
 */
export function buildToolInvocationAuditEntry(input: {
  tool: string;
  toolInput: unknown;
  sessionId: string | null | undefined;
  role: string | null;
  httpStatus: number;
  body: unknown;
}): ToolInvocationAuditEntry {
  const body = record(input.body) ?? {};
  const boundary = record(body.agent_boundary);
  const guard = record(boundary?.guard);
  const result = record(body.result);
  const nativeReceipt = record(result?.receipt);
  const code = boundedText(body.code, 160) ?? boundedText(result?.code, 160);
  const rejected = code === "tool_policy_rejected" || code === "plan_mode_blocked";
  const succeeded = input.httpStatus >= 200 && input.httpStatus < 300 && body.success !== false;
  const revisionBefore =
    (guard?.mode === "revision" ? revisionText(guard.value) : null) ?? revisionText(nativeReceipt?.revisionBefore);
  const revisionAfter =
    revisionText(result?.project_revision) ??
    revisionText(result?.production_revision) ??
    revisionText(nativeReceipt?.revisionAfter);
  const idempotencyKey = boundedText(record(boundary?.idempotency)?.key, 240) ?? inputIdempotencyKey(input.toolInput);
  return {
    source: deriveToolInvocationSource(input.sessionId),
    tool: input.tool.slice(0, 80),
    operation: toolInvocationOperation(input.toolInput),
    role: boundedText(input.role, 80),
    session_id: boundedText(input.sessionId, 160),
    revision_before: revisionBefore,
    revision_after: revisionAfter,
    idempotency_key: idempotencyKey,
    outcome: rejected ? "rejected" : succeeded ? "succeeded" : "failed",
    http_status: input.httpStatus,
    error_code: succeeded ? null : code,
    error: succeeded ? null : (redactToolAuditText(body.error) ?? null),
  };
}

/**
 * Gateway-local append-only audit trail for `/api/tools/*` invocations.
 *
 * Records are appended as JSON Lines under the control-plane data directory
 * (`<dataDirectory>/agent-audit/tool-invocations.jsonl`) and mirrored in a
 * bounded in-memory tail for queries. Appends are serialized so concurrent
 * tool calls never interleave partial lines; a failed append can never fail
 * the tool response it audits.
 */
export class ToolInvocationAuditStore {
  private records: ToolInvocationAuditRecord[] | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly dataDirectory: string,
    private readonly maxRecords = MAX_IN_MEMORY_RECORDS,
  ) {}

  /** The append-only JSONL file backing this store. */
  get filePath() {
    return join(this.dataDirectory, "agent-audit", "tool-invocations.jsonl");
  }

  private async ensureLoaded() {
    if (this.records) return;
    let lines: string[] = [];
    try {
      lines = (await readFile(this.filePath, "utf8")).split("\n");
    } catch {
      // A missing file is an empty trail.
    }
    const loaded: ToolInvocationAuditRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = toolInvocationAuditRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) loaded.push(parsed.data);
      } catch {
        // A corrupt line cannot prevent the rest of the trail from loading.
      }
    }
    this.records = loaded.slice(-this.maxRecords);
  }

  /**
   * Appends one audit entry. Persistence happens asynchronously and is
   * fire-and-forget from the caller's perspective: the tool response has
   * already been written when this is called.
   *
   * @param entry - The audit entry without id/timestamp.
   * @returns The full record including the assigned id and timestamp.
   */
  record(entry: ToolInvocationAuditEntry): ToolInvocationAuditRecord {
    const full = toolInvocationAuditRecordSchema.parse({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    this.tail = this.tail
      .then(async () => {
        await this.ensureLoaded();
        this.records!.push(full);
        if (this.records!.length > this.maxRecords) {
          this.records!.splice(0, this.records!.length - this.maxRecords);
        }
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
      })
      .catch((error) => {
        console.warn(`Tool invocation audit append failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return full;
  }

  /** Waits for all pending appends to reach disk. */
  async flush() {
    await this.tail;
  }

  /**
   * Lists audit records newest-first with optional filters and cursor paging.
   *
   * @param query - Session/source/tool filters, page size, and `after` cursor.
   * @returns The matching page plus a `next_after` cursor when more records remain.
   */
  async list(query: ToolInvocationAuditQuery = {}): Promise<{
    records: ToolInvocationAuditRecord[];
    next_after: string | null;
  }> {
    await this.flush();
    await this.ensureLoaded();
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    let items = [...this.records!].reverse();
    if (query.after) {
      const index = items.findIndex((item) => item.id === query.after);
      if (index >= 0) items = items.slice(index + 1);
    }
    items = items.filter(
      (item) =>
        (!query.session_id || item.session_id === query.session_id) &&
        (!query.source || item.source === query.source) &&
        (!query.tool || item.tool === query.tool),
    );
    const page = items.slice(0, limit);
    return {
      records: page,
      next_after: items.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
