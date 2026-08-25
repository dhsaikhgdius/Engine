/**
 * Director home page theme toggle.
 *
 * @module docs/site/directorHomeTheme
 */

export type DirectorHomeTheme = "light" | "dark";

const STORAGE_KEY = "director-home-theme";
const PAGE_THEME_ATTR = "data-dh-page-theme";
const THEME_EVENT = "director-home-theme-change";
const THEME_BUTTON_SELECTOR = "button[data-director-home-theme], button[data-director-home-theme-mobile]";

const isZhHome = () => document.querySelector<HTMLElement>("[data-director-home]")?.dataset.locale === "zh";

export const getDirectorHomeTheme = (): DirectorHomeTheme => {
  const attr = document.documentElement.getAttribute(PAGE_THEME_ATTR);
  if (attr === "light" || attr === "dark") return attr;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Ignore storage failures in restricted contexts.
  }

  return "dark";
};

const syncThemeControls = (theme: DirectorHomeTheme) => {
  const light = theme === "light";
  const zh = isZhHome();
  const label = light
    ? zh
      ? "切换到深色背景"
      : "Switch to a dark background"
    : zh
      ? "切换到浅色背景"
      : "Switch to a light background";
  const mobileLabel = light ? (zh ? "深色模式" : "Dark mode") : zh ? "浅色模式" : "Light mode";

  document.querySelectorAll<HTMLButtonElement>("button[data-director-home-theme]").forEach((toggle) => {
    toggle.setAttribute("aria-pressed", light ? "true" : "false");
    toggle.setAttribute("aria-label", label);
    toggle.querySelector<SVGElement>("[data-director-home-theme-sun]")?.toggleAttribute("hidden", light);
    toggle.querySelector<SVGElement>("[data-director-home-theme-moon]")?.toggleAttribute("hidden", !light);
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-director-home-theme-mobile]").forEach((toggle) => {
    toggle.setAttribute("aria-pressed", light ? "true" : "false");
    toggle.setAttribute("aria-label", label);
    toggle.textContent = mobileLabel;
  });
};

export const applyDirectorHomeTheme = (theme: DirectorHomeTheme) => {
  document.documentElement.setAttribute(PAGE_THEME_ATTR, theme);

  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures in restricted contexts.
  }

  syncThemeControls(theme);
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
};

export const toggleProductDemoTheme = () => {
  const demo = document.querySelector<HTMLElement>("[data-director-product-demo]");
  if (!demo) return false;

  const light = !demo.classList.contains("is-light");
  demo.classList.toggle("is-light", light);

  const zh = isZhHome();
  const label = demo.querySelector<HTMLElement>("[data-demo-theme-label]");
  const icon = demo.querySelector<SVGUseElement>("[data-demo-theme] use");
  if (label) label.textContent = light ? (zh ? "深色" : "Dark") : zh ? "浅色" : "Light";
  if (icon) icon.setAttribute("href", light ? "#dh-icon-moon" : "#dh-icon-sun");

  const button = demo.querySelector<HTMLButtonElement>("[data-demo-theme]");
  button?.setAttribute(
    "aria-label",
    zh ? `切换演示窗到${light ? "深色" : "浅色"}模式` : `Switch the demo window to ${light ? "dark" : "light"} mode`,
  );

  return light;
};

const bindThemeButtons = () => {
  document.querySelectorAll<HTMLButtonElement>(THEME_BUTTON_SELECTOR).forEach((button) => {
    if (button.dataset.themeClickBound === "true") return;
    button.dataset.themeClickBound = "true";

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const current = getDirectorHomeTheme();
      applyDirectorHomeTheme(current === "light" ? "dark" : "light");
    });
  });
};

export const mountDirectorHomeTheme = () => {
  applyDirectorHomeTheme(getDirectorHomeTheme());
  bindThemeButtons();
};

export const isDirectorHomeLightTheme = () => getDirectorHomeTheme() === "light";

export const onDirectorHomeThemeChange = (listener: (theme: DirectorHomeTheme) => void) => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ theme: DirectorHomeTheme }>).detail;
    if (detail?.theme) listener(detail.theme);
  };
  window.addEventListener(THEME_EVENT, handler);
  return () => window.removeEventListener(THEME_EVENT, handler);
};

declare global {
  interface Window {
    __directorHomeTheme?: {
      apply: (theme: DirectorHomeTheme) => void;
      get: () => DirectorHomeTheme;
      bindButtons: () => void;
    };
  }
}

if (typeof window !== "undefined") {
  window.__directorHomeTheme = {
    apply: applyDirectorHomeTheme,
    get: getDirectorHomeTheme,
    bindButtons: bindThemeButtons,
  };
}
