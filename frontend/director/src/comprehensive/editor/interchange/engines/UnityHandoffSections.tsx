/**
 * Unity 交接专属区块:Timeline / Avatar / 姿态烘焙回执、结构化 omittedChannels,
 * 以及仅出站的实时预览会话管理(令牌只在创建时显示一次)。
 *
 * @module unity-handoff-sections
 */

import { KeyRound, Link2, Link2Off, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectorDccEngineSendResult } from "../../../../dcc/directorDccEngineContract";
import type {
  DirectorUnityLiveLinkSessionGrant,
  DirectorUnityLiveLinkSessionStatus,
} from "../../../../dcc/directorUnityLiveLinkContract";
import { useLanguage } from "../../../i18n/language";
import {
  closeDirectorUnityLiveLinkSession,
  createDirectorUnityLiveLinkSession,
  listDirectorUnityLiveLinkSessions,
} from "../../api/dccEngineHandoffClient";

const UNITY_OMITTED_CHANNEL_LABELS: Record<string, string> = {
  poseValues: "姿态控制",
  motionBlocks: "动作片段",
  motion: "步态动作",
  ik: "IK 目标",
};

const UNITY_OMITTED_LIGHT_LABELS: Record<string, string> = {
  light_type_unknown: "未知灯光类型",
};

const UNITY_OMITTED_MATERIAL_LABELS: Record<string, string> = {
  pipeline_unsupported: "管线不支持材质回退",
  shader_missing: "缺少 Lit/Standard 着色器",
  no_mesh_target: "材质无网格目标",
  unsupported_channels: "不支持的材质通道",
};

const UNITY_OMITTED_SHOT_LABELS: Record<string, string> = {
  shot_no_camera_binding: "镜头缺少相机绑定",
  shot_camera_not_imported: "镜头相机未导入",
  shot_target_not_camera: "镜头目标不是相机",
};

const RENDER_PIPELINE_LABELS: Record<string, string> = {
  "built-in": "内置管线",
  urp: "URP",
  hdrp: "HDRP",
  custom: "自定义管线",
};

/**
 * zh-CN source strings describing the Unity send payload. GLB is the
 * production payload; USD import in Unity remains experimental and is
 * deliberately not offered here.
 */
export const UNITY_SEND_NOTES = [
  "以 GLB 发送（生产载荷）；Unity 侧 USD 仍为实验性，不作为发送格式提供",
  "连接器将 Director 动画与语义姿态烘焙到 Timeline，并从蒙皮 GLB 构建 Avatar",
];

/**
 * Unity 发送回执:Timeline 路径、渲染管线、Avatar / 动画剪辑 / 姿态计数,
 * 以及结构化 omittedChannels(非 Mixamo 骨架、动作片段等)。
 */
