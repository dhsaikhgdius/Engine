/**
 * Godot 交接专属区块：AnimationPlayer / 相机切换回执、WorldEnvironment 环境光与
 * 结构化省略灯光、姿态/动作省略详情，以及仅出站的实时预览快照（Godot 从不监听端口）。
 *
 * @module godot-handoff-sections
 */

import { Link2, Link2Off, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectorDccEngineSendResult } from "../../../../dcc/directorDccEngineContract";
import type { DirectorGodotLiveLinkPreview } from "../../../../dcc/directorGodotLiveLinkContract";
import { useLanguage } from "../../../i18n/language";
import { fetchDirectorGodotLiveLinkPreview } from "../../api/dccEngineHandoffClient";

/**
 * 结构化警告省略代码 → zh-CN 标签。来源：连接器灯光/镜头警告与网关姿态烘焙
 * 警告，均以 `warn-and-omit code: <code>` 结尾（绝不静默拍平）。
 */
const GODOT_OMIT_CODE_LABELS: Record<string, string> = {
  light_rect_area_unsupported: "面光源不支持",
  light_ambient_duplicate: "重复环境光",
  light_ambient_invisible: "环境光已隐藏",
  light_type_unknown: "未知灯光类型",
  light_hemisphere_approximated: "半球光已近似",
  shot_no_camera_binding: "镜头缺少相机绑定",
  shot_outside_playback: "镜头超出播放范围",
  shot_camera_not_imported: "镜头相机未导入",
  shot_target_not_camera: "镜头目标不是相机",
  shot_overlaps_previous: "镜头与前一镜头重叠",
  pose_values: "姿态控制",
  motion_blocks: "动作片段",
  character_rig: "角色绑定",
};

const OMITTED_CHANNEL_LABELS: Record<string, string> = {
  pose_values: "姿态控制",
  motion_blocks: "动作片段",
  character_rig: "角色绑定",
};

const OMIT_CODE_PATTERN = /warn-and-omit code: ([a-z0-9_]+)/;

/** One structured omission extracted from connector-side free-text warnings. */
interface GodotStructuredOmission {
  code: string;
  detail: string;
  /** Dedup key: code alone collapses multi-entity connector warnings incorrectly. */
  key: string;
}

/**
 * 从发送结果提取连接器侧结构化省略：优先使用回执里的 typed `omittedLights`，
 * 旧版连接器仍回退到警告文本中的 `warn-and-omit code: <code>`。
 * 网关烘焙通道以 `result.omittedAnimationChannels` 为准，不依赖自由文本摘要。
 */
export function collectGodotStructuredOmissions(
  warnings: string[],
  omittedLights: Array<{ directorId: string; code: string; lightType: string; reason: string }> = [],
): GodotStructuredOmission[] {
  if (omittedLights.length) {
    return omittedLights.map((light) => ({
      code: light.code,
      detail: light.reason,
      key: `${light.code}:${light.directorId}`,
    }));
  }
  const omissions: GodotStructuredOmission[] = [];
  for (const warning of warnings) {
    const match = OMIT_CODE_PATTERN.exec(warning);
    if (!match?.[1]) continue;
    // Prefer the first token that looks like an entity id so duplicate codes
    // across lights/shots stay distinct; fall back to the full warning text.
    const entityHint = warning.match(/\b(?:Light|Camera|Shot|Object)\s+([^\s:]+)/i)?.[1] ?? warning;
    omissions.push({ code: match[1], detail: warning, key: `${match[1]}:${entityHint}` });
  }
  return omissions;
}

/** zh-CN source strings describing the Godot send payload. */
export const GODOT_SEND_NOTES = [
  "以 GLB 发送场景、相机与稳定 ID；网关烘焙的变换/FOV/镜头切换由连接器写入 AnimationPlayer",
  "绑定姿态与动作片段警告省略（附结构化 omittedDetail）；持久回传仍走经审阅的回传包",
];

/**
 * Godot 发送回执:AnimationPlayer / 相机切换轨道计数、WorldEnvironment 环境光、
 * 省略灯光,以及从警告中提取的结构化省略代码列表。
 */
