import { z } from "zod";

/**
 * Editor-side vocabulary for the Unity live-link preview transport as served
 * by the Gateway session routes (`/api/dcc/unity/live-link/sessions`).
 *
 * The link is preview-only and outbound-only: the Unity Editor long-polls the
 * Gateway with a scoped per-session bearer token and monotonic sequence
 * numbers, and there is no endpoint through which the Unity editor can mutate
 * the project. The Director-side session list never includes the bearer
 * token — the raw secret is returned exactly once, at session creation.
 */

/** Director-side summary of one live-link session (never includes the token). */
export const directorUnityLiveLinkSessionStatusSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(200),
  label: z.string().max(120).nullable(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  closed: z.boolean(),
  latestSeq: z.number().int().nonnegative(),
  bufferedEventCount: z.number().int().nonnegative(),
  /** When the Unity editor client last polled, or null before first contact. */
  connectorSeenAt: z.string().min(1).nullable(),
});

/** A validated Unity live-link session summary. */
export type DirectorUnityLiveLinkSessionStatus = z.infer<typeof directorUnityLiveLinkSessionStatusSchema>;

/**
 * The one-time creation grant: the only response that ever carries the raw
 * bearer token. Callers hand the token to the Unity Editor window and must
 * never render it again afterwards.
 */
export const directorUnityLiveLinkSessionGrantSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(200),
  token: z.string().trim().min(1).max(512),
  expiresAt: z.string().min(1),
  /** The connector-facing poll path for this session. */
  pollPath: z.string().trim().min(1).max(1_024),
});

/** A validated one-time session creation grant. */
export type DirectorUnityLiveLinkSessionGrant = z.infer<typeof directorUnityLiveLinkSessionGrantSchema>;
