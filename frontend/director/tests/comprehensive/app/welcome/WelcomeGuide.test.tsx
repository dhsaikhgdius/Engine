import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DIRECTOR_DOCS_URL, showDirectorWelcomeGuide, WELCOME_GUIDE_STORAGE_KEY, WelcomeGuide } from "../../../../src/comprehensive/app/welcome/WelcomeGuide";

describe("WelcomeGuide", () => {
  beforeEach(() => {
    window.localStorage.removeItem(WELCOME_GUIDE_STORAGE_KEY);
  });

  it("shows on first launch, focuses the primary action, and links the docs", () => {
    render(<WelcomeGuide />);

    const dialog = screen.getByRole("dialog", { name: "欢迎使用 Director" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("画布");
    expect(dialog).toHaveTextContent("3D 片场");
    expect(dialog).toHaveTextContent("视频编辑器");
    expect(screen.getByRole("link", { name: "查看文档" })).toHaveAttribute("href", DIRECTOR_DOCS_URL);
    expect(screen.getByRole("button", { name: "开始使用" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).toBe("1");
  });

  it("stays hidden after it has been dismissed once", () => {
    window.localStorage.setItem(WELCOME_GUIDE_STORAGE_KEY, "1");
    render(<WelcomeGuide />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never shows in ComfyUI embedded mode, even when asked to reopen", () => {
    render(<WelcomeGuide embedded />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => showDirectorWelcomeGuide());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes with Escape and reopens from the help entry", () => {
    render(<WelcomeGuide />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(WELCOME_GUIDE_STORAGE_KEY)).toBe("1");

    act(() => showDirectorWelcomeGuide());
    expect(screen.getByRole("dialog", { name: "欢迎使用 Director" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭欢迎引导" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
