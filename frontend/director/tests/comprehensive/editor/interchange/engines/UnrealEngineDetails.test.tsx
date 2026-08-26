import { render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import type { DirectorDccEngineSendResult } from "../../../../../src/dcc/directorDccEngineContract";
import { LanguageProvider } from "../../../../../src/comprehensive/i18n/language";
import { UnrealEngineDetails } from "../../../../../src/comprehensive/editor/interchange/engines/UnrealEngineDetails";

const hash = "a".repeat(64);
const revision = `director-project-revision:v1:sha256:${hash}` as const;

function unrealSendResult(overrides: Partial<DirectorDccEngineSendResult> = {}): DirectorDccEngineSendResult {
  return {
    contract: "director-dcc-engine-send-v1",
    jobId: "550e8400-e29b-41d4-a716-446655440002",
    provider: "unreal",
    packagePath: "/data/dcc-jobs/unreal/job",
    manifestPath: "/data/dcc-jobs/unreal/job/manifest.json",
    manifestSha256: hash,
    packageDigest: hash,
    sourceRevision: revision,
    reportPath: "/data/dcc-jobs/unreal/job/report.json",
    report: {
      ok: true,
      contract: "director-dcc-engine-report-v1",
      provider: "unreal",
      hostVersion: "Unreal Engine 5.6.1",
      connectorVersion: "0.4.0",
      packageId: "director-dcc:abc:0",
      sourceRevision: revision,
      importedObjectCount: 3,
      importedCameraCount: 1,
      scenePath: "/Game/Director/Levels/Director_abc",
      returnPackageDir: "return-package",
      warnings: [],
      sequencer: {
        sequencePath: "/Game/Director/Sequences/abc/DirectorShots",
        displayRate: "24/1",
        tickResolution: "24000/1",
        dropFrame: false,
        startTimecode: "01:00:00:00",
        startFrameOffset: 86_400,
        playbackStart: 86_400,
        playbackEnd: 86_424,
        cameraCutCount: 2,
        transformTrackCount: 3,
        focalLengthTrackCount: 1,
        bakedKeyCount: 225,
      },
      importedSkeletalMeshCount: 1,
      appliedMaterialCount: 3,
      appliedTextureCount: 2,
      importedLightCount: 2,
      omittedLights: [
        {
          directorId: "light_ambient_1",
          lightType: "ambient",
          reason: "Uniform ambient light has no single-actor Unreal equivalent (warn-and-omit).",
        },
      ],
    },
    returnPackagePath: "/data/dcc-jobs/unreal/job/return-package",
    omittedAnimationChannels: [
      {
        directorId: "walker-1",
        entityType: "object",
        channels: ["pose_values", "character_rig"],
        details: [
          {
            channel: "pose_values",
            controls: ["arm.L", "arm.R"],
            reason: "Semantic pose keyframes are not carried by the Sequencer bake; Control Rig transfer is planned.",
          },
        ],
      },
    ],
    cleanFrame: {
      contract: "director-unreal-clean-frame-v1",
      provider: "unreal",
      status: "rendered",
      packageId: "director-dcc:abc:0",
      sourceRevision: revision,
      levelPath: "/Game/Director/Levels/Director_abc",
      cameraDirectorId: "cam-1",
      frame: 12,
      width: 1920,
      height: 1080,
      imagePath: "clean-frame.png",
      imageSha256: hash,
      method: "offscreen_high_res_screenshot",
      hostVersion: "Unreal Engine 5.6.1",
      warnings: [],
    },
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => window.localStorage.clear());

function renderDetails(result: DirectorDccEngineSendResult) {
  render(
    <LanguageProvider>
      <UnrealEngineDetails result={result} />
    </LanguageProvider>,
  );
}

it("shows the Sequencer receipt, clean frame, host counts, and structured omits", () => {
  renderDetails(unrealSendResult());

  const details = screen.getByTestId("unreal-engine-details");
  expect(within(details).getByText("/Game/Director/Sequences/abc/DirectorShots")).toBeInTheDocument();
  expect(within(details).getByText("24/1 · 01:00:00:00")).toBeInTheDocument();

  const counts = within(screen.getByTestId("unreal-host-counts"));
  expect(counts.getByText("骨骼网格体").nextElementSibling).toHaveTextContent("1");
  expect(counts.getByText("材质实例").nextElementSibling).toHaveTextContent("3");
  expect(counts.getByText("纹理参数绑定").nextElementSibling).toHaveTextContent("2");
  expect(counts.getByText("引擎灯光").nextElementSibling).toHaveTextContent("2");

  const cleanFrame = within(screen.getByTestId("unreal-clean-frame"));
  expect(cleanFrame.getByText("已渲染")).toBeInTheDocument();
  expect(cleanFrame.getByText(/1920×1080/)).toBeInTheDocument();

  const omittedLights = within(screen.getByTestId("unreal-omitted-lights"));
  expect(omittedLights.getByText("light_ambient_1")).toBeInTheDocument();
  expect(omittedLights.getByText(/no single-actor Unreal equivalent/)).toBeInTheDocument();

  const omittedChannels = within(screen.getByTestId("unreal-omitted-channels"));
  expect(omittedChannels.getByText("walker-1")).toBeInTheDocument();
  expect(omittedChannels.getByText("(pose_values, character_rig)")).toBeInTheDocument();
  // The detail record lists the exact omitted control names.
  expect(omittedChannels.getByText("pose_values: arm.L, arm.R")).toBeInTheDocument();
  // Honesty guard: the panel says Control Rig transfer is still planned.
  expect(omittedChannels.getByText(/Control Rig 无损往返仍在规划中/)).toBeInTheDocument();
});

it("shows the skipped clean-frame reason and the static-import note without inventing receipts", () => {
  const result = unrealSendResult({
    omittedAnimationChannels: undefined,
    cleanFrame: {
      contract: "director-unreal-clean-frame-v1",
      provider: "unreal",
      status: "skipped",
      skipReason: "No RHI is available.",
      warnings: [],
    },
  });
  result.report.sequencer = undefined;
  result.report.omittedLights = undefined;
  renderDetails(result);

  expect(screen.getByText("未提供 Sequencer 回执（静态导入）。")).toBeInTheDocument();
  const cleanFrame = within(screen.getByTestId("unreal-clean-frame"));
  expect(cleanFrame.getByText("已跳过")).toBeInTheDocument();
  expect(cleanFrame.getByText(/No RHI is available/)).toBeInTheDocument();
  expect(screen.queryByTestId("unreal-omitted-lights")).not.toBeInTheDocument();
  expect(screen.queryByTestId("unreal-omitted-channels")).not.toBeInTheDocument();
});

it("renders nothing for non-Unreal providers so the shared browser stays engine-agnostic", () => {
  const result = unrealSendResult();
  renderDetails({ ...result, provider: "godot", report: { ...result.report, provider: "godot" } });
  expect(screen.queryByTestId("unreal-engine-details")).not.toBeInTheDocument();
});
