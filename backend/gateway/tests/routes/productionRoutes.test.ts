import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectorProject } from "@director/project-schema";
import { createDefaultScene } from "@director/stage-protocol";
import type { ProductionRecord } from "../../gatewaySchemas";
import { ProductionMutationCoordinator } from "../../production/productionMutationCoordinator";
import { ProductionStateStore } from "../../production/productionStateStore";
import { handleProductionRoute } from "../../routes/productionRoutes";

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) : {};
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function initialProduction(): ProductionRecord {
  return {
    productionId: "main",
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    production: {
      version: 1,
      title: "Production",
      activeSceneId: null,
      scenes: [],
      editorialTimeline: [],
    },
  };
}

function directorProject(backgroundColor = "#373a40"): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor,
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

const openServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fixture(options: { fallbackProject?: DirectorProject } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "director-production-routes-"));
  const store = await ProductionStateStore.open({
    statePath: resolve(directory, "state.json"),
    defaultProduction: initialProduction(),
  });
  const coordinator = new ProductionMutationCoordinator(() => "2026-08-02T00:00:00Z");
  const server = createServer(async (request, response) => {
    const handled = await handleProductionRoute(request, response, new URL(request.url ?? "/", "http://127.0.0.1"), {
      readBody,
      json,
      getProduction: () => store.getProduction(),
      applyProductionUpdate: (mutation) =>
        coordinator.execute(
          () => store.getProduction(),
          mutation,
          (next) => store.commitProduction(next, mutation.sceneSeeds),
        ),
      getStageScene: createDefaultScene,
      getSceneProject: (sceneId) => store.getSceneProject(sceneId),
      readWorkbenchProjectFallback: async () => options.fallbackProject ?? null,
      saveSceneProject: (input) => store.saveSceneProject(input),
    });
    if (!handled) json(response, 404, { message: "not found" });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, store };
}

describe("production routes", () => {
  it("restores an unregistered scene from the last complete workbench project", async () => {
    const fallbackProject = directorProject("#456789");
    fallbackProject.objects.push({
      id: "agent-authored-object",
      name: "Agent authored object",
      kind: "prop",
      visible: true,
      locked: false,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      geometryType: "box",
    });
    const { baseUrl } = await fixture({ fallbackProject });

    const response = await fetch(`${baseUrl}/te-man/director/scenes/local-stage/project`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sceneId: "local-stage",
      revision: 0,
      updatedBy: "workbench-fallback",
      project: {
        scene: { backgroundColor: "#456789" },
        objects: [{ id: "agent-authored-object" }],
      },
    });
  });

  it("replays an idempotent scene creation before evaluating its stale revision", async () => {
    const { baseUrl, store } = await fixture();
    const payload = {
      expectedRevision: 0,
      sceneId: "scene-a",
      title: "Scene A",
      project: directorProject(),
      idempotencyKey: "agent-create-scene-a",
    };
    const first = await fetch(`${baseUrl}/te-man/director/productions/main/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const replay = await fetch(`${baseUrl}/te-man/director/productions/main/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      revision: 1,
      mutation: { idempotencyReplayed: true },
      production: { activeSceneId: "scene-a" },
    });
    expect(store.getProduction().revision).toBe(1);
    expect(store.getSceneProject("scene-a")?.project.version).toBe(1);
  });

  it("requires an initial project and exposes revision-guarded scene project persistence", async () => {
    const { baseUrl } = await fixture();
    const missingProject = await fetch(`${baseUrl}/te-man/director/productions/main/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, sceneId: "scene-a", title: "Scene A" }),
    });
    expect(missingProject.status).toBe(422);
    expect(await missingProject.json()).toMatchObject({ code: "scene_project_required" });

    const sourceProject = directorProject("#123456");
    const created = await fetch(`${baseUrl}/te-man/director/productions/main/scenes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        sceneId: "scene-a",
        title: "Scene A",
        project: sourceProject,
      }),
    });
    expect(created.status).toBe(200);

    const observed = await fetch(`${baseUrl}/te-man/director/scenes/scene-a/project`);
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({
      sceneId: "scene-a",
      revision: 0,
      project: { scene: { backgroundColor: "#123456" } },
    });

    const changedProject = structuredClone(sourceProject);
    changedProject.scene.backgroundColor = "#654321";
    const saved = await fetch(`${baseUrl}/te-man/director/scenes/scene-a/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, project: changedProject, actor: "test" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 1, updatedBy: "test" });

    const stale = await fetch(`${baseUrl}/te-man/director/scenes/scene-a/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, project: sourceProject }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_scene_project_revision" });
  });

  it("returns machine-readable revision and idempotency conflicts", async () => {
    const { baseUrl } = await fixture();
    const stale = await fetch(`${baseUrl}/te-man/director/productions/main`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 3,
        operations: [{ op: "rename_production", title: "Stale" }],
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_production_revision" });

    const first = await fetch(`${baseUrl}/te-man/director/productions/main`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "rename-production-key",
        operations: [{ op: "rename_production", title: "First" }],
      }),
    });
    expect(first.status).toBe(200);
    const conflict = await fetch(`${baseUrl}/te-man/director/productions/main`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        idempotencyKey: "rename-production-key",
        operations: [{ op: "rename_production", title: "Different" }],
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_key_conflict" });
  });
});
