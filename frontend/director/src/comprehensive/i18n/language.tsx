import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import translations from "./en-US.json";
import phraseRuleConfigs from "./phraseRules.json";

/** Supported UI locales. Source-authored in Simplified Chinese. */
export type Locale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "director.ui.locale";

/**
 * The editor is intentionally source-authored in Chinese. Keeping the source
 * phrase as the dictionary key lets newly added controls remain readable in
 * the default locale while the English surface is expanded incrementally.
 */
const TRANSLATIONS: Record<string, string> = translations;

type PhraseRuleHandler = (match: RegExpMatchArray) => string;
const PHRASE_RULE_HANDLERS = {
  performance: (match) => `Performance ${translateCapturedPhrase(match[1] ?? "")}`,
  collapseGroup: (match) => `Collapse ${translateCapturedPhrase(match[1] ?? "")} group`,
  expandGroup: (match) => `Expand ${translateCapturedPhrase(match[1] ?? "")} group`,
  axisView: (match) => `Switch to ${match[1]} ${match[2] === "正向" ? "positive" : "negative"} view`,
  characterTransform: (match) =>
    `Character ${match[1] === "位置" ? "position" : match[1] === "旋转" ? "rotation" : "scale"} ${match[2] ?? ""}`,
  cameraTransform: (match) => `Camera ${match[1] === "位置" ? "position" : "rotation"} ${match[2] ?? ""}`,
  deterministicPackage: (match) =>
    `${translateCapturedPhrase(match[1] ?? "Export")} exported as a deterministic PNG frame package (${match[2] ?? "0"} frames${match[3] ? ` · SHA ${match[3]}` : ""})`,
  deterministicTimestamp: (match) =>
    `${translateCapturedPhrase(match[1] ?? "Export")} exported with deterministic timestamps (F${match[2]}–F${match[3]})`,
  savedMacro: (match) => `Saved macro “${translateCapturedPhrase(match[1] ?? "")}”`,
  ranMacro: (match) => `Ran macro “${translateCapturedPhrase(match[1] ?? "")}”; undo is available`,
  deleteMacro: (match) => `Delete macro “${translateCapturedPhrase(match[1] ?? "")}”?`,
  deletedMacro: (match) => `Deleted macro “${translateCapturedPhrase(match[1] ?? "")}”`,
  sessionStatus: (match) => `Session status: ${translateCapturedPhrase(match[1] ?? "")}`,
  savedItem: (match) => `Saved ${translateCapturedPhrase(match[1] ?? "")}`,
  compositeSlider: (match) =>
    `${translateCapturedPhrase(match[1] ?? "")} · ${translateCapturedPhrase(match[2] ?? "")} slider`,
  composite: (match) => `${translateCapturedPhrase(match[1] ?? "")} · ${translateCapturedPhrase(match[2] ?? "")}`,
  agentToolActivity: (match) => {
    const tense = match[1] ?? "";
    const verb = match[2] ?? "";
    const phrases: Record<string, { run: string; done: string; fail: string }> = {
      观察场景: { run: "Observing the scene", done: "Observed the scene", fail: "Could not observe the scene" },
      读取目录: { run: "Reading the catalog", done: "Read the catalog", fail: "Could not read the catalog" },
      读取说明: {
        run: "Reading the description",
        done: "Read the description",
        fail: "Could not read the description",
      },
      读取能力: { run: "Reading capabilities", done: "Read capabilities", fail: "Could not read capabilities" },
      检查物体: { run: "Inspecting objects", done: "Inspected objects", fail: "Could not inspect objects" },
      保存快照: { run: "Saving a snapshot", done: "Saved a snapshot", fail: "Could not save a snapshot" },
      修改场景: { run: "Authoring the scene", done: "Authored the scene", fail: "Could not author the scene" },
      添加物体: { run: "Adding objects", done: "Added objects", fail: "Could not add objects" },
      删除物体: { run: "Deleting objects", done: "Deleted objects", fail: "Could not delete objects" },
      修改物体: { run: "Authoring objects", done: "Authored objects", fail: "Could not author objects" },
      截取画面: { run: "Capturing a frame", done: "Captured a frame", fail: "Could not capture a frame" },
      导出镜头包: {
        run: "Exporting a shot package",
        done: "Exported a shot package",
        fail: "Could not export a shot package",
      },
      交付成片: { run: "Delivering the film", done: "Delivered the film", fail: "Could not deliver the film" },
      选择物体: { run: "Selecting objects", done: "Selected objects", fail: "Could not select objects" },
      调整视口: { run: "Adjusting the viewport", done: "Adjusted the viewport", fail: "Could not adjust the viewport" },
      控制播放: { run: "Controlling playback", done: "Controlled playback", fail: "Could not control playback" },
      撤销: { run: "Undoing", done: "Undid the last change", fail: "Could not undo" },
      检查场景: { run: "Auditing the scene", done: "Audited the scene", fail: "Could not audit the scene" },
      对比修订: { run: "Diffing revisions", done: "Diffed revisions", fail: "Could not diff revisions" },
      修正场景: { run: "Correcting the scene", done: "Corrected the scene", fail: "Could not correct the scene" },
      追踪操作: { run: "Tracing the operation", done: "Traced the operation", fail: "Could not trace the operation" },
      提交生成: { run: "Submitting generation", done: "Submitted generation", fail: "Could not submit generation" },
      提交转录: {
        run: "Submitting transcription",
        done: "Submitted transcription",
        fail: "Could not submit transcription",
      },
      "生成 3D": { run: "Generating 3D", done: "Generated 3D", fail: "Could not generate 3D" },
      重建采集: {
        run: "Reconstructing the capture",
        done: "Reconstructed the capture",
        fail: "Could not reconstruct the capture",
      },
      导出分镜: {
        run: "Exporting the storyboard",
        done: "Exported the storyboard",
        fail: "Could not export the storyboard",
      },
      执行宏: { run: "Running a macro", done: "Ran a macro", fail: "Could not run a macro" },
      更新记忆: { run: "Updating memory", done: "Updated memory", fail: "Could not update memory" },
      写入补丁: { run: "Applying a patch", done: "Applied a patch", fail: "Could not apply a patch" },
      替换项目: { run: "Replacing the project", done: "Replaced the project", fail: "Could not replace the project" },
      写入镜头: { run: "Writing shot IR", done: "Wrote shot IR", fail: "Could not write shot IR" },
      执行制作指令: {
        run: "Running a production command",
        done: "Ran a production command",
        fail: "Could not run a production command",
      },
      执行画布操作: {
        run: "Running a canvas operation",
        done: "Ran a canvas operation",
        fail: "Could not run a canvas operation",
      },
      预览画布: { run: "Previewing the canvas", done: "Previewed the canvas", fail: "Could not preview the canvas" },
      调用工作台: { run: "Calling the workbench", done: "Called the workbench", fail: "Could not call the workbench" },
    };
    const entry = phrases[verb];
    if (!entry) return match[0] ?? "";
    if (tense === "正在") return entry.run;
    if (tense === "未能") return entry.fail;
    return entry.done;
  },
  agentToolActivityCount: (match) => {
    const tense = match[1] ?? "";
    const verb = match[2] ?? "";
    const count = match[3] ?? "0";
    const phrases: Record<string, { run: string; done: string; fail: string }> = {
      修改: {
        run: `Authoring ${count} objects`,
        done: `Authored ${count} objects`,
        fail: `Could not author ${count} objects`,
      },
      添加: {
        run: `Adding ${count} objects`,
        done: `Added ${count} objects`,
        fail: `Could not add ${count} objects`,
      },
      删除: {
        run: `Deleting ${count} objects`,
        done: `Deleted ${count} objects`,
        fail: `Could not delete ${count} objects`,
      },
      检查: {
        run: `Inspecting ${count} objects`,
        done: `Inspected ${count} objects`,
        fail: `Could not inspect ${count} objects`,
      },
      选择: {
        run: `Selecting ${count} objects`,
        done: `Selected ${count} objects`,
        fail: `Could not select ${count} objects`,
      },
    };
    const entry = phrases[verb];
    if (!entry) return match[0] ?? "";
    if (tense === "正在") return entry.run;
    if (tense === "未能") return entry.fail;
    return entry.done;
  },
} satisfies Record<string, PhraseRuleHandler>;

