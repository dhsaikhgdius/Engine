import { readFile, rename } from "node:fs/promises";
import { z } from "zod";
import type { DirectorProject } from "@director/project-schema";
import {
  productionRecordSchema,
  productionSceneProjectRecordSchema,
  type DirectorProductionSceneSeed as ProductionSceneSeed,
  type DirectorProductionSceneProjectRecord as ProductionSceneProjectRecord,
  type ProductionRecord,
} from "../../../packages/protocol/src/directorProductionProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";

export { productionSceneProjectRecordSchema };
export type { ProductionSceneProjectRecord };

/**
 * Durable store for the production record and its per-scene DirectorProject
 * documents, persisted as one atomically written JSON file. All mutations
 * are serialized through an internal queue and validated before persisting,
 * so the on-disk state is always a schema-valid snapshot.
 *
 * Key invariants:
 * - Every scene referenced by the production has a scene project; committing
 *   a production that references a new scene without a validated seed is
 *   rejected, and unreferenced scene projects are dropped on commit.
 * - Scene projects are revision-guarded: writers must echo the current
 *   revision, and a mismatch is a 409 with the corrective "observe and
 *   retry" message rather than a silent overwrite.
 * - A corrupt state file never blocks startup: the store salvages every
 *   record that still validates, backs up the unreadable file, and continues
 *   with the recovered (or default) state.
 */

const productionStateSchema = z
  .strictObject({
    version: z.literal(1),
    production: productionRecordSchema,
    sceneProjects: z.record(z.string(), productionSceneProjectRecordSchema),
  })
  .superRefine((state, context) => {
    // The map key is the routing identity; a record whose sceneId disagrees
    // would be reachable under the wrong scene.
    Object.entries(state.sceneProjects).forEach(([sceneId, record]) => {
      if (record.sceneId !== sceneId) {
        context.addIssue({
          code: "custom",
          path: ["sceneProjects", sceneId, "sceneId"],
          message: "scene project key and sceneId must match",
        });
      }
    });
  });

type ProductionState = z.infer<typeof productionStateSchema>;

export type { ProductionSceneSeed };

/** Typed store failure carrying the HTTP status and machine code routes map onto. */
export class ProductionStateStoreError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProductionStateStoreError";
  }
}

/** Reads and parses a JSON file, treating a missing file as null. */
async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Renders the first Zod issue as a short human-readable path + message. */
function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "unknown error";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

