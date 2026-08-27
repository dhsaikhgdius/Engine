import * as pty from "node-pty";
import { WebSocket } from "ws";
import type { TerminalMessage } from "./gatewaySchemas";

/**
 * PTY-backed terminal sessions for the in-browser agent CLI panel. Each
 * websocket owns at most one PTY (opening a new one closes the previous),
 * and output is micro-batched before being sent so fast-scrolling CLIs do
 * not flood the socket with per-byte frames. PTY interactions race against
 * process exit by design; those races are absorbed rather than surfaced,
 * since a dead terminal is a normal terminal state.
 */

type TerminalInputMessage = Extract<TerminalMessage, { type: "term.open" | "term.input" | "term.resize" }>;

/** Launch spec for one supported agent CLI. */
interface TerminalSpec {
  command: string;
  args: string[];
}

interface TerminalSession {
  terminal: pty.IPty;
  cancelOutputBatch: () => void;
  flushOutputBatch: () => void;
}

/** Output batching window and the byte threshold that flushes early. */
const TERMINAL_OUTPUT_BATCH_MS = 16;
const TERMINAL_OUTPUT_BATCH_MAX_BYTES = 64 * 1024;

function terminalSize(value: number, fallback: number) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function colorTerminalEnvironment(environment: NodeJS.ProcessEnv) {
  const terminalEnvironment = Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  // The gateway itself can be launched from a non-interactive, colorless
  // shell (Codex currently exports TERM=dumb + NO_COLOR=1). Those values do
  // not describe the xterm.js PTY we are creating, so do not leak them into
  // interactive agent CLIs.
  delete terminalEnvironment.NO_COLOR;
  terminalEnvironment.TERM = "xterm-256color";
  terminalEnvironment.COLORTERM = "truecolor";
  terminalEnvironment.CLICOLOR = "1";
  terminalEnvironment.CLICOLOR_FORCE = "1";
  terminalEnvironment.FORCE_COLOR = "3";
  return terminalEnvironment;
}

/** Owns PTY lifecycle and websocket transport independently from HTTP routing. */
export class TerminalSessionManager {
  private readonly sessions = new Map<WebSocket, TerminalSession>();
  private readonly agents = new Map<string, TerminalSpec>([
    ["codex", { command: "codex", args: ["--no-alt-screen"] }],
    ["claude", { command: "claude", args: [] }],
  ]);

  constructor(
    private readonly workspaceRoot: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Tears down the client's PTY (if any); safe to call repeatedly. */
  close(client: WebSocket) {
    const session = this.sessions.get(client);
    if (!session) return;
    this.sessions.delete(client);
    session.cancelOutputBatch();
    try {
      session.terminal.kill();
    } catch {
      // Expected race: the process may have exited before websocket cleanup.
    }
  }

  /** Dispatches one validated terminal message from the websocket. */
  handle(client: WebSocket, message: TerminalInputMessage) {
    if (message.type === "term.open") {
      const error = this.open(client, message.agent, message.cols, message.rows);
      if (error && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "term.error", message: error }));
      }
      return;
    }
    const session = this.sessions.get(client);
    if (!session) return;
    const terminal = session.terminal;
    if (message.type === "term.input") {
      try {
        terminal.write(message.data);
      } catch {
        // Expected race: pty.write can arrive after onExit removed the process.
      }
      return;
    }
    try {
      terminal.resize(terminalSize(message.cols, 80), terminalSize(message.rows, 24));
    } catch {
      // Expected race: resizing an exited PTY has no observable effect.
    }
  }

  /**
   * Spawns the agent CLI in a fresh PTY, replacing any previous session on
   * this socket. Returns a user-facing error string instead of throwing so
   * the caller can forward it as a `term.error` message; a missing binary is
   * distinguished from other launch failures.
   */
  private open(client: WebSocket, agent: string, cols: number, rows: number): string | null {
    this.close(client);
    const spec = this.agents.get(agent);
    if (!spec) return `未知的 agent：${agent}`;
    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(spec.command, spec.args, {
        name: "xterm-256color",
        cols: terminalSize(cols, 80),
        rows: terminalSize(rows, 24),
        cwd: this.workspaceRoot,
        env: colorTerminalEnvironment(this.environment),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return /ENOENT|not found|command not found/i.test(message)
        ? `${spec.command} CLI 未安装或不在 PATH 中`
        : `无法启动 ${spec.command}：${message}`;
    }
    let pendingOutput = "";
    let outputTimer: ReturnType<typeof setTimeout> | null = null;
    const flushOutputBatch = () => {
      outputTimer = null;
      if (!pendingOutput) return;
      const data = pendingOutput;
      pendingOutput = "";
      if (this.sessions.get(client)?.terminal === terminal && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "term.output", data }));
      }
    };
    const cancelOutputBatch = () => {
      if (outputTimer !== null) {
        clearTimeout(outputTimer);
        outputTimer = null;
      }
      pendingOutput = "";
    };
    // Coalesce output for up to one batching window, flushing immediately
    // when the pending buffer crosses the byte threshold.
    const queueOutput = (data: string) => {
      pendingOutput += data;
      if (pendingOutput.length >= TERMINAL_OUTPUT_BATCH_MAX_BYTES) {
        if (outputTimer !== null) {
          clearTimeout(outputTimer);
          outputTimer = null;
        }
        flushOutputBatch();
        return;
      }
      if (outputTimer === null) outputTimer = setTimeout(flushOutputBatch, TERMINAL_OUTPUT_BATCH_MS);
    };
    const session: TerminalSession = { terminal, cancelOutputBatch, flushOutputBatch };
    this.sessions.set(client, session);
    terminal.onData((data) => {
      if (this.sessions.get(client)?.terminal === terminal && client.readyState === WebSocket.OPEN) queueOutput(data);
    });
    terminal.onExit(({ exitCode }) => {
      if (this.sessions.get(client)?.terminal !== terminal) return;
      session.flushOutputBatch();
      this.sessions.delete(client);
      session.cancelOutputBatch();
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "term.exit", exitCode }));
    });
    return null;
  }
}
