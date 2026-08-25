import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import JSZip from "jszip";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import { applyDirectorAuthoringActions } from "@director/agent-engine";
import { createDefaultDirectorProject, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import {
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import { serializeDirectorCreativeTimelineToOtio } from "../../../../src/comprehensive/editor/interchange/creativeOtio";
import { DirectorInterchangeMenu } from "../../../../src/comprehensive/editor/interchange/DirectorInterchangeMenu";
import * as dccSceneImportClient from "../../../../src/comprehensive/editor/api/dccSceneImportClient";
import * as dccReturnClient from "../../../../src/comprehensive/editor/api/dccReturnClient";

const blendHash = "d".repeat(64);
const blendRevision = `director-project-revision:v1:sha256:${"e".repeat(64)}` as const;

function blendManifest() {
  return {
    schemaVersion: 1 as const,
    contract: "director-blend-scene-v1" as const,
    packageId: "blend-package-ui",
    exportedAt: "2026-08-06T08:00:00.000Z",
    blenderVersion: "Blender 5.1.0",
    source: { fileName: "production-stage.blend", sha256: blendHash, sizeBytes: 2048 },
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward" as const,
      destination: "right-handed-y-up-negative-z-forward" as const,
      unit: "meter" as const,
      linearMap: "(x,y,z)->(x,z,-y)" as const,
    },
    timeline: {
      frameStart: 1,
      frameEnd: 120,
      currentFrame: 1,
      fps: 24,
      timebase: { rate: { numerator: 24, denominator: 1 } },
    },
    scene: {
      name: "Production Stage",
      bundleFile: "scene.glb",
      objectCount: 7,
      meshCount: 5,
      materialCount: 3,
      actionCount: 1,
    },
    cameras: [
      {
        sourceId: "camera-a",
        name: "Camera A",
        transform: {
          location: [0, 0, 2] as [number, number, number],
          rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        focalLengthMm: 35,
        sensorWidthMm: 36,
        sensorHeightMm: 20.25,
        sensorFit: "auto" as const,
        renderAspectRatio: 16 / 9,
        verticalFovDegrees: 22.895192,
        apertureFStop: 2.8,
        focusDistanceM: 5,
        nearClipM: 0.1,
        farClipM: 1000,
      },
      {
        sourceId: "camera-b",
        name: "Camera B",
        transform: {
          location: [2, 0, 2] as [number, number, number],
          rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
        focalLengthMm: 50,
        sensorWidthMm: 36,
        sensorHeightMm: 20.25,
        sensorFit: "auto" as const,
        renderAspectRatio: 16 / 9,
        verticalFovDegrees: 22.895192,
        apertureFStop: 4,
        focusDistanceM: 8,
        nearClipM: 0.1,
        farClipM: 1000,
      },
    ],
    unsupported: [{ kind: "LIGHT", name: "Area Light", reason: "灯光尚未导入" }],
    warnings: ["约束将被忽略"],
    fileHashes: { "scene.glb": blendHash },
  };
}

function blendPlan(
  ready = true,
  cameraSourceIds = ["camera-a", "camera-b"],
  includeScene = true,
  warnings: string[] = [],
) {
  return {
    contract: "director-blend-scene-import-plan-v1" as const,
    planId: "blend-package-ui/plans/default.json",
    ready,
    packageId: "blend-package-ui",
    packageDir: "blend-package-ui/package",
    manifestHash: blendHash,
    targetRevision: blendRevision,
    selection: { includeScene, cameraSourceIds },
    operations: [],
    conflicts: ready ? [] : [{ sourceId: "scene", code: "id_collision" as const, reason: "当前场景已有同名稳定 ID。" }],
    warnings,
  };
}

beforeEach(() => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  act(() => {
    setDirectorCreativeWorkspaceScope("interchange-menu-tests");
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("opens the scene template dialog from the stage menu and hides the entry in the video workspace", async () => {
  const user = userEvent.setup();
  const { unmount } = render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.click(screen.getByRole("button", { name: /从模板新建…/ }));

  const dialog = screen.getByRole("dialog", { name: "从模板新建 3D 片场" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(within(dialog).getByRole("button", { name: "使用模板 双人对话" })).toBeInTheDocument();

  await user.click(within(dialog).getAllByRole("button", { name: "关闭模板选择" })[1]!);
  expect(screen.queryByRole("dialog", { name: "从模板新建 3D 片场" })).not.toBeInTheDocument();
  unmount();

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu workspace="video" />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  expect(screen.queryByRole("button", { name: /从模板新建…/ })).not.toBeInTheDocument();
});

it("loads a scene template into the stage project from the menu entry", async () => {
  const user = userEvent.setup();
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.click(screen.getByRole("button", { name: /从模板新建…/ }));
  await user.click(screen.getByRole("button", { name: "使用模板 追随镜头" }));

  const project = useDirectorStore.getState().project;
  expect(project.objects.some((object) => object.id === "char_walker")).toBe(true);
  expect(project.cameras[0]?.action?.mode).toBe("follow");
  expect(screen.queryByRole("dialog", { name: "从模板新建 3D 片场" })).not.toBeInTheDocument();
});

it("offers every professional interchange format and imports Fountain into the live project", async () => {
  const user = userEvent.setup();
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  const panel = screen.getByRole("region", { name: "专业格式交换" });
  for (const label of ["OTIO", "OTIOZ", "Fountain", "glTF", "GLB", "USD", "USDZ", "OBJ", "STL"]) {
    expect(within(panel).getByRole("button", { name: `导出 ${label}` })).toBeInTheDocument();
  }

  const file = new File(
    ["Title: Imported Script\n\nINT. STUDIO - DAY\n\nA camera waits on the empty stage.\n"],
    "script.fountain",
    { type: "text/plain" },
  );
  fireEvent.change(screen.getByLabelText("选择交换文件"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText("导入完成 · 无兼容性警告")).toBeInTheDocument());
  expect(useDirectorStore.getState().project.storyboard?.shots[0]?.title).toBe("INT. STUDIO - DAY");
});

it("exports a real Fountain download from the current project", async () => {
  const user = userEvent.setup();
  const project = createDefaultDirectorProject();
  project.storyboard = {
    version: 1,
    title: "Download",
    logline: "",
    shots: [
      {
        id: "shot-download",
        scriptBeatId: "beat-download",
        title: "EXT. ROOFTOP - NIGHT",
        cameraId: null,
        frameStart: 0,
        frameEnd: 23,
        shotSize: "wide",
        movement: "static",
        action: "City lights pulse.",
      },
    ],
  };
  useDirectorStore.getState().replaceProject(project);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:director-interchange");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.click(screen.getByRole("button", { name: "导出 Fountain" }));
  await waitFor(() => expect(screen.getByText("Fountain · 导出完成")).toBeInTheDocument());
  expect(click).toHaveBeenCalledOnce();
});

it("exports selected primitive geometry with a visible OBJ loss report and hashed sidecar", async () => {
  const user = userEvent.setup();
  const project = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    {
      action: "add_object",
      id: "menu-export-box",
      name: "Menu export box",
      kind: "prop",
      geometry_type: "box",
      transform: { position: [1, 0, 2], rotation: [0, 0, 0], scale: [2, 1, 3] },
    },
  ]).project;
  useDirectorStore.getState().replaceProject(project);
  useDirectorStore.getState().selectObjects(["menu-export-box"]);
  let downloaded: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    downloaded = value as Blob;
    return "blob:director-obj-export";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.click(screen.getByRole("radio", { name: /当前选择/ }));
  await user.click(screen.getByRole("button", { name: "导出 OBJ" }));
  await waitFor(() => expect(screen.getByText(/OBJ · 导出完成/)).toBeInTheDocument());
  const report = screen.getByRole("region", { name: "网格导出损失报告" });
  expect(within(report).getByText(/1 个对象/)).toBeInTheDocument();

  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(downloaded!);
  });
  const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file("director-scene.obj")?.async("string")).toContain("directorStableId menu-export-box");
  const manifest = JSON.parse((await zip.file("director-export.json")?.async("string")) ?? "{}");
  expect(manifest).toMatchObject({
    format: "obj",
    scope: { mode: "selection", includedObjectIds: ["menu-export-box"] },
    files: expect.arrayContaining([
      expect.objectContaining({ path: "director-scene.obj", sha256: expect.any(String) }),
    ]),
  });
});

it("exports the active Video Editor tracks to OTIO instead of the Stage storyboard", async () => {
  const user = userEvent.setup();
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    store.setMode("video");
    store.addClip({
      trackId: "video-1",
      mediaId: "offline-video",
      name: "Video editor clip",
      startSec: 1,
      durationSec: 2,
      sourceDurationSec: 5,
      playbackRate: 2,
    });
    store.addClip({
      trackId: "audio-1",
      mediaId: "offline-audio",
      name: "Video editor dialogue",
      startSec: 0,
      durationSec: 1,
      sourceDurationSec: 2,
    });
  });
  let downloaded: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    downloaded = value as Blob;
    return "blob:video-editor-otio";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu workspace="video" />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.click(screen.getByRole("button", { name: "导出 OTIO" }));
  await waitFor(() => expect(screen.getByText("OTIO · 导出完成")).toBeInTheDocument());
  expect(downloaded).not.toBeNull();
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(downloaded!);
  });
  const otio = JSON.parse(text) as { tracks: { children: Array<{ kind: string; children: unknown[] }> } };
  expect(otio.tracks.children.map((track) => track.kind)).toEqual(["Video", "Video", "Audio"]);
  expect(text).toContain("Video editor clip");
  expect(text).toContain("Video editor dialogue");

  await user.click(screen.getByRole("button", { name: "导出 OTIOZ" }));
  await waitFor(() => expect(screen.getByText("OTIOZ · 导出完成")).toBeInTheDocument());
  const archive = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(downloaded!);
  });
  const zip = await JSZip.loadAsync(archive);
  expect(await zip.file("content.otio")?.async("string")).toContain("Video editor dialogue");
});

