/**
 * Collaboration rooms ops section for the task tray: merged live + durable
 * room status from `GET /api/collab/rooms` (member counts, snapshot
 * size/age, pending and quarantined updates) plus invite revocation
 * durability counters, an optional per-room quarantine peek via
 * `GET /api/collab/rooms/quarantine`, and an explicit two-step close confirm
 * for `POST /api/collab/rooms/close`. Archiving durable history is a
 * separate opt-in on the confirm, and the receipt mirrors the typed archive
 * outcomes (`archived` / `no_durable_history` / `archive_failed`) — a
 * filesystem failure is never rendered as an archive success.
 *
 * @module CollaborationRoomsSection
 */

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../../i18n/language";
import {
  closeCollaborationRoom,
  fetchCollaborationRoomQuarantine,
  fetchCollaborationRooms,
  type CollaborationRoomCloseResult,
  type CollaborationRoomQuarantineReport,
  type CollaborationRoomStatus,
  type CollaborationRoomsReport,
} from "./collaborationRoomsClient";
import { formatStorageBytes } from "./storageHealthClient";
import { formatTaskRelativeTime } from "./taskTrayPresentation";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function modeLabel(mode: string): string {
  if (mode === "invite-required") return "需邀请";
  if (mode === "local-trust") return "本地信任";
  return mode;
}

/**
 * One source-language status word per room, mirroring the API flags without
 * inventing states: live peers → 活跃, retained-empty → 保留中, live but empty
 * → 空闲, durable-history-only rows → 仅持久化.
 */
function roomStatusLabel(room: CollaborationRoomStatus): string {
  if (room.peers > 0) return "活跃";
  if (room.retained) return "保留中";
  if (room.active) return "空闲";
  return "仅持久化";
}

/**
 * Compact " · "-joined typed facts of one close result (each part translated
 * separately). Mirrors the API outcome exactly: close facts first, then the
 * archive outcome — `archive_failed` reads as a failure with the errno code
 * and never as an archived history.
 */
function closeReceiptParts(result: CollaborationRoomCloseResult, t: (text: string) => string): string[] {
  const base = result.outcome === "archive_failed" ? result.failure : result.receipt;
  const parts: string[] = [];
  if (base.closed) {
    parts.push(t("已关闭"));
    parts.push(t(`断开成员 ${base.disconnected_peers}`));
  } else {
    parts.push(t("房间不在线（无成员断开）"));
  }
  if (result.outcome === "archive_failed") {
    parts.push(t(`历史归档失败（${result.failure.archive_error_code}），历史仍在原位`));
  } else if (result.receipt.archived === true) {
    parts.push(t("历史已归档"));
  } else if (result.receipt.archived === false && result.receipt.archive_reason === "no_durable_history") {
    parts.push(t("无持久化历史可归档"));
  }
  return parts;
}