// Moves the unreadable file aside (timestamped) instead of deleting it, so
// the corrupt bytes stay available for post-mortem inspection.
async function backupCorruptStateFile(statePath: string): Promise<void> {
  const backupPath = `${statePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await rename(statePath, backupPath);
    console.warn(`Backed up unreadable production state to ${backupPath}`);
  } catch (error) {
    console.warn(
      `Could not back up corrupt production state file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Salvages every scene project that still validates so one bad record cannot
 * keep the gateway from starting; returns null when nothing usable remains.
 */
function recoverPersistedState(persisted: unknown): ProductionState | null {
  if (typeof persisted !== "object" || persisted === null) return null;
  const raw = persisted as { version?: unknown; production?: unknown; sceneProjects?: unknown };
  if (raw.version !== 1) return null;
  const production = productionRecordSchema.safeParse(raw.production);
  if (!production.success) {
    console.warn(`Persisted production record is invalid: ${describeIssue(production.error)}`);
    return null;
  }
  const sceneProjects: ProductionState["sceneProjects"] = {};
  const rawSceneProjects =
    raw.sceneProjects && typeof raw.sceneProjects === "object" ? (raw.sceneProjects as Record<string, unknown>) : {};
  for (const [sceneId, record] of Object.entries(rawSceneProjects)) {
    const scene = productionSceneProjectRecordSchema.safeParse(record);
    if (!scene.success) {
      console.warn(`Skipping invalid persisted scene project "${sceneId}": ${describeIssue(scene.error)}`);
      continue;
    }
    if (scene.data.sceneId !== sceneId) {
      console.warn(`Skipping invalid persisted scene project "${sceneId}": scene project key and sceneId must match`);
      continue;
    }
    sceneProjects[sceneId] = scene.data;
  }
  return { version: 1, production: production.data, sceneProjects };
}

/** Serialized, schema-validated store for production + scene project state. */
export class ProductionStateStore {
  private state: ProductionState;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly statePath: string,
    state: ProductionState,
  ) {
    this.state = state;
  }

  /**
   * Opens (or initializes) the store. Load order: fully valid persisted
   * state → partial recovery of the persisted file (backing up the original)
   * → a legacy production manifest → the provided default. Whatever wins is
   * re-persisted immediately, so subsequent boots read a clean file.
   */
  static async open(options: {
    statePath: string;
    legacyManifestPath?: string;
    defaultProduction: ProductionRecord;
  }): Promise<ProductionStateStore> {
    let persisted: unknown = null;
    let corrupt = false;
    try {
      persisted = await readOptionalJson(options.statePath);
    } catch (error) {
      corrupt = true;
      console.warn(
        `Persisted production state is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (persisted !== null) {
      const parsed = productionStateSchema.safeParse(persisted);
      if (parsed.success) return new ProductionStateStore(options.statePath, parsed.data);
      console.warn(`Persisted production state is invalid: ${describeIssue(parsed.error)}`);
      const recovered = recoverPersistedState(persisted);
      if (recovered) {
        await backupCorruptStateFile(options.statePath);
        const store = new ProductionStateStore(options.statePath, recovered);
        await store.persist(recovered);
        return store;
      }
      corrupt = true;
    }
    if (corrupt) await backupCorruptStateFile(options.statePath);

    const legacy = options.legacyManifestPath
      ? await readOptionalJson(options.legacyManifestPath).catch(() => null)
      : null;
    const parsedLegacy = legacy === null ? null : productionRecordSchema.safeParse(legacy);
    const state: ProductionState = {
      version: 1,
      production: parsedLegacy?.success ? parsedLegacy.data : productionRecordSchema.parse(options.defaultProduction),
      sceneProjects: {},
    };
    const store = new ProductionStateStore(options.statePath, state);
    await store.persist(state);
    return store;
  }

  /** Deep-cloned snapshot; callers can never mutate the store's state. */
  getProduction(): ProductionRecord {
    return clone(this.state.production);
  }

  /** Deep-cloned scene project record, or null when the scene has none. */
  getSceneProject(sceneId: string): ProductionSceneProjectRecord | null {
    const record = this.state.sceneProjects[sceneId];
    return record ? clone(record) : null;
  }

  /**
   * Replaces the production record atomically. Scene projects no longer
   * referenced are dropped; newly referenced scenes must arrive with a seed
   * project (seeding an existing scene is a conflict — updates go through
   * the revision-guarded {@link saveSceneProject}); and each scene
   * reference's `sourceRevision` is realigned to its project's revision.
   */
  async commitProduction(nextProduction: ProductionRecord, seeds: ProductionSceneSeed[] = []): Promise<void> {
    return this.enqueue(async () => {
      const production = productionRecordSchema.parse(clone(nextProduction));
      const referencedSceneIds = new Set(production.production.scenes.map((scene) => scene.sceneId));
      const sceneProjects: ProductionState["sceneProjects"] = {};

      Object.entries(this.state.sceneProjects).forEach(([sceneId, record]) => {
        if (referencedSceneIds.has(sceneId)) sceneProjects[sceneId] = clone(record);
      });
      seeds.forEach((seed) => {
        if (!referencedSceneIds.has(seed.sceneId)) {
          throw new ProductionStateStoreError(
            `Scene project seed "${seed.sceneId}" is not referenced by the committed production.`,
            422,
            "scene_seed_without_reference",
          );
        }
        if (this.state.sceneProjects[seed.sceneId]) {
          throw new ProductionStateStoreError(
            `Scene project "${seed.sceneId}" already exists; update it through the revision-guarded scene project endpoint.`,
            409,
            "scene_project_seed_conflict",
          );
        }
        sceneProjects[seed.sceneId] = productionSceneProjectRecordSchema.parse({
          sceneId: seed.sceneId,
          revision: 0,
          updatedAt: production.updatedAt,
          updatedBy: production.updatedBy,
          project: seed.project,
        });
      });
      const previouslyReferenced = new Set(this.state.production.production.scenes.map((scene) => scene.sceneId));
      const unseededNewReference = production.production.scenes.find(
        (scene) => !previouslyReferenced.has(scene.sceneId) && !sceneProjects[scene.sceneId],
      );
      if (unseededNewReference) {
        throw new ProductionStateStoreError(
          `New scene "${unseededNewReference.sceneId}" requires a validated DirectorProject seed.`,
          422,
          "scene_project_required",
        );
      }
      production.production.scenes = production.production.scenes.map((scene) => ({
        ...scene,
        sourceRevision: sceneProjects[scene.sceneId]?.revision ?? scene.sourceRevision,
      }));
      const next: ProductionState = { version: 1, production, sceneProjects };
      await this.persist(next);
      this.state = next;
    });
  }

  /**
   * Saves one scene project under optimistic concurrency: the caller must
   * echo the current revision (0 for a scene without a project yet) and gets
   * the incremented record back. The production's scene reference is updated
   * to point at the new revision in the same atomic write.
   */
  async saveSceneProject(input: {
    sceneId: string;
    expectedRevision: number;
    project: DirectorProject;
    actor: string;
  }): Promise<ProductionSceneProjectRecord> {
    return this.enqueue(async () => {
      const sceneReference = this.state.production.production.scenes.find((scene) => scene.sceneId === input.sceneId);
      if (!sceneReference) {
        throw new ProductionStateStoreError(
          `Scene "${input.sceneId}" is not in the production.`,
          404,
          "scene_not_found",
        );
      }
      const current = this.state.sceneProjects[input.sceneId];
      const currentRevision = current?.revision ?? 0;
      if (input.expectedRevision !== currentRevision) {
        throw new ProductionStateStoreError(
          `Scene project revision is ${currentRevision}, not ${input.expectedRevision}. Observe and retry.`,
          409,
          "stale_scene_project_revision",
        );
      }
      const now = new Date().toISOString();
      const record = productionSceneProjectRecordSchema.parse({
        sceneId: input.sceneId,
        revision: currentRevision + 1,
        updatedAt: now,
        updatedBy: input.actor,
        project: input.project,
      });
      const next = clone(this.state);
      next.sceneProjects[input.sceneId] = record;
      next.production.production.scenes = next.production.production.scenes.map((scene) =>
        scene.sceneId === input.sceneId ? { ...scene, sourceRevision: record.revision } : scene,
      );
      await this.persist(next);
      this.state = next;
      return clone(record);
    });
  }

  // Serializes mutations so concurrent commits cannot interleave their
  // read-modify-write cycles; a failed operation never blocks the queue.
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(state: ProductionState) {
    await writeJsonAtomic(this.statePath, state);
  }
}
