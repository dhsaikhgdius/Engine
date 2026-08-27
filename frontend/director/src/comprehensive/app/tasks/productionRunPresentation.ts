import type { AgentUsageSummary } from "../../../../../../packages/protocol/src/agentObservabilityProtocol";
import {
  filmRunIntraPhaseSceneProgress,
  filmRunProgress,
  type FilmRunPhase,
} from "../../../../../../packages/protocol/src/filmPipelineProtocol";
import {
  FILM_RUN_USAGE_SCOPES,
  emptyFilmRunUsage,
  type FilmRunUsageScope,
} from "../../../../../../packages/protocol/src/filmRunUsage";
import type { FilmRunArtifactStoragePresence } from "../../../../../../packages/protocol/src/filmRunReceipt";
import type { DirectorMonitoredProductionRun } from "./productionRunTaskClient";

/** One absent-artifact warning line for the task tray (zh-CN source copy). */
export type ProductionRunAbsentArtifactWarning = {
  key: string;
  message: string;
};

/** zh-CN source labels for durable film-run usage scopes (receipt / tray). */
const FILM_RUN_USAGE_SCOPE_LABELS: Record<FilmRunUsageScope, string> = {
  "film-llm": "规划 LLM",
  "film-image": "图像生成",
  "film-video": "视频生成",
  "film-tts": "语音合成",
};

/** One non-empty per-scope usage line for the task tray. */
export type ProductionRunUsageLine = {
  scope: FilmRunUsageScope;
  /** zh-CN source label for the scope. */
  label: string;
  summary: AgentUsageSummary;
};

const FILM_PHASES: readonly FilmRunPhase[] = [
  "develop-story",
  "extract-characters",
  "write-scenes",
  "plan-scenes",
  "await-approval",
  "render",
  "assemble",
  "completed",
];

