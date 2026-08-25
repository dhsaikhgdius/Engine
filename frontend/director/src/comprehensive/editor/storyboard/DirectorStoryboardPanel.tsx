/**
 * Full storyboard panel: shot list, metadata, thumbnail capture, and generation handoff.
 *
 * @module DirectorStoryboardPanel
 */

import {
  ArrowDown,
  ArrowUp,
  Camera,
  Clapperboard,
  Copy,
  FileDown,
  Film,
  ImagePlus,
  Images,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePersistentCreativeMediaAssets } from "../media/persistentCreativeMediaStore";
import {
  DIRECTOR_STORYBOARD_MOVEMENTS,
  DIRECTOR_STORYBOARD_SHOT_SIZES,
  type DirectorProject,
  type DirectorStoryboard,
  type DirectorStoryboardShot,
} from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { getDirectorProjectRevision } from "../schema/directorProjectRevision";
import { MAX_DIRECTOR_TIMELINE_FRAME } from "../timeline/frameTime";
import {
  createEmptyDirectorStoryboard,
  duplicateStoryboardShot,
  insertStoryboardShotAtFrame,
  getStoryboardShotDuration,
  reorderStoryboardShot,
  sortStoryboardShots,
} from "./directorStoryboard";
import { captureDirectorStoryboardThumbnail } from "./storyboardCapture";
import { DirectorStoryboardExportDialog } from "./DirectorStoryboardExportDialog";
import { saveDirectorGenerationPromptHandoff } from "../workspaces/generationPromptHandoff";

