import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { ComfyNodeSnapshot } from "../../../../../../packages/protocol/src/comfyGenerationProtocol";

const bridgeMocks = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/workspaces/galleryGenerationBridge", () => ({
  listComfyGenerationNodes: bridgeMocks.list,
  saveComfyGenerationNode: bridgeMocks.save,
  removeComfyGenerationNode: bridgeMocks.remove,
}));

import {
  ComfyNodesDialog,
  deriveComfyNodeId,
  isComfyNodeAvailabilityError,
} from "../../../../src/comprehensive/editor/comfy/ComfyNodesDialog";

function nodeSnapshot(overrides: Partial<ComfyNodeSnapshot> = {}): ComfyNodeSnapshot {
  return {
    id: "workstation",
    label: "工作站",
    baseUrl: "http://127.0.0.1:8188",
    enabled: true,
    maxConcurrent: 1,
    status: "online",
    activeJobs: 0,
    queuedJobs: 0,
    queueRemaining: 0,
    ramTotalBytes: null,
    ramFreeBytes: null,
    vramTotalBytes: null,
    vramFreeBytes: null,
    deviceName: null,
    detail: null,
    checkedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  bridgeMocks.list.mockReset();
  bridgeMocks.save.mockReset();
  bridgeMocks.remove.mockReset();
  bridgeMocks.list.mockResolvedValue([]);
  bridgeMocks.save.mockImplementation(async (node: unknown) => node);
  bridgeMocks.remove.mockResolvedValue(true);
});

