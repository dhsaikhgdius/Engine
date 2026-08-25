import { BookOpen, Boxes, Film, LayoutDashboard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../../i18n/language";
import "./WelcomeGuide.css";

export const WELCOME_GUIDE_STORAGE_KEY = "director.welcome-guide.v1.seen";
export const WELCOME_GUIDE_OPEN_EVENT = "director:welcome-guide:open";

/**
 * The documentation site ships inside the repository (docs/site, Astro
 * Starlight) and has no deployed public URL; README documents this local
 * address, served by `npm run docs:dev`.
 */
export const DIRECTOR_DOCS_URL = "http://127.0.0.1:4321";

export function showDirectorWelcomeGuide() {
  window.dispatchEvent(new Event(WELCOME_GUIDE_OPEN_EVENT));
}

function hasSeenWelcomeGuide() {
  try {
    return window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY) === "1";
  } catch {
    // Without persistence the guide would reappear on every load, which is
    // worse than never showing it automatically.
    return true;
  }
}

function markWelcomeGuideSeen() {
  try {
    window.localStorage.setItem(WELCOME_GUIDE_STORAGE_KEY, "1");
  } catch {
    // Storage can be unavailable in a privacy-restricted frame.
  }
}

const WELCOME_WORKSPACES = [
  {
    icon: LayoutDashboard,
    title: "画布",
    description: "以节点图组织生成与制作任务，构建可追溯的多模态生产流程。",
  },
  {
    icon: Boxes,
    title: "3D 片场",
    description: "在三维场景中布置角色、道具与相机，完成走位、动画与分镜。",
  },
  {
    icon: Film,
    title: "视频编辑器",
    description: "在多轨时间线上剪辑画面、音频与字幕，并导出成片。",
  },
] as const;

export function WelcomeGuide({ embedded = false }: { embedded?: boolean }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(() => !embedded && !hasSeenWelcomeGuide());
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (embedded) return;
    const reopen = () => setOpen(true);
    window.addEventListener(WELCOME_GUIDE_OPEN_EVENT, reopen);
    return () => window.removeEventListener(WELCOME_GUIDE_OPEN_EVENT, reopen);
  }, [embedded]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      markWelcomeGuideSeen();
      setOpen(false);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!open) return null;

  function dismiss() {
    markWelcomeGuideSeen();
    setOpen(false);
    previousFocusRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="welcome-guide-overlay">
      <section
        aria-describedby="welcome-guide-intro"
        aria-labelledby="welcome-guide-title"
        aria-modal="true"
        className="welcome-guide-card"
        role="dialog"
      >
        <header className="welcome-guide-header">
          <div>
            <strong id="welcome-guide-title">{t("欢迎使用 Director")}</strong>
            <p id="welcome-guide-intro">
              {t(
                "Director 是一个 Agent 原生的 3D 影视创作工作台：从三维布景、镜头设计到生成与剪辑，都在浏览器中完成。",
              )}
            </p>
          </div>
          <button aria-label={t("关闭欢迎引导")} onClick={dismiss} type="button">
            <X aria-hidden size={15} />
          </button>
        </header>
        <ul className="welcome-guide-workspaces">
          {WELCOME_WORKSPACES.map(({ icon: Icon, title, description }) => (
            <li key={title}>
              <span aria-hidden className="welcome-guide-workspace-icon">
                <Icon size={16} />
              </span>
              <div>
                <strong>{t(title)}</strong>
                <p>{t(description)}</p>
              </div>
            </li>
          ))}
        </ul>
        <footer className="welcome-guide-footer">
          <a
            className="welcome-guide-docs"
            href={DIRECTOR_DOCS_URL}
            rel="noreferrer"
            target="_blank"
            title={t("文档站在仓库 docs/site 内，需先在仓库根目录运行 npm run docs:dev")}
          >
            <BookOpen aria-hidden size={14} />
            <span>{t("查看文档")}</span>
          </a>
          <span className="welcome-guide-docs-hint">{t("本地文档站，需先运行 npm run docs:dev")}</span>
          <button className="welcome-guide-primary" onClick={dismiss} ref={primaryRef} type="button">
            {t("开始使用")}
          </button>
        </footer>
      </section>
    </div>
  );
}