type PhraseRuleConfig = { pattern: string; flags?: string; replacement?: string; handler?: string };
function applyTranslatedReplacement(replacement: string, match: RegExpMatchArray) {
  return replacement.replace(/\$(\d+)/g, (token, index) => {
    const group = match[Number(index)];
    if (group == null) return token;
    return translateCapturedPhrase(group);
  });
}

const PHRASE_RULES: Array<[RegExp, PhraseRuleHandler]> = (phraseRuleConfigs as PhraseRuleConfig[]).map((config) => {
  const pattern = new RegExp(config.pattern, config.flags);
  const handler = config.handler
    ? PHRASE_RULE_HANDLERS[config.handler as keyof typeof PHRASE_RULE_HANDLERS]
    : (match: RegExpMatchArray) => applyTranslatedReplacement(config.replacement ?? "", match);
  if (!handler) throw new Error(`Unknown translation phrase handler: ${config.handler}`);
  return [pattern, handler];
});

function translateCapturedPhrase(value: string) {
  if (!value || !/[\u3400-\u9fff]/.test(value)) return value;
  return translateBody(value, "en-US");
}

function translateBody(value: string, locale: Locale) {
  if (locale === "zh-CN") return value;
  const direct = TRANSLATIONS[value];
  if (direct) return direct;
  for (const [pattern, render] of PHRASE_RULES) {
    const match = value.match(pattern);
    if (match) return render(match);
  }
  return value;
}

