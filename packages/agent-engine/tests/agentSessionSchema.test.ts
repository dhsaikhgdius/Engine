import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  agentSessionDisplayTitle,
  agentSessionSchema,
  createAgentCheckpointRequestSchema,
  injectAgentContextRequestSchema,
  isAgentSubagentSession,
  resolveAgentSessionOrigin,
  runningSubagentCount,
  sendAgentMessageRequestSchema,
  sidebarAgentSessions,
} from "../src/agentSessionSchema";

const TARGET = {
  token: "target-1",
  client_id: "browser-1",
  instance_id: "scene-1",
  scene_id: "scene-1",
  creative_scope_id: "scene-1",
  contract_version: 2 as const,
};

describe("agent session schemas", () => {
  it("accepts a durable provider-neutral session", () => {
    expect(
      agentSessionSchema.safeParse({
        id: "session-1",
        provider: "codex",
        profileId: null,
        roleId: null,
        title: "搭建街角",
        status: "idle",
        externalSessionId: null,
        parentSessionId: null,
        activeTurnId: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
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
      }).success,
    ).toBe(true);
  });

  it("keeps origin optional and recovers subagent rows from title", () => {
    expect(
      agentSessionSchema.safeParse({
        id: "session-1",
        provider: "api",
        profileId: null,
        roleId: null,
        title: "Subagent · geometry audit",
        status: "running",
        externalSessionId: null,
        parentSessionId: "parent-1",
        origin: "subagent",
        activeTurnId: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
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
      }).success,
    ).toBe(true);
    expect(
      resolveAgentSessionOrigin({
        origin: undefined,
        parentSessionId: "parent-1",
        title: "Subagent · geometry audit",
      }),
    ).toBe("subagent");
    expect(
      isAgentSubagentSession({
        origin: "fork",
        parentSessionId: "parent-1",
        title: "街角 · 分支",
      }),
    ).toBe(false);
    expect(
      agentSessionDisplayTitle(
        { origin: "subagent", parentSessionId: "parent-1", title: "Subagent · geometry audit" },
        "zh-CN",
      ),
    ).toBe("geometry audit");
    const parent = { origin: "user" as const, parentSessionId: null, title: "父会话", status: "idle" as const };
    const child = {
      origin: "subagent" as const,
      parentSessionId: "parent-1",
      title: "Subagent · audit",
      status: "running" as const,
    };
    const fork = { origin: "fork" as const, parentSessionId: "parent-1", title: "父会话 · 分支", status: "idle" as const };
    expect(sidebarAgentSessions([parent, child, fork])).toEqual([parent, fork]);
    expect(runningSubagentCount([{ ...child, parentSessionId: "parent-1" }], "parent-1")).toBe(1);
  });

  it("rejects events without structured data", () => {
    expect(
      agentEventSchema.safeParse({
        id: "event-1",
        sessionId: "session-1",
        sequence: 1,
        type: "tool.started",
        timestamp: "2026-07-28T00:00:00.000Z",
        turnId: null,
        itemId: null,
        provider: "codex",
      }).success,
    ).toBe(false);
  });

  it("guards message and checkpoint payloads", () => {
    expect(sendAgentMessageRequestSchema.safeParse({ message: "搭建一个街角", target: TARGET }).success).toBe(true);
    expect(sendAgentMessageRequestSchema.safeParse({ message: "", target: TARGET }).success).toBe(false);
    expect(sendAgentMessageRequestSchema.safeParse({ message: "搭建一个街角" }).success).toBe(false);
    expect(createAgentCheckpointRequestSchema.safeParse({ project: { version: 1 } }).success).toBe(true);
  });

  it("requires a scene revision or note for inject", () => {
    expect(injectAgentContextRequestSchema.safeParse({ project_revision: "rev-1" }).success).toBe(true);
    expect(injectAgentContextRequestSchema.safeParse({ text: "人类改了场景" }).success).toBe(true);
    expect(injectAgentContextRequestSchema.safeParse({ kind: "scene_revision" }).success).toBe(false);
    expect(injectAgentContextRequestSchema.safeParse({}).success).toBe(false);
  });
});
