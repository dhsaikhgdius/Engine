import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DirectorDccEngineHealth,
  DirectorDccEngineSendResult,
} from "../../../../../src/dcc/directorDccEngineContract";
import type { DirectorDccEngineId } from "../../../../../src/dcc/directorDccEngineSpace";
import type {
  DirectorDccProviderCatalog,
  DirectorDccProviderStatus,
} from "../../../../../src/dcc/directorDccProviderContract";
import { LanguageProvider } from "../../../../../src/comprehensive/i18n/language";

const providerClient = vi.hoisted(() => ({ discover: vi.fn(), sendToEngine: vi.fn() }));
const handoffClient = vi.hoisted(() => ({
  health: vi.fn(),
  listUnitySessions: vi.fn(),
  createUnitySession: vi.fn(),
  closeUnitySession: vi.fn(),
  godotPreview: vi.fn(),
}));
const returnClient = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));

vi.mock("../../../../../src/comprehensive/editor/api/dccProviderClient", () => {
  class DirectorDccProviderClientError extends Error {
    diagnostics?: { recovery: string[] };
  }
  return {
    discoverDirectorDccProviders: providerClient.discover,
    sendDirectorProjectToEngine: providerClient.sendToEngine,
    DirectorDccProviderClientError,
  };
});
vi.mock("../../../../../src/comprehensive/editor/api/dccEngineHandoffClient", () => ({
  fetchDirectorDccEngineHealth: handoffClient.health,
  listDirectorUnityLiveLinkSessions: handoffClient.listUnitySessions,
  createDirectorUnityLiveLinkSession: handoffClient.createUnitySession,
  closeDirectorUnityLiveLinkSession: handoffClient.closeUnitySession,
  fetchDirectorGodotLiveLinkPreview: handoffClient.godotPreview,
}));
vi.mock("../../../../../src/comprehensive/editor/api/dccReturnClient", () => {
  class DirectorDccReturnClientError extends Error {
    status: number;
    code?: string;
    recovery?: string;
    constructor(message: string, status = 409, code?: string, recovery?: string) {
      super(message);
      this.name = "DirectorDccReturnClientError";
      this.status = status;
      this.code = code;
      this.recovery = recovery;
    }
  }
  return {
    previewDirectorDccReturnPackage: returnClient.preview,
    applyDirectorDccImportPlan: returnClient.apply,
    DirectorDccReturnClientError,
  };
});
vi.mock("../../../../../src/comprehensive/editor/interchange/BlenderLivePanel", () => ({
  BlenderLivePanel: () => <div data-testid="blender-live-panel" />,
}));

import { EngineHandoffDock } from "../../../../../src/comprehensive/editor/interchange/engines/EngineHandoffDock";

const hash = "a".repeat(64);
const revision = `director-project-revision:v1:sha256:${hash}`;

function engineStatus(id: DirectorDccEngineId, nativeReady: boolean): DirectorDccProviderStatus {
  return {
    provider: {
      id,
      label: id === "unreal" ? "Unreal Engine" : id === "unity" ? "Unity" : "Godot",
      category: "engine",
      integration: "engine-headless",
      preferredFormat: id === "unreal" ? "usda" : "glb",
      exchangeFormats: id === "unreal" ? ["usda", "glb"] : id === "unity" ? ["glb", "usda"] : ["glb"],
      capabilities: [
        {
          id: "scene",
          level: "exchange",
          layer: "exchange-format",
          formats: id === "godot" ? ["glb"] : ["usda", "glb"],
        },
        { id: "animation", level: "native", layer: "connector" },
        { id: "roundtrip", level: "planned", layer: "connector" },
        { id: "live_link", level: "native", layer: "connector" },
      ],
      connectorDirectory: `integrations/${id}`,
    },
    installed: nativeReady,
    executable: nativeReady ? `/opt/${id}` : null,
    version: nativeReady ? "1.0" : null,
    nativeReady,
    exchangeReady: true,
    reason: null,
  };
}

