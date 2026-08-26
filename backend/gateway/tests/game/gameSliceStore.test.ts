import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGameSliceFromBrief, type GameSlice } from "../../../../packages/protocol/src/gameSliceProtocol";
import { GameSliceStore } from "../../game/gameSliceStore";

const NOW = "2026-08-26T03:00:00.000Z";

function baseSlice(id: string): GameSlice {
  return createGameSliceFromBrief({
    id,
    now: NOW,
    brief: { requirement: "Walk to the stele and interact.", genre: "exploration" },
  });
}

describe("GameSliceStore", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createStore() {
    const dir = await mkdtemp(join(tmpdir(), "director-game-store-"));
    tempDirs.push(dir);
    return { store: new GameSliceStore(dir), dir };
  }

  it("round-trips slices through put/get/loadAll and overwrites in place", async () => {
    const { store } = await createStore();
    await store.put(baseSlice("game-courtyard-01"));
    await store.put(baseSlice("game-rooftop-02"));
    await store.put({ ...baseSlice("game-courtyard-01"), title: "Courtyard stele" });

    const read = await store.get("game-courtyard-01");
    expect(read?.title).toBe("Courtyard stele");
    const all = await store.loadAll();
    expect(all.map((slice) => slice.id).sort()).toEqual(["game-courtyard-01", "game-rooftop-02"]);
  });

  it("serializes concurrent updates through the per-id lock", async () => {
    const { store } = await createStore();
    await store.put(baseSlice("game-courtyard-01"));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.update("game-courtyard-01", (slice) => ({
          ...slice,
          notes: [...slice.notes, `event ${index}`],
        })),
      ),
    );
    const slice = await store.get("game-courtyard-01");
    // The pristine slice carries default notes; every concurrent append must survive.
    expect(slice?.notes.filter((note) => note.startsWith("event "))).toHaveLength(8);
  });

  it("rejects invalid ids and unknown slices", async () => {
    const { store } = await createStore();
    expect(await store.get("../escape")).toBeNull();
    await expect(store.put({ ...baseSlice("game-courtyard-01"), id: "../escape" } as GameSlice)).rejects.toThrow();
    await expect(store.update("game-missing-slice-01", (slice) => slice)).rejects.toThrow(/Unknown game slice/);
  });

  it("skips corrupt documents instead of failing loadAll", async () => {
    const { store, dir } = await createStore();
    await store.put(baseSlice("game-courtyard-01"));
    await writeFile(join(dir, "game-slices", "game-broken-01.json"), "{ not json", "utf8");
    const all = await store.loadAll();
    expect(all.map((slice) => slice.id)).toEqual(["game-courtyard-01"]);
    expect(await store.get("game-broken-01")).toBeNull();
  });
});
