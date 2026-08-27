/**
 * Human-facing presentation for `director_dcc` engine editor-launch and
 * project-run errors. Labels stay zh-CN source strings (translated via i18n);
 * codes match the `engine_run_*` contract enum exactly — the machine code is
 * always surfaced beside its label, never replaced by free text alone. Same
 * honesty pattern as transcription error codes and media.verify outcomes.
 *
 * @module engine-run-presentation
 */

import type { DirectorDccEngineRunErrorCode } from "../../../../dcc/directorDccEngineRunContract";
import { DirectorDccEngineRunClientError } from "../../api/dccEngineRunClient";

/** zh-CN labels for each typed engine-run error code in the contract enum. */
export const ENGINE_RUN_ERROR_CODE_LABELS: Record<DirectorDccEngineRunErrorCode, string> = {
  engine_run_not_ready: "引擎运行未就绪",
  engine_run_unsupported: "该引擎不支持项目运行",
  engine_run_active: "已有运行在进行",
  engine_run_unknown: "没有已启动的运行",
  engine_run_invalid: "运行请求无效",
  engine_run_failed: "引擎进程启动失败",
};

/**
 * Route/client-level codes this surface can also receive, kept outside the
 * typed record so it stays exactly the contract enum.
 */
const ENGINE_RUN_TRANSPORT_CODE_LABELS: Record<string, string> = {
  engine_run_unavailable: "运行管理器未配置",
  invalid_response: "网关响应不符合契约",
};

/**
 * Returns the zh-CN label for an engine-run error code, or null for codes
 * outside the known vocabulary (the raw machine code still renders).
 *
 * @param code - Machine-readable code from the gateway or client.
 */
export function engineRunErrorCodeLabel(code: string): string | null {
  if (code in ENGINE_RUN_ERROR_CODE_LABELS) {
    return ENGINE_RUN_ERROR_CODE_LABELS[code as DirectorDccEngineRunErrorCode];
  }
  return ENGINE_RUN_TRANSPORT_CODE_LABELS[code] ?? null;
}

/** Display view of one failed engine-run call: code, label, text, recovery. */
export type EngineRunErrorView = {
  /** Machine-readable code, or null when the failure carried none. */
  code: string | null;
  /** zh-CN label for the code, or null when outside the known vocabulary. */
  codeLabel: string | null;
  /** Free-text message from the gateway or a local fallback. */
  message: string;
  /** Ordered, user-actionable recovery steps from the gateway. */
  recovery: string[];
};

/**
 * Projects a thrown engine-run failure into its display view. Typed codes
 * are never dropped in favor of the free-text message.
 *
 * @param error - The thrown value from an engine-run client call.
 * @param fallback - zh-CN fallback message when the value carries no text.
 */
export function engineRunErrorView(error: unknown, fallback: string): EngineRunErrorView {
  if (error instanceof DirectorDccEngineRunClientError) {
    const code = error.code ?? null;
    return {
      code,
      codeLabel: code ? engineRunErrorCodeLabel(code) : null,
      message: error.message,
      recovery: error.recovery,
    };
  }
  return {
    code: null,
    codeLabel: null,
    message: error instanceof Error ? error.message : fallback,
    recovery: [],
  };
}
