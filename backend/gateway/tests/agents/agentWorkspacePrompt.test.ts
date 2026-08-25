// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  AGENT_WORKSPACE_MERGE_ORDER,
  MAX_AGENT_WORKSPACE_PROMPT_CHARS,
  composeAgentWorkspacePrompt,
} from "../../agents/agentWorkspacePrompt";
import { AgentWorkspaceStore } from "../../agents/agentWorkspaceStore";

function snapshotWith(store: AgentWorkspaceStore) {
  const snapshot = store.snapshot();
  return { documents: snapshot.documents, skill_refs: snapshot.skill_refs };
}

describe("composeAgentWorkspacePrompt", () => {
  it("merges in documented order: org < user < session override", () => {
    const store = new AgentWorkspaceStore("/unused", { path: ":memory:" });
    store.saveDocument("org", "instructions", "团队：默认 35mm 镜头");
    store.saveDocument("user", "instructions", "个人：偏好 50mm 镜头");
    store.replaceSkillRefs([
      {
        id: "wb",
        scope: "org",
        name: "director-workbench",
        source: ".dsh/skills/director-workbench",
        note: "",
        enabled: true,
      },
      { id: "off", scope: "org", name: "disabled-skill", source: "somewhere", note: "", enabled: false },
    ]);

    const result = composeAgentWorkspacePrompt(snapshotWith(store), "本次会话：只拍夜景");
    expect(result.merge_order).toEqual(AGENT_WORKSPACE_MERGE_ORDER);
    expect(result.sections.map((section) => section.layer)).toEqual([
      "workspace_org",
      "workspace_user",
      "session_override",
    ]);
    const orgAt = result.prompt.indexOf("默认 35mm");
    const userAt = result.prompt.indexOf("偏好 50mm");
    const overrideAt = result.prompt.indexOf("只拍夜景");
    expect(orgAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(orgAt);
    expect(overrideAt).toBeGreaterThan(userAt);
    expect(result.prompt).toContain("repo skills < org workspace < user workspace < session override");
    expect(result.prompt).toContain("director-workbench");
    expect(result.prompt).not.toContain("disabled-skill");
    store.close();
  });

  it("never injects memory entries, even when the store holds them", () => {
    const store = new AgentWorkspaceStore("/unused", { path: ":memory:" });
    store.saveDocument("org", "instructions", "指令内容");
    store.setMemory("user", "secret-preference", "MEMORY-MUST-NOT-APPEAR");
    const result = composeAgentWorkspacePrompt(snapshotWith(store));
    expect(result.prompt).not.toContain("MEMORY-MUST-NOT-APPEAR");
    expect(result.prompt).toContain("never injected");
    store.close();
  });

  it("redacts credential-like values with the shared harness rules", () => {
    const store = new AgentWorkspaceStore("/unused", { path: ":memory:" });
    store.saveDocument("org", "instructions", 'api_key: sk-leaky-secret-value\n"gateway_token": "tok-abc"');
    const result = composeAgentWorkspacePrompt(snapshotWith(store), "Authorization: Bearer session-leak");
    expect(result.prompt).not.toContain("sk-leaky-secret-value");
    expect(result.prompt).not.toContain("tok-abc");
    expect(result.prompt).not.toContain("session-leak");
    expect(result.prompt).toContain("[REDACTED]");
    store.close();
  });

  it("returns an empty prompt when the workspace has no content", () => {
    const store = new AgentWorkspaceStore("/unused", { path: ":memory:" });
    const result = composeAgentWorkspacePrompt(snapshotWith(store));
    expect(result.prompt).toBe("");
    expect(result.sections).toEqual([]);
    store.close();
  });

  it("bounds the composed prompt length", () => {
    const store = new AgentWorkspaceStore("/unused", { path: ":memory:" });
    store.saveDocument("org", "instructions", "长".repeat(30_000));
    const result = composeAgentWorkspacePrompt(snapshotWith(store));
    expect(result.prompt.length).toBeLessThanOrEqual(MAX_AGENT_WORKSPACE_PROMPT_CHARS + 200);
    expect(result.prompt).toContain("truncated");
    store.close();
  });
});
