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
  openUnrealPreview: vi.fn(),
  sendUnrealPreviewFrame: vi.fn(),
  closeUnrealPreview: vi.fn(),
}));
const returnClient = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));
const runClient = vi.hoisted(() => ({ launch: vi.fn(), run: vi.fn(), status: vi.fn(), stop: vi.fn() }));
const sceneClient = vi.hoisted(() => ({ upload: vi.fn(), preview: vi.fn(), apply: vi.fn() }));

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
  openDirectorUnrealLivePreviewSession: handoffClient.openUnrealPreview,
  sendDirectorUnrealLivePreviewFrame: handoffClient.sendUnrealPreviewFrame,
  closeDirectorUnrealLivePreviewSession: handoffClient.closeUnrealPreview,
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
vi.mock("../../../../../src/comprehensive/editor/api/dccEngineRunClient", () => {
  class DirectorDccEngineRunClientError extends Error {
    recovery: string[] = [];
  }
  return {
    launchDirectorEngineEditor: runClient.launch,
    runDirectorEngineProject: runClient.run,
    fetchDirectorEngineRunStatus: runClient.status,
    stopDirectorEngineProject: runClient.stop,
    DirectorDccEngineRunClientError,
  };
});
vi.mock("../../../../../src/comprehensive/editor/api/dccEngineSceneClient", () => {
  class DirectorEngineSceneClientError extends Error {}
  return {
    uploadDirectorEngineScenePackage: sceneClient.upload,
    previewDirectorEngineSceneImport: sceneClient.preview,
    applyDirectorEngineSceneImport: sceneClient.apply,
    DirectorEngineSceneClientError,
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
        omittedMaterialCount: 2,
        omittedMaterials: [
          {
            directorId: "prop-glass",
            code: "unsupported_channels",
            reason:
              "Object prop-glass: Director material channels transmission have no faithful Director parent mapping; omitted (warn-and-omit code: unsupported_channels).",
          },
          {
            directorId: "prop-crate",
            code: "texture_import_failed",
            reason:
              "Object prop-crate: bundled texture parameter(s) BaseColorMap failed to import into Unreal; the MaterialInstance stays unbound for those slots (warn-and-omit code: texture_import_failed).",
          },
        ],
        omittedShotCount: 1,
        omittedShots: [
          {
            shotId: "shot-orphan",
            code: "shot_no_camera_binding",
            cameraDirectorId: null,
            reason:
              "Shot shot-orphan has no camera binding; no camera cut section was added (warn-and-omit code: shot_no_camera_binding).",
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
  expect(sequencer).toHaveTextContent("2");
  expect(sequencer).toHaveTextContent("省略镜头");
  const omittedMaterials = screen.getByRole("list", { name: "结构化省略材质" });
  expect(within(omittedMaterials).getByText("prop-glass")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("不支持的材质通道");
  expect(within(omittedMaterials).getByText("prop-crate")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("贴图导入失败");
  // Typed shot omissions render with the shared Godot/Unity code labels.
  const omittedShots = screen.getByRole("list", { name: "结构化省略镜头" });
  expect(within(omittedShots).getByText("shot-orphan")).toBeInTheDocument();
  expect(omittedShots).toHaveTextContent("镜头缺少相机绑定");
  expect(omittedShots).toHaveTextContent("no camera cut section was added");
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
          omittedMaterialCount: 2,
          omittedMaterials: [
            {
              directorId: "prop-hdrp",
              code: "pipeline_unsupported",
              renderPipeline: "hdrp",
              reason: "HDRP has no Director PBR fallback; omitted.",
            },
            {
              directorId: "prop-glass",
              code: "unsupported_channels",
              renderPipeline: "urp",
              reason:
                "Object prop-glass: Director material channels transmission have no faithful URP/Built-in Lit binding; omitted (warn-and-omit code: unsupported_channels).",
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
  expect(factOf("省略材质")).toHaveTextContent("2");
  const omittedMaterials = screen.getByRole("list", { name: "结构化省略材质" });
  expect(within(omittedMaterials).getByText("prop-hdrp")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("管线不支持材质回退");
  expect(within(omittedMaterials).getByText("prop-glass")).toBeInTheDocument();
  expect(omittedMaterials).toHaveTextContent("不支持的材质通道");
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
  const omittedLights = screen.getByRole("list", { name: "结构化省略灯光" });
  expect(within(omittedLights).getByText("light-panel")).toBeInTheDocument();
  expect(within(omittedLights).getByText("light-panel-2")).toBeInTheDocument();
  expect(omittedLights).toHaveTextContent("面光源不支持");
  // Gateway bake channels render as per-entity structured rows (not free-text).
  const omittedChannels = screen.getByRole("list", { name: "省略的动画通道" });
  expect(within(omittedChannels).getByText("hero")).toBeInTheDocument();
  expect(omittedChannels).toHaveTextContent("姿态控制");
  expect(omittedChannels).toHaveTextContent("动作片段");
  // Connector-side shot omits keep entities in the generic list (lights/materials have dedicated lists).
  const omissions = screen.getByRole("list", { name: "结构化省略" });
  expect(omissions).toHaveTextContent("shot_no_camera_binding");
  expect(omissions).toHaveTextContent("镜头缺少相机绑定");
  expect(within(omissions).queryByText("light-panel")).not.toBeInTheDocument();
  expect(omissions).not.toHaveTextContent("unsupported_channels");
  expect(omissions).not.toHaveTextContent("prop-glass");
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

it("lists typed omittedOptics / omittedAdditions on engine return preview without echoing them as free-text warnings", async () => {
  const opticsReason =
    "Camera cam-1 sensor format 'imax65' was omitted from the return plan (warn-and-omit).";
  const additionReason =
    'New DCC object "Prop" (prop-new) is available but not imported; rebuild the plan with include_new_objects.';
  returnClient.preview.mockResolvedValue({
    plan: {
      ready: true,
      conflicts: [],
      warnings: [opticsReason, "unrelated bake notice"],
      operations: [{ op: "skip", directorId: "prop-new", reason: additionReason }],
      packageId: "pkg",
      manifestHash: hash,
      omittedOpticsCount: 1,
      omittedOptics: [
        {
          directorId: "cam-1",
          code: "sensor_format",
          field: "sensorFormat",
          reason: opticsReason,
        },
      ],
      omittedAdditionsCount: 1,
      omittedAdditions: [
        {
          directorId: "prop-new",
          name: "Prop",
          meshFile: "meshes/prop-new.glb",
          code: "opt_in_required",
          reason: additionReason,
        },
      ],
    },
    summary: { operation_count: 1, skipped_count: 1, conflict_count: 0, warning_count: 2 },
    ready: true,
  });
  renderDock();
  const user = await openTab("Godot");
  const panel = screen.getByRole("tabpanel");
  await user.type(await within(panel).findByRole("textbox", { name: "回传包路径" }), "JOB/return");
  await user.click(within(panel).getByRole("button", { name: "预览差异" }));

  expect(
    await within(panel).findByText(/1 项更新 · 1 项跳过 · 0 项冲突 · 1 项省略光学 · 1 项省略新增 · 1 条提示/),
  ).toBeInTheDocument();

  const opticsList = within(panel).getByRole("list", { name: "结构化省略光学" });
  expect(within(opticsList).getByText("cam-1")).toBeInTheDocument();
  expect(opticsList).toHaveTextContent("传感器画幅省略");

  const additionsList = within(panel).getByRole("list", { name: "结构化省略新增对象" });
  expect(within(additionsList).getByText("prop-new")).toBeInTheDocument();
  expect(additionsList).toHaveTextContent("需选择纳入");

  const notices = within(panel).getByRole("list", { name: "回传提示" });
  expect(notices).toHaveTextContent("unrelated bake notice");
  expect(notices).not.toHaveTextContent("sensor format");
});

it("presents the Unreal live preview as disconnected preview-only copy without a fake connected state", async () => {
  renderDock();
  await openTab("Unreal");

  const panel = screen.getByRole("tabpanel");
  await within(panel).findByText(/未连接；在引擎侧运行 director_headless.py --mode live-preview/);
  expect(within(panel).getByRole("textbox", { name: "Unreal 实时预览端口" })).toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "推送活动相机" })).toBeDisabled();
  expect(within(panel).getAllByText(/绝不写入工程/).length).toBeGreaterThan(0);
  expect(within(panel).getByText(/Remote Control 不是安全边界/)).toBeInTheDocument();
  expect(within(panel).queryByText(/已连接/)).not.toBeInTheDocument();
});

it("runs the Godot project with bounded output and stops it from the same section", async () => {
  const runningStatus = {
    contract: "director-dcc-engine-run-v1",
    provider: "godot",
    runId: "godot-run-1",
    executable: "/opt/godot",
    projectPath: "/proj",
    scene: null,
    headless: false,
    pid: 4242,
    state: "running" as const,
    exitCode: null,
    startedAtMs: 1_000,
    endedAtMs: null,
    output: "[fixture] engine running\n",
    outputTruncated: false,
  };
  runClient.run.mockResolvedValue(runningStatus);
  runClient.status.mockResolvedValue(runningStatus);
  runClient.stop.mockResolvedValue({ ...runningStatus, state: "stopped" as const, endedAtMs: 2_000, exitCode: null });
  renderDock();
  const user = await openTab("Godot");
  const panel = screen.getByRole("tabpanel");

  await user.click(within(panel).getByRole("button", { name: "运行项目" }));
  expect(runClient.run).toHaveBeenCalledWith("godot", { headless: false });
  await within(panel).findByText("运行中");
  expect(within(panel).getByLabelText("运行输出")).toHaveTextContent("[fixture] engine running");

  await user.click(within(panel).getByRole("button", { name: /停止运行/ }));
  await waitFor(() => expect(runClient.stop).toHaveBeenCalledWith("godot"));
  await within(panel).findByText("已停止");
});

it("keeps project runs honest on Unity and offers the editor launch instead", async () => {
  runClient.launch.mockResolvedValue({
    contract: "director-dcc-engine-editor-launch-v1",
    provider: "unity",
    executable: "/opt/unity",
    projectPath: "/proj",
    pid: 777,
    launchedAtMs: 1_000,
    warnings: [],
  });
  renderDock();
  const user = await openTab("Unity");
  const panel = screen.getByRole("tabpanel");

  expect(within(panel).queryByRole("button", { name: "运行项目" })).not.toBeInTheDocument();
  expect(within(panel).getByText(/项目运行暂不支持该引擎/)).toBeInTheDocument();
  await user.click(within(panel).getByRole("button", { name: /在引擎编辑器中打开/ }));
  await waitFor(() => expect(runClient.launch).toHaveBeenCalledWith("unity"));
  expect(await within(panel).findByText(/编辑器已启动 · PID 777/)).toBeInTheDocument();
});

it("imports an uploaded Godot scene package after review with a rebuilt selection plan", async () => {
  const manifest = {
    schemaVersion: 1,
    contract: "director-engine-scene-v1",
    packageId: "godot-scene-a",
    provider: "godot",
    exportedAt: "2026-08-26T00:00:00Z",
    engineVersion: "Godot 4.7.2",
    exporter: { name: "director-godot-scene-export", version: "1.0.0" },
    source: { projectName: "Fixture", sceneName: "main" },
    coordinateSystem: {
      source: "right-handed-y-up-negative-z-forward-meter",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,y,z)",
    },
    timeline: { frameStart: 0, frameEnd: 0, currentFrame: 0, fps: 30 },
    scene: {
      name: "main",
      bundleFile: "assets/scene.glb",
      nodeCount: 6,
      meshCount: 1,
      skinnedMeshCount: 0,
      materialCount: 0,
      animationClipCount: 0,
    },
    nodes: [],
    cameras: [
      {
        sourceId: "MainCamera",
        name: "MainCamera",
        position: [0, 1.7, 5],
        lookTarget: [0, 1.7, -5],
        verticalFovDegrees: 40,
        nearClipM: 0.05,
        farClipM: 4000,
        renderAspectRatio: 16 / 9,
      },
    ],
    lights: [
      {
        sourceId: "Sun",
        name: "Sun",
        type: "directional",
        color: "#ffffff",
        intensity: 1,
        position: [0, 10, 0],
        target: [0, 0, 0],
        castShadow: true,
      },
    ],
    animationClips: [],
    unsupported: [],
    warnings: ["fixture warning"],
    fileHashes: { "assets/scene.glb": hash },
  };
  const plan = {
    contract: "director-engine-scene-import-plan-v1",
    planId: "godot-job/plans/default.json",
    ready: true,
    provider: "godot",
    packageId: "godot-scene-a",
    packageDir: "godot-job/package",
    manifestHash: hash,
    targetRevision: revision,
    selection: { includeScene: true, cameraSourceIds: ["MainCamera"], lightSourceIds: ["Sun"] },
    operations: [{ op: "create_scene_asset" }, { op: "create_scene_object" }, { op: "create_camera" }],
    conflicts: [],
    warnings: [],
  };
  sceneClient.upload.mockResolvedValue({
    jobId: "godot-job",
    provider: "godot",
    packagePath: "godot-job/package",
    manifest,
    plan,
  });
  sceneClient.preview.mockResolvedValue({ ...plan, operations: plan.operations.slice(0, 2) });
  sceneClient.apply.mockResolvedValue({ plan, copiedAssets: [{ assetId: "engine-scene-asset", url: "/x.glb" }] });
  renderDock();
  const user = await openTab("Godot");
  const panel = screen.getByRole("tabpanel");

  await user.upload(
    within(panel).getByLabelText("选择引擎场景包"),
    new File(["zip-bytes"], "director-engine-scene.zip", { type: "application/zip" }),
  );
  expect(sceneClient.upload).toHaveBeenCalledWith("godot", expect.any(File));
  await within(panel).findByText("包已校验");
  expect(within(panel).getByText(/Fixture · main · Godot 4.7.2/)).toBeInTheDocument();

  await user.click(within(panel).getByRole("button", { name: "按所选重建计划" }));
  await waitFor(() =>
    expect(sceneClient.preview).toHaveBeenCalledWith("godot", "godot-job/package", {
      includeScene: true,
      cameraSourceIds: ["MainCamera"],
      lightSourceIds: ["Sun"],
    }),
  );

  const importButton = within(panel).getByRole("button", { name: "导入引擎场景" });
  expect(importButton).toBeDisabled();
  await user.click(within(panel).getByRole("checkbox", { name: /我已审阅上方计划/ }));
  expect(importButton).toBeEnabled();
  await user.click(importButton);
  await waitFor(() => expect(sceneClient.apply).toHaveBeenCalledTimes(1));
  expect(within(panel).getByRole("button", { name: "已导入当前场景" })).toBeDisabled();
});

it("opens an Unreal live preview session against the entered port and closes it with bye", async () => {
  const sessionStatus = (forwarded: number, closed = false) => ({
    contract: "director-unreal-live-preview-status-v1" as const,
    sessionId: "preview-1",
    port: 42_813,
    openedAtMs: 1_000,
    summary: {
      contract: "director-unreal-live-preview-session-v1" as const,
      provider: "unreal" as const,
      protocol: "director-unreal-live-preview-v1" as const,
      forwardedFrameCount: forwarded,
      droppedFrameCount: 0,
      ignoredInboundByteCount: 0,
      closed,
      disconnectReason: closed ? ("client_close" as const) : null,
      disconnectDetail: null,
    },
  });
  handoffClient.openUnrealPreview.mockResolvedValue(sessionStatus(0));
  handoffClient.sendUnrealPreviewFrame.mockResolvedValue({
    send: { sent: true, seq: 1 },
    session: sessionStatus(1),
  });
  handoffClient.closeUnrealPreview.mockResolvedValue(sessionStatus(1, true));
  renderDock();
  const user = await openTab("Unreal");

  const panel = screen.getByRole("tabpanel");
  await user.type(within(panel).getByRole("textbox", { name: "Unreal 实时预览端口" }), "42813");
  await user.click(within(panel).getByRole("button", { name: "推送活动相机" }));

  expect(handoffClient.openUnrealPreview).toHaveBeenCalledWith(42_813);
  await within(panel).findByText(/已连接（网关 → 编辑器回环推送）/);

  await user.click(within(panel).getByRole("button", { name: "停止推送" }));
  await waitFor(() => expect(handoffClient.closeUnrealPreview).toHaveBeenCalledWith("preview-1"));
  expect(await within(panel).findByRole("button", { name: "推送活动相机" })).toBeInTheDocument();
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
