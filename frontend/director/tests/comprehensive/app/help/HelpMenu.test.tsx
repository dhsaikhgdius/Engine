import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_SHORTCUTS_OPEN_EVENT } from "../../../../src/comprehensive/editor/keyboard/EditorShortcuts";
import { DIRECTOR_DOCS_URL } from "../../../../src/comprehensive/app/welcome/WelcomeGuide";
import { HelpMenu } from "../../../../src/comprehensive/app/help/HelpMenu";

describe("HelpMenu", () => {
  const shortcutsListener = vi.fn();

  beforeEach(() => {
    shortcutsListener.mockClear();
    window.addEventListener(EDITOR_SHORTCUTS_OPEN_EVENT, shortcutsListener);
  });

  afterEach(() => {
    window.removeEventListener(EDITOR_SHORTCUTS_OPEN_EVENT, shortcutsListener);
  });

  it("links the local docs site from the dropdown", () => {
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));

    const menu = screen.getByRole("menu", { name: "帮助菜单" });
    const docsLink = within(menu).getByRole("menuitem", { name: /打开文档/ });
    expect(docsLink).toHaveAttribute("href", DIRECTOR_DOCS_URL);
    expect(docsLink).toHaveAttribute("target", "_blank");
  });

  it("opens the shortcuts panel through a window event", () => {
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /键盘快捷键/ }));
    expect(shortcutsListener).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes with Escape", () => {
    render(<HelpMenu />);
    fireEvent.click(screen.getByRole("button", { name: "帮助" }));
    expect(screen.getByRole("menu", { name: "帮助菜单" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
