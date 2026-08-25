import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DirectorTimelineEnablePrompt } from "../../../../src/comprehensive/editor/timeline/DirectorTimelineEnablePrompt";

it("requires an explicit click before adding a timeline to a legacy scene", () => {
  const onEnable = vi.fn();
  render(<DirectorTimelineEnablePrompt bottom={96} onEnable={onEnable} />);
  expect(screen.getByText("此旧场景尚未启用帧时间轴")).toBeInTheDocument();
  expect(onEnable).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /启用时间轴/ }));
  expect(onEnable).toHaveBeenCalledOnce();
});
