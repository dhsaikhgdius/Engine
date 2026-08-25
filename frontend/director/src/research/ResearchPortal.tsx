import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Languages,
  Menu,
  Play,
  ShieldCheck,
  TerminalSquare,
  X,
} from "lucide-react";
import stageRender from "../../../../docs/site/src/content/docs/engineering/reference/director-stage-render.png";
import stageWide from "../../../../docs/site/src/content/docs/engineering/reference/director-stage-wide.png";
import {
  documentationSections,
  portalCopy,
  protocolSteps,
  researchCopy,
  researchSections,
  type ResearchLocale,
} from "./researchContent";
import { persistResearchLocale, readInitialResearchLocale } from "./researchLocale";
import "./researchPortal.css";

type ResearchPage = "home" | "docs";

function pageFromPath() {
  return window.location.pathname.replace(/\/+$/, "") === "/research/docs" ? "docs" : "home";
}

function projectPath(page: ResearchPage) {
  return page === "docs" ? "/research/docs" : "/research";
}

function useResearchPage() {
  const [page, setPage] = useState<ResearchPage>(pageFromPath);

  useEffect(() => {
    const updatePage = () => setPage(pageFromPath());
    window.addEventListener("popstate", updatePage);
    return () => window.removeEventListener("popstate", updatePage);
  }, []);

  const navigate = (nextPage: ResearchPage) => {
    const nextPath = projectPath(nextPage);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setPage(nextPage);
    if (!navigator.userAgent.includes("jsdom")) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  };

  return { page, navigate };
}

