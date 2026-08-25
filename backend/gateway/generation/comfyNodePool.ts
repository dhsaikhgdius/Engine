import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  comfyNodeDefinitionSchema,
  comfyNodeSnapshotSchema,
  type ComfyNodeDefinition,
  type ComfyNodeSnapshot,
} from "../../../packages/protocol/src/comfyGenerationProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";

type FetchLike = typeof fetch;

const storedNodesSchema = z.strictObject({
  version: z.literal(1),
  nodes: z.array(comfyNodeDefinitionSchema).max(64),
});

function normalizedNode(raw: unknown) {
  const node = comfyNodeDefinitionSchema.parse(raw);
  return comfyNodeDefinitionSchema.parse({ ...node, baseUrl: node.baseUrl.replace(/\/+$/, "") });
}

function finiteMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function queueLength(value: unknown, key: string) {
  if (!value || typeof value !== "object") return 0;
  const queue = (value as Record<string, unknown>)[key];
  return Array.isArray(queue) ? queue.length : 0;
}

/**
 * Manages a pool of ComfyUI inference nodes: registration, persistence,
 * concurrency-limited slot acquisition, health snapshots, and prompt
 * lifecycle operations (interrupt, free memory, cancel).
 */
export class ComfyNodePool {
  private nodes = new Map<string, ComfyNodeDefinition>();
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly dataDirectory: string,
    private readonly configuredNodes: readonly ComfyNodeDefinition[] = [],
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private storagePath() {
    return join(this.dataDirectory, "comfy-nodes.json");
  }

