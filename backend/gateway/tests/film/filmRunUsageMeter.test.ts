import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filmRunSchema } from "../../../../packages/protocol/src/filmPipelineProtocol";
import { FilmRunStore } from "../../film/filmRunStore";
import { createFilmRunAttributingMeter, filmRunUsageContext } from "../../film/filmRunUsageMeter";

describe("createFilmRunAttributingMeter", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function storeWithRun(id = "film-usage-test-0001") {
    const directory = await mkdtemp(join(tmpdir(), "film-usage-"));
    directories.push(directory);
    const store = new FilmRunStore(directory);
    const now = "2026-08-26T00:00:00.000Z";
    await store.create(
      filmRunSchema.parse({
        version: 1,
        id,
        workflow: "idea-to-film",
        status: "running",
        phase: "develop-story",
        input: { idea: "灯塔" },
        createdAt: now,
        updatedAt: now,
      }),
    );
    return { store, id };
  }

  it("forwards every sample downstream and folds film scopes into the active run", async () => {
    const { store, id } = await storeWithRun();
    const downstream = vi.fn();
    const meter = createFilmRunAttributingMeter(store, downstream);

    await filmRunUsageContext.run(id, async () => {
      meter({
        scope: "film-llm",
        provider: "openai-compatible",
        model: "test",
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        duration_ms: 100,
        retries: 0,
        succeeded: true,
      });
      meter({
        scope: "film-image",
        provider: "openai-compatible",
        model: "image",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 250,
        retries: 0,
        succeeded: true,
      });
      meter({
        scope: "film-tts",
        provider: "speech-api:tts-1",
        model: "tts-1",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        duration_ms: 80,
        retries: 1,
        succeeded: true,
      });
      meter({
        scope: "prod-session",
        provider: "api",
        model: "other",
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        duration_ms: 10,
        retries: 0,
        succeeded: true,
      });
    });

    // Allow fire-and-forget store updates to settle.
    await vi.waitFor(async () => {
      const run = await store.get(id);
      expect(run?.usage["film-llm"].sample_count).toBe(1);
      expect(run?.usage["film-llm"].total_tokens).toBe(14);
      expect(run?.usage["film-image"].total_duration_ms).toBe(250);
      expect(run?.usage["film-video"].sample_count).toBe(0);
      expect(run?.usage["film-tts"].sample_count).toBe(1);
      expect(run?.usage["film-tts"].total_duration_ms).toBe(80);
      expect(run?.usage["film-tts"].retries).toBe(1);
    });
    expect(downstream).toHaveBeenCalledTimes(4);
  });

  it("does not attribute samples outside an active film-run context", async () => {
    const { store, id } = await storeWithRun("film-usage-test-0002");
    const meter = createFilmRunAttributingMeter(store);
    meter({
      scope: "film-llm",
      provider: "openai-compatible",
      model: "test",
      input_tokens: 5,
      output_tokens: 5,
      total_tokens: 10,
      duration_ms: 50,
      retries: 0,
      succeeded: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const run = await store.get(id);
    expect(run?.usage["film-llm"].sample_count).toBe(0);
  });
});
