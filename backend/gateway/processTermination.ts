import { spawn, type ChildProcess } from "node:child_process";

/** POSIX children are placed in their own group so descendants inherit a killable boundary. */
export const SPAWN_IN_OWN_PROCESS_GROUP = process.platform !== "win32";

function signalWindowsProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return false;
  try {
    const args = ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallback = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // The direct child also exited while taskkill was running.
      }
    };
    killer.on("error", fallback);
    killer.on("exit", (code) => {
      if (code !== 0) fallback();
    });
    killer.unref();
    return true;
  } catch {
    return false;
  }
}

/** Sends a signal to the whole spawned process tree when the platform supports it. */
export function signalChildProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (SPAWN_IN_OWN_PROCESS_GROUP && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The group may already have exited; fall through to the direct child.
    }
  } else if (process.platform === "win32" && signalWindowsProcessTree(child, signal)) {
    return true;
  }
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function destroyChildIo(child: ChildProcess) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function posixProcessGroupExists(child: ChildProcess) {
  if (!SPAWN_IN_OWN_PROCESS_GROUP || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminates a child tree and always settles, even when a descendant inherited
 * one of the child's stdio descriptors and therefore prevents `close`.
 */
export function terminateChildProcess(
  child: ChildProcess,
  options: { termGraceMs: number; closeGraceMs?: number },
): Promise<void> {
  const termGraceMs = Math.max(0, options.termGraceMs);
  const closeGraceMs = Math.max(0, options.closeGraceMs ?? 1_000);

  return new Promise((resolve) => {
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;
    let onError = () => {};
    let onClose = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      destroyChildIo(child);
      resolve();
    };
    onError = () => {
      if ((child.exitCode !== null || child.signalCode !== null) && !posixProcessGroupExists(child)) finish();
    };
    onClose = () => {
      // `close` only proves that the direct child's stdio is closed. A detached
      // descendant can still be alive in the process group while ignoring TERM.
      if (!posixProcessGroupExists(child)) finish();
    };
    child.once("close", onClose);
    child.on("error", onError);

    if (
      (child.exitCode !== null || child.signalCode !== null) &&
      (!SPAWN_IN_OWN_PROCESS_GROUP || !posixProcessGroupExists(child))
    ) {
      finish();
      return;
    }

    signalChildProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      signalChildProcessTree(child, "SIGKILL");
      forceSettleTimer = setTimeout(finish, closeGraceMs);
    }, termGraceMs);
  });
}