function ResearchMark() {
  return (
    <span aria-hidden="true" className="research-mark">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

function PortalHeader({
  locale,
  onLocaleChange,
  page,
  onNavigate,
}: {
  locale: ResearchLocale;
  onLocaleChange: (locale: ResearchLocale) => void;
  page: ResearchPage;
  onNavigate: (page: ResearchPage) => void;
}) {
  const copy = researchCopy(portalCopy, locale);
  const [menuOpen, setMenuOpen] = useState(false);

  const navigate = (nextPage: ResearchPage) => {
    setMenuOpen(false);
    onNavigate(nextPage);
  };

  return (
    <header className="research-header">
      <a
        className="research-brand"
        href="/research"
        onClick={(event) => {
          event.preventDefault();
          navigate("home");
        }}
      >
        <ResearchMark />
        <span>Director</span>
        <em>{copy.research}</em>
      </a>
      <button
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close navigation" : "Open navigation"}
        className="research-menu-toggle"
        onClick={() => setMenuOpen((value) => !value)}
        type="button"
      >
        {menuOpen ? <X size={18} /> : <Menu size={18} />}
      </button>
      <nav aria-label="Research navigation" className={`research-nav${menuOpen ? " is-open" : ""}`}>
        <a href="#overview" onClick={() => setMenuOpen(false)}>
          {copy.overview}
        </a>
        <a href="#protocol" onClick={() => setMenuOpen(false)}>
          {copy.protocol}
        </a>
        <a
          aria-current={page === "docs" ? "page" : undefined}
          href="/research/docs"
          onClick={(event) => {
            event.preventDefault();
            navigate("docs");
          }}
        >
          {copy.documentation}
        </a>
        <a className="research-studio-link" href="/">
          <span>{copy.openStudio}</span>
          <ArrowUpRight size={14} />
        </a>
        <label className="research-language" title={locale === "zh" ? "Language" : "切换语言"}>
          <Languages size={14} />
          <select
            aria-label="Language"
            value={locale}
            onChange={(event) => onLocaleChange(event.currentTarget.value as ResearchLocale)}
          >
            <option value="en">EN</option>
            <option value="zh">中文</option>
          </select>
        </label>
      </nav>
    </header>
  );
}

function TemplateHeroGallery({ locale }: { locale: ResearchLocale }) {
  return (
    <section
      aria-label={locale === "zh" ? "Director 片场画廊" : "Director stage gallery"}
      className="research-template-gallery"
    >
      <div className="research-gallery-frame research-gallery-frame-side">
        <img alt="Director 3D stage camera and character" src={stageRender} />
      </div>
      <div className="research-gallery-frame research-gallery-frame-main">
        <img alt="Director 3D production desk" src={stageWide} />
        <span className="research-gallery-caption">Director Stage · v0.3.1</span>
      </div>
      <div className="research-gallery-frame research-gallery-frame-side research-gallery-frame-right">
        <img alt="Director stage transform tools" src={stageRender} />
      </div>
      <div aria-label={locale === "zh" ? "画廊状态" : "Gallery status"} className="research-gallery-controls">
        <span aria-hidden="true" />
        <b aria-hidden="true" />
        <span aria-hidden="true" />
      </div>
    </section>
  );
}

function SystemDiagram({ locale }: { locale: ResearchLocale }) {
  const labels =
    locale === "zh"
      ? { state: "项目状态", scene: "场景", timeline: "时间线", audit: "审计", capture: "捕获", agent: "Agent" }
      : {
          state: "Project state",
          scene: "Scene",
          timeline: "Timeline",
          audit: "Audit",
          capture: "Capture",
          agent: "Agent",
        };

  return (
    <figure
      aria-label={locale === "zh" ? "Director 系统示意" : "Director system diagram"}
      className="research-system-diagram"
    >
      <div className="diagram-grid" />
      <div className="diagram-orbit diagram-orbit-one" />
      <div className="diagram-orbit diagram-orbit-two" />
      <div className="diagram-core">
        <span>{labels.state}</span>
      </div>
      <div className="diagram-node diagram-node-scene">
        <i />
        <span>{labels.scene}</span>
      </div>
      <div className="diagram-node diagram-node-timeline">
        <i />
        <span>{labels.timeline}</span>
      </div>
      <div className="diagram-node diagram-node-audit">
        <i />
        <span>{labels.audit}</span>
      </div>
      <div className="diagram-node diagram-node-capture">
        <i />
        <span>{labels.capture}</span>
      </div>
      <div className="diagram-node diagram-node-agent">
        <i />
        <span>{labels.agent}</span>
      </div>
      <figcaption>
        <span>UI</span>
        <span>MCP</span>
        <span>HTTP</span>
        <span>CLI</span>
      </figcaption>
    </figure>
  );
}

function ProtocolFlow({ locale }: { locale: ResearchLocale }) {
  return (
    <div className="research-protocol-flow">
      {protocolSteps.map((step, index) => (
        <div className="protocol-step" key={step.id}>
          <span className="protocol-index">{String(index + 1).padStart(2, "0")}</span>
          <div>
            <h3>{locale === "zh" ? step.zh : step.en}</h3>
            <p>{locale === "zh" ? step.detail.zh : step.detail.en}</p>
          </div>
          {index < protocolSteps.length - 1 ? (
            <ChevronRight aria-hidden="true" className="protocol-arrow" size={18} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function HomePage({ locale, onNavigate }: { locale: ResearchLocale; onNavigate: (page: ResearchPage) => void }) {
  const copy = researchCopy(portalCopy, locale);

  return (
    <main>
      <TemplateHeroGallery locale={locale} />
      <section className="research-paper-hero" id="overview">
        <div className="research-paper-hero-copy">
          <p className="research-kicker">
            <span />
            {copy.heroEyebrow}
          </p>
          <h1>{copy.heroTitle}</h1>
          <p className="research-hero-lead">{copy.heroLead}</p>
          <div className="research-hero-actions">
            <a
              href="/research/docs"
              onClick={(event) => {
                event.preventDefault();
                onNavigate("docs");
              }}
            >
              <BookOpen size={17} />
              {copy.readDocs}
            </a>
            <a href="#protocol">
              <ArrowDownRight size={17} />
              {copy.inspectProtocol}
            </a>
          </div>
        </div>
        <div className="research-paper-hero-meta">
          <p>{locale === "zh" ? "项目状态" : "Project state"}</p>
          <strong>
            {locale === "zh" ? "可检查的创作与评测工作流" : "Inspectable authoring and evaluation workflow"}
          </strong>
          <span>Browser · MCP · HTTP · CLI</span>
        </div>
      </section>

      <section className="research-principle" aria-label={copy.discipline}>
        <span className="research-section-number">00</span>
        <p>{copy.claimOne}</p>
        <ShieldCheck aria-hidden="true" size={22} />
      </section>

      <section className="research-abstract research-section" id="abstract">
        <div className="research-section-heading">
          <p>{copy.abstractLabel}</p>
          <span>01 / 05</span>
        </div>
        <div className="research-section-main">
          <h2>{copy.abstractTitle}</h2>
          <p>{copy.abstractBody}</p>
        </div>
        <div className="research-interface-row" aria-label="Director interfaces">
          <span>
            <span className="interface-dot" />
            Browser studio
          </span>
          <span>
            <span className="interface-dot" />
            MCP
          </span>
          <span>
            <span className="interface-dot" />
            HTTP gateway
          </span>
          <span>
            <span className="interface-dot" />
            CLI
          </span>
        </div>
      </section>

      <section className="research-system research-section">
        <div className="research-section-heading">
          <p>{copy.systemLabel}</p>
          <span>02 / 05</span>
        </div>
        <div className="research-system-intro">
          <div>
            <h2>{copy.systemTitle}</h2>
            <p>{copy.systemBody}</p>
          </div>
          <SystemDiagram locale={locale} />
        </div>
        <div className="research-capability-grid">
          {[
            {
              icon: <Play size={19} />,
              title: locale === "zh" ? "交互式片场" : "Interactive stage",
              body:
                locale === "zh"
                  ? "对象、角色、环境、相机与构图在浏览器中协同编辑。"
                  : "Objects, characters, environment, cameras, and framing are authored in the browser.",
            },
            {
              icon: <TerminalSquare size={19} />,
              title: locale === "zh" ? "结构化控制" : "Structured control",
              body:
                locale === "zh"
                  ? "Agent 通过已声明的操作而不是屏幕坐标来编辑项目。"
                  : "Agents edit through declared operations instead of screen coordinates.",
            },
            {
              icon: <Check size={19} />,
              title: locale === "zh" ? "原子校验" : "Atomic validation",
              body:
                locale === "zh"
                  ? "批量操作要么完整提交，要么不改变场景。"
                  : "A batch either commits as a whole or leaves the scene unchanged.",
            },
            {
              icon: <Code2 size={19} />,
              title: locale === "zh" ? "可检查产物" : "Inspectable artifacts",
              body:
                locale === "zh"
                  ? "场景、轨迹、审计和画面可被版本化与复核。"
                  : "Scenes, traces, audits, and captures can be versioned and reviewed.",
            },
          ].map((item, index) => (
            <article className="research-capability" key={item.title}>
              <span className="research-capability-index">0{index + 1}</span>
              <div className="research-capability-icon">{item.icon}</div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="research-evaluation research-section" id="protocol">
        <div className="research-section-heading">
          <p>{copy.evaluationLabel}</p>
          <span>03 / 05</span>
        </div>
        <div className="research-evaluation-intro">
          <h2>{copy.evaluationTitle}</h2>
          <p>{copy.evaluationBody}</p>
        </div>
        <div className="research-task-table" role="table" aria-label={copy.evaluationLabel}>
          <div className="research-task-head" role="row">
            <span role="columnheader">{locale === "zh" ? "任务层" : "Task layer"}</span>
            <span role="columnheader">{locale === "zh" ? "可检查对象" : "Inspectable unit"}</span>
            <span role="columnheader">{locale === "zh" ? "证据" : "Evidence"}</span>
          </div>
          {researchSections.map((item) => (
            <div className="research-task-row" key={item.id} role="row">
              <span className="research-task-index" role="cell">
                {item.index}
              </span>
              <div role="cell">
                <h3>{locale === "zh" ? item.zh : item.en}</h3>
                <p>{locale === "zh" ? item.description.zh : item.description.en}</p>
              </div>
              <span className="research-evidence" role="cell">
                {locale === "zh" ? item.evidence.zh : item.evidence.en}
              </span>
            </div>
          ))}
        </div>
        <ProtocolFlow locale={locale} />
      </section>

      <section className="research-reproduce research-section">
        <div className="research-section-heading">
          <p>{copy.reproducibilityLabel}</p>
          <span>04 / 05</span>
        </div>
        <div className="research-reproduce-content">
          <div>
            <h2>{copy.reproducibilityTitle}</h2>
            <p>{copy.reproducibilityBody}</p>
            <a
              href="/research/docs"
              onClick={(event) => {
                event.preventDefault();
                onNavigate("docs");
              }}
              className="research-text-link"
            >
              {copy.docsCta}
              <ArrowUpRight size={16} />
            </a>
          </div>
          <pre className="research-command">
            <code>
              <span>$</span> npm install{`\n`}
              <span>$</span> npm run dev{`\n`}
              <span>$</span> npm run test{`\n`}
              <span>$</span> npm run build
            </code>
          </pre>
        </div>
      </section>

      <section className="research-notes research-section">
        <div className="research-section-heading">
          <p>{copy.limitationsLabel}</p>
          <span>05 / 05</span>
        </div>
        <div className="research-notes-grid">
          <p>{copy.limitations}</p>
          <div>
            <h3>{copy.sourceLabel}</h3>
            <p>{copy.source}</p>
            <a href="/engineering/third_party_notices/" className="research-text-link">
              {copy.viewNotice}
              <ArrowUpRight size={16} />
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

function CopyCommand({ command, locale }: { command: string; locale: ResearchLocale }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Browsers without clipboard permission still expose the command as selectable text.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="research-doc-command">
      <code>{command}</code>
      <button
        onClick={() => {
          void copy();
        }}
        type="button"
      >
        {copied ? <Check size={14} /> : <Clipboard size={14} />}
        {copied ? (locale === "zh" ? "已复制" : "Copied") : locale === "zh" ? "复制" : "Copy"}
      </button>
    </div>
  );
}

function DocumentationPage({
  locale,
  onNavigate,
}: {
  locale: ResearchLocale;
  onNavigate: (page: ResearchPage) => void;
}) {
  const [activeSection, setActiveSection] = useState<(typeof documentationSections)[number]["id"]>(
    documentationSections[0].id,
  );
  const copy = researchCopy(portalCopy, locale);
  const active = useMemo(
    () => documentationSections.find((section) => section.id === activeSection) ?? documentationSections[0],
    [activeSection],
  );
  const isChinese = locale === "zh";

  return (
    <main className="research-docs">
      <aside className="research-docs-aside">
        <button className="research-back-link" onClick={() => onNavigate("home")} type="button">
          <ArrowDownRight size={15} />
          {isChinese ? "研究主页" : "Research home"}
        </button>
        <p>{isChinese ? "研究文档" : "Research documentation"}</p>
        <nav aria-label={isChinese ? "文档章节" : "Documentation sections"}>
          {documentationSections.map((section, index) => (
            <button
              aria-current={activeSection === section.id ? "page" : undefined}
              className={activeSection === section.id ? "is-active" : ""}
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              type="button"
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {isChinese ? section.label.zh : section.label.en}
            </button>
          ))}
        </nav>
        <a href="/" className="research-docs-studio-link">
          <span>{copy.openStudio}</span>
          <ArrowUpRight size={15} />
        </a>
      </aside>
      <article className="research-docs-content">
        <p className="research-kicker">
          <span />
          {isChinese ? "研究文档 / 工作台" : "RESEARCH DOCUMENTATION / WORKBENCH"}
        </p>
        <h1>{isChinese ? active.title.zh : active.title.en}</h1>
        <p className="research-docs-lead">{isChinese ? active.body.zh : active.body.en}</p>

        {active.id === "documentation-overview" ? (
          <div className="research-docs-prose">
            <h2>{isChinese ? "范围" : "Scope"}</h2>
            <p>
              {isChinese
                ? "Director 的研究接口围绕可验证的创作过程展开：场景状态、相机方案、时间线和 Agent 操作均应能以机器可读的方式被检查。"
                : "Director’s research interface centers on verifiable authorship: scene state, camera plans, timelines, and Agent operations should all be inspectable in a machine-readable form."}
            </p>
            <h2>{isChinese ? "推荐的证据包" : "Recommended evidence bundle"}</h2>
            <ul>
              <li>{isChinese ? "带版本号的项目或场景 JSON" : "Versioned project or scene JSON"}</li>
              <li>
                {isChinese
                  ? "输入、操作和校验结果的执行轨迹"
                  : "Execution trace containing inputs, operations, and validation results"}
              </li>
              <li>{isChinese ? "相机画面或导出的项目产物" : "Camera capture or exported project artifact"}</li>
            </ul>
          </div>
        ) : null}

        {active.id === "documentation-reproduce" ? (
          <div className="research-docs-prose">
            <h2>{isChinese ? "最小复现步骤" : "Minimum reproduction"}</h2>
            <CopyCommand command="npm install" locale={locale} />
            <CopyCommand command="npm run dev" locale={locale} />
            <CopyCommand command="npm run test && npm run build" locale={locale} />
            <p>
              {isChinese
                ? "开发服务会提供浏览器工作台与本地 Agent 网关。记录 Node.js 版本、依赖锁文件哈希、命令输出和浏览器版本，以便比较两个运行结果。"
                : "The development service exposes the browser workbench and local Agent gateway. Record the Node.js version, lockfile hash, command output, and browser version when comparing two runs."}
            </p>
          </div>
        ) : null}

        {active.id === "documentation-protocol" ? <ProtocolFlow locale={locale} /> : null}

        {active.id === "documentation-interfaces" ? (
          <div className="research-docs-prose">
            <h2>{isChinese ? "控制面" : "Control surfaces"}</h2>
            <dl className="research-interface-list">
              <div>
                <dt>Browser studio</dt>
                <dd>{isChinese ? "直接编辑、可视化检查和导出。" : "Direct editing, visual inspection, and export."}</dd>
              </div>
              <div>
                <dt>MCP</dt>
                <dd>
                  {isChinese
                    ? "供 Codex、Claude 等兼容客户端调用的结构化工具。"
                    : "Structured tools for Codex, Claude, and other compatible clients."}
                </dd>
              </div>
              <div>
                <dt>HTTP / CLI</dt>
                <dd>
                  {isChinese
                    ? "便于自动化、批处理与可记录的实验脚本。"
                    : "Automation, batch work, and recordable experiment scripts."}
                </dd>
              </div>
            </dl>
            <p>
              {isChinese
                ? "对于任何控制面，输入都应经过相同的数据校验，并返回可检查的错误或结果包。"
                : "For every control surface, inputs should pass the same data validation and return inspectable errors or result envelopes."}
            </p>
          </div>
        ) : null}

        {active.id === "documentation-limits" ? (
          <div className="research-docs-prose research-limit-prose">
            <h2>{isChinese ? "发布门槛" : "Release gate"}</h2>
            <p>
              {isChinese
                ? "在发布任何可比较的性能数据前，必须冻结任务定义、输入资产版本、系统提示或工具版本、评测预算、成功条件和报告模板。"
                : "Before publishing any comparable performance result, freeze the task definition, input asset version, system prompt or tool version, evaluation budget, success criteria, and reporting template."}
            </p>
            <h2>{isChinese ? "当前状态" : "Current status"}</h2>
            <p>
              {isChinese
                ? "当前仓库提供可复现工作台与协议骨架。它尚不是已发布的学术排行榜；因此页面有意不显示任何模型名次或百分比。"
                : "This repository currently provides a reproducible workbench and protocol skeleton. It is not yet a published academic leaderboard, so this site intentionally displays no model ranks or percentages."}
            </p>
          </div>
        ) : null}

        <footer className="research-docs-footer">
          <span>{copy.footer}</span>
        </footer>
      </article>
    </main>
  );
}

/**
 * Research portal root component.
 *
 * A standalone SPA surface (served at `/research`) that presents Director's
 * architecture, protocol, and evaluation framework. It shares the locale
 * contract with the main studio app via localStorage but is otherwise
 * fully decoupled.
 */
export default function ResearchPortal() {
  const [locale, setLocaleState] = useState<ResearchLocale>(readInitialResearchLocale);
  const { page, navigate } = useResearchPage();

  const setLocale = (nextLocale: ResearchLocale) => {
    setLocaleState(nextLocale);
    persistResearchLocale(nextLocale);
  };

  return (
    <div className="research-portal">
      <PortalHeader locale={locale} onLocaleChange={setLocale} page={page} onNavigate={navigate} />
      {page === "docs" ? (
        <DocumentationPage locale={locale} onNavigate={navigate} />
      ) : (
        <HomePage locale={locale} onNavigate={navigate} />
      )}
      {page === "home" ? (
        <footer className="research-footer">
          <span>
            <ResearchMark />
            {researchCopy(portalCopy, locale).footer}
          </span>
        </footer>
      ) : null}
    </div>
  );
}
