/**
 * 「引擎场景导入」区块(引擎 → Director):上传引擎内导出器写出的
 * director-engine-scene-v1 zip 包,审阅清单与冲突,勾选场景/相机/灯光,
 * 以 revision 保护的原子变更应用到当前 Director 项目。
 *
 * 与「引擎回传」方向相反:回传带回 Director 发送后的差异;本区块把一个
 * 已有引擎场景整包搬进 Director。
 *
 * @module engine-scene-import-section
 */

import { FileUp, PackageOpen } from "lucide-react";
import { useRef, useState } from "react";
import type {
  DirectorEngineSceneImportPlanV1,
  DirectorEngineSceneManifestV1,
} from "../../../../dcc/directorEngineSceneImportContract";
import type { DirectorDccEngineId } from "../../../../dcc/directorDccEngineSpace";
import { useLanguage } from "../../../i18n/language";
import {
  applyDirectorEngineSceneImport,
  DirectorEngineSceneClientError,
  previewDirectorEngineSceneImport,
  uploadDirectorEngineScenePackage,
} from "../../api/dccEngineSceneClient";
import { EngineSceneOmittedList, filterEngineSceneWarningsWithoutTypedEchoes } from "./engineSceneOmittedUi";

/** In-engine exporter每引擎的获取提示(zh-CN source strings)。 */
const EXPORTER_HINTS: Record<DirectorDccEngineId, string> = {
  unreal: "在 Unreal 中运行 director_scene_export.py --zip（或让 Agent 用 extract_engine_scene 无头提取）",
  unity: "在 Unity 中运行 DirectorSceneExport（-directorZip），或让 Agent 用 extract_engine_scene 无头提取",
  godot: "在 Godot 中运行 director_scene_export.gd --zip，或让 Agent 用 extract_engine_scene 无头提取",
};

const MAX_LISTED_SOURCES = 8;

function errorView(error: unknown, fallback: string): { message: string; recovery: string[] } {
  if (error instanceof DirectorEngineSceneClientError) {
    return { message: error.message, recovery: error.recovery ? [error.recovery] : [] };
  }
  return { message: error instanceof Error ? error.message : fallback, recovery: [] };
}

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/**
 * zip 上传 → 清单摘要 → 选择重建 → 审阅确认 → revision 保护应用。
 */
