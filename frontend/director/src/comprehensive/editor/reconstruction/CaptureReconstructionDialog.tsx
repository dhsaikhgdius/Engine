/**
 * @module CaptureReconstructionDialog
 * @description Modal dialog for reconstructing a 3D scene from a video or
 *   RGB-D scan capture, with configurable key views, object budget, and
 *   an optional shell mesh import.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Check, CircleAlert, Clapperboard, DoorOpen, Loader2, ScanLine, X } from "lucide-react";
import type {
  CaptureReconstructionPlan,
  CaptureSourceKind,
} from "../../../../../../packages/protocol/src/captureReconstructionProtocol";
import type { ProductionJobRecord } from "../../../../../../packages/protocol/src/productionJobProtocol";
import { uploadBlenderModelAsset } from "../api/blenderLiveClient";
import { useModalDialogFocus } from "../../app/layout/useModalDialogFocus";
import { useSuppressViewportChromeWhileMounted } from "../canvas/viewportChromeSuppression";
import { useDirectorStore } from "../store/directorStore";
import { applyCaptureReconstructionPlan } from "./captureReconstructionApply";
import {
  detectCaptureSourceKind,
  fetchCaptureArtifactBlob,
  fetchCaptureReconstructionPlan,
  getCaptureReconstructionJob,
  stageCaptureSource,
  submitCaptureReconstruction,
} from "./captureReconstructionClient";
import "./referenceSceneReconstruction.css";
import "./captureReconstruction.css";

const POLL_INTERVAL_MS = 1_500;

const ROLE_LABELS: Record<string, string> = {
  floor: "地板",
  wall: "墙段",
  door: "门",
  window: "窗",
  item: "物体",
  shell: "外壳",
};

const POSE_LABELS: Record<CaptureReconstructionPlan["analysis"]["providers"]["poses"], string> = {
  bundle: "扫描包",
  estimated: "单视角估计",
  none: "无",
};

const DEPTH_LABELS: Record<CaptureReconstructionPlan["analysis"]["providers"]["depth"], string> = {
  sensor: "传感器",
  model: "单目模型",
  none: "无",
};

function roleCounts(plan: CaptureReconstructionPlan) {
  const counts = new Map<string, number>();
  for (const object of plan.objects) counts.set(object.role, (counts.get(object.role) ?? 0) + 1);
  return [...counts.entries()].map(([role, count]) => `${ROLE_LABELS[role] ?? role} ${count}`);
}

export function CaptureReconstructionDialog({
  onApplied,
  onClose,
}: {
  onApplied?: (message: string) => void;
  onClose: () => void;
}) {
  useSuppressViewportChromeWhileMounted("capture-reconstruction");
  const dialogRef = useModalDialogFocus<HTMLElement>({ onClose: () => close() });
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyframeUrlsRef = useRef<string[]>([]);
  const project = useDirectorStore((state) => state.project);
  const replaceProject = useDirectorStore((state) => state.replaceProject);
  const selectObjects = useDirectorStore((state) => state.selectObjects);

  const [file, setFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<CaptureSourceKind>("rgb-video");
  const [prompt, setPrompt] = useState("");
  const [maxKeyViews, setMaxKeyViews] = useState(6);
  const [maxObjects, setMaxObjects] = useState(24);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [includeCameras, setIncludeCameras] = useState(true);
  const [includeShell, setIncludeShell] = useState(false);
  const [busy, setBusy] = useState<"reconstructing" | "applying" | null>(null);
  const [job, setJob] = useState<ProductionJobRecord | null>(null);
  const [plan, setPlan] = useState<CaptureReconstructionPlan | null>(null);
  const [keyframes, setKeyframes] = useState<Array<{ viewId: string; url: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      keyframeUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  function close() {
    abortRef.current?.abort();
    onClose();
  }

  function selectCapture(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!nextFile) return;
    setFile(nextFile);
    setSourceKind(detectCaptureSourceKind(nextFile));
    setPlan(null);
    setJob(null);
    setError(null);
  }

  async function loadKeyframes(nextPlan: CaptureReconstructionPlan, signal: AbortSignal) {
    const loaded: Array<{ viewId: string; url: string }> = [];
    for (const camera of nextPlan.cameras.slice(0, 6)) {
      try {
        const blob = await fetchCaptureArtifactBlob(nextPlan.jobId, camera.keyframeArtifactId, signal);
        const url = URL.createObjectURL(blob);
        keyframeUrlsRef.current.push(url);
        loaded.push({ viewId: camera.viewId, url });
      } catch {
        // Thumbnails are advisory; the plan stays applicable without them.
      }
    }
    setKeyframes(loaded);
  }

  async function reconstruct() {
    if (!file) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("reconstructing");
    setError(null);
    setPlan(null);
    try {
      const staged = await stageCaptureSource(file, controller.signal);
      const submitted = await submitCaptureReconstruction(
        {
          sourceMediaId: staged.sourceMediaId,
          sourceKind,
          fileName: file.name,
          maxKeyViews,
          maxObjects,
          gridResolution: 192,
          prompt,
        },
        `capture-ui:${staged.sha256}`,
        controller.signal,
      );
      setJob(submitted);
      let current = submitted;
      while (current.status === "queued" || current.status === "running") {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
        controller.signal.throwIfAborted();
        current = await getCaptureReconstructionJob(submitted.id, controller.signal);
        setJob(current);
      }
      if (current.status !== "succeeded") {
        throw new Error(current.error || `重建任务状态为 ${current.status}`);
      }
      const nextPlan = await fetchCaptureReconstructionPlan(current.id, controller.signal);
      setPlan(nextPlan);
      await loadKeyframes(nextPlan, controller.signal);
    } catch (nextError) {
      if (controller.signal.aborted) setError("重建已取消，可以重新开始。");
      else setError(nextError instanceof Error ? nextError.message : "采集重建失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
    }
  }

  async function applyPlan() {
    if (!plan) return;
    setBusy("applying");
    setError(null);
    try {
      let shellAsset: { id: string; url: string; fileName: string; realWorldSizeM: number } | null = null;
      if (includeShell && plan.shell) {
        const blob = await fetchCaptureArtifactBlob(plan.jobId, plan.shell.artifactId);
        const assetId = `capture-shell-${plan.jobId}`;
        const uploaded = await uploadBlenderModelAsset(blob, plan.shell.fileName, assetId);
        shellAsset = {
          id: assetId,
          url: uploaded.url,
          fileName: plan.shell.fileName,
          realWorldSizeM: Math.max(...plan.shell.sizeM),
        };
      }
      const result = applyCaptureReconstructionPlan(project, plan, { mode, includeCameras, shellAsset });
      replaceProject(result.project);
      selectObjects(result.objectIds.slice(0, 32));
      const doorCount = plan.objects.filter((object) => object.role === "door" && object.enabled).length;
      onApplied?.(
        `已从采集重建 ${result.objectIds.length} 个物体、${result.cameraIds.length} 台采集视角相机${
          doorCount ? `，含 ${doorCount} 扇可开合的门` : ""
        }。进入运镜模式（Player Mode）即可走进场景漫游。`,
      );
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "重建计划应用失败");
    } finally {
      setBusy(null);
    }
  }

  const progress = job && (job.status === "queued" || job.status === "running") ? job.progress : plan ? 1 : 0;

  return (
    <div
      className="reference-scene-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        aria-label="从视频或扫描重建场景"
        aria-modal="true"
        className="reference-scene-dialog capture-recon-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="reference-scene-header">
          <div>
            <span className="reference-scene-brand" aria-hidden="true">
              <ScanLine size={15} strokeWidth={1.9} />
            </span>
            <span>
              <strong>视频 / 扫描重建场景</strong>
              <small>RGB-D 扫描包重建可度量的房间；纯 RGB 视频经单目深度估计做单视角重建，由 Agent 闭环补齐</small>
            </span>
          </div>
          <button aria-label="关闭采集重建" className="ui-icon-button" onClick={close} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>

        <div className="reference-scene-body">
          <aside className="reference-scene-source">
            <input
              ref={inputRef}
              aria-label="选择采集文件"
              accept="video/*,.zip,application/zip"
              className="reference-scene-file-input"
              type="file"
              onChange={selectCapture}
            />
            <button
              className="reference-scene-upload"
              disabled={busy !== null}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <Clapperboard aria-hidden size={17} />
              <span>{file ? "更换采集文件" : "选择视频或扫描包"}</span>
            </button>
            {file ? (
              <div className="capture-recon-file">
                <strong>{file.name}</strong>
                <span>
                  {(file.size / (1024 * 1024)).toFixed(1)} MB ·{" "}
                  {sourceKind === "rgbd-bundle"
                    ? "RGB-D 扫描包（度量重建）"
                    : "RGB 视频（单目深度估计；未配置模型则降级为关键帧）"}
                </span>
              </div>
            ) : (
              <div className="reference-scene-empty">
                支持 MP4 / MOV / WEBM 视频，或 LiteReality 风格的 .zip 扫描包（capture.json + 帧 + 深度 + 位姿）。
              </div>
            )}
            <label className="reference-scene-field">
              <span>输入类型</span>
              <select
                aria-label="采集输入类型"
                value={sourceKind}
                onChange={(event) => setSourceKind(event.currentTarget.value as CaptureSourceKind)}
              >
                <option value="rgbd-bundle">RGB-D 扫描包（含深度与位姿）</option>
                <option value="rgb-video">RGB 视频（单目深度估计）</option>
              </select>
            </label>
            <label className="reference-scene-field">
              <span>重建说明</span>
              <textarea
                aria-label="采集重建说明"
                maxLength={2_000}
                placeholder="例如：这是客厅，注意保留通往阳台的门"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
              />
            </label>
            <div className="reference-scene-field-grid">
              <label className="reference-scene-field">
                <span>关键视图数</span>
                <input
                  aria-label="采集关键视图数"
                  max={12}
                  min={1}
                  type="number"
                  value={maxKeyViews}
                  onChange={(event) =>
                    setMaxKeyViews(Math.max(1, Math.min(12, Number(event.currentTarget.value) || 1)))
                  }
                />
              </label>
              <label className="reference-scene-field">
                <span>最大物体数</span>
                <input
                  aria-label="采集最大物体数"
                  max={64}
                  min={1}
                  type="number"
                  value={maxObjects}
                  onChange={(event) => setMaxObjects(Math.max(1, Math.min(64, Number(event.currentTarget.value) || 1)))}
                />
              </label>
            </div>
            <label className="reference-scene-field">
              <span>应用方式</span>
              <select
                aria-label="采集应用方式"
                value={mode}
                onChange={(event) => setMode(event.currentTarget.value as typeof mode)}
              >
                <option value="append">追加到当前片场</option>
                <option value="replace">替换非摄影机物体</option>
              </select>
            </label>
            <label className="capture-recon-toggle">
              <input
                aria-label="导入采集视角相机"
                checked={includeCameras}
                type="checkbox"
                onChange={(event) => setIncludeCameras(event.currentTarget.checked)}
              />
              <span>导入采集视角相机（供渲染比对闭环）</span>
            </label>
            <label className="capture-recon-toggle">
              <input
                aria-label="导入外壳网格"
                checked={includeShell}
                type="checkbox"
                onChange={(event) => setIncludeShell(event.currentTarget.checked)}
              />
              <span>导入融合外壳网格（体素证据，可随时删除）</span>
            </label>
            <div className="reference-scene-analysis-actions">
              {busy === "reconstructing" ? (
                <button className="reference-scene-secondary" onClick={() => abortRef.current?.abort()} type="button">
                  <X aria-hidden size={14} />
                  取消重建
                </button>
              ) : (
                <button
                  className="reference-scene-primary"
                  disabled={!file || busy !== null}
                  onClick={() => void reconstruct()}
                  type="button"
                >
                  <ScanLine aria-hidden size={14} />
                  {plan ? "重新重建" : "开始重建"}
                </button>
              )}
            </div>
          </aside>

          <main className="reference-scene-plan">
            {busy === "reconstructing" ? (
              <div className="reference-scene-plan-empty">
                <Loader2 aria-hidden className="spin" size={24} />
                <strong>{job?.message || "正在上传并重建采集"}</strong>
                <span className="capture-recon-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
                  <i style={{ width: `${Math.round(progress * 100)}%` }} />
                </span>
                <span>确定性重建不修改当前片场；完成后先审阅计划再应用</span>
              </div>
            ) : plan ? (
              <>
                <header className="reference-scene-plan-summary">
                  <div>
                    <strong>
                      {plan.analysis.status === "ready"
                        ? `度量重建：${plan.analysis.metrics.floorAreaM2.toFixed(1)}㎡ · ${plan.analysis.metrics.wallCount} 面墙 · ${plan.analysis.metrics.objectCount} 个物体`
                        : "降级重建：关键帧证据 + 可编辑脚手架"}
                    </strong>
                    <span>
                      位姿 {POSE_LABELS[plan.analysis.providers.poses]} · 深度{" "}
                      {DEPTH_LABELS[plan.analysis.providers.depth]} · 深度覆盖率{" "}
                      {Math.round(plan.analysis.metrics.depthCoverage * 100)}%
                    </span>
                  </div>
                  <span className={`reference-scene-status is-${plan.analysis.status}`}>
                    {plan.analysis.status === "ready" ? (
                      <Check aria-hidden size={13} />
                    ) : (
                      <CircleAlert aria-hidden size={13} />
                    )}
                    {plan.analysis.status === "ready" ? "度量结果" : "降级结果"}
                  </span>
                </header>
                {plan.analysis.warnings.length ? (
                  <div className="reference-scene-warnings">
                    {plan.analysis.warnings.map((warning) => (
                      <p key={warning}>
                        <CircleAlert aria-hidden size={13} />
                        {warning}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="capture-recon-counts" aria-label="重建计划构成">
                  {roleCounts(plan).map((entry) => (
                    <span key={entry}>{entry}</span>
                  ))}
                  <span>
                    <DoorOpen aria-hidden size={13} /> 采集视角相机 {plan.cameras.length}
                  </span>
                </div>
                {keyframes.length ? (
                  <section aria-label="采集关键帧" className="capture-recon-keyframes">
                    {keyframes.map((keyframe) => (
                      <figure key={keyframe.viewId}>
                        <img alt={`采集关键帧 ${keyframe.viewId}`} src={keyframe.url} />
                        <figcaption>{keyframe.viewId}</figcaption>
                      </figure>
                    ))}
                  </section>
                ) : null}
                <p className="capture-recon-loop-hint">
                  应用后可进入运镜模式（按 E 开门）漫游；Agent 可用 reconstruction.compare
                  从采集视角逐一比对并继续修正。
                </p>
              </>
            ) : (
              <div className="reference-scene-plan-empty">
                <ScanLine aria-hidden size={28} />
                <strong>重建计划会显示在这里</strong>
                <span>扫描包 → 地板、墙体、门窗、代理物体、关键视角；应用前全部可审阅</span>
              </div>
            )}
          </main>
        </div>

        {error ? (
          <p className="reference-scene-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="reference-scene-footer">
          <div>
            <button className="reference-scene-secondary" disabled={busy === "applying"} onClick={close} type="button">
              取消
            </button>
            <button
              className="reference-scene-primary"
              disabled={!plan || busy !== null || !plan.objects.some((object) => object.enabled)}
              onClick={() => void applyPlan()}
              type="button"
            >
              {busy === "applying" ? (
                <Loader2 aria-hidden className="spin" size={14} />
              ) : (
                <Check aria-hidden size={14} />
              )}
              应用到片场
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