export function renderUnityReceipt(result: DirectorDccEngineSendResult, t: (source: string) => string) {
  const details = result.report.unity;
  if (!details) {
    return <p className="director-engine-handoff-empty">{t("本次运行未附带 Unity 回执详情（旧版连接器）")}</p>;
  }
  const omitted = details.omittedChannels ?? [];
  return (
    <div className="director-engine-handoff-receipt-extra">
      <dl aria-label={t("Unity 回执")} className="director-engine-handoff-facts">
        <div>
          <dt>Timeline</dt>
          <dd data-i18n-user-content title={details.timelinePath ?? undefined}>
            {details.timelinePath ?? t("未生成")}
          </dd>
        </div>
        <div>
          <dt>{t("渲染管线")}</dt>
          <dd>{t(RENDER_PIPELINE_LABELS[details.renderPipeline] ?? details.renderPipeline)}</dd>
        </div>
        <div>
          <dt>{t("动画剪辑")}</dt>
          <dd>{details.bakedAnimationClipCount}</dd>
        </div>
        <div>
          <dt>{t("人形 Avatar")}</dt>
          <dd>{details.humanoidAvatarCount}</dd>
        </div>
        <div>
          <dt>{t("通用 Avatar")}</dt>
          <dd>{details.genericAvatarCount}</dd>
        </div>
        <div>
          <dt>{t("姿态角色")}</dt>
          <dd>{details.posedCharacterCount ?? 0}</dd>
        </div>
        <div>
          <dt>{t("灯光")}</dt>
          <dd>{details.importedLightCount}</dd>
        </div>
        <div>
          <dt>{t("省略灯光")}</dt>
          <dd>{details.omittedLightCount ?? details.omittedLights?.length ?? 0}</dd>
        </div>
        <div>
          <dt>{t("材质回退")}</dt>
          <dd>{details.materialFallbackCount}</dd>
        </div>
        <div>
          <dt>{t("省略材质")}</dt>
          <dd>{details.omittedMaterialCount ?? details.omittedMaterials?.length ?? 0}</dd>
        </div>
        {details.mappedShotCount !== undefined ? (
          <div>
            <dt>{t("映射镜头")}</dt>
            <dd>{details.mappedShotCount}</dd>
          </div>
        ) : null}
        {details.omittedShotCount !== undefined || details.omittedShots !== undefined ? (
          <div>
            <dt>{t("省略镜头")}</dt>
            <dd>{details.omittedShotCount ?? details.omittedShots?.length ?? 0}</dd>
          </div>
        ) : null}
      </dl>
      {(details.omittedLights?.length ?? 0) > 0 ? (
        <ul aria-label={t("结构化省略灯光")} className="director-engine-handoff-list is-warning">
          {details.omittedLights!.slice(0, 6).map((entry) => (
            <li key={`${entry.code}:${entry.directorId}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(UNITY_OMITTED_LIGHT_LABELS[entry.code] ?? entry.code)} · `}
              <span data-i18n-user-content>{entry.reason}</span>
            </li>
          ))}
          {details.omittedLights!.length > 6 ? (
            <li className="director-engine-handoff-more">+{details.omittedLights!.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {(details.omittedMaterials?.length ?? 0) > 0 ? (
        <ul aria-label={t("结构化省略材质")} className="director-engine-handoff-list is-warning">
          {details.omittedMaterials!.slice(0, 6).map((entry) => (
            <li key={`${entry.code}:${entry.directorId}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(UNITY_OMITTED_MATERIAL_LABELS[entry.code] ?? entry.code)} · `}
              <span data-i18n-user-content>{entry.reason}</span>
            </li>
          ))}
          {details.omittedMaterials!.length > 6 ? (
            <li className="director-engine-handoff-more">+{details.omittedMaterials!.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {(details.omittedShots?.length ?? 0) > 0 ? (
        <ul aria-label={t("结构化省略镜头")} className="director-engine-handoff-list is-warning">
          {details.omittedShots!.slice(0, 6).map((entry) => (
            <li key={`${entry.code}:${entry.shotId}`}>
              <code data-i18n-user-content>{entry.shotId}</code>
              {` · ${t(UNITY_OMITTED_SHOT_LABELS[entry.code] ?? entry.code)} · `}
              <span data-i18n-user-content>{entry.reason}</span>
            </li>
          ))}
          {details.omittedShots!.length > 6 ? (
            <li className="director-engine-handoff-more">+{details.omittedShots!.length - 6}</li>
          ) : null}
        </ul>
      ) : null}
      {omitted.length ? (
        <ul aria-label={t("省略的动画通道")} className="director-engine-handoff-list is-warning">
          {omitted.slice(0, 6).map((entry) => (
            <li key={`${entry.directorId}:${entry.channel}`}>
              <code data-i18n-user-content>{entry.directorId}</code>
              {` · ${t(UNITY_OMITTED_CHANNEL_LABELS[entry.channel] ?? entry.channel)} · `}
              <span data-i18n-user-content>{entry.reason}</span>
            </li>
          ))}
          {omitted.length > 6 ? <li className="director-engine-handoff-more">+{omitted.length - 6}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function sessionStatus(session: DirectorUnityLiveLinkSessionStatus): "connected" | "idle" | "disconnected" {
  if (session.closed) return "disconnected";
  return session.connectorSeenAt ? "connected" : "idle";
}

/**
 * Unity 实时预览会话:仅出站长轮询(编辑器拉取网关,从不回写)。
 * 会话列表永不包含令牌;创建返回的令牌只显示这一次。
 */
export function UnityLiveLinkSection() {
  const { t } = useLanguage();
  const requestRef = useRef<AbortController | null>(null);
  const [sessions, setSessions] = useState<DirectorUnityLiveLinkSessionStatus[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<DirectorUnityLiveLinkSessionGrant | null>(null);

  const statusLabels: Record<ReturnType<typeof sessionStatus>, string> = {
    connected: t("已连接"),
    idle: t("等待编辑器轮询"),
    disconnected: t("已断开"),
  };

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await listDirectorUnityLiveLinkSessions({ signal: controller.signal });
      if (!controller.signal.aborted) setSessions(next);
    } catch (nextError) {
      if (!controller.signal.aborted) {
        setSessions(null);
        setError(nextError instanceof Error ? nextError.message : t("实时预览会话读取失败"));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  async function createSession() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createDirectorUnityLiveLinkSession();
      setGrant(created);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("实时预览会话创建失败"));
    } finally {
      setBusy(false);
    }
  }

  async function closeSession(sessionId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await closeDirectorUnityLiveLinkSession(sessionId);
      if (grant?.sessionId === sessionId) setGrant(null);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("实时预览会话关闭失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="director-engine-handoff-live" data-live-engine="unity">
      <div className="director-engine-handoff-live-toolbar">
        <button disabled={busy || loading} onClick={() => void createSession()} type="button">
          <Plus aria-hidden size={12} /> {t("新建预览会话")}
        </button>
        <button
          aria-label={t("刷新实时预览会话")}
          className="ui-icon-button"
          disabled={busy || loading}
          onClick={() => void load()}
          type="button"
        >
          <RefreshCw aria-hidden className={loading ? "is-spinning" : undefined} size={13} />
        </button>
      </div>
      {grant ? (
        <div aria-label={t("一次性会话令牌")} className="director-engine-handoff-token" role="note">
          <KeyRound aria-hidden size={12} />
          <div>
            <p>{t("将此令牌粘贴到 Unity 菜单 Director → Live Link Preview；它不会再次显示")}</p>
            <code data-i18n-user-content>{grant.token}</code>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="director-engine-handoff-error" role="alert">
          {error}
        </p>
      ) : null}
      {sessions && sessions.length === 0 ? (
        <p className="director-engine-handoff-empty">{t("暂无预览会话；新建后在 Unity 编辑器中粘贴令牌开始轮询")}</p>
      ) : null}
      {sessions?.length ? (
        <ul aria-label={t("实时预览会话列表")} className="director-engine-handoff-sessions">
          {sessions.map((session) => {
            const status = sessionStatus(session);
            return (
              <li data-status={status} key={session.sessionId}>
                <span className="director-engine-handoff-live-status" data-status={status}>
                  {status === "connected" ? <Link2 aria-hidden size={12} /> : <Link2Off aria-hidden size={12} />}
                  {statusLabels[status]}
                </span>
                <span data-i18n-user-content>{session.label ?? session.sessionId.slice(0, 8)}</span>
                <small>
                  {t("序号")} {session.latestSeq}
                </small>
                <button
                  aria-label={`${t("关闭会话")} ${session.label ?? session.sessionId.slice(0, 8)}`}
                  className="ui-icon-button"
                  disabled={busy || session.closed}
                  onClick={() => void closeSession(session.sessionId)}
                  type="button"
                >
                  <X aria-hidden size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ul className="director-engine-handoff-notes">
        <li>{t("仅出站：Unity 编辑器凭会话令牌长轮询网关，不存在任何回写或远程执行端点")}</li>
      </ul>
    </div>
  );
}
