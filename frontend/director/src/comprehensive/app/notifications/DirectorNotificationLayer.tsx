import "./directorNotifications.css";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useDirectorSessionRuntime } from "../../editor/session/directorSessionRuntime";
import { persistentCreativeMediaLibrary } from "../../editor/media/persistentCreativeMediaStore";
import { GATEWAY_UNREACHABLE_MESSAGE, isNetworkFailureMessage } from "../../editor/api/friendlyError";
import {
  dismissDirectorNotification,
  notifyDirector,
  useDirectorNotifications,
  type DirectorNotificationSeverity,
} from "./directorNotificationStore";

const GATEWAY_OFFLINE_NOTICE_DELAY_MS = 5_000;
const GATEWAY_OFFLINE_NOTICE_DISMISS_MS = 8_000;
const SESSION_SAVE_CONFLICT_KEY = "session-save-conflict";
const SESSION_SYNC_NOTICE_DISMISS_MS = 6_000;
const GATEWAY_OFFLINE_KEY = "gateway-offline";
const CREATIVE_MEDIA_MEMORY_KEY = "creative-media-memory-storage";
const CREATIVE_MEDIA_ERROR_KEY = "creative-media-library-error";

export function isDirectorRemoteRevisionSyncNotice(reason: string) {
  return /^远端修订 .+，正在核对$/.test(reason);
}

const SEVERITY_ICONS: Record<DirectorNotificationSeverity, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

/** Gateway reasons often end with their own "."; drop it so the appended "。" doesn't double up. */
function withoutTrailingPeriod(reason: string): string {
  return reason.replace(/[.。;；]\s*$/, "");
}

/**
 * Autosave conflicts and gateway health already live in directorSessionRuntime;
 * this hook only projects them into user-visible, self-clearing banners so
 * gatewayClient itself stays untouched.
 */
function useDirectorSessionRuntimeNotifications() {
  const conflict = useDirectorSessionRuntime((state) => state.conflict);
  const gateway = useDirectorSessionRuntime((state) => state.gateway);
  const offlineSinceRef = useRef<number | null>(null);
  const offlineNoticeShownRef = useRef(false);

  useEffect(() => {
    if (!conflict) {
      dismissDirectorNotification(SESSION_SAVE_CONFLICT_KEY);
      return;
    }
    // Raw transport errors ("Failed to fetch") explain nothing; conflict and
    // binding messages from the gateway stay as-is because they are actionable.
    const reason = isNetworkFailureMessage(conflict) ? GATEWAY_UNREACHABLE_MESSAGE : conflict;
    notifyDirector({
      key: SESSION_SAVE_CONFLICT_KEY,
      severity: "warning",
      title: "场景尚未保存",
      detail: reason,
      autoDismissMs: isDirectorRemoteRevisionSyncNotice(reason) ? SESSION_SYNC_NOTICE_DISMISS_MS : null,
    });
  }, [conflict]);

  useEffect(() => {
    if (gateway === "connected") {
      offlineSinceRef.current = null;
      offlineNoticeShownRef.current = false;
      dismissDirectorNotification(GATEWAY_OFFLINE_KEY);
      return;
    }
    // The gateway flips between "connecting" and "disconnected" while it
    // retries, so measure from the first moment it left "connected" instead of
    // restarting the countdown on every flip. Once the toast has been shown
    // for this outage, do not revive it — retries would otherwise reset the
    // auto-dismiss timer forever.
    const now = Date.now();
    if (offlineSinceRef.current === null) offlineSinceRef.current = now;
    if (offlineNoticeShownRef.current) return;
    const remaining = Math.max(0, offlineSinceRef.current + GATEWAY_OFFLINE_NOTICE_DELAY_MS - now);
    const timer = window.setTimeout(() => {
      offlineNoticeShownRef.current = true;
      notifyDirector({
        key: GATEWAY_OFFLINE_KEY,
        severity: "warning",
        title: "网关未连接，Agent 与生成功能不可用",
        detail: "请在项目根目录运行 npm run dev（或单独运行 npm run gateway）启动 Agent Gateway。",
        autoDismissMs: GATEWAY_OFFLINE_NOTICE_DISMISS_MS,
      });
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [gateway]);
}

function useCreativeMediaStorageNotifications() {
  const storageMode = useStore(persistentCreativeMediaLibrary.store, (state) => state.storageMode);
  const warning = useStore(persistentCreativeMediaLibrary.store, (state) => state.warning);
  const status = useStore(persistentCreativeMediaLibrary.store, (state) => state.status);
  const error = useStore(persistentCreativeMediaLibrary.store, (state) => state.error);

  useEffect(() => {
    if (storageMode !== "memory") {
      dismissDirectorNotification(CREATIVE_MEDIA_MEMORY_KEY);
      return;
    }
    notifyDirector({
      key: CREATIVE_MEDIA_MEMORY_KEY,
      severity: "warning",
      title: "媒体仅保存在本次会话，刷新后将丢失",
      detail: warning ?? "浏览器持久化存储（IndexedDB）不可用，请及时导出需要保留的媒体素材。",
    });
  }, [storageMode, warning]);

  useEffect(() => {
    if (status !== "error") {
      dismissDirectorNotification(CREATIVE_MEDIA_ERROR_KEY);
      return;
    }
    notifyDirector({
      key: CREATIVE_MEDIA_ERROR_KEY,
      severity: "error",
      title: "媒体库加载失败",
      detail: error
        ? `${withoutTrailingPeriod(error)}。已导入的媒体可能暂时无法显示。`
        : "已导入的媒体可能暂时无法显示。",
    });
  }, [status, error]);
}

export function DirectorNotificationLayer() {
  useDirectorSessionRuntimeNotifications();
  useCreativeMediaStorageNotifications();
  const notifications = useDirectorNotifications();

  if (notifications.length === 0 || typeof document === "undefined") return null;

  // Portal into #root so the i18n MutationObserver (which watches #root, not
  // document.body) keeps translating notifications that appear later.
  const portalTarget = document.getElementById("root") ?? document.body;

  return createPortal(
    <div className="director-notification-layer">
      {notifications.map((notification) => {
        const Icon = SEVERITY_ICONS[notification.severity];
        return (
          <div
            className={`director-notification is-${notification.severity}`}
            key={notification.key}
            role={notification.severity === "error" ? "alert" : "status"}
          >
            <span aria-hidden="true" className="director-notification-icon">
              <Icon size={13} />
            </span>
            <div className="director-notification-body">
              <p className="director-notification-title">{notification.title}</p>
              {notification.detail ? <p className="director-notification-detail">{notification.detail}</p> : null}
              {notification.actions.length > 0 ? (
                <div className="director-notification-actions">
                  {notification.actions.map((action) => (
                    <button key={action.label} onClick={action.onSelect} type="button">
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              aria-label="关闭通知"
              className="director-notification-close"
              onClick={() => dismissDirectorNotification(notification.key)}
              type="button"
            >
              <X aria-hidden size={12} />
            </button>
          </div>
        );
      })}
    </div>,
    portalTarget,
  );
}