it("renders an accessible empty state that points at COMFYUI_URL and closes on Escape", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<ComfyNodesDialog onClose={onClose} />);

  const dialog = await screen.findByRole("dialog", { name: "ComfyUI 节点池" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await screen.findByText("尚未配置 ComfyUI 节点。可在此添加，或设置 COMFYUI_URL。")).toBeInTheDocument();
  expect(screen.getByText("COMFYUI_URL 环境变量在网关启动时读取，修改后需重启网关。")).toBeInTheDocument();

  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("lists node health from the pool snapshots, including offline detail", async () => {
  bridgeMocks.list.mockResolvedValue([
    nodeSnapshot(),
    nodeSnapshot({
      id: "render-box",
      label: "渲染机",
      baseUrl: "http://10.0.0.9:8188",
      status: "offline",
      detail: "HTTP 502",
    }),
    nodeSnapshot({ id: "paused", label: "备用机", enabled: false, status: "disabled" }),
  ]);
  render(<ComfyNodesDialog onClose={vi.fn()} />);

  expect(await screen.findByText("工作站")).toBeInTheDocument();
  expect(screen.getByText("在线")).toBeInTheDocument();
  expect(screen.getByText("离线")).toBeInTheDocument();
  expect(screen.getByText("HTTP 502")).toBeInTheDocument();
  expect(screen.getByText("已停用")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用 备用机" })).toBeInTheDocument();
});

it("adds a node with a schema-safe generated id and a normalized URL", async () => {
  const user = userEvent.setup();
  bridgeMocks.list.mockResolvedValueOnce([]);
  bridgeMocks.list.mockResolvedValue([nodeSnapshot({ id: "local", label: "本机" })]);
  render(<ComfyNodesDialog onClose={vi.fn()} />);
  await screen.findByText("尚未配置 ComfyUI 节点。可在此添加，或设置 COMFYUI_URL。");

  await user.type(screen.getByLabelText("节点名称"), "本机 ComfyUI");
  await user.type(screen.getByLabelText("节点地址"), "http://127.0.0.1:8188/");
  await user.click(screen.getByRole("button", { name: "添加生成节点" }));

  expect(await screen.findByText("ComfyUI 节点已保存")).toBeInTheDocument();
  expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
  const saved = bridgeMocks.save.mock.calls[0]![0] as {
    id: string;
    label: string;
    baseUrl: string;
    enabled: boolean;
    maxConcurrent: number;
  };
  expect(saved.id).toMatch(/^[a-z0-9][a-z0-9._-]{1,79}$/i);
  expect(saved.label).toBe("本机 ComfyUI");
  expect(saved.baseUrl).toBe("http://127.0.0.1:8188");
  expect(saved.enabled).toBe(true);
  expect(saved.maxConcurrent).toBe(1);
  expect(await screen.findByText("本机")).toBeInTheDocument();
});

it("validates the add-node form before calling the gateway", async () => {
  const user = userEvent.setup();
  render(<ComfyNodesDialog onClose={vi.fn()} />);
  await screen.findByText("尚未配置 ComfyUI 节点。可在此添加，或设置 COMFYUI_URL。");

  await user.click(screen.getByRole("button", { name: "添加生成节点" }));
  expect(await screen.findByText("请填写节点名称")).toBeInTheDocument();

  await user.type(screen.getByLabelText("节点名称"), "本机");
  await user.type(screen.getByLabelText("节点地址"), "not-a-url");
  await user.click(screen.getByRole("button", { name: "添加生成节点" }));
  expect(await screen.findByText("节点地址必须是 http:// 或 https:// 开头的 URL")).toBeInTheDocument();
  expect(bridgeMocks.save).not.toHaveBeenCalled();
});

it("requires a second click before removing a node and disarms on blur", async () => {
  const user = userEvent.setup();
  bridgeMocks.list.mockResolvedValue([nodeSnapshot()]);
  render(<ComfyNodesDialog onClose={vi.fn()} />);
  await screen.findByText("工作站");

  await user.click(screen.getByRole("button", { name: "删除 工作站" }));
  expect(screen.getByRole("button", { name: "确定移除这个 ComfyUI 节点吗？" })).toBeInTheDocument();
  expect(bridgeMocks.remove).not.toHaveBeenCalled();

  await user.tab();
  expect(await screen.findByRole("button", { name: "删除 工作站" })).toBeInTheDocument();
  expect(bridgeMocks.remove).not.toHaveBeenCalled();

  bridgeMocks.list.mockResolvedValue([]);
  await user.click(screen.getByRole("button", { name: "删除 工作站" }));
  await user.click(screen.getByRole("button", { name: "确定移除这个 ComfyUI 节点吗？" }));

  expect(await screen.findByText("节点已移除")).toBeInTheDocument();
  expect(bridgeMocks.remove).toHaveBeenCalledWith("workstation");
  expect(await screen.findByText("尚未配置 ComfyUI 节点。可在此添加，或设置 COMFYUI_URL。")).toBeInTheDocument();
});

it("disables a node in place through the upsert endpoint", async () => {
  const user = userEvent.setup();
  bridgeMocks.list.mockResolvedValue([nodeSnapshot()]);
  render(<ComfyNodesDialog onClose={vi.fn()} />);
  await screen.findByText("工作站");

  await user.click(screen.getByRole("button", { name: "停用 工作站" }));

  expect(await screen.findByText("节点已停用")).toBeInTheDocument();
  expect(bridgeMocks.save).toHaveBeenCalledWith({
    id: "workstation",
    label: "工作站",
    baseUrl: "http://127.0.0.1:8188",
    enabled: false,
    maxConcurrent: 1,
  });
});

it("surfaces gateway errors from the node listing with a retry affordance", async () => {
  bridgeMocks.list.mockRejectedValue(new Error("网关不可达"));
  render(<ComfyNodesDialog onClose={vi.fn()} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("网关不可达");
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
});

it("derives pool-unique ids that satisfy the node-definition schema", () => {
  expect(deriveComfyNodeId("Render Box 01", [])).toBe("render-box-01");
  expect(deriveComfyNodeId("Render Box 01", ["render-box-01"])).toBe("render-box-01-2");
  expect(deriveComfyNodeId("Render Box 01", ["render-box-01", "render-box-01-2"])).toBe("render-box-01-3");
  expect(deriveComfyNodeId("本机", [])).toMatch(/^comfy-[a-z0-9]+$/);
  expect(deriveComfyNodeId("-_.", [])).toMatch(/^comfy-[a-z0-9]+$/);
  for (const id of [
    deriveComfyNodeId("Render Box 01", []),
    deriveComfyNodeId("本机", []),
    deriveComfyNodeId("a", []),
  ]) {
    expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{1,79}$/i);
  }
});

it("recognizes only node-availability failures as node-pool problems", () => {
  expect(isComfyNodeAvailabilityError("没有在线的 ComfyUI 执行节点")).toBe(true);
  expect(isComfyNodeAvailabilityError("指定的 ComfyUI 节点不可用：render-box")).toBe(true);
  expect(isComfyNodeAvailabilityError("No selected ComfyUI node is currently reachable")).toBe(true);
  expect(isComfyNodeAvailabilityError("Unknown ComfyUI node render-box")).toBe(true);
  expect(isComfyNodeAvailabilityError("没有可用的 image ComfyUI 工作流")).toBe(false);
  expect(isComfyNodeAvailabilityError("生成任务 failed")).toBe(false);
  expect(isComfyNodeAvailabilityError(null)).toBe(false);
});
