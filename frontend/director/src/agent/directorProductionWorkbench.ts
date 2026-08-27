/**
 * Production workbench command executor (`production` operations).
 *
 * Manages the singleton multi-scene production record: observing production
 * state, renaming, creating / duplicating / renaming / activating / deleting
 * scenes. Mutations run against the backend production store with optimistic
 * revisions and idempotency keys; operations that change which scene should
 * be live also return a scene-switch directive the browser workbench client
 * must carry out (and the caller confirms via a fresh observe) — this module
 * never rebinds the viewport itself.
 */
import type { DirectorProject } from "@director/project-schema";
import { createDefaultDirectorProject } from "../comprehensive/editor/store/directorStore";
import {
  createDirectorProductionScene,
  DirectorProductionClientError,
  getDirectorProduction,
  type DirectorProductionRecord,
  type DirectorProductionSceneSeed,
  type ProductionOperation,
  updateDirectorProduction,
} from "../comprehensive/editor/production/productionClient";
import type { DirectorProductionWorkbenchOperation } from "@director/agent-engine/contract";
import type { DirectorWorkbenchExecution } from "./directorWorkbenchExecutor";

/**
 * The singleton production record key used to identify the Director production
 * in the backend datastore. Every production-scoped operation targets this record.
 */
const PRODUCTION_ID = "main";

/**
 * Describes a scene that the browser should navigate to and activate after a
 * production mutation. The caller uses the {@link activationId} to confirm the
 * switch completed by observing the current browser scene.
 */
export type DirectorProductionSceneSwitch = {
  /** The production scene ID the browser should switch to. */
  sceneId: string;
  /** A unique activation token the caller can use to verify the switch landed. */
  activationId: string;
  /** An optional seed project to seed the scene document when the switch lands. */
  seedProject?: DirectorProject;
};

/**
 * The outcome of executing a production workbench operation. Wraps a
 * {@link DirectorWorkbenchExecution} together with an optional scene-switch
 * instruction that the workbench client must carry out to complete the
 * operation.
 */
export type DirectorProductionWorkbenchResult = {
  /** The execution result (success or failure) of the production operation. */
  execution: DirectorWorkbenchExecution;
  /** When set, the browser must activate this scene for the operation to take effect. */
  switchScene?: DirectorProductionSceneSwitch;
};

type ProductionCommand = DirectorProductionWorkbenchOperation["command"];

/**
 * Dependency injection surface for the production workbench. Each method
 * encapsulates a side effect or state query that the executor needs to
 * interact with the Director backend, the browser, or the current project.
 */
export type DirectorProductionWorkbenchDependencies = {
  /** Fetch the current production record from the backend. */
  getProduction: (signal?: AbortSignal) => Promise<DirectorProductionRecord>;
  /** Apply a list of production-level operations (rename, add/remove scene, etc.). */
  updateProduction: (
    expectedRevision: number,
    operations: ProductionOperation[],
    requestKey: string,
    sceneSeeds?: DirectorProductionSceneSeed[],
    signal?: AbortSignal,
  ) => Promise<DirectorProductionRecord>;
  /** Create a new scene in the production and optionally activate it. */
  createScene: (input: {
    expectedRevision: number;
    sceneId: string;
    title: string;
    sourceSceneId?: string;
    project: DirectorProject;
    activate: boolean;
    requestKey: string;
    signal?: AbortSignal;
  }) => Promise<DirectorProductionRecord>;
  /** Return the scene ID currently loaded in the browser viewport. */
  currentBrowserSceneId: () => string;
  /** Return the document revision of the currently loaded scene, or null. */
  currentSceneDocumentRevision: () => number | null;
  /** Return the current project state (used for scene duplication). */
  currentProject: () => DirectorProject;
  /** Create a fresh default project for seeding new scenes. */
  createEmptyProject: () => DirectorProject;
};

const defaultDependencies: DirectorProductionWorkbenchDependencies = {
  getProduction: (signal) => getDirectorProduction(PRODUCTION_ID, signal),
  updateProduction: (expectedRevision, operations, requestKey, sceneSeeds, signal) =>
    updateDirectorProduction(
      PRODUCTION_ID,
      expectedRevision,
      operations,
      "director-agent:production",
      requestKey,
      sceneSeeds,
      signal,
    ),
  createScene: (input) =>
    createDirectorProductionScene({
      productionId: PRODUCTION_ID,
      expectedRevision: input.expectedRevision,
      sceneId: input.sceneId,
      title: input.title,
      sourceSceneId: input.sourceSceneId,
      project: input.project,
      activate: input.activate,
      idempotencyKey: input.requestKey,
      signal: input.signal,
    }),
  currentBrowserSceneId: () => "",
  currentSceneDocumentRevision: () => null,
  currentProject: () => {
    throw new Error("currentProject dependency is required for scene duplication");
  },
  createEmptyProject: () => createDefaultDirectorProject(),
};

