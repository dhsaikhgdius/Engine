import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";
import { useModalDialogFocus } from "../../../src/comprehensive/app/layout/useModalDialogFocus";
import { useDropdownDisclosure } from "../../../src/comprehensive/editor/useDropdownDisclosure";

function Dropdown() {
  const { dropdownRef, triggerRef, handleTriggerKeyDown, isOpen, setIsOpen } = useDropdownDisclosure();
  return (
    <div ref={dropdownRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
      >
        打开下拉
      </button>
      {isOpen ? (
        <div aria-label="测试下拉" role="listbox">
          <button role="option" aria-selected type="button">
            选项一
          </button>
        </div>
      ) : null}
    </div>
  );
}

it("opens from the trigger keyboard shortcuts", async () => {
  const user = userEvent.setup();
  render(<Dropdown />);
  const trigger = screen.getByRole("button", { name: "打开下拉" });

  trigger.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("listbox", { name: "测试下拉" })).toBeInTheDocument();
});

it("closes on Escape and restores focus to the trigger", async () => {
  const user = userEvent.setup();
  render(<Dropdown />);
  const trigger = screen.getByRole("button", { name: "打开下拉" });
  await user.click(trigger);
  expect(screen.getByRole("listbox", { name: "测试下拉" })).toBeInTheDocument();

  await user.keyboard("{Escape}");

  expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("still closes when the pointer goes down outside the dropdown", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button type="button">外部按钮</button>
      <Dropdown />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "打开下拉" }));

  fireEvent.mouseDown(screen.getByRole("button", { name: "外部按钮" }));

  expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();
});

function PortaledDropdown() {
  const { dropdownRef, triggerRef, layerRef, handleTriggerKeyDown, isOpen, setIsOpen } = useDropdownDisclosure();
  return (
    <div ref={dropdownRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
      >
        打开下拉
      </button>
      {isOpen
        ? createPortal(
            <div aria-label="浮层下拉" ref={layerRef} role="listbox">
              <button role="option" type="button">
                选项一
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

it("keeps a portaled menu open when the pointer lands inside the layer", async () => {
  const user = userEvent.setup();
  render(<PortaledDropdown />);
  await user.click(screen.getByRole("button", { name: "打开下拉" }));
  fireEvent.mouseDown(screen.getByRole("option", { name: "选项一" }));
  expect(screen.getByRole("listbox", { name: "浮层下拉" })).toBeInTheDocument();
});

function DialogWithDropdown({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalDialogFocus<HTMLDivElement>({ onClose });
  return (
    <div aria-label="含下拉的对话框" aria-modal="true" ref={dialogRef} role="dialog">
      <Dropdown />
    </div>
  );
}

it("Escape inside a dialog closes only the dropdown first, then the dialog", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <DialogWithDropdown
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    ) : null;
  }
  render(<Harness />);

  await user.click(screen.getByRole("button", { name: "打开下拉" }));
  expect(screen.getByRole("listbox", { name: "测试下拉" })).toBeInTheDocument();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox", { name: "测试下拉" })).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "含下拉的对话框" })).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "打开下拉" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "含下拉的对话框" })).not.toBeInTheDocument();
});
