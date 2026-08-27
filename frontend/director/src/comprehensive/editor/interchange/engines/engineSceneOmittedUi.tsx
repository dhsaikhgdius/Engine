/**
 * Shared engine-scene import omitted UI: zh-CN code labels, free-text warning
 * dedupe against typed reason echoes, and a structured list for the handoff
 * import section (mirrors blend import / dccReturnOmittedUi).
 *
 * @module engine-scene-omitted-ui
 */

import type {
  DirectorEngineSceneImportPlanV1,
  DirectorEngineSceneOmitted,
  DirectorEngineSceneOmittedCode,
} from "../../../../dcc/directorEngineSceneImportContract";

/** zh-CN labels for typed engine-scene import omitted codes. */
export const ENGINE_SCENE_OMIT_LABELS: Record<DirectorEngineSceneOmittedCode, string> = {
  unsupported_object: "不支持对象未导入",
  hierarchy_flattened: "层级合并为单一场景对象",
  animation_clips: "动画剪辑未映射时间线",
  skinned_mesh_rigs: "蒙皮骨骼未绑定角色系统",
  camera_roll: "相机滚转未导入",
};

/**
 * Drop free-text warnings that are only human echoes of typed omitted reasons
 * (same string the gateway stamped on both channels).
 */
export function filterEngineSceneWarningsWithoutTypedEchoes(
  warnings: string[],
  plan: Pick<DirectorEngineSceneImportPlanV1, "omitted">,
): string[] {
  const omitted = plan.omitted ?? [];
  if (!omitted.length) return warnings;
  const echoReasons = new Set<string>();
  for (const entry of omitted) {
    const reason = entry.reason.trim();
    if (reason) echoReasons.add(reason);
  }
  if (!echoReasons.size) return warnings;
  return warnings.filter((warning) => !echoReasons.has(warning.trim()));
}

type Translate = (source: string) => string;

/**
 * Structured omitted list for an engine scene import plan.
 * Uses the same truncated-list visual pattern as other handoff omitted* sections.
 */
export function EngineSceneOmittedList({
  omitted,
  t,
  listClassName,
  moreClassName,
}: {
  omitted: DirectorEngineSceneOmitted[];
  t: Translate;
  listClassName: string;
  moreClassName: string;
}) {
  if (!omitted.length) return null;
  return (
    <ul aria-label={t("引擎场景导入省略")} className={listClassName}>
      {omitted.slice(0, 6).map((entry) => (
        <li key={`${entry.code}:${entry.sourceId}:${entry.reason}`}>
          <code data-i18n-user-content>{entry.code}</code>
          {` · ${t(ENGINE_SCENE_OMIT_LABELS[entry.code] ?? entry.code)} · `}
          <span data-i18n-user-content title={entry.reason}>
            {entry.sourceId}
          </span>
        </li>
      ))}
      {omitted.length > 6 ? <li className={moreClassName}>+{omitted.length - 6}</li> : null}
    </ul>
  );
}
