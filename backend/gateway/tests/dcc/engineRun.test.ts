import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectorDccEngineRunManager } from "../../dcc/engineRun";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createGodotHarness() {
  const root = await mkdtemp(resolve(tmpdir(), "director-engine-run-"));
  temporaryRoots.push(root);
  const projectPath = resolve(root, "GodotProject");
  await mkdir(projectPath, { recursive: true });
  await writeFile(resolve(projectPath, "project.godot"), "config_version=5\n");
  const argvCapture = resolve(root, "argv.txt");
  const fakeGodot = resolve(root, "godot");
  // The fake engine records its argv, prints one line, and idles until killed.
  await writeFile(
    fakeGodot,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvCapture}"\necho "[fixture] engine running"\nsleep 60\n`,
    { mode: 0o755 },
  );
  const environment = {
    PATH: "",
    DIRECTOR_GODOT_BIN: fakeGodot,
    DIRECTOR_GODOT_PROJECT: projectPath,
  };
  return { root, projectPath, argvCapture, fakeGodot, environment };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the run state change.");
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const contents = await readFile(path, "utf8").catch(() => null);
    if (contents !== null && contents.length > 0) return contents;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
}

describe("Director DCC engine run manager", () => {
  it("runs the configured Godot project with a fixed argv, captures output, and stops with SIGTERM", async () => {
    const harness = await createGodotHarness();
    const manager = createDirectorDccEngineRunManager({ environment: harness.environment });

    const started = await manager.runProject("godot", { scene: "res://scenes/main.tscn", headless: true });
    expect(started.contract).toBe("director-dcc-engine-run-v1");
    expect(started.state).toBe("running");
    expect(started.scene).toBe("res://scenes/main.tscn");
    expect(started.headless).toBe(true);
    expect(started.pid).toBeGreaterThan(0);

    await waitUntil(() => manager.runStatus("godot").output.includes("[fixture] engine running"));
    const argv = (await readFile(harness.argvCapture, "utf8")).trim().split("\n");
    expect(argv).toEqual(["--path", await realpath(harness.projectPath), "--headless", "res://scenes/main.tscn"]);

    const stopped = await manager.stopRun("godot");
    expect(stopped.state).toBe("stopped");
    expect(stopped.endedAtMs).not.toBeNull();
    expect(stopped.output).toContain("[fixture] engine running");

    // A finished run stays readable and a new run may start afterwards.
    expect(manager.runStatus("godot").state).toBe("stopped");
    const second = await manager.runProject("godot", { headless: true });
    expect(second.runId).not.toBe(started.runId);
    await manager.stopRun("godot");
  });

  it("records a clean exit as exited and keeps the bounded output tail", async () => {
    const harness = await createGodotHarness();
    await writeFile(harness.fakeGodot, `#!/bin/sh\necho "one"\necho "two"\nexit 0\n`, { mode: 0o755 });
    const manager = createDirectorDccEngineRunManager({ environment: harness.environment, maxOutputBytes: 4_096 });
    await manager.runProject("godot");
    await waitUntil(() => manager.runStatus("godot").state === "exited");
    const status = manager.runStatus("godot");
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain("one");
    expect(status.output).toContain("two");
    expect(status.outputTruncated).toBe(false);
  });

  it("marks a non-zero exit as failed and truncates oversized output to a tail", async () => {
    const harness = await createGodotHarness();
    await writeFile(harness.fakeGodot, `#!/bin/sh\ni=0\nwhile [ $i -lt 400 ]; do echo "line-$i"; i=$((i+1)); done\nexit 3\n`, {
      mode: 0o755,
    });
    const manager = createDirectorDccEngineRunManager({ environment: harness.environment, maxOutputBytes: 1_024 });
    await manager.runProject("godot");
    await waitUntil(() => manager.runStatus("godot").state === "failed");
    const status = manager.runStatus("godot");
    expect(status.exitCode).toBe(3);
    expect(status.outputTruncated).toBe(true);
    expect(status.output).toContain("line-399");
    expect(status.output).not.toContain("line-0\n");
  });

  it("refuses overlapping runs, unknown statuses, and unsafe scene paths", async () => {
    const harness = await createGodotHarness();
    const manager = createDirectorDccEngineRunManager({ environment: harness.environment });
    expect(() => manager.runStatus("godot")).toThrowError(
      expect.objectContaining({ code: "engine_run_unknown", status: 404 }),
    );
    await expect(manager.stopRun("godot")).rejects.toMatchObject({ code: "engine_run_unknown" });

    await manager.runProject("godot", { headless: true });
    await expect(manager.runProject("godot")).rejects.toMatchObject({ code: "engine_run_active", status: 409 });
    await expect(manager.runProject("godot", { scene: "res://../escape.tscn" })).rejects.toThrow();
    await manager.stopRun("godot");
  });

  it("reports structured not-ready diagnostics and unsupported engines with recovery steps", async () => {
    const manager = createDirectorDccEngineRunManager({ environment: { PATH: "" } });
    await expect(manager.runProject("godot")).rejects.toMatchObject({
      code: "engine_run_not_ready",
      status: 503,
      recovery: expect.arrayContaining([expect.stringContaining("DIRECTOR_GODOT_BIN")]),
    });
    const harness = await createGodotHarness();
    const configured = createDirectorDccEngineRunManager({
      environment: { ...harness.environment, DIRECTOR_UNITY_BIN: harness.fakeGodot },
    });
    await expect(configured.runProject("unity")).rejects.toMatchObject({
      code: "engine_run_unsupported",
      status: 501,
    });
    await expect(configured.runProject("unreal")).rejects.toMatchObject({ code: "engine_run_unsupported" });
  });

  it("launches the Godot editor detached against the configured project", async () => {
    const harness = await createGodotHarness();
    const manager = createDirectorDccEngineRunManager({ environment: harness.environment });
    const launch = await manager.launchEditor("godot");
    expect(launch.contract).toBe("director-dcc-engine-editor-launch-v1");
    expect(launch.pid).toBeGreaterThan(0);
    expect(launch.executable).toBe(harness.fakeGodot);
    const argv = (await waitForFile(harness.argvCapture)).trim().split("\n");
    expect(argv).toEqual(["--editor", "--path", await realpath(harness.projectPath)]);
    process.kill(launch.pid, "SIGKILL");
  });

  it("maps the Unreal console binary onto its GUI sibling for editor launches", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-engine-run-unreal-"));
    temporaryRoots.push(root);
    const projectPath = resolve(root, "UnrealProject");
    await mkdir(projectPath, { recursive: true });
    await writeFile(resolve(projectPath, "Fixture.uproject"), "{}\n");
    const argvCapture = resolve(root, "argv.txt");
    const consoleBinary = resolve(root, "UnrealEditor-Cmd");
    const guiBinary = resolve(root, "UnrealEditor");
    await writeFile(consoleBinary, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
    await writeFile(guiBinary, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvCapture}"\nexit 0\n`, { mode: 0o755 });
    const manager = createDirectorDccEngineRunManager({
      environment: {
        PATH: "",
        DIRECTOR_UNREAL_EDITOR_BIN: consoleBinary,
        DIRECTOR_UNREAL_PROJECT: projectPath,
      },
    });
    const launch = await manager.launchEditor("unreal");
    expect(launch.executable).toBe(guiBinary);
    expect(launch.warnings).toEqual([]);
    const argv = (await waitForFile(argvCapture)).trim();
    expect(argv).toBe(resolve(await realpath(projectPath), "Fixture.uproject"));
  });
});
