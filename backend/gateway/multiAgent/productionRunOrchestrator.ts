import {
  FILM_ROLE_ARTIFACT_KIND,
  FILM_ROLE_CONTEXT,
  FULL_FILM_ROLE_SEQUENCE,
  filmProductionBriefSchema,
  parseFilmRoleDeliverable,
  type FilmRoleId,
} from "../../../packages/protocol/src/filmProductionProtocol";
import {
  productionRunSchema,
  type CreateProductionRunRequest,
  type ProductionArtifact,
  type ProductionRoleProfileMap,
  type ProductionRun,
  type ProductionRunNode,
} from "@director/agent-engine";
import type { AgentEvent, AgentProvider } from "@director/agent-engine";
import type { DirectorAgentTargetWire } from "../../../packages/protocol/src/agentGatewayProtocol";
import type { DirectorProject } from "@director/project-schema";
import { MultiAgentRunStore } from "./multiAgentRunStore";

/** Session handle returned by {@link ProductionAgentRunner.createSession}. */
export type ProductionAgentSession = { id: string };

/**
 * Narrow runner used by the production graph.
 *
 * The in-tree AgentHarness was removed in the DeepSeek Harness cutover.
 * Tests inject a fake; the gateway uses {@link HostedProductionAgentRunner}.
 */
export type ProductionAgentRunner = {
  createSession(input: {
    provider: AgentProvider;
    profileId: string;
    roleId: FilmRoleId;
    title: string;
  }): ProductionAgentSession;
  sendMessage(
    sessionId: string,
    prompt: string,
    project: DirectorProject | undefined,
    target: DirectorAgentTargetWire,
  ): Promise<unknown>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  interrupt(sessionId: string): Promise<unknown>;
  store: { listEvents(sessionId: string): readonly AgentEvent[] };
};

export const DEFAULT_FILM_GRAPH: FilmRoleId[] = [...FULL_FILM_ROLE_SEQUENCE];

const ROLE_INSTRUCTIONS: Record<FilmRoleId, string> = {
  showrunner:
    "Define the film's dramatic promise, theme, audience, tone, emotional arc, duration budget and non-negotiable creative rules. Resolve ambiguity into a production-ready creative brief. Observe only.",
  screenwriter:
    "Write an executable screenplay with stable scene and beat IDs, causal action, performance intention, dialogue, duration estimates and explicit scene transitions. Preserve the approved creative brief. Observe only.",
  "production-designer":
    "Create the production bible and use blender_native when approved locations, hero props or set geometry must be authored. Preserve stable IDs and return the native mutation receipt together with character, palette, material and lighting anchors.",
  "continuity-supervisor":
    "Build a dependency-aware continuity ledger. Track character state, wardrobe, props, geography, time, lighting, screen direction and the required first/last-frame handoff for every scene and shot. Return concrete corrections only. Observe only.",
  "shot-planner":
    "Translate the accepted screenplay and production bible into a timed shot list with stable shot IDs, framing, action, camera movement, lens intent, transition, source references and first/last-frame dependencies. Observe only.",
  "stage-director":
    "Use Director structured tools to author the approved characters, environments, blocking, performance beats and scene timing. Work from stable scene/shot IDs and return real mutation receipts.",
  cinematographer:
    "Use Director structured tools to create coverage, physical lenses, camera movement, motivated lighting and exposure for the approved shot list. Return the actual camera and coverage receipts.",
  "repair-operator":
    "Apply only the concrete narrative, continuity or visual fixes identified by the visual supervisor. Preserve approved intent and report the actual changed shots or media.",
  "generation-operator":
    "Turn the approved shots into executable image, video and audio jobs. Reuse identity and environment references, pass first/last frames between dependent shots, parallelize independent shots, and submit through Stage or the Canvas production DAG. Never invent a successful render receipt.",
  "visual-critic":
    "Use capture/inspect and other read-only evidence against the screenplay, production bible, continuity ledger and shot plan. Report only concrete identity, geography, motion, composition, lighting or temporal defects with affected shot IDs; do not mutate.",
  "sound-designer":
    "Design dialogue, ambience, Foley, effects and music cues against the locked scene and shot timeline. Specify cue IDs, timing, perspective, transitions and mix priorities. Observe only unless an approved audio generation tool is available.",
  editor:
    "Assemble verified picture and sound into an editorial decision list with shot IDs, source media, in/out points, transitions, pacing and delivery settings. Use the Video Editor tools when verified media exists; never fabricate media.",
};

