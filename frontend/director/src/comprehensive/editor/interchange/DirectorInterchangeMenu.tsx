/**
 * 专业格式交换菜单，提供工程导入导出、DCC 工作流（Blender 场景导入/回传）和模板新建功能。
 *
 * @module director-interchange-menu
 */

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  LayoutTemplate,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  DirectorBlendSceneImportPlanV1,
  DirectorBlendSceneManifestV1,
} from "../../../dcc/directorBlendSceneImportContract";
import type { DirectorDccImportPlanV1 } from "../../../dcc/directorDccReturnContract";
import {
  directorDccConnectorProviderIdSchema,
  type DirectorDccConnectorProviderId,
} from "../../../dcc/directorDccEngineSpace";
import { useLanguage } from "../../i18n/language";
import {
  applyDirectorBlendSceneImport,
  DirectorBlendSceneImportClientError,
  previewDirectorBlendSceneImport,
  uploadDirectorBlendScene,
} from "../api/dccSceneImportClient";
import { applyDirectorDccImportPlan, previewDirectorDccReturnPackage } from "../api/dccReturnClient";
import { useDirectorStore } from "../store/directorStore";
import { serializeProject } from "../io/exportProjectJson";
import { parseProject } from "../io/importProjectJson";
import { DirectorTemplateDialog } from "../templates/DirectorTemplateDialog";
import { useDirectorMediaLibrary } from "../workspaces/directorMediaLibrary";
import { useDirectorCreativeWorkspaceStore, type DirectorWorkspaceMode } from "../workspaces/directorWorkspaceStore";
import { DccProviderBrowser } from "./DccProviderBrowser";
import { EngineHandoffDock } from "./engines/EngineHandoffDock";
import type { DirectorInterchangeImportResult } from "./contract";
import type { DirectorFountainOmitted } from "./fountain";
import type { DirectorGltfOmitted } from "./gltf";
import { DIRECTOR_GLTF_OMITTED_CODES } from "./gltf";
import type { DirectorUsdOmitted } from "./usd";
import { DIRECTOR_USD_OMITTED_CODES } from "./usd";
import type { DirectorMeshExportReport } from "./mesh";
import "./DirectorInterchangeMenu.css";

type DirectorInterchangeFormat =
  "project" | "otio" | "otioz" | "fountain" | "gltf" | "glb" | "usda" | "usdz" | "obj" | "stl";

type DirectorInterchangeFormatEntry = { id: DirectorInterchangeFormat; label: string; detail: string };

const FOUNTAIN_OMIT_LABELS: Record<string, string> = {
  character_dialogue: "对白未导入分镜",
  boneyard_note: "旁注已跳过",
  section_heading: "分节标题已跳过",
  title_page_field: "标题页字段未导入",
  invalid_marker: "无效镜头标记",
  transition: "转场已跳过",
};

const GLTF_OMIT_LABELS: Record<(typeof DIRECTOR_GLTF_OMITTED_CODES)[number], string> = {
  embedded_manifest_invalid: "嵌入工程清单无效",
  duplicate_stable_id: "重复稳定 ID 已忽略",
  empty_project_no_metadata: "无 Director 元数据",
};

const USD_OMIT_LABELS: Record<(typeof DIRECTOR_USD_OMITTED_CODES)[number], string> = {
  embedded_manifest_invalid: "嵌入工程清单无效",
  duplicate_stable_id: "重复稳定 ID 已忽略",
  empty_project_no_metadata: "无 Director 元数据",
};

const FORMAT_GROUPS: Array<{ id: string; label: string; formats: DirectorInterchangeFormatEntry[] }> = [
  {
    id: "project",
    label: "工程",
    formats: [{ id: "project", label: "Director 工程", detail: "完整工程 JSON · 无损往返" }],
  },
  {
    id: "timeline",
    label: "时间线",
    formats: [
      { id: "otio", label: "OTIO", detail: "OpenTimelineIO JSON" },
      { id: "otioz", label: "OTIOZ", detail: "OpenTimelineIO 归档" },
    ],
  },
  {
    id: "screenplay",
    label: "剧本",
    formats: [{ id: "fountain", label: "Fountain", detail: "剧本与稳定节拍 ID" }],
  },
  {
    id: "scene",
    label: "三维场景",
    formats: [
      { id: "gltf", label: "glTF", detail: "可编辑 JSON 场景" },
      { id: "glb", label: "GLB", detail: "二进制 glTF 场景" },
      { id: "usda", label: "USD", detail: "ASCII USDA 层" },
      { id: "usdz", label: "USDZ", detail: "便携 USD 归档" },
    ],
  },
  {
    id: "mesh",
    label: "三维网格",
    formats: [
      { id: "obj", label: "OBJ", detail: "基元网格 ZIP + 损失报告" },
      { id: "stl", label: "STL", detail: "静态网格 ZIP + 损失报告" },
    ],
  },
];

const FORMATS: DirectorInterchangeFormatEntry[] = FORMAT_GROUPS.flatMap((group) => group.formats);

type DirectorInterchangeNoticeKind = "busy" | "success" | "warning" | "error";
type DirectorInterchangeNotice = { kind: DirectorInterchangeNoticeKind; text: string };

