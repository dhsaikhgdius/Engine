import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { productionRunIdSchema, productionRunSchema, type ProductionRun } from "@director/agent-engine";
import { writeJsonAtomic } from "../atomicJsonFile";

/**
 * Persists and retrieves multi-agent production run records as JSON files
 * on disk, with per-run serialised mutation via a lock queue.
 */
export class MultiAgentRunStore {
  private readonly directory: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * Creates a new multi-agent run store.
   *
   * @param dataDirectory - The data directory under which runs are stored.
   */
  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, "multi-agent-runs");
  }

  /**
   * Creates and persists a new production run.
   *
   * @param run - The run record to persist.
   * @returns The validated and persisted run.
   */
  async create(run: ProductionRun) {
    const parsed = productionRunSchema.parse(run);
    await this.write(parsed);
    return parsed;
  }

  /**
   * Retrieves a production run by its identifier.
   *
   * @param id - The run identifier.
   * @returns The run record, or null if not found or invalid.
   */
  async get(id: string) {
    if (!productionRunIdSchema.safeParse(id).success) return null;
    try {
      return productionRunSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * Lists recent production runs, sorted by update time descending.
   *
   * @param limit - Maximum number of runs to return.
   * @returns An array of production runs, newest first.
   */
  async list(limit = 50) {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).slice(0, 500);
    const runs = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return runs
      .filter((run): run is ProductionRun => Boolean(run))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  /**
   * Updates a production run with a serialised transform, preventing
   * concurrent mutations on the same run.
   *
   * @param id - The run identifier.
   * @param transform - A function that receives the current run and returns the updated run.
   * @returns The updated and persisted run.
   * @throws When the run does not exist.
   */
  async update(id: string, transform: (run: ProductionRun) => ProductionRun | Promise<ProductionRun>) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let resolveLock!: () => void;
    const currentLock = new Promise<void>((resolveCurrent) => {
      resolveLock = resolveCurrent;
    });
    const chain = previous.then(() => currentLock);
    this.locks.set(id, chain);
    await previous;
    try {
      const current = await this.get(id);
      if (!current) throw new Error(`Unknown production run ${id}`);
      const next = productionRunSchema.parse({ ...(await transform(current)), updatedAt: new Date().toISOString() });
      await this.write(next);
      return next;
    } finally {
      resolveLock();
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }

  private path(id: string) {
    return resolve(this.directory, `${id}.json`);
  }

  private async write(run: ProductionRun) {
    await writeJsonAtomic(this.path(run.id), run);
  }
}
