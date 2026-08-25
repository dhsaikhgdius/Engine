import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { AgentProvider } from "@director/agent-engine";

type VersionProbe = (command: string, args: readonly string[], options: { stdio: "ignore"; timeout: number }) => Pick<
  SpawnSyncReturns<Buffer>,
  "status"
>;

/**
 * Probe used by local Codex/Claude profiles.
 *
 * `--version` is a blocking spawn (up to 3s per missing CLI). Availability is
 * snapshotted at gateway start so `GET /api/agent/profiles` does not spawn on
 * every request.
 */
export function commandAvailable(command: string, spawn: VersionProbe = spawnSync) {
  const result = spawn(command, ["--version"], { stdio: "ignore", timeout: 3_000 });
  return result.status === 0;
}

/**
 * Returns which Agent providers the gateway can advertise as available.
 *
 * Hosted `api` is always listed; Codex/Claude follow `CODEX_CLI_COMMAND` /
 * `CLAUDE_CLI_COMMAND` (defaulting to `codex` / `claude` on PATH).
 */
export function probeLocalAgentCliAvailability(
  environment: NodeJS.ProcessEnv = process.env,
  spawn: VersionProbe = spawnSync,
): Record<AgentProvider, boolean> {
  return {
    api: true,
    codex: commandAvailable(environment.CODEX_CLI_COMMAND?.trim() || "codex", spawn),
    claude: commandAvailable(environment.CLAUDE_CLI_COMMAND?.trim() || "claude", spawn),
  };
}

