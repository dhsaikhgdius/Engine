/**
 * Minimal read-only collaboration rooms ops section for the task tray:
 * merged live + durable room status from `GET /api/collab/rooms` (member
 * counts, snapshot size/age, pending and quarantined updates) plus invite
 * revocation durability counters, with an optional per-room quarantine peek
 * via `GET /api/collab/rooms/quarantine`. Display only — no room close,
 * archive, or invite mutations.
 *
 * @module CollaborationRoomsSection
 */

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "../../i18n/language";
import {
  fetchCollaborationRoomQuarantine,
  fetchCollaborationRooms,
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
 * Renders the read-only collaboration room status rows so operators can see
 * which rooms are live or persisted, whether invite revocations survive a
 * gateway restart, and what sits in each room's quarantine index — without
 * grepping env or curling the ops endpoints. Values are shown exactly as the
 * API reports them; nothing here closes rooms or mutates invites.
 */
export function CollaborationRoomsSection() {
  const { t } = useLanguage();
  const [report, setReport] = useState<CollaborationRoomsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quarantine, setQuarantine] = useState<CollaborationRoomQuarantineReport | null>(null);
  const [quarantineBusyRoom, setQuarantineBusyRoom] = useState<string | null>(null);

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
          {report.rooms.length === 0 ? (
            <p className="task-tray-item-phase">{t("暂无活跃或持久化的协作房间")}</p>
          ) : (
            <ul aria-label={t("协作房间列表")} className="task-tray-collab-room-list">
              {report.rooms.map((room) => {
                const snapshotSummary = roomSnapshotSummary(room, t);
                const showQuarantinePeek = report.persistence && room.quarantined_updates > 0;
                const peeking = quarantine?.room === room.room;
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
                    {showQuarantinePeek ? (
                      <span className="task-tray-item-actions">
                        <button
                          disabled={quarantineBusyRoom !== null}
                          onClick={() => void toggleQuarantine(room.room)}
                          type="button"
                        >
                          {t(quarantineBusyRoom === room.room ? "读取隔离区…" : peeking ? "收起隔离区" : "查看隔离区")}
                        </button>
                      </span>
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
