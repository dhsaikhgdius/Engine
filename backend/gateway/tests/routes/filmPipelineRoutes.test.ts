import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filmRunSchema } from "../../../../packages/protocol/src/filmPipelineProtocol";
import type { FilmPipelineOrchestrator } from "../../film/filmPipelineOrchestrator";
import { FilmRunStore } from "../../film/filmRunStore";
import { handleFilmPipelineRoute, type FilmPipelineRouteDependencies } from "../../routes/filmPipelineRoutes";

describe("film pipeline routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  function run(id: string) {
    const now = new Date().toISOString();
    return filmRunSchema.parse({
      version: 1,
      id,
      workflow: "idea-to-film",
      status: "queued",
      phase: "develop-story",
      input: { idea: "灯塔守夜人" },
      createdAt: now,
      updatedAt: now,
    });
  }

  async function harness(payload: unknown, options: { configured?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "director-film-routes-"));
    tempDirs.push(dir);
    const store = new FilmRunStore(dir);
    const writes: Array<{ status: number; body: unknown }> = [];
    const orchestrator = {
      create: vi.fn(async () => run("film-created0-0000")),
      resume: vi.fn(async () => run("film-resumed0-0000")),
      cancel: vi.fn(async () => run("film-cancel00-0000")),
      approve: vi.fn(async () => run("film-approve0-0000")),
    };
    const dependencies: FilmPipelineRouteDependencies = {
      readBody: async () => payload,
      json: (_response, status, body) => writes.push({ status, body }),
      store,
      orchestrator: (options.configured === false ? null : orchestrator) as unknown as FilmPipelineOrchestrator,
      unconfiguredReason: options.configured === false ? "缺少配置" : undefined,
    };
    const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    return { store, writes, dependencies, response, orchestrator };
  }

  const request = (method: string) => ({ method }) as IncomingMessage;
  const url = (pathname: string) => new URL(`http://127.0.0.1:8787${pathname}`);

  it("lists runs and returns run documents", async () => {
    const context = await harness(null);
    await context.store.create(run("film-aaaaaaaa-1111"));
    expect(
      await handleFilmPipelineRoute(request("GET"), context.response, url("/api/film/runs"), context.dependencies),
    ).toBe(true);
    expect(context.writes[0].status).toBe(200);
    expect((context.writes[0].body as { runs: unknown[] }).runs).toHaveLength(1);

    expect(
      await handleFilmPipelineRoute(
        request("GET"),
        context.response,
        url("/api/film/runs/film-aaaaaaaa-1111"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[1].status).toBe(200);
  });

  it("creates runs and rejects invalid payloads", async () => {
    const valid = await harness({ workflow: "idea-to-film", input: { idea: "一个想法" } });
    expect(
      await handleFilmPipelineRoute(request("POST"), valid.response, url("/api/film/runs"), valid.dependencies),
    ).toBe(true);
    expect(valid.writes[0].status).toBe(202);
    expect(valid.orchestrator.create).toHaveBeenCalledOnce();

    const invalid = await harness({ workflow: "idea-to-film", input: {} });
    await handleFilmPipelineRoute(request("POST"), invalid.response, url("/api/film/runs"), invalid.dependencies);
    expect(invalid.writes[0].status).toBe(400);
  });

  it("returns 503 when providers are unconfigured", async () => {
    const context = await harness({ workflow: "idea-to-film", input: { idea: "x" } }, { configured: false });
    await handleFilmPipelineRoute(request("POST"), context.response, url("/api/film/runs"), context.dependencies);
    expect(context.writes[0]).toMatchObject({ status: 503 });
  });

  it("routes get/resume/cancel/approve for existing runs and 404s for unknown ids", async () => {
    const context = await harness(null);
    await context.store.create(run("film-bbbbbbbb-2222"));
    for (const action of ["resume", "cancel", "approve"] as const) {
      await handleFilmPipelineRoute(
        request("POST"),
        context.response,
        url(`/api/film/runs/film-bbbbbbbb-2222/${action}`),
        context.dependencies,
      );
    }
    expect(context.orchestrator.resume).toHaveBeenCalledWith("film-bbbbbbbb-2222");
    expect(context.orchestrator.cancel).toHaveBeenCalledWith("film-bbbbbbbb-2222");
    expect(context.orchestrator.approve).toHaveBeenCalledWith("film-bbbbbbbb-2222");

    await handleFilmPipelineRoute(
      request("GET"),
      context.response,
      url("/api/film/runs/film-missing0-0000"),
      context.dependencies,
    );
    expect(context.writes.at(-1)).toMatchObject({ status: 404 });
  });
});
