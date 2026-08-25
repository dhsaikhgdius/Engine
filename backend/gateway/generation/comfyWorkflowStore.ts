import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  comfyWorkflowImportRequestSchema,
  comfyWorkflowRecordSchema,
  type ComfyMediaKind,
  type ComfyWorkflowRecord,
} from "../../../packages/protocol/src/comfyGenerationProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";
import { inspectComfyWorkflow } from "./comfyWorkflow";

/** A ComfyUI workflow that is configured from the control plane rather than imported. */
export type ConfiguredComfyWorkflow = {
  /** Stable identifier for the workflow. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Absolute path to the workflow JSON file on disk. */
  path: string;
  /** The media kind this workflow produces. */
  mediaKind: ComfyMediaKind;
};

function slug(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "workflow"
  );
}

/**
 * Persists and manages ComfyUI workflow records.
 *
 * Workflows can be imported by users or configured via the control plane.
 * The store lazily initialises from disk, merging configured workflows
 * with any previously imported records.
 */
export class ComfyWorkflowStore {
  private records = new Map<string, ComfyWorkflowRecord>();
  private initializePromise: Promise<void> | null = null;

  /**
   * Creates a new ComfyUI workflow store.
   *
   * @param dataDirectory - The data directory for workflow persistence.
   * @param configured - Workflows configured from the control plane.
   */
  constructor(
    private readonly dataDirectory: string,
    private readonly configured: readonly ConfiguredComfyWorkflow[] = [],
  ) {}

  private root() {
    return join(this.dataDirectory, "comfy-workflows");
  }

  private recordPath(id: string) {
    if (!/^comfy-workflow-[a-z0-9-]{3,100}$/i.test(id)) throw new Error("Invalid ComfyUI workflow id");
    return join(this.root(), `${id}.json`);
  }

  private async initialize() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      await mkdir(this.root(), { recursive: true });
      const files = await readdir(this.root()).catch(() => [] as string[]);
      for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
        try {
          const record = comfyWorkflowRecordSchema.parse(JSON.parse(await readFile(join(this.root(), file), "utf8")));
          this.records.set(record.id, record);
        } catch {
          // One corrupt import must not hide other valid workflows.
        }
      }
      for (const configured of this.configured) {
        try {
          const workflow = JSON.parse(await readFile(configured.path, "utf8")) as unknown;
          const inspection = inspectComfyWorkflow(workflow, configured.mediaKind);
          const now = new Date().toISOString();
          const record = comfyWorkflowRecordSchema.parse({
            version: 1,
            id: configured.id,
            name: configured.name,
            description: "Configured from the Director control plane",
            category: "Configured",
            mediaKind: configured.mediaKind,
            workflow,
            parameters: inspection.parameters,
            workflowSha256: inspection.workflowSha256,
            source: "configured",
            createdAt: now,
            updatedAt: now,
          });
          this.records.set(record.id, record);
        } catch {
          // Discovery remains available even if a configured workflow is malformed or temporarily missing.
        }
      }
    })();
    return this.initializePromise;
  }

  /**
   * Lists all workflows sorted by name.
   *
   * @returns An array of validated workflow records.
   */
  async list() {
    await this.initialize();
    return [...this.records.values()]
      .map((record) => comfyWorkflowRecordSchema.parse(record))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Retrieves a single workflow by its identifier.
   *
   * @param id - The workflow identifier.
   * @returns The workflow record, or null if not found.
   */
  async get(id: string) {
    await this.initialize();
    const record = this.records.get(id);
    return record ? comfyWorkflowRecordSchema.parse(record) : null;
  }

  /**
   * Inspects a raw ComfyUI workflow without persisting it.
   *
   * @param rawWorkflow - The raw workflow object to inspect.
   * @param mediaKind - The expected media kind.
   * @param supportedClassTypes - Optional set of supported node class types.
   * @returns An inspection result with parameters and unsupported class types.
   */
  inspect(rawWorkflow: unknown, mediaKind: ComfyMediaKind, supportedClassTypes?: ReadonlySet<string>) {
    return inspectComfyWorkflow(rawWorkflow, mediaKind, supportedClassTypes);
  }

  /**
   * Imports a new user-created workflow and persists it to disk.
   *
   * @param raw - The raw import request, including the workflow and metadata.
   * @param supportedClassTypes - Optional set of supported node class types.
   * @returns The validated and persisted workflow record.
   * @throws When unsupported node class types are detected.
   */
  async import(raw: unknown, supportedClassTypes?: ReadonlySet<string>) {
    await this.initialize();
    const request = comfyWorkflowImportRequestSchema.parse(raw);
    const inspection = inspectComfyWorkflow(request.workflow, request.mediaKind, supportedClassTypes);
    if (inspection.unsupportedClassTypes.length) {
      throw new Error(`Unsupported ComfyUI node classes: ${inspection.unsupportedClassTypes.join(", ")}`);
    }
    const now = new Date().toISOString();
    const id = `comfy-workflow-${slug(request.name)}-${randomUUID().slice(0, 8)}`;
    const record = comfyWorkflowRecordSchema.parse({
      version: 1,
      id,
      name: request.name,
      description: request.description,
      category: request.category,
      mediaKind: request.mediaKind,
      workflow: request.workflow,
      parameters: inspection.parameters,
      workflowSha256: inspection.workflowSha256,
      source: "imported",
      createdAt: now,
      updatedAt: now,
    });
    await writeJsonAtomic(this.recordPath(id), record);
    this.records.set(id, record);
    return comfyWorkflowRecordSchema.parse(record);
  }

  /**
   * Removes an imported workflow from disk.
   *
   * Configured workflows cannot be removed through this method.
   *
   * @param id - The workflow identifier.
   * @returns True if the workflow was removed, false if it did not exist.
   * @throws When attempting to remove a configured workflow.
   */
  async remove(id: string) {
    await this.initialize();
    const record = this.records.get(id);
    if (!record) return false;
    if (record.source === "configured")
      throw new Error("Configured workflows must be removed from server configuration");
    await unlink(this.recordPath(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.records.delete(id);
    return true;
  }
}