const ROLE_OUTPUT_CONTRACT = [
  "Finish with exactly one JSON object and no markdown fence:",
  '{"title":"short artifact title","summary":"decisions and remaining constraints","deliverable":{}}',
  "The deliverable must contain the role's actual production document, keyed by stable scene, beat, shot, character, location or cue IDs where relevant.",
].join("\n");

type DurableToolReceipt = {
  title: string;
  status: string;
  result: unknown;
};

type ProductionNodeOutput = {
  text: string;
  receipts: DurableToolReceipt[];
};

function boundedReceiptResult(value: unknown) {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= 24_000 ? JSON.parse(encoded) : { truncated: true, byteLength: encoded.length };
  } catch {
    return { unreadable: true };
  }
}

function containsField(value: unknown, field: string, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsField(entry, field, depth + 1));
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, field)) return true;
  return Object.values(record).some((entry) => containsField(entry, field, depth + 1));
}

function relevantArtifactsForRole(artifacts: ProductionArtifact[], roleId: FilmRoleId) {
  const upstreamRoles = new Set(FILM_ROLE_CONTEXT[roleId]);
  if (!upstreamRoles.size) return [];
  return artifacts.filter((artifact) => upstreamRoles.has(artifact.roleId));
}

/** Collects the output artifacts of the given upstream nodes, in artifact order. */
function dependencyArtifacts(run: ProductionRun, dependencyIds: readonly string[]): ProductionArtifact[] {
  const dependencySet = new Set(dependencyIds);
  const outputIds = new Set(
    run.nodes.filter((node) => dependencySet.has(node.id)).flatMap((node) => node.outputArtifactIds),
  );
  return run.artifacts.filter((artifact) => outputIds.has(artifact.id));
}

/**
 * Resolves the effective dependency edges of a run. Graph runs persist
 * explicit `dependsOn` edges; serial-list runs (including every legacy
 * snapshot) fall back to the implicit linear chain in array order.
 */
export function executionDependencies(nodes: readonly ProductionRunNode[]): Map<string, readonly string[]> {
  const explicit = nodes.some((node) => node.dependsOn !== undefined);
  if (explicit) return new Map(nodes.map((node) => [node.id, node.dependsOn ?? []]));
  return new Map(nodes.map((node, index) => [node.id, index === 0 ? [] : [nodes[index - 1]!.id]]));
}

/**
 * Computes the node ids to reset for a checkpoint resume: the checkpoint node
 * itself plus every transitive dependent, so downstream work never consumes a
 * stale mix of old and re-produced artifacts.
 */
export function checkpointResetIds(nodes: readonly ProductionRunNode[], fromNodeId: string): Set<string> {
  const dependencies = executionDependencies(nodes);
  const reset = new Set([fromNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (reset.has(node.id)) continue;
      if ((dependencies.get(node.id) ?? []).some((dependency) => reset.has(dependency))) {
        reset.add(node.id);
        changed = true;
      }
    }
  }
  return reset;
}

