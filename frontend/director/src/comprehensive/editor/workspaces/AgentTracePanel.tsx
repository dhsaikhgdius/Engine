/**
 * Agent 轨迹面板：回放最近一次 Agent 会话的工具链、修订变化与模型用量。
 *
 * 数据来自 gateway 的 `/api/agent/traces/summary`、`/api/agent/usage` 与
 * `/api/agent/progress?kind=film_run`。面板只展示执行回执与聚合用量
 * （操作名、结果、耗时、修订、按 scope 的 token），从不展示提示词或密钥。
 *
 * @module agent-trace-panel
 */

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
  agentTraceSessionSummarySchema,
  agentUsageSampleSchema,
  agentUsageSummarySchema,
  summarizeAgentUsage,
  unifiedProgressSchema,
  type AgentTraceSessionSummary,
  type AgentUsageSample,
  type AgentUsageSummary,
  type UnifiedProgress,
} from "../../../../../../packages/protocol/src/agentObservabilityProtocol";
import { directorControlPlaneFetch } from "../api/directorControlPlaneClient";
import { useLanguage } from "../../i18n/language";
import "./AgentTracePanel.css";

const summaryResponseSchema = z.object({ summary: agentTraceSessionSummarySchema });
const usageResponseSchema = z.object({
  summary: agentUsageSummarySchema,
  samples: z.array(agentUsageSampleSchema).max(500).default([]),
});
const progressResponseSchema = z.object({
  entries: z.array(unifiedProgressSchema).max(200),
});

/** One usage aggregate keyed by meter scope (session id, `film-llm`, …). */
export type AgentTraceUsageScopeRow = {
  scope: string;
  summary: AgentUsageSummary;
};

/** 面板一次加载的数据：最近会话轨迹、模型用量聚合，以及 Film 统一进度。 */
export type AgentTracePanelData = {
  summary: AgentTraceSessionSummary | null;
  usage: AgentUsageSummary | null;
  usageScopes: AgentTraceUsageScopeRow[];
  filmProgress: UnifiedProgress[];
};

/**
 * Groups usage samples by scope and summarizes each bucket. Film pipeline
 * scopes sort first (`film-llm`, then `film-image`, `film-video`, `film-tts`),
 * then remaining scopes alphabetically, so render-phase metering is never
 * buried under production-session totals.
 */
export function groupUsageByScope(samples: readonly AgentUsageSample[]): AgentTraceUsageScopeRow[] {
  const byScope = new Map<string, AgentUsageSample[]>();
  for (const sample of samples) {
    const bucket = byScope.get(sample.scope) ?? [];
    bucket.push(sample);
    byScope.set(sample.scope, bucket);
  }
  const filmRank = (scope: string) => {
    if (scope === "film-llm") return 0;
    if (scope === "film-image") return 1;
    if (scope === "film-video") return 2;
    if (scope === "film-tts") return 3;
    return 100;
  };
  return [...byScope.entries()]
    .map(([scope, scoped]) => ({ scope, summary: summarizeAgentUsage(scoped) }))
    .sort((left, right) => {
      const rankDelta = filmRank(left.scope) - filmRank(right.scope);
      if (rankDelta !== 0) return rankDelta;
      return left.scope.localeCompare(right.scope);
    });
}

