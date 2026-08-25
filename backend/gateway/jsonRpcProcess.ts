import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { SPAWN_IN_OWN_PROCESS_GROUP, terminateChildProcess } from "./processTermination";

type JsonRpcId = string | number;
type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

/**
 * Manages the lifecycle of a child process that speaks JSON-RPC over stdio.
 *
 * Supports request/response with timeouts, fire-and-forget notifications,
 * inbound request handling, stderr forwarding, and graceful shutdown.
 */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: ReturnType<typeof createInterface> | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly notificationListeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly stderrListeners = new Set<(text: string) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();

  /**
   * Creates a new JSON-RPC process wrapper.
   *
   * @param command - The executable to spawn.
   * @param args - Arguments to pass to the executable.
   * @param cwd - Working directory for the child process.
   * @param env - Environment variables for the child process.
   * @param stopGraceMs - Grace period in milliseconds before force-killing during stop.
   */
  constructor(
    readonly command: string,
    readonly args: string[],
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv = process.env,
    private readonly stopGraceMs = 1_000,
  ) {}

  /**
   * Spawns the child process and begins reading its stdout line-by-line.
   *
   * Idempotent: calling start on an already-running process is a no-op.
   */
  start() {
    if (this.child) return;
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: SPAWN_IN_OWN_PROCESS_GROUP,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    this.lineReader = lines;
    lines.on("line", (line) => {
      if (this.child === child) this.handleLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      const text = chunk.toString();
      for (const listener of this.stderrListeners) listener(text);
    });
    child.stdin.on("error", (error) => {
      if (this.child !== child) return;
      this.fail(error, child);
      void terminateChildProcess(child, { termGraceMs: this.stopGraceMs });
    });
    child.on("error", (error) => this.fail(error, child));
    child.on("close", (code, signal) => {
      this.fail(new Error(`${this.command} RPC process exited (${code ?? signal ?? "unknown"})`), child);
    });
  }

  /**
   * Sends a JSON-RPC request and returns a promise that resolves with the
   * response result or rejects on timeout.
   *
   * @param method - The RPC method name.
   * @param params - Optional parameters for the method.
   * @param timeoutMs - Timeout in milliseconds before the request is rejected.
   * @returns The response result, typed as T.
   * @throws When the request times out or the process is not writable.
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        const pendingError = error instanceof Error ? error : new Error(String(error));
        pending?.reject(pendingError);
      }
    });
  }

  /**
   * Sends a JSON-RPC notification (no response expected).
   *
   * @param method - The RPC method name.
   * @param params - Optional parameters for the method.
   */
  notify(method: string, params?: unknown) {
    this.start();
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * Sends a success response for an inbound request.
   *
   * @param id - The request id to respond to.
   * @param result - The result payload.
   */
  respond(id: JsonRpcId, result: unknown) {
    this.write({ id, result });
  }

  /**
   * Sends an error response for an inbound request.
   *
   * @param id - The request id to respond to.
   * @param message - Human-readable error message.
   * @param code - JSON-RPC error code, defaults to -32603 (internal error).
   */
  respondError(id: JsonRpcId, message: string, code = -32603) {
    this.write({ id, error: { code, message } });
  }

  /**
   * Registers a listener for inbound JSON-RPC requests.
   *
   * @param listener - Called for every request message received from the child.
   * @returns A function that unregisters the listener.
   */
  onRequest(listener: (message: JsonRpcMessage) => void) {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  /**
   * Registers a listener for inbound JSON-RPC notifications.
   *
   * @param listener - Called for every notification message received from the child.
   * @returns A function that unregisters the listener.
   */
  onNotification(listener: (message: JsonRpcMessage) => void) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /**
   * Registers a listener for child process stderr output.
   *
   * @param listener - Called with each chunk of stderr text.
   * @returns A function that unregisters the listener.
   */
  onStderr(listener: (text: string) => void) {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  /**
   * Registers a listener that fires when the child process exits unexpectedly.
   *
   * @param listener - Called with the error describing the exit reason.
   * @returns A function that unregisters the listener.
   */
  onExit(listener: (error: Error) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Gracefully stops the child process, rejecting all pending requests.
   *
   * Sends a term signal first, then force-kills after the grace period.
   *
   * @returns A promise that resolves when the process has exited.
   */
  stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.lineReader?.close();
    this.lineReader = null;
    const stopped = new Error(`${this.command} RPC process stopped`);
    for (const pending of this.pending.values()) pending.reject(stopped);
    this.pending.clear();
    if (!child) return Promise.resolve();
    return terminateChildProcess(child, { termGraceMs: this.stopGraceMs });
  }

  private write(message: JsonRpcMessage) {
    if (!this.child?.stdin.writable) throw new Error(`${this.command} RPC stdin is not writable`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      for (const listener of this.stderrListeners) listener(`Invalid JSON-RPC line: ${line}`);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `RPC request ${String(message.id)} failed`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const listeners = message.id !== undefined ? this.requestListeners : this.notificationListeners;
    for (const listener of listeners) listener(message);
  }

  private fail(error: Error, child?: ChildProcessWithoutNullStreams) {
    if (child && this.child !== child) return;
    if (!this.child && !this.pending.size) return;
    this.child = null;
    this.lineReader?.close();
    this.lineReader = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.exitListeners) listener(error);
  }
}
