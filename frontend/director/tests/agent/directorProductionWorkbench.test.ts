import { describe, expect, it, vi } from "vitest";
import { createDefaultDirectorProject } from "../../src/comprehensive/editor/store/directorStore";
import type {
  DirectorProductionRecord,
  ProductionOperation,
} from "../../src/comprehensive/editor/production/productionClient";
import {
  executeDirectorProductionWorkbenchOperation,
  type DirectorProductionWorkbenchDependencies,
} from "../../src/agent/directorProductionWorkbench";

function production(): DirectorProductionRecord {
  return {
    productionId: "main",
    revision: 3,
    updatedAt: null,
    updatedBy: null,
    production: {
      version: 1,
      title: "Production",
      activeSceneId: "scene-a",
      scenes: [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 1, createdAt: "2026-08-01" }],
      editorialTimeline: [],
    },
  };
}

function dependencies(overrides: Partial<DirectorProductionWorkbenchDependencies> = {}) {
  let record = production();
  const updateProduction = vi.fn(async (expectedRevision: number, operations: ProductionOperation[], _key: string) => {
    expect(expectedRevision).toBe(record.revision);
    const next = structuredClone(record);
    operations.forEach((operation) => {
      if (operation.op === "rename_scene") {
        next.production.scenes.find((scene) => scene.sceneId === operation.sceneId)!.title = operation.title;
      } else if (operation.op === "add_scene_reference") {
        next.production.scenes.push({
          sceneId: operation.sceneId,
          title: operation.title,
          sourceRevision: 0,
          createdAt: "2026-08-02",
        });
      } else if (operation.op === "remove_scene_reference") {
        next.production.scenes = next.production.scenes.filter((scene) => scene.sceneId !== operation.sceneId);
        if (next.production.activeSceneId === operation.sceneId) {
          next.production.activeSceneId = next.production.scenes[0]?.sceneId ?? null;
        }
      } else if (operation.op === "set_active_scene") {
        next.production.activeSceneId = operation.sceneId;
      }
    });
    next.revision += 1;
    record = next;
    return structuredClone(record);
  });
  const createScene = vi.fn(
    async (input: {
      expectedRevision: number;
      sceneId: string;
      title: string;
      sourceSceneId?: string;
      project: ReturnType<typeof createDefaultDirectorProject>;
      activate: boolean;
      requestKey: string;
    }) => {
      expect(input.expectedRevision).toBe(record.revision);
      record = {
        ...record,
        revision: record.revision + 1,
        production: {
          ...record.production,
          activeSceneId: input.activate === false ? record.production.activeSceneId : input.sceneId,
          scenes: [
            ...record.production.scenes,
            {
              sceneId: input.sceneId,
              title: input.title,
              sourceRevision: 0,
              createdAt: "2026-08-02",
            },
          ],
        },
      };
      return structuredClone(record);
    },
  );
  const deps: DirectorProductionWorkbenchDependencies = {
    getProduction: async () => structuredClone(record),
    updateProduction,
    createScene,
    currentBrowserSceneId: () => "scene-a",
    currentSceneDocumentRevision: () => 1,
    currentProject: () => createDefaultDirectorProject(),
    createEmptyProject: () => createDefaultDirectorProject(),
    ...overrides,
  };
  return { deps, updateProduction, createScene };
}

