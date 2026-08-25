// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import { STAGE_VIEWPORT_AUDIO_STORAGE_KEY, setStageViewportAudioEnabled } from "../../../../src/comprehensive/editor/audio/stageViewportAudio";
import { DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED, DEFAULT_VIEWPORT_MOVE_SPEED } from "../../../../src/comprehensive/editor/schema/viewportNavigation";
import { useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { ViewportNavigationSettings } from "../../../../src/comprehensive/editor/canvas/ViewportNavigationSettings";

describe("ViewportNavigationSettings", () => {
  beforeEach(() => {
    setStageViewportAudioEnabled(true);
    window.localStorage.removeItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY);
    useDirectorStore.setState({
      viewportRotateSensitivity: 0.35,
      viewportZoomSensitivity: 0.4,
      viewportMoveSpeed: DEFAULT_VIEWPORT_MOVE_SPEED,
      viewportCharacterMoveSpeed: DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
      viewportPilotInertia: 0.4,
      viewportPilotLookSmoothing: 0.25,
      viewportPilotBankStrength: 0.3,
    });
  });

  it("updates and resets all shared navigation settings", () => {
    render(
      <LanguageProvider>
        <ViewportNavigationSettings />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "视角手感" }));
    fireEvent.change(screen.getByLabelText("转动视角"), { target: { value: "0.8" } });
    fireEvent.change(screen.getByLabelText("WASD 移动速度"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("人物移速"), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("移动惯性"), { target: { value: "0.7" } });
    fireEvent.change(screen.getByLabelText("侧倾幅度"), { target: { value: "0.6" } });
    expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(0.8);
    expect(useDirectorStore.getState().viewportMoveSpeed).toBe(14);
    expect(useDirectorStore.getState().viewportCharacterMoveSpeed).toBe(1.5);
    expect(useDirectorStore.getState().viewportPilotInertia).toBe(0.7);
    expect(useDirectorStore.getState().viewportPilotBankStrength).toBe(0.6);

    fireEvent.click(screen.getByRole("button", { name: "恢复默认手感" }));
    expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(0.35);
    expect(useDirectorStore.getState().viewportMoveSpeed).toBe(DEFAULT_VIEWPORT_MOVE_SPEED);
    expect(useDirectorStore.getState().viewportCharacterMoveSpeed).toBe(DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED);
    expect(useDirectorStore.getState().viewportPilotInertia).toBe(0.4);
    expect(useDirectorStore.getState().viewportPilotBankStrength).toBe(0.3);
  });

  it("exposes the Blender authority layer in the existing view controls", () => {
    const onVisibleChange = vi.fn();
    render(
      <LanguageProvider>
        <ViewportNavigationSettings blenderLive={{ visible: true, onVisibleChange }} />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "视角手感" }));
    const toggle = screen.getByRole("checkbox", { name: "Blender live" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(onVisibleChange).toHaveBeenCalledWith(false);
  });

  it("toggles and persists stage sound", () => {
    render(
      <LanguageProvider>
        <ViewportNavigationSettings />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "视角手感" }));
    const toggle = screen.getByRole("checkbox", { name: "启用舞台音效" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(STAGE_VIEWPORT_AUDIO_STORAGE_KEY)).toBe("false");
  });
});
