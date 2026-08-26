/**
 * Settings → Agent 工作区：SQLite 持久化的指令 / 经验 / 技能引用 / 记忆编辑器。
 * 保存后新的 Agent 会话自动生效（网关按 仓库技能 → 数据库 → 会话覆盖 合并）。
 *
 * @module AgentWorkspaceSettings
 */

import { AlertTriangle, Download, NotebookPen, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/language";
import {
  deleteAgentWorkspaceMemoryEntry,
  exportAgentWorkspaceBundle,
  fetchAgentWorkspace,
  importAgentWorkspaceBundle,
  listAgentWorkspaceDocumentVersions,
  restoreAgentWorkspaceDocumentVersion,
  saveAgentWorkspaceDocument,
  saveAgentWorkspaceSkillRefs,
  setAgentWorkspaceMemoryEntry,
  type AgentWorkspaceDocumentKind,
  type AgentWorkspaceDocumentVersion,
  type AgentWorkspaceScope,
  type AgentWorkspaceSnapshot,
} from "./agentWorkspaceClient";
import "./AgentWorkspaceSettings.css";

const SCOPES: readonly { id: AgentWorkspaceScope; label: string }[] = [
  { id: "org", label: "团队" },
  { id: "user", label: "个人" },
];

const KINDS: readonly { id: AgentWorkspaceDocumentKind; label: string }[] = [
  { id: "instructions", label: "指令" },
  { id: "learnings", label: "经验" },
];

/** A dead gateway reaches the browser as an opaque fetch string; name the likely cause. */
const UNREACHABLE_GATEWAY = /failed to fetch|networkerror|load failed|connection refused/i;

type WorkspaceError = { title: string; message: string };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatMoment(value: string | null) {
  if (!value) return "";
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? "" : moment.toLocaleString();
}

/** 顶栏弹出面板：编辑 SQL 持久化的 Agent 工作区。 */
export function AgentWorkspaceSettings() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [workspace, setWorkspace] = useState<AgentWorkspaceSnapshot | null>(null);
  const [scope, setScope] = useState<AgentWorkspaceScope>("org");
  const [kind, setKind] = useState<AgentWorkspaceDocumentKind>("instructions");
  const [draft, setDraft] = useState("");
  const [versions, setVersions] = useState<AgentWorkspaceDocumentVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<WorkspaceError | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillSource, setSkillSource] = useState("");
  const [memoryKey, setMemoryKey] = useState("");
  const [memoryValue, setMemoryValue] = useState("");
  const [memoryTtl, setMemoryTtl] = useState("");

  const reload = useCallback(async () => {
    const snapshot = await fetchAgentWorkspace();
    setWorkspace(snapshot);
    return snapshot;
  }, []);

  const reloadVersions = useCallback(async (nextScope: AgentWorkspaceScope, nextKind: AgentWorkspaceDocumentKind) => {
    const list = await listAgentWorkspaceDocumentVersions(nextScope, nextKind);
    setVersions(list);
    setSelectedVersion("");
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const snapshot = await reload();
        if (cancelled) return;
        const current = snapshot.documents.find((entry) => entry.scope === scope && entry.kind === kind);
        setDraft(current?.content ?? "");
        await reloadVersions(scope, kind);
        if (!cancelled) setNotice("");
      } catch (failure) {
        if (!cancelled) setError({ title: t("Agent 工作区加载失败"), message: errorText(failure) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, scope, kind, reloadToken, reload, reloadVersions, t]);

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (!(event.target instanceof Node) || wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    try {
      setNotice(await action());
      setError(null);
    } catch (failure) {
      setNotice("");
      setError({ title: t("操作失败"), message: errorText(failure) });
    } finally {
      setBusy(false);
    }
  }

  const currentDocument = workspace?.documents.find((entry) => entry.scope === scope && entry.kind === kind);
  const dirty = draft !== (currentDocument?.content ?? "");
  const skillRefs = workspace?.skill_refs ?? [];
  const memory = workspace?.memory ?? [];

  function documentMeta() {
    if (dirty) return t("未保存的修改");
    if (!currentDocument?.version) return t("尚未保存");
    return `v${currentDocument.version} · ${formatMoment(currentDocument.updated_at)}`;
  }

  return (
    <div className="agent-workspace-settings" ref={wrapperRef}>
      <button
        ref={triggerRef}
        aria-controls="agent-workspace-settings-popover"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("Agent 工作区设置")}
        className={`top-bar-settings-trigger${open ? " is-active" : ""}`}
        title={t("Agent 工作区设置")}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <NotebookPen aria-hidden size={14} strokeWidth={1.9} />
        <span className="top-bar-settings-label">{t("Agent 工作区")}</span>
      </button>

      {open ? (
        <section
          aria-label={t("Agent 工作区设置")}
          className="agent-workspace-settings-popover"
          id="agent-workspace-settings-popover"
          role="dialog"
        >
          <header className="agent-workspace-settings-header">
            <div className="agent-workspace-settings-header-text">
              <strong>{t("Agent 工作区")}</strong>
              <small>{t("指令、经验、技能引用与记忆存入 SQLite；保存后新会话自动生效，无需改动仓库。")}</small>
            </div>
            <button
              aria-label={t("关闭 Agent 工作区设置")}
              className="agent-workspace-icon-button"
              type="button"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden size={15} />
            </button>
          </header>

          <div className="agent-workspace-body">
            {error ? (
              <div className="agent-workspace-alert" role="alert">
                <AlertTriangle aria-hidden size={15} />
                <div className="agent-workspace-alert-text">
                  <strong>{error.title}</strong>
                  <p className="agent-workspace-alert-message">{error.message}</p>
                  {UNREACHABLE_GATEWAY.test(error.message) ? (
                    <p className="agent-workspace-alert-hint">{t("无法连接 Director 网关，请确认它已在本地启动。")}</p>
                  ) : null}
                </div>
                <button
                  className="agent-workspace-button"
                  disabled={loading || busy}
                  type="button"
                  onClick={() => setReloadToken((token) => token + 1)}
                >
                  {t("重试")}
                </button>
              </div>
            ) : null}

            {workspace ? (
              <>
                <div className="agent-workspace-axes">
                  <div className="agent-workspace-axis">
                    <span className="agent-workspace-axis-label" id="agent-workspace-scope-label">
                      {t("作用域")}
                    </span>
                    <div
                      aria-labelledby="agent-workspace-scope-label"
                      className="agent-workspace-segmented"
                      role="radiogroup"
                    >
                      {SCOPES.map((option) => (
                        <button
                          aria-checked={scope === option.id}
                          className={scope === option.id ? "is-active" : ""}
                          key={option.id}
                          role="radio"
                          type="button"
                          onClick={() => setScope(option.id)}
                        >
                          {t(option.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="agent-workspace-axis">
                    <span className="agent-workspace-axis-label" id="agent-workspace-kind-label">
                      {t("文档")}
                    </span>
                    <div
                      aria-labelledby="agent-workspace-kind-label"
                      className="agent-workspace-segmented"
                      role="radiogroup"
                    >
                      {KINDS.map((option) => (
                        <button
                          aria-checked={kind === option.id}
                          className={kind === option.id ? "is-active" : ""}
                          key={option.id}
                          role="radio"
                          type="button"
                          onClick={() => setKind(option.id)}
                        >
                          {t(option.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <section aria-label={t("工作区文档")} className="agent-workspace-card">
                  <div className="agent-workspace-card-head">
                    <h3 className="agent-workspace-card-title">{t(kind === "instructions" ? "指令" : "经验")}</h3>
                    <span className={`agent-workspace-card-meta${dirty ? " is-dirty" : ""}`}>{documentMeta()}</span>
                  </div>
                  <textarea
                    aria-label={t("工作区文档内容")}
                    className="agent-workspace-editor"
                    placeholder={t(kind === "instructions" ? "写给 Agent 的团队/个人指令…" : "沉淀可复用的经验教训…")}
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                  />
                  <div className="agent-workspace-editor-actions">
                    <select
                      aria-label={t("版本历史")}
                      value={selectedVersion}
                      onChange={(event) => setSelectedVersion(event.currentTarget.value)}
                    >
                      <option value="">
                        {t("版本历史")}（{versions.length}）
                      </option>
                      {versions.map((version) => (
                        <option key={version.version} value={String(version.version)}>
                          v{version.version} · {formatMoment(version.saved_at)} · {version.chars}
                        </option>
                      ))}
                    </select>
                    <button
                      className="agent-workspace-button"
                      disabled={busy || !selectedVersion}
                      type="button"
                      onClick={() =>
                        run(async () => {
                          const restored = await restoreAgentWorkspaceDocumentVersion(
                            scope,
                            kind,
                            Number(selectedVersion),
                          );
                          setDraft(restored.content);
                          await reload();
                          await reloadVersions(scope, kind);
                          return `${t("已恢复为新版本")} v${restored.version}`;
                        })
                      }
                    >
                      <RotateCcw aria-hidden size={12} />
                      {t("恢复")}
                    </button>
                    <button
                      className="agent-workspace-button is-primary"
                      disabled={busy || !dirty}
                      type="button"
                      onClick={() =>
                        run(async () => {
                          const saved = await saveAgentWorkspaceDocument(scope, kind, draft);
                          await reload();
                          await reloadVersions(scope, kind);
                          return `${t("已保存")} v${saved.version}`;
                        })
                      }
                    >
                      {t("保存")}
                    </button>
                  </div>
                </section>

                <section aria-label={t("技能引用")} className="agent-workspace-card">
                  <div className="agent-workspace-card-head">
                    <h3 className="agent-workspace-card-title">{t("技能引用")}</h3>
                    <span className="agent-workspace-card-meta">{skillRefs.length}</span>
                  </div>
                  {skillRefs.length === 0 ? (
                    <p className="agent-workspace-empty">{t("还没有技能引用")}</p>
                  ) : (
                    <ul className="agent-workspace-list">
                      {skillRefs.map((ref) => (
                        <li className="agent-workspace-row" key={ref.id}>
                          <label className="agent-workspace-switch">
                            <input
                              aria-label={`${t("启用技能")} ${ref.name}`}
                              checked={ref.enabled}
                              type="checkbox"
                              onChange={(event) => {
                                const enabled = event.currentTarget.checked;
                                void run(async () => {
                                  await saveAgentWorkspaceSkillRefs(
                                    skillRefs.map((entry) => (entry.id === ref.id ? { ...entry, enabled } : entry)),
                                  );
                                  await reload();
                                  return t("已更新技能引用");
                                });
                              }}
                            />
                            <span aria-hidden />
                          </label>
                          <span className="agent-workspace-row-text">
                            <span className="agent-workspace-row-title">{ref.name}</span>
                            <span className="agent-workspace-row-sub">
                              <em className="agent-workspace-tag">{t(ref.scope === "org" ? "团队" : "个人")}</em>
                              <code title={ref.source}>{ref.source}</code>
                            </span>
                          </span>
                          <button
                            aria-label={`${t("删除技能引用")} ${ref.name}`}
                            className="agent-workspace-icon-button is-danger"
                            disabled={busy}
                            type="button"
                            onClick={() =>
                              run(async () => {
                                await saveAgentWorkspaceSkillRefs(skillRefs.filter((entry) => entry.id !== ref.id));
                                await reload();
                                return t("已删除技能引用");
                              })
                            }
                          >
                            <Trash2 aria-hidden size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div aria-label={t("添加技能引用")} className="agent-workspace-form is-skill" role="group">
                    <input
                      aria-label={t("技能名称")}
                      placeholder={t("技能名称")}
                      type="text"
                      value={skillName}
                      onChange={(event) => setSkillName(event.currentTarget.value)}
                    />
                    <input
                      aria-label={t("技能来源（路径或 URL）")}
                      placeholder={t("技能来源（路径或 URL）")}
                      type="text"
                      value={skillSource}
                      onChange={(event) => setSkillSource(event.currentTarget.value)}
                    />
                    <button
                      className="agent-workspace-button"
                      disabled={busy || !skillName.trim() || !skillSource.trim()}
                      type="button"
                      onClick={() =>
                        run(async () => {
                          const id = `${scope}-${skillName.trim().replace(/[^A-Za-z0-9._-]+/g, "-")}-${Date.now().toString(36)}`;
                          await saveAgentWorkspaceSkillRefs([
                            ...skillRefs,
                            { id, scope, name: skillName.trim(), source: skillSource.trim(), note: "", enabled: true },
                          ]);
                          setSkillName("");
                          setSkillSource("");
                          await reload();
                          return t("已添加技能引用");
                        })
                      }
                    >
                      {t("添加")}
                    </button>
                  </div>
                </section>

                <section aria-label={t("记忆")} className="agent-workspace-card">
                  <div className="agent-workspace-card-head">
                    <h3 className="agent-workspace-card-title">{t("记忆")}</h3>
                    <span className="agent-workspace-card-meta">{memory.length}</span>
                  </div>
                  <p className="agent-workspace-memory-note">
                    {t("记忆由用户掌控，标记为不可信数据，永远不会自动注入为指令；仅当明确要求时 Agent 才会读取。")}
                  </p>
                  {memory.length === 0 ? (
                    <p className="agent-workspace-empty">{t("还没有记忆条目")}</p>
                  ) : (
                    <ul className="agent-workspace-list">
                      {memory.map((entry) => (
                        <li className="agent-workspace-row" key={`${entry.scope}:${entry.key}`}>
                          <span className="agent-workspace-row-text">
                            <span className="agent-workspace-row-title">{entry.key}</span>
                            <span className="agent-workspace-row-sub">
                              <em className="agent-workspace-tag">{t(entry.scope === "org" ? "团队" : "个人")}</em>
                              <code title={JSON.stringify(entry.value)}>{JSON.stringify(entry.value)}</code>
                              {entry.expires_at ? (
                                <em className="agent-workspace-tag">
                                  {t("过期")} {formatMoment(entry.expires_at)}
                                </em>
                              ) : null}
                            </span>
                          </span>
                          <button
                            aria-label={`${t("删除记忆")} ${entry.key}`}
                            className="agent-workspace-icon-button is-danger"
                            disabled={busy}
                            type="button"
                            onClick={() =>
                              run(async () => {
                                await deleteAgentWorkspaceMemoryEntry(entry.scope, entry.key);
                                await reload();
                                return t("已删除记忆条目");
                              })
                            }
                          >
                            <Trash2 aria-hidden size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div aria-label={t("添加记忆条目")} className="agent-workspace-form is-memory" role="group">
                    <input
                      aria-label={t("记忆键")}
                      placeholder={t("记忆键")}
                      type="text"
                      value={memoryKey}
                      onChange={(event) => setMemoryKey(event.currentTarget.value)}
                    />
                    <input
                      aria-label={t("记忆值")}
                      placeholder={t("记忆值")}
                      type="text"
                      value={memoryValue}
                      onChange={(event) => setMemoryValue(event.currentTarget.value)}
                    />
                    <input
                      aria-label={t("TTL 秒数（可选）")}
                      min="0"
                      placeholder="TTL s"
                      type="number"
                      value={memoryTtl}
                      onChange={(event) => setMemoryTtl(event.currentTarget.value)}
                    />
                    <button
                      className="agent-workspace-button"
                      disabled={busy || !memoryKey.trim()}
                      type="button"
                      onClick={() =>
                        run(async () => {
                          const ttl = Number(memoryTtl);
                          await setAgentWorkspaceMemoryEntry(
                            scope,
                            memoryKey.trim(),
                            memoryValue,
                            Number.isFinite(ttl) && ttl > 0 ? Math.round(ttl) : undefined,
                          );
                          setMemoryKey("");
                          setMemoryValue("");
                          setMemoryTtl("");
                          await reload();
                          return t("已保存记忆条目");
                        })
                      }
                    >
                      {t("添加")}
                    </button>
                  </div>
                </section>
              </>
            ) : error ? null : (
              <div aria-label={t("正在加载 Agent 工作区")} className="agent-workspace-skeleton" role="status">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>

          <footer className="agent-workspace-footer">
            <p aria-live="polite" className="agent-workspace-status" role="status">
              {notice}
            </p>
            <div className="agent-workspace-footer-actions">
              <button
                className="agent-workspace-button"
                disabled={busy}
                type="button"
                onClick={() =>
                  run(async () => {
                    const bundle = await exportAgentWorkspaceBundle();
                    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
                    const link = document.createElement("a");
                    link.href = URL.createObjectURL(blob);
                    link.download = `director-agent-workspace-${new Date().toISOString().slice(0, 10)}.json`;
                    link.click();
                    URL.revokeObjectURL(link.href);
                    return t("已导出工作区 bundle");
                  })
                }
              >
                <Download aria-hidden size={12} />
                {t("导出 JSON")}
              </button>
              <button
                className="agent-workspace-button"
                disabled={busy}
                type="button"
                onClick={() => importInputRef.current?.click()}
              >
                <Upload aria-hidden size={12} />
                {t("导入 JSON")}
              </button>
              <input
                ref={importInputRef}
                accept="application/json"
                aria-label={t("导入工作区 bundle")}
                hidden
                type="file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  void run(async () => {
                    const parsed: unknown = JSON.parse(await file.text());
                    await importAgentWorkspaceBundle(parsed);
                    const snapshot = await reload();
                    const current = snapshot.documents.find((entry) => entry.scope === scope && entry.kind === kind);
                    setDraft(current?.content ?? "");
                    await reloadVersions(scope, kind);
                    return t("已导入工作区 bundle");
                  });
                }}
              />
            </div>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
