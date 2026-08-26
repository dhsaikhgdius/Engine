import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  fetchAgentWorkspace: vi.fn(),
  saveAgentWorkspaceDocument: vi.fn(),
  listAgentWorkspaceDocumentVersions: vi.fn(),
  restoreAgentWorkspaceDocumentVersion: vi.fn(),
  saveAgentWorkspaceSkillRefs: vi.fn(),
  setAgentWorkspaceMemoryEntry: vi.fn(),
  deleteAgentWorkspaceMemoryEntry: vi.fn(),
  exportAgentWorkspaceBundle: vi.fn(),
  importAgentWorkspaceBundle: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/assistant/agentWorkspaceClient", () => clientMocks);

import { AgentWorkspaceSettings } from "../../../../src/comprehensive/editor/assistant/AgentWorkspaceSettings";

const snapshot = {
  documents: [
    { scope: "org", kind: "instructions", content: "团队级指令", version: 2, updated_at: "2026-08-25T00:00:00.000Z" },
  ],
  skill_refs: [
    {
      id: "wb",
      scope: "org",
      name: "director-workbench",
      source: ".dsh/skills/director-workbench",
      note: "",
      enabled: true,
    },
  ],
  memory: [
    {
      scope: "user",
      key: "pref",
      value: "dark",
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:00:00.000Z",
      expires_at: null,
    },
  ],
};

afterEach(() => vi.clearAllMocks());

async function openPanel() {
  clientMocks.fetchAgentWorkspace.mockResolvedValue(snapshot);
  clientMocks.listAgentWorkspaceDocumentVersions.mockResolvedValue([
    { scope: "org", kind: "instructions", version: 2, chars: 5, saved_at: "2026-08-25T00:00:00.000Z" },
    { scope: "org", kind: "instructions", version: 1, chars: 3, saved_at: "2026-08-24T00:00:00.000Z" },
  ]);
  render(<AgentWorkspaceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Agent 工作区设置" }));
  await waitFor(() => expect(clientMocks.fetchAgentWorkspace).toHaveBeenCalled());
}

describe("AgentWorkspaceSettings", () => {
  it("loads the workspace, shows documents, skills, memory, and the red-line note", async () => {
    await openPanel();
    expect(await screen.findByDisplayValue("团队级指令")).toBeInTheDocument();
    expect(screen.getByText("director-workbench")).toBeInTheDocument();
    expect(screen.getByText(".dsh/skills/director-workbench")).toBeInTheDocument();
    expect(screen.getByText("pref")).toBeInTheDocument();
    expect(screen.getByText(/永远不会自动注入为指令/)).toBeInTheDocument();
    // Version history is offered for restore.
    expect(screen.getByLabelText("版本历史")).toBeInTheDocument();
  });

  it("saves an edited document and reports the new version", async () => {
    await openPanel();
    clientMocks.saveAgentWorkspaceDocument.mockResolvedValue({
      scope: "org",
      kind: "instructions",
      content: "新指令",
      version: 3,
      updated_at: "2026-08-25T01:00:00.000Z",
    });
    const textarea = await screen.findByLabelText("工作区文档内容");
    fireEvent.change(textarea, { target: { value: "新指令" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(clientMocks.saveAgentWorkspaceDocument).toHaveBeenCalledWith("org", "instructions", "新指令"),
    );
    expect(await screen.findByText(/已保存 v3/)).toBeInTheDocument();
  });

  it("restores a historical version through the client", async () => {
    await openPanel();
    clientMocks.restoreAgentWorkspaceDocumentVersion.mockResolvedValue({
      scope: "org",
      kind: "instructions",
      content: "旧内容",
      version: 3,
      updated_at: "2026-08-25T01:00:00.000Z",
    });
    fireEvent.change(screen.getByLabelText("版本历史"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(clientMocks.restoreAgentWorkspaceDocumentVersion).toHaveBeenCalledWith("org", "instructions", 1),
    );
    expect(await screen.findByDisplayValue("旧内容")).toBeInTheDocument();
  });

  it("surfaces gateway errors inline and offers a retry", async () => {
    clientMocks.fetchAgentWorkspace.mockRejectedValue(new Error("网关不可用"));
    clientMocks.listAgentWorkspaceDocumentVersions.mockResolvedValue([]);
    render(<AgentWorkspaceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Agent 工作区设置" }));
    expect(await screen.findByText("网关不可用")).toBeInTheDocument();
    expect(screen.getByText("Agent 工作区加载失败")).toBeInTheDocument();

    clientMocks.fetchAgentWorkspace.mockResolvedValue(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByDisplayValue("团队级指令")).toBeInTheDocument();
    expect(screen.queryByText("网关不可用")).not.toBeInTheDocument();
  });

  it("names the likely cause when the gateway is unreachable", async () => {
    clientMocks.fetchAgentWorkspace.mockRejectedValue(new Error("Failed to fetch"));
    clientMocks.listAgentWorkspaceDocumentVersions.mockResolvedValue([]);
    render(<AgentWorkspaceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Agent 工作区设置" }));
    expect(await screen.findByText("无法连接 Director 网关，请确认它已在本地启动。")).toBeInTheDocument();
  });

  it("shows empty states instead of blank sections", async () => {
    clientMocks.fetchAgentWorkspace.mockResolvedValue({ documents: [], skill_refs: [], memory: [] });
    clientMocks.listAgentWorkspaceDocumentVersions.mockResolvedValue([]);
    render(<AgentWorkspaceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Agent 工作区设置" }));
    expect(await screen.findByText("还没有技能引用")).toBeInTheDocument();
    expect(screen.getByText("还没有记忆条目")).toBeInTheDocument();
    expect(screen.getByText("尚未保存")).toBeInTheDocument();
  });
});