/**
 * Translates a UI string from the source language (zh-CN) to the target locale.
 *
 * Preserves leading and trailing whitespace. Returns the input unchanged
 * when the locale is zh-CN or the value is empty.
 *
 * @param value - The source-language string to translate.
 * @param locale - Target locale.
 * @returns The translated string (or the original when no translation exists).
 */
export function translateString(value: string, locale: Locale) {
  if (!value || locale === "zh-CN") return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const body = value.slice(leading.length, value.length - trailing.length || undefined);
  return `${leading}${translateBody(body, locale)}${trailing}`;
}

type NodeTranslationState = { source: string; rendered: string };

const textState = new WeakMap<Text, NodeTranslationState>();
const attributeState = new WeakMap<Element, Map<string, NodeTranslationState>>();
const TRANSLATABLE_ATTRIBUTES = ["aria-label", "aria-description", "aria-valuetext", "title", "placeholder", "alt"];
const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE"]);
const USER_CONTENT_SELECTOR = "[data-i18n-user-content]";
const PRESERVE_ATTRIBUTES = "data-i18n-preserve-attributes";

function isInsideUserContent(element: Element) {
  return Boolean(element.closest(USER_CONTENT_SELECTOR));
}

function translateDocument(root: ParentNode, locale: Locale) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const parent = node.parentElement;
    if (parent && !IGNORED_TAGS.has(parent.tagName) && !isInsideUserContent(parent)) {
      const current = node.nodeValue ?? "";
      const state = textState.get(node);
      const source = state && current === state.rendered ? state.source : current;
      const rendered = translateString(source, locale);
      textState.set(node, { source, rendered });
      if (current !== rendered) node.nodeValue = rendered;
    }
    node = walker.nextNode() as Text | null;
  }

  const elements =
    root instanceof Element
      ? [root, ...Array.from(root.querySelectorAll("*"))]
      : Array.from(root.querySelectorAll("*"));
  for (const element of elements) {
    if (IGNORED_TAGS.has(element.tagName) || isInsideUserContent(element) || element.hasAttribute(PRESERVE_ATTRIBUTES))
      continue;
    let states = attributeState.get(element);
    if (!states) {
      states = new Map();
      attributeState.set(element, states);
    }
    for (const name of TRANSLATABLE_ATTRIBUTES) {
      const current = element.getAttribute(name);
      if (current == null) continue;
      const previous = states.get(name);
      const source = previous && current === previous.rendered ? previous.source : current;
      const rendered = translateString(source, locale);
      states.set(name, { source, rendered });
      if (current !== rendered) element.setAttribute(name, rendered);
    }
  }
}

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en-US" || stored === "zh-CN") return stored;
  } catch {
    // Storage can be unavailable in an embedded or privacy-restricted frame.
  }
  return "zh-CN";
}

type LanguageContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (source: string) => string;
};

const LanguageContext = createContext<LanguageContextValue>({
  locale: "zh-CN",
  setLocale: () => undefined,
  t: (source) => source,
});

/**
 * Provides locale state and a translation function to the React tree.
 *
 * On mount, reads the persisted locale from localStorage. On locale change,
 * persists the new choice, sets `document.documentElement.lang`, and walks
 * the DOM to translate all visible text nodes and translatable attributes.
 * A MutationObserver re-translates newly inserted content on the next
 * animation frame.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readInitialLocale());
  const documentTranslatedRef = useRef(false);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch {
      // Keep the current session usable when persistence is blocked.
    }
  }, []);

  const t = useCallback((source: string) => translateString(source, locale), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
    // In the zh-CN source locale the walk is only needed to restore source
    // text after leaving en-US; a fresh zh-CN document never needs it.
    if (locale === "zh-CN" && !documentTranslatedRef.current) return;
    documentTranslatedRef.current = locale !== "zh-CN";
    translateDocument(document, locale);
  }, [locale]);

  useEffect(() => {
    if (locale === "zh-CN") return;
    if (typeof MutationObserver === "undefined") return;
    let scheduled = false;
    let scheduledFrame: number | ReturnType<typeof setTimeout> | null = null;
    const cancelScheduledFrame = () => {
      if (scheduledFrame === null) return;
      if (typeof scheduledFrame === "number") window.cancelAnimationFrame(scheduledFrame);
      else window.clearTimeout(scheduledFrame);
      scheduledFrame = null;
    };
    const scheduleFrame = window.requestAnimationFrame
      ? (callback: FrameRequestCallback) => window.requestAnimationFrame(callback)
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0);
    const apply = () => {
      scheduled = false;
      scheduledFrame = null;
      translateDocument(document, locale);
    };
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      scheduledFrame = scheduleFrame(apply);
    });
    observer.observe(document.getElementById("root") ?? document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
    return () => {
      observer.disconnect();
      cancelScheduledFrame();
    };
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/**
 * React hook that returns the current locale, a setter, and a translation function.
 *
 * @returns `{ locale, setLocale, t }` where `t(source)` translates a
 *          source-language string to the current locale.
 */
export function useLanguage() {
  return useContext(LanguageContext);
}
