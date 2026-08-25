import type { DirectorAgentPlan } from "@director/agent-engine";

export type StoredAgentPlan = {
  plan: DirectorAgentPlan;
  sessionId?: string | null;
  sceneSignature: string;
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
