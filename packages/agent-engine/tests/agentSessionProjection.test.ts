import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentSession } from "../src/agentSessionSchema";
import { applyAgentSessionEvent } from "../src/agentSessionProjection";

function session(): AgentSession {
  return {
    id: "session-1",
    provider: "codex",
    profileId: null,
    roleId: null,
    title: "Session",
    status: "idle",
    externalSessionId: null,
    parentSessionId: null,
    activeTurnId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    lastEventSequence: 0,
    queuedMessageCount: 0,
    capabilities: {
      streaming: true,
      resume: true,
      fork: true,
      interrupt: true,
      approvals: true,
      messageQueue: true,
      checkpoints: true,
    },
  };
}

function event(type: AgentEvent["type"], data: Record<string, unknown> = {}, turnId: string | null = null): AgentEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: "session-1",
    sequence: 1,
    type,
    timestamp: "2026-08-15T00:00:01.000Z",
    turnId,
    itemId: null,
    provider: "codex",
    data,
  };
}

describe("applyAgentSessionEvent", () => {
  it("projects lifecycle, queue, and metadata from the durable stream", () => {
    const running = applyAgentSessionEvent(session(), event("turn.started", {}, "turn-1"));
    expect(running).toMatchObject({ status: "running", activeTurnId: "turn-1", lastEventSequence: 1 });

    const queued = applyAgentSessionEvent(running, event("queue.updated", { action: "enqueued", count: 2 }));
    expect(queued).toMatchObject({ status: "running", queuedMessageCount: 2 });

    const completed = applyAgentSessionEvent(
      queued,
      event("turn.completed", { turn: { status: "interrupted" } }, "turn-1"),
    );
    expect(completed).toMatchObject({ status: "interrupted", activeTurnId: null });

    const archived = applyAgentSessionEvent(completed, event("session.updated", { status: "archived", title: "Done" }));
    expect(archived).toMatchObject({ status: "archived", title: "Done" });

    const switched = applyAgentSessionEvent(
      archived,
      event("session.updated", {
        provider: "api",
        profileId: "epic.deepseek-v4-flash",
        model: "deepseek-v4-flash",
        externalSessionId: null,
      }),
    );
    expect(switched).toMatchObject({
      provider: "api",
      profileId: "epic.deepseek-v4-flash",
      externalSessionId: null,
    });
  });
});
