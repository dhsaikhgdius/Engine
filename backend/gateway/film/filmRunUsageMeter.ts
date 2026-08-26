import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentUsageMeter, AgentUsageMeterInput } from "../../../packages/protocol/src/agentObservabilityProtocol";
import { accumulateFilmRunUsage, isFilmRunUsageScope } from "../../../packages/protocol/src/filmRunUsage";
import type { FilmRunStore } from "./filmRunStore";

/**
 * Async context that attributes film-llm / film-image / film-video meter
 * samples to the durable film run currently executing on this async chain.
 * Concurrent runs stay isolated without a process-global "current run" slot.
 */
export const filmRunUsageContext = new AsyncLocalStorage<string>();

/**
 * Builds a meter that forwards every sample to the shared agent Trace store
 * and, when an active film-run async context is present, folds film scopes
 * into that run's durable `usage` rollup (surfaced on the run receipt).
 *
 * @param store - Durable film run store.
 * @param downstream - Optional shared agent usage meter (Trace panel).
 * @returns A meter safe to pass into planning/render providers.
 */
export function createFilmRunAttributingMeter(store: FilmRunStore, downstream?: AgentUsageMeter): AgentUsageMeter {
  return (sample: AgentUsageMeterInput) => {
    downstream?.(sample);
    const runId = filmRunUsageContext.getStore();
    if (!runId || !isFilmRunUsageScope(sample.scope)) return;
    void store
      .update(runId, (run) => ({
        ...run,
        usage: accumulateFilmRunUsage(run.usage, sample),
      }))
      .catch((error: unknown) => {
        console.warn("Film run usage rollup rejected a sample", error);
      });
  };
}
