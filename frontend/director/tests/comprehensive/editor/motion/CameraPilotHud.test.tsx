import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CameraPilotHud } from "../../../../src/comprehensive/editor/motion/CameraPilotHud";

const baseProps = {
  controlActive: true,
  currentFrame: 0,
  onExit: vi.fn(),
  onRecord: vi.fn(),
  pointedTargetName: null,
  recordedCount: 0,
};

it("shows whether F will lock or unlock the camera target", () => {
  const { rerender } = render(<CameraPilotHud {...baseProps} lockedTargetName={null} targetLocked={false} />);

  expect(screen.getByText("锁定目标")).toBeInTheDocument();

  rerender(<CameraPilotHud {...baseProps} lockedTargetName="Actor A" targetLocked />);

  expect(screen.getByText("解锁目标")).toBeInTheDocument();
  expect(screen.queryByText("锁定目标")).not.toBeInTheDocument();
  expect(screen.getByLabelText("WASD 移动 · E/Q 升降 · F 解锁目标")).toBeInTheDocument();
});

it("shows a locked current view point even when there is no named target", () => {
  render(<CameraPilotHud {...baseProps} lockedTargetName={null} targetLocked />);

  expect(screen.getByText("F · 当前视点")).toBeInTheDocument();
  expect(screen.getByText("解锁目标")).toBeInTheDocument();
});
