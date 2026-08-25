import { describe, expect, it } from "vitest";
import {
  PERFORMANCE_PROFILE_CONFIGS,
  PERFORMANCE_PROFILE_OPTIONS,
  normalizePerformanceProfileId,
  recommendAdaptivePerformanceProfile,
  resolveAutomaticPerformanceProfile,
  summarizeFrameIntervals,
} from "../../../../src/comprehensive/editor/performance/performanceProfiles";

describe("performance profiles", () => {
  it("keeps every valid stored preference and migrates unknown values to auto", () => {
    expect(normalizePerformanceProfileId("auto")).toBe("auto");
    expect(normalizePerformanceProfileId("fluid")).toBe("fluid");
    expect(normalizePerformanceProfileId("balanced")).toBe("balanced");
    expect(normalizePerformanceProfileId("quality")).toBe("quality");
    expect(normalizePerformanceProfileId("turbo")).toBe("auto");
    expect(normalizePerformanceProfileId(null)).toBe("auto");
  });

  it("offers a selectable option for auto and each render budget", () => {
    expect(PERFORMANCE_PROFILE_OPTIONS.map((option) => option.id)).toEqual(["auto", "fluid", "balanced", "quality"]);
  });

  it("maps device capability tiers to distinct starting budgets", () => {
    expect(
      resolveAutomaticPerformanceProfile({ deviceMemoryGb: 4, devicePixelRatio: 2, hardwareConcurrency: 12 }),
    ).toBe("fluid");
    expect(
      resolveAutomaticPerformanceProfile({ deviceMemoryGb: 16, devicePixelRatio: 2, hardwareConcurrency: 4 }),
    ).toBe("fluid");
    expect(resolveAutomaticPerformanceProfile({ deviceMemoryGb: 8, devicePixelRatio: 2, hardwareConcurrency: 6 })).toBe(
      "balanced",
    );
    expect(
      resolveAutomaticPerformanceProfile({ deviceMemoryGb: 16, devicePixelRatio: 2, hardwareConcurrency: 12 }),
    ).toBe("quality");
    expect(
      resolveAutomaticPerformanceProfile({ deviceMemoryGb: null, devicePixelRatio: 2, hardwareConcurrency: 10 }),
    ).toBe("quality");
  });

  it("gives each profile a strictly increasing render budget", () => {
    const { fluid, balanced, quality } = PERFORMANCE_PROFILE_CONFIGS;
    expect(fluid.shadowMapSize).toBeLessThan(balanced.shadowMapSize);
    expect(balanced.shadowMapSize).toBeLessThan(quality.shadowMapSize);
    const maxDpr = (dpr: number | [number, number]) => (Array.isArray(dpr) ? dpr[1] : dpr);
    expect(maxDpr(fluid.mainDpr)).toBeLessThan(maxDpr(balanced.mainDpr));
    expect(maxDpr(balanced.mainDpr)).toBeLessThan(maxDpr(quality.mainDpr));
    expect(maxDpr(fluid.previewDpr)).toBeLessThan(maxDpr(quality.previewDpr));
    expect(quality.shadowMapSize).toBe(4096);
    expect(fluid.characterAnimationSampling).toBe("adaptive");
    expect(quality.characterAnimationSampling).toBe("full");
    expect(fluid.characterLabelBudget).toBeGreaterThan(0);
    expect(quality.characterLabelBudget).toBeNull();
  });

  it("steps one rung down when struggling and one rung up only when comfortable", () => {
    const struggling = summarizeFrameIntervals([40, 45, 42, 50, 48]);
    expect(recommendAdaptivePerformanceProfile("quality", struggling)).toBe("balanced");
    expect(recommendAdaptivePerformanceProfile("balanced", struggling)).toBe("fluid");
    expect(recommendAdaptivePerformanceProfile("fluid", struggling)).toBe("fluid");

    const comfortable = summarizeFrameIntervals(Array.from({ length: 180 }, () => 16.7));
    expect(recommendAdaptivePerformanceProfile("fluid", comfortable)).toBe("balanced");
    expect(recommendAdaptivePerformanceProfile("balanced", comfortable)).toBe("quality");
    expect(recommendAdaptivePerformanceProfile("quality", comfortable)).toBe("quality");

    const borderline = summarizeFrameIntervals([16, 17, 16, 42, 45]);
    expect(recommendAdaptivePerformanceProfile("balanced", borderline)).toBe("fluid");
    expect(recommendAdaptivePerformanceProfile("quality", struggling)).not.toBe("fluid");
  });
});
