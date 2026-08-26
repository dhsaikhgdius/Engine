import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  agentTraceEventSchema,
  agentUsageSampleSchema,
  redactAgentTraceText,
  summarizeAgentTraceSession,
  type AgentTraceEvent,
  type AgentTraceSessionSummary,
  type AgentTraceSource,
  type AgentUsageMeter,
  type AgentUsageMeterInput,
  type AgentUsageSample,
} from "../../../packages/protocol/src/agentObservabilityProtocol";

/** Trace event input; the store assigns the id. */
export type AgentTraceEventInput = Omit<AgentTraceEvent, "id">;

/** Filters accepted by {@link AgentTraceStore.list}. */
export type AgentTraceFilter = {
  sessionId?: string;
  source?: AgentTraceSource;
  tool?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 2_000;
const DEFAULT_LIST_LIMIT = 200;

function parseJsonLines<T>(contents: string, parse: (value: unknown) => T | null, keep: number): T[] {
  const records: T[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parse(JSON.parse(trimmed));
      if (parsed) records.push(parsed);
    } catch {
      // One corrupt line must not discard the rest of the trace history.
    }
  }
  return records.slice(-keep);
}

/**
 * Bounded store for agent observability data: gateway tool-call trace events
 * and model-usage (cost/latency) samples.
 *
 * Events are held in a bounded in-memory buffer and appended to JSONL files
 * under the gateway data directory so the latest production run remains
 * reconstructable across restarts. Privacy: the store persists execution
 * receipts only — operation names, guard revisions, idempotency keys, and
 * capture references. Raw prompts, tool payloads, and credentials are never
 * recorded, and error text is redacted before it enters the buffer.
 */
export class AgentTraceStore {
  private readonly limit: number;
  private readonly eventsPath: string | null;
  private readonly usagePath: string | null;
  private readonly now: () => Date;
  private events: AgentTraceEvent[] = [];
  private usage: AgentUsageSample[] = [];
  private sequence = 0;
  private loadPromise: Promise<void> | null = null;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(options: { dataDirectory?: string; limit?: number; now?: () => Date } = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.eventsPath = options.dataDirectory ? resolve(options.dataDirectory, "agent-traces", "events.jsonl") : null;
    this.usagePath = options.dataDirectory ? resolve(options.dataDirectory, "agent-traces", "usage.jsonl") : null;
    this.now = options.now ?? (() => new Date());
  }

  private async ensureLoaded() {
    this.loadPromise ??= (async () => {
      if (!this.eventsPath || !this.usagePath) return;
      const [eventContents, usageContents] = await Promise.all([
        readFile(this.eventsPath, "utf8").catch(() => ""),
        readFile(this.usagePath, "utf8").catch(() => ""),
      ]);
      this.events = parseJsonLines(
        eventContents,
        (value) => agentTraceEventSchema.safeParse(value).data ?? null,
        this.limit,
      );
      this.usage = parseJsonLines(
        usageContents,
        (value) => agentUsageSampleSchema.safeParse(value).data ?? null,
        this.limit,
      );
      // Compact once per process start so the JSONL files stay bounded to the
      // in-memory window instead of growing without limit.
      await this.compact();
    })();
    await this.loadPromise;
  }

  private async compact() {
    if (!this.eventsPath || !this.usagePath) return;
    try {
      await mkdir(dirname(this.eventsPath), { recursive: true });
      await writeFile(this.eventsPath, this.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      await writeFile(this.usagePath, this.usage.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    } catch (error) {
      console.warn("Agent trace store compaction failed", error);
    }
  }

  private appendLine(path: string | null, record: unknown) {
    if (!path) return;
    this.appendTail = this.appendTail
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(record)}\n`);
      })
      .catch((error) => {
        console.warn("Agent trace store append failed", error);
      });
  }

  /**
   * Records one tool-call trace event. Error text is redacted before storage.
   *
   * @param input - The trace event without an id.
   * @returns The stored event.
   */
  async record(input: AgentTraceEventInput): Promise<AgentTraceEvent> {
    await this.ensureLoaded();
    const event = agentTraceEventSchema.parse({
      ...input,
      ...(input.error ? { error: redactAgentTraceText(input.error) } : {}),
      id: `trace-${++this.sequence}-${crypto.randomUUID()}`,
    });
    this.events.push(event);
    let trimmed = false;
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
      trimmed = true;
    }
    if (trimmed) {
      // Keep the on-disk JSONL window aligned with the in-memory bound so a
      // long-lived gateway process cannot grow traces without limit. Wait for
      // any in-flight appends before rewriting the file.
      await this.appendTail.catch(() => undefined);
      await this.compact();
    } else {
      this.appendLine(this.eventsPath, event);
    }
    return event;
  }

  /**
   * Lists trace events, newest first.
   *
   * @param filter - Optional session, source, tool, and limit filters.
   */
  async list(filter: AgentTraceFilter = {}): Promise<AgentTraceEvent[]> {
    await this.ensureLoaded();
    const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
    return this.events
      .filter(
        (event) =>
          (!filter.sessionId || event.session_id === filter.sessionId) &&
          (!filter.source || event.source === filter.source) &&
          (!filter.tool || event.tool === filter.tool),
      )
      .slice(-limit)
      .reverse()
      .map((event) => structuredClone(event));
  }

  /** Returns the session id of the most recently recorded event, or null. */
  async latestSessionId(): Promise<string | null> {
    await this.ensureLoaded();
    return this.events.at(-1)?.session_id ?? null;
  }

  /**
   * Reconstructs the tool-chain summary for one session.
   *
   * @param sessionId - The session to summarize; defaults to the most recent session.
   * @returns The summary, or null when no matching events exist.
   */
  async summarizeSession(sessionId?: string): Promise<AgentTraceSessionSummary | null> {
    await this.ensureLoaded();
    const target = sessionId ?? (await this.latestSessionId());
    if (!target) return null;
    return summarizeAgentTraceSession(target, this.events);
  }

  /**
   * Records one model-usage sample.
   *
   * @param input - The sample without id and timestamp.
   * @returns The stored sample.
   */
  async recordUsage(input: AgentUsageMeterInput): Promise<AgentUsageSample> {
    await this.ensureLoaded();
    const sample = agentUsageSampleSchema.parse({
      ...input,
      id: `usage-${++this.sequence}-${crypto.randomUUID()}`,
      recorded_at: this.now().toISOString(),
    });
    this.usage.push(sample);
    let trimmed = false;
    if (this.usage.length > this.limit) {
      this.usage.splice(0, this.usage.length - this.limit);
      trimmed = true;
    }
    if (trimmed) {
      await this.appendTail.catch(() => undefined);
      await this.compact();
    } else {
      this.appendLine(this.usagePath, sample);
    }
    return sample;
  }

  /**
   * Lists usage samples, newest first.
   *
   * @param filter - Optional scope and limit filters.
   */
  async listUsage(filter: { scope?: string; limit?: number } = {}): Promise<AgentUsageSample[]> {
    await this.ensureLoaded();
    const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
    return this.usage
      .filter((sample) => !filter.scope || sample.scope === filter.scope)
      .slice(-limit)
      .reverse()
      .map((sample) => structuredClone(sample));
  }

  /** Returns a fire-and-forget meter callback for model-provider call sites. */
  meter(): AgentUsageMeter {
    return (sample) => {
      void this.recordUsage(sample).catch((error) => {
        console.warn("Agent usage meter rejected a sample", error);
      });
    };
  }

  /** Awaits pending JSONL appends. Intended for tests and shutdown paths. */
  async flush() {
    await this.appendTail;
  }
}
