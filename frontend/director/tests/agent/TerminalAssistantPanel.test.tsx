import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { resetDirectorSessionRuntime } from "../../src/comprehensive/editor/session/directorSessionRuntime";

// xterm cannot render in jsdom (no canvas/real layout). Mock Terminal + FitAddon
// with a tiny shim that records calls so we can assert the term.* protocol.
const termMocks = vi.hoisted(() => {
  const instance = {
    writes: [] as string[],
    writeCallbacks: [] as Array<(() => void) | undefined>,
    resets: 0,
    clears: 0,
    focuses: 0,
    onDataCallback: null as ((d: string) => void) | null,
    onResizeCallback: null as ((e: { cols: number; rows: number }) => void) | null,
    onData(cb: (d: string) => void) {
      instance.onDataCallback = cb;
    },
    onResize(cb: (e: { cols: number; rows: number }) => void) {
      instance.onResizeCallback = cb;
    },
    loadAddon: vi.fn(),
    open: vi.fn(),
    reset() {
      instance.resets += 1;
    },
    clear() {
      instance.clears += 1;
    },
    focus() {
      instance.focuses += 1;
    },
    write(data: string, callback?: () => void) {
      instance.writes.push(data);
      instance.writeCallbacks.push(callback);
    },
    dispose: vi.fn(),
  };
  // `new Terminal()` returns the shared instance; callCount tracks construction.
  function TerminalCtor(this: unknown, _options?: unknown) {
    (TerminalCtor as unknown as { calls: number }).calls += 1;
    return instance;
  }
  (TerminalCtor as unknown as { calls: number }).calls = 0;
  function FitAddonCtor(this: unknown) {
    return { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) };
  }
  return {
    instance,
    Terminal: TerminalCtor,
    FitAddon: FitAddonCtor,
  };
});

const gatewayMocks = vi.hoisted(() => ({
  bootstrapDirectorAgent: vi.fn(async () => ({ browserToken: "terminal-test-browser-token-0001" })),
  clearDirectorAgentClient: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: termMocks.Terminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: termMocks.FitAddon,
}));

vi.mock("../../src/comprehensive/editor/assistant/agentGatewayClient", () => gatewayMocks);

// Fake WebSocket that captures sent messages and lets tests push inbound frames.
type Sent = { type: string; [key: string]: unknown };
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  sent: Sent[] = [];
  listeners: Record<string, EventListener[]> = {};
  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.last = this;
  }
  addEventListener(type: string, listener: EventListener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw) as Sent);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  emit(type: string, detail?: unknown) {
    for (const l of this.listeners[type] ?? []) {
      l(new Event(type) as unknown as { data?: unknown } & Event);
    }
  }
  // Test helper: deliver an inbound JSON frame as a MessageEvent-like object.
  receive(payload: unknown) {
    for (const l of this.listeners["message"] ?? []) {
      l({ data: JSON.stringify(payload) } as unknown as Event);
    }
  }
  // Test helper: simulate the server accepting the connection.
  open() {
    this.readyState = 1;
    this.emit("open");
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket);
// ResizeObserver is absent in jsdom.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  },
);

import { DirectorAssistantPanel } from "../../src/agent/TerminalAssistantPanel";

beforeEach(() => {
  resetDirectorSessionRuntime();
  termMocks.instance.writes = [];
  termMocks.instance.writeCallbacks = [];
  termMocks.instance.resets = 0;
  termMocks.instance.clears = 0;
  termMocks.instance.focuses = 0;
  termMocks.instance.onDataCallback = null;
  termMocks.instance.onResizeCallback = null;
  gatewayMocks.bootstrapDirectorAgent.mockClear();
  gatewayMocks.clearDirectorAgentClient.mockClear();
  FakeWebSocket.last = null;
});

async function waitForLastSocket() {
  await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
  return FakeWebSocket.last!;
}

async function openLastSocket() {
  const socket = await waitForLastSocket();
  await act(async () => {
    socket.open();
  });
  return socket;
}

it("opens the gateway socket and sends term.open for the default agent on connect", async () => {
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);

  const socket = await openLastSocket();
  const socketUrl = new URL(socket.url);
  expect(socketUrl.pathname).toBe("/ws");
  expect(socketUrl.searchParams.get("browser_token")).toBe("terminal-test-browser-token-0001");
  expect(gatewayMocks.bootstrapDirectorAgent).toHaveBeenCalledTimes(1);

  const opened = socket.sent.find((m) => m.type === "term.open");
  expect(opened).toBeTruthy();
  expect(opened?.agent).toBe("codex");
  expect(opened?.cols).toBe(80);
  expect(opened?.rows).toBe(24);
});

