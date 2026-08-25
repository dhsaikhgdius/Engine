import { z } from "zod";
import { asRecord as record } from "../../../packages/protocol/src/primitives";

/**
 * The exhaustive set of Director agent outcome kinds.
 *
 * - `completed` — the tool call succeeded with evidence of completion.
 * - `failed` — the tool call did not succeed and no timeout or stale condition applies.
 * - `timed_out` — the tool call exceeded its allotted time.
 * - `stale_revision` — the project revision changed during or before the call.
 * - `outcome_unknown` — the executor restarted and the outcome cannot be determined.
 */
export const DIRECTOR_AGENT_OUTCOME_KINDS = [
  "completed",
  "failed",
  "timed_out",
  "stale_revision",
  "outcome_unknown",
] as const;

/** Codes that signal a stale project revision. */
const STALE_CODES = new Set(["stale_project_revision", "revision_conflict"]);

/** Runtime codes that signal a transport or command timeout. */
const TIMEOUT_CODES = new Set(["gateway_transport_timeout", "command_timeout"]);
/** Codes that signal an unknown outcome due to executor restart. */
const UNKNOWN_CODES = new Set(["outcome_unknown", "executor_restart_outcome_unknown"]);

/** Zod schema for a single outcome kind. */
export const directorAgentOutcomeKindSchema = z.enum(DIRECTOR_AGENT_OUTCOME_KINDS);

/** Zod schema for a single outcome record. */
export const directorAgentOutcomeSchema = z.strictObject({
  kind: directorAgentOutcomeKindSchema,
  code: z.string().min(1).max(160).nullable().optional(),
  detail: z.string().min(1).max(1_000).nullable().optional(),
});

/** A single outcome kind from the enumerated set. */
export type DirectorAgentOutcomeKind = z.infer<typeof directorAgentOutcomeKindSchema>;
/** A single outcome record with kind, optional code, and optional detail. */
export type DirectorAgentOutcome = z.infer<typeof directorAgentOutcomeSchema>;

/**
 * Extracts the best outcome code from an envelope.
 *
 * Prefers `envelope.code`; falls back to `envelope.result.code`.
 */
function envelopeCode(envelope: Record<string, unknown>): string | null {
  if (typeof envelope.code === "string" && envelope.code.trim()) return envelope.code;
  const inner = record(envelope.result);
  return typeof inner?.code === "string" && inner.code.trim() ? inner.code : null;
}

/**
 * Checks whether `envelope` has objective evidence of a completed tool call.
 *
 * Looks for a capture fingerprint, capture locator, or explicit completion
 * markers (`replay_stale`, `stale_after_capture`, `capture_verified`).
 */
function hasCompletedEvidence(envelope: Record<string, unknown>): boolean {
  const inner = record(envelope.result);
  if (!inner) return false;
  if (inner.replay_stale === true || inner.stale_after_capture === true) return true;
  if (inner.capture_verified === true) return true;
  const capture = record(inner.capture) ?? record(envelope.capture);
  if (typeof capture?.fingerprint === "string" && capture.fingerprint) return true;
  if (typeof capture?.locator === "string" && capture.locator) return true;
  return false;
}

/**
 * Collects every applicable outcome from a tool result envelope.
 *
 * Timeout, stale, and completed outcomes can coexist — this is intentional:
 * a tool call can both succeed *and* be stale, or time out *and* still
 * produce a capture.
 *
 * @param envelope - The raw tool result envelope.
 * @returns An array of outcomes (may be empty, may contain multiple kinds).
 */
export function collectDirectorAgentOutcomes(envelope: Record<string, unknown>): DirectorAgentOutcome[] {
  const code = envelopeCode(envelope);
  const inner = record(envelope.result);
  const success = envelope.success === true;
  const timedOut = Boolean(code && TIMEOUT_CODES.has(code));
  const unknown = Boolean(code && UNKNOWN_CODES.has(code));
  const stale =
    Boolean(code && STALE_CODES.has(code)) ||
    inner?.replay_stale === true ||
    inner?.stale_after_capture === true;
  const completed = success || hasCompletedEvidence(envelope);
  const outcomes: DirectorAgentOutcome[] = [];

  if (completed && !unknown) outcomes.push({ kind: "completed" });
  if (timedOut) outcomes.push({ kind: "timed_out", code });
  if (unknown) outcomes.push({ kind: "outcome_unknown", code });
  if (stale) {
    outcomes.push({
      kind: "stale_revision",
      code: code && STALE_CODES.has(code) ? code : "stale_project_revision",
      detail:
        inner?.stale_after_capture === true ? "stale_after_capture" : inner?.replay_stale === true ? "replay_stale" : null,
    });
  }
  // Fallback: if nothing else matched, mark as failed.
  if (!completed && !unknown && !timedOut) {
    outcomes.push({ kind: "failed", ...(code ? { code } : {}) });
  }

  return outcomes;
}

/**
 * Attaches derived outcomes to an envelope and returns a new object.
 *
 * The original envelope is not mutated.
 *
 * @param envelope - The raw tool result envelope.
 * @returns A shallow copy of the envelope with an `outcomes` array appended.
 */
export function attachDirectorAgentOutcomes<T extends Record<string, unknown>>(envelope: T): T & { outcomes: DirectorAgentOutcome[] } {
  return { ...envelope, outcomes: collectDirectorAgentOutcomes(envelope) };
}