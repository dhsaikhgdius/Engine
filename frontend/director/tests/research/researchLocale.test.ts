import { afterEach, describe, expect, it } from "vitest";
import {
  APP_LOCALE_STORAGE_KEY,
  RESEARCH_LOCALE_STORAGE_KEY,
  appLocaleToResearchLocale,
  detectNavigatorResearchLocale,
  persistResearchLocale,
  readInitialResearchLocale,
  researchLocaleToAppLocale,
} from "../../src/research/researchLocale";

describe("researchLocale mapping", () => {
  it("keeps the storage key contract with the studio app", () => {
    expect(APP_LOCALE_STORAGE_KEY).toBe("director.ui.locale");
    expect(RESEARCH_LOCALE_STORAGE_KEY).toBe("director.research.locale");
  });

  it("maps studio locales to portal locales", () => {
    expect(appLocaleToResearchLocale("zh-CN", "en")).toBe("zh");
    expect(appLocaleToResearchLocale("en-US", "zh")).toBe("en");
  });

  it("falls back to the given default for invalid studio locales", () => {
    expect(appLocaleToResearchLocale("fr-FR", "zh")).toBe("zh");
    expect(appLocaleToResearchLocale(null, "en")).toBe("en");
    expect(appLocaleToResearchLocale("", "zh")).toBe("zh");
    expect(appLocaleToResearchLocale("zh", "en")).toBe("en");
  });

  it("maps portal locales to studio locales", () => {
    expect(researchLocaleToAppLocale("zh", "en-US")).toBe("zh-CN");
    expect(researchLocaleToAppLocale("en", "zh-CN")).toBe("en-US");
  });

  it("falls back to the given default for invalid portal locales", () => {
    expect(researchLocaleToAppLocale("fr", "zh-CN")).toBe("zh-CN");
    expect(researchLocaleToAppLocale(undefined, "en-US")).toBe("en-US");
    expect(researchLocaleToAppLocale("zh-CN", "en-US")).toBe("en-US");
  });

  it("detects the portal locale from a browser language", () => {
    expect(detectNavigatorResearchLocale("zh-CN")).toBe("zh");
    expect(detectNavigatorResearchLocale("ZH-TW")).toBe("zh");
    expect(detectNavigatorResearchLocale("en-GB")).toBe("en");
    expect(detectNavigatorResearchLocale("fr-FR")).toBe("en");
    expect(detectNavigatorResearchLocale("")).toBe("en");
  });
});

describe("researchLocale storage", () => {
  afterEach(() => {
    window.localStorage.clear();
    Reflect.deleteProperty(window.navigator, "language");
  });

  it("prefers the studio locale key on initialization", () => {
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, "en-US");
    window.localStorage.setItem(RESEARCH_LOCALE_STORAGE_KEY, "zh");

    expect(readInitialResearchLocale()).toBe("en");
  });

  it("uses the portal key when the studio key is missing or invalid", () => {
    window.localStorage.setItem(RESEARCH_LOCALE_STORAGE_KEY, "zh");
    expect(readInitialResearchLocale()).toBe("zh");

    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, "not-a-locale");
    expect(readInitialResearchLocale()).toBe("zh");
  });

  it("falls back to the browser language when nothing is stored", () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "zh-CN" });
    expect(readInitialResearchLocale()).toBe("zh");

    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-US" });
    expect(readInitialResearchLocale()).toBe("en");
  });

  it("persists both the portal key and the studio key", () => {
    persistResearchLocale("zh");
    expect(window.localStorage.getItem(RESEARCH_LOCALE_STORAGE_KEY)).toBe("zh");
    expect(window.localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("zh-CN");

    persistResearchLocale("en");
    expect(window.localStorage.getItem(RESEARCH_LOCALE_STORAGE_KEY)).toBe("en");
    expect(window.localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("en-US");
  });
});
