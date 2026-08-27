/**
 * 单引擎交接详情面板:能力芯片、连接器健康、无头发送(含回执)、回传预览/应用、实时预览状态。
 *
 * 共享骨架由本组件提供;Unreal / Unity / Godot 各自的回执渲染与实时预览区块
 * 通过 props 注入(见同目录 *HandoffSections.tsx)。
 *
 * @module engine-detail-panel
 */

import { CheckCircle2, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DirectorDccEngineHealth, DirectorDccEngineSendResult } from "../../../../dcc/directorDccEngineContract";
import type { DirectorDccEngineId } from "../../../../dcc/directorDccEngineSpace";
import type {
  DirectorDccCapabilityLevel,
  DirectorDccProviderStatus,
} from "../../../../dcc/directorDccProviderContract";
import type { DirectorDccImportPlanV1 } from "../../../../dcc/directorDccReturnContract";
import { useLanguage } from "../../../i18n/language";
import { fetchDirectorDccEngineHealth } from "../../api/dccEngineHandoffClient";
import { DirectorDccProviderClientError, sendDirectorProjectToEngine } from "../../api/dccProviderClient";
import {
  applyDirectorDccImportPlan,
  DirectorDccReturnClientError,
  previewDirectorDccReturnPackage,
} from "../../api/dccReturnClient";
import { DccReturnOmittedLists, filterDccReturnWarningsWithoutTypedEchoes } from "../dccReturnOmittedUi";
import { EngineRunSection } from "./EngineRunSection";
import { EngineSceneImportSection } from "./EngineSceneImportSection";

/** zh-CN capability labels keyed by the provider catalog capability ids. */
const CAPABILITY_LABELS: Record<string, string> = {
  scene: "场景",
  camera: "相机",
  animation: "动画",
  skeleton: "骨骼",
  materials: "材质",
  stable_ids: "稳定 ID",
  roundtrip: "往返",
  headless: "无头",
  live_link: "实时预览",
};

const CAPABILITY_LEVEL_LABELS: Record<DirectorDccCapabilityLevel, string> = {
  native: "原生",
  exchange: "交换",
  planned: "计划",
};

/** Result summary of one dry-run receive preview. */
interface EngineReturnPreviewState {
  plan: DirectorDccImportPlanV1;
  summary: { operation_count: number; skipped_count: number; conflict_count: number; warning_count: number };
  ready: boolean;
}

/** Props for the shared engine detail panel. */
export interface EngineDetailPanelProps {
  engine: DirectorDccEngineId;
  /** Live provider status from the shared catalog, or null while discovering. */
  status: DirectorDccProviderStatus | null;
  /** Catalog discovery error, when the provider list itself failed to load. */
  catalogError?: string;
  /** Whether the shared catalog is still loading. */
  catalogLoading?: boolean;
  /** Re-run the shared catalog discovery. */
  onRefresh: () => void;
  /** zh-CN source strings describing what the send payload carries. */
  sendNotes: string[];
  /** Unreal-only: offer the optional clean-frame render on send. */
  supportsCleanFrame?: boolean;
  /** Per-engine receipt renderer for a completed send result. */
  renderReceipt?: (result: DirectorDccEngineSendResult, t: (source: string) => string) => ReactNode;
  /** Per-engine live-link preview status section. */
  liveLink: ReactNode;
  /** Callback fired after a completed send (surfaces the note in the menu footer). */
  onEngineSendCompleted?: (result: DirectorDccEngineSendResult) => void;
}

function TruncatedList({ items, label, tone }: { items: string[]; label: string; tone?: "warning" | "danger" }) {
  if (!items.length) return null;
  return (
    <ul
      aria-label={label}
      className={`director-engine-handoff-list${tone === "danger" ? " is-danger" : tone === "warning" ? " is-warning" : ""}`}
    >
      {items.slice(0, 6).map((item) => (
        <li key={item}>{item}</li>
      ))}
      {items.length > 6 ? <li className="director-engine-handoff-more">+{items.length - 6}</li> : null}
    </ul>
  );
}