export function renderGodotReceipt(result: DirectorDccEngineSendResult, t: (source: string) => string) {
  const godot = result.report.godot;
  if (!godot) {
    return <p className="director-engine-handoff-empty">{t("本次运行未附带 Godot 回执详情（旧版连接器）")}</p>;
  }
  const omittedChannels = result.omittedAnimationChannels ?? result.report.omittedAnimationChannels ?? [];
  const connectorOmissions = collectGodotStructuredOmissions(
    [...result.warnings, ...result.report.warnings],
    godot.omittedLights ?? [],
  );
  const seenKeys = new Set<string>();
  const uniqueConnectorOmissions = connectorOmissions.filter((omission) => {
    if (seenKeys.has(omission.key)) return false;
    seenKeys.add(omission.key);
    return true;
  });
  return (
    <div className="director-engine-handoff-receipt-extra">
      <dl aria-label={t("Godot 回执")} className="director-engine-handoff-facts">
        <div>
          <dt>AnimationPlayer</dt>
          <dd data-i18n-user-content title={godot.animationPlayerPath ?? undefined}>
            {godot.animationPlayerPath ?? t("未生成")}
          </dd>
        </div>
        <div>
          <dt>{t("显示速率")}</dt>
          <dd>{godot.displayRate ?? t("未生成")}</dd>
        </div>
        <div>
          <dt>{t("相机切换轨道")}</dt>
          <dd>{godot.shotCutTrackCount}</dd>
        </div>
        <div>
          <dt>{t("映射镜头")}</dt>
          <dd>{godot.mappedShotCount}</dd>
        </div>
        <div>
          <dt>{t("变换轨道")}</dt>
          <dd>{godot.transformTrackCount}</dd>
        </div>
        <div>
          <dt>{t("FOV 轨道")}</dt>
          <dd>{godot.fovTrackCount}</dd>
        </div>
        <div>
          <dt>{t("烘焙关键帧")}</dt>
          <dd>{godot.bakedKeyCount}</dd>
        </div>
        <div>
          <dt>{t("骨骼")}</dt>
          <dd>{godot.importedSkeletonCount}</dd>
        </div>
        <div>
          <dt>{t("灯光")}</dt>
          <dd>{godot.importedLightCount}</dd>
        </div>
        <div>
          <dt>{t("省略灯光")}</dt>
          <dd>{godot.omittedLightCount}</dd>
        </div>
        <div>
          <dt>{t("环境光")}</dt>
          <dd>{godot.worldEnvironmentAmbient ? t("WorldEnvironment 已烘焙") : t("未烘焙")}</dd>
        </div>
        <div>
          <dt>{t("材质")}</dt>
          <dd>{godot.appliedMaterialCount}</dd>
        </div>
      </dl>
      {omittedChannels.length ? (
        <ul aria-label={t("省略的动画通道")} className="director-engine-handoff-list is-warning">
          {omittedChannels.slice(0, 6).map((entry) => (
            <li key={`${entry.directorId}:${entry.channels.join(",")}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${entry.channels.map((channel) => t(OMITTED_CHANNEL_LABELS[channel] ?? channel)).join("、")} · ${t("仅烘焙世界变换")}`}
            </li>
          ))}
          {omittedChannels.length > 6 ? (
            <li className="director-engine-handoff-more">+{omittedChannels.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {uniqueConnectorOmissions.length ? (
        <ul aria-label={t("结构化省略")} className="director-engine-handoff-list is-warning">
          {uniqueConnectorOmissions.slice(0, 6).map((omission) => (
            <li key={omission.key}>
              <code>{omission.code}</code>
              {` · ${t(GODOT_OMIT_CODE_LABELS[omission.code] ?? omission.code)}`}
              <span className="director-engine-handoff-omit-detail" data-i18n-user-content title={omission.detail}>
                {omission.detail}
              </span>
            </li>
          ))}
          {uniqueConnectorOmissions.length > 6 ? (
            <li className="director-engine-handoff-more">+{uniqueConnectorOmissions.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Godot 实时预览快照:仅出站推送(编辑器插件向网关推送带序号的临时帧,
 * Godot 从不监听端口)。空闲会话由网关清扫,因此快照中的会话都是活跃的。
 */
export function GodotLiveLinkSection() {
  const { t } = useLanguage();
  const requestRef = useRef<AbortController | null>(null);
  const [preview, setPreview] = useState<DirectorGodotLiveLinkPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await fetchDirectorGodotLiveLinkPreview({ signal: controller.signal });
      if (!controller.signal.aborted) setPreview(next);
    } catch (nextError) {
      if (!controller.signal.aborted) {
        setPreview(null);
        setError(nextError instanceof Error ? nextError.message : t("实时预览快照读取失败"));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  const sessions = preview?.sessions ?? [];

  return (
    <div className="director-engine-handoff-live" data-live-engine="godot">
      <div className="director-engine-handoff-live-toolbar">
        <button
          aria-label={t("刷新实时预览快照")}
          className="ui-icon-button"
          disabled={loading}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw aria-hidden className={loading ? "is-spinning" : undefined} size={13} />
        </button>
      </div>
      {error ? (
        <p className="director-engine-handoff-error" role="alert">
          {error}
        </p>
      ) : null}
      {preview && sessions.length === 0 ? (
        <div className="director-engine-handoff-live-status" data-status="disconnected">
          <Link2Off aria-hidden size={12} />
          <span>{t("未连接；在 Godot 编辑器菜单 Director → Start Live Preview 中开始推送")}</span>
        </div>
      ) : null}
      {sessions.length ? (
        <ul aria-label={t("实时预览会话列表")} className="director-engine-handoff-sessions">
          {sessions.map((session) => {
            const status = session.frameCount > 0 ? "connected" : "idle";
            return (
              <li data-status={status} key={session.sessionId}>
                <span className="director-engine-handoff-live-status" data-status={status}>
                  {status === "connected" ? <Link2 aria-hidden size={12} /> : <Link2Off aria-hidden size={12} />}
                  {status === "connected" ? t("已连接") : t("等待首帧")}
                </span>
                <span data-i18n-user-content title={session.scenePath ?? undefined}>
                  {session.scenePath ?? `Godot ${session.hostVersion}`}
                </span>
                <small>
                  {t("序号")} {session.lastSequence} · {session.frameCount} {t("帧")} · {session.entities.length}{" "}
                  {t("个实体")}
                </small>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ul className="director-engine-handoff-notes">
        <li>{t("仅出站：Godot 编辑器插件向网关推送带序号的临时帧，Godot 从不监听端口")}</li>
        <li>{t("预览帧绝不写入工程；断开只会回到最后提交的 Director 版本")}</li>
      </ul>
    </div>
  );
}
