import { afterEach, describe, expect, it, vi } from "vitest";

const controlPlaneMocks = vi.hoisted(() => ({
  directorControlPlaneFetch: vi.fn(),
  resetDirectorControlPlaneCredentials: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => controlPlaneMocks);

import {
  exportAgentWorkspaceBundle,
  fetchAgentWorkspace,
  importAgentWorkspaceBundle,
  saveAgentWorkspaceDocument,
  setAgentWorkspaceMemoryEntry,
} from "../../../../src/comprehensive/editor/assistant/agentWorkspaceClient";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const emptySnapshot = { documents: [], skill_refs: [], memory: [] };

const sampleBundle = {
  format: "director-agent-workspace-bundle",
  version: 1,
  exported_at: "2026-08-25T00:00:00.000Z",
  documents: [{ scope: "org", kind: "instructions", content: "团队指令" }],
  skill_refs: [],
  memory: [{ scope: "user", key: "pref", value: "dark", expires_at: null }],
};

afterEach(() => vi.clearAllMocks());

describe("agentWorkspaceClient", () => {
  it("fetches and validates the workspace snapshot", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValue(jsonResponse(200, { workspace: emptySnapshot }));
    await expect(fetchAgentWorkspace()).resolves.toEqual(emptySnapshot);
    expect(controlPlaneMocks.directorControlPlaneFetch).toHaveBeenCalledWith("/api/agent/workspace", {});
  });

  it("saves documents and surfaces gateway error messages", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        document: { scope: "org", kind: "instructions", content: "内容", version: 3, updated_at: "2026-08-25" },
      }),
    );
    await expect(saveAgentWorkspaceDocument("org", "instructions", "内容")).resolves.toMatchObject({ version: 3 });

    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(
      jsonResponse(400, { error: "工作区文档参数无效" }),
    );
    await expect(saveAgentWorkspaceDocument("org", "instructions", "x")).rejects.toThrow("工作区文档参数无效");
  });

  it("retries exactly once on 401 with credential rotation", async () => {
    controlPlaneMocks.directorControlPlaneFetch
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { workspace: emptySnapshot }));
    await expect(fetchAgentWorkspace()).resolves.toEqual(emptySnapshot);
    expect(controlPlaneMocks.resetDirectorControlPlaneCredentials).toHaveBeenCalledOnce();
    expect(controlPlaneMocks.directorControlPlaneFetch).toHaveBeenCalledTimes(2);
  });

  it("sends TTL only when provided for memory entries", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockImplementation(async () =>
      jsonResponse(200, {
        entry: {
          scope: "user",
          key: "pref",
          value: "dark",
          created_at: "2026-08-25",
          updated_at: "2026-08-25",
          expires_at: null,
        },
      }),
    );
    await setAgentWorkspaceMemoryEntry("user", "pref", "dark");
    const [, init] = controlPlaneMocks.directorControlPlaneFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ scope: "user", key: "pref", value: "dark" });

    await setAgentWorkspaceMemoryEntry("user", "pref", "dark", 60);
    const [, withTtl] = controlPlaneMocks.directorControlPlaneFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(withTtl.body))).toMatchObject({ ttl_seconds: 60 });
  });

  it("round-trips the bundle schema through export and import", async () => {
    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(jsonResponse(200, sampleBundle));
    const bundle = await exportAgentWorkspaceBundle();
    expect(bundle.documents[0]?.content).toBe("团队指令");

    controlPlaneMocks.directorControlPlaneFetch.mockResolvedValueOnce(jsonResponse(200, { workspace: emptySnapshot }));
    await expect(importAgentWorkspaceBundle(bundle)).resolves.toEqual(emptySnapshot);
    const [path, init] = controlPlaneMocks.directorControlPlaneFetch.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/agent/workspace/import");
    expect(JSON.parse(String(init.body))).toEqual(sampleBundle);
  });

  it("rejects malformed bundles before any network call", async () => {
    await expect(importAgentWorkspaceBundle({ format: "wrong" })).rejects.toThrow();
    expect(controlPlaneMocks.directorControlPlaneFetch).not.toHaveBeenCalled();
  });
});
