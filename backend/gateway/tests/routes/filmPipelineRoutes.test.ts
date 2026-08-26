import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("lists runs with the pipeline state and returns run documents with receipts", async () => {
    const context = await harness(null);
    await context.store.create(run("film-aaaaaaaa-1111"));
    expect(
      await handleFilmPipelineRoute(request("GET"), context.response, url("/api/film/runs"), context.dependencies),
    ).toBe(true);
    expect(context.writes[0].status).toBe(200);
    const list = context.writes[0].body as { runs: unknown[]; pipeline: { configured: boolean; reason: null } };
    expect(list.runs).toHaveLength(1);
    expect(list.pipeline).toEqual({ configured: true, reason: null });

    expect(
      await handleFilmPipelineRoute(
        request("GET"),
        context.response,
        url("/api/film/runs/film-aaaaaaaa-1111"),
        context.dependencies,
      ),
    ).toBe(true);
    expect(context.writes[1].status).toBe(200);
    const status = context.writes[1].body as { run: { id: string }; receipt: { contract: string; runId: string } };
    expect(status.run.id).toBe("film-aaaaaaaa-1111");
    expect(status.receipt.contract).toBe("director-film-run-receipt-v1");
    expect(status.receipt.runId).toBe("film-aaaaaaaa-1111");
  });

  it("serves the normalized receipt route", async () => {
    const context = await harness(null);
    await context.store.create(run("film-aaaaaaaa-1111"));
    expect(
      await handleFilmPipelineRoute(
        request("GET"),
        context.response,
        url("/api/film/runs/film-aaaaaaaa-1111/receipt"),
        context.dependencies,
      ),
    ).toBe(true);
    const body = context.writes[0].body as { receipt: { contract: string; terminal: boolean; progress: number } };
    expect(context.writes[0].status).toBe(200);
    expect(body.receipt.contract).toBe("director-film-run-receipt-v1");
    expect(body.receipt.terminal).toBe(false);
  });

  it("projects live artifact storagePresence on receipt-carrying responses", async () => {
    const context = await harness(null);

    // Runs with no artifact claims report null presence for both slots.
    await context.store.create(run("film-aaaaaaaa-1111"));
    await handleFilmPipelineRoute(
      request("GET"),
      context.response,
      url("/api/film/runs/film-aaaaaaaa-1111/receipt"),
      context.dependencies,
    );
    const queued = context.writes[0].body as {
      receipt: { artifacts: { storagePresence: { finalVideo: null; timeline: null } } };
    };
    expect(queued.receipt.artifacts.storagePresence).toEqual({ finalVideo: null, timeline: null });

    // Claimed paths are probed at read time: the final video bytes exist,
    // the claimed timeline file was deleted after the run finished.
    const runDirectory = context.store.runDirectory("film-bbbbbbbb-2222");
    await mkdir(runDirectory, { recursive: true });
    const finalVideoPath = join(runDirectory, "final_video.mp4");
    await writeFile(finalVideoPath, "mp4-bytes");
    const completed = run("film-bbbbbbbb-2222");
    await context.store.create(
      filmRunSchema.parse({
        ...completed,
        status: "completed",
        phase: "completed",
        finalVideoPath,
        timelinePath: join(runDirectory, "timeline.otio"),
      }),
    );
    await handleFilmPipelineRoute(
      request("GET"),
      context.response,
      url("/api/film/runs/film-bbbbbbbb-2222"),
      context.dependencies,
    );
    const status = context.writes[1].body as {
      receipt: { artifacts: { finalVideoPath: string; storagePresence: { finalVideo: string; timeline: string } } };
    };
    expect(status.receipt.artifacts.finalVideoPath).toBe(finalVideoPath);
    expect(status.receipt.artifacts.storagePresence).toEqual({ finalVideo: "present", timeline: "absent" });

    // Later cleanup ages the video bytes out; the next read reports it honestly.
    await rm(finalVideoPath);
    await handleFilmPipelineRoute(
      request("GET"),
      context.response,
      url("/api/film/runs/film-bbbbbbbb-2222/receipt"),
      context.dependencies,
    );
    const stale = context.writes[2].body as {
      receipt: { artifacts: { storagePresence: { finalVideo: string; timeline: string } } };
    };
    expect(stale.receipt.artifacts.storagePresence).toEqual({ finalVideo: "absent", timeline: "absent" });
  });

  it("serves the durable typed timeline export receipt on receipt responses", async () => {
    const context = await harness(null);
    const runDirectory = context.store.runDirectory("film-cccccccc-3333");
    await mkdir(runDirectory, { recursive: true });
    const timelinePath = join(runDirectory, "timeline.otio");
    await writeFile(timelinePath, "{}");
    const timelineExport = {
      shotCount: 3,
      clipCount: 2,
      omittedShotCount: 1,
      omittedShots: [{ sceneIdx: 0, shotIdx: 2, code: "clip_missing" as const, reason: "clip bytes were missing" }],
    };
    await context.store.create(
      filmRunSchema.parse({
        ...run("film-cccccccc-3333"),
        status: "completed",
        phase: "completed",
        timelinePath,
        timelineExport,
      }),
    );
    await handleFilmPipelineRoute(
      request("GET"),
      context.response,
      url("/api/film/runs/film-cccccccc-3333/receipt"),
      context.dependencies,
    );
    const body = context.writes[0].body as {
      receipt: { artifacts: { timelinePath: string; timelineExport: unknown } };
    };
    expect(body.receipt.artifacts.timelinePath).toBe(timelinePath);
    expect(body.receipt.artifacts.timelineExport).toEqual(timelineExport);
  });

  it("reports the unconfigured pipeline as an explicit state on the list surface", async () => {
    const context = await harness(null, { configured: false });
    await handleFilmPipelineRoute(request("GET"), context.response, url("/api/film/runs"), context.dependencies);
    const body = context.writes[0].body as { pipeline: { configured: boolean; reason: string } };
    expect(context.writes[0].status).toBe(200);
    expect(body.pipeline.configured).toBe(false);
    expect(body.pipeline.reason).toBe("缺少配置");
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

  it("returns 503 with the frozen code when providers are unconfigured", async () => {
    const context = await harness({ workflow: "idea-to-film", input: { idea: "x" } }, { configured: false });
    await handleFilmPipelineRoute(request("POST"), context.response, url("/api/film/runs"), context.dependencies);
    expect(context.writes[0]).toMatchObject({ status: 503, body: { code: "film_pipeline_unconfigured" } });

    await context.store.create(run("film-stale000-0000"));
    for (const action of ["resume", "approve"] as const) {
      await handleFilmPipelineRoute(
        request("POST"),
        context.response,
        url(`/api/film/runs/film-stale000-0000/${action}`),
        context.dependencies,
      );
      expect(context.writes.at(-1)).toMatchObject({ status: 503, body: { code: "film_pipeline_unconfigured" } });
    }
  });

  it("cancels stale runs even when the pipeline is unconfigured", async () => {
    const context = await harness(null, { configured: false });
    await context.store.create(run("film-stale111-1111"));
    await handleFilmPipelineRoute(
      request("POST"),
      context.response,
      url("/api/film/runs/film-stale111-1111/cancel"),
      context.dependencies,
    );
    expect(context.writes[0].status).toBe(200);
    const body = context.writes[0].body as { run: { status: string }; receipt: { status: string; terminal: boolean } };
    expect(body.run.status).toBe("cancelled");
    expect(body.receipt.terminal).toBe(true);
    expect((await context.store.get("film-stale111-1111"))?.status).toBe("cancelled");
  });

  it("answers every failure with a frozen public error code", async () => {
    const invalidId = await harness(null);
    await handleFilmPipelineRoute(
      request("GET"),
      invalidId.response,
      url("/api/film/runs/%ZZ"),
      invalidId.dependencies,
    );
    expect(invalidId.writes[0]).toMatchObject({ status: 400, body: { code: "invalid_run_id" } });

    const missing = await harness(null);
    await handleFilmPipelineRoute(
      request("GET"),
      missing.response,
      url("/api/film/runs/film-missing0-0000"),
      missing.dependencies,
    );
    expect(missing.writes[0]).toMatchObject({ status: 404, body: { code: "run_not_found" } });

    const invalid = await harness({ workflow: "idea-to-film", input: {} });
    await handleFilmPipelineRoute(request("POST"), invalid.response, url("/api/film/runs"), invalid.dependencies);
    expect(invalid.writes[0]).toMatchObject({ status: 400, body: { code: "invalid_request" } });
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
