import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as Y from "yjs";
import { writeJsonAtomic } from "../atomicJsonFile";

const DEFAULT_COMPACT_AFTER_UPDATES = 64;
const DEFAULT_MAX_QUARANTINED_UPDATES = 128;
const SNAPSHOT_FILE = "snapshot.bin";
const META_FILE = "meta.json";
const UPDATES_DIRECTORY = "updates";
const QUARANTINE_DIRECTORY = "quarantine";
const QUARANTINE_INDEX_FILE = "quarantine-index.json";

/** A corrupt Yjs update captured for offline inspection instead of being applied. */
export type CollaborationQuarantineRecord = {
  id: string;
  room: string;
  sha256: string;
  byteLength: number;
  reason: string;
  quarantinedAt: string;
};

/** Durable per-room operational status reported by {@link CollaborationSnapshotStore.status}. */
export type CollaborationRoomOpsStatus = {
  room: string;
  snapshotBytes: number;
  /** Last write time of the compacted snapshot file, for snapshot-age reporting. */
  snapshotUpdatedAt: string | null;
  pendingUpdates: number;
  quarantinedUpdates: number;
  lastCompactedAt: string | null;
};

/** Result of {@link CollaborationSnapshotStore.appendUpdate}. */
export type CollaborationAppendResult =
  | { accepted: true; compacted: boolean; pendingUpdates: number }
  | { accepted: false; quarantine: CollaborationQuarantineRecord };

/**
 * Validates that a payload is a structurally applicable Yjs update by
 * replaying it into a throwaway document.
 */
export function validateYjsUpdate(update: Uint8Array): { ok: true } | { ok: false; reason: string } {
  if (!(update instanceof Uint8Array) || update.byteLength === 0) {
    return { ok: false, reason: "empty update payload" };
  }
  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, update);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    probe.destroy();
  }
}

function encodeRoomDirectoryName(room: string) {
  return Buffer.from(room, "utf8").toString("base64url");
}

function decodeRoomDirectoryName(name: string): string | null {
  try {
    const room = Buffer.from(name, "base64url").toString("utf8");
    return encodeRoomDirectoryName(room) === name ? room : null;
  } catch {
    return null;
  }
}

async function readBinary(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

async function writeBinaryAtomic(path: string, bytes: Uint8Array) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, path);
}

/**
 * Disk-backed Yjs room operations: append-only update logs, threshold-driven
 * snapshot compaction, and quarantine for corrupt updates.
 *
 * Every incoming update is validated against a throwaway document first;
 * corrupt updates never reach the snapshot chain and are stored under
 * `quarantine/` with a bounded JSON index for later inspection. Valid updates
 * are appended as individual files and merged into a single canonical
 * snapshot (`Y.mergeUpdates`) once the pending log crosses the compaction
 * threshold, keeping room recovery reads O(1) instead of O(update history).
 *
 * All per-room mutations are serialized through a lock queue, mirroring
 * {@link ../multiAgent/multiAgentRunStore.MultiAgentRunStore}.
 */
export class CollaborationSnapshotStore {
  private readonly directory: string;
  private readonly archiveDirectory: string;
  private readonly compactAfterUpdates: number;
  private readonly maxQuarantinedUpdates: number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private updateSequence = 0;

  constructor(dataDirectory: string, options: { compactAfterUpdates?: number; maxQuarantinedUpdates?: number } = {}) {
    this.directory = resolve(dataDirectory, "collaboration-rooms");
    this.archiveDirectory = resolve(dataDirectory, "collaboration-rooms-archive");
    this.compactAfterUpdates = Math.max(1, options.compactAfterUpdates ?? DEFAULT_COMPACT_AFTER_UPDATES);
    this.maxQuarantinedUpdates = Math.max(1, options.maxQuarantinedUpdates ?? DEFAULT_MAX_QUARANTINED_UPDATES);
  }

  /**
   * Loads the merged room state: the compacted snapshot plus any pending
   * updates, as one Yjs update. Returns null when the room has no history.
   */
  async loadSnapshot(room: string): Promise<Uint8Array | null> {
    return this.withRoomLock(room, async () => {
      const chain = await this.readUpdateChain(room);
      if (chain.updates.length === 0) return null;
      return chain.updates.length === 1 ? chain.updates[0]! : Y.mergeUpdates(chain.updates);
    });
  }

