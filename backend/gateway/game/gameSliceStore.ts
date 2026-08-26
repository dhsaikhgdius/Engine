import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  gameSliceIdSchema,
  gameSliceSchema,
  type GameSlice,
} from "../../../packages/protocol/src/gameSliceProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";

/**
 * Durable game-slice documents under `game-slices/<id>.json`, modeled on
 * {@link ../film/filmRunStore.FilmRunStore}: atomic JSON writes plus per-id
 * serialized locking so concurrent writers never lose a transition. The
 * `director_game` machine owns slice semantics; this store only persists what
 * the reducer produced.
 */
export class GameSliceStore {
  private readonly directory: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, "game-slices");
  }

  /**
   * Persists one slice document (create or overwrite), serialized per id.
   *
   * @param slice - The slice produced by the `director_game` reducer.
   * @returns The validated persisted slice.
   */
  async put(slice: GameSlice) {
    const parsed = gameSliceSchema.parse(slice);
    await this.withLock(parsed.id, () => writeJsonAtomic(this.path(parsed.id), parsed));
    return parsed;
  }

  /**
   * Reads one slice by id.
   *
   * @param id - The game slice id.
   * @returns The slice document, or null when it does not exist or is unreadable.
   */
  async get(id: string) {
    if (!gameSliceIdSchema.safeParse(id).success) return null;
    try {
      return gameSliceSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * Loads every readable slice document. Unreadable or invalid files are
   * skipped, never deleted. The result seeds `createDirectorGameState`.
   */
  async loadAll() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).slice(0, 500);
    const slices = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return slices.filter((slice): slice is GameSlice => Boolean(slice));
  }

  /**
   * Atomically transforms one slice. Updates are serialized per id so
   * concurrent writers never lose a transition.
   *
   * @param id - The game slice id.
   * @param transform - A pure function that receives the current slice and returns the next state.
   * @returns The transformed slice.
   * @throws When the slice does not exist.
   */
  async update(id: string, transform: (slice: GameSlice) => GameSlice | Promise<GameSlice>) {
    return this.withLock(id, async () => {
      const current = await this.get(id);
      if (!current) throw new Error(`Unknown game slice ${id}`);
      const next = gameSliceSchema.parse({ ...(await transform(current)), updated_at: new Date().toISOString() });
      await writeJsonAtomic(this.path(next.id), next);
      return next;
    });
  }

  private path(id: string) {
    if (!gameSliceIdSchema.safeParse(id).success) throw new Error(`Invalid game slice id ${id}`);
    return resolve(this.directory, `${id}.json`);
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let resolveLock!: () => void;
    const currentLock = new Promise<void>((resolveCurrent) => {
      resolveLock = resolveCurrent;
    });
    const chain = previous.then(() => currentLock);
    this.locks.set(id, chain);
    await previous;
    try {
      return await fn();
    } finally {
      resolveLock();
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }
}
