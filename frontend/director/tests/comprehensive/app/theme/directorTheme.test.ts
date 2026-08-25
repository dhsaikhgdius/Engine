import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyDirectorTheme,
  DIRECTOR_THEME_STORAGE_KEY,
  initializeDirectorTheme,
  resolveInitialDirectorTheme,
  subscribeToDirectorTheme,
} from "../../../../src/comprehensive/app/theme/directorTheme";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty("color-scheme");
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses the saved preference before the operating-system preference", () => {
  window.localStorage.setItem(DIRECTOR_THEME_STORAGE_KEY, "light");

  expect(resolveInitialDirectorTheme()).toBe("light");
  expect(initializeDirectorTheme()).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

it("follows the operating-system color scheme on first use", () => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

  expect(resolveInitialDirectorTheme()).toBe("light");
});

it("persists explicit changes and publishes them to mounted controls", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeToDirectorTheme(listener);

  applyDirectorTheme("light", { persist: true });

  expect(window.localStorage.getItem(DIRECTOR_THEME_STORAGE_KEY)).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);

  unsubscribe();
});