function blenderStatus(): DirectorDccProviderStatus {
  return {
    provider: {
      id: "blender",
      label: "Blender",
      category: "dcc",
      integration: "native-roundtrip",
      preferredFormat: "blend",
      exchangeFormats: ["blend", "usda", "glb"],
      capabilities: [{ id: "scene", level: "native", layer: "connector" }],
      connectorDirectory: "integrations/blender",
    },
    installed: true,
    executable: "/opt/blender",
    version: "4.2",
    nativeReady: true,
    exchangeReady: true,
    reason: null,
  };
}

function catalog(overrides: Partial<Record<DirectorDccEngineId, boolean>> = {}): DirectorDccProviderCatalog {
  return {
    contract: "director-dcc-provider-catalog-v1",
    providers: [
      blenderStatus(),
      engineStatus("unreal", overrides.unreal ?? true),
      engineStatus("unity", overrides.unity ?? true),
      engineStatus("godot", overrides.godot ?? true),
    ],
  };
}

function health(
  provider: DirectorDccEngineId,
  overrides: Partial<DirectorDccEngineHealth> = {},
): DirectorDccEngineHealth {
  return {
    contract: "director-dcc-engine-health-v1",
    provider,
    ready: true,
    executable: `/opt/${provider}`,
    hostVersion: "5.4.1",
    connectorVersion: "0.3.0",
    connectorDirectory: `integrations/${provider}`,
    projectPath: `/projects/${provider}-game`,
    checks: [],
    warnings: [],
    recovery: [],
    ...overrides,
  };
}

function sendResult(
  provider: DirectorDccEngineId,
  overrides: Record<string, unknown> = {},
): DirectorDccEngineSendResult {
  return {
    contract: "director-dcc-engine-send-v1",
    jobId: "550e8400-e29b-41d4-a716-446655440001",
    provider,
    packagePath: `/jobs/${provider}/package`,
    manifestPath: `/jobs/${provider}/package/manifest.json`,
    manifestSha256: hash,
    packageDigest: hash,
    sourceRevision: revision,
    reportPath: `/jobs/${provider}/report.json`,
    report: {
      ok: true,
      contract: "director-dcc-engine-report-v1",
      provider,
      hostVersion: "host 1.0",
      connectorVersion: "0.3.0",
      packageId: "director-dcc:abc:0",
      sourceRevision: revision,
      importedObjectCount: 3,
      importedCameraCount: 1,
      scenePath: `/scenes/${provider}`,
      returnPackageDir: "return",
      warnings: [],
    },
    returnPackagePath: `/jobs/${provider}/return`,
    warnings: [],
    ...overrides,
  } as DirectorDccEngineSendResult;
}

beforeEach(() => {
  window.localStorage.clear();
  providerClient.discover.mockResolvedValue(catalog());
  handoffClient.health.mockImplementation((provider: DirectorDccEngineId) => Promise.resolve(health(provider)));
  handoffClient.listUnitySessions.mockResolvedValue([]);
  handoffClient.godotPreview.mockResolvedValue({
    contract: "director-godot-live-link-preview-v1",
    provider: "godot",
    authoritative: false,
    sessions: [],
  });
});

afterEach(() => vi.clearAllMocks());

function renderDock(onEngineSendCompleted = vi.fn()) {
  render(
    <LanguageProvider>
      <EngineHandoffDock onEngineSendCompleted={onEngineSendCompleted} />
    </LanguageProvider>,
  );
  return onEngineSendCompleted;
}

async function openTab(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name }));
  return user;
}

it("mounts the Blender tab with the existing live panel and honest catalog chips", async () => {
  renderDock();

  expect(await screen.findByTestId("blender-live-panel")).toBeInTheDocument();
  const panel = screen.getByRole("tabpanel");
  expect(within(panel).getByText("已检测安装")).toBeInTheDocument();
  expect(within(panel).getByText("原生连接就绪")).toBeInTheDocument();
  // The Blender kernel controls are not duplicated: no engine send/receive here.
  expect(within(panel).queryByRole("button", { name: /无头发送到引擎/ })).not.toBeInTheDocument();
});

