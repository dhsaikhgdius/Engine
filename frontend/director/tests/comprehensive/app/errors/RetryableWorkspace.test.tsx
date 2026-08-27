import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetryableWorkspace } from "../../../../src/comprehensive/app/errors/RetryableWorkspace";

// React and the boundary both log the caught chunk failure; keep test output clean.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function DemoWorkspace({ label = "workspace ready" }: { label?: string }) {
  return <div>{label}</div>;
}

it("shows the loading label until the workspace chunk resolves", async () => {
  let resolveChunk: (module: { default: typeof DemoWorkspace }) => void = () => {};
  const loader = vi.fn(
    () =>
      new Promise<{ default: typeof DemoWorkspace }>((resolve) => {
        resolveChunk = resolve;
      }),
  );

  render(<RetryableWorkspace title="演示工作区加载失败" loadingLabel="正在加载演示…" loader={loader} />);

  expect(await screen.findByText("正在加载演示…")).toBeInTheDocument();
  resolveChunk({ default: DemoWorkspace });
  expect(await screen.findByText("workspace ready")).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(1);
});

it("renders no loading state when loadingLabel is omitted (invisible hosts)", async () => {
  const loader = vi.fn(() => Promise.resolve({ default: DemoWorkspace }));

  const { container } = render(<RetryableWorkspace title="片场截图视口加载失败" loader={loader} />);

  expect(container.querySelector(".workspace-loading-state")).toBeNull();
  expect(await screen.findByText("workspace ready")).toBeInTheDocument();
});

it("recreates the lazy import on retry so a failed chunk load can recover", async () => {
  const user = userEvent.setup();
  const loader = vi
    .fn<() => Promise<{ default: typeof DemoWorkspace }>>()
    .mockRejectedValueOnce(new Error("chunk fetch failed"))
    .mockResolvedValue({ default: DemoWorkspace });

  render(<RetryableWorkspace title="演示工作区加载失败" loadingLabel="正在加载演示…" loader={loader} />);

  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByText("演示工作区加载失败")).toBeInTheDocument();
  expect(screen.getByText("chunk fetch failed")).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "重试" }));

  // The retry must construct a fresh lazy component: React caches a rejected
  // dynamic import per lazy instance, so recovery requires calling the loader again.
  expect(await screen.findByText("workspace ready")).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("forwards workspace props through to the loaded component", async () => {
  const loader = vi.fn(() => Promise.resolve({ default: DemoWorkspace }));

  render(
    <RetryableWorkspace
      label="custom workspace"
      loader={loader}
      loadingLabel="正在加载演示…"
      title="演示工作区加载失败"
    />,
  );

  expect(await screen.findByText("custom workspace")).toBeInTheDocument();
});
