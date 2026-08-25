import type { ProductionOperation, ProductionRecord } from "../gatewaySchemas";
import type { ProductionSceneSeed } from "./productionStateStore";
import { stableJson } from "../../../packages/protocol/src/stableJson";

/** A request to mutate a production record. */
export type ProductionMutationRequest = {
  /** The revision the caller expects the production to be at. */
  expectedRevision: number;
  /** The ordered list of operations to apply. */
  operations: ProductionOperation[];
  /** The actor (user or agent) performing the mutation. */
  actor: string;
  /** Optional idempotency key for deduplication. */
  idempotencyKey?: string;
  /** Optional scene seeds for newly added scenes. */
  sceneSeeds?: ProductionSceneSeed[];
};

/** The result of applying a production mutation. */
export type ProductionMutationResult = {
  /** The production record after the mutation. */
  record: ProductionRecord;
  /** Whether the result was replayed from a previous idempotent call. */
  replayed: boolean;
};

type IdempotencyRecord = {
  signature: string;
  result: ProductionRecord;
};

/**
 * Error thrown when a production mutation is rejected due to a revision
 * conflict or a validation failure.
 */
export class ProductionMutationError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 422,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProductionMutationError";
  }
}

function mutationError(message: string, code: string): never {
  throw new ProductionMutationError(message, 422, code);
}

function findScene(record: ProductionRecord, sceneId: string) {
  return record.production.scenes.find((scene) => scene.sceneId === sceneId);
}

function findShot(record: ProductionRecord, shotId: string) {
  return record.production.editorialTimeline.find((shot) => shot.id === shotId);
}

/**
 * Applies a sequence of production operations to a copy of the current record.
 *
 * Each operation is validated against the current state before being applied.
 * The revision is incremented and the updated timestamp and actor are set.
 *
 * @param current - The current production record.
 * @param operations - The ordered list of operations to apply.
 * @param actor - The actor performing the mutation.
 * @param now - ISO 8601 timestamp for the mutation.
 * @returns A new production record with the operations applied.
 * @throws {@link ProductionMutationError} When an operation references a missing entity.
 */
export function applyProductionOperations(
  current: ProductionRecord,
  operations: ProductionOperation[],
  actor: string,
  now: string,
): ProductionRecord {
  const next = structuredClone(current);

  for (const operation of operations) {
    switch (operation.op) {
      case "rename_production":
        next.production.title = operation.title;
        break;
      case "add_scene_reference": {
        if (findScene(next, operation.sceneId)) {
          mutationError(`Scene "${operation.sceneId}" already exists in the production.`, "scene_already_exists");
        }
        next.production.scenes.push({
          sceneId: operation.sceneId,
          title: operation.title,
          sourceRevision: 0,
          createdAt: now,
        });
        next.production.activeSceneId ??= operation.sceneId;
        break;
      }
      case "rename_scene": {
        const scene = findScene(next, operation.sceneId);
        if (!scene) mutationError(`Scene "${operation.sceneId}" does not exist.`, "scene_not_found");
        scene.title = operation.title;
        break;
      }
      case "set_active_scene":
        if (!findScene(next, operation.sceneId)) {
          mutationError(`Scene "${operation.sceneId}" does not exist.`, "scene_not_found");
        }
        next.production.activeSceneId = operation.sceneId;
        break;
      case "remove_scene_reference":
        if (!findScene(next, operation.sceneId)) {
          mutationError(`Scene "${operation.sceneId}" does not exist.`, "scene_not_found");
        }
        next.production.scenes = next.production.scenes.filter((scene) => scene.sceneId !== operation.sceneId);
        next.production.editorialTimeline = next.production.editorialTimeline.filter(
          (shot) => shot.sceneId !== operation.sceneId,
        );
        if (next.production.activeSceneId === operation.sceneId) {
          next.production.activeSceneId = next.production.scenes[0]?.sceneId ?? null;
        }
        break;
      case "add_editorial_shot": {
        if (!findScene(next, operation.shot.sceneId)) {
          mutationError(`Scene "${operation.shot.sceneId}" does not exist.`, "scene_not_found");
        }
        if (findShot(next, operation.shot.id)) {
          mutationError(`Editorial shot "${operation.shot.id}" already exists.`, "editorial_shot_already_exists");
        }
        const sourceRevision = findScene(next, operation.shot.sceneId)?.sourceRevision ?? 0;
        next.production.editorialTimeline.push({
          ...operation.shot,
          sourceRevision: operation.shot.sourceRevision ?? sourceRevision,
        });
        break;
      }
      case "remove_editorial_shot":
        if (!findShot(next, operation.id)) {
          mutationError(`Editorial shot "${operation.id}" does not exist.`, "editorial_shot_not_found");
        }
        next.production.editorialTimeline = next.production.editorialTimeline.filter(
          (shot) => shot.id !== operation.id,
        );
        break;
      case "refresh_editorial_shot": {
        const shot = findShot(next, operation.id);
        if (!shot) mutationError(`Editorial shot "${operation.id}" does not exist.`, "editorial_shot_not_found");
        shot.sourceRevision = findScene(next, shot.sceneId)?.sourceRevision ?? 0;
        break;
      }
    }
  }

  if (next.production.scenes.length && !next.production.activeSceneId) {
    next.production.activeSceneId = next.production.scenes[0]!.sceneId;
  }
  next.revision += 1;
  next.updatedAt = now;
  next.updatedBy = actor;
  return next;
}

