import type { ResearchLocale } from "./researchContent";

/**
 * Locale persisted by the main studio app (comprehensive/i18n/language.tsx).
 * The key is referenced as a plain string constant on purpose: the research
 * portal must stay decoupled from the studio i18n runtime, they only share
 * the localStorage contract.
 */
export type AppLocale = "zh-CN" | "en-US";

/** Shared localStorage key used by the main studio i18n system. */
export const APP_LOCALE_STORAGE_KEY = "director.ui.locale";
/** localStorage key owned by the research portal. */
export const RESEARCH_LOCALE_STORAGE_KEY = "director.research.locale";

/**
 * Maps the studio's four-letter locale tag to the research portal's two-letter form.
 *
 * @param value - The raw value read from storage.
 * @param fallback - Locale to return when the value is unrecognized.
 * @returns The corresponding research locale.
 */
export function appLocaleToResearchLocale(value: unknown, fallback: ResearchLocale): ResearchLocale {
  if (value === "zh-CN") return "zh";
  if (value === "en-US") return "en";
  return fallback;
}

/**
 * Maps the research portal's two-letter locale back to the studio's four-letter form.
 *
 * @param value - The raw value read from storage.
 * @param fallback - Locale to return when the value is unrecognized.
 * @returns The corresponding app locale.
 */
export function researchLocaleToAppLocale(value: unknown, fallback: AppLocale): AppLocale {
  if (value === "zh") return "zh-CN";
  if (value === "en") return "en-US";
  return fallback;
}

/**
 * Detects the research locale from the browser's `navigator.language`.
 *
 * @param language - Optional override for the navigator language string.
 * @returns `"zh"` for Chinese-language browsers, `"en"` otherwise.
 */
export function detectNavigatorResearchLocale(language?: string): ResearchLocale {
  const value = language ?? (typeof navigator === "undefined" ? "" : navigator.language) ?? "";
  return value.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * Initialization priority: the studio locale wins so a language switch made in
 * the main app carries over, then the portal's own persisted key, and finally
 * the browser language heuristic the portal has always used.
 */
export function readInitialResearchLocale(): ResearchLocale {
  try {
    const appLocale = window.localStorage.getItem(APP_LOCALE_STORAGE_KEY);
    if (appLocale === "zh-CN" || appLocale === "en-US") {
      return appLocaleToResearchLocale(appLocale, "zh");
    }
    const ownLocale = window.localStorage.getItem(RESEARCH_LOCALE_STORAGE_KEY);
    if (ownLocale === "zh" || ownLocale === "en") return ownLocale;
  } catch {
    // Storage can be unavailable in an embedded or privacy-restricted frame.
  }
  return detectNavigatorResearchLocale();
}

/**
 * Persist to both keys: the portal key keeps the portal self-contained, and
 * the studio key makes the choice follow the user back into the main app
 * (portal and studio are mutually exclusive full-page loads, so writing at
 * switch time is the synchronization point).
 */
export function persistResearchLocale(locale: ResearchLocale): void {
  try {
    window.localStorage.setItem(RESEARCH_LOCALE_STORAGE_KEY, locale);
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, researchLocaleToAppLocale(locale, "zh-CN"));
  } catch {
    // Keep the in-memory locale usable when persistence is blocked.
  }
}
