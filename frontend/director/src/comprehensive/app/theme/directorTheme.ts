/** The two supported color-scheme themes. */
export type DirectorTheme = "dark" | "light";

/** localStorage key used for persisting the user's theme preference. */
export const DIRECTOR_THEME_STORAGE_KEY = "director.ui.theme.v1";

const DIRECTOR_THEME_CHANGE_EVENT = "director:theme-change";

function normalizeDirectorTheme(value: unknown): DirectorTheme | null {
  return value === "dark" || value === "light" ? value : null;
}

function readQueryTheme(): DirectorTheme | null {
  try {
    return normalizeDirectorTheme(new URLSearchParams(window.location.search).get("theme"));
  } catch {
    return null;
  }
}

function readStoredTheme(): DirectorTheme | null {
  try {
    return normalizeDirectorTheme(window.localStorage.getItem(DIRECTOR_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function readSystemTheme(): DirectorTheme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function updateThemeColor(theme: DirectorTheme) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f4f5f7" : "#111419";
}

/**
 * Resolves the initial theme on first load, before any explicit user choice.
 * Priority: URL query param > localStorage > system preference.
 *
 * @returns The resolved theme.
 */
export function resolveInitialDirectorTheme(): DirectorTheme {
  return readQueryTheme() ?? readStoredTheme() ?? readSystemTheme();
}

/**
 * Reads the current theme from the DOM, falling back to the initial resolution
 * when no theme has been applied yet.
 *
 * @returns The current theme.
 */
export function getDirectorTheme(): DirectorTheme {
  return normalizeDirectorTheme(document.documentElement.dataset.theme) ?? resolveInitialDirectorTheme();
}

/**
 * Applies a theme to the DOM: sets `data-theme`, toggles the `dark` class,
 * updates `color-scheme`, and the `<meta name="theme-color">` value.
 *
 * @param theme - The theme to apply.
 * @param options.persist - When true, writes the choice to localStorage.
 * @param options.notify - When true, dispatches a `director:theme-change` custom event
 *   so other parts of the app can react.
 * @returns The applied theme.
 */
export function applyDirectorTheme(theme: DirectorTheme, options: { persist?: boolean; notify?: boolean } = {}) {
  const { persist = false, notify = true } = options;
  const previousTheme = normalizeDirectorTheme(document.documentElement.dataset.theme);

  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  updateThemeColor(theme);

  if (persist) {
    try {
      window.localStorage.setItem(DIRECTOR_THEME_STORAGE_KEY, theme);
    } catch {
      // Theme switching still works when storage is blocked by the host.
    }
  }

  if (notify && previousTheme !== theme) {
    window.dispatchEvent(new CustomEvent<DirectorTheme>(DIRECTOR_THEME_CHANGE_EVENT, { detail: theme }));
  }

  return theme;
}

/**
 * Applies the current theme on app startup without dispatching a change event.
 * Called once from the shell entry point.
 *
 * @returns The applied theme.
 */
export function initializeDirectorTheme() {
  return applyDirectorTheme(getDirectorTheme(), { notify: false });
}

/**
 * Subscribes to theme changes fired by `applyDirectorTheme`.
 *
 * @param listener - Called on every theme change.
 * @returns A function that removes the listener.
 */
export function subscribeToDirectorTheme(listener: () => void) {
  window.addEventListener(DIRECTOR_THEME_CHANGE_EVENT, listener);
  return () => window.removeEventListener(DIRECTOR_THEME_CHANGE_EVENT, listener);
}
