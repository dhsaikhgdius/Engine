import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { resetViewportChromeSuppression, useViewportChromeSuppressionStore } from "../../../../src/comprehensive/editor/canvas/viewportChromeSuppression";
import { ReferenceSceneReconstructionDialog } from "../../../../src/comprehensive/editor/reconstruction/ReferenceSceneReconstructionDialog";

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  prepare: vi.fn(),
  profiles: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/assistant/agentProfilesClient", () => ({ listAgentProfiles: mocks.profiles }));
vi.mock("../../../../src/comprehensive/editor/reconstruction/referenceImageAnalysis", () => ({ prepareDirectorReferenceImage: mocks.prepare }));
vi.mock("../../../../src/comprehensive/editor/reconstruction/referenceSceneReconstruction", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/comprehensive/editor/reconstruction/referenceSceneReconstruction")>();
  return { ...original, requestReferenceSceneAnalysis: mocks.analyze };
});

const prepared = {
  fileName: "podium.director-reference.jpg",
  mimeType: "image/jpeg" as const,
  base64: "/9j/4AAAAAAAAAAAAAD/2Q==",
  sha256: "a".repeat(64),
  dataUrl: "data:image/jpeg;base64,/9j/4AAAAAAAAAAAAAD/2Q==",
  byteLength: 16,
  metrics: {
    width: 1280,
    height: 720,
    palette: ["#15202b", "#d8af77"],
    meanLuminance: 0.4,
    edgeDensity: 0.2,
    foregroundCoverage: 0.5,
  },
};

beforeEach(() => {
  window.localStorage.clear();
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
  mocks.prepare.mockReset().mockResolvedValue(prepared);
  mocks.profiles.mockReset().mockResolvedValue([
    {
      id: "vision-primary",
      label: "Vision primary",
      runtime: "native-openai",
      model: "vision-model",
      endpointHost: "api.example.test",
      credentialConfigured: true,
      available: true,
      capabilities: {
        streaming: false,
        tools: true,
        parallelToolCalls: false,
        vision: true,
        jsonSchema: true,
        maxContextTokens: null,
        maxOutputTokens: null,
      },
    },
  ]);
  mocks.analyze.mockReset().mockImplementation(async (request) => ({
    version: 1,
    id: "reference-plan-ui",
    status: "draft",
    createdAt: "2026-08-07T00:00:00.000Z",
    expectedProjectRevision: request.projectRevision,
    prompt: request.prompt,
    applyMode: request.applyMode,
    source: {
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      sha256: prepared.sha256,
      metrics: prepared.metrics,
    },
    analysis: {
      status: "ready",
      mode: "vision",
      profileId: "vision-primary",
      model: "vision-model",
      summary: "A warm podium in a dark studio.",
      confidence: 0.82,
      warnings: ["Rear geometry is inferred."],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
    backgroundColor: "#15202b",
    objects: [
      {
        id: "reference-object-ui-01",
        enabled: true,
        name: "Podium",
        geometryType: "cylinder",
        transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1.8, 1, 1.8] },
        placementMode: "grounded",
        material: {
          baseColor: "#d8af77",
          metalness: 0.1,
          roughness: 0.6,
          emissiveColor: "#000000",
          emissiveIntensity: 0,
          opacity: 1,
        },
        confidence: 0.86,
        rationale: "Central cylindrical silhouette.",
      },
    ],
    lights: [],
  }));
  resetViewportChromeSuppression();
});

it("prepares, previews, edits, and atomically applies a reference reconstruction", async () => {
  const user = userEvent.setup();
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<ReferenceSceneReconstructionDialog onApplied={onApplied} onClose={onClose} />);

  await user.upload(screen.getByLabelText("选择参考图片"), new File(["image"], "podium.jpg", { type: "image/jpeg" }));
  expect(await screen.findByAltText("参考图预览")).toHaveAttribute("src", prepared.dataUrl);
  await user.type(screen.getByLabelText("参考图重建说明"), "只重建产品台");
  await user.click(screen.getByRole("button", { name: "生成重建计划" }));

  expect(await screen.findByText("A warm podium in a dark studio.")).toBeInTheDocument();
  expect(mocks.analyze).toHaveBeenCalledWith(
    expect.objectContaining({ profileId: "vision-primary", prompt: "只重建产品台" }),
    expect.any(AbortSignal),
  );
  const name = screen.getByLabelText("Podium 名称");
  await user.clear(name);
  await user.type(name, "Hero podium");
  const positionX = screen.getByLabelText("位置 X");
  await user.clear(positionX);
  await user.type(positionX, "2");
  await user.click(screen.getByRole("button", { name: "应用到片场" }));

  expect(onClose).toHaveBeenCalledOnce();
  expect(onApplied).toHaveBeenCalledWith(expect.stringContaining("1 个物体"));
  expect(
    useDirectorStore.getState().project.objects.find((object) => object.id === "reference-object-ui-01"),
  ).toMatchObject({
    name: "Hero podium",
    transform: { position: [2, 0.5, 0] },
    referenceBindings: [{ kind: "image", ref: "reference-image-aaaaaaaaaaaaaaaaaaaa" }],
  });
  expect(useDirectorStore.getState().project.referenceReconstructions?.[0]?.status).toBe("applied");

  act(() => useDirectorStore.getState().undo());
  expect(useDirectorStore.getState().project.objects.some((object) => object.id === "reference-object-ui-01")).toBe(
    false,
  );
});

it("blocks a stale plan after the live Stage changes", async () => {
  const user = userEvent.setup();
  render(<ReferenceSceneReconstructionDialog onClose={vi.fn()} />);
  await user.upload(screen.getByLabelText("选择参考图片"), new File(["image"], "podium.jpg", { type: "image/jpeg" }));
  await user.click(await screen.findByRole("button", { name: "生成重建计划" }));
  await screen.findByText("A warm podium in a dark studio.");

  act(() => useDirectorStore.getState().updateScene({ backgroundColor: "#ffffff" }));
  await waitFor(() => expect(screen.getByText(/片场在分析后已变化/)).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "应用到片场" })).toBeDisabled();
});

it("moves focus into the dialog on open and closes once on Escape", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<ReferenceSceneReconstructionDialog onClose={onClose} />);
  await screen.findByText("Vision primary · vision-model");

  expect(screen.getByRole("button", { name: "关闭参考图重建" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("suppresses viewport chrome while the dialog is mounted", () => {
  const { unmount } = render(<ReferenceSceneReconstructionDialog onClose={vi.fn()} />);

  expect(useViewportChromeSuppressionStore.getState().suppressions.has("reference-scene-reconstruction")).toBe(true);

  unmount();

  expect(useViewportChromeSuppressionStore.getState().suppressions.size).toBe(0);
});