function clampFrame(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

/**
 * Renders the storyboard panel with shot cards, thumbnails, frame-range editing,
 * shot reordering, PDF export, and AI generation handoff per shot.
 */
export function DirectorStoryboardPanel({
  currentFrame,
  onFrameChange,
  onFrameCommit,
  onOpenTimeline,
  onSelectedShotChange,
  project,
  selectedShotId: controlledSelectedShotId,
}: {
  currentFrame: number;
  onFrameChange: (frame: number) => void;
  onFrameCommit: (frame: number) => void;
  onOpenTimeline?: () => void;
  onSelectedShotChange?: (id: string | null) => void;
  project: DirectorProject;
  selectedShotId?: string | null;
}) {
  const updateStoryboard = useDirectorStore((state) => state.updateStoryboard);
  const updateScene = useDirectorStore((state) => state.updateScene);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);
  const mediaAssets = usePersistentCreativeMediaAssets();
  const [uncontrolledSelectedShotId, setUncontrolledSelectedShotId] = useState<string | null>(
    project.storyboard?.shots[0]?.id ?? null,
  );
  const [exportSelectedShotIds, setExportSelectedShotIds] = useState<Set<string>>(new Set());
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [captureBusy, setCaptureBusy] = useState<string | "batch" | null>(null);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const storyboard = project.storyboard ?? createEmptyDirectorStoryboard();
  const shots = useMemo(() => sortStoryboardShots(storyboard.shots), [storyboard.shots]);
  const timeline = project.scene.timeline;
  const selectedShotId = controlledSelectedShotId === undefined ? uncontrolledSelectedShotId : controlledSelectedShotId;
  const mediaUrlById = useMemo(
    () => new Map(mediaAssets.map((asset) => [asset.id, asset.objectUrl] as const)),
    [mediaAssets],
  );

  const selectShot = useCallback(
    (id: string | null) => {
      if (controlledSelectedShotId === undefined) setUncontrolledSelectedShotId(id);
      onSelectedShotChange?.(id);
    },
    [controlledSelectedShotId, onSelectedShotChange],
  );

  useEffect(() => {
    if (selectedShotId && shots.some((shot) => shot.id === selectedShotId)) return;
    selectShot(shots[0]?.id ?? null);
  }, [selectShot, selectedShotId, shots]);

  useEffect(() => {
    const available = new Set(shots.map((shot) => shot.id));
    setExportSelectedShotIds((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [shots]);

  function writeStoryboard(next: DirectorStoryboard) {
    updateStoryboard({ ...next, shots: sortStoryboardShots(next.shots) });
  }

  function updateMetadata(patch: Partial<Pick<DirectorStoryboard, "title" | "logline">>) {
    writeStoryboard({ ...storyboard, ...patch });
  }

  function updateShot(id: string, patch: Partial<DirectorStoryboardShot>) {
    if (!timeline) return;
    const orderedShots = sortStoryboardShots(storyboard.shots);
    const currentIndex = orderedShots.findIndex((shot) => shot.id === id);
    const previous = currentIndex > 0 ? orderedShots[currentIndex - 1] : null;
    const next = currentIndex >= 0 && currentIndex < orderedShots.length - 1 ? orderedShots[currentIndex + 1] : null;
    const minimumFrame = previous ? previous.frameEnd + 1 : timeline.frameStart;
    const maximumFrame = next ? next.frameStart - 1 : timeline.frameEnd;
    const shotsWithPatch = storyboard.shots.map((shot) => {
      if (shot.id !== id) return shot;
      const merged = { ...shot, ...patch };
      const frameStart = clampFrame(merged.frameStart, minimumFrame, maximumFrame);
      const frameEnd = Math.max(frameStart, clampFrame(merged.frameEnd, minimumFrame, maximumFrame));
      return { ...merged, frameStart, frameEnd };
    });
    writeStoryboard({ ...storyboard, shots: shotsWithPatch });
  }

  function applyShot(shot: DirectorStoryboardShot) {
    selectShot(shot.id);
    if (shot.cameraId) setActiveCamera(shot.cameraId);
    onFrameChange(shot.frameStart);
    onFrameCommit(shot.frameStart);
  }

  function addCurrentCameraShot() {
    if (!timeline) return;
    const result = insertStoryboardShotAtFrame({ project, currentFrame, timeline });
    writeStoryboard(result.storyboard);
    if (result.frameEnd > timeline.frameEnd) {
      updateScene({ timeline: { ...timeline, frameEnd: result.frameEnd } });
    }
    selectShot(result.shot.id);
    if (result.shot.cameraId) void captureShotThumbnail(result.shot.id);
  }

  function deleteShot(id: string) {
    writeStoryboard({ ...storyboard, shots: storyboard.shots.filter((shot) => shot.id !== id) });
    if (selectedShotId === id) selectShot(null);
  }

  function ensureTimelineContains(shotsToFit: DirectorStoryboardShot[]) {
    if (!timeline) return;
    const frameEnd = Math.max(timeline.frameEnd, ...shotsToFit.map((shot) => shot.frameEnd));
    if (frameEnd > timeline.frameEnd) updateScene({ timeline: { ...timeline, frameEnd } });
  }

  function moveShot(id: string, direction: "earlier" | "later") {
    if (!timeline) return;
    const nextShots = reorderStoryboardShot(storyboard.shots, id, direction, timeline.frameStart);
    writeStoryboard({ ...storyboard, shots: nextShots });
    ensureTimelineContains(nextShots);
  }

  function duplicateShot(id: string) {
    if (!timeline) return;
    const result = duplicateStoryboardShot(storyboard.shots, id, timeline.frameStart);
    writeStoryboard({ ...storyboard, shots: result.shots });
    ensureTimelineContains(result.shots);
    if (result.shot) selectShot(result.shot.id);
  }

  function toggleExportSelection(id: string) {
    setExportSelectedShotIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function captureShotThumbnail(shotId: string, fromBatch = false) {
    if (!fromBatch) setCaptureBusy(shotId);
    setCaptureError(false);
    setCaptureStatus(
      `正在捕获 ${useDirectorStore.getState().project.storyboard?.shots.find((shot) => shot.id === shotId)?.title ?? "分镜"}…`,
    );
    try {
      const liveProject = useDirectorStore.getState().project;
      const liveShot = liveProject.storyboard?.shots.find((shot) => shot.id === shotId);
      if (!liveShot) throw new Error(`分镜不存在：${shotId}`);
      const revision = getDirectorProjectRevision(liveProject);
      const { runWithDirectorProjectRevision } = await import("../../../agent/directorRevisionBoundCapture");
      const thumbnail = await runWithDirectorProjectRevision(revision, ({ project: immutableProject, signal }) => {
        const immutableShot = immutableProject.storyboard?.shots.find((shot) => shot.id === shotId);
        if (!immutableShot) throw new Error(`分镜不存在：${shotId}`);
        return captureDirectorStoryboardThumbnail(immutableProject, immutableShot, signal);
      });
      const latest = useDirectorStore.getState().project;
      const latestStoryboard = latest.storyboard ?? createEmptyDirectorStoryboard();
      updateStoryboard({
        ...latestStoryboard,
        shots: latestStoryboard.shots.map((shot) => (shot.id === shotId ? { ...shot, thumbnail } : shot)),
      });
      setCaptureStatus(`${liveShot.title} 已绑定 F${liveShot.frameStart} 的画面`);
      return true;
    } catch (error) {
      setCaptureError(true);
      setCaptureStatus(error instanceof Error ? error.message : "分镜截图失败");
      return false;
    } finally {
      if (!fromBatch) setCaptureBusy(null);
    }
  }

  async function captureMissingThumbnails() {
    if (captureBusy) return;
    const candidates = shots.filter(
      (shot) =>
        !shot.thumbnail || shot.thumbnail.cameraId !== shot.cameraId || shot.thumbnail.frame !== shot.frameStart,
    );
    if (!candidates.length) {
      setCaptureError(false);
      setCaptureStatus("所有分镜画面都与当前机位和入点帧一致");
      return;
    }
    setCaptureBusy("batch");
    let completed = 0;
    for (const shot of candidates) {
      if (await captureShotThumbnail(shot.id, true)) completed += 1;
    }
    setCaptureBusy(null);
    setCaptureError(completed !== candidates.length);
    setCaptureStatus(`批量捕获完成：${completed}/${candidates.length} 镜`);
  }

  function clearThumbnail(shotId: string) {
    const nextShots = storyboard.shots.map((shot) => {
      if (shot.id !== shotId || !shot.thumbnail) return shot;
      const { thumbnail: _thumbnail, ...withoutThumbnail } = shot;
      return withoutThumbnail;
    });
    writeStoryboard({ ...storyboard, shots: nextShots });
  }

  function openShotGeneration(shot: DirectorStoryboardShot) {
    const shotSize = DIRECTOR_STORYBOARD_SHOT_SIZES.find((entry) => entry.id === shot.shotSize)?.label ?? shot.shotSize;
    const movement = DIRECTOR_STORYBOARD_MOVEMENTS.find((entry) => entry.id === shot.movement)?.label ?? shot.movement;
    const prompt = [
      shot.title,
      shot.action.trim(),
      shot.notes?.trim(),
      `${shotSize}，${movement}`,
      shot.cameraId
        ? `Director camera: ${project.cameras.find((camera) => camera.id === shot.cameraId)?.name ?? shot.cameraId}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const saved = saveDirectorGenerationPromptHandoff({
      source: "storyboard",
      mediaKind: "image",
      targetModel: "generic",
      prompt,
      negativePrompt: "unreadable text, broken continuity, unintended extra subjects",
      workflowId: shot.generation?.workflowId ?? null,
      nodeIds: shot.generation?.nodeIds ?? [],
      parameters: shot.generation?.parameters ?? {},
      referenceMediaId: shot.thumbnail?.mediaId ?? null,
      referenceImages: Object.fromEntries(
        (shot.generation?.referenceImages ?? []).map((binding) => [binding.parameterId, binding.mediaId]),
      ),
      metadata: {
        shotId: shot.id,
        shotTitle: shot.title,
        frameStart: shot.frameStart,
        frameEnd: shot.frameEnd,
        shotSize: shot.shotSize,
        movement: shot.movement,
        ...(shot.cameraId ? { cameraId: shot.cameraId } : {}),
      },
    });
    if (!saved) {
      setCaptureError(true);
      setCaptureStatus("无法建立分镜生成上下文");
      return;
    }
    setCaptureError(false);
    setCaptureStatus("已保存分镜生成上下文");
  }

  return (
    <div
      aria-labelledby="director-bottom-storyboard-tab"
      className="storyboard-panel"
      id="director-bottom-storyboard"
      role="tabpanel"
    >
      <header className="storyboard-panel-header">
        <div className="storyboard-panel-heading">
          <span className="storyboard-panel-icon">
            <Clapperboard aria-hidden size={17} />
          </span>
          <div>
            <strong>导演分镜</strong>
            <span>{shots.length} 镜 · 与相机、帧区间和动作时间轴同步</span>
          </div>
        </div>
        <div className="storyboard-panel-actions">
          <button
            disabled={Boolean(captureBusy) || shots.length === 0}
            onClick={() => void captureMissingThumbnails()}
            type="button"
          >
            {captureBusy === "batch" ? (
              <Loader2 aria-hidden className="is-spinning" size={14} />
            ) : (
              <Images aria-hidden size={14} />
            )}
            补齐画面
          </button>
          <button disabled={shots.length === 0} onClick={() => setShowExportDialog(true)} type="button">
            <FileDown aria-hidden size={14} /> 导出 PDF
          </button>
          {onOpenTimeline ? (
            <button aria-label="切换到分镜轴" onClick={onOpenTimeline} type="button">
              <Film aria-hidden size={14} /> 分镜轴
            </button>
          ) : null}
          <button
            className="storyboard-add-shot"
            disabled={Boolean(captureBusy)}
            onClick={addCurrentCameraShot}
            type="button"
          >
            <Plus aria-hidden size={14} /> 从当前机位添加
          </button>
        </div>
      </header>

      {captureStatus ? (
        <div aria-live="polite" className={`storyboard-capture-status${captureError ? " is-error" : ""}`}>
          {captureBusy ? <Loader2 aria-hidden className="is-spinning" size={12} /> : null}
          <span>{captureStatus}</span>
        </div>
      ) : null}

      <div className="storyboard-meta-fields">
        <label>
          <span>分镜标题</span>
          <input
            aria-label="分镜标题"
            onChange={(event) => updateMetadata({ title: event.target.value })}
            value={storyboard.title}
          />
        </label>
        <label>
          <span>导演意图</span>
          <input
            aria-label="导演意图"
            onChange={(event) => updateMetadata({ logline: event.target.value })}
            value={storyboard.logline}
          />
        </label>
      </div>

      {shots.length ? (
        <div aria-label="分镜列表" className="storyboard-shot-list">
          {shots.map((shot, index) => {
            const active = selectedShotId === shot.id;
            const thumbnailUrl = shot.thumbnail ? mediaUrlById.get(shot.thumbnail.mediaId) : null;
            const staleThumbnail = Boolean(
              shot.thumbnail && (shot.thumbnail.cameraId !== shot.cameraId || shot.thumbnail.frame !== shot.frameStart),
            );
            return (
              <article className={`storyboard-shot-card${active ? " is-selected" : ""}`} key={shot.id}>
                <header>
                  <button
                    aria-label={`切换到分镜 ${shot.title}`}
                    className="storyboard-shot-jump"
                    onClick={() => applyShot(shot)}
                    type="button"
                  >
                    <span className="storyboard-shot-index">{String(index + 1).padStart(2, "0")}</span>
                    <span>
                      <strong data-i18n-user-content>{shot.title}</strong>
                      <small>
                        <Film aria-hidden size={12} /> F{shot.frameStart}–F{shot.frameEnd} ·{" "}
                        {getStoryboardShotDuration(shot, timeline?.fps ?? 24).toFixed(1)}s
                      </small>
                    </span>
                  </button>
                  <div className="storyboard-shot-toolbar">
                    <label className="storyboard-export-select" title="选择用于局部导出">
                      <input
                        aria-label={`选择导出分镜 ${shot.title}`}
                        checked={exportSelectedShotIds.has(shot.id)}
                        onChange={() => toggleExportSelection(shot.id)}
                        type="checkbox"
                      />
                    </label>
                    <button
                      aria-label={`前移分镜 ${shot.title}`}
                      disabled={index === 0}
                      onClick={() => moveShot(shot.id, "earlier")}
                      type="button"
                    >
                      <ArrowUp aria-hidden size={13} />
                    </button>
                    <button
                      aria-label={`后移分镜 ${shot.title}`}
                      disabled={index === shots.length - 1}
                      onClick={() => moveShot(shot.id, "later")}
                      type="button"
                    >
                      <ArrowDown aria-hidden size={13} />
                    </button>
                    <button aria-label={`复制分镜 ${shot.title}`} onClick={() => duplicateShot(shot.id)} type="button">
                      <Copy aria-hidden size={13} />
                    </button>
                    <button
                      aria-label={`生成分镜 ${shot.title}`}
                      onClick={() => openShotGeneration(shot)}
                      type="button"
                    >
                      <Sparkles aria-hidden size={13} />
                    </button>
                    <button
                      aria-label={`删除分镜 ${shot.title}`}
                      className="storyboard-shot-delete"
                      onClick={() => deleteShot(shot.id)}
                      type="button"
                    >
                      <Trash2 aria-hidden size={14} />
                    </button>
                  </div>
                </header>

                <div className="storyboard-thumbnail">
                  {thumbnailUrl ? (
                    <img alt={`${shot.title} 分镜画面`} src={thumbnailUrl} />
                  ) : (
                    <div className="storyboard-thumbnail-placeholder">
                      <span>{shot.thumbnail ? "缩略图媒体加载中或已缺失" : "尚未捕获本镜入点画面"}</span>
                    </div>
                  )}
                  {staleThumbnail ? <em className="storyboard-thumbnail-badge">机位或帧已变化 · 待重拍</em> : null}
                  <div className="storyboard-thumbnail-footer">
                    <span>{shot.thumbnail ? `F${shot.thumbnail.frame} · 已捕获` : `目标 F${shot.frameStart}`}</span>
                    <div className="storyboard-thumbnail-actions">
                      <button
                        disabled={Boolean(captureBusy) || !shot.cameraId}
                        onClick={() => void captureShotThumbnail(shot.id)}
                        type="button"
                      >
                        {captureBusy === shot.id ? (
                          <Loader2 aria-hidden className="is-spinning" size={12} />
                        ) : shot.thumbnail ? (
                          <RefreshCw aria-hidden size={12} />
                        ) : (
                          <ImagePlus aria-hidden size={12} />
                        )}
                        {shot.thumbnail ? "重拍" : "捕获"}
                      </button>
                      {shot.thumbnail ? (
                        <button
                          aria-label={`移除分镜画面 ${shot.title}`}
                          onClick={() => clearThumbnail(shot.id)}
                          type="button"
                        >
                          <X aria-hidden size={12} /> 移除
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="storyboard-shot-grid">
                  <label>
                    <span>镜名</span>
                    <input
                      aria-label={`${shot.title} 镜名`}
                      onChange={(event) => updateShot(shot.id, { title: event.target.value })}
                      value={shot.title}
                    />
                  </label>
                  <label>
                    <span>
                      <Camera aria-hidden size={12} /> 机位
                    </span>
                    <select
                      aria-label={`${shot.title} 机位`}
                      onChange={(event) => updateShot(shot.id, { cameraId: event.target.value || null })}
                      value={shot.cameraId ?? ""}
                    >
                      <option value="">未指定机位</option>
                      {project.cameras.map((camera) => (
                        <option data-i18n-user-content key={camera.id} value={camera.id}>
                          {camera.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>入点帧</span>
                    <input
                      aria-label={`${shot.title} 入点帧`}
                      max={MAX_DIRECTOR_TIMELINE_FRAME}
                      min={timeline?.frameStart ?? 0}
                      onChange={(event) => updateShot(shot.id, { frameStart: Number(event.target.value) })}
                      type="number"
                      value={shot.frameStart}
                    />
                  </label>
                  <label>
                    <span>出点帧</span>
                    <input
                      aria-label={`${shot.title} 出点帧`}
                      max={MAX_DIRECTOR_TIMELINE_FRAME}
                      min={shot.frameStart}
                      onChange={(event) => updateShot(shot.id, { frameEnd: Number(event.target.value) })}
                      type="number"
                      value={shot.frameEnd}
                    />
                  </label>
                  <label>
                    <span>景别</span>
                    <select
                      aria-label={`${shot.title} 景别`}
                      onChange={(event) =>
                        updateShot(shot.id, { shotSize: event.target.value as DirectorStoryboardShot["shotSize"] })
                      }
                      value={shot.shotSize}
                    >
                      {DIRECTOR_STORYBOARD_SHOT_SIZES.map((size) => (
                        <option key={size.id} value={size.id}>
                          {size.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>运镜</span>
                    <select
                      aria-label={`${shot.title} 运镜`}
                      onChange={(event) =>
                        updateShot(shot.id, { movement: event.target.value as DirectorStoryboardShot["movement"] })
                      }
                      value={shot.movement}
                    >
                      {DIRECTOR_STORYBOARD_MOVEMENTS.map((movement) => (
                        <option key={movement.id} value={movement.id}>
                          {movement.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="storyboard-shot-action">
                  <span>调度 / 表演</span>
                  <textarea
                    aria-label={`${shot.title} 调度与表演`}
                    onChange={(event) => updateShot(shot.id, { action: event.target.value })}
                    value={shot.action}
                  />
                </label>
                <div className="storyboard-shot-production">
                  <div className="storyboard-shot-rating" role="group" aria-label={`${shot.title} 分镜评分`}>
                    <span>评分</span>
                    {[1, 2, 3, 4, 5].map((rating) => (
                      <button
                        aria-label={`${shot.title} ${rating} 星`}
                        aria-pressed={(shot.rating ?? 0) === rating}
                        key={rating}
                        onClick={() => updateShot(shot.id, { rating: (shot.rating ?? 0) === rating ? 0 : rating })}
                        type="button"
                      >
                        <Star aria-hidden fill={(shot.rating ?? 0) >= rating ? "currentColor" : "none"} size={13} />
                      </button>
                    ))}
                  </div>
                  <label className="storyboard-shot-notes">
                    <span>制作备注（支持 Markdown 文本）</span>
                    <textarea
                      aria-label={`${shot.title} 制作备注`}
                      maxLength={20_000}
                      onChange={(event) => updateShot(shot.id, { notes: event.target.value })}
                      placeholder="灯光、连续性、生成反馈、修改清单…"
                      value={shot.notes ?? ""}
                    />
                  </label>
                  <div className="storyboard-shot-generation-history">
                    <header>
                      <span>生成记录</span>
                      <button onClick={() => openShotGeneration(shot)} type="button">
                        <Sparkles aria-hidden size={12} />
                        {shot.generation?.workflowId ? "继续生成" : "发送到生成工作区"}
                      </button>
                    </header>
                    {shot.generation?.outputs.length ? (
                      <ol>
                        {shot.generation.outputs
                          .slice()
                          .reverse()
                          .map((output) => (
                            <li key={output.jobId}>
                              <span>{output.kind.replace(".generate", "")}</span>
                              <strong>{output.mediaIds.length} 个成品</strong>
                              <small>
                                Seed {output.seed} · {new Date(output.promotedAt).toLocaleString()}
                              </small>
                            </li>
                          ))}
                      </ol>
                    ) : (
                      <p>尚无生成成品；捕获画面与 AI 生成历史分开保存。</p>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="storyboard-empty">
          <Film aria-hidden size={24} />
          <strong>还没有分镜</strong>
          <p>从当前机位建立一个镜头，或加载包含人物调度、机位运动和完整分镜的教室示例。</p>
        </div>
      )}
      {showExportDialog ? (
        <DirectorStoryboardExportDialog
          initialSelectedShotIds={[...exportSelectedShotIds]}
          onClose={() => setShowExportDialog(false)}
          project={project}
        />
      ) : null}
    </div>
  );
}
