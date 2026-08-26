import { z } from "zod";
import {
  accumulateAgentUsageSummary,
  agentUsageSummarySchema,
  EMPTY_AGENT_USAGE_SUMMARY,
  type AgentUsageAccumulationInput,
  type AgentUsageSummary,
} from "./agentObservabilityProtocol";

/** Film pipeline meter scopes that roll up onto a durable film run receipt. */
export const FILM_RUN_USAGE_SCOPES = ["film-llm", "film-image", "film-video", "film-tts"] as const;
/** One film-pipeline meter scope. */
export type FilmRunUsageScope = (typeof FILM_RUN_USAGE_SCOPES)[number];

/**
 * Per-scope usage rollup stamped on a durable film run and its receipt.
 * `film-tts` defaults to zeros so run documents persisted before speech
 * metering existed still parse. The lazy wrapper defers touching
 * `agentUsageSummarySchema` until parse time: this module participates in an
 * import cycle with `agentObservabilityProtocol` (via `filmPipelineProtocol`),
 * so the binding may still be uninitialized while this module evaluates.
 */
export const filmRunUsageSchema = z.strictObject({
  "film-llm": agentUsageSummarySchema,
  "film-image": agentUsageSummarySchema,
  "film-video": agentUsageSummarySchema,
  "film-tts": z.lazy(() => agentUsageSummarySchema).default(() => ({ ...EMPTY_AGENT_USAGE_SUMMARY })),
});
/** Per-scope film run usage rollup. */
export type FilmRunUsage = z.infer<typeof filmRunUsageSchema>;

/** Zeroed film-run usage rollup. */
export function emptyFilmRunUsage(): FilmRunUsage {
  return {
    "film-llm": { ...EMPTY_AGENT_USAGE_SUMMARY },
    "film-image": { ...EMPTY_AGENT_USAGE_SUMMARY },
    "film-video": { ...EMPTY_AGENT_USAGE_SUMMARY },
    "film-tts": { ...EMPTY_AGENT_USAGE_SUMMARY },
  };
}

/**
 * Whether a meter scope contributes to the durable film-run usage rollup.
 *
 * @param scope - Meter scope string.
 */
export function isFilmRunUsageScope(scope: string): scope is FilmRunUsageScope {
  return (FILM_RUN_USAGE_SCOPES as readonly string[]).includes(scope);
}

/**
 * Folds one film-scoped sample into a film-run usage rollup.
 *
 * @param usage - Current rollup.
 * @param sample - Meter sample (scope must be a film run usage scope).
 * @returns Updated rollup, or the input when the scope is not film-attributed.
 */
export function accumulateFilmRunUsage(
  usage: FilmRunUsage,
  sample: AgentUsageAccumulationInput & { scope: string },
): FilmRunUsage {
  if (!isFilmRunUsageScope(sample.scope)) return usage;
  return {
    ...usage,
    [sample.scope]: accumulateAgentUsageSummary(usage[sample.scope], sample),
  };
}

/** Re-export for callers that only need the summary accumulator alongside film helpers. */
export type { AgentUsageSummary };