export class ProductionRunOrchestrator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();

  constructor(
    private readonly harness: ProductionAgentRunner,
    private readonly store: MultiAgentRunStore,
    private readonly configuredProfileByRole: ProductionRoleProfileMap = {},
  ) {}

  /**
   * Request overrides win over server defaults; the run fallback is used last.
   * The result is materialized into each node at create time so resume is deterministic.
   */
  resolveRoleProfiles(input: CreateProductionRunRequest): ProductionRoleProfileMap {
    const roles = input.graph ? input.graph.nodes.map((node) => node.roleId) : (input.roles ?? DEFAULT_FILM_GRAPH);
    return Object.fromEntries(
      [...new Set(roles)].map((roleId) => [
        roleId,
        input.profileByRole?.[roleId] ?? this.configuredProfileByRole[roleId] ?? input.profileId,
      ]),
    ) as ProductionRoleProfileMap;
  }

  async create(input: CreateProductionRunRequest, project?: DirectorProject) {
    const now = new Date().toISOString();
    const profileByRole = this.resolveRoleProfiles(input);
    const blankNode = {
      sessionId: null,
      status: "pending",
      attempt: 0,
      startedAt: null,
      completedAt: null,
      inputArtifactIds: [],
      outputArtifactIds: [],
      error: null,
    };
    // Graph runs persist their explicit edges; serial-list runs keep the
    // legacy implicit chain (array order) so existing snapshots, artifact
    // inheritance, and resume semantics are byte-compatible.
    const nodes = input.graph
      ? input.graph.nodes.map((node) => ({
          ...blankNode,
          id: node.id,
          roleId: node.roleId,
          profileId: node.profileId ?? profileByRole[node.roleId] ?? input.profileId,
          dependsOn: [...node.dependsOn],
        }))
      : (input.roles ?? DEFAULT_FILM_GRAPH).map((roleId, index) => ({
          ...blankNode,
          id: `node-${String(index + 1).padStart(2, "0")}-${roleId}`,
          roleId,
          profileId: profileByRole[roleId] ?? input.profileId,
        }));
    const run = productionRunSchema.parse({
      version: 2,
      id: `run-${crypto.randomUUID()}`,
      objective: input.objective,
      provider: input.provider,
      profileId: input.profileId,
      profileByRole,
      brief: filmProductionBriefSchema.parse(input.brief ?? {}),
      status: "queued",
      target: input.target,
      createdAt: now,
      updatedAt: now,
      activeNodeId: null,
      nodes,
      artifacts: [],
    });
    await this.store.create(run);
    this.start(run.id, project);
    return run;
  }

  async resume(id: string, project?: DirectorProject, options: { fromNodeId?: string } = {}) {
    let run = await this.store.get(id);
    if (!run) throw new Error("Production run 不存在");
    if (options.fromNodeId && !run.nodes.some((node) => node.id === options.fromNodeId)) {
      throw new Error(`Production run checkpoint node ${options.fromNodeId} 不存在`);
    }
    const activeExecution = this.executions.get(id);
    if (activeExecution) {
      if (["queued", "running", "waiting_approval"].includes(run.status)) return run;
      await activeExecution.catch(() => undefined);
      run = await this.store.get(id);
      if (!run) throw new Error("Production run 不存在");
    }
    const queued = await this.store.update(id, (current) => {
      const resetIds = options.fromNodeId ? checkpointResetIds(current.nodes, options.fromNodeId) : null;
      const droppedArtifactIds = new Set(
        resetIds
          ? current.nodes
              .filter((node) => resetIds.has(node.id))
              .flatMap((node) => node.outputArtifactIds)
          : [],
      );
      return {
        ...current,
        status: "queued",
        activeNodeId: null,
        artifacts: current.artifacts.filter((artifact) => !droppedArtifactIds.has(artifact.id)),
        nodes: current.nodes.map((node) => {
          const checkpointReset = resetIds?.has(node.id) ?? false;
          if (node.status === "succeeded" && !checkpointReset) return node;
          return {
            ...node,
            status: "pending",
            error: null,
            startedAt: null,
            completedAt: null,
            // Checkpoint resets re-inherit inputs so re-produced upstream
            // artifacts are consumed instead of a stale mix.
            ...(checkpointReset ? { inputArtifactIds: [], outputArtifactIds: [] } : {}),
          };
        }),
      };
    });
    // A concurrent resume may have started the execution while this update was
    // waiting on the durable store lock. Only the first caller owns the start.
    if (!this.controllers.has(id)) this.start(id, project);
    return (await this.store.get(id)) ?? queued;
  }

  async cancel(id: string) {
    const execution = this.executions.get(id);
    this.controllers.get(id)?.abort(new DOMException("Production run cancelled", "AbortError"));
    const cancelled = await this.store.update(id, (run) => ({
      ...run,
      status: "cancelled",
      activeNodeId: null,
      nodes: run.nodes.map((node) =>
        node.status === "running" || node.status === "pending" ? { ...node, status: "cancelled" } : node,
      ),
    }));
    if (execution) await execution.catch(() => undefined);
    return (await this.store.get(id)) ?? cancelled;
  }

  private start(id: string, project?: DirectorProject) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const execution = new Promise<void>((resolveExecution, rejectExecution) => {
      setTimeout(() => {
        void this.execute(id, project, controller.signal).then(resolveExecution, rejectExecution);
      }, 0);
    });
    this.executions.set(id, execution);
    const release = () => {
      if (this.executions.get(id) === execution) this.executions.delete(id);
    };
    void execution.then(release, release);
  }

  private async execute(id: string, project: DirectorProject | undefined, signal: AbortSignal) {
    try {
      await this.store.update(id, (run) => ({ ...run, status: "running" }));
      // Wave scheduler: every node whose dependencies have all succeeded runs
      // concurrently. Serial-list runs degrade to one node per wave through
      // their implicit linear chain, preserving the legacy execution order.
      for (;;) {
        if (signal.aborted) throw signal.reason;
        const run = (await this.store.get(id))!;
        const remaining = run.nodes.filter((node) => node.status !== "succeeded");
        if (remaining.length === 0) break;
        const dependencies = executionDependencies(run.nodes);
        const succeeded = new Set(
          run.nodes.filter((node) => node.status === "succeeded").map((node) => node.id),
        );
        const ready = remaining.filter((node) =>
          (dependencies.get(node.id) ?? []).every((dependency) => succeeded.has(dependency)),
        );
        if (ready.length === 0) {
          throw new Error(
            `Production graph 无法继续：${remaining.map((node) => node.id).join(", ")} 的依赖不可满足`,
          );
        }
        const wave = await Promise.allSettled(ready.map((node) => this.executeNode(id, node.id, project, signal)));
        const failure = wave.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      }
      await this.store.update(id, (runValue) => ({ ...runValue, status: "completed", activeNodeId: null }));
    } catch (error) {
      const cancelled = signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update(id, (run) => ({
        ...run,
        status: cancelled ? "cancelled" : "failed",
        activeNodeId: null,
        nodes: run.nodes.map((node) =>
          node.status === "running"
            ? {
                ...node,
                status: cancelled ? "cancelled" : "failed",
                completedAt: new Date().toISOString(),
                error: message,
              }
            : node,
        ),
      }));
    } finally {
      if (this.controllers.get(id)?.signal === signal) this.controllers.delete(id);
    }
  }

  /**
   * Executes one graph node end to end: resolves its input artifacts, opens a
   * pinned session, runs the role, and persists the produced artifact.
   */
  private async executeNode(
    runId: string,
    nodeId: string,
    project: DirectorProject | undefined,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw signal.reason;
    const run = (await this.store.get(runId))!;
    const node = run.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Production run node ${nodeId} 不存在`);
    const previousInputs = run.artifacts.filter((artifact) => node.inputArtifactIds.includes(artifact.id));
    const inheritedInputs = previousInputs.length
      ? previousInputs
      : node.dependsOn !== undefined
        ? dependencyArtifacts(run, node.dependsOn)
        : relevantArtifactsForRole(run.artifacts, node.roleId);
    const session = this.harness.createSession({
      provider: run.provider,
      profileId: node.profileId,
      roleId: node.roleId,
      title: `${node.roleId} · ${run.objective.slice(0, 80)}`,
    });
    await this.store.update(runId, (current) => ({
      ...current,
      activeNodeId: node.id,
      nodes: current.nodes.map((candidate) =>
        candidate.id === node.id
          ? {
              ...candidate,
              sessionId: session.id,
              status: "running",
              attempt: candidate.attempt + 1,
              startedAt: new Date().toISOString(),
              inputArtifactIds: inheritedInputs.map((artifact) => artifact.id),
              error: null,
            }
          : candidate,
      ),
    }));
    const output = await this.runNode(
      session.id,
      [
        `Production objective: ${run.objective}`,
        `Production brief: ${JSON.stringify(run.brief ?? filmProductionBriefSchema.parse({}))}`,
        `Assigned role: ${node.roleId}`,
        ROLE_INSTRUCTIONS[node.roleId],
        `Upstream immutable artifacts:\n${JSON.stringify(inheritedInputs.map((artifact) => ({ id: artifact.id, kind: artifact.kind, payload: artifact.payload })))}`,
        ROLE_OUTPUT_CONTRACT,
      ].join("\n\n"),
      project,
      run,
      signal,
    );
    const artifact = this.artifact(node.roleId, output);
    await this.store.update(runId, (current) => ({
      ...current,
      artifacts: [...current.artifacts, artifact],
      activeNodeId: current.activeNodeId === node.id ? null : current.activeNodeId,
      nodes: current.nodes.map((candidate) =>
        candidate.id === node.id
          ? {
              ...candidate,
              status: "succeeded",
              completedAt: new Date().toISOString(),
              outputArtifactIds: [artifact.id],
            }
          : candidate,
      ),
    }));
  }

  private runNode(
    sessionId: string,
    prompt: string,
    project: DirectorProject | undefined,
    run: ProductionRun,
    signal: AbortSignal,
  ) {
    return new Promise<ProductionNodeOutput>((resolveOutput, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const cleanup = () => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        void this.harness.interrupt(sessionId).catch(() => undefined);
        rejectOnce(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      unsubscribe = this.harness.subscribe(sessionId, (event) => {
        if (event.type !== "turn.completed") return;
        try {
          const sessionEvents = this.harness.store.listEvents(sessionId);
          const text = sessionEvents
            .filter((candidate) => candidate.type === "assistant.message")
            .map((candidate) => String(candidate.data.text ?? ""))
            .filter(Boolean)
            .join("\n")
            .slice(0, 24_000);
          const receipts = sessionEvents
            .filter((candidate) => candidate.type === "tool.completed")
            .slice(-24)
            .map((candidate) => ({
              title: String(candidate.data.title ?? candidate.itemId ?? "unknown-tool"),
              status: String(candidate.data.status ?? "completed"),
              result: boundedReceiptResult(candidate.data.result),
            }));
          const nestedTurn =
            event.data.turn && typeof event.data.turn === "object"
              ? (event.data.turn as { status?: unknown })
              : undefined;
          const status = String(event.data.status ?? nestedTurn?.status ?? "completed");
          if (status !== "completed") {
            rejectOnce(new Error(String(event.data.error ?? `${run.provider} node failed`)));
          } else if (!text) {
            rejectOnce(new Error(`${run.provider} node completed without a durable role artifact`));
          } else if (!settled) {
            settled = true;
            cleanup();
            resolveOutput({ text, receipts });
          }
        } catch (error) {
          rejectOnce(error);
        }
      });
      void this.harness.sendMessage(sessionId, prompt, project, run.target).catch((error) => {
        rejectOnce(error);
      });
    });
  }

  private artifact(roleId: FilmRoleId, output: ProductionNodeOutput): ProductionArtifact {
    const completedReceipts = output.receipts.filter((receipt) => receipt.status === "completed");
    const verifiedGeneration = completedReceipts.some(
      (receipt) => receipt.title === "stage_video" && containsField(receipt.result, "job_id"),
    );
    const hasDirectorResult = completedReceipts.some(
      (receipt) =>
        receipt.title === "director_workbench" ||
        (receipt.title === "blender_native" &&
          (containsField(receipt.result, "revisionAfter") ||
            (containsField(receipt.result, "scene") && containsField(receipt.result, "revision")))),
    );
    const document = parseFilmRoleDeliverable(output.text);
    const payload = {
      text: output.text,
      ...(document ? { document } : {}),
      ...(output.receipts.length ? { receipts: output.receipts } : {}),
    };
    return {
      id: `artifact-${crypto.randomUUID()}`,
      kind:
        roleId === "generation-operator" && verifiedGeneration
          ? "generation-receipt"
          : (roleId === "production-designer" ||
                roleId === "stage-director" ||
                roleId === "cinematographer" ||
                roleId === "repair-operator") &&
              hasDirectorResult
            ? "director-receipt"
            : FILM_ROLE_ARTIFACT_KIND[roleId],
      roleId,
      payload,
      createdAt: new Date().toISOString(),
    };
  }
}