/** Mint a unique activation token the caller uses to confirm a scene switch landed. */
function activationId() {
  return `director-activation:${crypto.randomUUID()}`;
}

/** The revision to mutate against: the caller's explicit guard, else the freshly observed one. */
function commandExpectedRevision(command: ProductionCommand, production: DirectorProductionRecord) {
  return "expected_revision" in command && command.expected_revision !== undefined
    ? command.expected_revision
    : production.revision;
}

/** Build the shared success payload: revision delta, scene roster, and idempotency echo. */
function result(command: ProductionCommand, before: DirectorProductionRecord, after: DirectorProductionRecord) {
  return {
    op: "production",
    action: command.action,
    production_revision_before: before.revision,
    production_revision: after.revision,
    active_scene_id: after.production.activeSceneId,
    current_scenes: after.production.scenes,
    editorial_shot_count: after.production.editorialTimeline.length,
    production: after,
    ...(command.action !== "observe" && command.idempotency_key
      ? {
          idempotency: {
            key: command.idempotency_key,
            replayed: after.mutation?.idempotencyReplayed ?? false,
          },
        }
      : {}),
  };
}

/**
 * Map a thrown error to a typed failure result, preferring the backend's own
 * structured code (e.g. stale revision, scene conflicts) when the production
 * client surfaced one.
 */
function failure(error: unknown): DirectorProductionWorkbenchResult {
  if (error instanceof DirectorProductionClientError) {
    const body = error.body && typeof error.body === "object" && !Array.isArray(error.body) ? error.body : null;
    const code = body && "code" in body && typeof body.code === "string" ? body.code : "production_request_failed";
    return {
      execution: {
        success: false,
        error: error.message,
        result: { code, status: error.status },
      },
    };
  }
  return {
    execution: {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      result: { code: "production_request_failed" },
    },
  };
}

/**
 * Execute a production-scoped workbench operation (observe, rename, create
 * scene, duplicate scene, activate scene, delete scene) against the singleton
 * production record.
 *
 * The observe action is read-only and returns the current production state
 * plus browser-sync metadata. Every other action mutates the production
 * record and may return a {@link DirectorProductionSceneSwitch} instruction
 * that the caller must carry out.
 *
 * @param operation - The production workbench operation to execute.
 * @param signal - An optional abort signal to cancel the operation.
 * @param dependencies - Dependency injection for backend and browser state.
 *   Defaults to the live Director backend and a no-op browser stub.
 * @returns The execution result, optionally including a scene-switch directive.
 */