describe("director production workbench", () => {
  it("observes production revision and browser alignment", async () => {
    const { deps } = dependencies();
    const result = await executeDirectorProductionWorkbenchOperation(
      { op: "production", command: { action: "observe" } },
      undefined,
      deps,
    );
    expect(result.execution).toMatchObject({
      success: true,
      result: {
        production_revision: 3,
        active_scene_id: "scene-a",
        current_browser_scene_id: "scene-a",
        browser_matches_active_scene: true,
        scene_document_revision: 1,
      },
    });
  });

  it("creates without changing the browser target when activation is disabled", async () => {
    const { deps, createScene } = dependencies();
    const result = await executeDirectorProductionWorkbenchOperation(
      {
        op: "production",
        command: { action: "create_scene", scene_id: "scene-background", title: "Background", activate: false },
      },
      undefined,
      deps,
    );
    expect(createScene).toHaveBeenCalledWith(expect.objectContaining({ activate: false }));
    expect(result.switchScene).toBeUndefined();
    expect(result.execution.result).not.toHaveProperty("activation");
  });

  it("creates an explicit scene and requests activation", async () => {
    const { deps, createScene } = dependencies();
    const result = await executeDirectorProductionWorkbenchOperation(
      {
        op: "production",
        command: { action: "create_scene", scene_id: "scene-b", title: "Scene B", activate: true },
      },
      undefined,
      deps,
    );
    expect(createScene).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        sceneId: "scene-b",
        activate: true,
        project: expect.objectContaining({ version: 1 }),
        requestKey: expect.stringMatching(/^director-production:[0-9a-f-]{36}$/),
      }),
    );
    expect(result.switchScene).toMatchObject({
      sceneId: "scene-b",
      activationId: expect.stringMatching(/^director-activation:[0-9a-f-]{36}$/),
    });
  });

  it("forwards a caller request key and reports server replay", async () => {
    const updateProduction = vi.fn(async () => ({ ...production(), mutation: { idempotencyReplayed: true } }));
    const { deps } = dependencies({ updateProduction });
    const result = await executeDirectorProductionWorkbenchOperation(
      {
        op: "production",
        command: {
          action: "rename_scene",
          scene_id: "scene-a",
          title: "Opening",
          expected_revision: 3,
          idempotency_key: "production-rename-scene-v1",
        },
      },
      undefined,
      deps,
    );
    expect(updateProduction).toHaveBeenCalledWith(
      3,
      [{ op: "rename_scene", sceneId: "scene-a", title: "Opening" }],
      "production-rename-scene-v1",
      undefined,
      undefined,
    );
    expect(result.execution.result).toMatchObject({
      idempotency: { key: "production-rename-scene-v1", replayed: true },
    });
  });

  it("duplicates only the loaded source and carries an independent project seed", async () => {
    const project = createDefaultDirectorProject();
    project.storyboard = { version: 1, title: "Source board", logline: "A duplicated scene.", shots: [] };
    const { deps, createScene } = dependencies({ currentProject: () => project });
    const result = await executeDirectorProductionWorkbenchOperation(
      {
        op: "production",
        command: {
          action: "duplicate_scene",
          source_scene_id: "scene-a",
          scene_id: "scene-copy",
          activate: true,
        },
      },
      undefined,
      deps,
    );
    expect(result.execution.success).toBe(true);
    expect(result.switchScene?.sceneId).toBe("scene-copy");
    expect(result.switchScene?.seedProject).toEqual(project);
    expect(result.switchScene?.seedProject).not.toBe(project);
    expect(createScene).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ storyboard: project.storyboard }) }),
    );

    const wrongSource = await executeDirectorProductionWorkbenchOperation(
      {
        op: "production",
        command: {
          action: "duplicate_scene",
          source_scene_id: "scene-a",
          scene_id: "scene-copy-2",
          activate: true,
        },
      },
      undefined,
      dependencies({ currentBrowserSceneId: () => "scene-other" }).deps,
    );
    expect(wrongSource.execution).toMatchObject({ success: false, result: { code: "source_scene_not_loaded" } });
  });

  it("requires an explicit replacement when deleting the last scene", async () => {
    const { deps, updateProduction } = dependencies();
    const blocked = await executeDirectorProductionWorkbenchOperation(
      { op: "production", command: { action: "delete_scene", scene_id: "scene-a" } },
      undefined,
      deps,
    );
    expect(blocked.execution).toMatchObject({
      success: false,
      result: { code: "last_scene_requires_replacement" },
    });
    expect(updateProduction).not.toHaveBeenCalled();

    const replaced = await executeDirectorProductionWorkbenchOperation(
      {
        op: "production",
        command: {
          action: "delete_scene",
          scene_id: "scene-a",
          replacement: { scene_id: "scene-new", title: "Replacement" },
        },
      },
      undefined,
      deps,
    );
    expect(replaced.execution.success).toBe(true);
    expect(replaced.switchScene).toMatchObject({
      sceneId: "scene-new",
      activationId: expect.stringMatching(/^director-activation:[0-9a-f-]{36}$/),
      seedProject: expect.objectContaining({ version: 1 }),
    });
    expect(updateProduction).toHaveBeenLastCalledWith(
      3,
      expect.arrayContaining([{ op: "add_scene_reference", sceneId: "scene-new", title: "Replacement" }]),
      expect.any(String),
      [expect.objectContaining({ sceneId: "scene-new", project: expect.objectContaining({ version: 1 }) })],
      undefined,
    );
  });
});