it("renders capability chips with their honest native/exchange/planned levels", async () => {
  renderDock();
  await openTab("Unreal");

  const capabilities = await screen.findByRole("list", { name: "Unreal Engine 能力" });
  const chips = within(capabilities).getAllByRole("listitem");
  const byCapability = new Map(chips.map((chip) => [chip.getAttribute("data-capability"), chip]));
  expect(byCapability.get("scene")).toHaveTextContent("交换");
  expect(byCapability.get("animation")).toHaveTextContent("原生");
  expect(byCapability.get("roundtrip")).toHaveTextContent("计划");
  expect(byCapability.get("live_link")).toHaveTextContent("原生");
});

it("disables the headless send when the connector is not nativeReady and shows recovery steps", async () => {
  providerClient.discover.mockResolvedValue(catalog({ godot: false }));
  handoffClient.health.mockResolvedValue(
    health("godot", {
      ready: false,
      warnings: ["Godot executable was not detected."],
      recovery: ["Install Godot 4 and expose it on PATH."],
    }),
  );
  renderDock();
  await openTab("Godot");

  const send = await screen.findByRole("button", { name: /通过原生连接器发送到 Godot/ });
  expect(send).toBeDisabled();
  expect(send).toHaveAttribute("title", "Install Godot 4 and expose it on PATH.");
  expect(screen.getByText("原生连接未就绪")).toBeInTheDocument();
  const warningList = screen.getByRole("list", { name: "连接器警告" });
  expect(within(warningList).getByText("Godot executable was not detected.")).toBeInTheDocument();
  const recoveryList = screen.getByRole("list", { name: "恢复步骤" });
  expect(within(recoveryList).getByText("Install Godot 4 and expose it on PATH.")).toBeInTheDocument();
  expect(providerClient.sendToEngine).not.toHaveBeenCalled();
});