  /**
   * Validates and appends one incoming update. Corrupt updates are moved to
   * quarantine and reported instead of being applied; valid updates trigger
   * compaction once the pending log reaches the configured threshold.
   */
  async appendUpdate(room: string, update: Uint8Array): Promise<CollaborationAppendResult> {
    const validation = validateYjsUpdate(update);
    if (!validation.ok) {
      return { accepted: false, quarantine: await this.quarantine(room, update, validation.reason) };
    }
    return this.withRoomLock(room, async () => {
      const updatesDirectory = resolve(this.roomDirectory(room), UPDATES_DIRECTORY);
      await mkdir(updatesDirectory, { recursive: true });
      const name = `${Date.now().toString(16).padStart(12, "0")}-${(++this.updateSequence)
        .toString(16)
        .padStart(8, "0")}.yupdate`;
      await writeBinaryAtomic(resolve(updatesDirectory, name), update);
      const pendingUpdates = (await this.listUpdateFiles(room)).length;
      if (pendingUpdates < this.compactAfterUpdates) {
        return { accepted: true, compacted: false, pendingUpdates };
      }
      await this.compactLocked(room);
      return { accepted: true, compacted: true, pendingUpdates: 0 };
    });
  }

  /**
   * Merges the current snapshot and every pending update into one canonical
   * snapshot file, then removes the consumed update files.
   */
  async compact(room: string) {
    return this.withRoomLock(room, () => this.compactLocked(room));
  }

  /** Records a corrupt update for inspection without ever applying it. */
  async quarantine(room: string, update: Uint8Array, reason: string): Promise<CollaborationQuarantineRecord> {
    return this.withRoomLock(room, async () => {
      const quarantineDirectory = resolve(this.roomDirectory(room), QUARANTINE_DIRECTORY);
      await mkdir(quarantineDirectory, { recursive: true });
      const record: CollaborationQuarantineRecord = {
        id: `quarantine-${randomUUID()}`,
        room,
        sha256: createHash("sha256").update(update).digest("hex"),
        byteLength: update.byteLength,
        reason: reason.slice(0, 400),
        quarantinedAt: new Date().toISOString(),
      };
      await writeBinaryAtomic(resolve(quarantineDirectory, `${record.id}.bin`), update);
      const index = [...(await this.readQuarantineIndex(room)), record];
      const dropped = index.slice(0, Math.max(0, index.length - this.maxQuarantinedUpdates));
      for (const stale of dropped) {
        await rm(resolve(quarantineDirectory, `${stale.id}.bin`), { force: true });
      }
      await writeJsonAtomic(
        resolve(this.roomDirectory(room), QUARANTINE_INDEX_FILE),
        index.slice(-this.maxQuarantinedUpdates),
      );
      return record;
    });
  }

  /** Lists quarantined update records for one room, oldest first. */
  async listQuarantined(room: string): Promise<CollaborationQuarantineRecord[]> {
    return this.withRoomLock(room, () => this.readQuarantineIndex(room));
  }

  /** Reports durable operational counters for one room. */
  async status(room: string): Promise<CollaborationRoomOpsStatus> {
    return this.withRoomLock(room, () => this.statusLocked(room));
  }

  /**
   * Lists every persisted (non-archived) room with its durable operational
   * status. Directory names that do not decode back to a room id are skipped.
   */
  async listRooms(): Promise<CollaborationRoomOpsStatus[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const statuses: CollaborationRoomOpsStatus[] = [];
    for (const name of names.sort()) {
      const room = decodeRoomDirectoryName(name);
      if (room === null) continue;
      statuses.push(await this.withRoomLock(room, () => this.statusLocked(room)));
    }
    return statuses;
  }

  /**
   * Moves a room's durable history (snapshot, pending updates, quarantine)
   * into the archive directory so future joins start from an empty document.
   * Archived data is renamed, never deleted, and stops seeding new rooms.
   */
  async archiveRoom(room: string): Promise<{ archived: boolean; archivedAs: string | null }> {
    return this.withRoomLock(room, async () => {
      const source = this.roomDirectory(room);
      const archivedAs = `${encodeRoomDirectoryName(room)}.${Date.now().toString(16)}-${randomUUID().slice(0, 8)}`;
      try {
        await mkdir(this.archiveDirectory, { recursive: true });
        await rename(source, resolve(this.archiveDirectory, archivedAs));
        return { archived: true, archivedAs };
      } catch {
        return { archived: false, archivedAs: null };
      }
    });
  }

