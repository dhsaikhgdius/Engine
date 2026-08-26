import {
  createDirectorGameState,
  executeDirectorGame,
  type DirectorGameMachineContext,
} from "../../../packages/protocol/src/directorGameMachine";
import type { DirectorGameEnvelope } from "../../../packages/protocol/src/directorGameProtocol";
import { createHostFreePlaytestRunner } from "../../../packages/protocol/src/gamePlaytestHostFree";
import { GameSliceStore } from "./gameSliceStore";

/** Live `director_game` handle: the durable slice store plus one governed executor. */
export type DirectorGameRuntime = {
  /** Durable slice store; always readable. */
  store: GameSliceStore;
  /** Executes one `director_game` operation and persists any slice mutations. */
  execute: (input: unknown) => Promise<DirectorGameEnvelope>;
};

/** Optional integrations for {@link createDirectorGame}. */
export type DirectorGameOptions = {
  /** Clock override for deterministic tests. */
  now?: () => string;
  /** Slice id factory override for deterministic tests. */
  createId?: () => string;
  /**
   * Playtest tape driver. When omitted, Gateway defaults to the host-free
   * kinematic runner so `playtest` without an explicit `trace` still scores.
   * Pass `runPlaytest: undefined` via {@link DirectorGameOptions.disableHostFreePlaytest}
   * only in unit tests that assert `game_playtest_needs_stage`.
   */
  runPlaytest?: DirectorGameMachineContext["runPlaytest"];
  /**
   * When true, do not install the host-free default runner. Used by tests that
   * assert the bare-machine `game_playtest_needs_stage` corrective path.
   */
  disableHostFreePlaytest?: boolean;
};

/**
 * Wires the host-free `director_game` reducer to durable persistence: each
 * call loads the stored slices into `createDirectorGameState`, runs
 * `executeDirectorGame`, and writes back exactly the slices the reducer
 * replaced. Executions are serialized so concurrent HTTP calls never race the
 * load → reduce → persist cycle.
 *
 * Default playtest is the shared kinematic host-free runner. A live Stage
 * driver may wrap or replace it via {@link DirectorGameOptions.runPlaytest}.
 */
export function createDirectorGame(dataDirectory: string, options: DirectorGameOptions = {}): DirectorGameRuntime {
  const store = new GameSliceStore(dataDirectory);
  let chain: Promise<unknown> = Promise.resolve();
  const defaultRunner = options.disableHostFreePlaytest ? undefined : createHostFreePlaytestRunner();
  const runPlaytest = options.runPlaytest ?? defaultRunner;

  const execute = (input: unknown): Promise<DirectorGameEnvelope> => {
    const run = chain.then(async () => {
      const state = createDirectorGameState(await store.loadAll());
      // The reducer replaces a slice's object identity on every mutation, so
      // reference comparison finds exactly the documents to persist.
      const before = new Map(state.slices);
      const envelope = await executeDirectorGame(state, input, {
        now: options.now?.() ?? new Date().toISOString(),
        ...(options.createId ? { createId: options.createId } : {}),
        ...(runPlaytest ? { runPlaytest } : {}),
      });
      for (const [id, slice] of state.slices) {
        if (before.get(id) !== slice) await store.put(slice);
      }
      return envelope;
    });
    chain = run.catch(() => undefined);
    return run;
  };

  return { store, execute };
}