it("sends clean_frame for Unreal and renders the skipped receipt with its reason", async () => {
  providerClient.sendToEngine.mockResolvedValue(
    sendResult("unreal", {
      report: {
        ...sendResult("unreal").report,
        sequencer: {
          sequencePath: "/Game/Director/Sequences/DirectorSequence",
          displayRate: "24000/1001",
          tickResolution: "24000/1",
          dropFrame: true,
          startTimecode: "01:00:00;00",
          startFrameOffset: 86_400,
          playbackStart: 0,
          playbackEnd: 240,
          cameraCutCount: 3,
          transformTrackCount: 5,
          focalLengthTrackCount: 2,
          bakedKeyCount: 1_200,
        },
        appliedMaterialCount: 2,
        omittedMaterialCount: 1,
        omittedMaterials: [
          {
            directorId: "prop-glass",
            code: "unsupported_channels",
            reason:
              "Object prop-glass: Director material channels transmission have no faithful Director parent mapping; omitted (warn-and-omit code: unsupported_channels).",
          },
        ],
      },
      cleanFrame: {
        contract: "director-unreal-clean-frame-v1",
        provider: "unreal",
        status: "skipped",
        skipReason: "No Director-tagged camera exists in the imported level.",
        warnings: [],
      },
      omittedAnimationChannels: [
        { directorId: "obj-hero", entityType: "object", channels: ["pose_values", "motion_blocks"] },
      ],
    }),
  );
  renderDock();
  const user = await openTab("Unreal");

  await user.click(await screen.findByRole("checkbox", { name: /同时渲染一张洁净帧/ }));
  await user.click(screen.getByRole("button", { name: /通过原生连接器发送到 Unreal Engine/ }));

  expect(providerClient.sendToEngine).toHaveBeenCalledWith({ provider: "unreal", cleanFrame: true });
  const receipt = await screen.findByLabelText("洁净帧回执");
  expect(receipt).toHaveAttribute("data-status", "skipped");
  expect(receipt).toHaveTextContent("No Director-tagged camera exists in the imported level.");
  // Sequencer receipt summary: timebase and track counts.
  const sequencer = screen.getByLabelText("Sequencer 回执");
  expect(sequencer).toHaveTextContent("24000/1001 DF");
  expect(sequencer).toHaveTextContent("01:00:00;00");
  expect(sequencer).toHaveTextContent("3");
  expect(sequencer).toHaveTextContent("1200");
  expect(sequencer).toHaveTextContent("省略材质");
  expect(sequencer).toHaveTextContent("1");
  const omittedMaterials = screen.getByRole("list", { name: "结构化省略材质" });
  expect(within(omittedMaterials).getByText("prop-glass")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("不支持的材质通道");
  // Structured omitted channels stay visible instead of being flattened away.
  const omitted = screen.getByRole("list", { name: "省略的动画通道" });
  expect(within(omitted).getByText("obj-hero")).toBeInTheDocument();
  expect(omitted).toHaveTextContent("姿态控制");
  expect(omitted).toHaveTextContent("动作片段");
});

it("renders the Unity bake summary with structured omitted channels and never offers USD as the send payload", async () => {
  providerClient.sendToEngine.mockResolvedValue(
    sendResult("unity", {
      report: {
        ...sendResult("unity").report,
        unity: {
          timelinePath: "Assets/Director/DirectorTimeline.playable",
          renderPipeline: "urp",
          gltfImporterAvailable: true,
          importedLightCount: 2,
          bakedAnimationClipCount: 4,
          humanoidAvatarCount: 1,
          genericAvatarCount: 1,
          materialFallbackCount: 3,
          omittedMaterialCount: 1,
          omittedMaterials: [
            {
              directorId: "prop-hdrp",
              code: "pipeline_unsupported",
              renderPipeline: "hdrp",
              reason: "HDRP has no Director PBR fallback; omitted.",
            },
          ],
          mappedShotCount: 3,
          omittedShotCount: 1,
          omittedShots: [
            {
              shotId: "shot-orphan",
              code: "shot_no_camera_binding",
              cameraDirectorId: null,
              reason:
                "Shot shot-orphan has no camera binding; no ActivationTrack camera cut was created (warn-and-omit code: shot_no_camera_binding).",
            },
          ],
          posedCharacterCount: 2,
          omittedChannels: [
            { directorId: "char-alien", channel: "poseValues", reason: "Non-Mixamo rig: pose controls cannot map." },
            { directorId: "char-alien", channel: "motionBlocks", reason: "Clip GLBs are not part of the package." },
          ],
        },
      },
    }),
  );
  renderDock();
  const user = await openTab("Unity");

  // USD is never offered as the Unity production payload; there is no format picker.
  const panel = screen.getByRole("tabpanel");
  await within(panel).findByText(/以 GLB 发送（生产载荷）；Unity 侧 USD 仍为实验性，不作为发送格式提供/);
  expect(within(panel).queryByRole("combobox")).not.toBeInTheDocument();
  expect(within(panel).queryByRole("checkbox", { name: /USD/i })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /通过原生连接器发送到 Unity/ }));
  const facts = await screen.findByLabelText("Unity 回执");
  expect(facts).toHaveTextContent("Assets/Director/DirectorTimeline.playable");
  expect(facts).toHaveTextContent("URP");
  expect(facts).toHaveTextContent("省略材质");
  const factOf = (label: string) => within(facts).getByText(label).closest("div")!;
  expect(factOf("映射镜头")).toHaveTextContent("3");
  expect(factOf("省略镜头")).toHaveTextContent("1");
  const omittedMaterials = screen.getByRole("list", { name: "结构化省略材质" });
  expect(within(omittedMaterials).getByText("prop-hdrp")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("管线不支持材质回退");
  const omittedShots = screen.getByRole("list", { name: "结构化省略镜头" });
  expect(within(omittedShots).getByText("shot-orphan")).toBeInTheDocument();
  expect(omittedShots).toHaveTextContent("镜头缺少相机绑定");
  expect(omittedShots).toHaveTextContent("no ActivationTrack camera cut was created");
  const omitted = screen.getByRole("list", { name: "省略的动画通道" });
  expect(within(omitted).getAllByText("char-alien")).toHaveLength(2);
  expect(omitted).toHaveTextContent("Non-Mixamo rig: pose controls cannot map.");
  expect(omitted).toHaveTextContent("动作片段");
});