/** Compact " · "-joined durable-history facts for one room row (each part translated separately). */
function roomSnapshotSummary(room: CollaborationRoomStatus, t: (text: string) => string): string | null {
  const parts: string[] = [];
  if (room.snapshot_bytes > 0) {
    parts.push(t(`快照 ${formatStorageBytes(room.snapshot_bytes)}`));
    const age = room.snapshot_updated_at ? formatTaskRelativeTime(room.snapshot_updated_at) : "";
    if (age) parts.push(t(age));
  }
  if (room.pending_updates > 0) parts.push(t(`待压缩 ${room.pending_updates}`));
  if (room.quarantined_updates > 0) parts.push(t(`隔离 ${room.quarantined_updates}`));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Renders the collaboration room status rows so operators can see which
 * rooms are live or persisted, whether invite revocations survive a gateway
 * restart, and what sits in each room's quarantine index — without grepping
 * env or curling the ops endpoints. Values are shown exactly as the API
 * reports them. The only mutation is the explicit two-step room close: the
 * confirm copy states the `room_closed` peer disconnect semantics, archive
 * is a separate opt-in checkbox, and the destructive call is never issued
 * without the confirm click.
 */
export function CollaborationRoomsSection() {
  const { t } = useLanguage();
  const [report, setReport] = useState<CollaborationRoomsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quarantine, setQuarantine] = useState<CollaborationRoomQuarantineReport | null>(null);
  const [quarantineBusyRoom, setQuarantineBusyRoom] = useState<string | null>(null);
  const [closeConfirmRoom, setCloseConfirmRoom] = useState<string | null>(null);
  const [closeArchive, setCloseArchive] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeResult, setCloseResult] = useState<CollaborationRoomCloseResult | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setQuarantine(null);
    try {
      setReport(await fetchCollaborationRooms());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleQuarantine = useCallback(
    async (room: string) => {
      if (quarantine?.room === room) {
        setQuarantine(null);
        return;
      }
      setQuarantineBusyRoom(room);
      setError(null);
      try {
        setQuarantine(await fetchCollaborationRoomQuarantine(room));
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setQuarantineBusyRoom(null);
      }
    },
    [quarantine],
  );

  const toggleCloseConfirm = useCallback((room: string) => {
    setCloseArchive(false);
    setCloseResult(null);
    setCloseConfirmRoom((current) => (current === room ? null : room));
  }, []);

  const confirmClose = useCallback(
    async (room: string) => {
      setCloseBusy(true);
      setError(null);
      try {
        const result = await closeCollaborationRoom(room, { archive: closeArchive });
        setCloseResult(result);
        setCloseConfirmRoom(null);
        await refresh();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setCloseBusy(false);
      }
    },
    [closeArchive, refresh],
  );

  const revocations = report?.invite_revocations;
  const revocationsAtRisk =
    revocations !== undefined && !revocations.durable && revocations.revoked_tokens + revocations.room_cutoffs > 0;

  return (
    <section className="task-tray-section task-tray-collab-rooms">
      <h3>{t("协作房间")}</h3>
      {error ? <p className="task-tray-notice is-error">{error}</p> : null}
      {report ? (
        <>
          <p className="task-tray-item-phase">
            {[t(modeLabel(report.mode)), report.persistence ? t("持久化已启用") : t("持久化未启用")].join(" · ")}
          </p>
          <div className="task-tray-storage-rows">
            <span>{t("已吊销邀请")}</span>
            <span>{revocations?.revoked_tokens ?? 0}</span>
            <span>{t("房间级吊销截止")}</span>
            <span>{revocations?.room_cutoffs ?? 0}</span>
            <span>{t("吊销持久性")}</span>
            <span className={revocationsAtRisk ? "is-error" : undefined}>
              {revocations?.durable ? t("已持久化") : t("仅进程内（重启即失效）")}
            </span>
          </div>
          {closeResult ? (
            <p
              className={
                closeResult.outcome === "archive_failed" ? "task-tray-notice is-error" : "task-tray-item-phase"
              }
            >
              {[
                closeResult.outcome === "archive_failed" ? closeResult.failure.room : closeResult.receipt.room,
                ...closeReceiptParts(closeResult, t),
              ].join(" · ")}
            </p>
          ) : null}
          {report.rooms.length === 0 ? (
            <p className="task-tray-item-phase">{t("暂无活跃或持久化的协作房间")}</p>
          ) : (
            <ul aria-label={t("协作房间列表")} className="task-tray-collab-room-list">
              {report.rooms.map((room) => {
                const snapshotSummary = roomSnapshotSummary(room, t);
                const showQuarantinePeek = report.persistence && room.quarantined_updates > 0;
                const peeking = quarantine?.room === room.room;
                const confirmingClose = closeConfirmRoom === room.room;
                return (
                  <li className="task-tray-collab-room" key={room.room}>
                    <div className="task-tray-item-top">
                      <span className="task-tray-item-name" title={room.room}>
                        {room.room}
                      </span>
                      <span className="task-tray-item-status">{t(roomStatusLabel(room))}</span>
                    </div>
                    {room.active ? (
                      <p className="task-tray-item-phase">
                        {[
                          t(`在线 ${room.peers}（编辑 ${room.editors} · 只读 ${room.viewers}）`),
                          room.last_activity_at ? t(formatTaskRelativeTime(room.last_activity_at)) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    ) : null}
                    {snapshotSummary ? <p className="task-tray-item-phase">{snapshotSummary}</p> : null}
                    <span className="task-tray-item-actions">
                      {showQuarantinePeek ? (
                        <button
                          disabled={quarantineBusyRoom !== null}
                          onClick={() => void toggleQuarantine(room.room)}
                          type="button"
                        >
                          {t(quarantineBusyRoom === room.room ? "读取隔离区…" : peeking ? "收起隔离区" : "查看隔离区")}
                        </button>
                      ) : null}
                      <button disabled={closeBusy} onClick={() => toggleCloseConfirm(room.room)} type="button">
                        {t(confirmingClose ? "收起关闭确认" : "关闭房间…")}
                      </button>
                    </span>
                    {confirmingClose ? (
                      <div className="task-tray-collab-close-confirm">
                        <p className="task-tray-item-phase">
                          {t("关闭后所有在线成员会收到 room_closed 错误并被断开；之后重新加入会新建会话。")}
                        </p>
                        <label className="task-tray-collab-close-archive">
                          <input
                            checked={closeArchive}
                            disabled={!report.persistence || closeBusy}
                            onChange={(event) => setCloseArchive(event.target.checked)}
                            type="checkbox"
                          />
                          {t("同时归档持久化历史（之后加入将从空文档开始）")}
                        </label>
                        {!report.persistence ? (
                          <p className="task-tray-item-phase">{t("协作持久化未启用，无法归档房间")}</p>
                        ) : null}
                        <span className="task-tray-item-actions">
                          <button disabled={closeBusy} onClick={() => void confirmClose(room.room)} type="button">
                            {t(closeBusy ? "关闭中…" : closeArchive ? "确认关闭并归档" : "确认关闭")}
                          </button>
                          <button disabled={closeBusy} onClick={() => setCloseConfirmRoom(null)} type="button">
                            {t("取消")}
                          </button>
                        </span>
                      </div>
                    ) : null}
                    {peeking ? (
                      quarantine.records.length === 0 ? (
                        <p className="task-tray-item-phase">{t("隔离区为空")}</p>
                      ) : (
                        <ul aria-label={t("房间隔离记录")} className="task-tray-collab-quarantine">
                          {quarantine.records.map((record) => (
                            <li key={record.id} title={record.reason}>
                              {[
                                record.sha256.slice(0, 12),
                                formatStorageBytes(record.byte_length),
                                t(formatTaskRelativeTime(record.quarantined_at)),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </li>
                          ))}
                        </ul>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : busy ? (
        <p className="task-tray-item-phase">{t("正在读取协作房间…")}</p>
      ) : null}
      <span className="task-tray-item-actions">
        <button disabled={busy} onClick={() => void refresh()} type="button">
          {t("刷新")}
        </button>
      </span>
    </section>
  );
}
