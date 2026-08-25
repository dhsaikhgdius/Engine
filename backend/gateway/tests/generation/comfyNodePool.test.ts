import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfyNodePool } from "../../generation/comfyNodePool";

describe("ComfyNodePool", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createPool() {
    const directory = await mkdtemp(join(tmpdir(), "director-comfy-nodes-"));
    tempDirs.push(directory);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/system_stats")) {
        return new Response(
          JSON.stringify({
            system: { ram_total: 64_000, ram_free: 32_000 },
            devices: [{ name: "Test GPU", vram_total: 24_000, vram_free: 18_000 }],
          }),
        );
      }
      if (url.endsWith("/queue") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ queue_running: [], queue_pending: [[1], [2]] }));
      }
      if (url.endsWith("/object_info")) return new Response(JSON.stringify({ KSampler: {}, VAEDecode: {} }));
      return new Response(JSON.stringify({ ok: true }));
    });
    const pool = new ComfyNodePool(
      directory,
      [{ id: "gpu-a", label: "GPU A", baseUrl: "http://127.0.0.1:8188", enabled: true, maxConcurrent: 1 }],
      fetchImpl as typeof fetch,
    );
    return { directory, fetchImpl, pool };
  }

  it("reports health, queue depth, memory metrics, and supported classes", async () => {
    const { pool } = await createPool();
    const snapshots = await pool.snapshots();
    expect(snapshots).toEqual([
      expect.objectContaining({
        id: "gpu-a",
        status: "online",
        queueRemaining: 2,
        deviceName: "Test GPU",
        vramFreeBytes: 18_000,
      }),
    ]);
    expect(await pool.supportedClassTypes()).toEqual(new Set(["KSampler", "VAEDecode"]));
  });

  it("persists node edits and performs interrupt plus memory release for restart", async () => {
    const { directory, fetchImpl, pool } = await createPool();
    await pool.upsert({
      id: "gpu-b",
      label: "GPU B",
      baseUrl: "http://127.0.0.1:8288/",
      enabled: true,
      maxConcurrent: 2,
    });
    const stored = JSON.parse(await readFile(join(directory, "comfy-nodes.json"), "utf8")) as { nodes: unknown[] };
    expect(stored.nodes).toHaveLength(2);
    expect(await pool.get("gpu-b")).toMatchObject({ baseUrl: "http://127.0.0.1:8288", maxConcurrent: 2 });

    await pool.action("gpu-a", "restart");
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/interrupt"))).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/free"))).toBe(true);
  });

  it("queues local work above per-node concurrency and releases it in order", async () => {
    const { pool } = await createPool();
    const releaseFirst = await pool.acquire("gpu-a");
    let secondAcquired = false;
    const second = pool.acquire("gpu-a").then((release) => {
      secondAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
  });
});
