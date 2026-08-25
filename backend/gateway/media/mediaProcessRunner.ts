import { spawn, type ChildProcess } from "node:child_process";

export interface MediaProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Head of stdout, capped so a misbehaving tool cannot exhaust memory. */
  stdout: string;
  /** Tail of stderr; the most recent lines carry the actionable ffmpeg error. */
  stderr: string;
  timedOut: boolean;
}

export interface MediaProcessOptions {
  timeoutMs: number;
  /** How long a timed-out process may ignore SIGTERM before SIGKILL. */
  killGracePeriodMs?: number;
  maxStdoutChars?: number;
  maxStderrChars?: number;
  /** Extra environment entries merged over process.env (e.g. PYTHONPATH). */
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Injected into the media transcode executor so tests can substitute a fake
 * runner; only this module ever spawns real ffmpeg/ffprobe processes.
 */
export type MediaProcessRunner = (
  command: string,
  args: readonly string[],
  options: MediaProcessOptions,
) => Promise<MediaProcessResult>;

const DEFAULT_KILL_GRACE_PERIOD_MS = 3_000;
const DEFAULT_MAX_STDOUT_CHARS = 4_000_000;
const DEFAULT_MAX_STDERR_CHARS = 16_000;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The child is detached so it leads its own process group; signalling the
    // group also terminates any helpers ffmpeg spawned.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export const runMediaProcess: MediaProcessRunner = (command, args, options) => {
  const killGracePeriodMs = options.killGracePeriodMs ?? DEFAULT_KILL_GRACE_PERIOD_MS;
  const maxStdoutChars = options.maxStdoutChars ?? DEFAULT_MAX_STDOUT_CHARS;
  const maxStderrChars = options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS;
  return new Promise<MediaProcessResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        signalGroup(child, "SIGTERM");
        killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), killGracePeriodMs);
        killTimer.unref();
      },
      Math.max(1, options.timeoutMs),
    );
    const settle = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < maxStdoutChars) stdout = `${stdout}${chunk}`.slice(0, maxStdoutChars);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-maxStderrChars);
    });
    child.once("error", (error) => {
      settle();
      // ENOENT and friends surface unchanged so the executor can turn a
      // missing binary into a configuration error naming the env var.
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      settle();
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
};
