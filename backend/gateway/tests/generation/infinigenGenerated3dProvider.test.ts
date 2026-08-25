import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDirectorControlPlaneConfig } from "../../controlPlane/controlPlaneConfig";
import type { Generated3DJobInput } from "../../../../packages/protocol/src/generated3dProtocol";
import { Generated3DProviderRegistry } from "../../generation/generated3dProviders";
import {
  InfinigenGenerated3DProvider,
  resolveInfinigenFactory,
  type InfinigenProviderConfig,
} from "../../generation/infinigenGenerated3dProvider";

const WORKSPACE_CATALOG = resolve(import.meta.dirname, "../../../../integrations/infinigen/factory_catalog.json");

function jobInput(prompt: string): Generated3DJobInput {
  return {
    mode: "text-to-3d",
    providerId: "infinigen",
    name: "程序化资产",
    prompt,
    negativePrompt: undefined,
    sourceImage: null,
    targetHeightMeters: 1,
    topology: "triangle",
    targetPolygonCount: 50_000,
    texture: true,
    pbr: true,
    seed: 7,
    modelVersion: undefined,
  };
}

async function makeProvider(runnerBody: string) {
  const workDir = await mkdtemp(join(tmpdir(), "director-infinigen-"));
  const runnerScript = join(workDir, "stub-runner.cjs");
  await writeFile(runnerScript, runnerBody);
  const config: InfinigenProviderConfig = {
    id: "infinigen",
    label: "Infinigen（本地程序化）",
    pythonBin: process.execPath,
    workDir,
    textureResolution: 512,
    runnerScript,
    catalogPath: WORKSPACE_CATALOG,
  };
  return { provider: new InfinigenGenerated3DProvider(config), workDir };
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("waitFor timed out");
}

const SUCCESS_RUNNER = `
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--output") + 1];
fs.writeFileSync(path.join(out, "argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(out, "model.glb"), Buffer.from("fake-glb-bytes"));
fs.writeFileSync(path.join(out, "thumbnail.png"), Buffer.from("fake-png-bytes"));
fs.writeFileSync(
  path.join(out, "status.json"),
  JSON.stringify({ status: "succeeded", progress: 1, model: "model.glb", thumbnail: "thumbnail.png", warnings: [] }),
);
`;

const HANGING_RUNNER = `
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--output") + 1];
fs.writeFileSync(path.join(out, "status.json"), JSON.stringify({ status: "running", progress: 0.3 }));
setTimeout(() => {}, 60_000);
`;

const CRASHING_RUNNER = `process.exit(1);`;