const FILM_PHASE_LABELS: Record<FilmRunPhase, string> = {
  "develop-story": "故事开发",
  "extract-characters": "提取角色",
  "write-scenes": "编写场景",
  "plan-scenes": "规划镜头",
  "await-approval": "等待审批",
  render: "渲染镜头",
  assemble: "组装成片",
  completed: "制作完成",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

function compactName(value: string, fallback: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/**
 * Returns a localized type label for a production run.
 *
 * @param entry - The monitored production run.
 * @returns "电影管线" for film runs.
 */
export function productionRunTypeLabel(_entry: DirectorMonitoredProductionRun) {
  return "电影管线";
}

/**
 * Returns a human-readable display name for a production run,
 * derived from the run's idea or script text.
 *
 * @param entry - The monitored production run.
 * @returns A compact name, truncated to 80 characters when necessary.
 */
export function productionRunDisplayName(entry: DirectorMonitoredProductionRun) {
  const source = entry.run.input.idea ?? entry.run.input.script ?? entry.run.input.sceneScripts?.[0] ?? "";
  return compactName(source, entry.run.workflow === "idea-to-film" ? "从创意生成电影" : "从剧本生成电影");
}

/**
 * Returns the raw status string of a production run.
 *
 * @param entry - The monitored production run.
 */
export function productionRunStatus(entry: DirectorMonitoredProductionRun) {
  return entry.run.status;
}

/**
 * Returns a localized status label for a production run.
 *
 * @param entry - The monitored production run.
 * @returns A Chinese label, or the raw status as a fallback.
 */
export function productionRunStatusLabel(entry: DirectorMonitoredProductionRun) {
  return STATUS_LABELS[entry.run.status] ?? entry.run.status;
}

/**
 * Returns the current film-pipeline phase with a label, current index, and total count.
 *
 * @param entry - The monitored production run.
 * @returns An object with `label`, `current` (1-based), and `total`.
 */
export function productionRunStage(entry: DirectorMonitoredProductionRun) {
  const index = Math.max(0, FILM_PHASES.indexOf(entry.run.phase));
  return {
    label: FILM_PHASE_LABELS[entry.run.phase],
    current: index + 1,
    total: FILM_PHASES.length,
  };
}

/**
 * Returns the progress percentage (0–100) of a production run.
 *
 * Uses the same {@link filmRunProgress} helper as film run receipts and
 * unified agent progress so the task tray never invents a second scale
 * (stage current/total was off-by-one vs the phase-floor contract).
 *
 * @param entry - The monitored production run.
 * @returns An integer between 0 and 100.
 */
export function productionRunProgressPercent(entry: DirectorMonitoredProductionRun) {
  const fraction = filmRunProgress(entry.run);
  if (fraction === null) return 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/**
 * Returns the latest durable progress message from the film run event log,
 * matching the unified progress adapter (`run.events.at(-1)?.message`).
 *
 * @param entry - The monitored production run.
 */
export function productionRunLatestMessage(entry: DirectorMonitoredProductionRun): string | null {
  const message = entry.run.events.at(-1)?.message?.trim();
  return message || null;
}

/**
 * Returns intra-phase scene completion copy during plan-scenes or render.
 * Null when the run is outside those phases or has no scenes yet.
 *
 * @param entry - The monitored production run.
 */
export function productionRunIntraPhaseDetail(entry: DirectorMonitoredProductionRun): string | null {
  const progress = filmRunIntraPhaseSceneProgress(entry.run);
  if (!progress) return null;
  if (progress.phase === "plan-scenes") {
    return `已规划 ${progress.completed}/${progress.total} 场景`;
  }
  return `已渲染 ${progress.completed}/${progress.total} 场景`;
}

/**
 * Returns whether the tray should show the latest durable event message.
 *
 * @param entry - The monitored production run.
 */
export function productionRunShowsLatestMessage(entry: DirectorMonitoredProductionRun) {
  const status = entry.run.status;
  return status === "queued" || status === "running" || status === "waiting_approval";
}

/**
 * Returns the most precise failure reason for a production run.
 *
 * @param entry - The monitored production run.
 * @returns A trimmed error message, or null when no error is available.
 */
export function productionRunFailureReason(entry: DirectorMonitoredProductionRun) {
  return entry.run.error?.trim() || null;
}

/**
 * Returns whether a production run can be cancelled in its current state.
 *
 * @param entry - The monitored production run.
 */
export function productionRunCanCancel(entry: DirectorMonitoredProductionRun) {
  return entry.run.status === "queued" || entry.run.status === "running" || entry.run.status === "waiting_approval";
}

/**
 * Returns whether a production run should keep the fast polling loop alive.
 * True for queued and running runs.
 *
 * @param entry - The monitored production run.
 */
export function productionRunKeepsFastPolling(entry: DirectorMonitoredProductionRun) {
  return entry.run.status === "queued" || entry.run.status === "running";
}

/**
 * Returns whether a production run counts as active for badge and polling purposes.
 * Includes queued, running, and waiting_approval runs.
 *
 * @param entry - The monitored production run.
 */
export function productionRunCountsAsActive(entry: DirectorMonitoredProductionRun) {
  return productionRunKeepsFastPolling(entry) || entry.run.status === "waiting_approval";
}

/**
 * Returns whether a production run has reached a terminal state.
 *
 * @param entry - The monitored production run.
 */
export function productionRunIsFinished(entry: DirectorMonitoredProductionRun) {
  return entry.run.status === "completed" || entry.run.status === "failed" || entry.run.status === "cancelled";
}

/**
 * Returns non-empty durable per-scope usage lines from the film run document
 * (same rollup projected onto `director-film-run-receipt-v1`). Empty when the
 * run has no metered samples yet — the tray never invents a second meter.
 *
 * @param entry - The monitored production run.
 */
export function productionRunUsageLines(entry: DirectorMonitoredProductionRun): ProductionRunUsageLine[] {
  const usage = entry.run.usage ?? emptyFilmRunUsage();
  return FILM_RUN_USAGE_SCOPES.filter((scope) => usage[scope].sample_count > 0).map((scope) => ({
    scope,
    label: FILM_RUN_USAGE_SCOPE_LABELS[scope],
    summary: usage[scope],
  }));
}

/**
 * Formats one durable film-run usage line for the task tray.
 * LLM scopes emphasize tokens; image/video/speech emphasize sample count and
 * wall-clock (tokens stay 0 for media and speech HTTP meters).
 *
 * @param line - A non-empty usage line from {@link productionRunUsageLines}.
 * @param translate - Optional zh→locale mapper for the scope label.
 */
export function formatProductionRunUsageLine(
  line: ProductionRunUsageLine,
  translate: (source: string) => string = (source) => source,
): string {
  const label = translate(line.label);
  const durationSec = Math.max(0, Math.round(line.summary.total_duration_ms / 1000));
  const failure = line.summary.failure_count > 0 ? ` · ${translate("失败")} ${line.summary.failure_count}` : "";
  if (line.scope === "film-llm") {
    return `${label} ${line.summary.total_tokens} tokens · ${durationSec}s${failure}`;
  }
  return `${label} ${line.summary.sample_count} ${translate("次")} · ${durationSec}s${failure}`;
}

/**
 * Returns whether the run claims any artifact paths worth probing.
 *
 * @param entry - The monitored production run.
 */
export function productionRunMayHaveClaimedArtifacts(entry: DirectorMonitoredProductionRun) {
  const run = entry.run;
  if (run.finalVideoPath !== null || run.timelinePath !== null) return true;
  return (run.scenes ?? []).some((scene) => scene.videoPath !== null);
}

/**
 * Returns whether the tray should show a pending artifact-presence state.
 * True when the live receipt has not loaded yet but the run claims artifacts.
 *
 * @param entry - The monitored production run.
 */
export function productionRunArtifactPresencePending(entry: DirectorMonitoredProductionRun) {
  return entry.receipt === undefined && productionRunMayHaveClaimedArtifacts(entry);
}

/**
 * Formats zh-CN warning lines for absent probed artifacts on a live receipt.
 *
 * @param presence - Live `artifacts.storagePresence` from a film run receipt.
 */
export function formatProductionRunAbsentArtifactWarnings(
  presence: FilmRunArtifactStoragePresence,
): ProductionRunAbsentArtifactWarning[] {
  const warnings: ProductionRunAbsentArtifactWarning[] = [];
  if (presence.finalVideo === "absent") {
    warnings.push({ key: "finalVideo", message: "成片文件已不在存储中" });
  }
  if (presence.timeline === "absent") {
    warnings.push({ key: "timeline", message: "时间线文件已不在存储中" });
  }
  for (const scene of presence.sceneVideos) {
    if (scene.presence !== "absent") continue;
    warnings.push({
      key: `scene-${scene.sceneIdx}`,
      message: `场景 ${scene.sceneIdx + 1} 渲染视频已不在存储中`,
    });
  }
  return warnings;
}

/**
 * Returns absent-artifact warnings for a monitored production run.
 * Empty when the receipt is not loaded, has no probe, or every byte is present.
 *
 * @param entry - The monitored production run.
 */
export function productionRunAbsentArtifactWarnings(entry: DirectorMonitoredProductionRun) {
  const presence = entry.receipt?.artifacts.storagePresence;
  return presence ? formatProductionRunAbsentArtifactWarnings(presence) : [];
}