function downloadFile(content: BlobPart, type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function extensionOf(file: File) {
  return file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

function uniqueBlendSceneWarnings(
  manifest: DirectorBlendSceneManifestV1,
  plan: DirectorBlendSceneImportPlanV1,
): string[] {
  return [...new Set([...manifest.warnings, ...plan.warnings].map((warning) => warning.trim()).filter(Boolean))];
}

/**
 * 按操作类型汇总 DCC 回传计划；资产、变换与提示始终显示，
 * 富回传条目（相机光学、灯光、角色姿态、新增对象）仅在非零时显示。
 */
function dccReturnPlanSegments(plan: DirectorDccImportPlanV1, t: (source: string) => string): string[] {
  const countOf = (op: DirectorDccImportPlanV1["operations"][number]["op"]) =>
    plan.operations.filter((operation) => operation.op === op).length;
  const segments = [`${countOf("link_refined_asset")} ${t("个资产")}`, `${countOf("update_transform")} ${t("个变换")}`];
  const cameraOpticsCount = countOf("update_camera_optics");
  if (cameraOpticsCount) segments.push(`${cameraOpticsCount} ${t("个相机光学")}`);
  const lightCount = countOf("update_light");
  if (lightCount) segments.push(`${lightCount} ${t("个灯光更新")}`);
  const poseCount = countOf("set_character_pose");
  if (poseCount) segments.push(`${poseCount} ${t("个角色姿态")}`);
  const additionCount = countOf("create_prop");
  if (additionCount) segments.push(`${additionCount} ${t("个新增对象")}`);
  segments.push(`${plan.warnings.length} ${t("条提示")}`);
  return segments;
}

/**
 * 专业格式交换菜单，根据 workspace 模式提供导入导出、模板新建和 DCC 工作流入口。
 * @param workspace - 工作区模式，影响导出格式和可用功能。
 */
export function DirectorInterchangeMenu({ workspace = "stage" }: { workspace?: DirectorWorkspaceMode }) {
  const { t } = useLanguage();
  const mediaItems = useDirectorMediaLibrary();
  const [open, setOpen] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DirectorInterchangeNotice | null>(null);
  const [importDragOver, setImportDragOver] = useState(false);
  const [meshExportScope, setMeshExportScope] = useState<"all" | "selection">("all");
  const [meshExportReport, setMeshExportReport] = useState<DirectorMeshExportReport | null>(null);
  const [fountainOmitted, setFountainOmitted] = useState<DirectorFountainOmitted[]>([]);
  const [gltfOmitted, setGltfOmitted] = useState<DirectorGltfOmitted[]>([]);
  const [usdOmitted, setUsdOmitted] = useState<DirectorUsdOmitted[]>([]);
  const [blendPackageDir, setBlendPackageDir] = useState("");
  const [blendManifest, setBlendManifest] = useState<DirectorBlendSceneManifestV1 | null>(null);
  const [blendPlan, setBlendPlan] = useState<DirectorBlendSceneImportPlanV1 | null>(null);
  const [blendCameraSourceIds, setBlendCameraSourceIds] = useState<string[]>([]);
  const [blendApplied, setBlendApplied] = useState(false);
  const [dccPackageDir, setDccPackageDir] = useState("");
  const [dccPlan, setDccPlan] = useState<DirectorDccImportPlanV1 | null>(null);
  const [dccReturnProvider, setDccReturnProvider] = useState<DirectorDccConnectorProviderId>("blender");
  /** Blender 专属：是否将 .blend 中新建（新 director_id）的对象纳入回传计划。默认关闭，绝不自动导入。 */
  const [dccIncludeNewObjects, setDccIncludeNewObjects] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const blendInputRef = useRef<HTMLInputElement | null>(null);
  const entryRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const selectedObjectIds = useDirectorStore((state) => state.selectedObjectIds);
  const meshSelectedObjectIds = selectedObjectIds.length
    ? selectedObjectIds
    : selectedObjectId
      ? [selectedObjectId]
      : [];

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!(event.target instanceof Node) || entryRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  function note(kind: DirectorInterchangeNoticeKind, text: string) {
    setNotice({ kind, text });
  }

  async function exportFormat(format: DirectorInterchangeFormat) {
    setBusy(true);
    note("busy", t("正在准备交换文件…"));
    setMeshExportReport(null);
    setFountainOmitted([]);
    setGltfOmitted([]);
    setUsdOmitted([]);
    try {
      const interchange = await import("./index");
      const project = useDirectorStore.getState().project;
      let nextMeshReport: DirectorMeshExportReport | null = null;
      if (format === "project") {
        downloadFile(serializeProject(project), "application/json", "director-project.json");
      } else if (format === "otio") {
        if (workspace === "video") {
          const creative = useDirectorCreativeWorkspaceStore.getState();
          downloadFile(
            interchange.serializeDirectorCreativeTimelineToOtio(creative, mediaItems),
            "application/json",
            "director-video-edit.otio",
          );
        } else {
          downloadFile(interchange.serializeDirectorProjectToOtio(project), "application/json", "director.otio");
        }
      } else if (format === "otioz") {
        if (workspace === "video") {
          const creative = useDirectorCreativeWorkspaceStore.getState();
          downloadFile(
            await interchange.exportDirectorCreativeTimelineToOtioz(creative, mediaItems),
            interchange.DIRECTOR_OTIOZ_MIME_TYPE,
            "director-video-edit.otioz",
          );
        } else {
          downloadFile(
            await interchange.exportDirectorProjectToOtioz(project),
            interchange.DIRECTOR_OTIOZ_MIME_TYPE,
            "director.otioz",
          );
        }
      } else if (format === "fountain") {
        downloadFile(
          interchange.exportDirectorProjectToFountain(project),
          "text/plain;charset=utf-8",
          "director.fountain",
        );
      } else if (format === "gltf") {
        const document = await interchange.exportDirectorProjectToGltf(project);
        downloadFile(`${JSON.stringify(document.json, null, 2)}\n`, "model/gltf+json", "director.gltf");
      } else if (format === "glb") {
        downloadFile(await interchange.exportDirectorProjectToGlb(project), "model/gltf-binary", "director.glb");
      } else if (format === "usda") {
        downloadFile(interchange.exportDirectorProjectToUsda(project), "model/vnd.usda", "director.usda");
      } else if (format === "usdz") {
        downloadFile(await interchange.exportDirectorProjectToUsdz(project), "model/vnd.usdz+zip", "director.usdz");
      } else if (format === "obj") {
        const archive = await interchange.exportDirectorProjectToObjArchive(project, {
          ...(meshExportScope === "selection" ? { objectIds: meshSelectedObjectIds } : {}),
        });
        downloadFile(archive.bytes, interchange.DIRECTOR_MESH_EXPORT_ARCHIVE_MIME_TYPE, archive.fileName);
        nextMeshReport = archive.report;
      } else {
        const archive = await interchange.exportDirectorProjectToStlArchive(project, {
          ...(meshExportScope === "selection" ? { objectIds: meshSelectedObjectIds } : {}),
        });
        downloadFile(archive.bytes, interchange.DIRECTOR_MESH_EXPORT_ARCHIVE_MIME_TYPE, archive.fileName);
        nextMeshReport = archive.report;
      }
      setMeshExportReport(nextMeshReport);
      note(
        nextMeshReport?.warnings.length ? "warning" : "success",
        `${FORMATS.find((item) => item.id === format)?.label ?? format} · ${t("导出完成")}${
          nextMeshReport ? ` · ${nextMeshReport.warnings.length} ${t("条兼容性提示")}` : ""
        }`,
      );
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("交换文件导出失败"));
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    note("busy", t("正在校验并导入交换文件…"));
    setFountainOmitted([]);
    setGltfOmitted([]);
    setUsdOmitted([]);
    try {
      const extension = extensionOf(file);
      if (extension === "json") {
        useDirectorStore.getState().replaceProject(parseProject(await file.text()));
        note("success", `Director ${t("工程")} · ${t("导入完成，已替换当前 3D 工程")}`);
        return;
      }
      const interchange = await import("./index");
      const baseProject = useDirectorStore.getState().project;
      const sourceBytes = async () => new Uint8Array(await file.arrayBuffer());
      if (workspace === "video" && (extension === "otio" || extension === "otioz")) {
        const knownMediaIds = mediaItems
          .filter((item) => item.availability !== "offline" && Boolean(item.sourceUrl))
          .map((item) => item.id);
        const imported =
          extension === "otio"
            ? interchange.importDirectorCreativeTimelineFromOtio(await file.text(), { knownMediaIds })
            : await interchange.importDirectorCreativeTimelineFromOtioz(await sourceBytes(), { knownMediaIds });
        if (!interchange.applyDirectorCreativeOtioImport(imported)) {
          throw new Error(t("视频编辑器时间线导入失败"));
        }
        note(
          imported.warnings.length ? "warning" : "success",
          imported.warnings.length
            ? `${t("导入完成")} · ${imported.warnings.length} ${t("条兼容性提示")}`
            : t("导入完成 · 无兼容性警告"),
        );
        return;
      }
      let result: DirectorInterchangeImportResult;
      if (extension === "otio") {
        result = interchange.importDirectorProjectFromOtio(await file.text(), { baseProject });
      } else if (extension === "otioz") {
        result = await interchange.importDirectorProjectFromOtioz(await sourceBytes(), { baseProject });
      } else if (extension === "fountain") {
        result = interchange.importDirectorProjectFromFountain(await file.text(), { baseProject });
      } else if (extension === "gltf") {
        result = await interchange.importDirectorProjectFromGltf(await file.text(), { baseProject });
        setGltfOmitted(
          Array.isArray(result.omitted)
            ? (result.omitted as DirectorGltfOmitted[]).filter((entry) =>
                (DIRECTOR_GLTF_OMITTED_CODES as readonly string[]).includes(entry.code),
              )
            : [],
        );
      } else if (extension === "glb") {
        result = await interchange.importDirectorProjectFromGlb(await sourceBytes(), { baseProject });
        setGltfOmitted(
          Array.isArray(result.omitted)
            ? (result.omitted as DirectorGltfOmitted[]).filter((entry) =>
                (DIRECTOR_GLTF_OMITTED_CODES as readonly string[]).includes(entry.code),
              )
            : [],
        );
      } else if (extension === "usd" || extension === "usda") {
        result = interchange.importDirectorProjectFromUsda(await file.text(), { baseProject });
        setUsdOmitted(
          Array.isArray(result.omitted)
            ? (result.omitted as DirectorUsdOmitted[]).filter((entry) =>
                (DIRECTOR_USD_OMITTED_CODES as readonly string[]).includes(entry.code),
              )
            : [],
        );
      } else if (extension === "usdz") {
        result = await interchange.importDirectorProjectFromUsdz(await sourceBytes(), { baseProject });
        setUsdOmitted(
          Array.isArray(result.omitted)
            ? (result.omitted as DirectorUsdOmitted[]).filter((entry) =>
                (DIRECTOR_USD_OMITTED_CODES as readonly string[]).includes(entry.code),
              )
            : [],
        );
      } else {
        throw new Error(t("不支持的交换格式"));
      }
      useDirectorStore.getState().replaceProject(result.project);
      note(
        result.warnings.length ? "warning" : "success",
        result.warnings.length
          ? `${t("导入完成")} · ${result.warnings.length} ${t("条兼容性提示")}${
              result.omitted?.length ? ` · ${result.omitted.length} ${t("项结构化省略")}` : ""
            }`
          : result.omitted?.length
            ? `${t("导入完成")} · ${result.omitted.length} ${t("项结构化省略")}`
            : t("导入完成 · 无兼容性警告"),
      );
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("交换文件导入失败"));
    } finally {
      setBusy(false);
    }
  }

  function importDroppedFile(file: File) {
    if (extensionOf(file) === "blend" && workspace === "stage") {
      void uploadBlendScene(file);
      return;
    }
    void importFile(file);
  }

  async function previewDccReturn() {
    if (!dccPackageDir.trim()) return;
    setBusy(true);
    setDccPlan(null);
    note("busy", t("正在校验 DCC 回传包…"));
    try {
      const preview = await previewDirectorDccReturnPackage(dccPackageDir.trim(), dccReturnProvider, {
        includeNewObjects: dccReturnProvider === "blender" && dccIncludeNewObjects,
      });
      setDccPlan(preview.plan);
      note(
        preview.ready ? "success" : "warning",
        preview.ready
          ? `${t("回传计划可应用")} · ${preview.summary.operation_count} ${t("项更新")}`
          : `${t("回传计划存在冲突")} · ${preview.summary.conflict_count} ${t("项冲突")}`,
      );
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("DCC 回传包校验失败"));
    } finally {
      setBusy(false);
    }
  }

  async function applyDccReturn() {
    if (!dccPlan?.ready) return;
    setBusy(true);
    note("busy", t("正在按稳定 ID 合并 DCC 回传…"));
    try {
      const result = await applyDirectorDccImportPlan(dccPlan, dccReturnProvider);
      note("success", `${t("DCC 回传已应用")} · ${result.copiedAssets.length} ${t("个细化资产")}`);
      setDccPlan(null);
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("DCC 回传应用失败"));
    } finally {
      setBusy(false);
    }
  }

  function noteBlendPlan(plan: DirectorBlendSceneImportPlanV1) {
    note(
      plan.ready ? "success" : "warning",
      plan.ready
        ? `${t("Blender 场景检查完成")} · ${t("可应用")}`
        : `${t("Blender 场景存在冲突")} · ${plan.conflicts.length} ${t("项冲突")}`,
    );
  }

  async function rebuildBlendScenePlan(
    packageDir: string,
    manifest: DirectorBlendSceneManifestV1,
    cameraSourceIds: string[],
    includeScene: boolean,
  ) {
    const plan = await previewDirectorBlendSceneImport(packageDir, {
      includeScene: includeScene && Boolean(manifest.scene.bundleFile),
      cameraSourceIds,
    });
    setBlendCameraSourceIds(plan.selection.cameraSourceIds);
    setBlendPlan(plan);
    setBlendApplied(false);
    return plan;
  }

  async function uploadBlendScene(file: File) {
    if (extensionOf(file) !== "blend") {
      note("warning", t("请选择 Blender .blend 场景文件"));
      return;
    }
    setBusy(true);
    setBlendManifest(null);
    setBlendPlan(null);
    setBlendPackageDir("");
    setBlendCameraSourceIds([]);
    setBlendApplied(false);
    note("busy", t("正在上传并检查 Blender 场景…"));
    try {
      const uploaded = await uploadDirectorBlendScene(file);
      setBlendPackageDir(uploaded.packagePath);
      setBlendManifest(uploaded.manifest);
      // Extraction can take long enough for the live Director revision to move.
      // Always rebuild the server plan after upload, preserving the extractor's
      // actual scene/camera selection (including camera-only .blend files).
      const plan = await rebuildBlendScenePlan(
        uploaded.packagePath,
        uploaded.manifest,
        uploaded.plan.selection.cameraSourceIds,
        uploaded.plan.selection.includeScene,
      );
      noteBlendPlan(plan);
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("Blender 场景上传检查失败"));
    } finally {
      setBusy(false);
    }
  }

  async function updateBlendCameraSelection(cameraSourceIds: string[]) {
    if (!blendPackageDir || !blendManifest || !blendPlan) return;
    setBusy(true);
    note("busy", t("正在重建 Blender 场景导入计划…"));
    try {
      const plan = await rebuildBlendScenePlan(
        blendPackageDir,
        blendManifest,
        cameraSourceIds,
        blendPlan.selection.includeScene,
      );
      noteBlendPlan(plan);
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("Blender 场景导入计划更新失败"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshBlendScenePlan() {
    if (!blendPackageDir || !blendManifest || !blendPlan) return;
    setBusy(true);
    note("busy", t("正在刷新 Blender 场景导入预览…"));
    try {
      const plan = await rebuildBlendScenePlan(
        blendPackageDir,
        blendManifest,
        blendPlan.selection.cameraSourceIds,
        blendPlan.selection.includeScene,
      );
      noteBlendPlan(plan);
    } catch (error) {
      note("error", error instanceof Error ? error.message : t("Blender 场景导入预览刷新失败"));
    } finally {
      setBusy(false);
    }
  }

  async function applyBlendScene() {
    if (!blendPlan?.ready || blendApplied) return;
    setBusy(true);
    note("busy", t("正在原子应用 Blender 场景…"));
    try {
      const result = await applyDirectorBlendSceneImport(blendPlan.planId, blendPlan.targetRevision);
      setBlendPlan(result.plan);
      setBlendApplied(true);
      note("success", `${t("Blender 场景已应用")} · ${result.copiedAssets.length} ${t("个场景资产")}`);
    } catch (error) {
      if (
        error instanceof DirectorBlendSceneImportClientError &&
        error.code === "stale_project_revision" &&
        blendPackageDir &&
        blendManifest
      ) {
        note("busy", t("当前场景已变化，正在刷新 Blender 导入预览…"));
        try {
          const plan = await rebuildBlendScenePlan(
            blendPackageDir,
            blendManifest,
            blendPlan.selection.cameraSourceIds,
            blendPlan.selection.includeScene,
          );
          note(
            "warning",
            plan.ready
              ? t("当前场景已变化，导入预览已刷新，请重新确认后应用")
              : `${t("当前场景已变化，导入预览已刷新")} · ${plan.conflicts.length} ${t("项冲突")}`,
          );
        } catch (refreshError) {
          note(
            "error",
            refreshError instanceof Error ? refreshError.message : t("当前场景已变化，Blender 导入预览刷新失败"),
          );
        }
      } else {
        note("error", error instanceof Error ? error.message : t("Blender 场景应用失败"));
      }
    } finally {
      setBusy(false);
    }
  }

  const blendWarnings = blendManifest && blendPlan ? uniqueBlendSceneWarnings(blendManifest, blendPlan) : [];

  return (
    <div className="director-interchange-entry" ref={entryRef}>
      <button
        aria-controls="director-interchange-popover"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`top-bar-settings-trigger${open ? " is-active" : ""}`}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={t("专业交换")}
        type="button"
      >
        <RefreshCw aria-hidden size={14} />
        <span className="top-bar-settings-label">{t("交换")}</span>
      </button>
      {open ? (
        <section aria-label={t("专业格式交换")} className="director-interchange-menu" id="director-interchange-popover">
          <header>
            <div className="director-interchange-heading">
              <span aria-hidden className="director-interchange-brand">
                <RefreshCw size={15} />
              </span>
              <div>
                <strong>{t("专业格式交换")}</strong>
                <span>{t("稳定 ID、单位、坐标系与有理数时间基")}</span>
              </div>
            </div>
            <button
              aria-label={t("关闭交换面板")}
              className="ui-icon-button"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X aria-hidden size={16} />
            </button>
          </header>
          <div className="director-interchange-body">
            {workspace === "stage" ? (
              <section aria-label={t("新建")} className="director-interchange-section">
                <h3 className="director-interchange-section-label">{t("新建")}</h3>
                <button
                  className="director-template-menu-entry"
                  onClick={() => {
                    setTemplateDialogOpen(true);
                    setOpen(false);
                  }}
                  type="button"
                >
                  <span aria-hidden className="director-template-menu-icon">
                    <LayoutTemplate size={15} />
                  </span>
                  <span className="director-template-menu-copy">
                    <strong>{t("从模板新建…")}</strong>
                    <small>{t("空场景 · 双人对话 · 三点布光 · 环绕展示 · 追随镜头")}</small>
                  </span>
                </button>
              </section>
            ) : null}
            <section aria-label={t("导入")} className="director-interchange-section">
              <h3 className="director-interchange-section-label">{t("导入")}</h3>
              <button
                aria-label={t("导入交换文件")}
                className={`director-interchange-import${importDragOver ? " is-dragover" : ""}`}
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                  setImportDragOver(false);
                }}
                onDragOver={(event) => {
                  if (busy || !event.dataTransfer.types.includes("Files")) return;
                  event.preventDefault();
                  setImportDragOver(true);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setImportDragOver(false);
                  if (busy) return;
                  const file = event.dataTransfer.files?.[0];
                  if (file) importDroppedFile(file);
                }}
                type="button"
              >
                <span aria-hidden className="director-interchange-action-icon">
                  <ArrowDownToLine size={15} />
                </span>
                <span className="director-interchange-action-copy">
                  <strong>{t("导入交换文件")}</strong>
                  <small>
                    {t("点击或拖放")} · {t("工程 JSON")} · OTIO · glTF · USD · Fountain
                  </small>
                </span>
              </button>
              <input
                accept=".json,.otio,.otioz,.fountain,.gltf,.glb,.usd,.usda,.usdz"
                aria-label={t("选择交换文件")}
                className="sr-only"
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (file) void importFile(file);
                  input.value = "";
                }}
                ref={inputRef}
                tabIndex={-1}
                type="file"
              />
              {fountainOmitted.length ? (
                <section aria-label={t("Fountain 导入省略")} className="director-mesh-export-report">
                  <div>
                    <strong>{t("Fountain 导入省略")}</strong>
                    <span>
                      {fountainOmitted.length} {t("项结构化省略")}
                    </span>
                  </div>
                  <ul aria-label={t("结构化省略")} className="director-interchange-list is-warning">
                    {fountainOmitted.slice(0, 8).map((entry) => (
                      <li key={`${entry.code}:${entry.subject}:${entry.reason}`}>
                        <code>{entry.code}</code>
                        {` · ${t(FOUNTAIN_OMIT_LABELS[entry.code] ?? entry.code)} · `}
                        <span data-i18n-user-content title={entry.reason}>
                          {entry.subject}
                        </span>
                      </li>
                    ))}
                    {fountainOmitted.length > 8 ? (
                      <li className="director-interchange-more">+{fountainOmitted.length - 8}</li>
                    ) : null}
                  </ul>
                </section>
              ) : null}
              {gltfOmitted.length ? (
                <section aria-label={t("glTF 导入省略")} className="director-mesh-export-report">
                  <div>
                    <strong>{t("glTF 导入省略")}</strong>
                    <span>
                      {gltfOmitted.length} {t("项结构化省略")}
                    </span>
                  </div>
                  <ul aria-label={t("结构化省略")} className="director-interchange-list is-warning">
                    {gltfOmitted.slice(0, 8).map((entry) => (
                      <li key={`${entry.code}:${entry.subject}:${entry.reason}`}>
                        <code>{entry.code}</code>
                        {` · ${t(GLTF_OMIT_LABELS[entry.code] ?? entry.code)} · `}
                        <span data-i18n-user-content title={entry.reason}>
                          {entry.subject}
                        </span>
                      </li>
                    ))}
                    {gltfOmitted.length > 8 ? (
                      <li className="director-interchange-more">+{gltfOmitted.length - 8}</li>
                    ) : null}
                  </ul>
                </section>
              ) : null}
              {usdOmitted.length ? (
                <section aria-label={t("USD 导入省略")} className="director-mesh-export-report">
                  <div>
                    <strong>{t("USD 导入省略")}</strong>
                    <span>
                      {usdOmitted.length} {t("项结构化省略")}
                    </span>
                  </div>
                  <ul aria-label={t("结构化省略")} className="director-interchange-list is-warning">
                    {usdOmitted.slice(0, 8).map((entry) => (
                      <li key={`${entry.code}:${entry.subject}:${entry.reason}`}>
                        <code>{entry.code}</code>
                        {` · ${t(USD_OMIT_LABELS[entry.code] ?? entry.code)} · `}
                        <span data-i18n-user-content title={entry.reason}>
                          {entry.subject}
                        </span>
                      </li>
                    ))}
                    {usdOmitted.length > 8 ? (
                      <li className="director-interchange-more">+{usdOmitted.length - 8}</li>
                    ) : null}
                  </ul>
                </section>
              ) : null}
            </section>
            {workspace === "stage" ? (
              <section aria-label={t("DCC 工作流")} className="director-interchange-section">
                <h3 className="director-interchange-section-label">{t("DCC 工作流")}</h3>
                <DccProviderBrowser
                  onPackageExported={(result) =>
                    note("success", `${t("DCC 交换包已生成")} · ${result.provider} · ${result.packagePath}`)
                  }
                />
                <EngineHandoffDock
                  onEngineSendCompleted={(result) =>
                    note(
                      result.warnings.length ? "warning" : "success",
                      `${t("引擎已导入")} ${result.report.importedObjectCount + result.report.importedCameraCount} ${t("个实体")}${
                        result.report.scenePath ? ` · ${result.report.scenePath}` : ""
                      }`,
                    )
                  }
                />
                <div className="director-blender-interchange">
                  <section aria-label={t("导入 Blender 场景")} className="director-blend-scene-import">
                    <div className="director-interchange-section-heading">
                      <span aria-hidden className="director-interchange-section-icon">
                        <Upload size={14} />
                      </span>
                      <div>
                        <strong>{t("导入 Blender 场景")}</strong>
                        <small>{t("禁用 Blender 自动执行后检查 .blend，确认内容再原子导入")}</small>
                      </div>
                    </div>
                    <button
                      className="director-blend-scene-upload"
                      disabled={busy}
                      onClick={() => blendInputRef.current?.click()}
                      type="button"
                    >
                      <Upload aria-hidden size={13} /> {t("选择 .blend 场景")}
                    </button>
                    <input
                      accept=".blend,application/x-blender"
                      aria-label={t("选择 Blender 场景文件")}
                      className="sr-only"
                      onChange={(event) => {
                        const input = event.currentTarget;
                        const file = input.files?.[0];
                        if (file) void uploadBlendScene(file);
                        input.value = "";
                      }}
                      ref={blendInputRef}
                      tabIndex={-1}
                      type="file"
                    />
                    {blendManifest && blendPlan ? (
                      <div className="director-blend-scene-plan">
                        <div className="director-blend-scene-plan-heading">
                          <span data-ready={blendPlan.ready}>{blendPlan.ready ? t("可应用") : t("有冲突")}</span>
                          <small title={blendManifest.source.fileName}>{blendManifest.source.fileName}</small>
                        </div>
                        <dl aria-label={t("Blender 场景内容统计")} className="director-blend-scene-stats">
                          <div>
                            <dt>{t("对象")}</dt>
                            <dd>{blendManifest.scene.objectCount}</dd>
                          </div>
                          <div>
                            <dt>Mesh</dt>
                            <dd>{blendManifest.scene.meshCount}</dd>
                          </div>
                          <div>
                            <dt>{t("相机")}</dt>
                            <dd>{blendManifest.cameras.length}</dd>
                          </div>
                          <div>
                            <dt>{t("不支持")}</dt>
                            <dd>{blendManifest.unsupported.length}</dd>
                          </div>
                          <div>
                            <dt>{t("警告")}</dt>
                            <dd>{blendWarnings.length}</dd>
                          </div>
                        </dl>
                        <div className="director-blend-camera-selection">
                          <span>
                            {t("导入相机")} · {t("已选")} {blendCameraSourceIds.length} / {blendManifest.cameras.length}
                          </span>
                          <div role="group" aria-label={t("Blender 相机选择")}>
                            <button
                              disabled={busy || blendCameraSourceIds.length === blendManifest.cameras.length}
                              onClick={() =>
                                void updateBlendCameraSelection(blendManifest.cameras.map((camera) => camera.sourceId))
                              }
                              type="button"
                            >
                              {t("全选相机")}
                            </button>
                            <button
                              disabled={busy || blendCameraSourceIds.length === 0}
                              onClick={() => void updateBlendCameraSelection([])}
                              type="button"
                            >
                              {t("不导入相机")}
                            </button>
                          </div>
                        </div>
                        {blendPlan.conflicts.length ? (
                          <ul aria-label={t("Blender 场景导入冲突")} className="director-interchange-list is-danger">
                            {blendPlan.conflicts.slice(0, 6).map((conflict) => (
                              <li key={`${conflict.code}:${conflict.sourceId}`}>{conflict.reason}</li>
                            ))}
                            {blendPlan.conflicts.length > 6 ? (
                              <li className="director-interchange-more">+{blendPlan.conflicts.length - 6}</li>
                            ) : null}
                          </ul>
                        ) : null}
                        {blendManifest.unsupported.length ? (
                          <ul aria-label={t("Blender 不支持内容")} className="director-interchange-list">
                            {blendManifest.unsupported.slice(0, 4).map((item) => (
                              <li key={`${item.kind}:${item.name}`}>{`${item.name}：${item.reason}`}</li>
                            ))}
                            {blendManifest.unsupported.length > 4 ? (
                              <li className="director-interchange-more">+{blendManifest.unsupported.length - 4}</li>
                            ) : null}
                          </ul>
                        ) : null}
                        {blendWarnings.length ? (
                          <ul aria-label={t("Blender 场景警告")} className="director-interchange-list is-warning">
                            {blendWarnings.slice(0, 6).map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                            {blendWarnings.length > 6 ? (
                              <li className="director-interchange-more">+{blendWarnings.length - 6}</li>
                            ) : null}
                          </ul>
                        ) : null}
                        <div className="director-blend-scene-actions">
                          <button disabled={busy} onClick={() => void refreshBlendScenePlan()} type="button">
                            <RefreshCw aria-hidden size={12} /> {t("刷新预览")}
                          </button>
                          <button
                            className="director-blend-scene-apply"
                            disabled={busy || !blendPlan.ready || blendApplied}
                            onClick={() => void applyBlendScene()}
                            type="button"
                          >
                            {blendApplied ? t("已应用到当前场景") : t("应用到当前场景")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                  <section aria-label={t("DCC 回传")} className="director-dcc-return">
                    <div className="director-interchange-section-heading">
                      <span aria-hidden className="director-interchange-section-icon is-return">
                        <RefreshCw size={14} />
                      </span>
                      <div>
                        <strong>{t("DCC 回传")}</strong>
                        <small>{t("先预览 stable ID 差异，再合并 mesh 与变换")}</small>
                      </div>
                    </div>
                    <div>
                      <select
                        aria-label={t("回传提供方")}
                        className="ui-field"
                        disabled={busy}
                        onChange={(event) => {
                          const parsed = directorDccConnectorProviderIdSchema.safeParse(event.currentTarget.value);
                          if (!parsed.success) return;
                          setDccReturnProvider(parsed.data);
                          setDccPlan(null);
                        }}
                        value={dccReturnProvider}
                      >
                        <option value="blender">Blender</option>
                        <option value="unreal">Unreal Engine</option>
                        <option value="unity">Unity</option>
                        <option value="godot">Godot</option>
                      </select>
                      <input
                        aria-label={t("回传包路径")}
                        className="ui-field"
                        disabled={busy}
                        onChange={(event) => {
                          setDccPackageDir(event.currentTarget.value);
                          setDccPlan(null);
                        }}
                        placeholder="JOB_ID/return-package"
                        spellCheck={false}
                        value={dccPackageDir}
                      />
                      <button
                        disabled={busy || !dccPackageDir.trim()}
                        onClick={() => void previewDccReturn()}
                        type="button"
                      >
                        {t("预览差异")}
                      </button>
                    </div>
                    {dccReturnProvider === "blender" ? (
                      <label className="director-dcc-return-opt-in">
                        <input
                          checked={dccIncludeNewObjects}
                          disabled={busy}
                          onChange={(event) => {
                            setDccIncludeNewObjects(event.currentTarget.checked);
                            setDccPlan(null);
                          }}
                          type="checkbox"
                        />
                        <span>{t("纳入 Blender 新建对象（经审阅后作为道具导入）")}</span>
                      </label>
                    ) : null}
                    {dccPlan ? (
                      <div className="director-dcc-return-plan">
                        <span data-ready={dccPlan.ready}>{dccPlan.ready ? t("可应用") : t("有冲突")}</span>
                        <p>{dccReturnPlanSegments(dccPlan, t).join(" · ")}</p>
                        {dccPlan.conflicts.length ? (
                          <ul className="director-interchange-list is-danger">
                            {dccPlan.conflicts.slice(0, 6).map((conflict) => (
                              <li key={`${conflict.code}:${conflict.directorId}`}>{conflict.reason}</li>
                            ))}
                            {dccPlan.conflicts.length > 6 ? (
                              <li className="director-interchange-more">+{dccPlan.conflicts.length - 6}</li>
                            ) : null}
                          </ul>
                        ) : null}
                        {dccPlan.warnings.length ? (
                          <ul aria-label={t("DCC 回传提示")} className="director-interchange-list is-warning">
                            {dccPlan.warnings.slice(0, 6).map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                            {dccPlan.warnings.length > 6 ? (
                              <li className="director-interchange-more">+{dccPlan.warnings.length - 6}</li>
                            ) : null}
                          </ul>
                        ) : null}
                        <button disabled={busy || !dccPlan.ready} onClick={() => void applyDccReturn()} type="button">
                          {t("应用 DCC 回传")}
                        </button>
                      </div>
                    ) : null}
                  </section>
                </div>
              </section>
            ) : null}
            <section aria-label={t("导出")} className="director-interchange-section">
              <div className="director-interchange-export-heading">
                <h3 className="director-interchange-section-label">{t("导出")}</h3>
                <span>
                  {FORMATS.length} {t("种格式")}
                </span>
              </div>
              <div aria-label={t("网格导出范围")} className="director-mesh-export-scope" role="group">
                <span>{t("OBJ / STL 范围")}</span>
                <label>
                  <input
                    checked={meshExportScope === "all"}
                    name="director-mesh-export-scope"
                    onChange={() => setMeshExportScope("all")}
                    type="radio"
                  />
                  {t("整个片场")}
                </label>
                <label title={meshSelectedObjectIds.length ? undefined : t("先在场景中选择对象")}>
                  <input
                    checked={meshExportScope === "selection"}
                    disabled={!meshSelectedObjectIds.length}
                    name="director-mesh-export-scope"
                    onChange={() => setMeshExportScope("selection")}
                    type="radio"
                  />
                  {t("当前选择")} ({meshSelectedObjectIds.length})
                </label>
              </div>
              <div className="director-interchange-format-groups">
                {FORMAT_GROUPS.map((group) => (
                  <div className="director-interchange-format-group" key={group.id}>
                    <span className="director-interchange-format-group-label">{t(group.label)}</span>
                    <ul className="director-interchange-formats">
                      {group.formats.map((format) => (
                        <li key={format.id}>
                          <button
                            aria-label={`${t("导出")} ${format.label}`}
                            disabled={
                              busy ||
                              ((format.id === "obj" || format.id === "stl") &&
                                meshExportScope === "selection" &&
                                !meshSelectedObjectIds.length)
                            }
                            onClick={() => void exportFormat(format.id)}
                            type="button"
                          >
                            <span aria-hidden className="director-interchange-format-icon">
                              <ArrowUpFromLine size={13} />
                            </span>
                            <span>
                              <strong>{format.label}</strong>
                              <small title={t(format.detail)}>{t(format.detail)}</small>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              {meshExportReport ? (
                <section aria-label={t("网格导出损失报告")} className="director-mesh-export-report">
                  <div>
                    <strong>
                      {meshExportReport.format.toUpperCase()} ·{" "}
                      {meshExportReport.scope.mode === "selection" ? t("当前选择") : t("整个片场")}
                    </strong>
                    <span>
                      {meshExportReport.objects.length} {t("个对象")} · {meshExportReport.triangleCount} {t("个三角形")}{" "}
                      · {meshExportReport.omitted.length} {t("项未导出")}
                    </span>
                  </div>
                  {meshExportReport.warnings.length ? (
                    <ul className="director-interchange-list is-warning">
                      {meshExportReport.warnings.slice(0, 8).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                      {meshExportReport.warnings.length > 8 ? (
                        <li className="director-interchange-more">+{meshExportReport.warnings.length - 8}</li>
                      ) : null}
                    </ul>
                  ) : (
                    <p>{t("无兼容性警告")}</p>
                  )}
                </section>
              ) : null}
            </section>
          </div>
          <footer
            className={`director-interchange-footer${notice || busy ? " has-content" : ""}`}
            data-kind={busy ? "busy" : notice?.kind}
          >
            {busy ? (
              <Loader2 aria-hidden className="director-interchange-footer-icon director-interchange-spin" size={13} />
            ) : notice?.kind === "success" ? (
              <CheckCircle2 aria-hidden className="director-interchange-footer-icon" size={13} />
            ) : notice ? (
              <TriangleAlert aria-hidden className="director-interchange-footer-icon" size={13} />
            ) : null}
            {notice ? <output aria-live="polite">{notice.text}</output> : null}
          </footer>
        </section>
      ) : null}
      {templateDialogOpen ? <DirectorTemplateDialog onClose={() => setTemplateDialogOpen(false)} /> : null}
    </div>
  );
}
