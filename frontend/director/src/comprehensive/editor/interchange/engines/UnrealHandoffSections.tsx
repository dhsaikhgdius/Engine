/**
 * Unreal 交接专属区块:Sequencer 烘焙回执、洁净帧回执、结构化省略通道,以及
 * 回环实时预览的诚实状态说明(浏览器不可观测,绝不伪造"已连接")。
 *
 * @module unreal-handoff-sections
 */

import { Camera, MonitorOff } from "lucide-react";
import type { DirectorDccEngineSendResult } from "../../../../dcc/directorDccEngineContract";
import { useLanguage } from "../../../i18n/language";

const OMITTED_CHANNEL_LABELS: Record<string, string> = {
  pose_values: "姿态控制",
  motion_blocks: "动作片段",
  character_rig: "角色绑定",
};

const UNREAL_OMITTED_MATERIAL_LABELS: Record<string, string> = {
  unsupported_channels: "不支持的材质通道",
  no_mesh_target: "材质无网格目标",
  parent_unavailable: "父材质不可用",
  apply_failed: "材质应用失败",
};

/** zh-CN source strings describing the Unreal send payload. */
export const UNREAL_SEND_NOTES = [
  "以 USD 优先（附 GLB）发送场景、相机与稳定 ID",
  "网关烘焙的变换/相机动画由连接器写入 LevelSequence；Control Rig 姿态与动作片段警示省略",
];

/**
 * Unreal 发送回执:Sequencer 时基与轨道计数、洁净帧 rendered/skipped、
 * 结构化 omittedAnimationChannels(含 Control Rig 省略)。
 */
export function renderUnrealReceipt(result: DirectorDccEngineSendResult, t: (source: string) => string) {
  const sequencer = result.report.sequencer;
  const cleanFrame = result.cleanFrame;
  const omitted = result.omittedAnimationChannels ?? result.report.omittedAnimationChannels ?? [];
  const omittedMaterials = result.report.omittedMaterials ?? [];
  const omittedMaterialCount = result.report.omittedMaterialCount ?? omittedMaterials.length;
  const appliedMaterialCount = result.report.appliedMaterialCount;
  return (
    <div className="director-engine-handoff-receipt-extra">
      {sequencer ? (
        <dl aria-label={t("Sequencer 回执")} className="director-engine-handoff-facts">
          <div>
            <dt>{t("显示速率")}</dt>
            <dd>
              {sequencer.displayRate}
              {sequencer.dropFrame ? " DF" : ""}
            </dd>
          </div>
          <div>
            <dt>{t("起始时码")}</dt>
            <dd>{sequencer.startTimecode}</dd>
          </div>
          <div>
            <dt>{t("相机切换")}</dt>
            <dd>{sequencer.cameraCutCount}</dd>
          </div>
          <div>
            <dt>{t("变换轨道")}</dt>
            <dd>{sequencer.transformTrackCount}</dd>
          </div>
          <div>
            <dt>{t("焦距轨道")}</dt>
            <dd>{sequencer.focalLengthTrackCount}</dd>
          </div>
          <div>
            <dt>{t("烘焙关键帧")}</dt>
            <dd>{sequencer.bakedKeyCount}</dd>
          </div>
          {appliedMaterialCount !== undefined ? (
            <div>
              <dt>{t("材质")}</dt>
              <dd>{appliedMaterialCount}</dd>
            </div>
          ) : null}
          {omittedMaterialCount > 0 || omittedMaterials.length > 0 ? (
            <div>
              <dt>{t("省略材质")}</dt>
              <dd>{omittedMaterialCount}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="director-engine-handoff-empty">{t("本次运行未写入 Sequencer 回执（静态导入）")}</p>
      )}
      {cleanFrame ? (
        <div
          aria-label={t("洁净帧回执")}
          className="director-engine-handoff-clean-frame"
          data-status={cleanFrame.status}
        >
          <Camera aria-hidden size={12} />
          {cleanFrame.status === "rendered" ? (
            <span>
              {t("洁净帧已渲染")} · {cleanFrame.width}×{cleanFrame.height} · F{cleanFrame.frame}
            </span>
          ) : (
            <span>
              {t("洁净帧已跳过")}：{cleanFrame.skipReason}
            </span>
          )}
        </div>
      ) : null}
      {omittedMaterials.length ? (
        <ul aria-label={t("结构化省略材质")} className="director-engine-handoff-list is-warning">
          {omittedMaterials.slice(0, 6).map((entry) => (
            <li key={`material:${entry.code}:${entry.directorId}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(UNREAL_OMITTED_MATERIAL_LABELS[entry.code] ?? entry.code)} · `}
              <span data-i18n-user-content title={entry.reason}>
                {entry.reason}
              </span>
            </li>
          ))}
          {omittedMaterials.length > 6 ? (
            <li className="director-engine-handoff-more">+{omittedMaterials.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {omitted.length ? (
        <ul aria-label={t("省略的动画通道")} className="director-engine-handoff-list is-warning">
          {omitted.slice(0, 6).map((entry) => (
            <li key={`${entry.directorId}:${entry.channels.join(",")}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${entry.channels.map((channel) => t(OMITTED_CHANNEL_LABELS[channel] ?? channel)).join("、")} · ${t("仅烘焙世界变换")}`}
            </li>
          ))}
          {omitted.length > 6 ? <li className="director-engine-handoff-more">+{omitted.length - 6}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Unreal 实时预览状态:网关到连接器的 127.0.0.1 回环推送,浏览器无法观测其
 * 会话,因此绝不显示"已连接";只给出启动方式与安全边界说明。
 */
export function UnrealLiveLinkSection() {
  const { t } = useLanguage();
  return (
    <div className="director-engine-handoff-live" data-live-engine="unreal">
      <div className="director-engine-handoff-live-status" data-status="unobservable">
        <MonitorOff aria-hidden size={12} />
        <span>{t("浏览器不可观测（网关 → 编辑器回环推送）")}</span>
      </div>
      <ul className="director-engine-handoff-notes">
        <li>{t("链路仅绑定 127.0.0.1、单向、带序号；帧只作用于编辑器视口，绝不写入工程")}</li>
        <li>
          {t("启动方式：在引擎项目中设置 DIRECTOR_UNREAL_PREVIEW_TOKEN，运行 director_headless.py --mode live-preview")}
        </li>
        <li>{t("Remote Control 不是安全边界；此链路不经过也不依赖它")}</li>
      </ul>
    </div>
  );
}
