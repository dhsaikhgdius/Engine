// @vitest-environment node

import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DirectorProject } from "@director/project-schema";
import type { ProductionRecord } from "../../gatewaySchemas";
import { ProductionStateStore, ProductionStateStoreError } from "../../production/productionStateStore";

function project(color = "#101820"): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: color,
      panoramaYaw: 0,
      panoramaRadius: 60,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.9,
      groundHeight: 0,
    },
    assets: [],
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
  };
}

function production(): ProductionRecord {
  return {
    productionId: "main",
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    production: { version: 1, title: "Production", activeSceneId: null, scenes: [], editorialTimeline: [] },
  };
}

async function openStore() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-production-state-"));
  const statePath = resolve(directory, "state.json");
  return {
    statePath,
    store: await ProductionStateStore.open({ statePath, defaultProduction: production() }),
  };
}

describe("ProductionStateStore", () => {
  it("commits a manifest reference and validated scene project in one durable state file", async () => {
    const { store, statePath } = await openStore();
    const next = production();
    next.revision = 1;
    next.production.activeSceneId = "scene-a";
    next.production.scenes = [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 0, createdAt: "now" }];

    await store.commitProduction(next, [{ sceneId: "scene-a", project: project("#abcdef") }]);

    expect(store.getSceneProject("scene-a")).toMatchObject({
      sceneId: "scene-a",
      revision: 0,
      project: { scene: { backgroundColor: "#abcdef" } },
    });
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 1,
      production: { revision: 1 },
      sceneProjects: { "scene-a": { revision: 0 } },
    });
  });

  it("increments scene revision independently and rejects stale saves", async () => {
    const { store } = await openStore();
    const next = production();
    next.revision = 1;
    next.production.activeSceneId = "scene-a";
    next.production.scenes = [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 0, createdAt: "now" }];
    await store.commitProduction(next, [{ sceneId: "scene-a", project: project() }]);

    const saved = await store.saveSceneProject({
      sceneId: "scene-a",
      expectedRevision: 0,
      project: project("#334455"),
      actor: "test",
    });
    expect(saved).toMatchObject({ revision: 1, project: { scene: { backgroundColor: "#334455" } } });
    expect(store.getProduction().production.scenes[0]?.sourceRevision).toBe(1);
    await expect(
      store.saveSceneProject({ sceneId: "scene-a", expectedRevision: 0, project: project(), actor: "stale" }),
    ).rejects.toMatchObject({ code: "stale_scene_project_revision" } satisfies Partial<ProductionStateStoreError>);
  });

  it("removes the scene document in the same commit that removes its manifest reference", async () => {
    const { store } = await openStore();
    const withScene = production();
    withScene.revision = 1;
    withScene.production.activeSceneId = "scene-a";
    withScene.production.scenes = [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 0, createdAt: "now" }];
    await store.commitProduction(withScene, [{ sceneId: "scene-a", project: project() }]);
    const empty = production();
    empty.revision = 2;
    await store.commitProduction(empty);
    expect(store.getSceneProject("scene-a")).toBeNull();
  });

  it("rejects a newly referenced scene without a project seed", async () => {
    const { store } = await openStore();
    const next = production();
    next.revision = 1;
    next.production.activeSceneId = "scene-a";
    next.production.scenes = [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 0, createdAt: "now" }];
    await expect(store.commitProduction(next)).rejects.toMatchObject({ code: "scene_project_required" });
    expect(store.getProduction().revision).toBe(0);
  });

  it("salvages valid scene projects and backs up the state file when one scene is corrupt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { store, statePath } = await openStore();
      const next = production();
      next.revision = 1;
      next.production.activeSceneId = "scene-a";
      next.production.scenes = [
        { sceneId: "scene-a", title: "Scene A", sourceRevision: 0, createdAt: "now" },
        { sceneId: "scene-b", title: "Scene B", sourceRevision: 0, createdAt: "now" },
      ];
      await store.commitProduction(next, [
        { sceneId: "scene-a", project: project("#abcdef") },
        { sceneId: "scene-b", project: project("#123456") },
      ]);

      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        sceneProjects: Record<string, { project: { scene: Record<string, unknown> } }>;
      };
      persisted.sceneProjects["scene-b"]!.project.scene.backgroundColor = 42;
      await writeFile(statePath, JSON.stringify(persisted));

      const reopened = await ProductionStateStore.open({ statePath, defaultProduction: production() });
      expect(reopened.getSceneProject("scene-a")).toMatchObject({
        project: { scene: { backgroundColor: "#abcdef" } },
      });
      expect(reopened.getSceneProject("scene-b")).toBeNull();
      expect(reopened.getProduction().revision).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"scene-b"'));

      const backups = (await readdir(dirname(statePath))).filter((name) => name.includes(".corrupt-"));
      expect(backups).toHaveLength(1);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        version: 1,
        sceneProjects: { "scene-a": { revision: 0 } },
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("starts from the default production and backs up a state file that cannot be parsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const directory = await mkdtemp(resolve(tmpdir(), "director-production-state-"));
      const statePath = resolve(directory, "state.json");
      await writeFile(statePath, "{ not json");

      const store = await ProductionStateStore.open({ statePath, defaultProduction: production() });
      expect(store.getProduction()).toMatchObject({ productionId: "main", revision: 0 });

      const backups = (await readdir(directory)).filter((name) => name.startsWith("state.json.corrupt-"));
      expect(backups).toHaveLength(1);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ version: 1, sceneProjects: {} });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not let a manifest mutation reset an existing scene document revision", async () => {
    const { store } = await openStore();
    const next = production();
    next.revision = 1;
    next.production.activeSceneId = "scene-a";
    next.production.scenes = [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 0, createdAt: "now" }];
    await store.commitProduction(next, [{ sceneId: "scene-a", project: project() }]);
    const renamed = store.getProduction();
    renamed.revision = 2;
    renamed.production.title = "Renamed";
    await expect(
      store.commitProduction(renamed, [{ sceneId: "scene-a", project: project("#ffffff") }]),
    ).rejects.toMatchObject({ code: "scene_project_seed_conflict" });
    expect(store.getSceneProject("scene-a")).toMatchObject({
      revision: 0,
      project: { scene: { backgroundColor: "#101820" } },
    });
  });
});
