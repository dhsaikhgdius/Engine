import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createDefaultScene, parseStageScene, type StageScene } from "@director/stage-protocol";

/** How many quarantined snapshots are kept beside the scene file. */
export const STAGE_SCENE_QUARANTINE_LIMIT = 3;

/** Why and where a damaged Stage scene snapshot was preserved. */
export interface StageSceneQuarantineRecord {
  /** Human-readable load failure (read, JSON parse, or schema error). */
  reason: string;
  /** Where the damaged snapshot was moved, or null when it could not be preserved. */
  quarantinePath: string | null;
  /** ISO timestamp of the recovery. */
  quarantinedAt: string;
}

/** Result of loading the durable Stage scene snapshot. */
export interface StageSceneLoadResult {
  scene: StageScene;
  /** Non-null when a damaged snapshot was quarantined and the default scene loaded. */
  recovery: StageSceneQuarantineRecord | null;
}

function isFileMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function pruneStageSceneQuarantine(scenePath: string): Promise<void> {
  const directory = dirname(scenePath);
  const prefix = `${basename(scenePath)}.corrupt-`;
  const backups = (await readdir(directory)).filter((name) => name.startsWith(prefix)).sort();
  await Promise.all(
    backups
      .slice(0, Math.max(0, backups.length - STAGE_SCENE_QUARANTINE_LIMIT))
      .map((name) => unlink(join(directory, name)).catch(() => undefined)),
  );
}

async function quarantineStageSceneFile(scenePath: string): Promise<string | null> {
  // The random suffix keeps same-millisecond quarantines from overwriting
  // each other; retention below keeps the newest few.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${scenePath}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(scenePath, quarantinePath);
    await pruneStageSceneQuarantine(scenePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

function logStageSceneRecovery(scenePath: string, recovery: StageSceneQuarantineRecord) {
  const preserved = recovery.quarantinePath
    ? `原始快照已隔离到 ${recovery.quarantinePath}`
    : "原始快照未能隔离，请勿手动覆盖该文件";
  console.error(`Stage 场景快照无法加载（${scenePath}）：${recovery.reason}。${preserved}；已改为加载默认场景。`);
}

/**
 * Loads the durable Stage scene snapshot without silently destroying it.
 *
 * A missing file is a normal first boot and yields the default scene. A
 * snapshot that cannot be read, parsed, or schema-validated is quarantined to
 * a bounded `<scenePath>.corrupt-<timestamp>` sibling before the default
 * scene (which later persists back to the primary path) can replace it, the
 * failure is logged, and a recovery record is returned so callers can surface
 * it (e.g. on the gateway health endpoint).
 */
export async function loadStageSceneWithRecovery(scenePath: string): Promise<StageSceneLoadResult> {
  let contents: string | null = null;
  let reason: string | null = null;
  try {
    contents = await readFile(scenePath, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) return { scene: createDefaultScene(), recovery: null };
    reason = `无法读取场景文件：${error instanceof Error ? error.message : String(error)}`;
  }

  if (contents !== null) {
    try {
      const parsed = parseStageScene(JSON.parse(contents));
      if (parsed.success) return { scene: parsed.scene, recovery: null };
      reason = parsed.error;
    } catch (error) {
      reason = `场景 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const recovery: StageSceneQuarantineRecord = {
    reason: reason ?? "未知错误",
    quarantinePath: await quarantineStageSceneFile(scenePath),
    quarantinedAt: new Date().toISOString(),
  };
  logStageSceneRecovery(scenePath, recovery);
  return { scene: createDefaultScene(), recovery };
}
