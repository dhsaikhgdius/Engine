/**
 * Canvas Fountain script-import omitted honesty: zh-CN labels for the typed
 * `omitted[]` codes stamped by `canvas.script.apply_plan` (`board_capacity`
 * plus Fountain importer codes). Keeps toast/list presentation in sync with
 * the Agent receipt without inventing new omit codes.
 *
 * @module canvas-script-omitted-ui
 */

import {
  DIRECTOR_FOUNTAIN_OMITTED_CODES,
  type DirectorFountainOmittedCode,
} from "../interchange/fountain";

/** Codes the apply_plan executor may stamp on `result.omitted`. */
export const CANVAS_SCRIPT_OMITTED_CODES = ["board_capacity", ...DIRECTOR_FOUNTAIN_OMITTED_CODES] as const;

/** One Canvas script-import omit code. */
export type CanvasScriptOmittedCode = (typeof CANVAS_SCRIPT_OMITTED_CODES)[number];

/** One omitted entry from an apply_plan receipt (or plan). */
export type CanvasScriptOmittedEntry = {
  code: string;
  subject: string;
  reason: string;
};

/** zh-CN labels for typed Canvas script-import omit codes. */
export const CANVAS_SCRIPT_OMIT_LABELS: Record<CanvasScriptOmittedCode, string> = {
  board_capacity: "画板容量已满",
  character_dialogue: "对白未导入分镜",
  boneyard_note: "旁注已跳过",
  section_heading: "分节标题已跳过",
  title_page_field: "标题页字段未导入",
  invalid_marker: "无效镜头标记",
  transition: "转场已跳过",
};

const KNOWN_CODES = new Set<string>(CANVAS_SCRIPT_OMITTED_CODES);

type Translate = (source: string) => string;

/** Resolve a zh-CN label for a receipt omit code (falls back to the raw code). */
export function canvasScriptOmitLabel(code: string): string {
  if (KNOWN_CODES.has(code)) {
    return CANVAS_SCRIPT_OMIT_LABELS[code as CanvasScriptOmittedCode];
  }
  return code;
}

/** One detail line: `code · label · subject` (subject truncated for UI). */
export function formatCanvasScriptOmittedDetailLine(entry: CanvasScriptOmittedEntry, t: Translate): string {
  const label = t(canvasScriptOmitLabel(entry.code));
  const subject = entry.subject.trim();
  const subjectPreview = subject.length > 48 ? `${subject.slice(0, 48)}…` : subject;
  return subjectPreview ? `${entry.code} · ${label} · ${subjectPreview}` : `${entry.code} · ${label}`;
}

/**
 * Compact toast summary of omit codes: groups identical codes with counts so a
 * long Fountain dialogue omit list does not flood the status pill.
 */
export function summarizeCanvasScriptOmitted(omitted: CanvasScriptOmittedEntry[], t: Translate): string {
  if (!omitted.length) return "";
  const counts = new Map<string, number>();
  for (const entry of omitted) {
    counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [code, count] of counts) {
    const label = t(canvasScriptOmitLabel(code));
    parts.push(count > 1 ? `${code} · ${label} ×${count}` : `${code} · ${label}`);
  }
  return parts.join("；");
}

/** Receipt slice used to build the Canvas import status message. */
export type CanvasScriptApplyPlanResult = {
  nodes_added: number;
  omitted: CanvasScriptOmittedEntry[];
  warnings: string[];
};

/**
 * Honest import status for the Canvas toast: always reports `nodes_added`, and
 * when anything was omitted surfaces typed codes (never only a bare count, and
 * never success severity while omissions remain).
 */
export function formatCanvasScriptImportMessage(
  result: CanvasScriptApplyPlanResult,
  t: Translate,
): {
  text: string;
  severity: "info" | "success";
  details: string[];
} {
  const segments = [`${t("已导入剧本")} · ${result.nodes_added} ${t("个分镜")}`];
  const omitSummary = summarizeCanvasScriptOmitted(result.omitted, t);
  if (omitSummary) {
    segments.push(`${t("省略")}：${omitSummary}`);
  }
  if (result.warnings.length) {
    segments.push(result.warnings[0]!);
  }
  const details = result.omitted.slice(0, 6).map((entry) => formatCanvasScriptOmittedDetailLine(entry, t));
  if (result.omitted.length > 6) {
    details.push(`+${result.omitted.length - 6}`);
  }
  return {
    text: segments.join(" · "),
    severity: result.omitted.length || result.warnings.length ? "info" : "success",
    details,
  };
}

/** Type guard helper for tests / callers that only care about Fountain codes. */
export function isDirectorFountainOmittedCode(code: string): code is DirectorFountainOmittedCode {
  return (DIRECTOR_FOUNTAIN_OMITTED_CODES as readonly string[]).includes(code);
}
