/*
 * Shared terminal session logic: owns the xterm instance + gateway WebSocket
 * and the term.* protocol (open/input/resize/output/exit/error). Used by both
 * the floating TerminalAssistantPanel and the embedded sidebar terminal.
 */
import { DIRECTOR_AGENT_IDS, type DirectorAgentId } from "@director/agent-engine";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import {
  updateDirectorSessionRuntime,
  useDirectorSessionRuntime,
} from "../comprehensive/editor/session/directorSessionRuntime";
import { bootstrapDirectorAgent, clearDirectorAgentClient } from "../comprehensive/editor/assistant/agentGatewayClient";
import terminalTheme from "./terminalTheme.json";

/** Supported local CLI identities — same ids as the gateway planner/PTY surface. */
export type AgentId = DirectorAgentId;

const TERMINAL_AGENT_LABELS: Record<DirectorAgentId, string> = {
  codex: "Codex",
  claude: "Claude",
};

/** Available agent CLI options presented in the terminal tab bar. */
export const TERMINAL_AGENTS: { id: AgentId; label: string }[] = DIRECTOR_AGENT_IDS.map((id) => ({
  id,
  label: TERMINAL_AGENT_LABELS[id],
}));

type SocketMessage =
  | { type: "term.output"; data: string }
  | { type: "term.exit"; exitCode: number }
  | { type: "term.error"; message: string }
  | { type: string; [key: string]: unknown };

/** Terminal color theme applied to the xterm instance. */
export const TERMINAL_THEME = terminalTheme;

const SEMANTIC_COLOR_CLASS = "director-terminal-semantic-color";
const SEMANTIC_COLOR_PROPERTY = "--director-terminal-semantic-color";
const SEMANTIC_WEIGHT_PROPERTY = "--director-terminal-semantic-weight";

/** Semantic color and weight to apply to an otherwise unstyled terminal span. */
export type TerminalSemanticStyle = {
  color: string;
  fontWeight?: "600" | "700";
};

/**
 * Codex and Claude sometimes render their full-screen UI without ANSI color,
 * even inside a truecolor PTY. Add restrained semantic accents only to those
 * otherwise unstyled spans; genuine ANSI foreground colors always win.
 */
export function getTerminalSemanticStyle(
  text: string,
  className = "",
  hasInlineColor = false,
): TerminalSemanticStyle | null {
  const value = text.trim();
  if (!value || hasInlineColor || /(?:^|\s)xterm-fg-\d+(?:\s|$)/.test(className)) return null;

  if (/\b(?:error|failed|failure|invalid|denied|fatal)\b/i.test(value)) {
    return { color: TERMINAL_THEME.red };
  }
  if (/^(?:⚠|warning\b|warn\b)/i.test(value)) {
    return { color: TERMINAL_THEME.brightYellow };
  }
  if (/^(?:OpenAI Codex|Codex)$/i.test(value)) {
    return { color: TERMINAL_THEME.cursor, fontWeight: "700" };
  }
  if (/^(?:Claude Code|Claude)$/i.test(value)) {
    return { color: TERMINAL_THEME.brightMagenta, fontWeight: "700" };
  }
  if (/^(?:Tip:|Hint:)/i.test(value)) {
    return { color: TERMINAL_THEME.yellow, fontWeight: "700" };
  }
  if (/^[›❯>$]$/.test(value)) {
    return { color: TERMINAL_THEME.green, fontWeight: "700" };
  }
  if (/^(?:gpt-|claude-|o\d|codex-)/i.test(value) || /\bgpt-[\w.-]+/i.test(value)) {
    return { color: TERMINAL_THEME.brightBlue };
  }
  if (/^(?:~\/|\/Users\/|\/workspace\b)/.test(value) || /(?:\s|[·•])~\//.test(value)) {
    return { color: TERMINAL_THEME.cyan };
  }
  if (/^\/[a-z][\w-]*/i.test(value) || /\s\/[a-z][\w-]*/i.test(value)) {
    return { color: TERMINAL_THEME.magenta };
  }
  if (/\b(?:ready|connected|success|completed)\b/i.test(value)) {
    return { color: TERMINAL_THEME.green };
  }
  return null;
}

/**
 * Applies semantic color classes to every span in the terminal rows.
 *
 * @param root - The DOM subtree containing `.xterm-rows` spans.
 */
export function applyTerminalSemanticColors(root: ParentNode) {
  applyTerminalSemanticColorsToSpans(root.querySelectorAll<HTMLSpanElement>(".xterm-rows span"));
}

/**
 * Applies semantic color classes to a pre-collected set of terminal spans.
 *
 * @param spans - Iterable of `<span>` elements inside `.xterm-rows`.
 */