/**
 * Coordinates serialised production mutations with revision checking and
 * idempotency key replay.
 *
 * Mutations are executed one at a time in a serial queue. Each request is
 * validated against the expected revision, and a stable signature of the
 * request is stored for idempotency replay.
 */
export class ProductionMutationCoordinator {
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private queue: Promise<void> = Promise.resolve();

  /**
   * Creates a new production mutation coordinator.
   *
   * @param now - Clock that returns ISO 8601 timestamps for mutations.
   * @param historyLimit - Maximum number of idempotency records to retain.
   */
  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly historyLimit = 256,
  ) {}

  /**
   * Executes a production mutation, serialised against other concurrent
   * mutations on the same coordinator.
   *
   * Checks the expected revision, validates idempotency keys, and commits
   * the result through the provided callback.
   *
   * @param current - The current production record or a factory that returns it.
   * @param request - The mutation request.
   * @param commit - Callback to persist the mutated record.
   * @returns The mutation result.
   * @throws {@link ProductionMutationError} On revision mismatch or idempotency key conflict.
   */
  async execute(
    current: ProductionRecord | (() => ProductionRecord),
    request: ProductionMutationRequest,
    commit: (next: ProductionRecord) => Promise<void>,
  ): Promise<ProductionMutationResult> {
    const result = this.queue.then(
      () => this.executeSerialized(current, request, commit),
      () => this.executeSerialized(current, request, commit),
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeSerialized(
    currentSource: ProductionRecord | (() => ProductionRecord),
    request: ProductionMutationRequest,
    commit: (next: ProductionRecord) => Promise<void>,
  ): Promise<ProductionMutationResult> {
    const signature = stableJson({
      expectedRevision: request.expectedRevision,
      actor: request.actor,
      operations: request.operations,
      sceneSeeds: request.sceneSeeds ?? [],
    });
    if (request.idempotencyKey) {
      const previous = this.idempotency.get(request.idempotencyKey);
      if (previous) {
        if (previous.signature !== signature) {
          throw new ProductionMutationError(
            `Idempotency key "${request.idempotencyKey}" was already used for a different production mutation.`,
            409,
            "idempotency_key_conflict",
          );
        }
        return { record: structuredClone(previous.result), replayed: true };
      }
    }

    const current = typeof currentSource === "function" ? currentSource() : currentSource;
    if (request.expectedRevision !== current.revision) {
      throw new ProductionMutationError(
        `Production revision is ${current.revision}, not ${request.expectedRevision}. Observe and retry.`,
        409,
        "stale_production_revision",
      );
    }

    const next = applyProductionOperations(current, request.operations, request.actor, this.now());
    await commit(next);
    if (request.idempotencyKey) {
      this.idempotency.set(request.idempotencyKey, { signature, result: structuredClone(next) });
      while (this.idempotency.size > this.historyLimit) {
        const oldest = this.idempotency.keys().next().value as string | undefined;
        if (!oldest) break;
        this.idempotency.delete(oldest);
      }
    }
    return { record: structuredClone(next), replayed: false };
  }
}
