import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { resetViewportChromeSuppression } from "../../../../src/comprehensive/editor/canvas/viewportChromeSuppression";
import { CaptureReconstructionDialog } from "../../../../src/comprehensive/editor/reconstruction/CaptureReconstructionDialog";

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  submit: vi.fn(),
  getJob: vi.fn(),
  fetchPlan: vi.fn(),
  fetchArtifact: vi.fn(),
  uploadModel: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/editor/reconstruction/captureReconstructionClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/comprehensive/editor/reconstruction/captureReconstructionClient")>();
  return {
    ...original,
    stageCaptureSource: mocks.stage,
    submitCaptureReconstruction: mocks.submit,
    getCaptureReconstructionJob: mocks.getJob,
    fetchCaptureReconstructionPlan: mocks.fetchPlan,
    fetchCaptureArtifactBlob: mocks.fetchArtifact,
  };
});
vi.mock("../../../../src/comprehensive/editor/api/blenderLiveClient", () => ({ uploadBlenderModelAsset: mocks.uploadModel }));

const sha256 = "a".repeat(64);

function jobRecord(status: "queued" | "running" | "succeeded", progress: number) {
  return {
    contractVersion: 1,
    id: "job-ui-1",
    kind: "scene.reconstruct",
    status,
    progress,
    inputFingerprint: "fp",
    idempotencyKey: `capture-ui:${sha256}`,
    input: {
      sourceMediaId: `media-input:sha256:${sha256}`,
      sourceKind: "rgbd-bundle",
      fileName: "room.zip",
      maxKeyViews: 6,
      maxObjects: 24,
      gridResolution: 192,
      prompt: "",
    },
    attempts: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    message: status === "succeeded" ? "done" : "重建进行中",
    artifacts: [],
  };
}

const doorTransform = {
  position: [1.2, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [0.9, 2.05, 0.05] as [number, number, number],
};

const plan = {
  version: 1,
  id: "capture-plan-ui",
  jobId: "job-ui-1",
  createdAt: "2026-08-14T00:00:00.000Z",
  status: "draft" as const,
  source: { kind: "rgbd-bundle" as const, fileName: "room.zip", sha256 },
  analysis: {
    status: "ready" as const,
    providers: { poses: "bundle" as const, depth: "sensor" as const, semantics: "heuristic" as const },
    warnings: ["墙体提取假设主导曼哈顿方向；斜墙会被近似。"],
    metrics: { frameCount: 16, keyViewCount: 1, floorAreaM2: 21.6, wallCount: 4, objectCount: 1, depthCoverage: 0.87 },
    prompt: "",
  },
  objects: [
    {
      id: "capture-floor",
      enabled: true,
      name: "地板",
      role: "floor" as const,
      geometryType: "box" as const,
      transform: { position: [3, -0.1, 1.8], rotation: [0, 0, 0], scale: [6, 0.1, 3.6] },
      material: {
        baseColor: "#b8b0a4",
        metalness: 0,
        roughness: 0.85,
        emissiveColor: "#000000",
        emissiveIntensity: 0,
        opacity: 1,
      },
      confidence: 0.8,
      rationale: "重建地面。",
    },
    {
      id: "capture-door-01",
      enabled: true,
      name: "门 1",
      role: "door" as const,
      geometryType: "box" as const,
      transform: doorTransform,
      material: {
        baseColor: "#7a5c3e",
        metalness: 0,
        roughness: 0.7,
        emissiveColor: "#000000",
        emissiveIntensity: 0,
        opacity: 1,
      },
      interaction: {
        prompt: "开门 / 关门",
        radiusM: 2,
        closedTransform: doorTransform,
        openTransform: { ...doorTransform, rotation: [0, Math.PI / 2, 0] as [number, number, number] },
      },
      confidence: 0.7,
      rationale: "门洞。",
    },
  ],
  cameras: [
    {
      id: "capture-view-camera-01",
      viewId: "view-01",
      name: "采集视角 1",
      position: [3, 1.5, 3.2] as [number, number, number],
      target: [2.5, 0.8, 1.2] as [number, number, number],
      fovYDeg: 58,
      width: 640,
      height: 480,
      keyframeArtifactId: "attempt-keyview-view-01",
    },
  ],
  shell: null,
};

beforeEach(() => {
  window.localStorage.clear();
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...createInitialDirectorState() });
  resetViewportChromeSuppression();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:keyframe"), revokeObjectURL: vi.fn() }));
  mocks.stage.mockReset().mockResolvedValue({ sourceMediaId: `media-input:sha256:${sha256}`, sha256, bytes: 3 });
  mocks.submit.mockReset().mockResolvedValue(jobRecord("running", 0.2));
  mocks.getJob.mockReset().mockResolvedValue(jobRecord("succeeded", 1));
  mocks.fetchPlan.mockReset().mockResolvedValue(plan);
  mocks.fetchArtifact.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  mocks.uploadModel.mockReset();
});

it("stages the capture, polls the job, previews the plan, and applies it to the stage", async () => {
  const user = userEvent.setup();
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<CaptureReconstructionDialog onApplied={onApplied} onClose={onClose} />);

  await user.upload(screen.getByLabelText("选择采集文件"), new File(["zip"], "room.zip", { type: "application/zip" }));
  expect(await screen.findByText(/RGB-D 扫描包（度量重建）/)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "开始重建" }));
  await waitFor(() => expect(mocks.fetchPlan).toHaveBeenCalledWith("job-ui-1", expect.anything()), {
    timeout: 8_000,
  });

  expect(await screen.findByText(/度量重建：21\.6㎡ · 4 面墙 · 1 个物体/)).toBeInTheDocument();
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.objectContaining({ sourceKind: "rgbd-bundle", fileName: "room.zip" }),
    `capture-ui:${sha256}`,
    expect.anything(),
  );

  await user.click(screen.getByRole("button", { name: "应用到片场" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalled());
  expect(onApplied.mock.calls[0]![0]).toContain("1 扇可开合的门");
  expect(onClose).toHaveBeenCalled();

  const project = useDirectorStore.getState().project;
  expect(project.objects.some((object) => object.id === "capture-door-01")).toBe(true);
  expect(project.cameras.some((camera) => camera.id === "capture-view-camera-01")).toBe(true);
}, 15_000);

it("surfaces reconstruction failures without touching the stage", async () => {
  const user = userEvent.setup();
  mocks.getJob.mockResolvedValue({ ...jobRecord("succeeded", 1), status: "failed", error: "深度缺失" });
  render(<CaptureReconstructionDialog onClose={vi.fn()} />);

  await user.upload(screen.getByLabelText("选择采集文件"), new File(["zip"], "room.zip", { type: "application/zip" }));
  await user.click(screen.getByRole("button", { name: "开始重建" }));

  expect(await screen.findByRole("alert", undefined, { timeout: 8_000 })).toHaveTextContent("深度缺失");
  expect(useDirectorStore.getState().project.objects.some((object) => object.id === "capture-floor")).toBe(false);
}, 15_000);
