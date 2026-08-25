import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearDirectorNotifications,
  dismissDirectorNotification,
  getDirectorNotifications,
  notifyDirector,
} from "../../../../src/comprehensive/app/notifications/directorNotificationStore";

beforeEach(() => {
  vi.useFakeTimers();
  clearDirectorNotifications();
});

afterEach(() => {
  clearDirectorNotifications();
  vi.useRealTimers();
});

it("auto-dismisses info and success notifications after 6 seconds", () => {
  notifyDirector({ severity: "info", title: "已连接" });
  notifyDirector({ severity: "success", title: "导出完成" });
  expect(getDirectorNotifications()).toHaveLength(2);

  vi.advanceTimersByTime(5_999);
  expect(getDirectorNotifications()).toHaveLength(2);

  vi.advanceTimersByTime(1);
  expect(getDirectorNotifications()).toHaveLength(0);
});

it("keeps warning and error notifications until they are dismissed manually", () => {
  const key = notifyDirector({ severity: "error", title: "保存失败" });
  notifyDirector({ severity: "warning", title: "存储空间不足" });

  vi.advanceTimersByTime(60_000);
  expect(getDirectorNotifications()).toHaveLength(2);

  dismissDirectorNotification(key);
  expect(getDirectorNotifications().map((notification) => notification.title)).toEqual(["存储空间不足"]);
});

it("updates a keyed notification in place instead of stacking duplicates", () => {
  notifyDirector({ key: "gateway", severity: "warning", title: "网关未连接", detail: "第一次" });
  notifyDirector({ key: "gateway", severity: "warning", title: "网关未连接", detail: "第二次" });

  const notifications = getDirectorNotifications();
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.detail).toBe("第二次");
});

it("resets the auto-dismiss timer when a keyed notification is updated", () => {
  notifyDirector({ key: "sync", severity: "info", title: "同步中" });
  vi.advanceTimersByTime(4_000);
  notifyDirector({ key: "sync", severity: "info", title: "同步中" });

  vi.advanceTimersByTime(4_000);
  expect(getDirectorNotifications()).toHaveLength(1);

  vi.advanceTimersByTime(2_000);
  expect(getDirectorNotifications()).toHaveLength(0);
});

it("supports overriding the auto-dismiss delay, including sticky info notifications", () => {
  notifyDirector({ key: "sticky-info", severity: "info", title: "常驻提示", autoDismissMs: null });
  notifyDirector({ key: "quick-warning", severity: "warning", title: "短暂警告", autoDismissMs: 1_000 });

  vi.advanceTimersByTime(1_000);
  expect(getDirectorNotifications().map((notification) => notification.key)).toEqual(["sticky-info"]);

  vi.advanceTimersByTime(600_000);
  expect(getDirectorNotifications()).toHaveLength(1);
});