  private roomDirectory(room: string) {
    return resolve(this.directory, encodeRoomDirectoryName(room));
  }

  private async statusLocked(room: string): Promise<CollaborationRoomOpsStatus> {
    const snapshotPath = resolve(this.roomDirectory(room), SNAPSHOT_FILE);
    let snapshotBytes = 0;
    let snapshotUpdatedAt: string | null = null;
    try {
      const snapshotStat = await stat(snapshotPath);
      snapshotBytes = snapshotStat.size;
      snapshotUpdatedAt = snapshotStat.mtime.toISOString();
    } catch {
      // No compacted snapshot yet.
    }
    const meta = await this.readMeta(room);
    return {
      room,
      snapshotBytes,
      snapshotUpdatedAt,
      pendingUpdates: (await this.listUpdateFiles(room)).length,
      quarantinedUpdates: (await this.readQuarantineIndex(room)).length,
      lastCompactedAt: meta.lastCompactedAt,
    };
  }

  private async listUpdateFiles(room: string) {
    try {
      const names = await readdir(resolve(this.roomDirectory(room), UPDATES_DIRECTORY));
      return names.filter((name) => name.endsWith(".yupdate")).sort();
    } catch {
      return [];
    }
  }

  private async readUpdateChain(room: string) {
    const updates: Uint8Array[] = [];
    const snapshot = await readBinary(resolve(this.roomDirectory(room), SNAPSHOT_FILE));
    if (snapshot) updates.push(snapshot);
    const names = await this.listUpdateFiles(room);
    for (const name of names) {
      const update = await readBinary(resolve(this.roomDirectory(room), UPDATES_DIRECTORY, name));
      if (update) updates.push(update);
    }
    return { updates, pendingNames: names };
  }

  private async compactLocked(room: string) {
    const chain = await this.readUpdateChain(room);
    if (chain.updates.length === 0) {
      return { snapshotBytes: 0, mergedUpdates: 0 };
    }
    const merged = chain.updates.length === 1 ? chain.updates[0]! : Y.mergeUpdates(chain.updates);
    const validation = validateYjsUpdate(merged);
    if (!validation.ok) throw new Error(`Compacted room snapshot is not applicable: ${validation.reason}`);
    await mkdir(this.roomDirectory(room), { recursive: true });
    await writeBinaryAtomic(resolve(this.roomDirectory(room), SNAPSHOT_FILE), merged);
    for (const name of chain.pendingNames) {
      await rm(resolve(this.roomDirectory(room), UPDATES_DIRECTORY, name), { force: true });
    }
    await writeJsonAtomic(resolve(this.roomDirectory(room), META_FILE), {
      lastCompactedAt: new Date().toISOString(),
    });
    return { snapshotBytes: merged.byteLength, mergedUpdates: chain.pendingNames.length };
  }

  private async readMeta(room: string): Promise<{ lastCompactedAt: string | null }> {
    try {
      const parsed: unknown = JSON.parse(await readFile(resolve(this.roomDirectory(room), META_FILE), "utf8"));
      const lastCompactedAt =
        parsed &&
        typeof parsed === "object" &&
        "lastCompactedAt" in parsed &&
        typeof (parsed as Record<string, unknown>).lastCompactedAt === "string"
          ? ((parsed as Record<string, unknown>).lastCompactedAt as string)
          : null;
      return { lastCompactedAt };
    } catch {
      return { lastCompactedAt: null };
    }
  }

  private async readQuarantineIndex(room: string): Promise<CollaborationQuarantineRecord[]> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(resolve(this.roomDirectory(room), QUARANTINE_INDEX_FILE), "utf8"),
      );
      return Array.isArray(parsed) ? (parsed as CollaborationQuarantineRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async withRoomLock<T>(room: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(room) ?? Promise.resolve();
    const next = previous.then(task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(room, settled);
    void settled.then(() => {
      if (this.locks.get(room) === settled) this.locks.delete(room);
    });
    return next;
  }
}
