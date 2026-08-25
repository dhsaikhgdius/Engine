/**
 * @module ReferenceSceneReconstructionDialog
 * @description Modal dialog for reconstructing a 3D scene from a reference
 *   image via vision-model analysis or local scaffolding, with per-object
 *   edit controls before applying to the project.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Check, CircleAlert, ImagePlus, Loader2, RefreshCw, ScanSearch, Square, X } from "lucide-react";
import type { PublicAgentProfile } from "@director/agent-engine";
import {
  DIRECTOR_REFERENCE_SCENE_GEOMETRY_TYPES,
  referenceSceneAnalysisRequestSchema,
  referenceSceneReconstructionPlanSchema,
  type ReferenceScenePlanObject,
  type ReferenceSceneReconstructionPlan,
} from "../../../../../../packages/protocol/src/referenceSceneReconstructionProtocol";
import { listAgentProfiles } from "../assistant/agentProfilesClient";
import { GEOMETRY_PRIMITIVE_OPTIONS } from "../schema/directorProject";
import { getDirectorProjectRevision } from "../schema/directorProjectRevision";
import { useDirectorStore } from "../store/directorStore";
import { prepareDirectorReferenceImage, type PreparedDirectorReferenceImage } from "./referenceImageAnalysis";
import { applyReferenceSceneReconstructionPlan, requestReferenceSceneAnalysis } from "./referenceSceneReconstruction";
import { useSuppressViewportChromeWhileMounted } from "../canvas/viewportChromeSuppression";
import { useModalDialogFocus } from "../../app/layout/useModalDialogFocus";
import "./referenceSceneReconstruction.css";

type Axis = 0 | 1 | 2;

function hostedVisionProfiles(profiles: PublicAgentProfile[]) {
  return profiles.filter(
    (profile) => profile.available && profile.capabilities.vision && profile.runtime.startsWith("native-"),
  );
}

function VectorEditor({
  label,
  onChange,
  step,
  value,
}: {
  label: string;
  onChange: (axis: Axis, value: number) => void;
  step: number;
  value: [number, number, number];
}) {
  return (
    <fieldset className="reference-scene-vector">
      <legend>{label}</legend>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>
          <span data-axis={axis}>{axis}</span>
          <input
            aria-label={`${label} ${axis}`}
            step={step}
            type="number"
            value={Number(value[index].toFixed(3))}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) onChange(index as Axis, next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

function ObjectPlanEditor({
  object,
  onChange,
}: {
  object: ReferenceScenePlanObject;
  onChange: (next: ReferenceScenePlanObject) => void;
}) {
  const patchVector = (field: "position" | "scale", axis: Axis, value: number) => {
    const next = [...object.transform[field]] as [number, number, number];
    next[axis] = value;
    onChange({ ...object, transform: { ...object.transform, [field]: next } });
  };
  return (
    <article className={`reference-scene-object${object.enabled ? "" : " is-disabled"}`}>
      <header>
        <label className="reference-scene-object-toggle">
          <input
            aria-label={`包含 ${object.name}`}
            checked={object.enabled}
            type="checkbox"
            onChange={(event) => onChange({ ...object, enabled: event.currentTarget.checked })}
          />
          <Square aria-hidden size={14} />
        </label>
        <input
          aria-label={`${object.name} 名称`}
          className="reference-scene-object-name"
          maxLength={120}
          value={object.name}
          onChange={(event) => onChange({ ...object, name: event.currentTarget.value })}
        />
        <span className="reference-scene-confidence">{Math.round(object.confidence * 100)}%</span>
      </header>
      <div className="reference-scene-object-fields">
        <label>
          <span>几何</span>
          <select
            aria-label={`${object.name} 几何`}
            value={object.geometryType}
            onChange={(event) =>
              onChange({
                ...object,
                geometryType: event.currentTarget.value as ReferenceScenePlanObject["geometryType"],
              })
            }
          >
            {DIRECTOR_REFERENCE_SCENE_GEOMETRY_TYPES.map((type) => (
              <option key={type} value={type}>
                {GEOMETRY_PRIMITIVE_OPTIONS.find((option) => option.type === type)?.label ?? type}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>颜色</span>
          <input
            aria-label={`${object.name} 颜色`}
            type="color"
            value={object.material.baseColor}
            onChange={(event) =>
              onChange({ ...object, material: { ...object.material, baseColor: event.currentTarget.value } })
            }
          />
        </label>
        <label>
          <span>放置意图</span>
          <select
            aria-label={`${object.name} 放置意图`}
            value={object.placementMode}
            onChange={(event) =>
              onChange({
                ...object,
                placementMode: event.currentTarget.value as ReferenceScenePlanObject["placementMode"],
              })
            }
          >
            <option value="grounded">落地</option>
            <option value="auto">自动校验</option>
            <option value="floating">悬浮</option>
          </select>
        </label>
      </div>
      <div className="reference-scene-object-vectors">
        <VectorEditor
          label="位置"
          step={0.1}
          value={object.transform.position}
          onChange={(axis, value) => patchVector("position", axis, value)}
        />
        <VectorEditor
          label="缩放"
          step={0.1}
          value={object.transform.scale}
          onChange={(axis, value) => patchVector("scale", axis, value)}
        />
      </div>
      <p>{object.rationale}</p>
    </article>
  );
}

export function ReferenceSceneReconstructionDialog({
  onApplied,
  onClose,
}: {
  onApplied?: (message: string) => void;
  onClose: () => void;
}) {
  useSuppressViewportChromeWhileMounted("reference-scene-reconstruction");
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Escape aborts any in-flight analysis before closing, same as the close button.
  const dialogRef = useModalDialogFocus<HTMLElement>({ onClose: () => close() });
  const project = useDirectorStore((state) => state.project);
  const replaceProject = useDirectorStore((state) => state.replaceProject);
  const selectObjects = useDirectorStore((state) => state.selectObjects);
  const [prepared, setPrepared] = useState<PreparedDirectorReferenceImage | null>(null);
  const [profiles, setProfiles] = useState<PublicAgentProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<"auto" | "vision" | "local">("auto");
  const [applyMode, setApplyMode] = useState<"append" | "replace">("append");
  const [maxObjects, setMaxObjects] = useState(8);
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<ReferenceSceneReconstructionPlan | null>(null);
  const [busy, setBusy] = useState<"preparing" | "analyzing" | "applying" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visionProfiles = useMemo(() => hostedVisionProfiles(profiles), [profiles]);
  const currentRevision = getDirectorProjectRevision(project);
  const stale = Boolean(plan && plan.expectedProjectRevision !== currentRevision);

  useEffect(() => {
    let alive = true;
    void listAgentProfiles()
      .then((next) => {
        if (!alive) return;
        setProfiles(next);
        const available = hostedVisionProfiles(next);
        setProfileId((current) => current ?? available[0]?.id ?? null);
      })
      .catch(() => {
        if (alive) setProfiles([]);
      });
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, []);

  async function selectReference(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setBusy("preparing");
    setError(null);
    setPlan(null);
    try {
      setPrepared(await prepareDirectorReferenceImage(file));
    } catch (nextError) {
      setPrepared(null);
      setError(nextError instanceof Error ? nextError.message : "参考图读取失败");
    } finally {
      setBusy(null);
    }
  }

  async function analyze() {
    if (!prepared) return;
    if (analysisMode === "vision" && !profileId) {
      setError("强制视觉分析需要可用的托管视觉模型");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy("analyzing");
    setError(null);
    try {
      const request = referenceSceneAnalysisRequestSchema.parse({
        version: 1,
        projectRevision: currentRevision,
        prompt,
        applyMode,
        analysisMode,
        profileId: analysisMode === "local" ? null : profileId,
        maxObjects,
        image: {
          fileName: prepared.fileName,
          mimeType: prepared.mimeType,
          base64: prepared.base64,
          sha256: prepared.sha256,
          metrics: prepared.metrics,
        },
      });
      setPlan(await requestReferenceSceneAnalysis(request, controller.signal));
    } catch (nextError) {
      if (controller.signal.aborted) setError("参考图分析已取消，可以重新开始。");
      else setError(nextError instanceof Error ? nextError.message : "参考图分析失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(null);
    }
  }

  function cancelAnalysis() {
    abortRef.current?.abort();
  }

  function updateObject(index: number, next: ReferenceScenePlanObject) {
    setPlan((current) => {
      if (!current) return current;
      const objects = [...current.objects];
      objects[index] = next;
      return { ...current, objects };
    });
  }

  function applyPlan() {
    if (!plan || !prepared) return;
    setBusy("applying");
    setError(null);
    try {
      const validatedPlan = referenceSceneReconstructionPlanSchema.parse({ ...plan, applyMode });
      const result = applyReferenceSceneReconstructionPlan(project, validatedPlan, prepared.dataUrl);
      replaceProject(result.project);
      selectObjects(result.plan.application?.objectIds ?? []);
      onApplied?.(
        `已从参考图创建 ${result.plan.application?.objectIds.length ?? 0} 个物体和 ${result.plan.application?.lightIds.length ?? 0} 盏灯，可用撤销回退。`,
      );
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "重建计划应用失败");
    } finally {
      setBusy(null);
    }
  }

  function close() {
    abortRef.current?.abort();
    onClose();
  }

  return (
    <div
      className="reference-scene-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        aria-label="参考图重建场景"
        aria-modal="true"
        className="reference-scene-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="reference-scene-header">
          <div>
            <span className="reference-scene-brand" aria-hidden="true">
              <ScanSearch size={15} strokeWidth={1.9} />
            </span>
            <span>
              <strong>参考图重建场景</strong>
              <small>先审阅计划，再一次性应用；不会自动修改当前场景</small>
            </span>
          </div>
          <button aria-label="关闭参考图重建" className="ui-icon-button" onClick={close} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>

        <div className="reference-scene-body">
          <aside className="reference-scene-source">
            <input
              ref={inputRef}
              aria-label="选择参考图片"
              accept="image/png,image/jpeg,image/webp"
              className="reference-scene-file-input"
              type="file"
              onChange={(event) => void selectReference(event)}
            />
            <button
              className="reference-scene-upload"
              disabled={busy !== null}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {busy === "preparing" ? (
                <Loader2 aria-hidden className="spin" size={17} />
              ) : (
                <ImagePlus aria-hidden size={17} />
              )}
              <span>{prepared ? "更换参考图" : "选择照片或草图"}</span>
            </button>
            {prepared ? (
              <figure className="reference-scene-preview">
                <img alt="参考图预览" src={prepared.dataUrl} />
                <figcaption>
                  <strong>{prepared.fileName}</strong>
                  <span>
                    {prepared.metrics.width} × {prepared.metrics.height} · {(prepared.byteLength / 1024).toFixed(0)} KB
                  </span>
                </figcaption>
              </figure>
            ) : (
              <div className="reference-scene-empty">
                JPG / PNG / WEBP，原图不上传到项目之外；发送给所选视觉 Profile 的是压缩副本。
              </div>
            )}
            {prepared ? (
              <div className="reference-scene-metrics" aria-label="参考图本地测量">
                <span>亮度 {Math.round(prepared.metrics.meanLuminance * 100)}%</span>
                <span>边缘 {Math.round(prepared.metrics.edgeDensity * 100)}%</span>
                <span>前景 {Math.round(prepared.metrics.foregroundCoverage * 100)}%</span>
                <div>
                  {prepared.metrics.palette.map((entry) => (
                    <i key={entry} style={{ background: entry }} title={entry} />
                  ))}
                </div>
              </div>
            ) : null}
            <label className="reference-scene-field">
              <span>重建说明</span>
              <textarea
                aria-label="参考图重建说明"
                maxLength={2_000}
                placeholder="例如：只重建建筑体块，忽略画面中的人物"
                rows={4}
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
              />
            </label>
            <div className="reference-scene-field-grid">
              <label className="reference-scene-field">
                <span>分析模式</span>
                <select
                  aria-label="参考图分析模式"
                  value={analysisMode}
                  onChange={(event) => setAnalysisMode(event.currentTarget.value as typeof analysisMode)}
                >
                  <option value="auto">自动（可降级）</option>
                  <option value="vision">强制视觉模型</option>
                  <option value="local">仅本地脚手架</option>
                </select>
              </label>
              <label className="reference-scene-field">
                <span>最大物体</span>
                <input
                  aria-label="参考图最大物体数"
                  max={16}
                  min={1}
                  type="number"
                  value={maxObjects}
                  onChange={(event) => setMaxObjects(Math.max(1, Math.min(16, Number(event.currentTarget.value) || 1)))}
                />
              </label>
            </div>
            {analysisMode !== "local" ? (
              <label className="reference-scene-field">
                <span>视觉模型</span>
                <select
                  aria-label="参考图视觉模型"
                  value={profileId ?? ""}
                  onChange={(event) => setProfileId(event.currentTarget.value || null)}
                >
                  <option value="">{visionProfiles.length ? "自动选择" : "没有可用的托管视觉模型"}</option>
                  {visionProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label} · {profile.model}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="reference-scene-field">
              <span>应用方式</span>
              <select
                aria-label="参考图应用方式"
                value={applyMode}
                onChange={(event) => setApplyMode(event.currentTarget.value as typeof applyMode)}
              >
                <option value="append">追加到当前片场</option>
                <option value="replace">替换非摄影机物体与灯光</option>
              </select>
            </label>
            <div className="reference-scene-analysis-actions">
              {busy === "analyzing" ? (
                <button className="reference-scene-secondary" onClick={cancelAnalysis} type="button">
                  <X aria-hidden size={14} />
                  取消分析
                </button>
              ) : (
                <button
                  className="reference-scene-primary"
                  disabled={!prepared || busy !== null}
                  onClick={() => void analyze()}
                  type="button"
                >
                  {plan ? <RefreshCw aria-hidden size={14} /> : <ScanSearch aria-hidden size={14} />}
                  {plan ? "重新分析" : "生成重建计划"}
                </button>
              )}
            </div>
          </aside>

          <main className="reference-scene-plan">
            {busy === "analyzing" ? (
              <div className="reference-scene-plan-empty">
                <Loader2 aria-hidden className="spin" size={24} />
                <strong>正在分析可见形体、材质与光线</strong>
                <span>当前片场不会在分析期间被修改</span>
              </div>
            ) : plan ? (
              <>
                <header className="reference-scene-plan-summary">
                  <div>
                    <strong>{plan.analysis.summary}</strong>
                    <span>
                      {plan.analysis.mode === "vision" ? `视觉分析 · ${plan.analysis.model}` : "本地构图脚手架"} ·
                      置信度 {Math.round(plan.analysis.confidence * 100)}%
                    </span>
                  </div>
                  <span className={`reference-scene-status is-${plan.analysis.status}`}>
                    {plan.analysis.status === "ready" ? (
                      <Check aria-hidden size={13} />
                    ) : (
                      <CircleAlert aria-hidden size={13} />
                    )}
                    {plan.analysis.status === "ready" ? "结构化结果" : "降级结果"}
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
                <div className="reference-scene-plan-controls">
                  <label>
                    <span>环境底色</span>
                    <input
                      aria-label="重建环境底色"
                      type="color"
                      value={plan.backgroundColor}
                      onChange={(event) => setPlan({ ...plan, backgroundColor: event.currentTarget.value })}
                    />
                  </label>
                  <span>
                    {plan.objects.filter((object) => object.enabled).length} / {plan.objects.length} 个物体
                  </span>
                  <span>
                    {plan.lights.filter((light) => light.enabled).length} / {plan.lights.length} 盏灯
                  </span>
                </div>
                <div className="reference-scene-object-list">
                  {plan.objects.map((object, index) => (
                    <ObjectPlanEditor key={object.id} object={object} onChange={(next) => updateObject(index, next)} />
                  ))}
                </div>
                {plan.lights.length ? (
                  <section className="reference-scene-light-list" aria-label="建议灯光">
                    <h3>建议灯光</h3>
                    {plan.lights.map((light, index) => (
                      <label key={light.id}>
                        <input
                          aria-label={`包含灯光 ${light.name}`}
                          checked={light.enabled}
                          type="checkbox"
                          onChange={(event) => {
                            const lights = [...plan.lights];
                            lights[index] = { ...light, enabled: event.currentTarget.checked };
                            setPlan({ ...plan, lights });
                          }}
                        />
                        <i style={{ background: light.color }} />
                        <span>
                          <strong>{light.name}</strong>
                          <small>
                            {light.type} · {light.intensity.toFixed(1)}
                          </small>
                        </span>
                        <em>{light.rationale}</em>
                      </label>
                    ))}
                  </section>
                ) : null}
              </>
            ) : (
              <div className="reference-scene-plan-empty">
                <ScanSearch aria-hidden size={28} />
                <strong>重建计划会显示在这里</strong>
                <span>物体、位置、尺度、颜色和灯光都可在应用前修改</span>
              </div>
            )}
          </main>
        </div>

        {error ? (
          <p className="reference-scene-error" role="alert">
            {error}
          </p>
        ) : null}
        {stale ? (
          <p className="reference-scene-error" role="alert">
            片场在分析后已变化，请重新分析以避免覆盖新修改。
          </p>
        ) : null}
        <footer className="reference-scene-footer">
          <span>来源图片、模型 Profile、置信度、警告和输出 ID 会写入工程；原始 base64 不写入计划记录。</span>
          <div>
            <button className="reference-scene-secondary" disabled={busy === "applying"} onClick={close} type="button">
              取消
            </button>
            <button
              className="reference-scene-primary"
              disabled={!plan || !prepared || stale || busy !== null || !plan.objects.some((object) => object.enabled)}
              onClick={applyPlan}
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
