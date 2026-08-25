import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ltx23SpawnProvider, type Ltx23SpawnProviderOptions } from "../../../video/providers/ltx23SpawnProvider";

const nowPrefix = "video-12345678";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = undefined as unknown as number;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("Ltx23SpawnProvider", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createProvider(spawnImpl: Ltx23SpawnProviderOptions["spawnImpl"]) {
    const dataDirectory = mkdtempSync(join(tmpdir(), "director-ltx23-"));
    roots.push(dataDirectory);
    return {
      dataDirectory,
      provider: new Ltx23SpawnProvider({
        sourceRoot: "/opt/ltx-2",
        distilledCheckpointPath: "/models/distilled.safetensors",
        spatialUpsamplerPath: "/models/upsampler.safetensors",
        gemmaRoot: "/models/gemma",
        generateScript: "/repo/tools/scripts/ltx23-generate.py",
        dataDirectory,
        uvBinary: "uv",
        model: "ltx-2.3-22b",
        repository: "https://github.com/Lightricks/LTX-2.git",
        commit: "9".repeat(40),
        pipelineVersion: "1.1.7",
        spawnImpl,
      }),
    };
  }

  it("normalizes LTX constraints and spawns DistilledPipeline with a request file", async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as Ltx23SpawnProviderOptions["spawnImpl"];
    const { provider: ltx, dataDirectory } = createProvider(spawnImpl);

    const jobPromise = ltx.submit({
      idempotencyKey: `${nowPrefix}-abcd`,
      prompt: "A locked medium shot of an actor crossing the room.",
      negativePrompt: "flicker",
      width: 1280,
      height: 720,
      frameRate: 23.976,
      numFrames: 120,
      seed: 42,
      generateAudio: true,
      enhancePrompt: false,
      conditioning: [
        {
          role: "clean-frame",
          uri: "/workspace/data/clean.png",
          mimeType: "image/png",
          frameIndex: 0,
          strength: 1,
          crf: 19,
        },
        {
          role: "depth",
          uri: "/workspace/data/depth.png",
          mimeType: "image/png",
          frameIndex: 0,
          strength: 1,
          crf: 19,
        },
      ],
      metadata: { shot_id: "scene-1" },
    });

    const job = await jobPromise;
    expect(job.provider).toBe("ltx-2.3");
    expect(job.status).toBe("running");
    expect(job.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1280x704"),
        expect.stringContaining("121"),
        expect.stringContaining("23.976"),
        expect.stringContaining("depth"),
        expect.stringContaining("negative prompt"),
      ]),
    );

    expect(spawnImpl).toHaveBeenCalledOnce();
    const args = (spawnImpl as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls[0]?.[1] ?? [];
    expect(args).toEqual(
      expect.arrayContaining([
        "--project",
        "/opt/ltx-2",
        "--package",
        "ltx-pipelines",
        "/repo/tools/scripts/ltx23-generate.py",
      ]),
    );
    const requestPath = args[args.indexOf("--request") + 1] as string;
    const payload = JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      width: 1280,
      height: 704,
      frame_rate: 24,
      num_frames: 121,
      seed: 42,
      generate_audio: true,
    });
    expect(payload.images).toEqual([
      {
        path: "/workspace/data/clean.png",
        frame_idx: 0,
        strength: 1,
        crf: 19,
      },
    ]);

    const outputPath = args[args.indexOf("--output") + 1] as string;
    mkdirSync(join(dataDirectory, "video-jobs", `${nowPrefix}-abcd`), { recursive: true });
    writeFileSync(outputPath, "fake-mp4");
    child.emit("exit", 0, null);
    await vi.waitFor(async () => {
      expect((await ltx.getJob(`${nowPrefix}-abcd`)).status).toBe("completed");
    });
    const completed = await ltx.getJob(`${nowPrefix}-abcd`);
    expect(completed.outputs[0]).toMatchObject({
      kind: "video",
      mimeType: "video/mp4",
      uri: outputPath,
    });
  });

  it("reports cold health and official-source capabilities", async () => {
    const { provider: ltx } = createProvider(
      vi.fn(() => fakeChild()) as unknown as Ltx23SpawnProviderOptions["spawnImpl"],
    );
    await expect(ltx.health()).resolves.toMatchObject({
      provider: "ltx-2.3",
      status: "cold",
      modelLoaded: false,
    });
    await expect(ltx.capabilities()).resolves.toMatchObject({
      id: "ltx-2.3",
      configured: true,
      dimensionMultiple: 64,
      runtimeSource: {
        kind: "official-source",
        pipeline: "ltx_pipelines.distilled.DistilledPipeline",
      },
    });
  });

  it("cancels an in-flight spawn", async () => {
    const child = fakeChild();
    const { provider: ltx } = createProvider(vi.fn(() => child) as unknown as Ltx23SpawnProviderOptions["spawnImpl"]);
    await ltx.submit({
      idempotencyKey: `${nowPrefix}-cancel`,
      prompt: "hold",
      width: 768,
      height: 512,
      frameRate: 24,
      numFrames: 9,
      seed: 1,
      generateAudio: false,
      enhancePrompt: false,
      conditioning: [],
      metadata: {},
    });
    const cancelled = await ltx.cancel(`${nowPrefix}-cancel`);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelRequested).toBe(true);
  });

  it("rejects a reused idempotency key with a different payload", async () => {
    const child = fakeChild();
    const { provider: ltx } = createProvider(vi.fn(() => child) as unknown as Ltx23SpawnProviderOptions["spawnImpl"]);
    const base = {
      idempotencyKey: `${nowPrefix}-dup`,
      prompt: "one",
      width: 768,
      height: 512,
      frameRate: 24,
      numFrames: 9,
      seed: 1,
      generateAudio: false,
      enhancePrompt: false,
      conditioning: [],
      metadata: {},
    };
    await ltx.submit(base);
    await expect(ltx.submit({ ...base, prompt: "two" })).rejects.toThrow(/Idempotency-Key/);
  });
});
