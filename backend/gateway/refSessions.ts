/** Configuration options for the {@link RefSessionRegistry}. */
export interface RefSessionRegistryOptions {
  /** Time-to-live for idle sessions in milliseconds. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Maximum number of sessions before the oldest is evicted. Defaults to 128. */
  maxSessions?: number;
  /** Optional clock for deterministic timestamps. */
  now?: () => number;
}

interface RefSession {
  refs: Map<string, string>;
  lastUsedAt: number;
}

/**
 * A size-bounded, TTL-based session registry that maps session identifiers
 * to mutable key-value maps.
 *
 * Each `get` call bumps the session's last-used timestamp; sessions that
 * exceed the TTL are pruned automatically. When the maximum session count
 * is exceeded, the least-recently-used session is evicted.
 */
export class RefSessionRegistry {
  private readonly sessions = new Map<string, RefSession>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  /**
   * Creates a new ref session registry.
   *
   * @param options - Configuration for TTL, capacity, and clock.
   */
  constructor(options: RefSessionRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.maxSessions = options.maxSessions ?? 128;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns the ref map for a session, creating it if it does not exist.
   *
   * Bumps the session's last-used timestamp and moves it to the end of the
   * LRU order.
   *
   * @param sessionId - The session identifier.
   * @returns The mutable ref map for the session.
   */
  get(sessionId: string): Map<string, string> {
    const now = this.now();
    this.prune(now);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastUsedAt = now;
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing.refs;
    }
    const created = { refs: new Map<string, string>(), lastUsedAt: now };
    this.sessions.set(sessionId, created);
    this.trim();
    return created.refs;
  }

  /** Current number of active (non-expired) sessions. */
  get size() {
    this.prune(this.now());
    return this.sessions.size;
  }

  private prune(now: number) {
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt >= this.ttlMs) this.sessions.delete(id);
    }
  }

  private trim() {
    while (this.sessions.size > this.maxSessions) {
      const oldestId = this.sessions.keys().next().value as string | undefined;
      if (!oldestId) return;
      this.sessions.delete(oldestId);
    }
  }
}
