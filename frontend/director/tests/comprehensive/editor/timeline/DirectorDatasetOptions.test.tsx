import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import type { DirectorMultimodalFrameExportSelection } from "../../../../src/comprehensive/editor/video/multimodalFrameExport";
import { DirectorDatasetOptions } from "../../../../src/comprehensive/editor/timeline/DirectorDatasetOptions";

function Harness({
  disabled = false,
  initial,
}: {
  disabled?: boolean;
  initial?: DirectorMultimodalFrameExportSelection;
}) {
  const [selection, setSelection] = useState<DirectorMultimodalFrameExportSelection>(
    initial ?? { renderPasses: ["clean"], includeCamera: true, includeObjects: true },
  );
  return <DirectorDatasetOptions disabled={disabled} onChange={setSelection} selection={selection} />;
}

it("keeps a compact panel name instead of concatenating every channel into the fieldset", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("数据选项"));

  expect(screen.getByRole("group", { name: "数据导出选项" })).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: /clean clay albedo/ })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "导出 albedo" })).toBeInTheDocument();
  expect(screen.getByText("反照率")).toBeInTheDocument();
  expect(screen.getByText("光流 EXR")).toBeInTheDocument();
});

it("keeps the last remaining image channel checked", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("数据选项"));

  fireEvent.click(screen.getByRole("checkbox", { name: "导出 clean" }));
  expect(screen.getByRole("checkbox", { name: "导出 clean" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "导出 clean" })).toBeDisabled();
});

it("applies clean-only and select-all presets without dropping per-frame flags", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("数据选项"));

  fireEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(screen.getByRole("checkbox", { name: "导出 motion" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "导出相机参数" })).toBeChecked();

  fireEvent.click(screen.getByRole("checkbox", { name: "导出 depth 米制 EXR" }));
  expect(screen.getByRole("checkbox", { name: "导出 depth 米制 EXR" })).toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "仅干净" }));

  expect(screen.getByRole("checkbox", { name: "导出 clean" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "导出 depth" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "导出 depth 米制 EXR" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "导出 depth 米制 EXR" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "导出对象状态" })).toBeChecked();
});

it("closes the panel on Escape", () => {
  render(<Harness />);
  const details = screen.getByText("数据选项").closest("details");
  fireEvent.click(screen.getByText("数据选项"));
  expect(details).toHaveAttribute("open");

  fireEvent.keyDown(document, { key: "Escape" });
  expect(details).not.toHaveAttribute("open");
});