it("hides the Unity shot rows for pre-0.3.3 connector reports instead of fabricating zero counts", async () => {
  providerClient.sendToEngine.mockResolvedValue(
    sendResult("unity", {
      report: {
        ...sendResult("unity").report,
        unity: {
          timelinePath: "Assets/Director/DirectorTimeline.playable",
          renderPipeline: "urp",
          gltfImporterAvailable: true,
          importedLightCount: 0,
          bakedAnimationClipCount: 1,
          humanoidAvatarCount: 0,
          genericAvatarCount: 0,
          materialFallbackCount: 0,
        },
      },
    }),
  );
  renderDock();
  const user = await openTab("Unity");

  await user.click(screen.getByRole("button", { name: /通过原生连接器发送到 Unity/ }));
  const facts = await screen.findByLabelText("Unity 回执");
  expect(within(facts).queryByText("映射镜头")).not.toBeInTheDocument();
  expect(within(facts).queryByText("省略镜头")).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "结构化省略镜头" })).not.toBeInTheDocument();
});

it("shows the Godot AnimationPlayer/shot-cut receipt with WorldEnvironment ambient and structured light omits", async () => {
  providerClient.sendToEngine.mockResolvedValue(
    sendResult("godot", {
      report: {
        ...sendResult("godot").report,
        godot: {
          animationPlayerPath: "res://director/director_scene.tscn",
          animationLibrary: "director",
          displayRate: "24000/1001",
          bakedKeyCount: 640,
          transformTrackCount: 4,
          fovTrackCount: 1,
          shotCutTrackCount: 1,
          mappedShotCount: 5,
          omittedShotCount: 1,
          omittedShots: [
            {
              shotId: "shot-orphan",
              code: "shot_no_camera_binding",
              cameraDirectorId: null,
              reason:
                "Shot shot-orphan has no camera binding; no camera cut was keyed (warn-and-omit code: shot_no_camera_binding).",
            },
          ],
          payloadAnimationPlayerCount: 0,
          importedSkeletonCount: 1,
          importedLightCount: 2,
          worldEnvironmentAmbient: true,
          omittedLightCount: 2,
          omittedLights: [
            {
              directorId: "light-panel",
              code: "light_rect_area_unsupported",
              lightType: "rect-area",
              reason:
                "Light light-panel (rect-area): Godot has no runtime area-light node, so the light was omitted rather than approximated (warn-and-omit code: light_rect_area_unsupported).",
            },
            {
              directorId: "light-panel-2",
              code: "light_rect_area_unsupported",
              lightType: "rect-area",
              reason:
                "Light light-panel-2 (rect-area): Godot has no runtime area-light node, so the light was omitted rather than approximated (warn-and-omit code: light_rect_area_unsupported).",
            },
          ],
          appliedMaterialCount: 3,
          omittedMaterialCount: 1,
          omittedMaterials: [
            {
              directorId: "prop-glass",
              code: "unsupported_channels",
              reason:
                "Object prop-glass: Director material channels transmission have no StandardMaterial3D equivalent here; omitted (warn-and-omit code: unsupported_channels).",
            },
          ],
          externalizedTextureCount: 2,
        },
        warnings: [
          "Light light-panel is a rect-area light; omitted rather than approximated (warn-and-omit code: light_rect_area_unsupported).",
          "Light light-panel-2 is a rect-area light; omitted rather than approximated (warn-and-omit code: light_rect_area_unsupported).",
        ],
        omittedAnimationChannels: [
          { directorId: "hero", entityType: "object", channels: ["pose_values", "motion_blocks"] },
        ],
      },
      warnings: [
        "hero: rig pose keyframes (bone-level channels) are not carried by the Godot animation bake; only world transforms were baked (warn-and-omit, see omittedAnimationChannels). 3 pose controls affected.",
      ],
      omittedAnimationChannels: [
        { directorId: "hero", entityType: "object", channels: ["pose_values", "motion_blocks"] },
      ],
    }),
  );
  renderDock();
  const user = await openTab("Godot");

  await user.click(await screen.findByRole("button", { name: /通过原生连接器发送到 Godot/ }));

  const facts = await screen.findByLabelText("Godot 回执");
  const factOf = (label: string) => within(facts).getByText(label).closest("div")!;
  expect(factOf("相机切换轨道")).toHaveTextContent("1");
  expect(factOf("映射镜头")).toHaveTextContent("5");
  expect(factOf("省略镜头")).toHaveTextContent("1");
  expect(factOf("环境光")).toHaveTextContent("WorldEnvironment 已烘焙");
  expect(factOf("省略灯光")).toHaveTextContent("2");
  expect(factOf("省略材质")).toHaveTextContent("1");
  const omittedShots = screen.getByRole("list", { name: "结构化省略镜头" });
  expect(within(omittedShots).getByText("shot-orphan")).toBeInTheDocument();
  expect(omittedShots).toHaveTextContent("镜头缺少相机绑定");
  const omittedMaterials = screen.getByRole("list", { name: "结构化省略材质" });
  expect(within(omittedMaterials).getByText("prop-glass")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("不支持的材质通道");
  // Gateway bake channels render as per-entity structured rows (not free-text).
  const omittedChannels = screen.getByRole("list", { name: "省略的动画通道" });
  expect(within(omittedChannels).getByText("hero")).toBeInTheDocument();
  expect(omittedChannels).toHaveTextContent("姿态控制");
  expect(omittedChannels).toHaveTextContent("动作片段");
  // Connector-side light+material+shot omits keep entities (dedup is per code+entity).
  const omissions = screen.getByRole("list", { name: "结构化省略" });
  expect(within(omissions).getAllByText("light_rect_area_unsupported")).toHaveLength(2);
  expect(omissions).toHaveTextContent("面光源不支持");
  expect(omissions).toHaveTextContent("light-panel");
  expect(omissions).toHaveTextContent("unsupported_channels");
  expect(omissions).toHaveTextContent("不支持的材质通道");
  expect(omissions).toHaveTextContent("light-panel-2");
  expect(omissions).toHaveTextContent("shot_no_camera_binding");
  expect(omissions).toHaveTextContent("镜头缺少相机绑定");
});

it("previews an engine return as a dry run and guards apply behind an explicit review confirmation", async () => {
  returnClient.preview.mockResolvedValue({
    plan: {
      ready: true,
      conflicts: [],
      warnings: ["mesh hero.glb was refined"],
      operations: [],
      packageId: "pkg",
      manifestHash: hash,
    },
    summary: { operation_count: 2, skipped_count: 1, conflict_count: 0, warning_count: 1 },
    ready: true,
  });
  returnClient.apply.mockResolvedValue({ copiedAssets: ["a.glb"] });
  renderDock();
  const user = await openTab("Godot");

  const panel = screen.getByRole("tabpanel");
  await user.type(await within(panel).findByRole("textbox", { name: "回传包路径" }), "JOB/return");
  await user.click(within(panel).getByRole("checkbox", { name: /纳入引擎新建对象/ }));
  await user.click(within(panel).getByRole("button", { name: "预览差异" }));

  expect(returnClient.preview).toHaveBeenCalledWith("JOB/return", "godot", { includeNewObjects: true });
  expect(await within(panel).findByText(/2 项更新 · 1 项跳过 · 0 项冲突 · 1 条提示/)).toBeInTheDocument();
  const apply = within(panel).getByRole("button", { name: "应用引擎回传" });
  expect(apply).toBeDisabled();
  await user.click(within(panel).getByRole("checkbox", { name: /我已审阅上方差异/ }));
  expect(apply).toBeEnabled();
  await user.click(apply);
  await waitFor(() => expect(returnClient.apply).toHaveBeenCalledTimes(1));
  expect(within(panel).getByRole("button", { name: "已应用到当前场景" })).toBeDisabled();
});

it("presents the Unreal live link as unobservable preview-only copy without a fake connected state", async () => {
  renderDock();
  await openTab("Unreal");

  const panel = screen.getByRole("tabpanel");
  await within(panel).findByText("浏览器不可观测（网关 → 编辑器回环推送）");
  expect(within(panel).getAllByText(/绝不写入工程/).length).toBeGreaterThan(0);
  expect(within(panel).getByText(/Remote Control 不是安全边界/)).toBeInTheDocument();
  expect(within(panel).queryByText("已连接")).not.toBeInTheDocument();
});

it("shows how to start the Godot live link instead of fabricating a session", async () => {
  renderDock();
  await openTab("Godot");

  const panel = screen.getByRole("tabpanel");
  await within(panel).findByText("未连接；在 Godot 编辑器菜单 Director → Start Live Preview 中开始推送");
  expect(within(panel).getByText(/Godot 从不监听端口/)).toBeInTheDocument();
  expect(within(panel).queryByText("已连接")).not.toBeInTheDocument();
});

it("marks a pushing Godot session as connected with its sequence number", async () => {
  handoffClient.godotPreview.mockResolvedValue({
    contract: "director-godot-live-link-preview-v1",
    provider: "godot",
    authoritative: false,
    sessions: [
      {
        sessionId: "550e8400-e29b-41d4-a716-446655440002",
        connectorVersion: "0.1.0",
        hostVersion: "4.3.stable",
        scenePath: "res://main.tscn",
        startedAtMs: 1_000,
        lastSeenAtMs: 2_000,
        lastSequence: 7,
        frameCount: 6,
        entities: [],
      },
    ],
  });
  renderDock();
  await openTab("Godot");

  const sessions = await screen.findByRole("list", { name: "实时预览会话列表" });
  expect(within(sessions).getByText("已连接")).toBeInTheDocument();
  expect(within(sessions).getByText("res://main.tscn")).toBeInTheDocument();
  expect(sessions).toHaveTextContent("序号 7");
});

it("creates Unity live-link sessions, revealing the token only in the one-time grant", async () => {
  handoffClient.listUnitySessions.mockResolvedValueOnce([]).mockResolvedValue([
    {
      sessionId: "session-1",
      label: "工作站",
      createdAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-26T00:30:00.000Z",
      closed: false,
      latestSeq: 0,
      bufferedEventCount: 0,
      connectorSeenAt: null,
    },
  ]);
  handoffClient.createUnitySession.mockResolvedValue({
    sessionId: "session-1",
    token: "raw-secret-token",
    expiresAt: "2026-08-26T00:30:00.000Z",
    pollPath: "/api/dcc/unity/live-link/sessions/session-1/events",
  });
  renderDock();
  const user = await openTab("Unity");

  const panel = screen.getByRole("tabpanel");
  await within(panel).findByText(/暂无预览会话/);
  expect(within(panel).queryByText("raw-secret-token")).not.toBeInTheDocument();
  await user.click(within(panel).getByRole("button", { name: /新建预览会话/ }));

  await within(panel).findByText("raw-secret-token");
  expect(within(panel).getByText(/它不会再次显示/)).toBeInTheDocument();
  const sessions = await within(panel).findByRole("list", { name: "实时预览会话列表" });
  // The session list never carries the raw secret; only the one-time grant does.
  expect(within(sessions).queryByText("raw-secret-token")).not.toBeInTheDocument();
  expect(within(sessions).getByText("等待编辑器轮询")).toBeInTheDocument();
  expect(within(panel).getByText(/仅出站/)).toBeInTheDocument();
});
