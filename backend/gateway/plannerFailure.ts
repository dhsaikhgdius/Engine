import { randomUUID } from "node:crypto";
import type { DirectorAgentId } from "@director/agent-engine";
import { BoundedTextBuffer } from "./boundedTextBuffer";
import { redactSensitiveText } from "./redaction";

/**
 * Planner incident reporting with a hard split between what leaks to HTTP
 * and what stays in gateway logs. Raw CLI diagnostics can contain prompts,
 * file paths, or tokens, so the HTTP side only ever sees a fixed allowlisted
 * category message plus a correlation incident id, while the full diagnostic
 * — redacted and bounded to a tail — is written to the internal logger under
 * the same id for operators to look up.
 */

/** Cap on the internally logged diagnostic; the head is dropped, tail kept. */
const INTERNAL_DIAGNOSTIC_MAX_BYTES = 8 * 1024;

/** Sink for the internal (non-HTTP) incident log line. */
export type InternalPlannerLogger = (message: string) => void;

type PlannerIncidentKind = "failure" | "invalid-output" | "output-limit";

function agentLabel(agent: DirectorAgentId) {
  return agent === "codex" ? "Codex" : "Claude";
}

/** Maps process diagnostics to a fixed allowlist of messages safe for HTTP. */
export function safePlannerFailureSummary(stderr: string, agent: DirectorAgentId) {
  const normalized = stderr.replace(/\s+/g, " ").trim();
  const label = agentLabel(agent);
  if (/not logged in|login required|authentication required/i.test(normalized)) return `${label} CLI 尚未登录`;
  if (/\b401\b|unauthorized|invalid api key|authentication failed/i.test(normalized)) {
    return `${label} 凭据无效或已过期`;
  }
  if (
    /stream disconnected|tls handshake|failed to send remote|error sending request|failed to connect|network error|connection (?:refused|reset|timed out)/i.test(
      normalized,
    ) ||
    (/models cache/i.test(normalized) && /failed to refresh|stale/i.test(normalized))
  ) {
    return `${label} CLI 无法连接模型服务，请检查网络或登录状态`;
  }
  if (/invalid_json_schema/i.test(normalized)) return "Agent 的结构化计划格式暂不可用，请重试";
  if (/ENOENT|not found|command not found/i.test(normalized)) return `${label} CLI 未安装或不在 PATH 中`;
  return `${label} 规划进程失败，请查看网关内部日志`;
}

// Shared incident path: one random id ties the public message to the
// redacted, bounded internal log entry.
function reportPlannerIncident(
  diagnosticValue: string,
  agent: DirectorAgentId,
  kind: PlannerIncidentKind,
  publicSummary: string,
  logger: InternalPlannerLogger,
) {
  const incidentId = randomUUID();
  const diagnostic = new BoundedTextBuffer(
    INTERNAL_DIAGNOSTIC_MAX_BYTES,
    "[... planner diagnostic truncated; showing tail ...]\n",
  );
  diagnostic.append(redactSensitiveText(diagnosticValue));
  logger(`[director-planner-${kind} id=${incidentId} agent=${agent}]\n${diagnostic.toString()}`);
  return {
    incidentId,
    publicMessage: `${publicSummary}（故障编号 ${incidentId}）`,
  };
}

/**
 * Records a bounded, redacted diagnostic internally and returns only a stable
 * category plus correlation id for the HTTP response.
 */
export function reportPlannerFailure(
  stderr: string,
  agent: DirectorAgentId,
  logger: InternalPlannerLogger = console.error,
) {
  return reportPlannerIncident(stderr, agent, "failure", safePlannerFailureSummary(stderr, agent), logger);
}

/** Reports a decoder/JSON failure without ever reflecting model output. */
export function reportPlannerInvalidOutput(
  diagnostic: string,
  agent: DirectorAgentId,
  logger: InternalPlannerLogger = console.error,
) {
  return reportPlannerIncident(
    diagnostic,
    agent,
    "invalid-output",
    `${agentLabel(agent)} 返回的结构化计划无效，请重试`,
    logger,
  );
}

/** Reports a bounded-output rejection without attempting to parse a truncated plan. */
export function reportPlannerOutputLimit(
  diagnostic: string,
  agent: DirectorAgentId,
  logger: InternalPlannerLogger = console.error,
) {
  return reportPlannerIncident(
    diagnostic,
    agent,
    "output-limit",
    `${agentLabel(agent)} 规划输出超过安全上限，请缩短请求后重试`,
    logger,
  );
}
