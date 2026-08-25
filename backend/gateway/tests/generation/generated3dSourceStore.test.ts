import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Generated3DSourceStore } from "../../generation/generated3dSourceStore";

describe("Generated3DSourceStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    directories.length = 0;
  });

  it("stores source images by verified content hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-generated-3d-source-"));
    directories.push(directory);
    const store = new Generated3DSourceStore(directory);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("director-image")]);
    const source = await store.importDataUrl(`data:image/jpeg;base64,${bytes.toString("base64")}`);
    expect(source).toMatchObject({ mimeType: "image/jpeg", bytes: bytes.byteLength });
    expect(await store.read(source)).toEqual(bytes);
    expect(await store.importDataUrl(`data:image/jpeg;base64,${bytes.toString("base64")}`)).toEqual(source);
  });

  it("rejects MIME/signature mismatches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "director-generated-3d-source-"));
    directories.push(directory);
    const store = new Generated3DSourceStore(directory);
    await expect(
      store.importDataUrl(`data:image/png;base64,${Buffer.from("not-png").toString("base64")}`),
    ).rejects.toThrow(/do not match/);
  });
});
