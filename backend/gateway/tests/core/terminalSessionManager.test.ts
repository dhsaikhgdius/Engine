import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const ptyMocks = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type ExitHandler = (event: { exitCode: number }) => void;
  const terminals: Array<{
    data: DataHandler | null;
    exit: ExitHandler | null;
    kill: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }> = [];

  const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => {
    const terminal = {
      data: null as DataHandler | null,
      exit: null as ExitHandler | null,
      kill: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      onData(handler: DataHandler) {
        terminal.data = handler;
      },
      onExit(handler: ExitHandler) {
        terminal.exit = handler;
      },
    };
    terminals.push(terminal);
    return terminal;
  });

  return { spawn, terminals };
});

vi.mock("node-pty", () => ({ spawn: ptyMocks.spawn }));

import { TerminalSessionManager } from "../../terminalSessionManager";

function createClient() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket;
}

beforeEach(() => {
  vi.useFakeTimers();
  ptyMocks.spawn.mockClear();
  ptyMocks.terminals.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

it("suppresses stale output and exit events after switching agents", () => {
  const manager = new TerminalSessionManager("/workspace", {});
  const client = createClient();

  manager.handle(client, { type: "term.open", agent: "codex", cols: 80, rows: 24 });
  const codex = ptyMocks.terminals[0]!;
  manager.handle(client, { type: "term.open", agent: "claude", cols: 100, rows: 30 });
  const claude = ptyMocks.terminals[1]!;

  expect(codex.kill).toHaveBeenCalledOnce();
  codex.data?.("stale output");
  codex.exit?.({ exitCode: 0 });
  claude.data?.("current output");
  vi.advanceTimersByTime(16);

  expect(client.send).toHaveBeenCalledTimes(1);
  expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: "term.output", data: "current output" }));
});

it("coalesces a burst of PTY output into one websocket frame", () => {
  const manager = new TerminalSessionManager("/workspace", {});
  const client = createClient();

  manager.handle(client, { type: "term.open", agent: "codex", cols: 80, rows: 24 });
  const terminal = ptyMocks.terminals[0]!;
  terminal.data?.("first");
  terminal.data?.(" second");

  expect(client.send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);

  expect(client.send).toHaveBeenCalledOnce();
  expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: "term.output", data: "first second" }));
});

it("reports the active process exit exactly once", () => {
  const manager = new TerminalSessionManager("/workspace", {});
  const client = createClient();

  manager.handle(client, { type: "term.open", agent: "codex", cols: 80, rows: 24 });
  const terminal = ptyMocks.terminals[0]!;
  terminal.exit?.({ exitCode: 7 });
  terminal.exit?.({ exitCode: 7 });

  expect(client.send).toHaveBeenCalledOnce();
  expect(client.send).toHaveBeenCalledWith(JSON.stringify({ type: "term.exit", exitCode: 7 }));
});

it("describes the embedded PTY as a 256-color truecolor terminal", () => {
  const manager = new TerminalSessionManager("/workspace", {
    PATH: "/bin",
    TERM: "dumb",
    COLORTERM: "",
    NO_COLOR: "1",
  });
  const client = createClient();

  manager.handle(client, { type: "term.open", agent: "codex", cols: 80, rows: 24 });

  expect(ptyMocks.spawn).toHaveBeenCalledWith(
    "codex",
    ["--no-alt-screen"],
    expect.objectContaining({
      name: "xterm-256color",
      env: expect.objectContaining({
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        CLICOLOR: "1",
        CLICOLOR_FORCE: "1",
        FORCE_COLOR: "3",
      }),
    }),
  );
  const options = ptyMocks.spawn.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
  expect(options?.env).not.toHaveProperty("NO_COLOR");
});
