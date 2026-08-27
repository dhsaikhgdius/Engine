import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceErrorBoundary } from "../../../../src/comprehensive/app/errors/WorkspaceErrorBoundary";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function BrokenOnce({ broken }: { broken: boolean }) {
  if (broken) throw new Error("render exploded");
  return <div>workspace content</div>;
}

it("renders children until a descendant throws, then shows the recovery card", () => {
  const { rerender } = render(
    <WorkspaceErrorBoundary title="演示界面加载失败">
      <BrokenOnce broken={false} />
    </WorkspaceErrorBoundary>,
  );
  expect(screen.getByText("workspace content")).toBeInTheDocument();

  rerender(
    <WorkspaceErrorBoundary title="演示界面加载失败">
      <BrokenOnce broken />
    </WorkspaceErrorBoundary>,
  );
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("演示界面加载失败")).toBeInTheDocument();
  expect(screen.getByText("render exploded")).toBeInTheDocument();
});

it("calls onRetry before clearing the error so parents can rebuild lazy imports", async () => {
  const user = userEvent.setup();
  let broken = true;
  const onRetry = vi.fn(() => {
    broken = false;
  });

  function MaybeBroken() {
    if (broken) throw new Error("render exploded");
    return <div>workspace content</div>;
  }

  render(
    <WorkspaceErrorBoundary onRetry={onRetry} title="演示界面加载失败">
      <MaybeBroken />
    </WorkspaceErrorBoundary>,
  );
  expect(screen.getByRole("alert")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重试" }));

  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(screen.getByText("workspace content")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("falls back to the generic headline when no title is provided", () => {
  render(
    <WorkspaceErrorBoundary>
      <BrokenOnce broken />
    </WorkspaceErrorBoundary>,
  );
  expect(screen.getByText("界面加载出错")).toBeInTheDocument();
});