function ReadinessChip({
  ready,
  readyLabel,
  notReadyLabel,
}: {
  ready: boolean;
  readyLabel: string;
  notReadyLabel: string;
}) {
  return (
    <span className={ready ? "is-ready" : "is-unavailable"}>
      {ready ? <CheckCircle2 aria-hidden size={11} /> : <TriangleAlert aria-hidden size={11} />}
      {ready ? readyLabel : notReadyLabel}
    </span>
  );
}

/**
 * 单引擎交接详情:状态芯片、健康检查、发送与回执、回传与受控应用、实时预览。
 */
export function EngineDetailPanel({
  engine,
  status,
  catalogError,
  catalogLoading,
  onRefresh,
  sendNotes,
  supportsCleanFrame = false,
  renderReceipt,
  liveLink,
  onEngineSendCompleted,
}: EngineDetailPanelProps) {
  const { t } = useLanguage();
  const healthRequestRef = useRef<AbortController | null>(null);
  const [health, setHealth] = useState<DirectorDccEngineHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [healthLoading, setHealthLoading] = useState(true);
  const [cleanFrame, setCleanFrame] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<DirectorDccEngineSendResult | null>(null);
  const [sendError, setSendError] = useState<{ message: string; recovery: string[] } | null>(null);
  const [returnDir, setReturnDir] = useState("");
  const [includeNewObjects, setIncludeNewObjects] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [receivePreview, setReceivePreview] = useState<EngineReturnPreviewState | null>(null);
  const [receiveError, setReceiveError] = useState<{ message: string; recovery: string[] } | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [appliedSummary, setAppliedSummary] = useState("");

  const loadHealth = useCallback(async () => {
    healthRequestRef.current?.abort();
    const controller = new AbortController();
    healthRequestRef.current = controller;
    setHealthLoading(true);
    setHealthError("");
    try {
      const next = await fetchDirectorDccEngineHealth(engine, { signal: controller.signal });
      if (!controller.signal.aborted) setHealth(next);
    } catch (error) {
      if (!controller.signal.aborted) {
        setHealth(null);
        setHealthError(error instanceof Error ? error.message : t("引擎连接器健康检查失败"));
      }
    } finally {
      if (!controller.signal.aborted) setHealthLoading(false);
    }
  }, [engine, t]);

  useEffect(() => {
    void loadHealth();
    return () => healthRequestRef.current?.abort();
  }, [loadHealth]);

  const provider = status?.provider ?? null;
  const nativeReady = Boolean(status?.nativeReady);
  const recoverySteps = health?.recovery ?? [];
  const busy = sending || previewing || applying;

  async function sendToEngine() {
    if (!nativeReady || busy) return;
    setSending(true);
    setSendError(null);
    setSendResult(null);
    try {
      const result = await sendDirectorProjectToEngine({
        provider: engine,
        ...(supportsCleanFrame && cleanFrame ? { cleanFrame: true } : {}),
      });
      setSendResult(result);
      if (result.report.returnPackageDir) {
        setReturnDir(`${result.jobId}/${result.report.returnPackageDir}`);
      }
      onEngineSendCompleted?.(result);
    } catch (error) {
      if (error instanceof DirectorDccProviderClientError) {
        setSendError({ message: error.message, recovery: error.diagnostics?.recovery ?? [] });
      } else {
        setSendError({ message: error instanceof Error ? error.message : t("引擎发送失败"), recovery: [] });
      }
    } finally {
      setSending(false);
    }
  }

  async function previewReturn() {
    const packageDir = returnDir.trim();
    if (!packageDir || busy) return;
    setPreviewing(true);
    setReceiveError(null);
    setReceivePreview(null);
    setReviewConfirmed(false);
    setApplied(false);
    setAppliedSummary("");
    try {
      const preview = await previewDirectorDccReturnPackage(packageDir, engine, {
        includeNewObjects,
      });
      setReceivePreview({ plan: preview.plan, summary: preview.summary, ready: preview.ready });
    } catch (error) {
      if (error instanceof DirectorDccReturnClientError) {
        setReceiveError({
          message: error.message,
          recovery: error.recovery ? [error.recovery] : [],
        });
      } else {
        setReceiveError({ message: error instanceof Error ? error.message : t("引擎回传预览失败"), recovery: [] });
      }
    } finally {
      setPreviewing(false);
    }
  }

  async function applyReturn() {
    if (!receivePreview?.ready || !reviewConfirmed || busy || applied) return;
    setApplying(true);
    setReceiveError(null);
    try {
      const result = await applyDirectorDccImportPlan(receivePreview.plan, engine);
      setApplied(true);
      setAppliedSummary(`${t("引擎回传已应用")} · ${result.copiedAssets.length} ${t("个细化资产")}`);
    } catch (error) {
      if (error instanceof DirectorDccReturnClientError) {
        setReceiveError({
          message: error.message,
          recovery: error.recovery ? [error.recovery] : [],
        });
      } else {
        setReceiveError({ message: error instanceof Error ? error.message : t("引擎回传应用失败"), recovery: [] });
      }
    } finally {
      setApplying(false);
    }
  }

  const report = sendResult?.report ?? null;
  const returnWarnings = receivePreview
    ? filterDccReturnWarningsWithoutTypedEchoes(receivePreview.plan.warnings, receivePreview.plan)
    : [];
  const planSegments = receivePreview
    ? [
        `${receivePreview.summary.operation_count} ${t("项更新")}`,
        `${receivePreview.summary.skipped_count} ${t("项跳过")}`,
        `${receivePreview.summary.conflict_count} ${t("项冲突")}`,
        ...(receivePreview.plan.omittedOptics?.length
          ? [`${receivePreview.plan.omittedOptics.length} ${t("项省略光学")}`]
          : []),
        ...(receivePreview.plan.omittedAdditions?.length
          ? [`${receivePreview.plan.omittedAdditions.length} ${t("项省略新增")}`]
          : []),
        `${returnWarnings.length} ${t("条提示")}`,
      ]
    : [];

  return (
    <div className="director-engine-handoff-detail" data-engine={engine}>
      <section aria-label={`${provider?.label ?? engine} ${t("连接状态")}`} className="director-engine-handoff-block">
        <div className="director-engine-handoff-block-heading">
          <strong>{t("连接状态")}</strong>
          <button
            aria-label={t("刷新引擎连接状态")}
            className="ui-icon-button"
            disabled={healthLoading || Boolean(catalogLoading)}
            onClick={() => {
              onRefresh();
              void loadHealth();
            }}
            type="button"
          >
            <RefreshCw aria-hidden className={healthLoading ? "is-spinning" : undefined} size={13} />
          </button>
        </div>
        {catalogError ? (
          <p className="director-engine-handoff-error" role="alert">
            {catalogError}
          </p>
        ) : null}
        {!status && !catalogError ? (
          <p className="director-engine-handoff-empty">
            {catalogLoading ? t("正在发现 DCC 提供方…") : t("提供方目录中没有该引擎")}
          </p>
        ) : null}
        {status ? (
          <div className="director-engine-handoff-readiness">
            <ReadinessChip notReadyLabel={t("未检测到安装")} ready={status.installed} readyLabel={t("已检测安装")} />
            <ReadinessChip
              notReadyLabel={t("原生连接未就绪")}
              ready={status.nativeReady}
              readyLabel={t("原生连接就绪")}
            />
            <ReadinessChip
              notReadyLabel={t("交换包不可用")}
              ready={status.exchangeReady}
              readyLabel={t("交换包就绪")}
            />
          </div>
        ) : null}
        {provider ? (
          <ul aria-label={`${provider.label} ${t("能力")}`} className="director-engine-handoff-capabilities">
            {provider.capabilities.map((capability) => (
              <li data-capability={capability.id} data-level={capability.level} key={capability.id}>
                <span>{t(CAPABILITY_LABELS[capability.id] ?? capability.id)}</span>
                <em>{t(CAPABILITY_LEVEL_LABELS[capability.level])}</em>
              </li>
            ))}
          </ul>
        ) : null}
        {healthError ? (
          <p className="director-engine-handoff-error" role="alert">
            {healthError}
          </p>
        ) : null}
        {health ? (
          <dl aria-label={`${provider?.label ?? engine} ${t("连接器详情")}`} className="director-engine-handoff-facts">
            <div>
              <dt>{t("连接器版本")}</dt>
              <dd>{health.connectorVersion ?? t("未知")}</dd>
            </div>
            <div>
              <dt>{t("主机版本")}</dt>
              <dd>{health.hostVersion ?? t("未检测到")}</dd>
            </div>
            <div>
              <dt>{t("引擎项目")}</dt>
              <dd data-i18n-user-content title={health.projectPath ?? undefined}>
                {health.projectPath ?? t("未配置")}
              </dd>
            </div>
          </dl>
        ) : null}
        {health && !health.ready ? (
          <>
            <TruncatedList items={health.warnings} label={t("连接器警告")} tone="warning" />
            <TruncatedList items={health.recovery} label={t("恢复步骤")} />
          </>
        ) : null}
      </section>

      <EngineRunSection engine={engine} />

      <section aria-label={`${provider?.label ?? engine} ${t("发送")}`} className="director-engine-handoff-block">
        <div className="director-engine-handoff-block-heading">
          <strong>{t("无头发送")}</strong>
        </div>
        <ul className="director-engine-handoff-notes">
          {sendNotes.map((note) => (
            <li key={note}>{t(note)}</li>
          ))}
        </ul>
        {supportsCleanFrame ? (
          <label className="director-engine-handoff-opt-in">
            <input
              checked={cleanFrame}
              disabled={busy}
              onChange={(event) => setCleanFrame(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>{t("同时渲染一张洁净帧（无辅助线/标签；失败只降级为跳过回执）")}</span>
          </label>
        ) : null}
        <button
          aria-label={`${t("通过原生连接器发送到")} ${provider?.label ?? engine}`}
          className="director-engine-handoff-send"
          disabled={!nativeReady || busy}
          onClick={() => void sendToEngine()}
          title={nativeReady ? undefined : (recoverySteps[0] ?? t("原生连接器未就绪；请先配置引擎项目与可执行文件"))}
          type="button"
        >
          <Send aria-hidden size={12} />
          {sending ? t("发送中…") : t("无头发送到引擎")}
        </button>
        {sendError ? (
          <div className="director-engine-handoff-error" role="alert">
            <p>{sendError.message}</p>
            <TruncatedList items={sendError.recovery} label={t("恢复步骤")} />
          </div>
        ) : null}
        {sendResult && report ? (
          <div className="director-engine-handoff-receipt" data-engine-receipt={engine}>
            <div className="director-engine-handoff-receipt-heading">
              <span className="is-ready">
                <CheckCircle2 aria-hidden size={11} /> {t("引擎已导入")}
              </span>
              <small data-i18n-user-content title={report.scenePath ?? undefined}>
                {report.scenePath ?? t("未写入场景路径")}
              </small>
            </div>
            <dl aria-label={t("引擎导入回执")} className="director-engine-handoff-facts">
              <div>
                <dt>{t("对象")}</dt>
                <dd>{report.importedObjectCount}</dd>
              </div>
              <div>
                <dt>{t("相机")}</dt>
                <dd>{report.importedCameraCount}</dd>
              </div>
              <div>
                <dt>{t("主机")}</dt>
                <dd data-i18n-user-content>{report.hostVersion}</dd>
              </div>
              <div>
                <dt>{t("连接器")}</dt>
                <dd data-i18n-user-content>{report.connectorVersion}</dd>
              </div>
            </dl>
            {renderReceipt?.(sendResult, t)}
            <TruncatedList items={sendResult.warnings} label={t("发送提示")} tone="warning" />
          </div>
        ) : null}
      </section>

      <section aria-label={`${provider?.label ?? engine} ${t("回传")}`} className="director-engine-handoff-block">
        <div className="director-engine-handoff-block-heading">
          <strong>{t("引擎回传")}</strong>
          <small>{t("先预览 stable ID 差异，审阅后再应用")}</small>
        </div>
        <div className="director-engine-handoff-return-controls">
          <input
            aria-label={t("回传包路径")}
            className="ui-field"
            disabled={busy}
            onChange={(event) => {
              setReturnDir(event.currentTarget.value);
              setReceivePreview(null);
              setReviewConfirmed(false);
              setApplied(false);
            }}
            placeholder="JOB_ID/return"
            spellCheck={false}
            value={returnDir}
          />
          <button disabled={busy || !returnDir.trim()} onClick={() => void previewReturn()} type="button">
            {previewing ? t("预览中…") : t("预览差异")}
          </button>
        </div>
        <label className="director-engine-handoff-opt-in">
          <input
            checked={includeNewObjects}
            disabled={busy}
            onChange={(event) => {
              setIncludeNewObjects(event.currentTarget.checked);
              setReceivePreview(null);
              setReviewConfirmed(false);
              setApplied(false);
            }}
            type="checkbox"
          />
          <span>{t("纳入引擎新建对象（经审阅后作为道具导入）")}</span>
        </label>
        {receiveError ? (
          <div className="director-engine-handoff-error" role="alert">
            <p>{receiveError.message}</p>
            <TruncatedList items={receiveError.recovery} label={t("恢复步骤")} />
          </div>
        ) : null}
        {receivePreview ? (
          <div className="director-engine-handoff-plan">
            <span data-ready={receivePreview.ready}>{receivePreview.ready ? t("可应用") : t("有冲突")}</span>
            <p>{planSegments.join(" · ")}</p>
            <TruncatedList
              items={receivePreview.plan.conflicts.map((conflict) => conflict.reason)}
              label={t("回传冲突")}
              tone="danger"
            />
            <DccReturnOmittedLists
              detailClassName="director-engine-handoff-omit-detail"
              listClassName="director-engine-handoff-list is-warning"
              moreClassName="director-engine-handoff-more"
              plan={receivePreview.plan}
              t={t}
            />
            <TruncatedList items={returnWarnings} label={t("回传提示")} tone="warning" />
            <label className="director-engine-handoff-opt-in">
              <input
                checked={reviewConfirmed}
                disabled={busy || !receivePreview.ready || applied}
                onChange={(event) => setReviewConfirmed(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>{t("我已审阅上方差异，确认应用到当前场景")}</span>
            </label>
            <button
              className="director-engine-handoff-apply"
              disabled={busy || !receivePreview.ready || !reviewConfirmed || applied}
              onClick={() => void applyReturn()}
              type="button"
            >
              {applied ? t("已应用到当前场景") : applying ? t("应用中…") : t("应用引擎回传")}
            </button>
            {applied && appliedSummary ? (
              <output className="director-engine-handoff-applied">{appliedSummary}</output>
            ) : null}
          </div>
        ) : null}
      </section>

      <EngineSceneImportSection engine={engine} />

      <section aria-label={`${provider?.label ?? engine} ${t("实时预览")}`} className="director-engine-handoff-block">
        <div className="director-engine-handoff-block-heading">
          <strong>{t("实时预览链路")}</strong>
          <small>{t("仅预览，绝不写入工程；持久通道始终是经审阅的交换/回传包")}</small>
        </div>
        {liveLink}
      </section>
    </div>
  );
}