it("imports OTIO into Video Editor atomically without replacing the Stage project", async () => {
  const stageBefore = structuredClone(useDirectorStore.getState().project);
  const serialized = serializeDirectorCreativeTimelineToOtio({
    editSettings: {
      aspectRatio: "9 / 16",
      fps: 24,
      timebase: { rate: { numerator: 24, denominator: 1 }, dropFrame: false, startTimecode: "01:00:00:00" },
      snapEnabled: false,
      exportQuality: "preview",
    },
    editTracks: [
      {
        id: "imported-video",
        name: "Imported V1",
        kind: "video",
        muted: false,
        locked: false,
        visible: true,
        clips: [
          {
            id: "imported-clip",
            mediaId: "missing-imported-media",
            name: "Imported edit clip",
            startSec: 2,
            durationSec: 1,
            inSec: 0.5,
            sourceDurationSec: 3,
            playbackRate: 1.5,
            opacity: 0.9,
            volume: 0.7,
            fadeInSec: 0.1,
            fadeOutSec: 0.2,
            scale: 1,
            positionX: 0,
            positionY: 0,
            rotationDeg: 0,
            fit: "contain",
          },
        ],
      },
    ],
  });
  const user = userEvent.setup();
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu workspace="video" />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  fireEvent.change(screen.getByLabelText("选择交换文件"), {
    target: { files: [new File([serialized], "edit.otio", { type: "application/json" })] },
  });
  await waitFor(() => expect(screen.getByText(/导入完成/)).toBeInTheDocument());
  const creative = useDirectorCreativeWorkspaceStore.getState();
  expect(creative.editTracks[0]).toMatchObject({ id: "imported-video", name: "Imported V1" });
  expect(creative.editTracks[0]!.clips[0]).toMatchObject({
    id: "imported-clip",
    name: "Imported edit clip",
    startSec: 2,
    inSec: 0.5,
    playbackRate: 1.5,
  });
  expect(creative.editSettings).toMatchObject({ aspectRatio: "9 / 16", snapEnabled: false, exportQuality: "preview" });
  expect(useDirectorStore.getState().project).toEqual(stageBefore);
});