  private async initialize() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      const merged = new Map(this.configuredNodes.map((entry) => [entry.id, normalizedNode(entry)]));
      try {
        const stored = storedNodesSchema.parse(JSON.parse(await readFile(this.storagePath(), "utf8")));
        stored.nodes.forEach((entry) => merged.set(entry.id, normalizedNode(entry)));
      } catch {
        // First run and a corrupt optional registry both fall back to configured nodes.
      }
      this.nodes = merged;
    })();
    return this.initializePromise;
  }

  private async persist() {
    await writeJsonAtomic(this.storagePath(), {
      version: 1,
      nodes: [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }

  /** Returns all registered node definitions. */
  async definitions() {
    await this.initialize();
    return [...this.nodes.values()].map((node) => comfyNodeDefinitionSchema.parse(node));
  }

  /** Returns a single node definition by id, or null when not found. */
  async get(id: string) {
    await this.initialize();
    const node = this.nodes.get(id);
    return node ? comfyNodeDefinitionSchema.parse(node) : null;
  }

  /**
   * Inserts or updates a node definition and persists the registry.
   *
   * @param raw - The raw node definition to upsert.
   * @returns The normalized node definition.
   */
  async upsert(raw: unknown) {
    await this.initialize();
    const node = normalizedNode(raw);
    this.nodes.set(node.id, node);
    await this.persist();
    return comfyNodeDefinitionSchema.parse(node);
  }

  /**
   * Removes a node from the pool. Refuses when the node has active jobs.
   *
   * @param id - The node id to remove.
   * @returns True when the node was removed, false when it did not exist.
   * @throws When the node has active jobs.
   */
  async remove(id: string) {
    await this.initialize();
    if ((this.active.get(id) ?? 0) > 0) throw new Error("Cannot remove a ComfyUI node while it has active jobs");
    const removed = this.nodes.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  /**
   * Makes an HTTP request to a ComfyUI node. Verifies the node exists and is enabled.
   *
   * @param nodeId - The target node id.
   * @param path - The API path (e.g. "/prompt").
   * @param init - Fetch init options.
   * @returns The fetch Response.
   * @throws When the node is unknown or disabled.
   */
  async request(nodeId: string, path: string, init: RequestInit = {}) {
    const node = await this.get(nodeId);
    if (!node) throw new Error(`Unknown ComfyUI node ${nodeId}`);
    if (!node.enabled) throw new Error(`ComfyUI node ${node.label} is disabled`);
    return this.fetchImpl(`${node.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, init);
  }

  /**
   * Makes a JSON request to a ComfyUI node and parses the response body.
   *
   * @param nodeId - The target node id.
   * @param path - The API path.
   * @param init - Fetch init options.
   * @returns The parsed JSON response body.
   * @throws When the HTTP response is not ok.
   */
  async json(nodeId: string, path: string, init: RequestInit = {}) {
    const response = await this.request(nodeId, path, init);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`ComfyUI node ${nodeId} returned HTTP ${response.status}`);
    return body;
  }

  /**
   * Takes a live health snapshot of a single node, including GPU stats and queue depth.
   *
   * @param node - The node definition to snapshot.
   * @returns A snapshot with status, resource metrics, and queue information.
   */
  async snapshot(node: ComfyNodeDefinition): Promise<ComfyNodeSnapshot> {
    const activeJobs = this.active.get(node.id) ?? 0;
    const queuedJobs = this.waiters.get(node.id)?.length ?? 0;
    const checkedAt = new Date().toISOString();
    if (!node.enabled) {
      return comfyNodeSnapshotSchema.parse({
        ...node,
        status: "disabled",
        activeJobs,
        queuedJobs,
        queueRemaining: null,
        ramTotalBytes: null,
        ramFreeBytes: null,
        vramTotalBytes: null,
        vramFreeBytes: null,
        deviceName: null,
        detail: null,
        checkedAt,
      });
    }
    try {
      const [statsResponse, queueResponse] = await Promise.all([
        this.request(node.id, "/system_stats", { signal: AbortSignal.timeout(4_000) }),
        this.request(node.id, "/queue", { signal: AbortSignal.timeout(4_000) }),
      ]);
      if (!statsResponse.ok || !queueResponse.ok)
        throw new Error(`HTTP ${statsResponse.status}/${queueResponse.status}`);
      const stats = (await statsResponse.json()) as {
        system?: { ram_total?: unknown; ram_free?: unknown };
        devices?: Array<{
          name?: unknown;
          vram_total?: unknown;
          vram_free?: unknown;
        }>;
      };
      const queue = await queueResponse.json();
      const remoteRunning = queueLength(queue, "queue_running");
      const remotePending = queueLength(queue, "queue_pending");
      const device = stats.devices?.[0];
      return comfyNodeSnapshotSchema.parse({
        ...node,
        status: activeJobs || remoteRunning ? "busy" : "online",
        activeJobs,
        queuedJobs,
        queueRemaining: remoteRunning + remotePending,
        ramTotalBytes: finiteMetric(stats.system?.ram_total),
        ramFreeBytes: finiteMetric(stats.system?.ram_free),
        vramTotalBytes: finiteMetric(device?.vram_total),
        vramFreeBytes: finiteMetric(device?.vram_free),
        deviceName: typeof device?.name === "string" ? device.name : null,
        detail: null,
        checkedAt,
      });
    } catch (error) {
      return comfyNodeSnapshotSchema.parse({
        ...node,
        status: "offline",
        activeJobs,
        queuedJobs,
        queueRemaining: null,
        ramTotalBytes: null,
        ramFreeBytes: null,
        vramTotalBytes: null,
        vramFreeBytes: null,
        deviceName: null,
        detail: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        checkedAt,
      });
    }
  }

  /**
   * Takes health snapshots of multiple nodes, or all nodes when no ids are given.
   *
   * @param ids - Optional list of node ids to snapshot.
   * @returns An array of snapshots.
   */
  async snapshots(ids?: readonly string[]) {
    const definitions = await this.definitions();
    const selected = ids?.length ? definitions.filter((node) => ids.includes(node.id)) : definitions;
    return Promise.all(selected.map((node) => this.snapshot(node)));
  }

  /**
   * Returns snapshots of enabled and online nodes only.
   *
   * @param ids - Optional list of node ids to filter.
   * @returns Snapshots of available nodes.
   */
  async available(ids?: readonly string[]) {
    const snapshots = await this.snapshots(ids);
    return snapshots.filter((node) => node.enabled && node.status !== "offline");
  }

  /**
   * Collects the union of class types supported by enabled nodes.
   *
   * @param ids - Optional list of node ids to query.
   * @returns A set of supported ComfyUI class type names.
   */
  async supportedClassTypes(ids?: readonly string[]) {
    const nodes = (await this.definitions()).filter((node) => node.enabled && (!ids?.length || ids.includes(node.id)));
    const classTypes = new Set<string>();
    await Promise.all(
      nodes.map(async (node) => {
        try {
          const info = await this.json(node.id, "/object_info", { signal: AbortSignal.timeout(8_000) });
          if (info && typeof info === "object")
            Object.keys(info as Record<string, unknown>).forEach((key) => classTypes.add(key));
        } catch {
          // Unsupported-node reporting remains best-effort when a backend is offline.
        }
      }),
    );
    return classTypes;
  }

  /**
   * Acquires a concurrency slot on a node. Blocks when the node is at capacity.
   * Returns a release function that must be called exactly once.
   *
   * @param nodeId - The node to acquire a slot on.
   * @param signal - Optional abort signal to cancel the wait.
   * @returns A release function.
   * @throws When the node is unknown or disabled.
   */
  async acquire(nodeId: string, signal?: AbortSignal) {
    const node = await this.get(nodeId);
    if (!node) throw new Error(`Unknown ComfyUI node ${nodeId}`);
    if (!node.enabled) throw new Error(`ComfyUI node ${node.label} is disabled`);
    while ((this.active.get(nodeId) ?? 0) >= node.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiters.get(nodeId) ?? [];
        const resume = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const current = this.waiters.get(nodeId);
          if (current)
            this.waiters.set(
              nodeId,
              current.filter((candidate) => candidate !== resume),
            );
          reject(signal?.reason ?? new Error("ComfyUI node slot wait was cancelled"));
        };
        queue.push(resume);
        this.waiters.set(nodeId, queue);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    this.active.set(nodeId, (this.active.get(nodeId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(nodeId, Math.max(0, (this.active.get(nodeId) ?? 1) - 1));
      this.waiters.get(nodeId)?.shift()?.();
    };
  }

  /**
   * Sends an action (interrupt, free, restart) to a ComfyUI node.
   * "restart" performs both interrupt and free.
   *
   * @param nodeId - The target node.
   * @param action - The action to perform.
   * @returns A snapshot of the node after the action.
   */
  async action(nodeId: string, action: "interrupt" | "free" | "restart") {
    if (action === "interrupt" || action === "restart") {
      const response = await this.request(nodeId, "/interrupt", { method: "POST" });
      if (!response.ok) throw new Error(`ComfyUI interrupt returned HTTP ${response.status}`);
    }
    if (action === "free" || action === "restart") {
      const response = await this.request(nodeId, "/free", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
      if (!response.ok) throw new Error(`ComfyUI memory release returned HTTP ${response.status}`);
    }
    return this.snapshot((await this.get(nodeId))!);
  }

  /**
   * Cancels a specific prompt on a ComfyUI node. Optionally interrupts the
   * currently executing prompt as well.
   *
   * @param nodeId - The target node.
   * @param promptId - The prompt id to cancel.
   * @param interrupt - Whether to also send an interrupt signal.
   */
  async cancelPrompt(nodeId: string, promptId: string, interrupt = false) {
    const queueResponse = await this.request(nodeId, "/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
    });
    if (!queueResponse.ok) throw new Error(`ComfyUI queue cancellation returned HTTP ${queueResponse.status}`);
    if (interrupt) await this.action(nodeId, "interrupt");
  }
}
