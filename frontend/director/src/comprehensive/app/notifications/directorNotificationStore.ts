import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/** Semantic severity of a notification, controlling icon and auto-dismiss behavior. */
export type DirectorNotificationSeverity = "info" | "success" | "warning" | "error";

/** A user-selectable action button rendered alongside the notification. */
export interface DirectorNotificationAction {
  /** The button label. */
  label: string;
  /** Called when the user clicks the action button. */
  onSelect: () => void;
}

/** Parameters for creating or updating a notification. */
export interface DirectorNotificationInput {
  /** Notifications with the same key update in place instead of stacking. */
  key?: string;
  severity: DirectorNotificationSeverity;
  title: string;
  detail?: string;
  actions?: DirectorNotificationAction[];
  /**
   * Milliseconds before auto-dismissal. Defaults to 6s for info/success and
   * sticky (null) for warning/error.
   */
  autoDismissMs?: number | null;
}

/** A resolved notification stored in the notification store. */
export interface DirectorNotification {
  key: string;
  severity: DirectorNotificationSeverity;
  title: string;
  detail: string | null;
  actions: DirectorNotificationAction[];
  createdAt: number;
  updatedAt: number;
}

interface DirectorNotificationStoreState {
  notifications: readonly DirectorNotification[];
}

const AUTO_DISMISS_MS = 6_000;

/** The vanilla Zustand store backing the Director notification system. */
export const directorNotificationStore = createStore<DirectorNotificationStoreState>(() => ({
  notifications: [],
}));

const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
let generatedKeySequence = 0;

function clearDismissTimer(key: string) {
  const timer = dismissTimers.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  dismissTimers.delete(key);
}

function resolveAutoDismissMs(input: DirectorNotificationInput): number | null {
  if (input.autoDismissMs !== undefined) return input.autoDismissMs;
  return input.severity === "info" || input.severity === "success" ? AUTO_DISMISS_MS : null;
}

/**
 * Creates or updates a notification. Notifications with the same key replace
 * each other; a generated key ensures uniqueness when none is provided.
 *
 * Auto-dismiss behavior: info/success notifications dismiss after 6 s by
 * default; warning/error notifications are sticky unless `autoDismissMs` is
 * explicitly set.
 *
 * @param input - The notification parameters.
 * @returns The notification key, useful for programmatic dismissal.
 */
export function notifyDirector(input: DirectorNotificationInput): string {
  generatedKeySequence += 1;
  const key = input.key ?? `director-notification-${generatedKeySequence}`;
  const now = Date.now();

  directorNotificationStore.setState((state) => {
    const existing = state.notifications.find((notification) => notification.key === key);
    const next: DirectorNotification = {
      key,
      severity: input.severity,
      title: input.title,
      detail: input.detail?.trim() || null,
      actions: input.actions ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return {
      notifications: existing
        ? state.notifications.map((notification) => (notification.key === key ? next : notification))
        : [...state.notifications, next],
    };
  });

  clearDismissTimer(key);
  const autoDismissMs = resolveAutoDismissMs(input);
  if (autoDismissMs !== null && autoDismissMs > 0) {
    dismissTimers.set(
      key,
      setTimeout(() => {
        dismissTimers.delete(key);
        dismissDirectorNotification(key);
      }, autoDismissMs),
    );
  }
  return key;
}

/**
 * Dismisses a notification by key. Safe to call on a key that no longer exists.
 *
 * @param key - The notification key returned by `notifyDirector`.
 */
export function dismissDirectorNotification(key: string) {
  clearDismissTimer(key);
  const { notifications } = directorNotificationStore.getState();
  if (!notifications.some((notification) => notification.key === key)) return;
  directorNotificationStore.setState({
    notifications: notifications.filter((notification) => notification.key !== key),
  });
}

/** Dismisses every active notification and clears all auto-dismiss timers. */
export function clearDirectorNotifications() {
  Array.from(dismissTimers.keys()).forEach(clearDismissTimer);
  if (directorNotificationStore.getState().notifications.length === 0) return;
  directorNotificationStore.setState({ notifications: [] });
}

/**
 * Returns the current notification list without subscribing to changes.
 * Prefer `useDirectorNotifications` inside React components.
 *
 * @returns A readonly snapshot of the current notifications.
 */
export function getDirectorNotifications(): readonly DirectorNotification[] {
  return directorNotificationStore.getState().notifications;
}

/** React hook that subscribes to the current notification list. */
export function useDirectorNotifications(): readonly DirectorNotification[] {
  return useStore(directorNotificationStore, (state) => state.notifications);
}
