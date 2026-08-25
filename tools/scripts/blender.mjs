#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worldEngineRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const blenderLiveRoot = join(worldEngineRoot, "integrations", "blender", "live");
const blenderBackendScript = join(blenderLiveRoot, "worldengine_backend.py");
const command = process.argv[2] ?? "run";

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function blenderExecutable() {
  const candidates = [
    process.env.BLENDER_BIN,
    join(worldEngineRoot, ".runtime", "blender-build", "bin", "Blender.app", "Contents", "MacOS", "Blender"),
    join(worldEngineRoot, ".runtime", "blender-build", "bin", "blender"),
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
  ].filter(Boolean);
  const executable = candidates.find(isExecutable);
  if (!executable) {
    throw new Error("Blender 4.2+ not found. Install Blender or set BLENDER_BIN.");
  }
  return executable;
}

function nativeEnvironment() {
  const sessionPort = process.env.WORLDENGINE_SESSION_PORT ?? "8791";
  return {
    ...process.env,
    BLENDER_USER_SCRIPTS: blenderLiveRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    DIRECTOR_BLENDER_PROJECT_FILE:
      process.env.DIRECTOR_BLENDER_PROJECT_FILE ??
      join(
        resolve(worldEngineRoot, process.env.DIRECTOR_DATA_DIRECTORY ?? "data"),
        "blender",
        "director-native.blend",
      ),
    WORLDENGINE_SESSION_PORT: sessionPort,
  };
}

function run(executable, args, options = {}) {
  const child = spawn(executable, args, { stdio: "inherit", ...options });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (command === "test") {
  const executable = blenderExecutable();
  const testRoot = join(blenderLiveRoot, "addons", "worldengine_studio", "tests");
  for (const script of [
    "blender_camera_snapshot_smoke.py",
    "blender_modeling_smoke.py",
    "blender_geometry_smoke.py",
    "blender_smoke.py",
    "blender_gateway_smoke.py",
  ]) {
    const child = spawnSync(
      executable,
      ["--background", "--factory-startup", "--python-exit-code", "1", "--python", join(testRoot, script)],
      { cwd: worldEngineRoot, env: nativeEnvironment(), stdio: "inherit" },
    );
    if (child.error) {
      throw child.error;
    }
    if (child.signal) {
      process.kill(process.pid, child.signal);
    }
    if (child.status !== 0) {
      process.exit(child.status ?? 1);
    }
  }
} else if (command === "run") {
  run(blenderExecutable(), ["--background", "--factory-startup", "--python", blenderBackendScript], {
    cwd: worldEngineRoot,
    env: nativeEnvironment(),
  });
} else {
  throw new Error(`Unknown Blender command: ${command}`);
}
