import type { ProductionJobRecord } from "../../../packages/protocol/src/productionJobProtocol";
import type { ProductionJobStore } from "../jobs/productionJobStore";

export type ReconcilingExecutor = {
  supports(job: ProductionJobRecord): boolean;
  reconcile(jobId: string): Promise<ProductionJobRecord | null | undefined>;
};

/**
 * Jobs interrupted by a gateway restart land in outcome_unknown and previously
 * stayed there until someone clicked reconcile. Run the existing reconcile flow
 * once for each of them; failures only log so startup is never blocked.
 */
export async function reconcileOutcomeUnknownJobs(
  store: ProductionJobStore,
  executors: readonly ReconcilingExecutor[],
): Promise<void> {
  let jobs: ProductionJobRecord[];
  try {
    jobs = await store.list();
  } catch (error) {
    console.warn("Startup reconciliation could not list production jobs", error);
    return;
  }
  for (const job of jobs) {
    if (job.status !== "outcome_unknown") continue;
    const executor = executors.find((candidate) => candidate.supports(job));
    if (!executor) continue;
    try {
      const reconciled = await executor.reconcile(job.id);
      console.log(
        `Startup reconciliation for production job ${job.id} (${job.kind}): ${reconciled?.status ?? "unchanged"}`,
      );
    } catch (error) {
      console.warn(`Startup reconciliation failed for production job ${job.id} (${job.kind})`, error);
    }
  }
}