export function EngineSceneImportSection({ engine }: { engine: DirectorDccEngineId }) {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; recovery: string[] } | null>(null);
  const [manifest, setManifest] = useState<DirectorEngineSceneManifestV1 | null>(null);
  const [packageDir, setPackageDir] = useState("");
  const [plan, setPlan] = useState<DirectorEngineSceneImportPlanV1 | null>(null);
  const [includeScene, setIncludeScene] = useState(true);
  const [cameraIds, setCameraIds] = useState<string[]>([]);
  const [lightIds, setLightIds] = useState<string[]>([]);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedSummary, setAppliedSummary] = useState("");

  async function ingest(file: File) {
    setBusy(true);
    setError(null);
    setManifest(null);
    setPlan(null);
    setAppliedSummary("");
    setReviewConfirmed(false);
    try {
      const upload = await uploadDirectorEngineScenePackage(engine, file);
      setManifest(upload.manifest);
      setPackageDir(upload.packagePath);
      setPlan(upload.plan);
      setIncludeScene(upload.plan.selection.includeScene);
      setCameraIds(upload.plan.selection.cameraSourceIds);
      setLightIds(upload.plan.selection.lightSourceIds);
    } catch (uploadError) {
      setError(errorView(uploadError, t("引擎场景包上传失败")));
    } finally {
      setBusy(false);
    }
  }

  async function rebuildPlan() {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    setAppliedSummary("");
    setReviewConfirmed(false);
    try {
      const next = await previewDirectorEngineSceneImport(engine, packageDir, {
        includeScene,
        cameraSourceIds: cameraIds,
        lightSourceIds: lightIds,
      });
      setPlan(next);
    } catch (previewError) {
      setError(errorView(previewError, t("引擎场景导入预览失败")));
    } finally {
      setBusy(false);
    }
  }

  async function applyPlan() {
    if (!plan?.ready || !reviewConfirmed || busy || applying || appliedSummary) return;
    setApplying(true);
    setError(null);
    try {
      const result = await applyDirectorEngineSceneImport(plan);
      setAppliedSummary(
        `${t("引擎场景已导入")} · ${result.plan.operations.length} ${t("项操作")} · ${result.copiedAssets.length} ${t("个复制资产")}`,
      );
    } catch (applyError) {
      setError(errorView(applyError, t("引擎场景导入应用失败")));
    } finally {
      setApplying(false);
    }
  }

  const working = busy || applying;
  const omitted = plan?.omitted ?? [];
  const omittedCount = plan?.omittedCount ?? omitted.length;
  const filteredPlanWarnings = plan ? filterEngineSceneWarningsWithoutTypedEchoes(plan.warnings, plan) : [];
  const manifestWarningSet = new Set((manifest?.warnings ?? []).map((warning) => warning.trim()).filter(Boolean));
  const planOnlyWarnings = filteredPlanWarnings.filter((warning) => !manifestWarningSet.has(warning.trim()));

  return (
    <section aria-label={t("引擎场景导入")} className="director-engine-handoff-block">
      <div className="director-engine-handoff-block-heading">
        <strong>{t("引擎场景导入（引擎 → Director）")}</strong>
        <small>{t("上传引擎内导出的 zip 包，审阅计划后一次性导入")}</small>
      </div>
      <p className="director-engine-handoff-hint">{t(EXPORTER_HINTS[engine])}</p>
      <div className="director-engine-run-toolbar">
        <input
          accept=".zip,application/zip"
          aria-label={t("选择引擎场景包")}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void ingest(file);
          }}
          ref={fileInputRef}
          type="file"
        />
        <button disabled={working} onClick={() => fileInputRef.current?.click()} type="button">
          <FileUp aria-hidden size={12} />
          {busy && !manifest ? t("上传校验中…") : t("上传场景包（.zip）")}
        </button>
      </div>
      {manifest ? (
        <div className="director-engine-handoff-receipt">
          <div className="director-engine-handoff-receipt-heading">
            <span className="is-ready">
              <PackageOpen aria-hidden size={11} /> {t("包已校验")}
            </span>
            <small
              data-i18n-user-content
            >{`${manifest.source.projectName} · ${manifest.source.sceneName} · ${manifest.engineVersion}`}</small>
          </div>
          <dl aria-label={t("场景包摘要")} className="director-engine-handoff-facts">
            <div>
              <dt>{t("节点")}</dt>
              <dd>{manifest.scene.nodeCount}</dd>
            </div>
            <div>
              <dt>{t("网格")}</dt>
              <dd>{manifest.scene.meshCount + manifest.scene.skinnedMeshCount}</dd>
            </div>
            <div>
              <dt>{t("相机")}</dt>
              <dd>{manifest.cameras.length}</dd>
            </div>
            <div>
              <dt>{t("灯光")}</dt>
              <dd>{manifest.lights.length}</dd>
            </div>
            <div>
              <dt>{t("动画剪辑")}</dt>
              <dd>{manifest.scene.animationClipCount}</dd>
            </div>
          </dl>
          <div className="director-engine-scene-selection">
            <label className="director-engine-handoff-opt-in">
              <input
                checked={includeScene}
                disabled={working || !manifest.scene.bundleFile}
                onChange={(event) => setIncludeScene(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>
                {manifest.scene.bundleFile
                  ? t("导入场景几何（GLB 捆绑，保持米制原比例）")
                  : t("此包不含几何捆绑（引擎侧缺 glTF 导出器）；仍可导入相机与灯光")}
              </span>
            </label>
            {manifest.cameras.length ? (
              <fieldset className="director-engine-scene-picks">
                <legend>{t("相机")}</legend>
                {manifest.cameras.slice(0, MAX_LISTED_SOURCES).map((camera) => (
                  <label key={camera.sourceId}>
                    <input
                      checked={cameraIds.includes(camera.sourceId)}
                      disabled={working}
                      onChange={() => setCameraIds((current) => toggleId(current, camera.sourceId))}
                      type="checkbox"
                    />
                    <span data-i18n-user-content>{camera.name}</span>
                  </label>
                ))}
                {manifest.cameras.length > MAX_LISTED_SOURCES ? (
                  <small>{`+${manifest.cameras.length - MAX_LISTED_SOURCES}`}</small>
                ) : null}
              </fieldset>
            ) : null}
            {manifest.lights.length ? (
              <fieldset className="director-engine-scene-picks">
                <legend>{t("灯光")}</legend>
                {manifest.lights.slice(0, MAX_LISTED_SOURCES).map((light) => (
                  <label key={light.sourceId}>
                    <input
                      checked={lightIds.includes(light.sourceId)}
                      disabled={working}
                      onChange={() => setLightIds((current) => toggleId(current, light.sourceId))}
                      type="checkbox"
                    />
                    <span data-i18n-user-content>{`${light.name} (${light.type})`}</span>
                  </label>
                ))}
                {manifest.lights.length > MAX_LISTED_SOURCES ? (
                  <small>{`+${manifest.lights.length - MAX_LISTED_SOURCES}`}</small>
                ) : null}
              </fieldset>
            ) : null}
            <button disabled={working} onClick={() => void rebuildPlan()} type="button">
              {busy ? t("重建计划中…") : t("按所选重建计划")}
            </button>
          </div>
          {manifest.warnings.length ? (
            <ul aria-label={t("场景包提示")} className="director-engine-handoff-list is-warning">
              {manifest.warnings.slice(0, 6).map((warning) => (
                <li data-i18n-user-content key={warning}>
                  {warning}
                </li>
              ))}
              {manifest.warnings.length > 6 ? (
                <li className="director-engine-handoff-more">+{manifest.warnings.length - 6}</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
      {plan ? (
        <div className="director-engine-handoff-plan">
          <span data-ready={plan.ready}>{plan.ready ? t("可导入") : t("有冲突")}</span>
          <p>
            {[
              `${plan.operations.length} ${t("项操作")}`,
              `${plan.conflicts.length} ${t("项冲突")}`,
              ...(omittedCount ? [`${omittedCount} ${t("项省略")}`] : []),
              `${filteredPlanWarnings.length} ${t("条提示")}`,
            ].join(" · ")}
          </p>
          {plan.conflicts.length ? (
            <ul className="director-engine-handoff-list is-danger">
              {plan.conflicts.slice(0, 6).map((conflict) => (
                <li data-i18n-user-content key={`${conflict.code}:${conflict.sourceId}`}>
                  {conflict.reason}
                </li>
              ))}
              {plan.conflicts.length > 6 ? (
                <li className="director-engine-handoff-more">+{plan.conflicts.length - 6}</li>
              ) : null}
            </ul>
          ) : null}
          <EngineSceneOmittedList
            listClassName="director-engine-handoff-list is-warning"
            moreClassName="director-engine-handoff-more"
            omitted={omitted}
            t={t}
          />
          {planOnlyWarnings.length ? (
            <ul aria-label={t("引擎场景导入提示")} className="director-engine-handoff-list is-warning">
              {planOnlyWarnings.slice(0, 6).map((warning) => (
                <li data-i18n-user-content key={warning}>
                  {warning}
                </li>
              ))}
              {planOnlyWarnings.length > 6 ? (
                <li className="director-engine-handoff-more">+{planOnlyWarnings.length - 6}</li>
              ) : null}
            </ul>
          ) : null}
          <label className="director-engine-handoff-opt-in">
            <input
              checked={reviewConfirmed}
              disabled={working || !plan.ready || Boolean(appliedSummary)}
              onChange={(event) => setReviewConfirmed(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>{t("我已审阅上方计划，确认导入当前场景")}</span>
          </label>
          <button
            className="director-engine-handoff-apply"
            disabled={working || !plan.ready || !reviewConfirmed || Boolean(appliedSummary)}
            onClick={() => void applyPlan()}
            type="button"
          >
            {appliedSummary ? t("已导入当前场景") : applying ? t("导入中…") : t("导入引擎场景")}
          </button>
          {appliedSummary ? <output className="director-engine-handoff-applied">{appliedSummary}</output> : null}
        </div>
      ) : null}
      {error ? (
        <div className="director-engine-handoff-error" role="alert">
          <p>{error.message}</p>
          {error.recovery.length ? (
            <ul className="director-engine-handoff-list">
              {error.recovery.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
