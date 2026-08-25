/**
 * Blender 实时会话面板，用于连接 Blender、检查场景、编辑网格、创建白膜和门窗洞口。
 *
 * @module blender-live-panel
 */

import { Box, Camera, DoorOpen, Lightbulb, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BlenderAgentOperation,
  BlenderEffectReceipt,
  BlenderLiveCommandBatch,
  BlenderLiveSceneSnapshot,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { useLanguage } from "../../i18n/language";
import { useBlenderRuntimeStore } from "../runtime/blenderRuntimeStore";
import { applyBlenderRuntimeBatch, applyBlenderRuntimeOperations } from "../runtime/blenderRuntimeTransactions";
import { useDirectorStore } from "../store/directorStore";
import {
  createBlenderBlockoutBatch,
  createBlenderCameraBatch,
  createBlenderLightBatch,
  createBlenderOpeningBatch,
  createBlenderPrimitiveBatch,
  inspectBlenderLiveObject,
  BlenderLiveClientError,
} from "../api/blenderLiveClient";
import { BlenderMeshEditor } from "./BlenderMeshEditor";
import "./blenderLivePanel.css";

type Dimensions = {
  width: number;
  depth: number;
  height: number;
  steps: number;
};

type LiveNotice = {
  tone: "busy" | "error" | "success";
  text: string;
};

const BLENDER_LAUNCH_COMMAND = "npm run blender";
const SUCCESS_NOTICE_DISMISS_MS = 4_000;

function isSceneIdentityConflict(error: unknown) {
  return (
    error instanceof BlenderLiveClientError &&
    (error.status === 409 || error.code === "scene_epoch_conflict" || error.code === "revision_conflict")
  );
}

function findBlenderObjectRoot(snapshot: BlenderLiveSceneSnapshot, objectId: string) {
  const objectsById = new Map(snapshot.objects.map((object) => [object.id, object]));
  let current = objectsById.get(objectId);
  while (current?.parentId && objectsById.has(current.parentId)) {
    current = objectsById.get(current.parentId);
  }
  return current ?? null;
}

/** 在场景快照中查找指定对象所属的网格列表。 */
export function findBlenderMeshesForObject(snapshot: BlenderLiveSceneSnapshot, preferredObjectId?: string) {
  const meshes = snapshot.objects.filter((object) => object.type === "MESH");
  const objectsById = new Map(snapshot.objects.map((object) => [object.id, object]));
  const belongsToPreferredObject = (mesh: (typeof meshes)[number]) => {
    if (!preferredObjectId) return true;
    let current: (typeof snapshot.objects)[number] | undefined = mesh;
    while (current) {
      if (current.id === preferredObjectId) return true;
      current = current.parentId ? objectsById.get(current.parentId) : undefined;
    }
    return false;
  };
  return meshes.filter(belongsToPreferredObject);
}

/** 在场景快照中查找首选网格的 ID，优先返回活动对象。 */
export function findPreferredBlenderMeshId(snapshot: BlenderLiveSceneSnapshot, preferredObjectId?: string) {
  const candidates = findBlenderMeshesForObject(snapshot, preferredObjectId);
  return candidates.find((mesh) => mesh.id === snapshot.activeObjectId)?.id ?? candidates[0]?.id ?? "";
}

/**
 * 原生网格检查器入口，当选中 Blender 原生对象时渲染对应的网格编辑面板。
 * 非角色对象且在 Blender 引擎中时显示。
 */
export function BlenderNativeMeshInspector() {
  const showMeshInspector = useDirectorStore((state) => {
    const selected = state.project.objects.find((object) => object.id === state.selectedObjectId);
    if (!selected || selected.nativeSource?.engine !== "blender") return false;
    if (selected.kind === "character") return false;
    return true;
  });

  if (!showMeshInspector) return null;
  return <BlenderLivePanel objectOnly />;
}

/**
 * Blender 实时会话主面板，管理 Blender 连接、场景同步、网格编辑和白膜创建。
 * @param objectOnly - 仅显示对象编辑模式，隐藏创建工具和连接状态。
 */
export function BlenderLivePanel({ objectOnly = false }: { objectOnly?: boolean } = {}) {
  const { t } = useLanguage();
  const runtimeScene = useBlenderRuntimeStore((state) => state.snapshot);
  const runtimeStatus = useBlenderRuntimeStore((state) => state.status);
  const refreshCompletedId = useBlenderRuntimeStore((state) => state.refreshCompletedId);
  const requestRuntimeRefresh = useBlenderRuntimeStore((state) => state.requestRefresh);
  const directorObjects = useDirectorStore((state) => state.project.objects);
  const selectDirectorObject = useDirectorStore((state) => state.selectObject);
  const selectedNativeObjectId = useDirectorStore((state) => {
    const selected = state.project.objects.find((object) => object.id === state.selectedObjectId);
    return selected?.nativeSource?.engine === "blender" ? selected.nativeSource.objectId : undefined;
  });
  const nativeProjectId = useDirectorStore((state) => state.project.nativeScene?.projectId);
  const [activeTool, setActiveTool] = useState<"object" | "create">("object");
  const [dimensions, setDimensions] = useState<Dimensions>({
    width: 6,
    depth: 5,
    height: 2.8,
    steps: 12,
  });
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [notice, setNotice] = useState<LiveNotice | null>(null);
  const [wallId, setWallId] = useState("");
  const [activeMeshId, setActiveMeshId] = useState("");
  const [inspection, setInspection] = useState<BlenderObjectInspection | null>(null);
  const [meshReceipt, setMeshReceipt] = useState<BlenderEffectReceipt | null>(null);
  const contextRequestRef = useRef(0);
  const inspectedContextSignatureRef = useRef<string | null>(null);
  const manualRefreshRequestRef = useRef(0);
  const commandVersionRef = useRef<{ sceneEpoch: string; revision: number } | null>(null);

  const clearSceneContext = useCallback(() => {
    contextRequestRef.current += 1;
    inspectedContextSignatureRef.current = null;
    setActiveMeshId("");
    setInspection(null);
  }, []);

  const refreshSceneContext = useCallback(
    async (
      snapshot: BlenderLiveSceneSnapshot,
      preferredMeshId?: string,
      expectedRevision = snapshot.revision,
      force = false,
    ) => {
      const contextRequest = ++contextRequestRef.current;
      if (nativeProjectId && snapshot.projectId && snapshot.projectId !== nativeProjectId) {
        clearSceneContext();
        return snapshot;
      }
      const contextSignature = [
        snapshot.sceneEpoch,
        expectedRevision,
        snapshot.frame,
        snapshot.activeObjectId ?? "",
        snapshot.selectedObjectIds.join(","),
        preferredMeshId ?? "",
      ].join("|");
      if (!force && inspectedContextSignatureRef.current === contextSignature) return snapshot;
      const nextMeshId = findPreferredBlenderMeshId(snapshot, preferredMeshId);
      const nextInspection = nextMeshId
        ? (
            await inspectBlenderLiveObject(nextMeshId, {
              expectedSceneEpoch: snapshot.sceneEpoch,
              expectedRevision,
            })
          ).inspection
        : null;
      if (contextRequest !== contextRequestRef.current) return snapshot;
      inspectedContextSignatureRef.current = contextSignature;
      setActiveMeshId(nextMeshId);
      setInspection(nextInspection);
      return snapshot;
    },
    [clearSceneContext, nativeProjectId],
  );

  const reportError = useCallback((error: unknown) => {
    setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
  }, []);

  const reportSceneContextError = useCallback(
    (error: unknown) => {
      if (isSceneIdentityConflict(error)) requestRuntimeRefresh();
      reportError(error);
    },
    [reportError, requestRuntimeRefresh],
  );

  useEffect(() => {
    if (runtimeStatus?.available && runtimeScene) {
      void refreshSceneContext(runtimeScene, objectOnly ? selectedNativeObjectId : undefined).catch(
        reportSceneContextError,
      );
      return;
    }
    if (runtimeStatus && !runtimeStatus.available) {
      clearSceneContext();
    }
  }, [
    clearSceneContext,
    objectOnly,
    refreshSceneContext,
    reportSceneContextError,
    runtimeScene,
    runtimeStatus,
    selectedNativeObjectId,
  ]);

  const retryConnection = useCallback(() => {
    setChecking(true);
    manualRefreshRequestRef.current = requestRuntimeRefresh();
  }, [requestRuntimeRefresh]);

  useEffect(() => {
    if (!checking || refreshCompletedId < manualRefreshRequestRef.current) return;
    setChecking(false);
    const current = useBlenderRuntimeStore.getState();
    if (current.status?.available && current.snapshot) {
      void refreshSceneContext(
        current.snapshot,
        objectOnly ? selectedNativeObjectId : undefined,
        current.snapshot.revision,
        true,
      ).catch(reportSceneContextError);
    }
  }, [checking, objectOnly, refreshCompletedId, refreshSceneContext, reportSceneContextError, selectedNativeObjectId]);

  const copyLaunchCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(BLENDER_LAUNCH_COMMAND);
      setCommandCopied(true);
    } catch {
      // Clipboard access can be denied; the command stays selectable as text.
    }
  }, []);

  useEffect(() => {
    if (!commandCopied) return;
    const timer = window.setTimeout(() => setCommandCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [commandCopied]);

  useEffect(() => {
    if (notice?.tone !== "success") return;
    const timer = window.setTimeout(() => setNotice(null), SUCCESS_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const scene =
    runtimeScene && (!nativeProjectId || !runtimeScene.projectId || runtimeScene.projectId === nativeProjectId)
      ? runtimeScene
      : null;

  useEffect(() => {
    if (!scene) {
      commandVersionRef.current = null;
      return;
    }
    const current = commandVersionRef.current;
    if (current?.sceneEpoch !== scene.sceneEpoch || current.revision < scene.revision) {
      commandVersionRef.current = { sceneEpoch: scene.sceneEpoch, revision: scene.revision };
    }
  }, [scene]);

  useEffect(() => {
    const walls = scene?.objects.filter((object) => object.kind === "wall") ?? [];
    setWallId((current) => (walls.some((wall) => wall.id === current) ? current : (walls[0]?.id ?? "")));
  }, [scene]);

  async function apply(label: string, createBatch: (revision: number, sceneEpoch: string) => BlenderLiveCommandBatch) {
    if (!scene) return;
    const currentVersion = commandVersionRef.current;
    const commandVersion =
      currentVersion?.sceneEpoch === scene.sceneEpoch && currentVersion.revision >= scene.revision
        ? currentVersion
        : { sceneEpoch: scene.sceneEpoch, revision: scene.revision };
    setBusy(true);
    setNotice({ tone: "busy", text: `${label}…` });
    try {
      const result = await applyBlenderRuntimeBatch(createBatch(commandVersion.revision, commandVersion.sceneEpoch));
      commandVersionRef.current = {
        sceneEpoch: result.receipt.sceneEpoch,
        revision: result.receipt.revisionAfter,
      };
      setNotice({ tone: "success", text: `${label} · ${t("完成")} · rev ${result.receipt.revisionAfter}` });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function applyMesh(
    label: string,
    operations: BlenderAgentOperation[],
    preferredMeshId = activeMeshId,
  ): Promise<BlenderEffectReceipt | null> {
    if (!scene || !preferredMeshId) return null;
    const currentVersion = commandVersionRef.current;
    const commandVersion =
      currentVersion?.sceneEpoch === scene.sceneEpoch && currentVersion.revision >= scene.revision
        ? currentVersion
        : { sceneEpoch: scene.sceneEpoch, revision: scene.revision };
    setBusy(true);
    setNotice({ tone: "busy", text: `${label}…` });
    try {
      const result = await applyBlenderRuntimeOperations({
        expectedSceneEpoch: commandVersion.sceneEpoch,
        expectedRevision: commandVersion.revision,
        operations,
      });
      commandVersionRef.current = {
        sceneEpoch: result.receipt.sceneEpoch,
        revision: result.receipt.revisionAfter,
      };
      setMeshReceipt(result.receipt);
      const nextSnapshot = await refreshSceneContext(
        result.projectedSnapshot ?? scene,
        result.receipt.selection.activeObjectId ?? preferredMeshId,
        result.receipt.revisionAfter,
        true,
      );
      if (!objectOnly && operations.some((operation) => operation.op === "set_selection")) {
        const activeObjectId = result.receipt.selection.activeObjectId ?? preferredMeshId;
        const activeRoot = findBlenderObjectRoot(nextSnapshot, activeObjectId);
        const directorObject = activeRoot
          ? directorObjects.find(
              (object) =>
                (object.nativeSource?.engine === "blender" && object.nativeSource.objectId === activeRoot.id) ||
                object.id === activeRoot.directorId ||
                object.id === `native:${activeRoot.id}`,
            )
          : undefined;
        if (directorObject) selectDirectorObject(directorObject.id);
      }
      setNotice({ tone: "success", text: `${label} · ${t("完成")} · rev ${result.receipt.revisionAfter}` });
      return result.receipt;
    } catch (error) {
      reportError(error);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function numberField(field: keyof Dimensions, label: string, min: number, step: number) {
    return (
      <label>
        <span>{label}</span>
        <input
          min={min}
          onChange={(event) =>
            setDimensions((current) => ({
              ...current,
              [field]: Number(event.currentTarget.value) || min,
            }))
          }
          step={step}
          type="number"
          value={dimensions[field]}
        />
      </label>
    );
  }

  const liveStatus = runtimeStatus?.available === true ? runtimeStatus : null;
  const connected = liveStatus !== null;
  const statusDetail = liveStatus
    ? `Blender ${liveStatus.blenderVersion} · rev ${scene?.revision ?? liveStatus.revision}${
        liveStatus.busy ? ` · ${t("执行中")}` : ""
      }`
    : t("本机 Blender 实时会话未运行");
  const walls = scene?.objects.filter((object) => object.kind === "wall") ?? [];
  const meshes = scene
    ? objectOnly
      ? findBlenderMeshesForObject(scene, selectedNativeObjectId)
      : scene.objects.filter((object) => object.type === "MESH")
    : [];

  if (objectOnly) {
    if (!selectedNativeObjectId) return null;
    if (!connected || !scene || meshes.length === 0) return null;

    return (
      <section aria-label={t("Blender Mesh 编辑")} className="blender-live-panel is-sidebar is-object-inspector">
        <BlenderMeshEditor
          activeMeshId={activeMeshId}
          busy={busy}
          inspection={inspection}
          meshes={meshes}
          onApply={applyMesh}
          receipt={meshReceipt}
        />
        {notice ? <output className={`blender-live-notice is-${notice.tone}`}>{notice.text}</output> : null}
      </section>
    );
  }

  return (
    <section aria-label={t("Blender 场景")} className="blender-live-panel is-sidebar">
      <header
        aria-label={t("Blender 连接状态")}
        className="blender-live-status"
        data-state={liveStatus ? (liveStatus.busy ? "busy" : "connected") : "offline"}
        role="group"
      >
        <span aria-hidden className="blender-live-status-dot" />
        <div className="blender-live-status-copy">
          <strong>{liveStatus ? t("已连接") : t("未连接")}</strong>
          <small title={statusDetail}>{statusDetail}</small>
        </div>
        <button
          aria-label={t("刷新")}
          className="blender-live-status-refresh"
          disabled={checking || busy}
          onClick={() => void retryConnection()}
          title={t("刷新")}
          type="button"
        >
          <RefreshCw aria-hidden className={checking ? "blender-live-spin" : undefined} size={13} />
        </button>
      </header>

      {connected && scene ? (
        <>
          <div aria-label={t("建模工具")} className="blender-live-tool-tabs" role="tablist">
            {(["object", "create"] as const).map((tool) => (
              <button
                aria-selected={activeTool === tool}
                key={tool}
                onClick={() => setActiveTool(tool)}
                role="tab"
                type="button"
              >
                {tool === "object" ? t("对象编辑") : t("创建")}
              </button>
            ))}
          </div>

          {activeTool === "object" ? (
            <div className="blender-live-tabpanel" role="tabpanel">
              <BlenderMeshEditor
                activeMeshId={activeMeshId}
                busy={busy}
                inspection={inspection}
                meshes={meshes}
                onApply={applyMesh}
                receipt={meshReceipt}
              />
            </div>
          ) : (
            <div className="blender-create-panel" role="tabpanel">
              <section className="blender-tool-section">
                <header className="blender-tool-section-heading">
                  <strong>{t("白膜搭建")}</strong>
                  <small>{t("尺寸仅用于下方新建预设")}</small>
                </header>
                <div className="blender-live-fields">
                  {numberField("width", t("宽"), 0.1, 0.1)}
                  {numberField("depth", t("深"), 0.1, 0.1)}
                  {numberField("height", t("高"), 0.1, 0.1)}
                  {numberField("steps", t("台阶"), 2, 1)}
                </div>

                <div aria-label={t("Blender 白膜预设")} className="blender-live-presets" role="group">
                  {(["floor", "room", "corridor", "stairs"] as const).map((preset) => (
                    <button
                      disabled={busy}
                      key={preset}
                      onClick={() =>
                        void apply(
                          t(
                            {
                              floor: "地面",
                              room: "房间",
                              corridor: "走廊",
                              stairs: "楼梯",
                            }[preset],
                          ),
                          (revision, sceneEpoch) =>
                            createBlenderBlockoutBatch({
                              preset,
                              expectedSceneEpoch: sceneEpoch,
                              expectedRevision: revision,
                              width: dimensions.width,
                              depth: dimensions.depth,
                              height: dimensions.height,
                              stepCount: dimensions.steps,
                            }),
                        )
                      }
                      type="button"
                    >
                      {
                        {
                          floor: t("地面"),
                          room: t("房间"),
                          corridor: t("走廊"),
                          stairs: t("楼梯"),
                        }[preset]
                      }
                    </button>
                  ))}
                </div>
              </section>

              <section className="blender-tool-section">
                <header className="blender-tool-section-heading">
                  <strong>{t("添加建模对象")}</strong>
                </header>
                <div className="blender-live-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void apply(t("添加白模方块"), (revision, sceneEpoch) =>
                        createBlenderPrimitiveBatch({
                          expectedSceneEpoch: sceneEpoch,
                          expectedRevision: revision,
                        }),
                      )
                    }
                    type="button"
                  >
                    <Box aria-hidden size={13} /> {t("方块")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void apply(t("添加镜头相机"), createBlenderCameraBatch)}
                    type="button"
                  >
                    <Camera aria-hidden size={13} /> {t("镜头相机")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void apply(t("添加主光"), createBlenderLightBatch)}
                    type="button"
                  >
                    <Lightbulb aria-hidden size={13} /> {t("主光")}
                  </button>
                </div>
              </section>

              {walls.length > 0 ? (
                <section className="blender-tool-section">
                  <header className="blender-tool-section-heading">
                    <strong>{t("门窗洞口")}</strong>
                    <small>{t("选择墙体后创建非破坏布尔洞口")}</small>
                  </header>
                  <div className="blender-live-openings">
                    <label>
                      <span>{t("目标墙体")}</span>
                      <select onChange={(event) => setWallId(event.currentTarget.value)} value={wallId}>
                        {walls.map((wall) => (
                          <option key={wall.id} value={wall.id}>
                            {wall.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div>
                      <button
                        disabled={busy || !wallId}
                        onClick={() =>
                          void apply(t("创建 Blender 门洞"), (revision, sceneEpoch) =>
                            createBlenderOpeningBatch({
                              targetId: wallId,
                              kind: "door",
                              expectedSceneEpoch: sceneEpoch,
                              expectedRevision: revision,
                            }),
                          )
                        }
                        type="button"
                      >
                        <DoorOpen aria-hidden size={13} /> {t("门洞")}
                      </button>
                      <button
                        disabled={busy || !wallId}
                        onClick={() =>
                          void apply(t("创建 Blender 窗洞"), (revision, sceneEpoch) =>
                            createBlenderOpeningBatch({
                              targetId: wallId,
                              kind: "window",
                              expectedSceneEpoch: sceneEpoch,
                              expectedRevision: revision,
                            }),
                          )
                        }
                        type="button"
                      >
                        {t("窗洞")}
                      </button>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </>
      ) : connected ? (
        <div className="blender-live-empty is-syncing" role="status">
          <span className="blender-live-empty-icon">
            <LoaderCircle aria-hidden className="blender-live-spin" size={14} />
          </span>
          <div className="blender-live-empty-copy">
            <strong>{t("正在同步 Blender 场景…")}</strong>
          </div>
        </div>
      ) : (
        <div className="blender-live-empty">
          <div className="blender-live-empty-copy">
            <strong>{t("Blender 未连接")}</strong>
          </div>
          <div className="blender-live-launch">
            <span>{t("在项目根目录运行:")}</span>
            <div className="blender-live-launch-command">
              <code>{BLENDER_LAUNCH_COMMAND}</code>
              <button
                aria-label={t("复制启动命令")}
                onClick={() => void copyLaunchCommand()}
                title={t("复制启动命令")}
                type="button"
              >
                {commandCopied ? t("已复制") : t("复制")}
              </button>
            </div>
          </div>
          <button
            className="blender-live-retry"
            disabled={checking}
            onClick={() => void retryConnection()}
            type="button"
          >
            <RefreshCw aria-hidden className={checking ? "blender-live-spin" : undefined} size={13} />
            {checking ? t("正在检测…") : t("重新检测")}
          </button>
        </div>
      )}

      {notice ? <output className={`blender-live-notice is-${notice.tone}`}>{notice.text}</output> : null}
    </section>
  );
}
