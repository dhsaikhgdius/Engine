import { Box, CircleAlert, ImagePlus, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type {
  Generated3DMode,
  Generated3DProviderCapability,
  Generated3DProviderId,
  Generated3DTopology,
} from "../../../../../../packages/protocol/src/generated3dProtocol";
import {
  prepareDirectorReferenceImage,
  type PreparedDirectorReferenceImage,
} from "../reconstruction/referenceImageAnalysis";
import {
  cancelGenerated3DJob,
  listGenerated3DJobs,
  listGenerated3DProviders,
  reconcileGenerated3DJob,
  retryGenerated3DJob,
  submitGenerated3DJob,
  type Generated3DJob,
} from "./generated3dClient";
import { promoteGenerated3DJob } from "./generated3dPromotion";
import { friendlyErrorMessage } from "../api/friendlyError";
import { useSuppressViewportChromeWhileMounted } from "../canvas/viewportChromeSuppression";
import { useModalDialogFocus } from "../../app/layout/useModalDialogFocus";
import "./generated3d.css";

const STATUS_LABELS: Record<Generated3DJob["status"], string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  outcome_unknown: "结果待确认",
  reconciling: "核对中",
};

/** Gateway environment variables that unlock each provider (see backend/gateway/controlPlane/controlPlaneConfig.ts). */
const PROVIDER_ENV_KEYS: Record<Generated3DProviderId, string> = {
  meshy: "DIRECTOR_MESHY_API_KEY",
  tripo: "DIRECTOR_TRIPO_API_KEY",
  infinigen: "DIRECTOR_INFINIGEN_PYTHON",
};

function upsertJob(jobs: Generated3DJob[], job: Generated3DJob) {
  return [job, ...jobs.filter((candidate) => candidate.id !== job.id)];
}

function ProviderStatus({ provider }: { provider: Generated3DProviderCapability }) {
  return (
    <span className={provider.configured ? "generated3d-provider-ready" : "generated3d-provider-missing"}>
      {provider.configured
        ? "已配置"
        : `服务端未配置，需在网关设置 ${PROVIDER_ENV_KEYS[provider.id] ?? "供应商 API Key"}`}
    </span>
  );
}

