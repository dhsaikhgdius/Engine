import { fireEvent, render, screen } from "@testing-library/react";
import { Video } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { CreativeTransportDropdown } from "../../../../src/comprehensive/editor/workspaces/CreativeTransportDropdown";

describe("CreativeTransportDropdown", () => {
  it("portals the menu above the trigger with enough width for icon labels", () => {
    render(
      <CreativeTransportDropdown
        ariaLabel="添加轨道"
        onSelect={() => undefined}
        options={[
          { id: "video", label: "视频轨", icon: <Video aria-hidden size={14} /> },
          { id: "audio", label: "音频轨", icon: <Video aria-hidden size={14} /> },
        ]}
        trigger="轨道"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "添加轨道" }));

    const menu = document.body.querySelector(".creative-transport-dropdown-menu.is-portaled");
    expect(menu).not.toBeNull();
    expect(document.body).toContainElement(screen.getByRole("menuitem", { name: "音频轨" }));
    expect((menu as HTMLElement).style.minWidth).not.toBe("0px");
    expect(Number.parseFloat((menu as HTMLElement).style.minWidth || "0")).toBeGreaterThanOrEqual(120);
  });

  it("opens with ArrowUp, focuses the selected option, and moves focus while skipping disabled options", () => {
    render(
      <CreativeTransportDropdown
        ariaLabel="播放速度"
        onSelect={() => undefined}
        options={[
          { id: "slow", label: "慢速" },
          { id: "normal", label: "常速", disabled: true },
          { id: "fast", label: "快速" },
        ]}
        trigger="速度"
        value="slow"
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "播放速度" }), { key: "ArrowUp" });

    const slowOption = screen.getByRole("option", { name: "慢速" });
    const fastOption = screen.getByRole("option", { name: "快速" });
    expect(slowOption).toHaveFocus();

    fireEvent.keyDown(slowOption, { key: "ArrowDown" });
    expect(fastOption).toHaveFocus();

    fireEvent.keyDown(fastOption, { key: "ArrowDown" });
    expect(slowOption).toHaveFocus();

    fireEvent.keyDown(slowOption, { key: "ArrowUp" });
    expect(fastOption).toHaveFocus();

    fireEvent.keyDown(fastOption, { key: "Home" });
    expect(slowOption).toHaveFocus();

    fireEvent.keyDown(slowOption, { key: "End" });
    expect(fastOption).toHaveFocus();
  });

  it("focuses the first enabled option when nothing is selected", () => {
    render(
      <CreativeTransportDropdown
        ariaLabel="添加轨道"
        onSelect={() => undefined}
        options={[
          { id: "video", label: "视频轨", disabled: true },
          { id: "audio", label: "音频轨" },
        ]}
        trigger="轨道"
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "添加轨道" }), { key: "ArrowDown" });

    expect(screen.getByRole("menuitem", { name: "音频轨" })).toHaveFocus();
  });

  it("selects the focused option with Enter and returns focus to the trigger", () => {
    const onSelect = vi.fn();
    render(
      <CreativeTransportDropdown
        ariaLabel="添加轨道"
        onSelect={onSelect}
        options={[
          { id: "video", label: "视频轨" },
          { id: "audio", label: "音频轨" },
        ]}
        trigger="轨道"
      />,
    );

    const trigger = screen.getByRole("button", { name: "添加轨道" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "视频轨" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "音频轨" }), { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("audio");
    expect(document.body.querySelector(".creative-transport-dropdown-menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("selects the focused option with Space", () => {
    const onSelect = vi.fn();
    render(
      <CreativeTransportDropdown
        ariaLabel="添加轨道"
        onSelect={onSelect}
        options={[{ id: "video", label: "视频轨" }]}
        trigger="轨道"
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "添加轨道" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "视频轨" }), { key: " " });

    expect(onSelect).toHaveBeenCalledWith("video");
    expect(document.body.querySelector(".creative-transport-dropdown-menu")).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(
      <CreativeTransportDropdown
        ariaLabel="添加轨道"
        onSelect={() => undefined}
        options={[{ id: "video", label: "视频轨" }]}
        trigger="轨道"
      />,
    );

    const trigger = screen.getByRole("button", { name: "添加轨道" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "视频轨" }), { key: "Escape" });

    expect(document.body.querySelector(".creative-transport-dropdown-menu")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Tab without selecting", () => {
    const onSelect = vi.fn();
    render(
      <CreativeTransportDropdown
        ariaLabel="添加轨道"
        onSelect={onSelect}
        options={[{ id: "video", label: "视频轨" }]}
        trigger="轨道"
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "添加轨道" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "视频轨" }), { key: "Tab" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.body.querySelector(".creative-transport-dropdown-menu")).toBeNull();
    expect(screen.getByRole("button", { name: "添加轨道" })).toHaveAttribute("aria-expanded", "false");
  });
});