export async function executeDirectorProductionWorkbenchOperation(
  operation: DirectorProductionWorkbenchOperation,
  signal?: AbortSignal,
  dependencies: DirectorProductionWorkbenchDependencies = defaultDependencies,
): Promise<DirectorProductionWorkbenchResult> {
  const command = operation.command;
  try {
    const before = await dependencies.getProduction(signal);
    if (command.action === "observe") {
      const browserSceneId = dependencies.currentBrowserSceneId();
      return {
        execution: {
          success: true,
          result: {
            // Observe is read-only; before and after are the same record.
            ...result(command, before, before),
            current_browser_scene_id: browserSceneId || null,
            browser_matches_active_scene: Boolean(browserSceneId) && browserSceneId === before.production.activeSceneId,
            scene_document_revision: dependencies.currentSceneDocumentRevision(),
          },
        },
      };
    }

    const expectedRevision = commandExpectedRevision(command, before);
    const requestKey = command.idempotency_key ?? `director-production:${crypto.randomUUID()}`;
    let after: DirectorProductionRecord;
    let switchScene: DirectorProductionSceneSwitch | undefined;

    switch (command.action) {
      case "rename_production":
        after = await dependencies.updateProduction(
          expectedRevision,
          [{ op: "rename_production", title: command.title }],
          requestKey,
          undefined,
          signal,
        );
        break;
      case "create_scene": {
        const seedProject = dependencies.createEmptyProject();
        after = await dependencies.createScene({
          expectedRevision,
          sceneId: command.scene_id,
          title: command.title,
          project: seedProject,
          activate: command.activate,
          requestKey,
          signal,
        });
        if (command.activate)
          switchScene = {
            sceneId: command.scene_id,
            activationId: activationId(),
            seedProject,
          };
        break;
      }
      case "duplicate_scene": {
        const source = before.production.scenes.find((scene) => scene.sceneId === command.source_scene_id);
        if (!source) {
          return {
            execution: {
              success: false,
              error: `Source scene "${command.source_scene_id}" does not exist.`,
              result: { code: "scene_not_found" },
            },
          };
        }
        if (dependencies.currentBrowserSceneId() !== command.source_scene_id) {
          return {
            execution: {
              success: false,
              error: `Scene "${command.source_scene_id}" is not the loaded browser scene. Activate and observe it before duplicating content.`,
              result: { code: "source_scene_not_loaded", required_scene_id: command.source_scene_id },
            },
          };
        }
        const seedProject = structuredClone(dependencies.currentProject());
        after = await dependencies.createScene({
          expectedRevision,
          sceneId: command.scene_id,
          title: command.title ?? `${source.title} Copy`,
          sourceSceneId: command.source_scene_id,
          project: seedProject,
          activate: command.activate,
          requestKey,
          signal,
        });
        if (command.activate)
          switchScene = {
            sceneId: command.scene_id,
            activationId: activationId(),
            seedProject,
          };
        break;
      }
      case "rename_scene":
        after = await dependencies.updateProduction(
          expectedRevision,
          [{ op: "rename_scene", sceneId: command.scene_id, title: command.title }],
          requestKey,
          undefined,
          signal,
        );
        break;
      case "activate_scene":
        // Skip the backend call when the production and browser already agree on the active scene.
        if (
          before.production.activeSceneId === command.scene_id &&
          dependencies.currentBrowserSceneId() === command.scene_id
        ) {
          after = before;
        } else {
          after = await dependencies.updateProduction(
            expectedRevision,
            [{ op: "set_active_scene", sceneId: command.scene_id }],
            requestKey,
            undefined,
            signal,
          );
          switchScene = {
            sceneId: command.scene_id,
            activationId: activationId(),
          };
        }
        break;
      case "delete_scene": {
        const exists = before.production.scenes.some((scene) => scene.sceneId === command.scene_id);
        if (!exists) {
          return {
            execution: {
              success: false,
              error: `Scene "${command.scene_id}" does not exist.`,
              result: { code: "scene_not_found" },
            },
          };
        }
        const deletingLast = before.production.scenes.length === 1;
        // A production must always have at least one scene; the last scene can only
        // be deleted when a replacement is provided.
        if (deletingLast && !command.replacement) {
          return {
            execution: {
              success: false,
              error: "Deleting the last scene requires an explicit replacement scene ID and title.",
              result: { code: "last_scene_requires_replacement" },
            },
          };
        }
        const operations: ProductionOperation[] = [];
        const sceneSeeds: DirectorProductionSceneSeed[] = [];
        if (command.replacement) {
          const replacementProject = dependencies.createEmptyProject();
          operations.push({
            op: "add_scene_reference",
            sceneId: command.replacement.scene_id,
            title: command.replacement.title,
          });
          sceneSeeds.push({ sceneId: command.replacement.scene_id, project: replacementProject });
        }
        operations.push({ op: "remove_scene_reference", sceneId: command.scene_id });
        if (command.replacement) {
          operations.push({ op: "set_active_scene", sceneId: command.replacement.scene_id });
        }
        after = await dependencies.updateProduction(expectedRevision, operations, requestKey, sceneSeeds, signal);
        // When the browser is viewing the deleted scene, switch it to the new active scene.
        if (dependencies.currentBrowserSceneId() === command.scene_id && after.production.activeSceneId) {
          const replacementSeed = sceneSeeds.find((seed) => seed.sceneId === after.production.activeSceneId)?.project;
          switchScene = {
            sceneId: after.production.activeSceneId,
            activationId: activationId(),
            ...(replacementSeed ? { seedProject: replacementSeed } : {}),
          };
        }
        break;
      }
    }

    const operationResult = result(command, before, after);
    return {
      execution: {
        success: true,
        result: {
          ...operationResult,
          ...(switchScene
            ? {
                activation: {
                  status: "pending",
                  activation_id: switchScene.activationId,
                  scene_id: switchScene.sceneId,
                  confirmation: "observe_after_browser_rebind",
                },
              }
            : {}),
        },
      },
      ...(switchScene ? { switchScene } : {}),
    };
  } catch (error) {
    return failure(error);
  }
}
