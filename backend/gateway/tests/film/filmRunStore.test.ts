import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filmRunSchema, type FilmRun } from "../../../../packages/protocol/src/filmPipelineProtocol";
import { FilmRunStore } from "../../film/filmRunStore";

function baseRun(id: string): FilmRun {
  const now = new Date().toISOString();
  return filmRunSchema.parse({
    version: 1,
    id,
    workflow: "idea-to-film",
    status: "queued",
    phase: "develop-story",
    input: { idea: "海边灯塔看守人的一夜" },
    createdAt: now,
    updatedAt: now,
  });
}

describe("FilmRunStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createStore() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-store-"));
    tempDirs.push(dir);
    return new FilmRunStore(dir);
  }

  it("round-trips runs and lists newest first", async () => {
    const store = await createStore();
    await store.create(baseRun("film-aaaaaaaa-1111"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.create(baseRun("film-bbbbbbbb-2222"));
    const listed = await store.list();
    expect(listed.map((run) => run.id)).toEqual(["film-bbbbbbbb-2222", "film-aaaaaaaa-1111"]);
  });

  it("serializes concurrent updates through the per-run lock", async () => {
    const store = await createStore();
    await store.create(baseRun("film-cccccccc-3333"));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.update("film-cccccccc-3333", (run) => ({
          ...run,
          events: [...run.events, { at: new Date().toISOString(), stage: "test", message: `event ${index}` }],
        })),
      ),
    );
    const run = await store.get("film-cccccccc-3333");
    expect(run?.events).toHaveLength(8);
  });

  it("rejects invalid ids and unknown runs", async () => {
    const store = await createStore();
    expect(await store.get("../escape")).toBeNull();
    expect(() => store.runDirectory("../escape")).toThrow(/Invalid film run id/);
    await expect(store.update("film-dddddddd-4444", (run) => run)).rejects.toThrow(/Unknown film run/);
  });

  it("marks non-completed runs cancelled and closes open phase receipts", async () => {
    const store = await createStore();
    await store.create(
      filmRunSchema.parse({
        ...baseRun("film-eeeeeeee-5555"),
        status: "running",
        phaseReceipts: [{ phase: "develop-story", startedAt: new Date().toISOString(), finishedAt: null }],
      }),
    );
    const cancelled = await store.markCancelled("film-eeeeeeee-5555");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.phaseReceipts[0]?.finishedAt).not.toBeNull();

    await store.create(filmRunSchema.parse({ ...baseRun("film-ffffffff-6666"), status: "completed" }));
    expect((await store.markCancelled("film-ffffffff-6666")).status).toBe("completed");
  });

  it("probes live artifact byte presence for claimed paths only", async () => {
    const store = await createStore();

    // No claims yet: nothing to probe, nothing reported.
    const queued = await store.create(baseRun("film-55555555-eeee"));
    expect(await store.artifactStoragePresence(queued)).toEqual({});

    const runDirectory = store.runDirectory("film-66666666-ffff");
    await mkdir(runDirectory, { recursive: true });
    const finalVideoPath = join(runDirectory, "final_video.mp4");
    await writeFile(finalVideoPath, "mp4-bytes");
    const completed = await store.create(
      filmRunSchema.parse({
        ...baseRun("film-66666666-ffff"),
        status: "completed",
        phase: "completed",
        finalVideoPath,
        timelinePath: join(runDirectory, "timeline.otio"),
      }),
    );

    // The final video bytes exist; the claimed timeline was never written.
    expect(await store.artifactStoragePresence(completed)).toEqual({ finalVideo: "present", timeline: "absent" });

    // Cleanup after the run finished ages the video bytes out too.
    await rm(finalVideoPath);
    expect(await store.artifactStoragePresence(completed)).toEqual({ finalVideo: "absent", timeline: "absent" });
  });

  it("reconciles queued/running restart survivors into interrupted-failed runs", async () => {
    const store = await createStore();
    await store.create(filmRunSchema.parse({ ...baseRun("film-11111111-aaaa"), status: "queued" }));
    await store.create(
      filmRunSchema.parse({
        ...baseRun("film-22222222-bbbb"),
        status: "running",
        phase: "render",
        phaseReceipts: [{ phase: "render", startedAt: new Date().toISOString(), finishedAt: null }],
      }),
    );
    await store.create(filmRunSchema.parse({ ...baseRun("film-33333333-cccc"), status: "completed" }));
    await store.create(filmRunSchema.parse({ ...baseRun("film-44444444-dddd"), status: "waiting_approval" }));

    const interrupted = await store.reconcileInterrupted();
    expect(interrupted.sort()).toEqual(["film-11111111-aaaa", "film-22222222-bbbb"]);

    const running = await store.get("film-22222222-bbbb");
    expect(running?.status).toBe("failed");
    expect(running?.errorCode).toBe("film_run_interrupted");
    expect(running?.error).toContain("resume continues");
    expect(running?.phaseReceipts[0]?.finishedAt).not.toBeNull();
    expect(running?.events.at(-1)?.stage).toBe("reconcile");

    // Terminal and gate states are untouched, and a second pass is a no-op.
    expect((await store.get("film-33333333-cccc"))?.status).toBe("completed");
    expect((await store.get("film-44444444-dddd"))?.status).toBe("waiting_approval");
    expect(await store.reconcileInterrupted()).toEqual([]);
  });
});
