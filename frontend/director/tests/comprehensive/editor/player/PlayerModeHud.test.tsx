import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlayerModeHud } from "../../../../src/comprehensive/editor/player/PlayerModeHud";

function createProps(overrides: Partial<ComponentProps<typeof PlayerModeHud>> = {}) {
  return {
    activeActorId: "actor-a",
    actors: [
      { id: "actor-a", name: "角色甲" },
      { id: "actor-b", name: "角色乙" },
    ],
    controlActive: true,
    flying: false,
    onEmote: vi.fn(),
    onExit: vi.fn(),
    onSelectActor: vi.fn(),
    onToggleFlight: vi.fn(),
    onToggleRecording: vi.fn(),
    onToggleView: vi.fn(),
    playerName: "角色甲",
    recording: false,
    runtimeStatus: null,
    viewMode: "third" as const,
    ...overrides,
  };
}

describe("PlayerModeHud", () => {
  it("keeps the dense key reference collapsed until explicitly requested", () => {
    render(<PlayerModeHud {...createProps()} />);

    expect(screen.queryByLabelText("漫游快捷键")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "键位说明" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Preventing pointerdown keeps the live canvas focused while this overlay
    // action runs; dispatchEvent returns false for a canceled event.
    expect(fireEvent.pointerDown(toggle)).toBe(false);
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("漫游快捷键")).toBeInTheDocument();
    expect(screen.getByText("解锁 / 再按退出")).toBeInTheDocument();
  });

  it("renders emotes as a separate hotbar and preserves focus intent on activation", () => {
    const onEmote = vi.fn();
    render(<PlayerModeHud {...createProps({ onEmote })} />);

    const dock = screen.getByRole("group", { name: "表情动作" });
    const clap = screen.getByRole("button", { name: "站立鼓掌" });
    expect(dock).toContainElement(clap);
    expect(fireEvent.pointerDown(clap)).toBe(false);
    fireEvent.click(clap);
    expect(onEmote).toHaveBeenCalledWith("clap");
  });

  it("shows the nearest object's E-key interaction prompt", () => {
    render(
      <PlayerModeHud
        {...createProps({
          runtimeStatus: {
            aiming: false,
            cameraDistance: 4,
            cameraObstructed: false,
            cameraPosition: [0, 2, 4],
            emoteClipId: null,
            interaction: { objectId: "set-door", prompt: "打开大厅门" },
            playerPosition: [0, 0, 0],
            playerVisible: true,
            targetPosition: [0, 1, 0],
            vehicle: null,
            viewMode: "third",
          },
        })}
      />,
    );

    expect(screen.getByText("打开大厅门")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("按 E");
  });

  it("hides the emote hotbar while vehicle controls own the session", () => {
    render(
      <PlayerModeHud
        {...createProps({
          runtimeStatus: {
            aiming: false,
            cameraDistance: 4,
            cameraObstructed: false,
            cameraPosition: [0, 2, 4],
            emoteClipId: null,
            playerPosition: [0, 0, 0],
            playerVisible: true,
            targetPosition: [0, 1, 0],
            vehicle: { phase: "driving", vehicleName: "跑车", speedKph: 42 },
            viewMode: "third",
          },
        })}
      />,
    );

    expect(screen.queryByRole("group", { name: "表情动作" })).not.toBeInTheDocument();
    expect(screen.getByText("42 km/h")).toBeInTheDocument();
  });
});