export function applyTerminalSemanticColorsToSpans(spans: Iterable<HTMLSpanElement>) {
  for (const span of spans) {
    const style = getTerminalSemanticStyle(span.textContent ?? "", span.className, Boolean(span.style.color));
    span.classList.toggle(SEMANTIC_COLOR_CLASS, style !== null);
    if (style) {
      span.style.setProperty(SEMANTIC_COLOR_PROPERTY, style.color);
      if (style.fontWeight) span.style.setProperty(SEMANTIC_WEIGHT_PROPERTY, style.fontWeight);
      else span.style.removeProperty(SEMANTIC_WEIGHT_PROPERTY);
    } else {
      span.style.removeProperty(SEMANTIC_COLOR_PROPERTY);
      span.style.removeProperty(SEMANTIC_WEIGHT_PROPERTY);
    }
  }
}

function addTerminalSemanticSpan(node: Node, root: HTMLElement, spans: Set<HTMLSpanElement>) {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.nodeType === Node.TEXT_NODE
        ? node.parentElement
        : null;
  const span = element?.closest<HTMLSpanElement>(".xterm-rows span");
  if (span && root.contains(span)) spans.add(span);
}

function addAddedTerminalSemanticSpans(node: Node, root: HTMLElement, spans: Set<HTMLSpanElement>) {
  addTerminalSemanticSpan(node, root, spans);
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const span of (node as Element).querySelectorAll<HTMLSpanElement>("span")) {
    if (span.closest(".xterm-rows") && root.contains(span)) spans.add(span);
  }
}

/**
 * Collects the set of terminal spans that need semantic color re-evaluation
 * after a batch of DOM mutations.
 *
 * @param mutations - MutationObserver records from the terminal container.
 * @param root - The terminal host element.
 * @returns A set of `<span>` elements to re-style.
 */
export function collectTerminalSemanticColorTargets(mutations: Iterable<MutationRecord>, root: HTMLElement) {
  const spans = new Set<HTMLSpanElement>();
  for (const mutation of mutations) {
    if (mutation.type === "characterData") {
      addTerminalSemanticSpan(mutation.target, root, spans);
      continue;
    }
    if (mutation.type !== "childList") continue;
    addTerminalSemanticSpan(mutation.target, root, spans);
    for (const node of mutation.addedNodes) {
      addAddedTerminalSemanticSpans(node, root, spans);
    }
  }
  return spans;
}

const connectedTerminalSockets = new Set<WebSocket>();

function publishGatewayConnecting() {
  if (connectedTerminalSockets.size > 0) return;
  updateDirectorSessionRuntime({ gateway: "connecting", mcp: "connecting" });
}

function publishGatewayConnected(socket: WebSocket) {
  connectedTerminalSockets.add(socket);
  updateDirectorSessionRuntime({
    gateway: "connected",
    mcp: "connected",
    comfyui: "connected",
    codex: "ready",
  });
}

function publishGatewayDisconnected(socket: WebSocket | null) {
  if (socket) connectedTerminalSockets.delete(socket);
  if (connectedTerminalSockets.size > 0) return;
  updateDirectorSessionRuntime({
    gateway: "disconnected",
    mcp: "disconnected",
    comfyui: "disconnected",
    codex: "unavailable",
  });
}

/**
 * Maps an internal connection state value to a human-readable Chinese label.
 *
 * @param value - The connection state string.
 * @returns A Chinese status label.
 */
export function stateLabel(value: string) {
  if (value === "connected" || value === "ready") return "已连接";
  if (value === "connecting") return "连接中";
  if (value === "not-logged-in") return "未登录";
  if (value === "missing") return "未安装";
  if (value === "unavailable") return "不可用";
  if (value === "unknown") return "检查中";
  return "未连接";
}

/**
 * The complete public API surface returned by {@link useTerminalSession}.
 *
 * Consumers receive a stable reference to the terminal host ref plus
 * reactive state (banner, connection status, agent selection) and
 * imperative actions (switch, restart, clear, focus).
 */
export interface TerminalSession {
  /** Ref to attach to the terminal's host `<div>`. */
  termHostRef: React.RefObject<HTMLDivElement>;
  /** Current overlay banner text, or null when the terminal is running. */
  banner: string | null;
  /** Whether the banner represents an error state. */
  bannerError: boolean;
  /** Whether the WebSocket is reconnecting. */
  reconnecting: boolean;
  /** Gateway connection state. */
  gateway: string;
  /** MCP server connection state. */
  mcp: string;
  /** ComfyUI connection state. */
  comfyui: string;
  /** Codex CLI availability state. */
  codex: string;
  /** Currently selected agent CLI. */
  agent: AgentId;
  /** Lifecycle state of the PTY session. */
  terminalStatus: "connecting" | "starting" | "ready" | "exited" | "error";
  /** Switch to a different agent CLI, re-opening the PTY. */
  switchAgent: (next: AgentId) => void;
  /** Restart the current PTY session. */
  restartTerminal: () => void;
  /** Clear the terminal buffer and reset cursor. */
  clearTerminal: () => void;
  /** Focus the underlying xterm instance. */
  focusTerminal: () => void;
}

