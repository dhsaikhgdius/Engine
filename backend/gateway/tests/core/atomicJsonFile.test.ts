import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonAtomic } from "../../atomicJsonFile";

describe("writeJsonAtomic", () => {
  it("atomically replaces JSON while preserving the requested wire formatting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "worldengine-atomic-json-"));
    const path = join(directory, "nested", "state.json");
    try {
      await writeJsonAtomic(path, { version: 1 }, { space: 0 });
      expect(await readFile(path, "utf8")).toBe('{"version":1}');

      await writeJsonAtomic(path, { version: 2 }, { trailingNewline: true });
      expect(await readFile(path, "utf8")).toBe('{\n  "version": 2\n}\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
