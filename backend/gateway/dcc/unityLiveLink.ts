import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Director → Unity live preview link ("live_link") hub.
 *
 * Trust model:
 * - Director-side operations (create, close, publish, status) share the
 *   gateway's local trust like every other `/api/dcc` route.
 * - The Unity editor client is OUTBOUND-ONLY: it polls the gateway with the
 *   per-session bearer token minted at session creation. The gateway never
 *   connects into Unity, and no endpoint executes connector-supplied code.
 * - The link is never authoritative. It carries preview state one way
 *   (Director → Unity); the token authorizes reading events and nothing
 *   else, and scene changes still travel exclusively through hash-checked
 *   exchange/return packages.
 *
 * Delivery model:
 * - Every published event carries a per-session monotonically increasing
 *   sequence number starting at 1. The hub retains a bounded ring of recent
 *   events plus the latest snapshot event even after it leaves the ring.
 * - A poll asks for events after the last sequence number it applied. When
 *   the requested resume point has already been evicted from the ring, the
 *   hub answers `resync: true` and replays from the latest snapshot so the
 *   client can rebuild its preview state instead of applying a gapped tail.
 * - Polls long-wait for new events and are disconnect-safe: an aborted
 *   request removes its waiter immediately, timeouts clear their timers,
 *   and close/expiry wakes every pending waiter so no poll outlives its
 *   session.
 */

const finiteNumber = z.number().finite();
const nonEmpty = z.string().trim().min(1);
const vec3Schema = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const quaternionSchema = z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]);

/** One entity's preview state in Director canonical space (right-handed, Y-up, metres). */
export const unityLiveLinkEntityStateSchema = z.strictObject({
  directorId: nonEmpty.max(240),
  entityType: z.enum(["object", "camera", "light"]),
  transform: z.strictObject({
    location: vec3Schema,
    rotationQuaternion: quaternionSchema,
    scale: vec3Schema,
  }),
  /** Vertical fov in degrees; only meaningful for cameras. */
  fovDegrees: z.number().finite().positive().max(179).optional(),
});

/**
 * The preview payloads Director publishes. `snapshot` rebuilds the whole
 * preview state (and is the resync anchor), `transform_update` moves a batch
 * of entities, `timeline_update` scrubs the preview playhead.
 */
export const unityLiveLinkEventPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("snapshot"),
    frame: finiteNumber,
    entities: z.array(unityLiveLinkEntityStateSchema).max(4_096),
  }),
  z.strictObject({
    kind: z.literal("transform_update"),
    entities: z.array(unityLiveLinkEntityStateSchema).min(1).max(4_096),
  }),
  z.strictObject({
    kind: z.literal("timeline_update"),
    frame: finiteNumber,
    playing: z.boolean(),
  }),
]);

/** A Director-published live preview event payload. */
export type UnityLiveLinkEventPayload = z.infer<typeof unityLiveLinkEventPayloadSchema>;

/** One sequence-numbered event as delivered to the Unity editor client. */
export interface UnityLiveLinkEvent {
  seq: number;
  publishedAt: string;
  payload: UnityLiveLinkEventPayload;
}

/** The result of one poll: the events to apply and where the client now is. */
export interface UnityLiveLinkPollResult {
  sessionId: string;
  /** Events in ascending seq order; empty when the wait timed out or was aborted. */
  events: UnityLiveLinkEvent[];
  /** The seq the client should pass as `after` on its next poll. */
  latestSeq: number;
  /**
   * True when the requested resume point was evicted from the ring: the
   * client must drop its preview state and rebuild from the delivered
   * snapshot (or await one when none was captured yet).
   */
  resync: boolean;
}

/** Director-side session summary (never includes the bearer token). */
export interface UnityLiveLinkSessionStatus {
  sessionId: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  closed: boolean;
  latestSeq: number;
  bufferedEventCount: number;
  /** When the Unity editor client last polled, or null before first contact. */
  connectorSeenAt: string | null;
}

/** A live-link failure with the HTTP status and stable code the route returns. */
export class UnityLiveLinkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UnityLiveLinkError";
  }
}

