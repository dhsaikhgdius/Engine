/**
 * Shared DCC return-plan omittedOptics / omittedAdditions UI: zh-CN code labels,
 * free-text warning dedupe against typed reason echoes, and structured lists for
 * Interchange + engine handoff return previews.
 *
 * @module dcc-return-omitted-ui
 */

import type {
  DirectorDccOmittedAddition,
  DirectorDccOmittedOptics,
  DirectorDccImportPlanV1,
} from "../../../dcc/directorDccReturnContract";

/** zh-CN labels for typed return-plan omittedOptics codes. */
export const DCC_OMITTED_OPTICS_LABELS: Record<DirectorDccOmittedOptics["code"], string> = {
  sensor_format: "传感器画幅省略",
};

/** zh-CN labels for typed return-plan omittedAdditions codes. */
export const DCC_OMITTED_ADDITION_LABELS: Record<DirectorDccOmittedAddition["code"], string> = {
  opt_in_required: "需选择纳入",
  duplicate_director_id: "稳定 ID 重复",
  skip_requested: "已按请求跳过",
};

/**
 * Drop free-text warnings that are only human echoes of typed omittedOptics /
 * omittedAdditions reasons (same string the gateway stamped on both channels).
 */
export function filterDccReturnWarningsWithoutTypedEchoes(
  warnings: string[],
  plan: Pick<DirectorDccImportPlanV1, "omittedOptics" | "omittedAdditions">,
): string[] {
  const echoReasons = new Set<string>();
  for (const entry of plan.omittedOptics ?? []) {
    const reason = entry.reason.trim();
    if (reason) echoReasons.add(reason);
  }
  for (const entry of plan.omittedAdditions ?? []) {
    const reason = entry.reason.trim();
    if (reason) echoReasons.add(reason);
  }
  if (!echoReasons.size) return warnings;
  return warnings.filter((warning) => !echoReasons.has(warning.trim()));
}

type Translate = (source: string) => string;

/**
 * Structured omittedOptics / omittedAdditions lists for a DCC return import plan.
 * Uses the same truncated-list visual pattern as engine handoff omitted* sections.
 */
export function DccReturnOmittedLists({
  plan,
  t,
  listClassName,
  moreClassName,
  detailClassName,
}: {
  plan: Pick<DirectorDccImportPlanV1, "omittedOptics" | "omittedAdditions">;
  t: Translate;
  listClassName: string;
  moreClassName: string;
  detailClassName?: string;
}) {
  const omittedOptics = plan.omittedOptics ?? [];
  const omittedAdditions = plan.omittedAdditions ?? [];
  if (!omittedOptics.length && !omittedAdditions.length) return null;
  return (
    <>
      {omittedOptics.length ? (
        <ul aria-label={t("结构化省略光学")} className={listClassName}>
          {omittedOptics.slice(0, 6).map((entry) => (
            <li key={`optics:${entry.code}:${entry.directorId}:${entry.reason}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(DCC_OMITTED_OPTICS_LABELS[entry.code] ?? entry.code)} · `}
              <span className={detailClassName} data-i18n-user-content title={entry.reason}>
                {entry.reason}
              </span>
            </li>
          ))}
          {omittedOptics.length > 6 ? <li className={moreClassName}>+{omittedOptics.length - 6}</li> : null}
        </ul>
      ) : null}
      {omittedAdditions.length ? (
        <ul aria-label={t("结构化省略新增对象")} className={listClassName}>
          {omittedAdditions.slice(0, 6).map((entry) => (
            <li key={`addition:${entry.code}:${entry.directorId}:${entry.meshFile}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(DCC_OMITTED_ADDITION_LABELS[entry.code] ?? entry.code)} · `}
              <span className={detailClassName} data-i18n-user-content title={entry.reason}>
                {entry.name}
              </span>
            </li>
          ))}
          {omittedAdditions.length > 6 ? <li className={moreClassName}>+{omittedAdditions.length - 6}</li> : null}
        </ul>
      ) : null}
    </>
  );
}
