import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  generated3dProviderCapabilitySchema,
  type Generated3DJobInput,
  type Generated3DProviderCapability,
} from "../../../packages/protocol/src/generated3dProtocol";
import type {
  Generated3DProvider,
  Generated3DProviderSnapshot,
  Generated3DProviderSource,
} from "./generated3dProviders";

export type InfinigenProviderConfig = {
  id: "infinigen";
  label: string;
  pythonBin?: string;
  workDir: string;
  textureResolution: number;
  runnerScript: string;
  catalogPath: string;
};

const factoryCatalogSchema = z.object({
  version: z.literal(1),
  factories: z
    .array(
      z
        .object({
          id: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,120}$/),
          kind: z.enum(["asset", "environment"]).default("asset"),
          module: z
            .string()
            .regex(/^infinigen(\.[A-Za-z_][A-Za-z0-9_]*)+$/)
            .optional(),
          label: z.string().min(1).max(120),
          category: z.enum(["nature", "indoor", "environment"]),
          keywords: z.array(z.string().min(1).max(80)).min(1).max(16),
        })
        .refine((entry) => entry.kind === "environment" || Boolean(entry.module), {
          message: "asset factories must declare an infinigen module path",
        }),
    )
    .min(1),
});

export type InfinigenFactoryEntry = z.infer<typeof factoryCatalogSchema>["factories"][number];

/** Written atomically by the Python runner after every stage transition. */
const runnerStatusSchema = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number().min(0).max(1).default(0),
  message: z.string().max(2_000).optional(),
  error: z.string().max(4_000).optional(),
  warnings: z.array(z.string().max(1_000)).max(20).default([]),
  model: z.string().max(255).optional(),
  thumbnail: z.string().max(255).optional(),
});

const launchSchema = z.object({
  pid: z.number().int().positive(),
  factoryId: z.string(),
  seed: z.number().int(),
  startedAt: z.string(),
});

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Task ids are the only user-influenced path segment; keep them strictly opaque. */
function assertTaskId(taskId: string) {
  if (!/^[a-f0-9-]{8,64}$/i.test(taskId)) throw new Error("Invalid Infinigen task id");
  return taskId;
}

