/**
 * Dropdown tray that lists active and finished production runs and background tasks.
 *
 * @module DirectorTaskTrayMenu
 */

import "./taskTray.css";
import { useEffect, useMemo } from "react";
import { ListChecks } from "lucide-react";
import { useLanguage } from "../../i18n/language";
import { useDropdownDisclosure } from "../../editor/useDropdownDisclosure";
import { useDirectorSessionRuntime } from "../../editor/session/directorSessionRuntime";
import type { ProductionJobRecord } from "../../../../../../packages/protocol/src/productionJobProtocol";
import {
  cancelDirectorTask,
  cancelDirectorProductionRun,
  clearFinishedDirectorTasks,
  countActiveDirectorTasks,
  dismissDirectorProductionRun,
  dismissDirectorTask,
  retryDirectorTask,
  setDirectorTaskTrayPanelOpen,
  startDirectorTaskTrayPolling,
  useDirectorTaskTray,
  visibleDirectorProductionRuns,
  visibleDirectorTasks,
} from "./directorTaskTrayStore";
import { monitoredProductionRunKey, type DirectorMonitoredProductionRun } from "./productionRunTaskClient";
import {
  productionRunCanCancel,
  productionRunDisplayName,
  productionRunFailureReason,
  productionRunIsFinished,
  productionRunProgressPercent,
  productionRunStage,
  productionRunStatus,
  productionRunStatusLabel,
  productionRunTypeLabel,
} from "./productionRunPresentation";
import { taskIsFinished, taskSupportsCancel, taskSupportsRetry } from "./productionTaskClient";
import {
  formatTaskRelativeTime,
  taskDisplayName,
  taskFailureReason,
  taskKindLabel,
  taskProgressPercent,
  taskStartedAt,
  taskStatusLabel,
} from "./taskTrayPresentation";

