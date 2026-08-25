import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import { PerformanceSettings } from "../../../../src/comprehensive/editor/performance/PerformanceSettings";
import {
  PERFORMANCE_OVERRIDES_STORAGE_KEY,
  PERFORMANCE_PROFILE_STORAGE_KEY,
  createAnonymousPerformanceReport,
  getPerformanceRuntimeSnapshot,
  publishPerformanceSample,
  resetPerformanceConfigOverrides,
  setSelectedPerformanceProfile,
} from "../../../../src/comprehensive/editor/performance/performanceRuntime";

describe("PerformanceSettings", () => {
  beforeEach(() => {
    act(() => {
      resetPerformanceConfigOverrides();
      setSelectedPerformanceProfile("quality");
    });
  });

  afterEach(() => {
    window.localStorage.removeItem("director.ui.locale");
    act(() => {
      resetPerformanceConfigOverrides();
      setSelectedPerformanceProfile("quality");
    });
  });

  it("offers every profile and persists the chosen one", () => {
    render(<PerformanceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "性能 高清" }));

    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /高清/ })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: /流畅/ }));
    expect(window.localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY)).toBe("fluid");
    expect(screen.getByRole("radio", { name: /流畅/ })).toBeChecked();
    expect(screen.getByText(/当前实际使用/)).toHaveTextContent("流畅");

    fireEvent.click(screen.getByRole("radio", { name: /自动/ }));
    expect(window.localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY)).toBe("auto");
    expect(screen.getByRole("radio", { name: /自动/ })).toBeChecked();
  });

  it("migrates an unknown stored preference to auto", () => {
    act(() => setSelectedPerformanceProfile("turbo" as never));
    render(<PerformanceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "性能 自动" }));

    expect(window.localStorage.getItem(PERFORMANCE_PROFILE_STORAGE_KEY)).toBe("auto");
    expect(screen.getByRole("radio", { name: /自动/ })).toBeChecked();
  });

  it("shows measured frame health and builds an anonymous renderer report", () => {
    render(<PerformanceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "性能 高清" }));

    act(() => {
      publishPerformanceSample({
        averageFps: 58.75,
        effectiveProfileId: "balanced",
        longFrameRatio: 0.01,
        p95FrameMs: 19.4,
        renderer: {
          calls: 12,
          geometries: 8,
          pixelRatio: 1,
          textures: 4,
          triangles: 24_000,
          viewportHeight: 720,
          viewportWidth: 1280,
        },
      });
    });

    expect(screen.getByText("58.8 FPS · P95 19.4 ms")).toBeInTheDocument();
    expect(screen.getByText(/当前实际使用/)).toHaveTextContent("均衡");
    expect(screen.getByRole("button", { name: "下载匿名性能报告" })).toBeEnabled();
    expect(createAnonymousPerformanceReport().renderer?.triangles).toBe(24_000);
    expect(createAnonymousPerformanceReport().performance.effectiveProfile).toBe("balanced");
  });

  it("persists adjustable render, shadow, animation, and label trade-offs", () => {
    render(<PerformanceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "性能 高清" }));

    fireEvent.change(screen.getByRole("slider", { name: "主视口像素密度" }), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "启用实时阴影" }));
    fireEvent.change(screen.getByRole("combobox", { name: "阴影分辨率" }), { target: { value: "2048" } });
    fireEvent.change(screen.getByRole("combobox", { name: "角色动画采样" }), {
      target: { value: "adaptive" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "角色标签上限" }), { target: { value: "24" } });

    expect(getPerformanceRuntimeSnapshot().configOverrides).toEqual(
      expect.objectContaining({
        mainDpr: 1.5,
        shadowsEnabled: false,
        shadowMapSize: 2048,
        characterAnimationSampling: "adaptive",
        characterLabelBudget: 24,
      }),
    );
    expect(JSON.parse(window.localStorage.getItem(PERFORMANCE_OVERRIDES_STORAGE_KEY) ?? "{}")).toEqual(
      expect.objectContaining({ mainDpr: 1.5, shadowsEnabled: false }),
    );
    expect(screen.getByRole("button", { name: "性能 高清 自定义" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "恢复当前档位默认值" }));
    expect(getPerformanceRuntimeSnapshot().configOverrides).toEqual({});
    expect(getPerformanceRuntimeSnapshot().resolvedConfig.shadowMapSize).toBe(4096);
    expect(getPerformanceRuntimeSnapshot().resolvedConfig.characterAnimationSampling).toBe("full");
    expect(getPerformanceRuntimeSnapshot().resolvedConfig.characterLabelBudget).toBeNull();
  });

  it("keeps the custom state fully translated in the English interface", () => {
    window.localStorage.setItem("director.ui.locale", "en-US");
    render(
      <LanguageProvider>
        <PerformanceSettings />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Performance High quality" }));
    fireEvent.change(screen.getByRole("combobox", { name: "阴影分辨率" }), { target: { value: "2048" } });

    expect(screen.getByRole("button", { name: "Performance High quality Custom" })).toBeInTheDocument();
  });
});