export function resolveInfinigenFactory(prompt: string, factories: readonly InfinigenFactoryEntry[]) {
  const trimmed = prompt.trim();
  const exact = factories.find((factory) => factory.id.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;
  const haystack = trimmed.toLowerCase();
  let best: { entry: InfinigenFactoryEntry; length: number } | null = null;
  for (const entry of factories) {
    for (const keyword of entry.keywords) {
      const needle = keyword.toLowerCase();
      if (haystack.includes(needle) && (!best || needle.length > best.length)) {
        best = { entry, length: needle.length };
      }
    }
  }
  if (!best) {
    const known = factories
      .slice(0, 20)
      .map((factory) => `${factory.label}(${factory.id})`)
      .join("、");
    throw new Error(`没有匹配 "${prompt}" 的 Infinigen 工厂；可用示例：${known}…`);
  }
  return best.entry;
}

/**
 * Runs Infinigen asset factories in a local Python subprocess. The runner
 * process owns Blender (bpy) and writes {@link runnerStatusSchema} snapshots
 * plus model.glb / thumbnail.png into a per-task work directory; this class
 * only launches, observes, and kills that process, so the gateway event loop
 * never blocks on generation.
 */
export class InfinigenGenerated3DProvider implements Generated3DProvider {
  readonly id = "infinigen" as const;
  readonly localArtifacts = true;
  readonly capability: Generated3DProviderCapability;
  private catalog: InfinigenFactoryEntry[] | null = null;

  constructor(private readonly config: InfinigenProviderConfig) {
    this.capability = generated3dProviderCapabilitySchema.parse({
      id: this.id,
      label: config.label,
      configured: Boolean(config.pythonBin),
      modes: ["text-to-3d"],
      modelVersion: null,
      cancellation: "local-only",
      documentationUrl: "https://infinigen.org",
    });
  }

  async factories() {
    if (!this.catalog) {
      const parsed = factoryCatalogSchema.parse(JSON.parse(await readFile(this.config.catalogPath, "utf8")));
      this.catalog = parsed.factories;
    }
    return this.catalog;
  }

  private taskDir(taskId: string) {
    return join(this.config.workDir, "tasks", assertTaskId(taskId));
  }

  async submit(
    input: Generated3DJobInput,
    _source?: Generated3DProviderSource | null,
    _signal?: AbortSignal,
  ): Promise<string> {
    if (!this.config.pythonBin) {
      throw new Error("Infinigen 未配置；请设置 DIRECTOR_INFINIGEN_PYTHON 指向安装了 infinigen 的 Python 解释器");
    }
    const factory = resolveInfinigenFactory(input.prompt, await this.factories());
    const taskId = randomUUID();
    const directory = this.taskDir(taskId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify({ status: "queued", progress: 0, message: `等待 ${factory.label} 生成` }),
    );
    const log = openSync(join(directory, "runner.log"), "a");
    const child = spawn(
      this.config.pythonBin,
      [
        resolve(this.config.runnerScript),
        "--factory",
        factory.id,
        "--kind",
        factory.kind,
        ...(factory.module ? ["--module", factory.module] : []),
        "--seed",
        String(input.seed),
        "--name",
        input.name,
        "--texture-res",
        String(this.config.textureResolution),
        "--output",
        directory,
      ],
      { cwd: this.config.workDir, detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
    if (typeof child.pid !== "number") throw new Error("Infinigen runner 进程启动失败");
    await writeFile(
      join(directory, "launch.json"),
      JSON.stringify({ pid: child.pid, factoryId: factory.id, seed: input.seed, startedAt: new Date().toISOString() }),
    );
    return `infinigen:task:${taskId}`;
  }

  private async readStatus(taskId: string) {
    const raw = await readFile(join(this.taskDir(taskId), "status.json"), "utf8");
    return runnerStatusSchema.parse(JSON.parse(raw));
  }

  private async readLaunch(taskId: string) {
    try {
      return launchSchema.parse(JSON.parse(await readFile(join(this.taskDir(taskId), "launch.json"), "utf8")));
    } catch {
      return null;
    }
  }

  async inspect(
    external: string,
    _input?: Generated3DJobInput,
    _signal?: AbortSignal,
  ): Promise<Generated3DProviderSnapshot> {
    const taskId = this.taskIdFrom(external);
    let status: z.infer<typeof runnerStatusSchema>;
    try {
      status = await this.readStatus(taskId);
    } catch (error) {
      throw new Error(`Infinigen 任务状态不可读: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (status.status === "succeeded") {
      if (!status.model || !status.thumbnail) {
        return {
          status: "failed",
          progress: status.progress,
          externalId: external,
          error: "Infinigen runner 声称成功但缺少模型或缩略图文件",
        };
      }
      const directory = this.taskDir(taskId);
      return {
        status: "succeeded",
        progress: 1,
        externalId: external,
        modelUrl: pathToFileURL(join(directory, status.model)).href,
        thumbnailUrl: pathToFileURL(join(directory, status.thumbnail)).href,
      };
    }
    if (status.status === "failed" || status.status === "cancelled") {
      return { status: status.status, progress: status.progress, externalId: external, error: status.error };
    }
    const launch = await this.readLaunch(taskId);
    if (launch && !processAlive(launch.pid)) {
      return {
        status: "failed",
        progress: status.progress,
        externalId: external,
        error: `Infinigen runner (pid ${launch.pid}) 已退出但未写入终态；详见任务目录 runner.log`,
      };
    }
    return { status: status.status, progress: status.progress, externalId: external };
  }

  async cancel(external: string, _input?: Generated3DJobInput, _signal?: AbortSignal): Promise<boolean> {
    const taskId = this.taskIdFrom(external);
    const launch = await this.readLaunch(taskId);
    let killed = false;
    if (launch && processAlive(launch.pid)) {
      try {
        process.kill(launch.pid, "SIGTERM");
        killed = true;
      } catch {
        killed = false;
      }
    }
    try {
      const status = await this.readStatus(taskId);
      if (status.status === "queued" || status.status === "running") {
        await writeFile(
          join(this.taskDir(taskId), "status.json"),
          JSON.stringify({ status: "cancelled", progress: status.progress, message: "已被 Director 取消" }),
        );
      }
    } catch {
      // A missing status file means the runner never started; nothing to record.
    }
    return killed;
  }

  private taskIdFrom(external: string) {
    if (!external.startsWith("infinigen:task:")) throw new Error("3D provider task id does not match infinigen");
    return assertTaskId(external.slice("infinigen:task:".length));
  }
}
