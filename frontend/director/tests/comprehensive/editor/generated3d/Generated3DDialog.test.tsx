import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { Generated3DJob } from "../../../../src/comprehensive/editor/generated3d/generated3dClient";

const mocks = vi.hoisted(() => ({
  listProviders: vi.fn(),
  listJobs: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  reconcile: vi.fn(),
  promote: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/generated3d/generated3dClient", () => ({
  listGenerated3DProviders: mocks.listProviders,
  listGenerated3DJobs: mocks.listJobs,
  submitGenerated3DJob: mocks.submit,
  cancelGenerated3DJob: mocks.cancel,
  retryGenerated3DJob: mocks.retry,
  reconcileGenerated3DJob: mocks.reconcile,
}));
vi.mock("../../../../src/comprehensive/editor/generated3d/generated3dPromotion", () => ({ promoteGenerated3DJob: mocks.promote }));
vi.mock("../../../../src/comprehensive/editor/reconstruction/referenceImageAnalysis", () => ({ prepareDirectorReferenceImage: mocks.prepare }));

import { Generated3DDialog } from "../../../../src/comprehensive/editor/generated3d/Generated3DDialog";

function generatedJob(status: Generated3DJob["status"], id = `job-${status}`) {
  return {
    id,
    kind: "model.generate",
    status,
    progress: status === "succeeded" ? 1 : 0,
    input: {
      mode: "text-to-3d",
      providerId: "meshy",
      name: status === "succeeded" ? "Hero prop" : "New prop",
      prompt: "A detailed prop",
    },
    artifacts: status === "succeeded" ? [{ id: "receipt", role: "metadata" }] : [],
    attempts: [],
    message: status === "succeeded" ? "Normalized" : "Queued",
  } as unknown as Generated3DJob;
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.listProviders.mockResolvedValue({
    defaultProvider: "meshy",
    providers: [
      {
        id: "meshy",
        label: "Meshy",
        configured: true,
        modes: ["text-to-3d", "image-to-3d"],
        modelVersion: "meshy-6",
        cancellation: "remote",
        documentationUrl: "https://docs.meshy.ai/en/api",
      },
      {
        id: "tripo",
        label: "Tripo",
        configured: false,
        modes: ["text-to-3d", "image-to-3d"],
        modelVersion: null,
        cancellation: "local-only",
        documentationUrl: "https://platform.tripo3d.ai/docs",
      },
    ],
  });
  mocks.listJobs.mockResolvedValue([generatedJob("succeeded")]);
  mocks.submit.mockResolvedValue(generatedJob("queued"));
  mocks.promote.mockResolvedValue({ assetId: "generated3d:job-succeeded" });
  mocks.prepare.mockResolvedValue({
    fileName: "reference.director-reference.jpg",
    mimeType: "image/jpeg",
    base64: "/9j/2Q==",
    sha256: "a".repeat(64),
    dataUrl: "data:image/jpeg;base64,/9j/2Q==",
    byteLength: 4,
    metrics: { width: 1024, height: 768 },
  });
});

it("submits provider-backed work and promotes a completed model", async () => {
  const user = userEvent.setup();
  const onPromoted = vi.fn();
  render(<Generated3DDialog onClose={vi.fn()} onPromoted={onPromoted} />);

  expect(await screen.findByText("Hero prop")).toBeInTheDocument();
  expect(screen.getByText("已配置")).toBeInTheDocument();
  const name = screen.getByLabelText("生成 3D 资产名称");
  await user.clear(name);
  await user.type(name, "Stone arch");
  await user.type(screen.getByLabelText("3D 生成提示词"), "A weathered stone arch with clean topology");
  await user.click(screen.getByRole("button", { name: "开始生成" }));

  await waitFor(() =>
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "text-to-3d",
        providerId: "meshy",
        name: "Stone arch",
        prompt: "A weathered stone arch with clean topology",
        texture: true,
        pbr: true,
      }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "加入片场与画廊" }));
  await waitFor(() => expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({ id: "job-succeeded" })));
  expect(onPromoted).toHaveBeenCalledWith(expect.stringContaining("Hero prop 已加入片场和画廊"));
});

it("moves focus into the dialog on open and closes once on Escape", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Generated3DDialog onClose={onClose} />);
  await screen.findByText("Hero prop");

  // 打开时焦点进入对话框内第一个可聚焦控件（头部关闭按钮）。
  expect(screen.getByRole("button", { name: "关闭 AI 生成 3D 模型" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("prepares a bounded source image before image-to-3D submission", async () => {
  const user = userEvent.setup();
  render(<Generated3DDialog onClose={vi.fn()} />);
  await screen.findByText("Hero prop");
  await user.click(screen.getByRole("button", { name: "图生 3D" }));
  await user.upload(
    screen.getByLabelText("选择图生 3D 参考图"),
    new File(["image"], "reference.png", { type: "image/png" }),
  );
  expect(await screen.findByAltText("图生 3D 参考图预览")).toHaveAttribute("src", "data:image/jpeg;base64,/9j/2Q==");
  expect(mocks.prepare).toHaveBeenCalledWith(expect.any(File));
});