function TaskTrayItem({ job, pending }: { job: ProductionJobRecord; pending: boolean }) {
  const { t } = useLanguage();
  const failureReason = job.status === "failed" ? taskFailureReason(job) : null;
  const percent = taskProgressPercent(job);
  const finished = taskIsFinished(job);

  return (
    <li className={`task-tray-item is-${job.status}`}>
      <div className="task-tray-item-top">
        <span className="task-tray-item-kind">{taskKindLabel(job.kind)}</span>
        <span className="task-tray-item-name" title={taskDisplayName(job)}>
          {taskDisplayName(job)}
        </span>
        <span className={`task-tray-item-status is-${job.status}`}>{taskStatusLabel(job.status)}</span>
      </div>
      {job.status === "running" ? (
        <div className="task-tray-item-progress-row">
          <div
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={percent}
            className="task-tray-progress"
            role="progressbar"
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="task-tray-progress-value">{percent}%</span>
        </div>
      ) : null}
      {job.status === "running" && job.message ? <p className="task-tray-item-phase">{job.message}</p> : null}
      {failureReason ? <p className="task-tray-item-error">{failureReason}</p> : null}
      <div className="task-tray-item-meta">
        <span className="task-tray-item-time">{formatTaskRelativeTime(taskStartedAt(job))}</span>
        <span className="task-tray-item-actions">
          {taskSupportsCancel(job) ? (
            <button disabled={pending} onClick={() => void cancelDirectorTask(job.id)} type="button">
              {t(pending ? "取消中…" : "取消")}
            </button>
          ) : null}
          {taskSupportsRetry(job) ? (
            <button disabled={pending} onClick={() => void retryDirectorTask(job.id)} type="button">
              {t(pending ? "重试中…" : "重试")}
            </button>
          ) : null}
          {finished ? (
            <button onClick={() => dismissDirectorTask(job.id)} type="button">
              {t("清除")}
            </button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function ProductionRunTrayItem({ entry, pending }: { entry: DirectorMonitoredProductionRun; pending: boolean }) {
  const { t } = useLanguage();
  const key = monitoredProductionRunKey(entry);
  const status = productionRunStatus(entry);
  const stage = productionRunStage(entry);
  const percent = productionRunProgressPercent(entry);
  const failureReason = status === "failed" ? productionRunFailureReason(entry) : null;
  const finished = productionRunIsFinished(entry);

  return (
    <li className={`task-tray-item is-${status}`}>
      <div className="task-tray-item-top">
        <span className="task-tray-item-kind">{productionRunTypeLabel(entry)}</span>
        <span className="task-tray-item-name" title={productionRunDisplayName(entry)}>
          {productionRunDisplayName(entry)}
        </span>
        <span className={`task-tray-item-status is-${status}`}>{productionRunStatusLabel(entry)}</span>
      </div>
      <div className="task-tray-item-progress-row">
        <div
          aria-label={t("生产运行阶段进度")}
          aria-valuemax={stage.total}
          aria-valuemin={0}
          aria-valuenow={stage.current}
          className="task-tray-progress"
          role="progressbar"
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className="task-tray-progress-value">
          {stage.current}/{stage.total}
        </span>
      </div>
      <p className="task-tray-item-phase">{`${stage.label} · 第 ${stage.current}/${stage.total} 阶段`}</p>
      {failureReason ? <p className="task-tray-item-error">{failureReason}</p> : null}
      <div className="task-tray-item-meta">
        <span className="task-tray-item-time">{formatTaskRelativeTime(entry.run.createdAt)}</span>
        <span className="task-tray-item-actions">
          {productionRunCanCancel(entry) ? (
            <button disabled={pending} onClick={() => void cancelDirectorProductionRun(key)} type="button">
              {t(pending ? "取消中…" : "取消")}
            </button>
          ) : null}
          {finished ? (
            <button onClick={() => dismissDirectorProductionRun(key)} type="button">
              {t("清除")}
            </button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * Renders a dropdown tray with production run stages and individual background task
 * progress, cancellations, retries, and dismissals.
 */
export function DirectorTaskTrayMenu() {
  const { t } = useLanguage();
  const { dropdownRef, handleTriggerKeyDown, isOpen, setIsOpen } = useDropdownDisclosure();
  const gateway = useDirectorSessionRuntime((state) => state.gateway);
  const jobs = useDirectorTaskTray((state) => state.jobs);
  const productionRuns = useDirectorTaskTray((state) => state.productionRuns);
  const dismissedIds = useDirectorTaskTray((state) => state.dismissedIds);
  const dismissedRunKeys = useDirectorTaskTray((state) => state.dismissedRunKeys);
  const pendingActionIds = useDirectorTaskTray((state) => state.pendingActionIds);
  const pendingRunActionKeys = useDirectorTaskTray((state) => state.pendingRunActionKeys);
  const phase = useDirectorTaskTray((state) => state.phase);
  const error = useDirectorTaskTray((state) => state.error);
  const activeCount = useDirectorTaskTray(countActiveDirectorTasks);

  useEffect(() => startDirectorTaskTrayPolling(), []);
  useEffect(() => {
    setDirectorTaskTrayPanelOpen(isOpen);
  }, [isOpen]);

  const visibleTasks = useMemo(() => visibleDirectorTasks(jobs, dismissedIds), [jobs, dismissedIds]);
  const visibleRuns = useMemo(
    () => visibleDirectorProductionRuns(productionRuns, dismissedRunKeys),
    [productionRuns, dismissedRunKeys],
  );
  const hasFinishedTasks = visibleTasks.some(taskIsFinished) || visibleRuns.some(productionRunIsFinished);
  const triggerLabel = activeCount > 0 ? `任务中心（${activeCount} 个进行中）` : "任务中心";

  return (
    <div className="task-tray" ref={dropdownRef}>
      <button
        aria-controls="task-tray-popover"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={triggerLabel}
        className={`top-bar-settings-trigger${isOpen ? " is-active" : ""}`}
        title={triggerLabel}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
      >
        <ListChecks aria-hidden size={14} />
        <span className="top-bar-settings-label">{t("任务")}</span>
        {activeCount > 0 ? (
          <span aria-hidden className="task-tray-badge">
            {activeCount > 99 ? "99+" : activeCount}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div aria-label={t("任务中心")} className="task-tray-popover" id="task-tray-popover" role="dialog">
          <header className="task-tray-header">
            <strong>{t("任务中心")}</strong>
            {hasFinishedTasks ? (
              <button className="task-tray-clear" onClick={clearFinishedDirectorTasks} type="button">
                {t("清除已结束任务")}
              </button>
            ) : null}
          </header>
          {gateway !== "connected" ? <p className="task-tray-notice">{t("网关未连接，任务状态已暂停刷新。")}</p> : null}
          {phase === "error" && error ? (
            <p className="task-tray-notice is-error">{`任务列表刷新失败：${error}`}</p>
          ) : null}
          {visibleTasks.length === 0 && visibleRuns.length === 0 ? (
            <p className="task-tray-empty">
              {t(phase === "idle" && gateway === "connected" ? "正在加载任务…" : "暂无任务记录")}
            </p>
          ) : (
            <>
              {visibleRuns.length > 0 ? (
                <section className="task-tray-section">
                  <h3>{t("生产运行")}</h3>
                  <ul className="task-tray-list">
                    {visibleRuns.map((entry) => {
                      const key = monitoredProductionRunKey(entry);
                      return (
                        <ProductionRunTrayItem entry={entry} key={key} pending={pendingRunActionKeys.includes(key)} />
                      );
                    })}
                  </ul>
                </section>
              ) : null}
              {visibleTasks.length > 0 ? (
                <section className="task-tray-section">
                  <h3>{t("后台任务")}</h3>
                  <ul className="task-tray-list">
                    {visibleTasks.map((job) => (
                      <TaskTrayItem job={job} key={job.id} pending={pendingActionIds.includes(job.id)} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
