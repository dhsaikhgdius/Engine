import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  closeFilmRunPhaseReceipts,
  filmRunIdSchema,
  filmRunSchema,
  type FilmRun,
} from "../../../packages/protocol/src/filmPipelineProtocol";
import type {
  FilmRunArtifactStoragePresence,
  FilmRunSceneVideoStoragePresence,
  ProjectFilmRunReceiptOptions,
} from "../../../packages/protocol/src/filmRunReceipt";
import { writeJsonAtomic } from "../atomicJsonFile";

/**
 * Durable film run documents with per-id serialized update locking.
 * Media artifacts (portraits, frames, clips) live beside each run under
 * `film-runs/<id>/`; the JSON document only carries state, plans and
 * workspace paths.
 */
export class FilmRunStore {
  private readonly directory: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(dataDirectory: string) {
    this.directory = resolve(dataDirectory, "film-runs");
  }

  /** Returns the absolute path to the run's media artifact directory. */
  runDirectory(id: string) {
    if (!filmRunIdSchema.safeParse(id).success) throw new Error(`Invalid film run id ${id}`);
    return resolve(this.directory, id);
  }

  /**
   * Persists a new film run document.
   *
   * @param run - The validated film run to create.
   * @returns The persisted run.
   */
  async create(run: FilmRun) {
    const parsed = filmRunSchema.parse(run);
    await this.write(parsed);
    return parsed;
  }

  /**
   * Reads a film run by id.
   *
   * @param id - The film run id.
   * @returns The run document, or null when it does not exist or is unreadable.
   */
  async get(id: string) {
    if (!filmRunIdSchema.safeParse(id).success) return null;
    try {
      return filmRunSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch {
      return null;
    }
  }

  /**
   * Lists recent film runs, newest first.
   *
   * @param limit - Maximum number of runs to return (default 50).
   */
  async list(limit = 50) {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith(".json")).slice(0, 500);
    const runs = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return runs
      .filter((run): run is FilmRun => Boolean(run))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  /**
   * Atomically transforms a film run. Updates are serialized per id so
   * concurrent writers never lose a transition.
   *
   * @param id - The film run id.
   * @param transform - A pure function that receives the current run and returns the next state.
   * @returns The transformed run.
   * @throws When the run does not exist.
   */
  async update(id: string, transform: (run: FilmRun) => FilmRun | Promise<FilmRun>) {
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
      if (!current) throw new Error(`Unknown film run ${id}`);
      const next = filmRunSchema.parse({ ...(await transform(current)), updatedAt: new Date().toISOString() });
      await this.write(next);
      return next;
    } finally {
      resolveLock();
      if (this.locks.get(id) === chain) this.locks.delete(id);
    }
  }

  /**
   * Marks a run cancelled unless it already completed, closing any open
   * phase receipt. This is a pure store transition: it needs no configured
   * providers, so stale runs stay controllable on an unconfigured gateway.
   *
   * @param id - The film run id.
   * @returns The run after the transition.
   * @throws When the run does not exist.
   */
  async markCancelled(id: string) {
    return this.update(id, (run) =>
      run.status === "completed"
        ? run
        : {
            ...run,
            status: "cancelled",
            phaseReceipts: closeFilmRunPhaseReceipts(run.phaseReceipts, new Date().toISOString()),
          },
    );
  }

  /**
   * Probes whether the bytes behind the run's claimed artifact paths still
   * exist on disk. Disk cleanup, `.runtime` wipes, or manual deletion can age
   * bytes out while the run document keeps the path claim; live receipt reads
   * pass this to `projectFilmRunReceipt` so every control surface reports
   * honest `storagePresence` instead of trusting the stored paths (mirrors
   * `ProductionJobStore.artifactBytesPresent`).
   *
   * @param run - The durable film run document.
   * @returns Probe verdicts for each claimed path; unclaimed paths are omitted.
   */
  async artifactStoragePresence(
    run: FilmRun,
  ): Promise<NonNullable<ProjectFilmRunReceiptOptions["artifactStoragePresence"]>> {
    const [finalVideo, timeline, sceneProbes] = await Promise.all([
      this.pathBytesPresent(run.finalVideoPath),
      this.pathBytesPresent(run.timelinePath),
      // Scene videoPath claims back renderedSceneCount and the
      // resume/assemble checkpoints, so their bytes are probed too.
      Promise.all(
        run.scenes.map(
          async (scene): Promise<{ sceneIdx: number; presence: FilmRunArtifactStoragePresence | null }> => ({
            sceneIdx: scene.idx,
            presence: await this.pathBytesPresent(scene.videoPath),
          }),
        ),
      ),
    ]);
    const sceneVideos = sceneProbes.filter(
      (probe): probe is FilmRunSceneVideoStoragePresence => probe.presence !== null,
    );
    return {
      ...(finalVideo === null ? {} : { finalVideo }),
      ...(timeline === null ? {} : { timeline }),
      ...(sceneVideos.length === 0 ? {} : { sceneVideos }),
    };
  }

  /**
   * Marks runs left `queued`/`running` by a previous gateway process as
   * failed with the stable `film_run_interrupted` code, so restart survivors
   * report an explicit state instead of appearing to run forever. Callers
   * must invoke this before any execution starts in the current process.
   *
   * @returns The ids of the runs that were transitioned.
   */
  async reconcileInterrupted(): Promise<string[]> {
    const runs = await this.list(500);
    const interrupted: string[] = [];
    for (const run of runs) {
      if (run.status !== "queued" && run.status !== "running") continue;
      await this.update(run.id, (current) => {
        if (current.status !== "queued" && current.status !== "running") return current;
        const at = new Date().toISOString();
        return {
          ...current,
          status: "failed",
          error: "Film run interrupted by a gateway restart; resume continues from the last durable artifact",
          errorCode: "film_run_interrupted",
          phaseReceipts: closeFilmRunPhaseReceipts(current.phaseReceipts, at),
          events: [
            ...current.events,
            { at, stage: "reconcile", message: "Run interrupted by a gateway restart" },
          ].slice(-200),
        };
      });
      interrupted.push(run.id);
    }
    return interrupted;
  }

  private async pathBytesPresent(path: string | null): Promise<FilmRunArtifactStoragePresence | null> {
    if (path === null) return null;
    try {
      await access(path);
      return "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
  }

  private path(id: string) {
    return resolve(this.directory, `${id}.json`);
  }

  private async write(run: FilmRun) {
    await writeJsonAtomic(this.path(run.id), run);
  }
}
