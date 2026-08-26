// @vitest-environment node

import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultScene } from "@director/stage-protocol";
import { STAGE_SCENE_QUARANTINE_LIMIT, loadStageSceneWithRecovery } from "../../stageSceneFile";

async function sceneFile() {
  const directory = await mkdtemp(resolve(tmpdir(), "director-stage-scene-"));
  return { directory, scenePath: resolve(directory, "stage-scene.json") };
}

async function listQuarantined(directory: string) {
  return (await readdir(directory)).filter((name) => name.startsWith("stage-scene.json.corrupt-")).sort();
}

describe("loadStageSceneWithRecovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads a valid persisted scene without touching it", async () => {
    const { directory, scenePath } = await sceneFile();
    const scene = createDefaultScene();
    await writeFile(scenePath, JSON.stringify(scene), "utf8");

    const result = await loadStageSceneWithRecovery(scenePath);

    expect(result.recovery).toBeNull();
    expect(result.scene).toEqual(scene);
    expect(await listQuarantined(directory)).toEqual([]);
  });

  it("treats a missing file as a normal first boot", async () => {
    const { directory, scenePath } = await sceneFile();

    const result = await loadStageSceneWithRecovery(scenePath);

    expect(result.recovery).toBeNull();
    expect(result.scene).toEqual(createDefaultScene());
    expect(await listQuarantined(directory)).toEqual([]);
  });

  it("quarantines a truncated snapshot instead of silently resetting it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { directory, scenePath } = await sceneFile();
    const truncated = '{"objects": {"floor';
    await writeFile(scenePath, truncated, "utf8");

    const result = await loadStageSceneWithRecovery(scenePath);

    expect(result.scene).toEqual(createDefaultScene());
    expect(result.recovery).not.toBeNull();
    expect(result.recovery!.reason).toContain("JSON 解析失败");
    const quarantined = await listQuarantined(directory);
    expect(quarantined).toHaveLength(1);
    expect(result.recovery!.quarantinePath).toBe(join(directory, quarantined[0]!));
    // The damaged bytes are preserved verbatim and the primary path is free
    // for the default scene to persist without destroying the original.
    expect(await readFile(result.recovery!.quarantinePath!, "utf8")).toBe(truncated);
    await expect(readFile(scenePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(quarantined[0]!));
  });

  it("quarantines a schema-invalid snapshot with the validation reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { directory, scenePath } = await sceneFile();
    const invalid = JSON.stringify({ objects: "not-a-record" });
    await writeFile(scenePath, invalid, "utf8");

    const result = await loadStageSceneWithRecovery(scenePath);

    expect(result.scene).toEqual(createDefaultScene());
    expect(result.recovery!.reason).toContain("场景数据无效");
    const quarantined = await listQuarantined(directory);
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(directory, quarantined[0]!), "utf8")).toBe(invalid);
  });

  it("bounds the quarantine to the newest snapshots", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { directory, scenePath } = await sceneFile();

    for (let index = 0; index < STAGE_SCENE_QUARANTINE_LIMIT + 2; index += 1) {
      await writeFile(scenePath, `corrupt-${index}`, "utf8");
      await loadStageSceneWithRecovery(scenePath);
    }

    const quarantined = await listQuarantined(directory);
    expect(quarantined).toHaveLength(STAGE_SCENE_QUARANTINE_LIMIT);
    const preserved = await Promise.all(quarantined.map((name) => readFile(join(directory, name), "utf8")));
    // The newest snapshots survive pruning.
    expect(preserved).toContain(`corrupt-${STAGE_SCENE_QUARANTINE_LIMIT + 1}`);
    expect(preserved).not.toContain("corrupt-0");
  });

  it("falls back to the default scene with a recovery record when the snapshot cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { scenePath } = await sceneFile();
    // A directory at the scene path fails readFile with EISDIR (not ENOENT).
    const { mkdir } = await import("node:fs/promises");
    await mkdir(scenePath);
    await writeFile(join(scenePath, "nested.txt"), "x", "utf8");

    const result = await loadStageSceneWithRecovery(scenePath);

    expect(result.scene).toEqual(createDefaultScene());
    expect(result.recovery).not.toBeNull();
    expect(result.recovery!.reason).toContain("无法读取场景文件");
    // The unreadable entry is still preserved (moved aside when possible) so
    // the default scene never overwrites it on the next persist.
    await expect(readFile(join(scenePath, "nested.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
