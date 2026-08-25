/**
 * Agent 轨迹面板：回放最近一次 Agent 会话的工具链、修订变化与模型用量。
 *
 * 数据来自 gateway 的 `/api/agent/traces/summary` 与 `/api/agent/usage`，
 * 面板只展示执行回执（操作名、结果、耗时、修订），从不展示提示词或密钥。
 *
 * @module agent-trace-panel
 */

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  agentTraceSessionSummarySchema,
  agentUsageSummarySchema,
  type AgentTraceSessionSummary,
  type AgentUsageSummary,
} from "../../../../../../packages/protocol/src/agentObservabilityProtocol";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";
import { useLanguage } from "../../i18n/language";
import "./AgentTracePanel.css";

const summaryResponseSchema = z.object({ summary: agentTraceSessionSummarySchema });
const usageResponseSchema = z.object({ summary: agentUsageSummarySchema });

/** 面板一次加载的数据：最近会话轨迹（可能为空）与模型用量聚合。 */
export type AgentTracePanelData = {
  summary: AgentTraceSessionSummary | null;
  usage: AgentUsageSummary | null;
};

/**
 * Loads the latest session trace summary and the usage aggregate from the
 * gateway observability API. A 404 from the summary endpoint means no traced
 * session exists yet and resolves to a null summary rather than an error.
 */
export async function loadAgentTracePanelData(
  fetcher: (path: string) => Promise<Response> = directorControlPlaneFetch,
): Promise<AgentTracePanelData> {
  const [summaryResponse, usageResponse] = await Promise.all([
    fetcher("/api/agent/traces/summary"),
    fetcher("/api/agent/usage?limit=200"),
  ]);
  let summary: AgentTraceSessionSummary | null = null;
  if (summaryResponse.ok) {
    summary = summaryResponseSchema.parse(await summaryResponse.json()).summary;
  } else if (summaryResponse.status !== 404) {
    throw new Error(`Agent trace summary request failed (HTTP ${summaryResponse.status})`);
  }
  let usage: AgentUsageSummary | null = null;
  if (usageResponse.ok) {
    usage = usageResponseSchema.parse(await usageResponse.json()).summary;
  }
  return { summary, usage };
}

/** 简洁的耗时展示：毫秒 → `x ms` / `x.x s`。 */
export function formatTraceDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

function formatClock(iso: string) {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleTimeString();
}

/** Agent 轨迹面板组件。 */
export function AgentTracePanel({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const [data, setData] = useState<AgentTracePanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setData(await loadAgentTracePanelData());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = data?.summary ?? null;
  const usage = data?.usage ?? null;

  return (
    <aside aria-label={t("Agent 轨迹")} className="director-agent-trace-panel">
      <header className="director-agent-trace-panel-header">
        <h2>{t("Agent 轨迹")}</h2>
        <div className="director-agent-trace-panel-actions">
          <button disabled={loading} onClick={() => void refresh()} type="button">
            {t("刷新")}
          </button>
          <button aria-label={t("关闭轨迹面板")} onClick={onClose} type="button">
            ×
          </button>
        </div>
      </header>

      {failed ? <p className="director-agent-trace-panel-empty">{t("轨迹服务暂时不可用")}</p> : null}
      {!failed && !loading && !summary ? (
        <p className="director-agent-trace-panel-empty">{t("还没有可回放的 Agent 会话")}</p>
      ) : null}

      {summary ? (
        <section aria-label={t("会话摘要")} className="director-agent-trace-panel-summary">
          <p className="director-agent-trace-panel-session" title={summary.session_id}>
            {summary.session_id}
          </p>
          <p className="director-agent-trace-panel-meta">
            {summary.sources.join(" · ")} · {t("调用")} {summary.call_count} · {t("错误")} {summary.error_count} ·{" "}
            {t("冲突")} {summary.conflict_count} · {formatTraceDuration(summary.total_duration_ms)}
          </p>
          {summary.revision_start || summary.revision_end ? (
            <p className="director-agent-trace-panel-meta">
              {t("修订")} {summary.revision_start ?? "—"} → {summary.revision_end ?? "—"}
            </p>
          ) : null}
          <ol className="director-agent-trace-panel-chain">
            {summary.chain.map((step, index) => (
              <li data-outcome={step.outcome} key={`${step.started_at}-${index}`}>
                <span className="director-agent-trace-panel-step-op">
                  {step.tool} · {step.operation}
                </span>
                <span className="director-agent-trace-panel-step-meta">
                  {formatClock(step.started_at)} · {formatTraceDuration(step.duration_ms)}
                  {step.code ? ` · ${step.code}` : ""}
                  {step.capture_ref ? ` · ${t("截图")}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {usage && usage.sample_count > 0 ? (
        <section aria-label={t("模型用量")} className="director-agent-trace-panel-usage">
          <h3>{t("模型用量")}</h3>
          <p className="director-agent-trace-panel-meta">
            {usage.total_tokens} tokens（{usage.input_tokens} / {usage.output_tokens}）·{" "}
            {formatTraceDuration(usage.total_duration_ms)} · {t("重试")} {usage.retries} · {t("失败")}{" "}
            {usage.failure_count}
          </p>
        </section>
      ) : null}
    </aside>
  );
}