/** Formats a unified progress fraction as a percent label, or an em dash when unknown. */
export function formatProgressPercent(progress: number | null): string {
  if (progress === null || !Number.isFinite(progress)) return "—";
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

/**
 * Loads the latest session trace summary, usage aggregate (with per-scope
 * breakdown), and film-run unified progress from the gateway observability API.
 * A 404 from the summary endpoint means no traced session exists yet and
 * resolves to a null summary rather than an error.
 */
export async function loadAgentTracePanelData(
  fetcher: (path: string) => Promise<Response> = directorControlPlaneFetch,
): Promise<AgentTracePanelData> {
  const [summaryResponse, usageResponse, progressResponse] = await Promise.all([
    fetcher("/api/agent/traces/summary"),
    fetcher("/api/agent/usage?limit=200"),
    fetcher("/api/agent/progress?kind=film_run&limit=20"),
  ]);
  let summary: AgentTraceSessionSummary | null = null;
  if (summaryResponse.ok) {
    summary = summaryResponseSchema.parse(await summaryResponse.json()).summary;
  } else if (summaryResponse.status !== 404) {
    throw new Error(`Agent trace summary request failed (HTTP ${summaryResponse.status})`);
  }
  let usage: AgentUsageSummary | null = null;
  let usageScopes: AgentTraceUsageScopeRow[] = [];
  if (usageResponse.ok) {
    const body = usageResponseSchema.parse(await usageResponse.json());
    usage = body.summary;
    usageScopes = groupUsageByScope(body.samples);
  }
  let filmProgress: UnifiedProgress[] = [];
  if (progressResponse.ok) {
    filmProgress = progressResponseSchema.parse(await progressResponse.json()).entries;
  } else if (progressResponse.status !== 404) {
    throw new Error(`Agent progress request failed (HTTP ${progressResponse.status})`);
  }
  return { summary, usage, usageScopes, filmProgress };
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

function scopeLabel(scope: string, t: (key: string) => string): string {
  if (scope === "film-llm") return t("Film 规划 LLM");
  if (scope === "film-image") return t("Film 图像生成");
  if (scope === "film-video") return t("Film 视频生成");
  if (scope === "film-tts") return t("Film 语音合成");
  return scope;
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
  const usageScopes = data?.usageScopes ?? [];
  const filmProgress = data?.filmProgress ?? [];

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
      {!failed && !loading && !summary && filmProgress.length === 0 && !(usage && usage.sample_count > 0) ? (
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

      {filmProgress.length > 0 ? (
        <section aria-label={t("电影管线进度")} className="director-agent-trace-panel-film">
          <h3>{t("电影管线进度")}</h3>
          <ul className="director-agent-trace-panel-film-list">
            {filmProgress.map((entry) => {
              const usageScopes = entry.usage
                ? (["film-llm", "film-image", "film-video", "film-tts"] as const).filter(
                    (scope) => entry.usage![scope].sample_count > 0,
                  )
                : [];
              return (
                <li key={entry.id}>
                  <span className="director-agent-trace-panel-step-op">
                    {entry.label} · {formatProgressPercent(entry.progress)} · {entry.source_status}
                  </span>
                  {entry.message ? <span className="director-agent-trace-panel-step-meta">{entry.message}</span> : null}
                  {usageScopes.length > 0 ? (
                    <ul aria-label={t("本运行用量")} className="director-agent-trace-panel-film-usage">
                      {usageScopes.map((scope) => {
                        const summary = entry.usage![scope];
                        return (
                          <li key={scope}>
                            <span className="director-agent-trace-panel-step-op">{scopeLabel(scope, t)}</span>
                            <span className="director-agent-trace-panel-step-meta">
                              {scope === "film-llm"
                                ? `${summary.total_tokens} tokens · ${formatTraceDuration(summary.total_duration_ms)}`
                                : `${summary.sample_count} · ${formatTraceDuration(summary.total_duration_ms)}`}
                              {summary.failure_count > 0 ? ` · ${t("失败")} ${summary.failure_count}` : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
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
          {usageScopes.length > 1 ||
          usageScopes.some(
            (row) =>
              row.scope === "film-llm" ||
              row.scope === "film-image" ||
              row.scope === "film-video" ||
              row.scope === "film-tts",
          ) ? (
            <ul className="director-agent-trace-panel-usage-scopes">
              {usageScopes.map((row) => (
                <li key={row.scope}>
                  <span className="director-agent-trace-panel-step-op">{scopeLabel(row.scope, t)}</span>
                  <span className="director-agent-trace-panel-step-meta">
                    {row.summary.total_tokens} tokens · {formatTraceDuration(row.summary.total_duration_ms)}
                    {row.summary.failure_count > 0 ? ` · ${t("失败")} ${row.summary.failure_count}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