describe("Infinigen generated-3D provider", () => {
  it("maps prompts to catalog factories by id and keyword", async () => {
    const { provider } = await makeProvider(SUCCESS_RUNNER);
    const factories = await provider.factories();
    expect(resolveInfinigenFactory("ChairFactory", factories).id).toBe("ChairFactory");
    expect(resolveInfinigenFactory("一把舒服的椅子", factories).id).toBe("ChairFactory");
    expect(resolveInfinigenFactory("生成一个红酒杯", factories).id).toBe("WineglassFactory");
    expect(resolveInfinigenFactory("potted plant on a desk", factories).id).toBe("PlantContainerFactory");
    expect(() => resolveInfinigenFactory("量子计算机", factories)).toThrow(/没有匹配/);
  });

  it("maps environment prompts to heightfield presets", async () => {
    const { provider } = await makeProvider(SUCCESS_RUNNER);
    const factories = await provider.factories();
    expect(resolveInfinigenFactory("环绕的群山", factories)).toMatchObject({
      id: "SurroundingMountains",
      kind: "environment",
    });
    expect(resolveInfinigenFactory("一片沙漠环境", factories).id).toBe("DesertDunes");
    expect(resolveInfinigenFactory("rolling hills backdrop", factories).id).toBe("RollingHills");
    expect(resolveInfinigenFactory("两山之间的山谷", factories).id).toBe("MountainValley");
  });

  it("launches the runner with kind=environment and no module for presets", async () => {
    const { provider } = await makeProvider(SUCCESS_RUNNER);
    const externalId = await provider.submit(jobInput("环绕的群山"), null, new AbortController().signal);
    const snapshot = await waitFor(async () => {
      const current = await provider.inspect(externalId, jobInput("环绕的群山"), new AbortController().signal);
      return current.status === "succeeded" ? current : null;
    });
    const argv = JSON.parse(
      await readFile(
        new URL("argv.json", `${snapshot.modelUrl!.slice(0, snapshot.modelUrl!.lastIndexOf("/"))}/`),
        "utf8",
      ),
    ) as string[];
    expect(argv).toContain("--kind");
    expect(argv[argv.indexOf("--kind") + 1]).toBe("environment");
    expect(argv[argv.indexOf("--factory") + 1]).toBe("SurroundingMountains");
    expect(argv).not.toContain("--module");
  });

  it("registers as an unconfigured local provider until a python binary is set", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {});
    const registry = new Generated3DProviderRegistry(config.generation.generated3d, fetch);
    const capability = registry.get("infinigen").capability;
    expect(capability).toMatchObject({ id: "infinigen", configured: false, cancellation: "local-only" });
    expect(registry.capabilities().map((entry) => entry.id)).toContain("infinigen");
  });

  it("runs the local runner to completion and reports file artifacts", async () => {
    const { provider } = await makeProvider(SUCCESS_RUNNER);
    const externalId = await provider.submit(jobInput("一把舒服的椅子"), null, new AbortController().signal);
    expect(externalId).toMatch(/^infinigen:task:/);
    const snapshot = await waitFor(async () => {
      const current = await provider.inspect(externalId, jobInput("chair"), new AbortController().signal);
      return current.status === "succeeded" || current.status === "failed" ? current : null;
    });
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.modelUrl).toMatch(/^file:.*model\.glb$/);
    expect(snapshot.thumbnailUrl).toMatch(/^file:.*thumbnail\.png$/);
    expect(await readFile(new URL(snapshot.modelUrl!), "utf8")).toBe("fake-glb-bytes");
  });

  it("cancels a running task by killing the runner and recording the terminal state", async () => {
    const { provider } = await makeProvider(HANGING_RUNNER);
    const externalId = await provider.submit(jobInput("chair"), null, new AbortController().signal);
    await waitFor(async () => {
      const current = await provider.inspect(externalId, jobInput("chair"), new AbortController().signal);
      return current.status === "running" && current.progress === 0.3 ? current : null;
    });
    const killed = await provider.cancel(externalId, jobInput("chair"), new AbortController().signal);
    expect(killed).toBe(true);
    const snapshot = await provider.inspect(externalId, jobInput("chair"), new AbortController().signal);
    expect(snapshot.status).toBe("cancelled");
  });

  it("reports failure when the runner dies without writing a terminal status", async () => {
    const { provider } = await makeProvider(CRASHING_RUNNER);
    const externalId = await provider.submit(jobInput("chair"), null, new AbortController().signal);
    const snapshot = await waitFor(async () => {
      const current = await provider.inspect(externalId, jobInput("chair"), new AbortController().signal);
      return current.status === "failed" ? current : null;
    });
    expect(snapshot.error).toMatch(/已退出但未写入终态/);
  });

  it("refuses to submit without a configured python interpreter", async () => {
    const { provider, workDir } = await makeProvider(SUCCESS_RUNNER);
    void workDir;
    const unconfigured = new InfinigenGenerated3DProvider({
      id: "infinigen",
      label: "Infinigen",
      pythonBin: undefined,
      workDir: "/tmp/unused",
      textureResolution: 512,
      runnerScript: "/tmp/unused.py",
      catalogPath: WORKSPACE_CATALOG,
    });
    expect(unconfigured.capability.configured).toBe(false);
    await expect(unconfigured.submit(jobInput("chair"), null, new AbortController().signal)).rejects.toThrow(
      /DIRECTOR_INFINIGEN_PYTHON/,
    );
  });
});
