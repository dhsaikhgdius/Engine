import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { expect, it } from "vitest";
import { getEscapeLayerDepth } from "../../../../src/comprehensive/app/layout/escapeLayerStack";
import { useModalDialogFocus } from "../../../../src/comprehensive/app/layout/useModalDialogFocus";

function TestDialog({ onClose, useInitialFocus = false }: { onClose: () => void; useInitialFocus?: boolean }) {
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialogFocus<HTMLDivElement>({
    onClose,
    initialFocusRef: useInitialFocus ? initialFocusRef : undefined,
  });
  return (
    <div aria-label="测试对话框" aria-modal="true" ref={dialogRef} role="dialog">
      <button type="button">第一项</button>
      <input aria-label="中间输入框" />
      <button ref={initialFocusRef} type="button">
        最后一项
      </button>
    </div>
  );
}

function Harness({ useInitialFocus = false }: { useInitialFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开对话框
      </button>
      {open ? <TestDialog useInitialFocus={useInitialFocus} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

it("moves focus to the first focusable control when the dialog opens", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("button", { name: "打开对话框" }));

  expect(screen.getByRole("dialog", { name: "测试对话框" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "第一项" })).toHaveFocus();
});

it("honours an explicit initial focus target", async () => {
  const user = userEvent.setup();
  render(<Harness useInitialFocus />);

  await user.click(screen.getByRole("button", { name: "打开对话框" }));

  expect(screen.getByRole("button", { name: "最后一项" })).toHaveFocus();
});

it("cycles Tab and Shift+Tab inside the dialog", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "打开对话框" }));

  await user.tab();
  expect(screen.getByLabelText("中间输入框")).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "最后一项" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "第一项" })).toHaveFocus();

  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "最后一项" })).toHaveFocus();
});

it("closes on Escape and restores focus to the trigger", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "打开对话框" });
  await user.click(trigger);
  expect(getEscapeLayerDepth()).toBe(1);

  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog", { name: "测试对话框" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(getEscapeLayerDepth()).toBe(0);
});

it("restores trigger focus when the dialog closes by other means", async () => {
  const user = userEvent.setup();
  function ClosableHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          打开对话框
        </button>
        {open ? <ClosableDialog onClose={() => setOpen(false)} /> : null}
      </>
    );
  }
  function ClosableDialog({ onClose }: { onClose: () => void }) {
    const dialogRef = useModalDialogFocus<HTMLDivElement>({ onClose });
    return (
      <div aria-label="可关闭对话框" aria-modal="true" ref={dialogRef} role="dialog">
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
    );
  }
  render(<ClosableHarness />);
  const trigger = screen.getByRole("button", { name: "打开对话框" });
  await user.click(trigger);

  await user.click(screen.getByRole("button", { name: "关闭" }));

  expect(screen.queryByRole("dialog", { name: "可关闭对话框" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("falls back to focusing the dialog container when nothing inside is focusable", async () => {
  const user = userEvent.setup();
  function EmptyDialogHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          打开对话框
        </button>
        {open ? <EmptyDialog onClose={() => setOpen(false)} /> : null}
      </>
    );
  }
  function EmptyDialog({ onClose }: { onClose: () => void }) {
    const dialogRef = useModalDialogFocus<HTMLDivElement>({ onClose });
    return (
      <div aria-label="空对话框" aria-modal="true" ref={dialogRef} role="dialog">
        <p>没有可交互控件</p>
      </div>
    );
  }
  render(<EmptyDialogHarness />);
  await user.click(screen.getByRole("button", { name: "打开对话框" }));

  const dialog = screen.getByRole("dialog", { name: "空对话框" });
  expect(dialog).toHaveFocus();

  await user.tab();
  expect(dialog).toHaveFocus();
});
