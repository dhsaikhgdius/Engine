import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearCastingHud } from "../../../../../src/comprehensive/editor/player/linearCasting/LinearCastingHud";
import { setLinearCastingHudRuntime } from "../../../../../src/comprehensive/editor/player/linearCasting/linearCastingHudBridge";
import {
  setLinearCastingEnabled,
  setLinearCastingPaused,
} from "../../../../../src/comprehensive/editor/player/linearCasting/linearCastingSession";

function mockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    aim: { isArmed: false },
    selected: "ice",
    cooldownRatio: () => 0,
    flash: { color: { r: 1, g: 1, b: 1 }, strength: 0 },
    toggleArm: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  setLinearCastingHudRuntime(null);
  setLinearCastingEnabled(true);
  setLinearCastingPaused(false);
});

describe("LinearCastingHud", () => {
  it("renders every ability slot and keeps pointerdown from stealing roam focus", () => {
    const runtime = mockRuntime();
    setLinearCastingHudRuntime(runtime as never);
    render(<LinearCastingHud />);

    const bar = screen.getByRole("toolbar", { name: "技能栏" });
    const frost = screen.getByRole("button", { name: "霜矛" });
    expect(screen.getByRole("complementary", { name: "技能施放" })).toBeInTheDocument();
    expect(bar).toContainElement(frost);
    expect(screen.getByRole("button", { name: "冰川冠" })).toBeInTheDocument();
    expect(frost.querySelector("kbd")?.textContent).toBe("5");
    expect(fireEvent.pointerDown(frost)).toBe(false);
    fireEvent.click(frost);
    expect(runtime.toggleArm).toHaveBeenCalledWith("ice");
  });

  it("can turn casting off so roam keys stay available", () => {
    setLinearCastingHudRuntime(mockRuntime() as never);
    render(<LinearCastingHud />);

    const toggle = screen.getByRole("button", { name: "开" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(fireEvent.pointerDown(toggle)).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "关" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "霜矛" })).toBeDisabled();
  });
});
