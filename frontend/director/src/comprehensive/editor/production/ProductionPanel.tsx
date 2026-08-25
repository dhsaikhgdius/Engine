/**
 * @module ProductionPanel
 * @description Sidebar or scene-browser panel that manages the production
 *   manifest: scene list, scene thumbnails, editorial cut timeline, and
 *   scene creation/duplication/switch operations.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Camera,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  CopyPlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Scissors,
  Trash2,
} from "lucide-react";
import { useDirectorSessionRuntime } from "../session/directorSessionRuntime";
import { requestViewportCapture } from "../io/captureBridge";
import type { DirectorProject } from "../schema/directorProject";
import { createDefaultDirectorProject, useDirectorStore } from "../store/directorStore";
import {
  createDirectorProductionScene,
  DirectorProductionClientError,
  getDirectorProduction,
  type DirectorProductionRecord,
  type EditorialShot,
  updateDirectorProduction,
} from "./productionClient";
import {
  ensureSceneCameraThumbnail,
  getSceneCameraThumbnails,
  rememberSceneCameraThumbnail,
  subscribeSceneCameraThumbnails,
} from "./sceneCameraThumbnailCache";

const PRODUCTION_ID = "main";

function shortRevision(value: number | null | undefined) {
  return Number.isSafeInteger(value) ? `r${value}` : "未保存";
}

function makeSceneId() {
  return `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeShotId() {
  return `cut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function messageFrom(error: unknown) {
  if (error instanceof DirectorProductionClientError) return error.message;
  return error instanceof Error ? error.message : "制作项目操作失败";
}

function requestSceneSwitch(sceneId: string, seedProject?: DirectorProject) {
  const activationId = `director-activation-ui:${crypto.randomUUID()}`;
  window.parent?.postMessage(
    {
      type: "storyai:director-desk-switch-scene",
      payload: { sceneId, activationId, ...(seedProject ? { project: seedProject } : {}) },
    },
    window.location.origin,
  );
  return activationId;
}

function SceneThumbnail({
  scene,
  thumbnailUrl,
  size = "compact",
}: {
  scene: { title: string; sceneId: string };
  thumbnailUrl?: string;
  size?: "compact" | "large";
}) {
  return (
    <span
      aria-hidden="true"
      className={`production-scene-thumbnail${size === "large" ? " is-large" : ""}`}
      data-testid={`scene-thumbnail-${scene.sceneId}`}
    >
      {thumbnailUrl ? (
        <img alt="" className="production-scene-thumbnail-image" src={thumbnailUrl} />
      ) : (
        <span className="production-scene-thumbnail-empty">
          <Camera size={size === "large" ? 19 : 15} />
          <small>未生成机位画面</small>
        </span>
      )}
    </span>
  );
}

export function ProductionPanel({ variant = "sidebar" }: { variant?: "sidebar" | "scene-browser" }) {
  const sceneId = useDirectorSessionRuntime((state) => state.sceneId);
  const sceneRevision = useDirectorSessionRuntime((state) => state.revision);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const cameras = useDirectorStore((state) => state.project.cameras);
  const timeline = useDirectorStore((state) => state.project.scene.timeline);
  const [record, setRecord] = useState<DirectorProductionRecord | null>(null);
  const [sceneTitle, setSceneTitle] = useState("新场景");
  const [sceneListExpanded, setSceneListExpanded] = useState(true);
  const [cutListExpanded, setCutListExpanded] = useState(true);
  const [switchingSceneId, setSwitchingSceneId] = useState<string | null>(null);
  const [switchingActivationId, setSwitchingActivationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const sceneCameraThumbnails = useSyncExternalStore(
    subscribeSceneCameraThumbnails,
    getSceneCameraThumbnails,
    getSceneCameraThumbnails,
  );

  const currentScene = useMemo(
    () => record?.production.scenes.find((item) => item.sceneId === sceneId) ?? null,
    [record, sceneId],
  );
  const sceneBrowser = variant === "scene-browser";
  const sceneListLabel = sceneBrowser ? "场景缩略图库" : "场景列表";
  const currentCamera = useMemo(
    () => cameras.find((camera) => camera.id === activeCameraId) ?? cameras[0] ?? null,
    [activeCameraId, cameras],
  );

  async function captureCurrentCameraThumbnail() {
    if (!sceneId || !currentCamera) {
      setStatus("当前场景没有活动机位；添加机位后才能生成真实缩略图");
      return;
    }
    try {
      const [capture] = await requestViewportCapture({
        preset: "current",
        source: "camera-panel",
        cameraId: currentCamera.id,
      });
      if (!capture?.dataUrl) throw new Error("机位没有返回可用画面");
      rememberSceneCameraThumbnail(sceneId, capture.dataUrl);
      setStatus("已更新当前机位缩略图");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "生成机位缩略图失败");
    }
  }

  useEffect(() => {
    if (!sceneId || !currentCamera) return;
    if (currentCamera.lastCaptureUrl?.startsWith("data:image/")) {
      rememberSceneCameraThumbnail(sceneId, currentCamera.lastCaptureUrl);
      return;
    }
    if (sceneCameraThumbnails[sceneId]) return;
    // DirectorCanvas registers its capture handler after mount. Delay once so
    // both the left and bottom browsers share one real current-camera capture.
    const timer = window.setTimeout(() => {
      void ensureSceneCameraThumbnail(sceneId, async () => {
        const [capture] = await requestViewportCapture({
          preset: "current",
          source: "camera-panel",
          cameraId: currentCamera.id,
        });
        return capture?.dataUrl ?? null;
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [currentCamera, sceneCameraThumbnails, sceneId]);

  useEffect(() => {
    if (!switchingSceneId) return;
    const timeout = window.setTimeout(() => {
      setSwitchingSceneId(null);
      setSwitchingActivationId(null);
      setStatus("宿主未确认场景切换；请重试或刷新制作项目");
    }, 18_000);
    return () => window.clearTimeout(timeout);
  }, [switchingSceneId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      if (
        event.data?.type !== "storyai:director-desk-scene-switch-failed" &&
        event.data?.type !== "storyai:director-desk-scene-switch-ready"
      )
        return;
      const nextSceneId = typeof event.data?.payload?.sceneId === "string" ? event.data.payload.sceneId : "";
      if (!nextSceneId || nextSceneId !== switchingSceneId) return;
      const nextActivationId =
        typeof event.data?.payload?.activationId === "string" ? event.data.payload.activationId : "";
      if (switchingActivationId && nextActivationId && nextActivationId !== switchingActivationId) return;
      setSwitchingSceneId(null);
      setSwitchingActivationId(null);
      setStatus(
        event.data.type === "storyai:director-desk-scene-switch-ready"
          ? ""
          : typeof event.data?.payload?.message === "string"
            ? event.data.payload.message
            : "场景切换失败",
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [switchingActivationId, switchingSceneId]);

  async function refresh({ ensureCurrent = false } = {}) {
    const next = await getDirectorProduction(PRODUCTION_ID);
    if (ensureCurrent && sceneId && !next.production.scenes.some((item) => item.sceneId === sceneId)) {
      const registered = await updateDirectorProduction(
        PRODUCTION_ID,
        next.revision,
        [
          {
            op: "add_scene_reference",
            sceneId,
            title: `场景 ${next.production.scenes.length + 1}`,
          },
        ],
        "director-desk:register-current-scene",
        undefined,
        [{ sceneId, project: structuredClone(useDirectorStore.getState().project) }],
      );
      setRecord(registered);
      return registered;
    }
    setRecord(next);
    return next;
  }

  useEffect(() => {
    if (!sceneId) return;
    let cancelled = false;
    if (!switchingSceneId) setStatus("");
    void refresh({ ensureCurrent: Boolean(sceneId) }).catch((error) => {
      if (!cancelled) setStatus(messageFrom(error));
    });
    return () => {
      cancelled = true;
    };
    // The host bridge changes sceneId after an acknowledged scene switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  async function withBusy(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      await task();
    } catch (error) {
      setStatus(messageFrom(error));
      try {
        await refresh();
      } catch {
        // The first user-visible error is more actionable than this reload failure.
      }
    } finally {
      setBusy(false);
    }
  }

  function switchScene(targetSceneId: string) {
    void withBusy(async () => {
      const current = record ?? (await refresh({ ensureCurrent: Boolean(sceneId) }));
      const next =
        current.production.activeSceneId === targetSceneId
          ? current
          : await updateDirectorProduction(PRODUCTION_ID, current.revision, [
              {
                op: "set_active_scene",
                sceneId: targetSceneId,
              },
            ]);
      setRecord(next);
      setSwitchingSceneId(targetSceneId);
      setSwitchingActivationId(requestSceneSwitch(targetSceneId));
      setStatus(`正在切换到 ${targetSceneId}…`);
    });
  }

  function createScene({ duplicate = false } = {}) {
    void withBusy(async () => {
      const current = record ?? (await refresh({ ensureCurrent: Boolean(sceneId) }));
      // The production manifest only owns scene references. Capture the loaded
      // project before the async manifest mutation so a duplicate receives an
      // independent scoped-project seed instead of opening as an empty scene.
      const seedProject = duplicate
        ? structuredClone(useDirectorStore.getState().project)
        : createDefaultDirectorProject();
      const title = duplicate
        ? currentScene?.title || `场景 ${current.production.scenes.length + 1}`
        : sceneTitle.trim() || "新场景";
      const next = await createDirectorProductionScene({
        productionId: PRODUCTION_ID,
        expectedRevision: current.revision,
        sceneId: makeSceneId(),
        title,
        ...(duplicate && sceneId ? { sourceSceneId: sceneId } : {}),
        project: seedProject,
      });
      const createdSceneId = next.production.activeSceneId;
      setRecord(next);
      setSceneTitle("新场景");
      if (createdSceneId) {
        setSwitchingSceneId(createdSceneId);
        setSwitchingActivationId(requestSceneSwitch(createdSceneId, seedProject));
        setStatus(`正在切换到 ${createdSceneId}…`);
      }
    });
  }

  function addCurrentCameraToCut() {
    void withBusy(async () => {
      const current = record ?? (await refresh({ ensureCurrent: Boolean(sceneId) }));
      if (!sceneId || !current.production.scenes.some((item) => item.sceneId === sceneId)) {
        throw new Error("当前场景尚未注册到制作项目");
      }
      const frameStart = timeline?.frameStart ?? 1;
      const frameEnd = timeline?.frameEnd ?? Math.max(frameStart, 48);
      const shot: Omit<EditorialShot, "sourceRevision"> = {
        id: makeShotId(),
        label: activeCameraId ? `机位 ${activeCameraId}` : "当前场景段落",
        sceneId,
        cameraId: activeCameraId || null,
        frameStart,
        frameEnd,
        mode: "linked",
      };
      const next = await updateDirectorProduction(PRODUCTION_ID, current.revision, [
        {
          op: "add_editorial_shot",
          shot,
        },
      ]);
      setRecord(next);
    });
  }

  function removeCut(shotId: string) {
    void withBusy(async () => {
      if (!record) return;
      const next = await updateDirectorProduction(PRODUCTION_ID, record.revision, [
        {
          op: "remove_editorial_shot",
          id: shotId,
        },
      ]);
      setRecord(next);
    });
  }

  function removeScene(targetSceneId: string) {
    void withBusy(async () => {
      let current = record ?? (await refresh({ ensureCurrent: Boolean(sceneId) }));
      if (!current.production.scenes.some((item) => item.sceneId === targetSceneId)) {
        throw new Error("场景不在制作项目中");
      }

      // Keep the production usable: replacing the last scene avoids ensureCurrent
      // immediately re-registering the deleted session on the next refresh.
      if (current.production.scenes.length <= 1) {
        const replacementProject = createDefaultDirectorProject();
        current = await createDirectorProductionScene({
          productionId: PRODUCTION_ID,
          expectedRevision: current.revision,
          sceneId: makeSceneId(),
          title: "新场景",
          project: replacementProject,
        });
      }

      const next = await updateDirectorProduction(PRODUCTION_ID, current.revision, [
        {
          op: "remove_scene_reference",
          sceneId: targetSceneId,
        },
      ]);
      setRecord(next);
      const nextActive = next.production.activeSceneId;
      if (nextActive && nextActive !== sceneId) {
        setSwitchingSceneId(nextActive);
        setSwitchingActivationId(requestSceneSwitch(nextActive));
        setStatus(`已删除场景，正在切换到 ${nextActive}…`);
        return;
      }
      setStatus("已删除场景");
    });
  }

  return (
    <section
      className={`production-panel${sceneBrowser ? " is-scene-browser" : ""}`}
      aria-label={sceneBrowser ? "场景缩略图" : "制作项目"}
    >
      <div className="production-panel-heading">
        <span className="production-panel-icon">
          <Clapperboard aria-hidden size={15} />
        </span>
        <div>
          <strong>{sceneBrowser ? "场景缩略图" : record?.production.title || "制作项目"}</strong>
          {sceneBrowser && record ? (
            <span>{`${record.production.scenes.length} 个场景 · ${shortRevision(record.revision)}`}</span>
          ) : null}
          {!sceneBrowser && !record ? <span>连接项目中</span> : null}
        </div>
        <button
          aria-label="刷新制作项目"
          className="production-icon-button"
          disabled={busy}
          onClick={() =>
            void withBusy(async () => {
              await refresh({ ensureCurrent: Boolean(sceneId) });
            })
          }
          type="button"
        >
          {busy ? (
            <LoaderCircle aria-hidden className="production-spin" size={14} />
          ) : (
            <RefreshCw aria-hidden size={14} />
          )}
        </button>
        {sceneBrowser ? (
          <button
            aria-label="更新当前机位缩略图"
            className="production-icon-button"
            disabled={busy || !currentCamera}
            onClick={() => void captureCurrentCameraThumbnail()}
            type="button"
          >
            <Camera aria-hidden size={14} />
          </button>
        ) : null}
        <button
          aria-expanded={sceneListExpanded}
          aria-label={`${sceneListExpanded ? "收起" : "展开"}${sceneBrowser ? "场景缩略图" : "场景"}列表`}
          className="production-icon-button"
          onClick={() => setSceneListExpanded((expanded) => !expanded)}
          type="button"
        >
          {sceneListExpanded ? <ChevronDown aria-hidden size={15} /> : <ChevronRight aria-hidden size={15} />}
        </button>
      </div>

      {sceneListExpanded ? (
        <div
          className={`production-scene-list${sceneBrowser ? " is-thumbnail-browser" : ""}`}
          aria-label={sceneListLabel}
        >
          {record?.production.scenes.map((scene) => {
            const selected = scene.sceneId === sceneId;
            return (
              <div
                className={`production-scene-row${selected ? " is-current" : ""}${sceneBrowser ? " is-thumbnail-card" : ""}`}
                key={scene.sceneId}
              >
                <button
                  aria-label={`${scene.title} ${selected ? shortRevision(sceneRevision) : shortRevision(scene.sourceRevision)}`}
                  aria-current={selected ? "page" : undefined}
                  className="production-scene-select"
                  disabled={busy}
                  onClick={() => switchScene(scene.sceneId)}
                  type="button"
                >
                  <SceneThumbnail
                    scene={scene}
                    size={sceneBrowser ? "large" : "compact"}
                    thumbnailUrl={sceneCameraThumbnails[scene.sceneId]}
                  />
                  <span className="production-scene-row-copy">
                    <span className="production-scene-row-title" data-i18n-user-content>
                      {scene.title}
                    </span>
                    <span className="production-scene-row-meta">{scene.sceneId}</span>
                  </span>
                  <span className="production-scene-row-revision">
                    {selected ? shortRevision(sceneRevision) : shortRevision(scene.sourceRevision)}
                  </span>
                </button>
                <button
                  aria-label={`删除场景 ${scene.title}`}
                  className="production-scene-delete"
                  disabled={busy}
                  onClick={() => removeScene(scene.sceneId)}
                  type="button"
                >
                  <Trash2 aria-hidden size={13} />
                </button>
              </div>
            );
          })}
          {record && record.production.scenes.length === 0 ? (
            <p className="production-empty">当前场景会在连接成功后加入项目。</p>
          ) : null}
        </div>
      ) : null}

      <div className="production-create-row">
        <input
          aria-label="新场景名称"
          disabled={busy}
          onChange={(event) => setSceneTitle(event.target.value)}
          placeholder="新场景名称"
          value={sceneTitle}
        />
        <button aria-label="创建空场景" disabled={busy} onClick={() => createScene()} type="button">
          <Plus aria-hidden size={14} />
        </button>
        <button
          aria-label="复制当前场景"
          disabled={busy || !sceneId}
          onClick={() => createScene({ duplicate: true })}
          type="button"
        >
          <CopyPlus aria-hidden size={14} />
        </button>
      </div>

      {!sceneBrowser ? (
        <>
          <div className="production-cut-heading">
            <span>
              <Scissors aria-hidden size={14} /> 剪辑轨
            </span>
            <div className="production-cut-heading-actions">
              <button
                aria-expanded={cutListExpanded}
                aria-label={`${cutListExpanded ? "收起" : "展开"}剪辑轨列表`}
                className="production-cut-collapse"
                onClick={() => setCutListExpanded((expanded) => !expanded)}
                type="button"
              >
                {cutListExpanded ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
              </button>
              <button disabled={busy || !currentScene} onClick={addCurrentCameraToCut} type="button">
                添加当前机位
              </button>
            </div>
          </div>
          {cutListExpanded ? (
            <div className="production-cut-list" aria-label="剪辑轨">
              {record?.production.editorialTimeline.map((shot) => (
                <div className="production-cut-row" key={shot.id}>
                  <button
                    className="production-cut-select"
                    disabled={busy}
                    onClick={() => switchScene(shot.sceneId)}
                    type="button"
                  >
                    <span data-i18n-user-content>{shot.label}</span>
                    <small>
                      {shot.sceneId} · F{shot.frameStart}–F{shot.frameEnd}
                    </small>
                  </button>
                  <button
                    aria-label={`删除剪辑段 ${shot.label}`}
                    className="production-cut-delete"
                    disabled={busy}
                    onClick={() => removeCut(shot.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden size={13} />
                  </button>
                </div>
              ))}
              {record && record.production.editorialTimeline.length === 0 ? (
                <p className="production-empty">剪辑轨只引用场景和机位，不复制动作数据。</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {status ? (
        <p className="production-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
