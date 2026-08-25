/*
 * Terminal-style director panel: a real xterm surface that drives codex/claude
 * CLI via the gateway's PTY-over-WebSocket protocol (term.* messages on /ws).
 *
 * Two surfaces share the useTerminalSession hook:
 *  - DirectorAssistantPanel: floating top-right drawer (drag header, close).
 *  - EmbeddedTerminalPanel: fills its host container (sidebar slot), with an
 *    optional vertical split into two independent PTY sessions.
 */
import "./terminalAssistant.css";
import {
  Eraser,
  GripHorizontal,
  LoaderCircle,
  RotateCcw,
  SquareSplitVertical,
  Terminal as TerminalIcon,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useDirectorSessionRuntime } from "../comprehensive/editor/session/directorSessionRuntime";
import { stateLabel, TERMINAL_AGENTS, useTerminalSession, type AgentId } from "./useTerminalSession";

/** Pixel offset of the floating terminal panel relative to the viewport. */
export interface DirectorAssistantPanelOffset {
  x: number;
  y: number;
}

const PANEL_VIEWPORT_MARGIN = 8;
const COMPACT_PANEL_MAX_WIDTH = 720;
const SPLIT_MIN_RATIO = 0.22;
const SPLIT_MAX_RATIO = 0.78;

type PanelDragState = {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  baseLeft: number;
  baseTop: number;
  width: number;
  height: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  if (maximum < minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function terminalStatusLabel(status: ReturnType<typeof useTerminalSession>["terminalStatus"]) {
  if (status === "ready") return "运行中";
  if (status === "starting") return "启动中";
  if (status === "exited") return "已退出";
  if (status === "error") return "异常";
  return "连接中";
}

function AgentTabs({
  actions,
  embedded = false,
  session,
}: {
  actions?: ReactNode;
  embedded?: boolean;
  session: ReturnType<typeof useTerminalSession>;
}) {
  const { agent, switchAgent, terminalStatus } = session;
  // Healthy states stay a quiet dot in the embedded toolbar; failure states
  // spell themselves out — a lone red dot is too easy to miss in a sidebar.
  const attentionState = terminalStatus === "error" || terminalStatus === "exited";
  const compact = embedded && !attentionState;
  return (
    <div className={`director-agent-terminal-toolbar${embedded ? " is-embedded" : ""}`}>
      <div className="director-agent-terminal-toolbar-leading">
        <div className="director-agent-terminal-tabs" role="tablist" aria-label="选择 CLI">
          {TERMINAL_AGENTS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              type="button"
              aria-selected={agent === entry.id}
              className={`director-agent-terminal-tab${agent === entry.id ? " is-active" : ""}`}
              onClick={() => switchAgent(entry.id as AgentId)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span
          className={`director-agent-terminal-process-state${compact ? " is-compact" : ""}`}
          data-state={terminalStatus}
          title={compact ? terminalStatusLabel(terminalStatus) : undefined}
        >
          <span aria-hidden className="director-agent-terminal-state-dot" />
          {compact ? (
            <span className="director-agent-terminal-sr-only">{terminalStatusLabel(terminalStatus)}</span>
          ) : (
            terminalStatusLabel(terminalStatus)
          )}
        </span>
      </div>
      {actions ? <div className="director-agent-terminal-tab-actions">{actions}</div> : null}
    </div>
  );
}

function StatusQuartet({ session }: { session?: ReturnType<typeof useTerminalSession> }) {
  const runtimeGateway = useDirectorSessionRuntime((state) => state.gateway);
  const runtimeCodex = useDirectorSessionRuntime((state) => state.codex);
  const runtimeMcp = useDirectorSessionRuntime((state) => state.mcp);
  const runtimeComfyui = useDirectorSessionRuntime((state) => state.comfyui);
  const gateway = session?.gateway ?? runtimeGateway;
  const codex = session?.codex ?? runtimeCodex;
  const mcp = session?.mcp ?? runtimeMcp;
  const comfyui = session?.comfyui ?? runtimeComfyui;
  const environmentState = gateway === "connected" ? "connected" : gateway === "connecting" ? "connecting" : "error";
  return (
    <div className="director-agent-session-status" aria-label="连接状态">
      <span className="director-agent-session-title">
        <TerminalIcon aria-hidden size={13} strokeWidth={1.8} />
        <strong>Agent CLI</strong>
      </span>
      <span
        className="director-agent-session-summary"
        data-state={environmentState}
        title={`Gateway ${stateLabel(gateway)} · Codex ${stateLabel(codex)} · MCP ${stateLabel(mcp)} · ComfyUI ${stateLabel(comfyui)}`}
      >
        <span aria-hidden className="director-agent-session-dot" />
        {gateway === "connected" ? "运行环境已连接" : gateway === "connecting" ? "正在连接运行环境" : "运行环境不可用"}
      </span>
      <span className="director-agent-terminal-sr-only">Gateway {stateLabel(gateway)}</span>
      <span className="director-agent-terminal-sr-only">Codex {stateLabel(codex)}</span>
      <span className="director-agent-terminal-sr-only">MCP {stateLabel(mcp)}</span>
      <span className="director-agent-terminal-sr-only">ComfyUI {stateLabel(comfyui)}</span>
    </div>
  );
}

function TerminalSurface({
  embedded = false,
  session,
}: {
  embedded?: boolean;
  session: ReturnType<typeof useTerminalSession>;
}) {
  const { agent, banner, bannerError, focusTerminal, gateway, reconnecting, restartTerminal, termHostRef } = session;
  return (
    <div
      aria-label={`${agent} 终端窗口`}
      className={`director-agent-terminal${embedded ? " is-embedded-surface" : ""}${banner ? " has-banner" : ""}`}
      onPointerDown={focusTerminal}
      role="region"
    >
      <div className="director-agent-terminal-host" ref={termHostRef} />
      {banner && (
        <div className={`director-agent-terminal-banner${bannerError ? " is-error" : ""}`}>
          <div aria-hidden className="director-agent-terminal-banner-icon">
            {reconnecting ? (
              <LoaderCircle className="director-agent-spin" size={18} />
            ) : bannerError ? (
              <TriangleAlert size={18} />
            ) : (
              <span className="director-agent-terminal-pulse" />
            )}
          </div>
          <div className="director-agent-terminal-banner-copy">
            <strong>{banner}</strong>
            {bannerError ? (
              <button
                aria-label={`从错误状态重新启动 ${agent}`}
                disabled={gateway !== "connected"}
                onClick={restartTerminal}
                type="button"
              >
                重新启动 {agent}
              </button>
            ) : (
              <small>首次启动可能需要几秒钟</small>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TerminalPane({
  embedded = false,
  onClose,
  onSplit,
}: {
  embedded?: boolean;
  onClose?: () => void;
  onSplit?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useTerminalSession(hostRef);
  const { agent, clearTerminal, focusTerminal, gateway, restartTerminal } = session;
  return (
    <div className={`director-agent-terminal-pane${embedded ? " is-embedded" : ""}`}>
      <AgentTabs
        embedded={embedded}
        session={session}
        actions={
          <>
            <button
              aria-label="清空终端"
              className="director-agent-terminal-pane-action"
              onClick={clearTerminal}
              title="清空终端"
              type="button"
            >
              <Eraser aria-hidden size={14} strokeWidth={1.8} />
            </button>
            <button
              aria-label={`重新启动 ${agent}`}
              className="director-agent-terminal-pane-action"
              disabled={gateway !== "connected"}
              onClick={() => {
                restartTerminal();
                focusTerminal();
              }}
              title={`重新启动 ${agent}`}
              type="button"
            >
              <RotateCcw aria-hidden size={14} strokeWidth={1.8} />
            </button>
            {onSplit ? (
              <button
                aria-label="上下切分终端"
                className="director-agent-terminal-pane-action"
                onClick={onSplit}
                title="上下切分终端"
                type="button"
              >
                <SquareSplitVertical aria-hidden size={14} strokeWidth={1.8} />
              </button>
            ) : null}
            {onClose ? (
              <button
                aria-label="关闭此终端"
                className="director-agent-terminal-pane-action"
                onClick={onClose}
                title="关闭此终端"
                type="button"
              >
                <X aria-hidden size={14} strokeWidth={1.8} />
              </button>
            ) : null}
          </>
        }
      />
      <TerminalSurface embedded={embedded} session={session} />
    </div>
  );
}

/**
 * Embedded terminal panel that fills its host container.
 *
 * Supports an optional vertical split into two independent PTY sessions
 * with a draggable divider.
 */
export function EmbeddedTerminalPanel() {
  const splitRootRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [secondaryKey, setSecondaryKey] = useState(0);

  function beginSplitDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    if (!splitRootRef.current) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    setDraggingSplit(true);

    function move(ev: PointerEvent) {
      const activeRoot = splitRootRef.current;
      if (!activeRoot) return;
      const rect = activeRoot.getBoundingClientRect();
      if (rect.height <= 0) return;
      setSplitRatio(clamp((ev.clientY - rect.top) / rect.height, SPLIT_MIN_RATIO, SPLIT_MAX_RATIO));
    }

    function end(ev: PointerEvent) {
      setDraggingSplit(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      try {
        (ev.target as HTMLElement | null)?.releasePointerCapture?.(pointerId);
      } catch {
        // Capture may already be released.
      }
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  return (
    <div
      className={`director-agent-terminal-embedded${split ? " is-split" : ""}${draggingSplit ? " is-split-dragging" : ""}`}
    >
      <div className="director-agent-terminal-split-root" ref={splitRootRef}>
        <div
          className="director-agent-terminal-split-pane"
          style={split ? { flexBasis: `${splitRatio * 100}%` } : undefined}
        >
          <TerminalPane
            embedded
            onSplit={
              split
                ? undefined
                : () => {
                    setSecondaryKey((value) => value + 1);
                    setSplitRatio(0.5);
                    setSplit(true);
                  }
            }
          />
        </div>
        {split ? (
          <>
            <button
              aria-label="拖动调整终端高度"
              aria-orientation="horizontal"
              aria-valuemax={Math.round(SPLIT_MAX_RATIO * 100)}
              aria-valuemin={Math.round(SPLIT_MIN_RATIO * 100)}
              aria-valuenow={Math.round(splitRatio * 100)}
              className="director-agent-terminal-split-handle"
              onPointerDown={beginSplitDrag}
              role="separator"
              type="button"
            >
              <span className="director-agent-terminal-split-handle-grip" />
            </button>
            <div
              className="director-agent-terminal-split-pane is-secondary"
              style={{ flexBasis: `${(1 - splitRatio) * 100}%` }}
            >
              <TerminalPane embedded key={secondaryKey} onClose={() => setSplit(false)} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Floating terminal panel: a top-right drawer with a drag header and close
 * button that drives Codex or Claude CLI via the gateway's PTY-over-WebSocket
 * protocol.
 *
 * @param onClose - Called when the user clicks the close button.
 * @param offset - Current pixel offset from the viewport origin.
 * @param onOffsetChange - Called when the user drags the panel to a new position.
 */
export function DirectorAssistantPanel({
  onClose,
  offset,
  onOffsetChange,
}: {
  onClose: () => void;
  offset: DirectorAssistantPanelOffset;
  onOffsetChange: (offset: DirectorAssistantPanelOffset) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useTerminalSession(hostRef);
  const { gateway } = session;
  const panelRef = useRef<HTMLElement>(null);
  const dragStart = useRef<PanelDragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    function move(event: PointerEvent) {
      const start = dragStart.current;
      if (!start) return;
      onOffsetChange({
        x: clamp(
          start.originX + event.clientX - start.startX,
          PANEL_VIEWPORT_MARGIN - start.baseLeft,
          window.innerWidth - PANEL_VIEWPORT_MARGIN - start.width - start.baseLeft,
        ),
        y: clamp(
          start.originY + event.clientY - start.startY,
          PANEL_VIEWPORT_MARGIN - start.baseTop,
          window.innerHeight - PANEL_VIEWPORT_MARGIN - start.height - start.baseTop,
        ),
      });
    }
    function end() {
      dragStart.current = null;
      setDragging(false);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
  }, [dragging, onOffsetChange]);

  useEffect(() => {
    function keepPanelInViewport() {
      const panel = panelRef.current;
      if (!panel || window.innerWidth <= COMPACT_PANEL_MAX_WIDTH) return;
      const rect = panel.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const correctionX =
        rect.left < PANEL_VIEWPORT_MARGIN
          ? PANEL_VIEWPORT_MARGIN - rect.left
          : rect.right > window.innerWidth - PANEL_VIEWPORT_MARGIN
            ? window.innerWidth - PANEL_VIEWPORT_MARGIN - rect.right
            : 0;
      const correctionY =
        rect.top < PANEL_VIEWPORT_MARGIN
          ? PANEL_VIEWPORT_MARGIN - rect.top
          : rect.bottom > window.innerHeight - PANEL_VIEWPORT_MARGIN
            ? window.innerHeight - PANEL_VIEWPORT_MARGIN - rect.bottom
            : 0;
      if (correctionX !== 0 || correctionY !== 0) {
        onOffsetChange({ x: offset.x + correctionX, y: offset.y + correctionY });
      }
    }
    keepPanelInViewport();
    window.addEventListener("resize", keepPanelInViewport);
    return () => window.removeEventListener("resize", keepPanelInViewport);
  }, [offset, onOffsetChange]);

  return (
    <aside
      ref={panelRef}
      className={`director-agent-drawer is-terminal${dragging ? " is-dragging" : ""}`}
      aria-label="导演终端"
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
    >
      <header
        aria-label="拖动导演终端面板"
        className="director-agent-header"
        onPointerDown={(event) => {
          if (event.button !== 0 || window.innerWidth <= COMPACT_PANEL_MAX_WIDTH) return;
          if ((event.target as HTMLElement).closest("button, input, textarea, select, a")) return;
          const panel = panelRef.current;
          if (!panel) return;
          const rect = panel.getBoundingClientRect();
          event.preventDefault();
          dragStart.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
            baseLeft: rect.left - offset.x,
            baseTop: rect.top - offset.y,
            width: rect.width,
            height: rect.height,
          };
          setDragging(true);
        }}
        title="按住并拖动面板"
      >
        <div className="director-agent-heading">
          <span className="director-agent-logo">
            <TerminalIcon aria-hidden size={16} />
          </span>
          <span>
            <strong>导演终端</strong>
            <small data-status={gateway}>Agent Gateway {stateLabel(gateway)}</small>
          </span>
        </div>
        <div className="director-agent-header-actions">
          <GripHorizontal aria-hidden className="director-agent-drag-grip" size={16} />
          <button className="director-agent-icon-button" type="button" aria-label="关闭导演终端" onClick={onClose}>
            <X aria-hidden size={17} />
          </button>
        </div>
      </header>

      <StatusQuartet session={session} />
      <div className="director-agent-terminal-pane">
        <AgentTabs
          session={session}
          actions={
            <>
              <button
                aria-label="清空终端"
                className="director-agent-terminal-pane-action"
                onClick={session.clearTerminal}
                title="清空终端"
                type="button"
              >
                <Eraser aria-hidden size={14} strokeWidth={1.8} />
              </button>
              <button
                aria-label={`重新启动 ${session.agent}`}
                className="director-agent-terminal-pane-action"
                disabled={gateway !== "connected"}
                onClick={session.restartTerminal}
                title={`重新启动 ${session.agent}`}
                type="button"
              >
                <RotateCcw aria-hidden size={14} strokeWidth={1.8} />
              </button>
            </>
          }
        />
        <TerminalSurface session={session} />
      </div>
    </aside>
  );
}