/** Options for {@link createUnityLiveLinkHub}; all injectable for host-free tests. */
export interface UnityLiveLinkHubOptions {
  /** Clock override (defaults to `Date.now`). */
  now?: () => number;
  /** Inactivity TTL before a session expires (default 30 minutes). */
  sessionTtlMs?: number;
  /** Ring capacity per session before old events are evicted (default 512). */
  maxBufferedEvents?: number;
  /** Maximum concurrently open sessions (default 8). */
  maxSessions?: number;
  /** Ceiling for one poll's long wait (default 55 seconds). */
  maxWaitMs?: number;
}

interface SessionRecord {
  sessionId: string;
  token: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
  connectorSeenAt: number | null;
  closed: boolean;
  nextSeq: number;
  events: UnityLiveLinkEvent[];
  latestSnapshot: UnityLiveLinkEvent | null;
  waiters: Set<() => void>;
}

/** The gateway-side Unity live-link hub. */
export interface UnityLiveLinkHub {
  /** Mints a new session with a scoped bearer token for the Unity client. */
  createSession(label?: string): { sessionId: string; token: string; expiresAt: string };
  /** Closes a session and wakes every pending poll. Returns false when unknown. */
  closeSession(sessionId: string): boolean;
  /** Publishes Director preview events; returns the assigned seq range. */
  publish(sessionId: string, payloads: UnityLiveLinkEventPayload[]): { firstSeq: number; latestSeq: number };
  /** Long-polls events after `afterSeq` on behalf of the Unity editor client. */
  poll(options: {
    sessionId: string;
    token: string;
    afterSeq: number;
    waitMs: number;
    signal?: AbortSignal;
  }): Promise<UnityLiveLinkPollResult>;
  /** Director-side session summaries (tokens are never included). */
  status(): UnityLiveLinkSessionStatus[];
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 512;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_WAIT_MS = 55_000;
/** One poll never returns more events than this; the client polls again immediately. */
const MAX_EVENTS_PER_POLL = 256;

function tokensMatch(expected: string, presented: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const presentedBuffer = Buffer.from(presented, "utf8");
  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, presentedBuffer);
}

