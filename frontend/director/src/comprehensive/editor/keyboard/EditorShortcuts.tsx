import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEscapeLayer } from "../../app/layout/escapeLayerStack";
import { useLanguage } from "../../i18n/language";
import type { DirectorWorkspaceMode } from "../workspaces/directorWorkspaceStore";

export const EDITOR_SHORTCUTS_OPEN_EVENT = "director:editor-shortcuts:open";

export function openDirectorEditorShortcuts() {
  window.dispatchEvent(new Event(EDITOR_SHORTCUTS_OPEN_EVENT));
}

/** Mirrors the App-level shortcut guard so `?` never fires while typing. */
function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

type ShortcutGroup = {
  title: string;
  rows: Array<[string, string]>;
};

// Global bindings live in App.tsx (undo/redo plus the Stage clipboard set).
const COMMON_SHORTCUTS: ShortcutGroup = {
  title: "通用",
  rows: [
    ["撤销", "⌘/Ctrl Z"],
    ["重做", "⌘/Ctrl ⇧ Z · ⌘/Ctrl Y"],
    ["显示 / 关闭快捷键面板", "⇧ /"],
  ],
};

const STAGE_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "3D 片场",
    rows: [
      ["复制所选对象", "⌘/Ctrl C"],
      ["粘贴对象", "⌘/Ctrl V"],
      ["复制并粘贴副本", "⌘/Ctrl D"],
      ["选择全部对象", "⌘/Ctrl A"],
      ["删除所选对象", "Delete · Backspace"],
      ["手型视口移动", "W · A · S · D · Q · E"],
      ["方向键转视角", "← · → · ↑ · ↓"],
    ],
  },
];

const CANVAS_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "画布",
    rows: [
      ["删除节点", "Delete · Backspace"],
      ["取消连接 / 关闭菜单", "Esc"],
    ],
  },
];

// Kept in sync with the window keydown handler in VideoEditorWorkspace.tsx.
const VIDEO_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "视频编辑器",
    rows: [
      ["播放 / 暂停", "Space"],
      ["复制所选剪辑副本", "⌘/Ctrl D"],
      ["删除剪辑", "Delete · Backspace"],
      ["波纹删除剪辑（后续片段补位）", "⇧ Delete"],
      ["在播放头处分割", "S"],
      ["逐帧微移所选剪辑", ", · ."],
      ["按 1 秒微移所选剪辑", "⇧ , · ⇧ ."],
      ["逐帧移动播放头", "← · →"],
      ["按 1 秒移动播放头", "⇧ ← · ⇧ →"],
      ["播放头跳到开头 / 结尾", "Home · End"],
      ["取消选择 / 关闭菜单", "Esc"],
    ],
  },
];

function getShortcutGroups(workspace: DirectorWorkspaceMode) {
  if (workspace === "stage") return [COMMON_SHORTCUTS, ...STAGE_SHORTCUTS];
  if (workspace === "canvas") return [COMMON_SHORTCUTS, ...CANVAS_SHORTCUTS];
  if (workspace === "video") return [COMMON_SHORTCUTS, ...VIDEO_SHORTCUTS];
  return [COMMON_SHORTCUTS];
}

export function EditorShortcuts({ workspace }: { workspace: DirectorWorkspaceMode }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const groups = getShortcutGroups(workspace);

  useEffect(() => {
    const openFromEvent = () => setOpen(true);
    const toggleFromKeyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const isShiftSlash = event.key === "?" || (event.shiftKey && (event.key === "/" || event.code === "Slash"));
      if (!isShiftSlash) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener(EDITOR_SHORTCUTS_OPEN_EVENT, openFromEvent);
    window.addEventListener("keydown", toggleFromKeyboard);
    return () => {
      window.removeEventListener(EDITOR_SHORTCUTS_OPEN_EVENT, openFromEvent);
      window.removeEventListener("keydown", toggleFromKeyboard);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || wrapperRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    return () => document.removeEventListener("pointerdown", closeOnPointerDown);
  }, [open]);

  // Escape 经共享层级栈处理，避免与对话框/下拉的 Esc 一键连关。
  useEscapeLayer(open, (event) => {
    event.preventDefault();
    setOpen(false);
  });

  return (
    <div className="editor-shortcuts" ref={wrapperRef}>
      {open ? (
        <section
          aria-label={t("键盘快捷键")}
          className="editor-shortcuts-popover"
          id="editor-shortcuts-popover"
          role="dialog"
        >
          <header className="editor-shortcuts-header">
            <div>
              <strong>{t("键盘快捷键")}</strong>
              <small>{t("当前工作区可用操作")}</small>
            </div>
            <button aria-label={t("关闭快捷键")} type="button" onClick={() => setOpen(false)}>
              <X aria-hidden size={15} />
            </button>
          </header>
          <div className="editor-shortcuts-groups">
            {groups.map((group) => (
              <section className="editor-shortcuts-group" key={group.title}>
                <h3>{t(group.title)}</h3>
                <dl>
                  {group.rows.map(([label, keys]) => (
                    <div className="editor-shortcut-row" key={`${label}-${keys}`}>
                      <dt>{t(label)}</dt>
                      <dd>{keys}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
