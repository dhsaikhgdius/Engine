import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorShortcuts, openDirectorEditorShortcuts } from "../../../../src/comprehensive/editor/keyboard/EditorShortcuts";

describe("EditorShortcuts", () => {
  it("lists the full video editor bindings grouped by workspace", () => {
    render(<EditorShortcuts workspace="video" />);
    act(() => openDirectorEditorShortcuts());

    const dialog = screen.getByRole("dialog", { name: "键盘快捷键" });
    expect(dialog).toHaveTextContent("通用");
    expect(dialog).toHaveTextContent("视频编辑器");
    expect(dialog).toHaveTextContent("显示 / 关闭快捷键面板");
    expect(dialog).toHaveTextContent("播放 / 暂停");
    expect(dialog).toHaveTextContent("复制所选剪辑副本");
    expect(dialog).toHaveTextContent("波纹删除剪辑");
    expect(dialog).toHaveTextContent("在播放头处分割");
    expect(dialog).toHaveTextContent("逐帧微移所选剪辑");
    expect(dialog).toHaveTextContent("按 1 秒移动播放头");
    expect(dialog).toHaveTextContent("Home · End");
  });

  it("keeps the stage clipboard and viewport rows", () => {
    render(<EditorShortcuts workspace="stage" />);
    act(() => openDirectorEditorShortcuts());

    const dialog = screen.getByRole("dialog", { name: "键盘快捷键" });
    expect(dialog).toHaveTextContent("复制所选对象");
    expect(dialog).toHaveTextContent("W · A · S · D · Q · E");
    expect(dialog).toHaveTextContent("方向键转视角");
    expect(dialog).toHaveTextContent("← · → · ↑ · ↓");
  });

  it("toggles with Shift+/ outside editable fields", () => {
    render(<EditorShortcuts workspace="stage" />);

    fireEvent.keyDown(window, { key: "?", code: "Slash", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "?", code: "Slash", shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });

  it("ignores Shift+/ while typing in an input", () => {
    render(
      <>
        <input aria-label="剪辑名称" />
        <EditorShortcuts workspace="video" />
      </>,
    );
    const input = screen.getByLabelText("剪辑名称");
    input.focus();

    fireEvent.keyDown(input, { key: "?", code: "Slash", shiftKey: true });

    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });

  it("opens from the help menu event and closes with Escape", () => {
    render(<EditorShortcuts workspace="canvas" />);

    act(() => openDirectorEditorShortcuts());
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).not.toBeInTheDocument();
  });
});
