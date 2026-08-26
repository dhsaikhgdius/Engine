import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import {
  gamePlaytestTraceSchema,
  playerRole,
  type GamePlaytestTrace,
  type GameSlice,
} from "../../../packages/protocol/src/gameSliceProtocol";
import {
  createHostFreePlaytestRunner,
  hostFreePlaytestTimeoutMs,
} from "../../../packages/protocol/src/gamePlaytestHostFree";
import type { DirectorGameMachineContext } from "../../../packages/protocol/src/directorGameMachine";

/** Browser workbench command result shape used by the live playtest bridge. */
export type LiveWorkbenchCommandResult = {
  success: boolean;
  result?: unknown;
  error?: string;
} | null;

export type LiveStagePlaytestDependencies = {
  /**
   * Send a workbench operation to a connected Stage tab. Returns null when no
   * client is available.
   */
  requestWorkbenchCommand: (
    input: DirectorWorkbenchOperation,
    timeoutMs?: number,
  ) => Promise<LiveWorkbenchCommandResult>;
  /**
   * Fallback when no live tab is connected or the live tape fails. Defaults to
   * the shared host-free kinematic runner.
   */
  fallback?: DirectorGameMachineContext["runPlaytest"];
};

/**
 * Prefer a live Stage `game_playtest` tape; fall back to host-free kinematics
 * when no workbench tab is connected or the live receipt is unusable.
 */
export function createLiveStagePlaytestRunner(
  dependencies: LiveStagePlaytestDependencies,
): DirectorGameMachineContext["runPlaytest"] {
  const fallback = dependencies.fallback ?? createHostFreePlaytestRunner();

  return async ({ slice, operation }) => {
    const actorId = playerRole(slice)?.object_id;
    const timeoutMs = hostFreePlaytestTimeoutMs(operation.script);
    const remote = await dependencies.requestWorkbenchCommand(
      {
        op: "game_playtest",
        script: operation.script,
        ...(actorId ? { actor_id: actorId } : {}),
        slice_id: slice.id,
      },
      timeoutMs,
    );

    if (remote?.success) {
      const trace = extractPlaytestTrace(remote.result, slice);
      if (trace) return trace;
    }

    return fallback({ slice, operation });
  };
}

function extractPlaytestTrace(result: unknown, slice: GameSlice): GamePlaytestTrace | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const candidate = record.trace ?? result;
  const parsed = gamePlaytestTraceSchema.safeParse(candidate);
  if (!parsed.success) return null;
  if (parsed.data.slice_id !== slice.id) {
    return gamePlaytestTraceSchema.parse({ ...parsed.data, slice_id: slice.id });
  }
  return parsed.data;
}