/**
 * React hook that owns the xterm instance, the gateway WebSocket, and the
 * `term.*` protocol (open/input/resize/output/exit/error).
 *
 * Used by both the floating {@link DirectorAssistantPanel} and the embedded
 * sidebar terminal.
 *
 * @param hostRef - A ref attached to the `<div>` that will host the terminal.
 * @returns A {@link TerminalSession} with reactive state and imperative actions.
 */
export function useTerminalSession(hostRef: React.RefObject<HTMLDivElement>): TerminalSession {
  const mcp = useDirectorSessionRuntime((state) => state.mcp);
  const comfyui = useDirectorSessionRuntime((state) => state.comfyui);
  const codex = useDirectorSessionRuntime((state) => state.codex);
  const [gateway, setGateway] = useState("connecting");
  const [agent, setAgent] = useState<AgentId>("codex");
  const [banner, setBanner] = useState<string | null>(null);
  const [bannerError, setBannerError] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<TerminalSession["terminalStatus"]>("connecting");
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const agentRef = useRef<AgentId>("codex");
  const openedRef = useRef(false);
  const fitFrameRef = useRef<number | null>(null);
  const lastSentDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const terminalFontSizeRef = useRef(11);
  const terminalOutputBufferRef = useRef("");
  const terminalOutputFrameRef = useRef<number | null>(null);

  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);

  function writeBanner(message: string | null, isError = false) {
    setBanner(message);
    setBannerError(isError);
  }

  function flushTerminalOutput() {
    terminalOutputFrameRef.current = null;
    const output = terminalOutputBufferRef.current;
    terminalOutputBufferRef.current = "";
    if (output) termRef.current?.write(output);
  }

  function scheduleTerminalOutput(output: string) {
    terminalOutputBufferRef.current += output;
    if (terminalOutputFrameRef.current !== null) return;
    terminalOutputFrameRef.current = window.requestAnimationFrame(flushTerminalOutput);
  }

  function cancelPendingTerminalOutput() {
    if (terminalOutputFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalOutputFrameRef.current);
      terminalOutputFrameRef.current = null;
    }
    terminalOutputBufferRef.current = "";
  }

  function scheduleFit(focus = false) {
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      try {
        fitRef.current?.fit();
      } catch {
        // A hidden or transitioning panel will be fitted by its next resize.
      }
      if (focus) termRef.current?.focus();
    });
  }

  function mountTerminal() {
    if (termRef.current || !hostRef.current) return;
    const term = new Terminal({
      fontFamily: '"SFMono-Regular", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace',
      fontSize: terminalFontSizeRef.current,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.3,
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (webglRef.current === webgl) webglRef.current = null;
      });
      webglRef.current = webgl;
    } catch {
      // The DOM renderer remains a safe fallback when WebGL is unavailable.
    }
    termRef.current = term;
    fitRef.current = fit;
    // Keep xterm's hot rendering path self-contained. A MutationObserver that
    // restyles every newly-rendered span makes full-screen PTY redraws pay for
    // a second DOM pass and can make the terminal look like it is flickering.
    scheduleFit(true);
    term.onData((data) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "term.input", data }));
      }
    });
    term.onResize(({ cols, rows }) => {
      const socket = socketRef.current;
      const previous = lastSentDimensionsRef.current;
      if (previous?.cols === cols && previous.rows === rows) return;
      lastSentDimensionsRef.current = { cols, rows };
      if (openedRef.current && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "term.resize", cols, rows }));
      }
    });
  }

  function disposeTerminal() {
    const term = termRef.current;
    termRef.current = null;
    fitRef.current = null;
    const webgl = webglRef.current;
    webglRef.current = null;
    cancelPendingTerminalOutput();
    openedRef.current = false;
    lastSentDimensionsRef.current = null;
    if (fitFrameRef.current !== null) {
      window.cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    }
    try {
      webgl?.dispose();
      term?.dispose();
    } catch {
      // Dispose after re-open can race with xterm internals.
    }
  }

  function requestOpen(socket: WebSocket, agentId: AgentId) {
    const term = termRef.current;
    const fit = fitRef.current;
    let cols = 80;
    let rows = 24;
    try {
      const dims = fit?.proposeDimensions();
      if (dims && Number.isSafeInteger(dims.cols) && Number.isSafeInteger(dims.rows)) {
        cols = dims.cols;
        rows = dims.rows;
      }
    } catch {
      // Fall back to defaults if the terminal hasn't been laid out yet.
    }
    openedRef.current = false;
    setTerminalStatus("starting");
    writeBanner(`正在启动 ${agentId}…`);
    cancelPendingTerminalOutput();
    term?.reset();
    lastSentDimensionsRef.current = { cols, rows };
    socket.send(JSON.stringify({ type: "term.open", agent: agentId, cols, rows }));
    openedRef.current = true;
    scheduleFit(true);
  }

  useEffect(() => {
    const gatewayUrl = import.meta.env.VITE_STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787";
    const wsUrl = gatewayUrl.replace(/^http/, "ws") + "/ws";
    let stopped = false;
    let reconnectTimer: number | undefined;

    async function connect() {
      if (stopped) return;
      setTerminalStatus("connecting");
      setGateway("connecting");
      publishGatewayConnecting();
      let browserToken: string;
      try {
        browserToken = (await bootstrapDirectorAgent()).browserToken;
      } catch {
        if (!stopped) reconnectTimer = window.setTimeout(() => void connect(), 1500);
        return;
      }
      if (stopped) return;
      const authenticatedUrl = new URL(wsUrl);
      authenticatedUrl.searchParams.set("browser_token", browserToken);
      const socket = new WebSocket(authenticatedUrl);
      let opened = false;
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (stopped) return;
        opened = true;
        setGateway("connected");
        publishGatewayConnected(socket);
        setReconnecting(false);
        mountTerminal();
        if (termRef.current) requestOpen(socket, agentRef.current);
      });

      socket.addEventListener("message", (event) => {
        let message: SocketMessage;
        try {
          message = JSON.parse(String(event.data)) as SocketMessage;
        } catch {
          return;
        }
        if (message.type === "term.output" && typeof message.data === "string") {
          scheduleTerminalOutput(message.data);
          setBanner((current) => (current === null ? current : null));
          setTerminalStatus("ready");
        } else if (message.type === "term.exit" && typeof message.exitCode === "number") {
          writeBanner(`${agentRef.current} 进程已退出（exit ${message.exitCode}）`, true);
          openedRef.current = false;
          setTerminalStatus("exited");
        } else if (message.type === "term.error" && typeof message.message === "string") {
          writeBanner(message.message, true);
          openedRef.current = false;
          setTerminalStatus("error");
        }
      });

      socket.addEventListener("close", () => {
        if (stopped) return;
        if (!opened) clearDirectorAgentClient();
        setGateway("disconnected");
        publishGatewayDisconnected(socket);
        setReconnecting(true);
        setTerminalStatus("connecting");
        writeBanner("Gateway 连接已中断，正在重试…", true);
        window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => void connect(), 1500);
      });

      socket.addEventListener("error", () => socket.close());
    }

    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      publishGatewayDisconnected(socket);
      try {
        socket?.close();
      } catch {
        // Closing an already-closed socket is a no-op.
      }
      disposeTerminal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coalesce layout observations into one fit per animation frame. Calling
  // FitAddon synchronously from ResizeObserver can otherwise create a
  // resize -> terminal resize -> layout feedback loop in narrow sidebars.
  useEffect(() => {
    let lastWidth = -1;
    let lastHeight = -1;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const width = Math.round(rect?.width ?? hostRef.current?.clientWidth ?? 0);
      const height = Math.round(rect?.height ?? hostRef.current?.clientHeight ?? 0);
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      const nextFontSize = width > 0 && width < 380 ? 10 : 11;
      if (nextFontSize !== terminalFontSizeRef.current) {
        terminalFontSizeRef.current = nextFontSize;
        if (termRef.current) termRef.current.options.fontSize = nextFontSize;
      }
      scheduleFit();
    });
    if (hostRef.current) observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
  }, [hostRef]);

  function switchAgent(next: AgentId) {
    if (next === agent) return;
    setAgent(next);
    agentRef.current = next;
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      requestOpen(socket, next);
    }
  }

  function restartTerminal() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      writeBanner("Gateway 尚未连接；会在连接恢复后自动可用。", true);
      return;
    }
    requestOpen(socket, agentRef.current);
  }

  function clearTerminal() {
    const term = termRef.current;
    if (!term) return;
    term.clear();
    term.write("\u001b[2J\u001b[H");
    term.focus();
  }

  function focusTerminal() {
    termRef.current?.focus();
  }

  return {
    termHostRef: hostRef as React.RefObject<HTMLDivElement>,
    banner,
    bannerError,
    reconnecting,
    gateway,
    mcp,
    comfyui,
    codex,
    agent,
    terminalStatus,
    switchAgent,
    restartTerminal,
    clearTerminal,
    focusTerminal,
  };
}
