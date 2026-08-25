// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  AGENT_WORKSPACE_DOCUMENT_VERSION_LIMIT,
  AgentWorkspaceStore,
  agentWorkspaceBundleSchema,
} from "../../agents/agentWorkspaceStore";

function openStore(nowMs = { value: 1_700_000_000_000 }) {
  const store = new AgentWorkspaceStore("/unused", { path: ":memory:", now: () => nowMs.value });
  return { store, nowMs };
}

describe("AgentWorkspaceStore documents", () => {
  it("starts empty and bumps versions with history on save", () => {
    const { store } = openStore();
    expect(store.getDocument("org", "instructions")).toMatchObject({ content: "", version: 0, updated_at: null });

    const first = store.saveDocument("org", "instructions", "始终先 observe 再 mutate");
    expect(first.version).toBe(1);
    const second = store.saveDocument("org", "instructions", "始终先 observe 再 mutate。镜头默认 35mm。");
    expect(second.version).toBe(2);

    const versions = store.listDocumentVersions("org", "instructions");
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(store.getDocumentVersion("org", "instructions", 1)).toBe("始终先 observe 再 mutate");
    store.close();
  });

  it("treats identical content as a no-op save", () => {
    const { store } = openStore();
    store.saveDocument("user", "learnings", "same");
    const again = store.saveDocument("user", "learnings", "same");
    expect(again.version).toBe(1);
    expect(store.listDocumentVersions("user", "learnings")).toHaveLength(1);
    store.close();
  });

  it("restores a historical version as a new version, preserving history", () => {
    const { store } = openStore();
    store.saveDocument("org", "instructions", "v1 内容");
    store.saveDocument("org", "instructions", "v2 内容");
    const restored = store.restoreDocumentVersion("org", "instructions", 1);
    expect(restored).toMatchObject({ version: 3, content: "v1 内容" });
    expect(store.listDocumentVersions("org", "instructions")).toHaveLength(3);
    expect(store.restoreDocumentVersion("org", "instructions", 99)).toBeNull();
    store.close();
  });

  it("caps version history at the retention limit", () => {
    const { store } = openStore();
    for (let index = 0; index <= AGENT_WORKSPACE_DOCUMENT_VERSION_LIMIT + 5; index += 1) {
      store.saveDocument("org", "instructions", `内容 ${index}`);
    }
    const versions = store.listDocumentVersions("org", "instructions");
    expect(versions).toHaveLength(AGENT_WORKSPACE_DOCUMENT_VERSION_LIMIT);
    store.close();
  });

  it("persists documents across store re-open on the same file", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "director-agent-workspace-"));
    try {
      const first = new AgentWorkspaceStore(directory);
      first.saveDocument("org", "instructions", "跨会话可见的指令");
      first.close();
      const second = new AgentWorkspaceStore(directory);
      expect(second.getDocument("org", "instructions").content).toBe("跨会话可见的指令");
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("AgentWorkspaceStore skill refs", () => {
  it("replaces the list atomically and rejects duplicate ids", () => {
    const { store } = openStore();
    const refs = store.replaceSkillRefs([
      { id: "wb", scope: "org", name: "director-workbench", source: ".dsh/skills/director-workbench", note: "", enabled: true },
    ]);
    expect(refs).toHaveLength(1);
    expect(() =>
      store.replaceSkillRefs([
        { id: "a", scope: "org", name: "x", source: "s", note: "", enabled: true },
        { id: "a", scope: "user", name: "y", source: "s2", note: "", enabled: true },
      ]),
    ).toThrow(/Duplicate/);
    // Failed replace keeps the previous list.
    expect(store.listSkillRefs()).toHaveLength(1);
    store.close();
  });
});

describe("AgentWorkspaceStore memory", () => {
  it("stores structured values with TTL and purges expired entries", () => {
    const { store, nowMs } = openStore();
    store.setMemory("user", "favorite-lens", { mm: 50 }, 60);
    store.setMemory("user", "keeper", "no ttl");
    expect(store.listMemory()).toHaveLength(2);

    nowMs.value += 61_000;
    const remaining = store.listMemory();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ key: "keeper", value: "no ttl", expires_at: null });
    store.close();
  });

  it("overwrites by key, deletes explicitly, and bounds value size", () => {
    const { store } = openStore();
    store.setMemory("org", "k", 1);
    const updated = store.setMemory("org", "k", 2);
    expect(updated.value).toBe(2);
    expect(store.deleteMemory("org", "k")).toBe(true);
    expect(store.deleteMemory("org", "k")).toBe(false);
    expect(() => store.setMemory("org", "big", "x".repeat(9_000))).toThrow(/serialized characters/);
    store.close();
  });
});

describe("AgentWorkspaceStore bundle", () => {
  it("round-trips export → import into a fresh store", () => {
    const { store, nowMs } = openStore();
    store.saveDocument("org", "instructions", "团队指令");
    store.saveDocument("user", "learnings", "个人经验");
    store.replaceSkillRefs([
      { id: "wb", scope: "org", name: "director-workbench", source: ".dsh/skills/director-workbench", note: "先加载", enabled: true },
    ]);
    store.setMemory("user", "pref", { theme: "dark" }, 3_600);
    store.setMemory("org", "fact", "no-ttl-fact");

    const bundle = store.exportBundle();
    expect(agentWorkspaceBundleSchema.parse(bundle)).toBeTruthy();
    store.close();

    const cloned = new AgentWorkspaceStore("/unused", { path: ":memory:", now: () => nowMs.value });
    const snapshot = cloned.importBundle(bundle);
    expect(snapshot.documents.find((d) => d.scope === "org" && d.kind === "instructions")?.content).toBe("团队指令");
    expect(snapshot.documents.find((d) => d.scope === "user" && d.kind === "learnings")?.content).toBe("个人经验");
    expect(snapshot.skill_refs).toEqual(bundle.skill_refs);
    expect(snapshot.memory.map((entry) => entry.key).sort()).toEqual(["fact", "pref"]);

    // Second export equals the first on all portable fields.
    const reExported = cloned.exportBundle();
    expect(reExported.documents).toEqual(bundle.documents);
    expect(reExported.skill_refs).toEqual(bundle.skill_refs);
    expect(reExported.memory).toEqual(bundle.memory);
    cloned.close();
  });

  it("drops already-expired memory on import", () => {
    const { store, nowMs } = openStore();
    store.setMemory("user", "soon", "gone", 10);
    const bundle = store.exportBundle();
    store.close();

    nowMs.value += 11_000;
    const late = new AgentWorkspaceStore("/unused", { path: ":memory:", now: () => nowMs.value });
    const snapshot = late.importBundle(bundle);
    expect(snapshot.memory).toHaveLength(0);
    late.close();
  });

  it("never contains provider credentials fields", () => {
    const { store } = openStore();
    store.saveDocument("org", "instructions", "内容");
    const serialized = JSON.stringify(store.exportBundle());
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("baseUrl");
    store.close();
  });
});
