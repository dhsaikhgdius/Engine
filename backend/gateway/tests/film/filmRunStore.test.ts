import { mkdtemp, rm } from "node:fs/promises";
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
});
