/**
 * Minimal read-only collaboration health section for the task tray: team-mode
 * flags, room counts, and transport honesty from the redacted `/health`
 * collaboration stanza. Display only — no invite or room mutations.
 *
 * @module CollaborationHealthSection
 */

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../../i18n/language";
import { fetchCollaborationHealth, type CollaborationHealthStanza } from "./collaborationHealthClient";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function modeLabel(mode: string): string {
  if (mode === "invite-required") return "需邀请";
  if (mode === "local-trust") return "本地信任";
  return mode;
}

function memberIdentityLabel(identity: CollaborationHealthStanza["transport"]["member_identity"]): string {
  return identity === "invite-capability" ? "邀请 capability" : "本地信任";
}

function formatTtlSeconds(seconds: number): string {
  return seconds === 0 ? "立即销毁" : `${seconds} 秒`;
}

function formatRateLimit(perMinute: number): string {
  return perMinute === 0 ? "未限制" : `${perMinute} / 分钟`;
}

/**
 * Renders collaboration deployment flags from `GET /health` so operators can
 * confirm team-mode settings without grepping env. Values are shown exactly as
 * the stanza reports them (no implied multi-node or TLS).
 */
export function CollaborationHealthSection() {
  const { t } = useLanguage();
  const [health, setHealth] = useState<CollaborationHealthStanza | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setHealth(await fetchCollaborationHealth());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="task-tray-section task-tray-collab-health">
      <h3>{t("协作健康")}</h3>
      {error ? <p className="task-tray-notice is-error">{error}</p> : null}
      {health ? (
        <>
          <p className="task-tray-item-phase">
            {[t(modeLabel(health.mode)), health.persistence ? t("持久化已启用") : t("持久化未启用")].join(" · ")}
          </p>
          <div className="task-tray-storage-rows">
            <span>{t("鉴权模式")}</span>
            <span>{t(modeLabel(health.mode))}</span>
            <span>{t("持久化")}</span>
            <span>{health.persistence ? t("已启用") : t("未启用")}</span>
            <span>{t("空房间 TTL")}</span>
            <span>{t(formatTtlSeconds(health.empty_room_ttl_seconds))}</span>
            <span>{t("邀请速率限制")}</span>
            <span>{t(formatRateLimit(health.invite_rate_limit_per_minute))}</span>
            <span>{t("活跃房间")}</span>
            <span>{health.active_rooms}</span>
            <span>{t("保留房间")}</span>
            <span>{health.retained_rooms}</span>
            <span>{t("传输绑定")}</span>
            <span>{health.transport.loopback_binding ? t("仅 loopback") : t("非 loopback")}</span>
            <span>{t("TLS 终结")}</span>
            <span>{health.transport.tls_termination ? t("已终结 TLS") : t("不终结 TLS")}</span>
            <span>{t("多节点房间")}</span>
            <span>{health.transport.multi_node ? t("多节点集群") : t("单进程（无多节点）")}</span>
            <span>{t("成员身份")}</span>
            <span>{t(memberIdentityLabel(health.transport.member_identity))}</span>
          </div>
        </>
      ) : busy ? (
        <p className="task-tray-item-phase">{t("正在读取协作健康…")}</p>
      ) : null}
      <span className="task-tray-item-actions">
        <button disabled={busy} onClick={() => void refresh()} type="button">
          {t("刷新")}
        </button>
      </span>
    </section>
  );
}
