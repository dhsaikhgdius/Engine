import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetDirectorSessionRuntime,
  updateDirectorSessionRuntime,
} from "../../../../src/comprehensive/editor/session/directorSessionRuntime";
import {
  DirectorNotificationLayer,
  isDirectorRemoteRevisionSyncNotice,
} from "../../../../src/comprehensive/app/notifications/DirectorNotificationLayer";
import {
  clearDirectorNotifications,
  getDirectorNotifications,
} from "../../../../src/comprehensive/app/notifications/directorNotificationStore";

beforeEach(() => {
  vi.useFakeTimers();
  resetDirectorSessionRuntime();
  clearDirectorNotifications();
  updateDirectorSessionRuntime({ gateway: "connected" });
});

afterEach(() => {
  clearDirectorNotifications();
  resetDirectorSessionRuntime();
  vi.useRealTimers();
});

it("treats remote-revision checking as a short-lived sync notice", () => {
  expect(isDirectorRemoteRevisionSyncNotice("远端修订 1791，正在核对")).toBe(true);
  expect(isDirectorRemoteRevisionSyncNotice("Scene project save failed")).toBe(false);
});

it("auto-dismisses the unsaved-scene sync notice after a few seconds", () => {
  updateDirectorSessionRuntime({ conflict: "远端修订 1791，正在核对" });
  render(<DirectorNotificationLayer />);

  expect(screen.getByText("场景尚未保存")).toBeInTheDocument();
  expect(screen.getByText("远端修订 1791，正在核对")).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(5_999);
  });
  expect(screen.getByText("场景尚未保存")).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByText("场景尚未保存")).not.toBeInTheDocument();
  expect(getDirectorNotifications().some((notification) => notification.key === "session-save-conflict")).toBe(false);
});

it("keeps a real scene-save failure until it is dismissed", () => {
  updateDirectorSessionRuntime({ conflict: "Scene project save failed" });
  render(<DirectorNotificationLayer />);

  expect(screen.getByText("场景尚未保存")).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByText("场景尚未保存")).toBeInTheDocument();
});

it("shows the gateway-offline notice after a delay, then auto-dismisses it", () => {
  render(<DirectorNotificationLayer />);
  act(() => {
    updateDirectorSessionRuntime({ gateway: "disconnected" });
  });

  expect(screen.queryByText("网关未连接，Agent 与生成功能不可用")).not.toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(4_999);
  });
  expect(screen.queryByText("网关未连接，Agent 与生成功能不可用")).not.toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.getByText("网关未连接，Agent 与生成功能不可用")).toBeInTheDocument();
  expect(
    screen.getByText("请在项目根目录运行 npm run dev（或单独运行 npm run gateway）启动 Agent Gateway。"),
  ).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(7_999);
  });
  expect(screen.getByText("网关未连接，Agent 与生成功能不可用")).toBeInTheDocument();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByText("网关未连接，Agent 与生成功能不可用")).not.toBeInTheDocument();
  expect(getDirectorNotifications().some((notification) => notification.key === "gateway-offline")).toBe(false);
});

it("does not revive the gateway-offline notice while the same outage continues", () => {
  render(<DirectorNotificationLayer />);
  act(() => {
    updateDirectorSessionRuntime({ gateway: "disconnected" });
  });
  act(() => {
    vi.advanceTimersByTime(13_000);
  });
  expect(screen.queryByText("网关未连接，Agent 与生成功能不可用")).not.toBeInTheDocument();

  act(() => {
    updateDirectorSessionRuntime({ gateway: "connecting" });
  });
  act(() => {
    vi.advanceTimersByTime(8_000);
  });
  expect(screen.queryByText("网关未连接，Agent 与生成功能不可用")).not.toBeInTheDocument();
});

it("shows the gateway-offline notice again after reconnecting and a later outage", () => {
  render(<DirectorNotificationLayer />);
  act(() => {
    updateDirectorSessionRuntime({ gateway: "disconnected" });
  });
  act(() => {
    vi.advanceTimersByTime(13_000);
  });

  act(() => {
    updateDirectorSessionRuntime({ gateway: "connected" });
  });
  act(() => {
    updateDirectorSessionRuntime({ gateway: "disconnected" });
  });
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(screen.getByText("网关未连接，Agent 与生成功能不可用")).toBeInTheDocument();
});
