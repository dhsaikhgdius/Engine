/**
 * Sliding-window rate limit for collaboration invite mint/revoke HTTP routes.
 *
 * Defaults off (`limitPerMinute = 0`) so local trust mode stays unbounded.
 * Operators opt in with `DIRECTOR_COLLAB_INVITE_RATE_LIMIT_PER_MINUTE`. The
 * limiter keys on the Authorization bearer fingerprint (or a caller-supplied
 * key) because the gateway is loopback-first and IP alone is not meaningful.
 *
 * @module collaborationInviteRateLimit
 */

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 4_096;

/** Outcome of one rate-limit check. */
export type CollaborationInviteRateLimitVerdict =
  { allowed: true } | { allowed: false; retryAfterSeconds: number; limitPerMinute: number };

/**
 * Parses `DIRECTOR_COLLAB_INVITE_RATE_LIMIT_PER_MINUTE`: a positive integer
 * clamped to 10_000, else 0 (disabled).
 */
export function parseCollaborationInviteRateLimitPerMinute(configured: string | undefined): number {
  const parsed = Number.parseInt(configured?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 10_000);
}

/** Fingerprint the gateway Authorization header for per-caller windows. */
export function collaborationInviteRateLimitKeyFromAuthorization(authorization: string | undefined): string {
  const value = authorization?.trim() ?? "";
  if (!value) return "anonymous";
  // Keep the key short and avoid storing the raw bearer token in the map key.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `auth:${(hash >>> 0).toString(16)}`;
}

/**
 * In-memory sliding-window limiter for invite mint/revoke. Shared across both
 * routes so an attacker cannot burn the budget on mint then again on revoke.
 */
export class CollaborationInviteRateLimiter {
  private readonly timestampsByKey = new Map<string, number[]>();

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the configured limit is zero (local trust / unlimited). */
  get enabled(): boolean {
    return this.limitPerMinute > 0;
  }

  /**
   * Record one attempt for `key` and return whether it is still within budget.
   * Disabled limiters always allow.
   */
  check(key: string): CollaborationInviteRateLimitVerdict {
    if (!this.enabled) return { allowed: true };
    const now = this.now();
    const windowStart = now - WINDOW_MS;
    const prior = this.timestampsByKey.get(key) ?? [];
    const recent = prior.filter((stamp) => stamp > windowStart);
    if (recent.length >= this.limitPerMinute) {
      this.timestampsByKey.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1_000));
      return { allowed: false, retryAfterSeconds, limitPerMinute: this.limitPerMinute };
    }
    recent.push(now);
    this.timestampsByKey.set(key, recent);
    this.evictIfNeeded(windowStart);
    return { allowed: true };
  }

  private evictIfNeeded(windowStart: number) {
    if (this.timestampsByKey.size <= MAX_TRACKED_KEYS) return;
    for (const [key, stamps] of this.timestampsByKey) {
      const recent = stamps.filter((stamp) => stamp > windowStart);
      if (!recent.length) this.timestampsByKey.delete(key);
      else this.timestampsByKey.set(key, recent);
      if (this.timestampsByKey.size <= MAX_TRACKED_KEYS / 2) break;
    }
    // Hard cap: drop arbitrary oldest entries if still over budget after prune.
    while (this.timestampsByKey.size > MAX_TRACKED_KEYS) {
      const first = this.timestampsByKey.keys().next().value;
      if (first === undefined) break;
      this.timestampsByKey.delete(first);
    }
  }
}
