import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import { createFilmPipeline } from "../../film/createFilmPipeline";

describe("createFilmPipeline", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function dataDirectory() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-factory-"));
    tempDirs.push(dir);
    return dir;
  }

  it("stays readable but unconfigured without providers", async () => {
    const config = loadDirectorControlPlaneConfig("/tmp/workspace", {});
    const pipeline = createFilmPipeline(config, await dataDirectory());
    expect(pipeline.orchestrator).toBeNull();
    expect(pipeline.unconfiguredReason).toContain("Film pipeline 未配置");
    expect(await pipeline.store.list()).toEqual([]);
  });

  it("builds the orchestrator from one OpenRouter-style key set", async () => {
    const config = loadDirectorControlPlaneConfig("/tmp/workspace", {
      DIRECTOR_FILM_LLM_BASE_URL: "https://openrouter.ai/api/v1",
      DIRECTOR_FILM_LLM_API_KEY: "film-secret",
      DIRECTOR_FILM_LLM_MODEL: "google/gemini-2.5-flash",
    });
    expect(config.film.image.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.film.video.baseUrl).toBe("https://openrouter.ai/api/v1");
    const pipeline = createFilmPipeline(config, await dataDirectory());
    expect(pipeline.orchestrator).not.toBeNull();
    expect(pipeline.unconfiguredReason).toBeUndefined();
  });
});
