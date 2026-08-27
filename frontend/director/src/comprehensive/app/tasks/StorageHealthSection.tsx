/**
 * Minimal read-only storage/jobs health section for the task tray: usage
 * estimates, sweep candidates, recent GC results, and an explicit two-step
 * sweep (dry-run plan first, then a confirm button that echoes the plan id).
 *
 * @module StorageHealthSection
 */

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../../i18n/language";
import {
  fetchStorageHealth,
  formatStorageBytes,
  planStorageGc,
  sweepStorageGc,
  type StorageGcPlanSummary,
  type StorageGcSweepOutcome,
  type StorageHealthSummary,
} from "./storageHealthClient";
import { formatTaskRelativeTime } from "./taskTrayPresentation";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Typed write-probe failure codes mapped to the source-language row copy. */
const WRITE_PROBE_FAILURE_TEXT = {
  put_failed: "写入失败",
  verify_failed: "回读校验失败",
  delete_failed: "探针清理失败",
} as const;

/**
 * Renders the storage health rows plus the explicit plan → confirm sweep
 * flow. Planning is always a dry run; sweeping only ever consumes the exact
 * reviewed plan and reports the recorded outcome.
 */
export function StorageHealthSection() {
  const { t } = useLanguage();
  const [health, setHealth] = useState<StorageHealthSummary | null>(null);
  const [plan, setPlan] = useState<StorageGcPlanSummary | null>(null);
  const [outcome, setOutcome] = useState<StorageGcSweepOutcome | null>(null);
  const [busy, setBusy] = useState<"health" | "plan" | "sweep" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy("health");
    setError(null);
    try {
      setHealth(await fetchStorageHealth());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestPlan = useCallback(async () => {
    setBusy("plan");
    setError(null);
    setOutcome(null);
    try {
      setPlan(await planStorageGc());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const confirmSweep = useCallback(async () => {
    if (!plan) return;
    setBusy("sweep");
    setError(null);
    try {
      setOutcome(await sweepStorageGc(plan.planId));
      setPlan(null);
      setHealth(await fetchStorageHealth());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }, [plan]);

  const lastSweep = health?.recentSweeps[0];

  return (
    <section className="task-tray-section task-tray-storage">
      <h3>{t("存储健康")}</h3>
      {error ? <p className="task-tray-notice is-error">{error}</p> : null}
      {health ? (
        <>
          <p className="task-tray-item-phase">
            {[
              health.backend === "filesystem" ? t("文件系统后端") : t("对象存储后端"),
              health.policy.source === "environment" ? t("环境变量策略") : t("默认保守策略"),
            ].join(" · ")}
          </p>
          <div className="task-tray-storage-rows">
            <span>{t("产物占用")}</span>
            <span>{formatStorageBytes(health.usage.jobArtifacts.bytes)}</span>
            <span>{t("暂存输入")}</span>
            <span>{formatStorageBytes(health.usage.stagedMediaInputs.bytes)}</span>
            {health.capacity ? (
              <>
                <span>{t("剩余空间")}</span>
                {health.capacity.status === "measured" ? (
                  <span>
                    {`${formatStorageBytes(health.capacity.availableBytes)} / ${formatStorageBytes(health.capacity.totalBytes)}`}
                  </span>
                ) : (
                  <span className="is-error" title={health.capacity.reason}>
                    {t(health.capacity.code === "capacity_unsupported" ? "后端不支持容量测量" : "容量探测失败")}
                  </span>
                )}
              </>
            ) : null}
            {health.writeProbe ? (
              <>
                <span>{t("写入探针")}</span>
                {health.writeProbe.status === "ok" ? (
                  <span>
                    {[
                      t("可写"),
                      `${Math.round(health.writeProbe.latencyMs)} ms`,
                      health.writeProbe.bytesProbed !== undefined
                        ? t(`已回读 ${formatStorageBytes(health.writeProbe.bytesProbed)}`)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : (
                  <span className="is-error" title={health.writeProbe.reason}>
                    {t(WRITE_PROBE_FAILURE_TEXT[health.writeProbe.code])}
                  </span>
                )}
              </>
            ) : null}
            <span>{t("可清扫")}</span>
            <span>
              {health.sweepCandidates.count > 0
                ? t(`${health.sweepCandidates.count} 个对象（${formatStorageBytes(health.sweepCandidates.bytes)}）`)
                : t("无")}
            </span>
            <span>{t("最近清扫")}</span>
            <span>
              {lastSweep
                ? `${t(formatTaskRelativeTime(lastSweep.sweptAt))} · ${formatStorageBytes(lastSweep.reclaimedBytes)}`
                : t("暂无清扫记录")}
            </span>
          </div>
        </>
      ) : busy === "health" ? (
        <p className="task-tray-item-phase">{t("正在读取存储健康…")}</p>
      ) : null}
      <span className="task-tray-item-actions">
        <button disabled={busy !== null} onClick={() => void refresh()} type="button">
          {t("刷新")}
        </button>
        <button disabled={busy !== null} onClick={() => void requestPlan()} type="button">
          {t(busy === "plan" ? "计划中…" : "生成清扫计划（试运行）")}
        </button>
      </span>
      {plan ? (
        plan.sweep.count > 0 ? (
          <>
            <p className="task-tray-notice">{t("试运行完成，尚未删除任何对象。")}</p>
            <span className="task-tray-item-actions">
              <button disabled={busy !== null} onClick={() => void confirmSweep()} type="button">
                {t(
                  busy === "sweep"
                    ? "清扫中…"
                    : `确认清扫 ${plan.sweep.count} 个对象（${formatStorageBytes(plan.sweep.bytes)}）`,
                )}
              </button>
            </span>
          </>
        ) : (
          <p className="task-tray-item-phase">{t("暂无可清扫对象")}</p>
        )
      ) : null}
      {outcome ? (
        <p className="task-tray-notice">
          {t(`已清扫 ${outcome.deletedCount} 个对象，回收 ${formatStorageBytes(outcome.reclaimedBytes)}`)}
        </p>
      ) : null}
    </section>
  );
}
