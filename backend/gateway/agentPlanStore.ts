import type { DirectorAgentPlan } from "@director/agent-engine";

/** One cached plan plus the context needed to validate its application. */
export type StoredAgentPlan = {
  plan: DirectorAgentPlan;
  sessionId?: string | null;
  /** Fingerprint of the scene the plan was drafted against; apply rechecks it. */
  sceneSignature: string;
  /** Epoch ms after which the plan is treated as gone. */
  expiresAt: number;
};

/**
 * Short-lived assistant plan cache. Replaces the plan tables that used to live
 * on the deleted homemade Agent session store.
 */
export class AgentPlanStore {
  private readonly plans = new Map<string, StoredAgentPlan>();

  savePlan(input: StoredAgentPlan) {
    this.plans.set(input.plan.id, input);
  }

  /** Returns the plan unless expired; expiry is enforced lazily on read. */
  getPlan(planId: string): StoredAgentPlan | undefined {
    const stored = this.plans.get(planId);
    if (!stored) return undefined;
    if (stored.expiresAt <= Date.now()) {
      this.plans.delete(planId);
      return undefined;
    }
    return stored;
  }

  deletePlan(planId: string) {
    this.plans.delete(planId);
  }

  clearPlans() {
    this.plans.clear();
  }
}