export function Generated3DDialog({
  onClose,
  onPromoted,
}: {
  onClose: () => void;
  onPromoted?: (message: string) => void;
}) {
  useSuppressViewportChromeWhileMounted("generated-3d");
  const dialogRef = useModalDialogFocus<HTMLElement>({ onClose });
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const [providers, setProviders] = useState<Generated3DProviderCapability[]>([]);
  const [providerId, setProviderId] = useState<Generated3DProviderId>("meshy");
  const [jobs, setJobs] = useState<Generated3DJob[]>([]);
  const [mode, setMode] = useState<Generated3DMode>("text-to-3d");
  const [name, setName] = useState("生成模型");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [source, setSource] = useState<PreparedDirectorReferenceImage | null>(null);
  const [targetHeightMeters, setTargetHeightMeters] = useState<number | "">("");
  const [topology, setTopology] = useState<Generated3DTopology>("triangle");
  const [targetPolygonCount, setTargetPolygonCount] = useState(50_000);
  const [texture, setTexture] = useState(true);
  const [pbr, setPbr] = useState(true);
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [promotedJobs, setPromotedJobs] = useState<Set<string>>(new Set());

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId) ?? null,
    [providerId, providers],
  );

  const refreshJobs = useCallback(async (silent = false) => {
    try {
      setJobs(await listGenerated3DJobs());
    } catch (error) {
      if (!silent) setNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([listGenerated3DProviders(), listGenerated3DJobs()])
      .then(([providerState, nextJobs]) => {
        if (!alive) return;
        setProviders(providerState.providers);
        setProviderId(providerState.defaultProvider);
        setJobs(nextJobs);
      })
      .catch((error) => {
        if (alive) setNotice(error instanceof Error ? error.message : String(error));
      });
    const timer = window.setInterval(() => void refreshJobs(true), 2_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [refreshJobs]);

  async function selectSource(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy("source");
    setNotice("正在校验并压缩参考图…");
    try {
      const prepared = await prepareDirectorReferenceImage(file);
      setSource(prepared);
      if (name === "生成模型") setName(file.name.replace(/\.[^.]+$/, "") || "图生模型");
      setNotice(`参考图已就绪 · ${prepared.metrics.width}×${prepared.metrics.height}`);
    } catch (error) {
      setSource(null);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy("submit");
    setNotice("正在提交持久 3D 生成任务…");
    try {
      const job = await submitGenerated3DJob({
        mode,
        providerId,
        name,
        prompt,
        negativePrompt: negativePrompt.trim() || undefined,
        sourceImageDataUrl: mode === "image-to-3d" ? source?.dataUrl : undefined,
        targetHeightMeters: targetHeightMeters === "" ? undefined : targetHeightMeters,
        topology,
        targetPolygonCount,
        texture,
        pbr,
        seed,
        idempotencyKey: `generated3d-ui-${crypto.randomUUID()}`,
      });
      setJobs((current) => upsertJob(current, job));
      setNotice(`${job.input.name} 已进入 ${selectedProvider?.label ?? providerId} 队列`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function jobAction(job: Generated3DJob, action: "cancel" | "retry" | "reconcile") {
    setBusy(`${action}:${job.id}`);
    try {
      const next =
        action === "cancel"
          ? await cancelGenerated3DJob(job.id)
          : action === "retry"
            ? await retryGenerated3DJob(job.id)
            : await reconcileGenerated3DJob(job.id);
      setJobs((current) => upsertJob(current, next));
      setNotice(`${job.input.name}：${STATUS_LABELS[next.status]}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function promote(job: Generated3DJob) {
    setBusy(`promote:${job.id}`);
    setNotice("正在校验产物、写入项目资源并加入画廊…");
    try {
      const result = await promoteGenerated3DJob(job);
      setPromotedJobs((current) => new Set(current).add(job.id));
      const message = `${job.input.name} 已加入片场和画廊（${result.assetId}）`;
      setNotice(message);
      onPromoted?.(message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  const canSubmit =
    selectedProvider?.configured &&
    selectedProvider.modes.includes(mode) &&
    name.trim() &&
    prompt.trim() &&
    (mode !== "image-to-3d" || source);

  return (
    <div
      className="generated3d-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-label="AI 生成 3D 模型"
        aria-modal="true"
        className="generated3d-surface"
        ref={dialogRef}
        role="dialog"
      >
        <header className="generated3d-header">
          <div>
            <Sparkles aria-hidden size={18} />
            <span>
              <strong>AI 生成 3D</strong>
              <small>真实 Meshy / Tripo 任务 · 米制 GLB 规范化 · 可追溯晋升</small>
            </span>
          </div>
          <button aria-label="关闭 AI 生成 3D 模型" className="ui-icon-button" onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>

        <div className="generated3d-layout">
          <form className="generated3d-form" onSubmit={(event) => void submit(event)}>
            <fieldset>
              <legend>供应商与输入</legend>
              <label>
                <span>供应商</span>
                <select
                  aria-label="3D 生成供应商"
                  className="ui-field"
                  value={providerId}
                  onChange={(event) => setProviderId(event.currentTarget.value as Generated3DProviderId)}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                      {provider.configured ? "" : "（未配置）"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedProvider ? (
                <p className="generated3d-provider-line">
                  <ProviderStatus provider={selectedProvider} />
                  <span>
                    {selectedProvider.cancellation === "remote" ? "支持远程取消" : "仅本地停止追踪"}
                    {selectedProvider.modelVersion ? ` · ${selectedProvider.modelVersion}` : ""}
                  </span>
                </p>
              ) : null}
              <div aria-label="3D 生成输入方式" className="generated3d-mode-toggle" role="group">
                <button
                  aria-pressed={mode === "text-to-3d"}
                  className={`ui-segmented-item${mode === "text-to-3d" ? " ui-segmented-item-active" : ""}`}
                  onClick={() => setMode("text-to-3d")}
                  type="button"
                >
                  文生 3D
                </button>
                <button
                  aria-pressed={mode === "image-to-3d"}
                  className={`ui-segmented-item${mode === "image-to-3d" ? " ui-segmented-item-active" : ""}`}
                  onClick={() => setMode("image-to-3d")}
                  type="button"
                >
                  图生 3D
                </button>
              </div>
              <label>
                <span>资产名称</span>
                <input
                  aria-label="生成 3D 资产名称"
                  className="ui-field"
                  maxLength={160}
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>提示词</span>
                <textarea
                  aria-label="3D 生成提示词"
                  className="ui-field"
                  maxLength={600}
                  placeholder="描述完整形体、材质、风格与希望保留的结构"
                  rows={4}
                  value={prompt}
                  onChange={(event) => setPrompt(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>负面提示词</span>
                <input
                  aria-label="3D 生成负面提示词"
                  className="ui-field"
                  maxLength={255}
                  value={negativePrompt}
                  onChange={(event) => setNegativePrompt(event.currentTarget.value)}
                />
              </label>
              {mode === "image-to-3d" ? (
                <div className="generated3d-source">
                  <button
                    className="generated3d-upload"
                    disabled={busy === "source"}
                    onClick={() => sourceInputRef.current?.click()}
                    type="button"
                  >
                    {busy === "source" ? (
                      <Loader2 aria-hidden className="generated3d-spin" size={14} />
                    ) : (
                      <ImagePlus aria-hidden size={14} />
                    )}
                    {source ? "更换参考图" : "选择参考图"}
                  </button>
                  <input
                    ref={sourceInputRef}
                    aria-label="选择图生 3D 参考图"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    type="file"
                    onChange={(event) => void selectSource(event)}
                  />
                  {source ? (
                    <img alt="图生 3D 参考图预览" src={source.dataUrl} />
                  ) : (
                    <span>将转为不超过 5 MiB 的已校验 JPEG</span>
                  )}
                </div>
              ) : null}
            </fieldset>

            <fieldset>
              <legend>几何与材质</legend>
              <div className="generated3d-grid">
                <label>
                  <span>目标高度（米）</span>
                  <input
                    aria-label="生成模型目标高度"
                    className="ui-field"
                    min="0.01"
                    max="100"
                    step="0.01"
                    type="number"
                    placeholder="自动（按提示词估计）"
                    value={targetHeightMeters}
                    onChange={(event) => {
                      const raw = event.currentTarget.value;
                      setTargetHeightMeters(raw === "" ? "" : Number(raw));
                    }}
                  />
                </label>
                <label>
                  <span>拓扑</span>
                  <select
                    aria-label="生成模型拓扑"
                    className="ui-field"
                    value={topology}
                    onChange={(event) => setTopology(event.currentTarget.value as Generated3DTopology)}
                  >
                    <option value="triangle">三角面</option>
                    <option value="quad">四边面重拓扑</option>
                    <option value="lowpoly">低模</option>
                  </select>
                </label>
                <label>
                  <span>目标面数</span>
                  <input
                    aria-label="生成模型目标面数"
                    className="ui-field"
                    min="100"
                    max="2000000"
                    step="100"
                    type="number"
                    value={targetPolygonCount}
                    onChange={(event) => setTargetPolygonCount(Number(event.currentTarget.value))}
                  />
                </label>
                <label>
                  <span>种子</span>
                  <input
                    aria-label="3D 生成种子"
                    className="ui-field"
                    min="0"
                    max="2147483647"
                    step="1"
                    type="number"
                    value={seed}
                    onChange={(event) => setSeed(Number(event.currentTarget.value))}
                  />
                </label>
              </div>
              <div className="generated3d-checks">
                <label>
                  <input
                    checked={texture}
                    type="checkbox"
                    onChange={(event) => {
                      setTexture(event.currentTarget.checked);
                      if (!event.currentTarget.checked) setPbr(false);
                    }}
                  />
                  生成纹理
                </label>
                <label>
                  <input
                    checked={pbr}
                    disabled={!texture}
                    type="checkbox"
                    onChange={(event) => setPbr(event.currentTarget.checked)}
                  />
                  PBR 材质
                </label>
              </div>
            </fieldset>

            <button className="generated3d-primary" disabled={!canSubmit || Boolean(busy)} type="submit">
              {busy === "submit" ? (
                <Loader2 aria-hidden className="generated3d-spin" size={15} />
              ) : (
                <Sparkles aria-hidden size={15} />
              )}
              开始生成
            </button>
          </form>

          <section className="generated3d-queue" aria-label="3D 生成队列">
            <header>
              <div>
                <strong>持久任务</strong>
                <small>刷新页面后仍可继续查看、取消或核对</small>
              </div>
              <button
                aria-label="刷新 3D 生成队列"
                className="ui-icon-button"
                onClick={() => void refreshJobs()}
                type="button"
              >
                <RefreshCw aria-hidden size={14} />
              </button>
            </header>
            {!jobs.length ? (
              <div className="generated3d-empty">
                <Box aria-hidden size={24} />
                <span>还没有 3D 生成任务</span>
              </div>
            ) : (
              <div className="generated3d-jobs">
                {jobs.map((job) => {
                  const actionBusy = busy?.endsWith(`:${job.id}`);
                  return (
                    <article key={job.id} className={`generated3d-job is-${job.status}`}>
                      <header>
                        <div>
                          <strong>{job.input.name}</strong>
                          <small>
                            {job.input.providerId} · {job.input.mode === "text-to-3d" ? "文生" : "图生"}
                          </small>
                        </div>
                        <span>{STATUS_LABELS[job.status]}</span>
                      </header>
                      <div
                        className="generated3d-progress"
                        role="progressbar"
                        aria-label={`${job.input.name} 进度`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(job.progress * 100)}
                      >
                        <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
                      </div>
                      <p>{job.error ?? job.message ?? "等待供应商状态"}</p>
                      {job.status === "outcome_unknown" ? (
                        <p className="generated3d-warning">
                          <CircleAlert aria-hidden size={14} />
                          供应商可能已接受任务，请先核对，避免重复计费。
                        </p>
                      ) : null}
                      <footer>
                        {job.status === "queued" || job.status === "running" ? (
                          <button disabled={actionBusy} onClick={() => void jobAction(job, "cancel")} type="button">
                            取消
                          </button>
                        ) : null}
                        {job.status === "failed" || job.status === "cancelled" ? (
                          <button disabled={actionBusy} onClick={() => void jobAction(job, "retry")} type="button">
                            重试
                          </button>
                        ) : null}
                        {job.status === "outcome_unknown" ? (
                          <button disabled={actionBusy} onClick={() => void jobAction(job, "reconcile")} type="button">
                            核对供应商
                          </button>
                        ) : null}
                        {job.status === "succeeded" ? (
                          <button disabled={actionBusy} onClick={() => void promote(job)} type="button">
                            {promotedJobs.has(job.id) ? "再放置一个" : "加入片场与画廊"}
                          </button>
                        ) : null}
                      </footer>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
        {notice ? (
          <p className="generated3d-notice" role="status">
            {notice}
          </p>
        ) : null}
      </section>
    </div>
  );
}
