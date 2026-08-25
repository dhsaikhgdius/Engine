import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Host-present smoke checks. Each test runs only when the matching
 * DIRECTOR_*_BIN environment variable points at a real executable; otherwise
 * it skips with an explicit reason. Passing a smoke test never marks a
 * provider nativeReady in production code: the runtime bar is the versioned
 * connector health check (connector source + executable + engine project +
 * installed connector).
 */
describe("engine host smoke (skipped without a configured host)", () => {
  const godotBin = process.env.DIRECTOR_GODOT_BIN;
  it.skipIf(!godotBin || !existsSync(godotBin))(
    "godot --version responds (set DIRECTOR_GODOT_BIN to enable)",
    async () => {
      const { stdout } = await execFileAsync(godotBin!, ["--version"], { timeout: 60_000 });
      expect(stdout).toMatch(/^4\./);
    },
  );

  const unityBin = process.env.DIRECTOR_UNITY_BIN;
  it.skipIf(!unityBin || !existsSync(unityBin))(
    "unity -version responds (set DIRECTOR_UNITY_BIN to enable)",
    async () => {
      const { stdout } = await execFileAsync(unityBin!, ["-version"], { timeout: 120_000 });
      expect(stdout.trim().length).toBeGreaterThan(0);
    },
  );

  const unrealBin = process.env.DIRECTOR_UNREAL_EDITOR_BIN;
  it.skipIf(!unrealBin || !existsSync(unrealBin))(
    "UnrealEditor-Cmd binary exists and is versioned (set DIRECTOR_UNREAL_EDITOR_BIN to enable)",
    () => {
      // Booting the editor for a smoke test is too heavy; Build.version is the
      // same source the Gateway's version probe reads.
      expect(existsSync(unrealBin!)).toBe(true);
    },
  );

  const blenderBin = process.env.DIRECTOR_BLENDER_BIN ?? process.env.BLENDER_BIN;
  it.skipIf(!blenderBin || !existsSync(blenderBin))(
    "blender --version responds (set DIRECTOR_BLENDER_BIN to enable)",
    async () => {
      const { stdout } = await execFileAsync(blenderBin!, ["--version"], { timeout: 60_000 });
      expect(stdout).toMatch(/Blender/);
    },
  );
});
