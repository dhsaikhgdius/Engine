import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { InspectorSelectField } from "../../../../src/comprehensive/editor/panels/InspectorControls";

function SelectHarness({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("b");
  return (
    <InspectorSelectField
      ariaLabel="测试选择"
      label="测试"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    >
      <option value="a">选项 A</option>
      <option value="b">选项 B</option>
      <option value="c" disabled>
        选项 C
      </option>
      <option value="d">选项 D</option>
    </InspectorSelectField>
  );
}

it("moves focus onto the selected option when the listbox opens", async () => {
  const user = userEvent.setup();
  render(<SelectHarness />);

  await user.click(screen.getByRole("button", { name: "测试选择" }));

  expect(screen.getByRole("listbox", { name: "测试选择" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "选项 B" })).toHaveFocus();
});

it("opens from the trigger with ArrowDown and navigates with arrows, Home and End", async () => {
  const user = userEvent.setup();
  render(<SelectHarness />);
  const trigger = screen.getByRole("button", { name: "测试选择" });

  trigger.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "选项 B" })).toHaveFocus();

  // 禁用项（选项 C）被跳过，到底后回绕。
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "选项 D" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "选项 A" })).toHaveFocus();

  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("option", { name: "选项 D" })).toHaveFocus();

  await user.keyboard("{Home}");
  expect(screen.getByRole("option", { name: "选项 A" })).toHaveFocus();
  await user.keyboard("{End}");
  expect(screen.getByRole("option", { name: "选项 D" })).toHaveFocus();
});

it("selects the focused option with Enter and returns focus to the trigger", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SelectHarness onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "测试选择" });

  await user.click(trigger);
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith("d");
  expect(screen.queryByRole("listbox", { name: "测试选择" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveTextContent("选项 D");
});

it("selects the focused option with Space", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SelectHarness onChange={onChange} />);

  await user.click(screen.getByRole("button", { name: "测试选择" }));
  await user.keyboard("{Home}");
  await user.keyboard(" ");

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("listbox", { name: "测试选择" })).not.toBeInTheDocument();
});

it("closes on Escape without selecting and restores trigger focus", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SelectHarness onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "测试选择" });

  await user.click(trigger);
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{Escape}");

  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox", { name: "测试选择" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps mouse selection working and returns focus to the trigger", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SelectHarness onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "测试选择" });

  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "选项 A" }));

  expect(onChange).toHaveBeenCalledWith("a");
  expect(screen.queryByRole("listbox", { name: "测试选择" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("ignores clicks on disabled options", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SelectHarness onChange={onChange} />);

  await user.click(screen.getByRole("button", { name: "测试选择" }));
  await user.click(screen.getByRole("option", { name: "选项 C" }));

  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox", { name: "测试选择" })).toBeInTheDocument();
});