/** Creates the in-memory Unity live-link hub. */
export function createUnityLiveLinkHub(options: UnityLiveLinkHubOptions = {}): UnityLiveLinkHub {
  const now = options.now ?? Date.now;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sessions = new Map<string, SessionRecord>();

  function expiresAt(session: SessionRecord): number {
    return session.lastSeenAt + sessionTtlMs;
  }

  function pruneExpired(): void {
    const timestamp = now();
    for (const [sessionId, session] of sessions) {
      if (timestamp >= expiresAt(session)) {
        wakeWaiters(session);
        sessions.delete(sessionId);
      }
    }
  }

  function wakeWaiters(session: SessionRecord): void {
    const waiters = [...session.waiters];
    session.waiters.clear();
    for (const wake of waiters) wake();
  }

  function requireSession(sessionId: string): SessionRecord {
    pruneExpired();
    const session = sessions.get(sessionId);
    if (!session) {
      throw new UnityLiveLinkError(
        404,
        "live_link_session_unknown",
        `Unknown or expired Unity live-link session: ${sessionId}`,
      );
    }
    if (session.closed) {
      throw new UnityLiveLinkError(
        410,
        "live_link_session_closed",
        `Unity live-link session ${sessionId} was closed by Director.`,
      );
    }
    return session;
  }

  function collectEvents(session: SessionRecord, afterSeq: number): { events: UnityLiveLinkEvent[]; resync: boolean } {
    const head = session.nextSeq - 1;
    const oldestBuffered = session.events[0]?.seq ?? session.nextSeq;
    const resumeValid = afterSeq <= head && afterSeq >= oldestBuffered - 1;
    if (resumeValid) {
      return {
        events: session.events.filter((event) => event.seq > afterSeq).slice(0, MAX_EVENTS_PER_POLL),
        resync: false,
      };
    }
    // The client resumes behind the ring (its tail was evicted) or ahead of
    // this session's head (stale client state): replay from the latest
    // snapshot, which survives ring eviction, so it can rebuild. Without a
    // snapshot the buffered absolute states are delivered best-effort.
    const snapshot = session.latestSnapshot;
    const tail = snapshot ? session.events.filter((event) => event.seq > snapshot.seq) : [...session.events];
    const events = (snapshot ? [snapshot, ...tail] : tail).slice(0, MAX_EVENTS_PER_POLL);
    return { events, resync: true };
  }

  return {
    createSession(label?: string) {
      pruneExpired();
      const openSessions = [...sessions.values()].filter((session) => !session.closed).length;
      if (openSessions >= maxSessions) {
        throw new UnityLiveLinkError(
          429,
          "live_link_session_limit",
          `The gateway already has ${openSessions} open Unity live-link sessions; close one first.`,
        );
      }
      const timestamp = now();
      const session: SessionRecord = {
        sessionId: randomUUID(),
        token: randomBytes(32).toString("hex"),
        label: label?.trim() ? label.trim() : null,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        connectorSeenAt: null,
        closed: false,
        nextSeq: 1,
        events: [],
        latestSnapshot: null,
        waiters: new Set(),
      };
      sessions.set(session.sessionId, session);
      return {
        sessionId: session.sessionId,
        token: session.token,
        expiresAt: new Date(expiresAt(session)).toISOString(),
      };
    },

    closeSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session || session.closed) return false;
      session.closed = true;
      // Keep the record until its TTL passes so late polls get a clean 410.
      session.lastSeenAt = now();
      wakeWaiters(session);
      return true;
    },

    publish(sessionId: string, payloads: UnityLiveLinkEventPayload[]) {
      const session = requireSession(sessionId);
      if (payloads.length === 0) {
        throw new UnityLiveLinkError(400, "live_link_publish_empty", "Publishing requires at least one event.");
      }
      session.lastSeenAt = now();
      const publishedAt = new Date(session.lastSeenAt).toISOString();
      const firstSeq = session.nextSeq;
      for (const payload of payloads) {
        const event: UnityLiveLinkEvent = { seq: session.nextSeq, publishedAt, payload };
        session.nextSeq += 1;
        session.events.push(event);
        if (payload.kind === "snapshot") session.latestSnapshot = event;
      }
      if (session.events.length > maxBufferedEvents) {
        session.events.splice(0, session.events.length - maxBufferedEvents);
      }
      wakeWaiters(session);
      return { firstSeq, latestSeq: session.nextSeq - 1 };
    },

    async poll({ sessionId, token, afterSeq, waitMs, signal }) {
      const session = requireSession(sessionId);
      if (!tokensMatch(session.token, token)) {
        throw new UnityLiveLinkError(
          401,
          "live_link_token_invalid",
          "The presented Unity live-link token does not match this session.",
        );
      }
      session.lastSeenAt = now();
      session.connectorSeenAt = session.lastSeenAt;

      let collected = collectEvents(session, afterSeq);
      const boundedWaitMs = Math.max(0, Math.min(waitMs, maxWaitMs));
      if (collected.events.length === 0 && !collected.resync && boundedWaitMs > 0 && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          let settled = false;
          let timer: NodeJS.Timeout | null = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            session.waiters.delete(finish);
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            resolve();
          };
          session.waiters.add(finish);
          timer = setTimeout(finish, boundedWaitMs);
          signal?.addEventListener("abort", finish, { once: true });
        });
        // The session may have closed or expired while we waited.
        if (!sessions.has(sessionId)) {
          throw new UnityLiveLinkError(
            404,
            "live_link_session_unknown",
            `Unknown or expired Unity live-link session: ${sessionId}`,
          );
        }
        if (session.closed) {
          throw new UnityLiveLinkError(
            410,
            "live_link_session_closed",
            `Unity live-link session ${sessionId} was closed by Director.`,
          );
        }
        collected = signal?.aborted ? { events: [], resync: false } : collectEvents(session, afterSeq);
      }

      const lastDelivered = collected.events[collected.events.length - 1]?.seq;
      return {
        sessionId,
        events: collected.events,
        // A resync with nothing to replay rebases the client onto the head so
        // its next poll waits for fresh events instead of looping on resync.
        latestSeq: lastDelivered ?? (collected.resync ? session.nextSeq - 1 : afterSeq),
        resync: collected.resync,
      };
    },

    status() {
      pruneExpired();
      return [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        label: session.label,
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: new Date(expiresAt(session)).toISOString(),
        closed: session.closed,
        latestSeq: session.nextSeq - 1,
        bufferedEventCount: session.events.length,
        connectorSeenAt: session.connectorSeenAt === null ? null : new Date(session.connectorSeenAt).toISOString(),
      }));
    },
  };
}