it("forwards keystrokes as term.input and writes term.output to the terminal surface", async () => {
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  const socket = await openLastSocket();

  // mountTerminal runs inside the open handler; give it a tick if needed.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(termMocks.instance.onDataCallback).not.toBeNull();
  // Simulate user typing: invoke the xterm onData callback the panel registered.
  termMocks.instance.onDataCallback?.("ls\r");

  expect(socket.sent).toContainEqual({ type: "term.input", data: "ls\r" });

  // Server streams output back; the panel should write it to the terminal.
  await act(async () => {
    socket.receive({ type: "term.output", data: "hello\n" });
  });
  await waitFor(() => expect(termMocks.instance.writes).toContain("hello\n"));
  expect(termMocks.instance.writes).toContain("hello\n");
  expect(termMocks.instance.writeCallbacks.at(-1)).toBeUndefined();
});

it("switching to claude sends a fresh term.open and clears the surface", async () => {
  const user = userEvent.setup();
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  const socket = await openLastSocket();
  termMocks.instance.writes = [];
  socket.sent = [];

  await act(async () => {
    await user.click(screen.getByRole("tab", { name: "Claude" }));
  });

  const opened = socket.sent.find((m) => m.type === "term.open");
  expect(opened?.agent).toBe("claude");
  expect(termMocks.instance.resets).toBeGreaterThan(0);
});

it("surfaces a term.error as an error banner without throwing", async () => {
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  const socket = await openLastSocket();

  await act(async () => {
    socket.receive({ type: "term.error", message: "codex CLI 未安装或不在 PATH 中" });
  });

  expect(await screen.findByText("codex CLI 未安装或不在 PATH 中")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "从错误状态重新启动 codex" })).toBeEnabled();
});

it("waits for an explicit retry after a terminal process exits", async () => {
  const user = userEvent.setup();
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  const socket = await openLastSocket();
  socket.sent = [];

  await act(async () => {
    socket.receive({ type: "term.exit", exitCode: 0 });
  });

  expect(await screen.findByText("codex 进程已退出（exit 0）")).toBeInTheDocument();
  expect(socket.sent).not.toContainEqual(expect.objectContaining({ type: "term.open" }));

  await user.click(screen.getByRole("button", { name: "从错误状态重新启动 codex" }));
  expect(socket.sent).toContainEqual(expect.objectContaining({ type: "term.open", agent: "codex" }));
});

it("keeps clear and restart controls available without corrupting the PTY session", async () => {
  const user = userEvent.setup();
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  const socket = await openLastSocket();
  socket.sent = [];
  termMocks.instance.writes = [];

  await user.click(screen.getByRole("button", { name: "清空终端" }));
  expect(termMocks.instance.clears).toBe(1);
  expect(termMocks.instance.writes).toContain("\u001b[2J\u001b[H");
  expect(termMocks.instance.focuses).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "重新启动 codex" }));
  expect(socket.sent).toContainEqual(expect.objectContaining({ type: "term.open", agent: "codex" }));
});

it("deduplicates identical terminal resize messages", async () => {
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  const socket = await openLastSocket();
  socket.sent = [];

  termMocks.instance.onResizeCallback?.({ cols: 100, rows: 30 });
  termMocks.instance.onResizeCallback?.({ cols: 100, rows: 30 });

  expect(socket.sent.filter((message) => message.type === "term.resize")).toEqual([
    { type: "term.resize", cols: 100, rows: 30 },
  ]);
});

it("renders the connection status quartet from the session runtime", async () => {
  render(<DirectorAssistantPanel offset={{ x: 0, y: 0 }} onClose={vi.fn()} onOffsetChange={vi.fn()} />);
  await openLastSocket();

  expect(screen.getByText("Gateway 已连接")).toBeInTheDocument();
  expect(screen.getByText("Codex 已连接")).toBeInTheDocument();
  expect(screen.getByText("MCP 已连接")).toBeInTheDocument();
  expect(screen.getByText("ComfyUI 已连接")).toBeInTheDocument();
});

it("lets the embedded terminal split vertically into a second independent pane", async () => {
  const user = userEvent.setup();
  const sockets: FakeWebSocket[] = [];
  const Original = FakeWebSocket;
  class TrackingSocket extends Original {
    constructor(url: string | URL) {
      super(url);
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", TrackingSocket);

  const { EmbeddedTerminalPanel } = await import("../../src/agent/TerminalAssistantPanel");
  render(<EmbeddedTerminalPanel />);

  await waitFor(() => expect(sockets).toHaveLength(1));

  expect(screen.getByRole("button", { name: "上下切分终端" })).toBeInTheDocument();
  expect(screen.queryByRole("separator", { name: "拖动调整终端高度" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "上下切分终端" }));

  await waitFor(() => expect(sockets).toHaveLength(2));

  expect(screen.getAllByRole("tablist", { name: "选择 CLI" })).toHaveLength(2);
  expect(screen.getByRole("separator", { name: "拖动调整终端高度" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭此终端" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "上下切分终端" })).not.toBeInTheDocument();
  expect(sockets).toHaveLength(2);

  await act(async () => {
    sockets.forEach((socket) => socket.open());
  });

  await user.click(screen.getByRole("button", { name: "关闭此终端" }));
  expect(screen.getAllByRole("tablist", { name: "选择 CLI" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "上下切分终端" })).toBeInTheDocument();
  expect(screen.queryByText("Gateway 已连接")).not.toBeInTheDocument();

  vi.stubGlobal("WebSocket", Original);
});
