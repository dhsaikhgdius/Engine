/**
 * Unreal 引擎交接回执详情(仅 Unreal)。
 *
 * 展示一次无头发送完成后的结构化回执:Sequencer 回执、清帧渲染回执、
 * 宿主侧计数(骨骼网格体 / 材质实例 / 纹理参数 / 引擎灯光),以及
 * 结构化的省略记录(省略的灯光、省略的动画通道及其控件名)。
 * 组件完全自包含:只读展示发送结果,不发起请求,也不改写工程。
 *
 * @module unreal-engine-details
 */

import { Camera, Clapperboard, Lightbulb, ListX } from "lucide-react";
import type {
  DirectorDccEngineSendResult,
  DirectorUnrealOmittedAnimationChannels,
  DirectorUnrealOmittedLight,
} from "../../../../dcc/directorDccEngineContract";
import { useLanguage } from "../../../i18n/language";
import "./UnrealEngineDetails.css";

/** Props for the UnrealEngineDetails component. */
export interface UnrealEngineDetailsProps {
  /** A completed Unreal headless send result (ignored for other providers). */
  result: DirectorDccEngineSendResult;
}

function CountRow({ label, value }: { label: string; value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <li>
      <span>{label}</span>
      <strong data-i18n-user-content>{value}</strong>
    </li>
  );
}

function OmittedLights({ lights }: { lights: DirectorUnrealOmittedLight[] }) {
  const { t } = useLanguage();
  return (
    <div className="director-unreal-details-block" data-testid="unreal-omitted-lights">
      <h5>
        <Lightbulb aria-hidden size={11} />
        {t("省略的灯光")}
      </h5>
      <ul aria-label={t("省略的灯光")}>
        {lights.map((light) => (
          <li data-i18n-user-content key={light.directorId}>
            <strong>{light.directorId}</strong>
            <span>({light.lightType})</span>
            <p>{light.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OmittedChannels({ records }: { records: DirectorUnrealOmittedAnimationChannels[] }) {
  const { t } = useLanguage();
  return (
    <div className="director-unreal-details-block" data-testid="unreal-omitted-channels">
      <h5>
        <ListX aria-hidden size={11} />
        {t("省略的动画通道")}
      </h5>
      <p className="director-unreal-details-note">{t("Control Rig 无损往返仍在规划中；世界变换已完整烘焙。")}</p>
      <ul aria-label={t("省略的动画通道")}>
        {records.map((record) => (
          <li data-i18n-user-content key={`${record.entityType}-${record.directorId}`}>
            <strong>{record.directorId}</strong>
            <span>({record.channels.join(", ")})</span>
            {(record.details ?? [])
              .filter((detail) => detail.controls.length > 0)
              .map((detail) => (
                <p key={detail.channel}>
                  {detail.channel}: {detail.controls.join(", ")}
                </p>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Unreal 交接回执详情:Sequencer、清帧、计数与省略记录的只读展示。
 *
 * @param result - 已完成的 Unreal 无头发送结果。
 */
export function UnrealEngineDetails({ result }: UnrealEngineDetailsProps) {
  const { t } = useLanguage();
  if (result.provider !== "unreal") return null;
  const { report } = result;
  const cleanFrame = result.cleanFrame;
  const omittedLights = report.omittedLights ?? [];
  const omittedChannels = result.omittedAnimationChannels ?? report.omittedAnimationChannels ?? [];

  return (
    <section aria-label={t("Unreal 交接回执")} className="director-unreal-details" data-testid="unreal-engine-details">
      <div className="director-unreal-details-block" data-testid="unreal-sequencer-receipt">
        <h5>
          <Clapperboard aria-hidden size={11} />
          {t("Sequencer 回执")}
        </h5>
        {report.sequencer ? (
          <>
            <p className="director-unreal-details-path" data-i18n-user-content>
              {report.sequencer.sequencePath}
            </p>
            <ul aria-label={t("Sequencer 轨道计数")}>
              <CountRow label={t("镜头切换")} value={report.sequencer.cameraCutCount} />
              <CountRow label={t("变换轨道")} value={report.sequencer.transformTrackCount} />
              <CountRow label={t("焦距轨道")} value={report.sequencer.focalLengthTrackCount} />
              <CountRow label={t("烘焙关键帧")} value={report.sequencer.bakedKeyCount} />
            </ul>
            <p className="director-unreal-details-note" data-i18n-user-content>
              {report.sequencer.displayRate} · {report.sequencer.startTimecode}
            </p>
          </>
        ) : (
          <p className="director-unreal-details-note">{t("未提供 Sequencer 回执（静态导入）。")}</p>
        )}
      </div>

      <div className="director-unreal-details-block" data-testid="unreal-host-counts">
        <h5>{t("宿主导入计数")}</h5>
        <ul aria-label={t("宿主导入计数")}>
          <CountRow label={t("骨骼网格体")} value={report.importedSkeletalMeshCount} />
          <CountRow label={t("材质实例")} value={report.appliedMaterialCount} />
          <CountRow label={t("纹理参数绑定")} value={report.appliedTextureCount} />
          <CountRow label={t("引擎灯光")} value={report.importedLightCount} />
        </ul>
      </div>

      {cleanFrame ? (
        <div className="director-unreal-details-block" data-testid="unreal-clean-frame">
          <h5>
            <Camera aria-hidden size={11} />
            {t("清帧渲染")}
          </h5>
          {cleanFrame.status === "rendered" ? (
            <p data-i18n-user-content>
              <span className="is-ready">{t("已渲染")}</span> {cleanFrame.width}×{cleanFrame.height} ·{" "}
              {cleanFrame.imagePath}
            </p>
          ) : (
            <p data-i18n-user-content>
              <span className="is-skipped">{t("已跳过")}</span> {cleanFrame.skipReason}
            </p>
          )}
        </div>
      ) : null}

      {omittedLights.length > 0 ? <OmittedLights lights={omittedLights} /> : null}
      {omittedChannels.length > 0 ? <OmittedChannels records={omittedChannels} /> : null}
    </section>
  );
}
