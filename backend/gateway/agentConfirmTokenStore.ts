import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "./atomicJsonFile";

/** Default lifetime of one confirm token in milliseconds. */
export const DEFAULT_CONFIRM_TOKEN_TTL_MS = 2 * 60_000;

/** Default cap on retained token records so the file cannot grow unbounded. */
export const DEFAULT_CONFIRM_TOKEN_MAX_RECORDS = 500;

/**
 * The exact call a confirm token authorizes. Every field is compared on
 * consumption, so a token issued for one tool/operation/role/session cannot
 * confirm a different destructive call.
 */
export type AgentConfirmTokenBinding = {
  /** The tool name, e.g. `director_workbench`. */
  tool: string;
  /** The destructive operation key, e.g. `deliver` or `interchange.export`. */
  operation: string;
  /** The film role the call will be governed by, or `null` for unrestricted. */
  role: string | null;
  /** The caller session id, or `null` when the caller sends none. */
  sessionId: string | null;
};

const persistedConfirmTokenSchema = z.strictObject({
  id: z.string().min(1),
  /** SHA-256 hex digest of the raw token; the raw token is never stored. */
  token_hash: z.string().length(64),
  tool: z.string().min(1).max(120),
  operation: z.string().min(1).max(200),
  role: z.string().min(1).max(120).nullable(),
  session_id: z.string().min(1).max(160).nullable(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  used_at: z.iso.datetime().optional(),
});

type PersistedConfirmToken = z.infer<typeof persistedConfirmTokenSchema>;

const persistedConfirmTokenFileSchema = z.looseObject({
  version: z.literal(1),
  tokens: z.array(z.unknown()),
});

/** Why one confirm-token consumption was refused. */
export type AgentConfirmTokenRejection = "invalid" | "expired" | "already_used" | "binding_mismatch";

/** The outcome of consuming one confirm token. */
export type AgentConfirmTokenConsumption = { ok: true } | { ok: false; reason: AgentConfirmTokenRejection };

function hashConfirmToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Short-lived, single-use confirmation tokens for destructive / publish tool
 * operations, shared by every non-UI entry point (HTTP, MCP, CLI).
 *
 * Tokens are gateway-issued, bound to one exact tool + operation + role +
 * session, and stored as SHA-256 hashes in one atomic JSON file next to the
 * tool audit trail (`agent-confirm-tokens.json`) — same JSON +
 * {@link writeJsonAtomic} persistence style, no sqlite.
 */
export class AgentConfirmTokenStore {
  private tokens: PersistedConfirmToken[] = [];
  private loadPromise: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    readonly dataDirectory: string,
    readonly ttlMs = DEFAULT_CONFIRM_TOKEN_TTL_MS,
    readonly maxRecords = DEFAULT_CONFIRM_TOKEN_MAX_RECORDS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Absolute path of the persisted token file. */
  get filePath() {
    return join(this.dataDirectory, "agent-confirm-tokens.json");
  }

  private async ensureLoaded() {
    this.loadPromise ??= (async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      } catch {
        return; // A missing or corrupt file starts empty; old tokens simply stop validating.
      }
      const parsed = persistedConfirmTokenFileSchema.safeParse(raw);
      if (!parsed.success) return;
      for (const candidate of parsed.data.tokens) {
        const token = persistedConfirmTokenSchema.safeParse(candidate);
        if (token.success) this.tokens.push(token.data);
      }
    })();
    await this.loadPromise;
  }

  private prune() {
    const cutoff = this.now();
    this.tokens = this.tokens.filter((token) => Date.parse(token.expires_at) > cutoff);
    if (this.tokens.length > this.maxRecords) {
      this.tokens = this.tokens.slice(-this.maxRecords);
    }
  }

  private async withSerializedWrite<Result>(mutate: () => Result): Promise<Result> {
    let release!: () => void;
    const preceding = this.writeTail;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      await this.ensureLoaded();
      const result = mutate();
      this.prune();
      await writeJsonAtomic(this.filePath, { version: 1, tokens: this.tokens });
      return result;
    } finally {
      release();
    }
  }

  /**
   * Issues one single-use confirm token bound to an exact destructive call.
   * Only the SHA-256 hash is persisted; the raw token is returned once.
   *
   * @param binding - The exact tool + operation + role + session the token confirms.
   * @returns The raw token, its expiry timestamp, and the store TTL.
   */
  async issue(binding: AgentConfirmTokenBinding): Promise<{ token: string; expiresAt: string; ttlMs: number }> {
    const token = `dctk_${randomBytes(24).toString("base64url")}`;
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt + this.ttlMs).toISOString();
    await this.withSerializedWrite(() => {
      this.tokens.push({
        id: randomUUID(),
        token_hash: hashConfirmToken(token),
        tool: binding.tool,
        operation: binding.operation,
        role: binding.role,
        session_id: binding.sessionId,
        issued_at: new Date(issuedAt).toISOString(),
        expires_at: expiresAt,
      });
    });
    return { token, expiresAt, ttlMs: this.ttlMs };
  }

  /**
   * Consumes one confirm token for an exact destructive call. A token is
   * spent on its first successful consumption; replays, expired tokens, and
   * binding mismatches are refused with a stable reason.
   *
   * @param token - The raw token supplied by the caller.
   * @param binding - The exact tool + operation + role + session of the call.
   */
  async consume(token: string, binding: AgentConfirmTokenBinding): Promise<AgentConfirmTokenConsumption> {
    const hash = hashConfirmToken(token);
    return this.withSerializedWrite<AgentConfirmTokenConsumption>(() => {
      const stored = this.tokens.find((candidate) => candidate.token_hash === hash);
      if (!stored) return { ok: false, reason: "invalid" };
      if (stored.used_at) return { ok: false, reason: "already_used" };
      if (Date.parse(stored.expires_at) <= this.now()) return { ok: false, reason: "expired" };
      if (
        stored.tool !== binding.tool ||
        stored.operation !== binding.operation ||
        stored.role !== binding.role ||
        stored.session_id !== binding.sessionId
      ) {
        return { ok: false, reason: "binding_mismatch" };
      }
      stored.used_at = new Date(this.now()).toISOString();
      return { ok: true };
    });
  }
}
