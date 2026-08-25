import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agentSessionSchema";
import { agentPlanUpdateData, foldAgentPlanFromEvents } from "../src/agentPlanFold";
import type { DirectorAgentPlan } from "../src/agentPlan";

function event(sequence: number, type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent {
  return {
    id: `e${sequence}`,
    sessionId: "s1",
    sequence,
    type,
    timestamp: "2026-08-15T00:00:00.000Z",
    turnId: "turn-1",
    itemId: null,
    provider: "codex",
    data,
  };
}

const plan: DirectorAgentPlan = {
  id: "plan-1",
  agent: "codex",
  summary: "在大厅加一盏灯",
  suggestedNext: "确认后应用",
  operations: [
    {
      id: "plan-1-1",
      tool: "director_workbench",
      input: { op: "observe" },
      summary: "观察场景",
      requiresConfirmation: false,
    },
  ],
  requiresConfirmation: true,
  changedObjectIds: [],
};

describe("agent plan fold", () => {
  it("reconstructs the latest structured plan from plan.updated events", () => {
    const folded = foldAgentPlanFromEvents([
      event(1, "user.message", { text: "加灯" }),
      event(2, "plan.updated", agentPlanUpdateData("confirmation_required", { plan })),
    ]);
    expect(folded).toMatchObject({
      planId: "plan-1",
      status: "confirmation_required",
      requiresConfirmation: true,
      summary: "在大厅加一盏灯",
    });
    expect(folded?.plan?.id).toBe("plan-1");
  });

  it("folds apply as the terminal status and ignores later Codex native plan entries", () => {
    const folded = foldAgentPlanFromEvents([
      event(1, "plan.updated", agentPlanUpdateData("confirmation_required", { plan })),
      event(2, "plan.updated", agentPlanUpdateData("applied", { planId: "plan-1", summary: plan.summary })),
      event(3, "plan.updated", { entries: [{ title: "native" }] }),
    ]);
    expect(folded).toMatchObject({ planId: "plan-1", status: "applied", summary: "在大厅加一盏灯" });
    expect(folded?.plan).toBeNull();
  });

  it("does not treat a discarded plan as still pending", () => {
    expect(
      foldAgentPlanFromEvents([
        event(1, "plan.updated", agentPlanUpdateData("pending", { plan })),
        event(2, "plan.updated", agentPlanUpdateData("discarded", { planId: "plan-1" })),
      ])?.status,
    ).toBe("discarded");
  });
});
