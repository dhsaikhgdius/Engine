import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResearchPortal from "../../src/research/ResearchPortal";

describe("ResearchPortal", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
  });

  it("renders the research home with a real protocol rather than a leaderboard", () => {
    window.history.replaceState({}, "", "/research");
    render(<ResearchPortal />);

    expect(screen.getByRole("heading", { name: /agent-native 3d stage/i })).toBeInTheDocument();
    expect(screen.getByText(/does not report fabricated benchmark scores/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open studio/i })).toHaveAttribute("href", "/");
  });

  it("opens the documentation route without leaving the portal", () => {
    window.history.replaceState({}, "", "/research");
    render(<ResearchPortal />);

    fireEvent.click(screen.getByRole("link", { name: /^documentation$/i }));

    expect(window.location.pathname).toBe("/research/docs");
    expect(screen.getByRole("heading", { name: /research documentation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reproduce/i })).toBeInTheDocument();
  });

  it("offers a Chinese reader-facing version", () => {
    window.history.replaceState({}, "", "/research");
    render(<ResearchPortal />);

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });

    expect(screen.getByRole("heading", { name: /面向可复现制作/i })).toBeInTheDocument();
  });

  it("initializes from the locale persisted by the main studio app", () => {
    window.localStorage.setItem("director.ui.locale", "zh-CN");
    window.history.replaceState({}, "", "/research");
    render(<ResearchPortal />);

    expect(screen.getByRole("heading", { name: /面向可复现制作/i })).toBeInTheDocument();
  });

  it("restores its own persisted locale when the studio key is absent", () => {
    window.localStorage.setItem("director.research.locale", "zh");
    window.history.replaceState({}, "", "/research");
    render(<ResearchPortal />);

    expect(screen.getByRole("heading", { name: /面向可复现制作/i })).toBeInTheDocument();
  });

  it("writes portal language switches back to the studio locale key", () => {
    window.history.replaceState({}, "", "/research");
    render(<ResearchPortal />);

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    expect(window.localStorage.getItem("director.ui.locale")).toBe("zh-CN");
    expect(window.localStorage.getItem("director.research.locale")).toBe("zh");

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "en" } });
    expect(window.localStorage.getItem("director.ui.locale")).toBe("en-US");
    expect(window.localStorage.getItem("director.research.locale")).toBe("en");
  });

  it("copies commands when browser clipboard access is available", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    window.history.replaceState({}, "", "/research/docs");
    render(<ResearchPortal />);

    fireEvent.click(screen.getByRole("button", { name: /reproduce/i }));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /copy/i })[0]);
      await Promise.resolve();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npm install");
  });
});