it("previews Blender return conflicts before enabling Apply", async () => {
  const user = userEvent.setup();
  vi.spyOn(dccReturnClient, "previewDirectorDccReturnPackage").mockResolvedValue({
    ready: false,
    dry_run: true,
    summary: { operation_count: 0, skipped_count: 1, conflict_count: 1, warning_count: 0 },
    plan: {
      contract: "director-dcc-import-plan-v1",
      ready: false,
      packageId: "return-1",
      packageDir: "job-1/return-package",
      manifestHash: "a".repeat(64),
      sourceRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}`,
      targetRevision: `director-project-revision:v1:sha256:${"c".repeat(64)}`,
      operations: [{ op: "skip", directorId: "deleted", reason: "Stable ID no longer exists." }],
      conflicts: [
        {
          directorId: "deleted",
          code: "unknown_director_id",
          reason: "Stable ID no longer exists.",
        },
      ],
      warnings: [],
    },
  });
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.type(screen.getByLabelText("回传包路径"), "job-1/return-package");
  await user.click(screen.getByRole("button", { name: "预览差异" }));
  await waitFor(() => expect(screen.getByText("回传计划存在冲突 · 1 项冲突")).toBeInTheDocument());
  expect(screen.getByText("Stable ID no longer exists.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "应用 DCC 回传" })).toBeDisabled();
  expect(dccReturnClient.previewDirectorDccReturnPackage).toHaveBeenCalledWith("job-1/return-package", "blender");
});

it("routes engine return previews through the selected connector provider", async () => {
  const user = userEvent.setup();
  const preview = vi.spyOn(dccReturnClient, "previewDirectorDccReturnPackage").mockResolvedValue({
    ready: true,
    dry_run: true,
    summary: { operation_count: 1, skipped_count: 0, conflict_count: 0, warning_count: 0 },
    plan: {
      contract: "director-dcc-import-plan-v1",
      ready: true,
      packageId: "return-godot-1",
      packageDir: "job-godot/return-package",
      manifestHash: "a".repeat(64),
      sourceRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}`,
      targetRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}`,
      operations: [
        {
          op: "update_transform",
          entityType: "object",
          objectId: "obj-1",
          transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
      conflicts: [],
      warnings: [],
    },
  });
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.selectOptions(screen.getByLabelText("回传提供方"), "godot");
  await user.type(screen.getByLabelText("回传包路径"), "job-godot/return-package");
  await user.click(screen.getByRole("button", { name: "预览差异" }));
  await waitFor(() => expect(screen.getByText("回传计划可应用 · 1 项更新")).toBeInTheDocument());
  expect(preview).toHaveBeenCalledWith("job-godot/return-package", "godot");
  expect(screen.getByRole("button", { name: "应用 DCC 回传" })).toBeEnabled();
});

it("uploads a Blender scene, rebuilds camera selection, and applies the reviewed plan", async () => {
  const user = userEvent.setup();
  const manifest = blendManifest();
  const initialPlan = blendPlan();
  const noCameraPlan = blendPlan(true, []);
  const upload = vi.spyOn(dccSceneImportClient, "uploadDirectorBlendScene").mockResolvedValue({
    jobId: "blend-job-ui",
    packagePath: "blend-package-ui/package",
    manifest,
    plan: initialPlan,
  });
  const preview = vi
    .spyOn(dccSceneImportClient, "previewDirectorBlendSceneImport")
    .mockResolvedValueOnce(initialPlan)
    .mockResolvedValueOnce(noCameraPlan)
    .mockResolvedValueOnce(noCameraPlan);
  const apply = vi.spyOn(dccSceneImportClient, "applyDirectorBlendSceneImport").mockResolvedValue({
    plan: noCameraPlan,
    authoring: { success: true },
    copiedAssets: [{ assetId: "asset-stage", url: "/dcc-import/hash/stage.glb", hash: blendHash }],
  });
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  const file = new File(["BLENDER"], "production-stage.blend", { type: "application/x-blender" });
  await user.upload(screen.getByLabelText("选择 Blender 场景文件"), file);

  await waitFor(() => expect(upload).toHaveBeenCalledWith(file));
  expect(preview).toHaveBeenNthCalledWith(1, "blend-package-ui/package", initialPlan.selection);
  expect(screen.getByText("production-stage.blend")).toBeInTheDocument();
  const statistics = screen.getByLabelText("Blender 场景内容统计");
  expect(within(statistics).getByText("7")).toBeInTheDocument();
  expect(within(statistics).getByText("5")).toBeInTheDocument();
  expect(screen.getByText("导入相机 · 已选 2 / 2")).toBeInTheDocument();
  expect(screen.getByText("Area Light：灯光尚未导入")).toBeInTheDocument();
  expect(screen.getByText("约束将被忽略")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "不导入相机" }));
  await waitFor(() =>
    expect(preview).toHaveBeenCalledWith("blend-package-ui/package", {
      includeScene: true,
      cameraSourceIds: [],
    }),
  );
  expect(screen.getByText("导入相机 · 已选 0 / 2")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "刷新预览" }));
  await waitFor(() => expect(preview).toHaveBeenNthCalledWith(3, "blend-package-ui/package", noCameraPlan.selection));

  await user.click(screen.getByRole("button", { name: "应用到当前场景" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith(noCameraPlan.planId, blendRevision));
  expect(screen.getByText("已应用到当前场景")).toBeInTheDocument();
  expect(screen.getByText("Blender 场景已应用 · 1 个场景资产")).toBeInTheDocument();
});

it("shows Blender scene conflicts and keeps apply disabled", async () => {
  const user = userEvent.setup();
  const conflictPlan = blendPlan(false);
  vi.spyOn(dccSceneImportClient, "uploadDirectorBlendScene").mockResolvedValue({
    jobId: "blend-job-conflict",
    packagePath: "blend-package-ui/package",
    manifest: blendManifest(),
    plan: conflictPlan,
  });
  vi.spyOn(dccSceneImportClient, "previewDirectorBlendSceneImport").mockResolvedValue(conflictPlan);
  const apply = vi.spyOn(dccSceneImportClient, "applyDirectorBlendSceneImport");
  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.upload(
    screen.getByLabelText("选择 Blender 场景文件"),
    new File(["BLENDER"], "conflict.blend", { type: "application/x-blender" }),
  );

  await waitFor(() => expect(screen.getByText("Blender 场景存在冲突 · 1 项冲突")).toBeInTheDocument());
  expect(screen.getByText("当前场景已有同名稳定 ID。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "应用到当前场景" })).toBeDisabled();
  expect(apply).not.toHaveBeenCalled();
});

it("preserves camera-only selection and shows de-duplicated plan warnings", async () => {
  const user = userEvent.setup();
  const manifest = {
    ...blendManifest(),
    scene: {
      ...blendManifest().scene,
      bundleFile: null,
      objectCount: 0,
      meshCount: 0,
      materialCount: 0,
      actionCount: 0,
    },
    fileHashes: {},
  };
  const cameraOnlyPlan = blendPlan(true, ["camera-a", "camera-b"], false, [
    "约束将被忽略",
    "相机视场已转换到 Director 传感器格式",
  ]);
  const cameraOnlyWithoutCameras = blendPlan(false, [], false, cameraOnlyPlan.warnings);
  vi.spyOn(dccSceneImportClient, "uploadDirectorBlendScene").mockResolvedValue({
    jobId: "blend-job-camera-only",
    packagePath: "blend-package-ui/package",
    manifest,
    plan: cameraOnlyPlan,
  });
  const preview = vi
    .spyOn(dccSceneImportClient, "previewDirectorBlendSceneImport")
    .mockResolvedValueOnce(cameraOnlyPlan)
    .mockResolvedValueOnce(cameraOnlyWithoutCameras);

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.upload(
    screen.getByLabelText("选择 Blender 场景文件"),
    new File(["BLENDER"], "camera-only.blend", { type: "application/x-blender" }),
  );

  await waitFor(() =>
    expect(preview).toHaveBeenNthCalledWith(1, "blend-package-ui/package", {
      includeScene: false,
      cameraSourceIds: ["camera-a", "camera-b"],
    }),
  );
  const warnings = screen.getByRole("list", { name: "Blender 场景警告" });
  expect(within(warnings).getAllByRole("listitem")).toHaveLength(2);
  expect(within(warnings).getByText("约束将被忽略")).toBeInTheDocument();
  expect(within(warnings).getByText("相机视场已转换到 Director 传感器格式")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "不导入相机" }));
  await waitFor(() =>
    expect(preview).toHaveBeenNthCalledWith(2, "blend-package-ui/package", {
      includeScene: false,
      cameraSourceIds: [],
    }),
  );
});

it("automatically refreshes a stale Blender import plan and asks for confirmation again", async () => {
  const user = userEvent.setup();
  const manifest = blendManifest();
  const initialPlan = blendPlan();
  const refreshedPlan = {
    ...blendPlan(),
    planId: "blend-package-ui/plans/refreshed.json",
    targetRevision: `director-project-revision:v1:sha256:${"f".repeat(64)}` as const,
  };
  vi.spyOn(dccSceneImportClient, "uploadDirectorBlendScene").mockResolvedValue({
    jobId: "blend-job-stale",
    packagePath: "blend-package-ui/package",
    manifest,
    plan: initialPlan,
  });
  const preview = vi
    .spyOn(dccSceneImportClient, "previewDirectorBlendSceneImport")
    .mockResolvedValueOnce(initialPlan)
    .mockResolvedValueOnce(refreshedPlan);
  vi.spyOn(dccSceneImportClient, "applyDirectorBlendSceneImport").mockRejectedValue(
    new dccSceneImportClient.DirectorBlendSceneImportClientError(
      "Project revision changed",
      409,
      "stale_project_revision",
      "Preview again",
    ),
  );

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.upload(
    screen.getByLabelText("选择 Blender 场景文件"),
    new File(["BLENDER"], "stale.blend", { type: "application/x-blender" }),
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "应用到当前场景" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "应用到当前场景" }));

  await waitFor(() => expect(screen.getByText("当前场景已变化，导入预览已刷新，请重新确认后应用")).toBeInTheDocument());
  expect(preview).toHaveBeenNthCalledWith(2, "blend-package-ui/package", initialPlan.selection);
  expect(screen.getByRole("button", { name: "应用到当前场景" })).toBeEnabled();
});

it("exports the complete Director project JSON and re-imports it losslessly", async () => {
  const user = userEvent.setup();
  const project = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    {
      action: "add_object",
      id: "roundtrip-box",
      name: "Roundtrip box",
      kind: "prop",
      geometry_type: "box",
      transform: { position: [1, 0, 2], rotation: [0, 0, 0], scale: [2, 1, 3] },
    },
  ]).project;
  useDirectorStore.getState().replaceProject(project);
  let downloaded: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    downloaded = value as Blob;
    return "blob:director-project-export";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  render(
    <LanguageProvider>
      <DirectorInterchangeMenu />
    </LanguageProvider>,
  );
  await user.click(screen.getByRole("button", { name: "交换" }));
  await user.click(screen.getByRole("button", { name: "导出 Director 工程" }));
  await waitFor(() => expect(screen.getByText("Director 工程 · 导出完成")).toBeInTheDocument());
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(downloaded!);
  });
  expect(JSON.parse(text).objects.some((object: { id: string }) => object.id === "roundtrip-box")).toBe(true);

  useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  expect(useDirectorStore.getState().project.objects.some((object) => object.id === "roundtrip-box")).toBe(false);

  const file = new File([text], "director-project.json", { type: "application/json" });
  fireEvent.change(screen.getByLabelText("选择交换文件"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(/已替换当前 3D 工程/)).toBeInTheDocument());
  const restored = useDirectorStore.getState().project.objects.find((object) => object.id === "roundtrip-box");
  expect(restored?.name).toBe("Roundtrip box");
  expect(restored?.transform.scale).toEqual([2, 1, 3]);
});
