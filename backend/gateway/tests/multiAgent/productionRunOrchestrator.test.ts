// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@director/agent-engine";
import type { CreateProductionRunRequest, ProductionRun } from "@director/agent-engine";
import type { FilmRoleId } from "../../../../packages/protocol/src/filmProductionProtocol";
import { MultiAgentRunStore } from "../../multiAgent/multiAgentRunStore";
import {
  DEFAULT_FILM_GRAPH,
  ProductionRunOrchestrator,
  type ProductionAgentRunner,
} from "../../multiAgent/productionRunOrchestrator";

type ScriptedOutcome =
  | {
      type: "success";
      text: string;
      receipts?: Array<{ title: string; status?: string; result?: unknown }>;
    }
  | { type: "failure"; error: string }
  | { type: "hang" };

type Listener = (event: AgentEvent) => void;

class FakeAgentHarness {
  private sessionSequence = 0;
  private eventSequence = 0;
  private readonly roleBySession = new Map<string, FilmRoleId>();
  private readonly eventsBySession = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly prompts: Array<{ roleId: FilmRoleId; sessionId: string; prompt: string }> = [];
  readonly sessions: Array<{ roleId: FilmRoleId; profileId: string; sessionId: string }> = [];
  readonly interruptedSessionIds: string[] = [];

  readonly store = {
    listEvents: (sessionId: string) => this.eventsBySession.get(sessionId) ?? [],
  };

  constructor(private readonly outcomes: Partial<Record<FilmRoleId, ScriptedOutcome[]>>) {}

  createSession(input: { roleId?: FilmRoleId | null; profileId?: string }) {
    if (!input.roleId) throw new Error("The orchestrator must pin every session to a film role");
    if (!input.profileId) throw new Error("The orchestrator must pin every role to an exact profile");
    const id = `fake-session-${++this.sessionSequence}`;
    this.roleBySession.set(id, input.roleId);
    this.sessions.push({ roleId: input.roleId, profileId: input.profileId, sessionId: id });
    this.eventsBySession.set(id, []);
    return { id };
  }

  subscribe(sessionId: string, listener: Listener) {
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  async sendMessage(sessionId: string, prompt: string) {
    const roleId = this.roleBySession.get(sessionId);
    if (!roleId) throw new Error(`Unknown fake session ${sessionId}`);
    this.prompts.push({ roleId, sessionId, prompt });
    const outcome = this.outcomes[roleId]?.shift();
    if (!outcome) throw new Error(`No scripted outcome for ${roleId}`);
    if (outcome.type === "hang") return { queued: false };

    queueMicrotask(() => {
      if (outcome.type === "success") {
        for (const receipt of outcome.receipts ?? []) {
          this.append(sessionId, "tool.completed", {
            title: receipt.title,
            status: receipt.status ?? "completed",
            result: receipt.result,
          });
        }
        this.append(sessionId, "assistant.message", { text: outcome.text });
        this.emit(sessionId, "turn.completed", { status: "completed" });
      } else {
        // Codex app-server style events can carry status under `turn.status`.
        // The orchestrator must interpret the same normalized shape as AgentHarness.
        this.emit(sessionId, "turn.completed", { turn: { status: "failed" }, error: outcome.error });
      }
    });
    return { queued: false };
  }

  async interrupt(sessionId: string) {
    this.interruptedSessionIds.push(sessionId);
    return { id: sessionId };
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }

  private append(sessionId: string, type: AgentEvent["type"], data: Record<string, unknown>) {
    const event = {
      id: `fake-event-${++this.eventSequence}`,
      sessionId,
      sequence: this.eventSequence,
      type,
      timestamp: new Date().toISOString(),
      turnId: null,
      itemId: null,
      provider: "api",
      data,
    } satisfies AgentEvent;
    this.eventsBySession.get(sessionId)?.push(event);
    return event;
  }

  private emit(sessionId: string, type: AgentEvent["type"], data: Record<string, unknown>) {
    const event = this.append(sessionId, type, data);
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener(event);
  }
}

const directories: string[] = [];
const TARGET = {
  token: "target-token",
  client_id: "browser-client",
  instance_id: "director-instance",
  scene_id: "scene-1",
  creative_scope_id: "scope-1",
  contract_version: 2 as const,
};

function setup(
  outcomes: Partial<Record<FilmRoleId, ScriptedOutcome[]>>,
  configuredProfileByRole: Partial<Record<FilmRoleId, string>> = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), "director-production-orchestrator-"));
  directories.push(directory);
  const store = new MultiAgentRunStore(directory);
  const harness = new FakeAgentHarness(outcomes);
  const orchestrator = new ProductionRunOrchestrator(
    harness as unknown as ProductionAgentRunner,
    store,
    configuredProfileByRole,
  );
  return { store, harness, orchestrator };
}

function request(roles: FilmRoleId[]): CreateProductionRunRequest {
  return {
    objective: "Create a causally coherent three-shot sequence with verified continuity.",
    provider: "api",
    profileId: "api-default",
    roles,
    target: TARGET,
  };
}

async function waitForRun(
  store: MultiAgentRunStore,
  id: string,
  predicate: (run: ProductionRun) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.get(id);
    if (run && predicate(run)) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  throw new Error(`Timed out waiting for production run ${id}`);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ProductionRunOrchestrator", () => {
  it("uses the complete film production graph by default", () => {
    expect(DEFAULT_FILM_GRAPH).toEqual([
      "showrunner",
      "screenwriter",
      "production-designer",
      "continuity-supervisor",
      "shot-planner",
      "stage-director",
      "cinematographer",
      "generation-operator",
      "visual-critic",
      "repair-operator",
      "sound-designer",
      "editor",
    ]);
  });

  it("routes each role to its resolved profile and persists the exact node assignment", async () => {
    const configured = {
      "stage-director": "configured-director",
      cinematographer: "configured-camera",
      "visual-critic": "configured-critic",
      "repair-operator": "configured-repair",
    } satisfies Partial<Record<FilmRoleId, string>>;
    const { store, harness, orchestrator } = setup(
      {
        "stage-director": [{ type: "success", text: "blocking" }],
        cinematographer: [{ type: "success", text: "camera" }],
        "visual-critic": [{ type: "success", text: "critique" }],
        "repair-operator": [{ type: "success", text: "repair" }],
      },
      configured,
    );
    const input = request(["stage-director", "cinematographer", "visual-critic", "repair-operator"]);
    input.profileByRole = { cinematographer: "request-camera" };

    const created = await orchestrator.create(input);
    expect(created).toMatchObject({
      version: 2,
      profileByRole: {
        "stage-director": "configured-director",
        cinematographer: "request-camera",
        "visual-critic": "configured-critic",
        "repair-operator": "configured-repair",
      },
    });
    expect(created.nodes.map(({ roleId, profileId }) => [roleId, profileId])).toEqual([
      ["stage-director", "configured-director"],
      ["cinematographer", "request-camera"],
      ["visual-critic", "configured-critic"],
      ["repair-operator", "configured-repair"],
    ]);

    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");
    expect(harness.sessions.map(({ roleId, profileId }) => [roleId, profileId])).toEqual(
      completed.nodes.map(({ roleId, profileId }) => [roleId, profileId]),
    );
  });

  it("pins a failed node profile across resume even if server routing changes", async () => {
    const configured: Partial<Record<FilmRoleId, string>> = { "repair-operator": "repair-v1" };
    const { store, harness, orchestrator } = setup(
      {
        "repair-operator": [
          { type: "failure", error: "temporary repair failure" },
          { type: "success", text: "repaired" },
        ],
      },
      configured,
    );
    const created = await orchestrator.create(request(["repair-operator"]));
    await waitForRun(store, created.id, (run) => run.status === "failed");
    configured["repair-operator"] = "repair-v2";
    await orchestrator.resume(created.id);
    await waitForRun(store, created.id, (run) => run.status === "completed");

    expect(harness.sessions.map((session) => session.profileId)).toEqual(["repair-v1", "repair-v1"]);
  });

  it("executes roles strictly in order and hands durable upstream artifacts to each successor", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: "showrunner-report" }],
      screenwriter: [{ type: "success", text: "screenwriter-report" }],
      "continuity-supervisor": [{ type: "success", text: "continuity-report" }],
    });

    const created = await orchestrator.create(request(["showrunner", "screenwriter", "continuity-supervisor"]));
    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");

    expect(harness.prompts.map((entry) => entry.roleId)).toEqual([
      "showrunner",
      "screenwriter",
      "continuity-supervisor",
    ]);
    expect(harness.prompts[1]?.prompt).toContain("showrunner-report");
    expect(harness.prompts[2]?.prompt).toContain("showrunner-report");
    expect(harness.prompts[2]?.prompt).toContain("screenwriter-report");
    expect(completed.artifacts.map((artifact) => artifact.payload)).toEqual([
      { text: "showrunner-report" },
      { text: "screenwriter-report" },
      { text: "continuity-report" },
    ]);
    expect(completed.nodes.map((node) => node.inputArtifactIds.length)).toEqual([0, 1, 2]);
    expect(completed.nodes.every((node) => node.status === "succeeded" && node.attempt === 1)).toBe(true);
    expect(harness.listenerCount()).toBe(0);
  });

  it("persists structured film deliverables and passes them to dependent departments", async () => {
    const creativeBrief = JSON.stringify({
      title: "Approved creative brief",
      summary: "A courier chooses memory over safety.",
      deliverable: { theme: "identity", ending: "the courier opens the archive" },
    });
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: creativeBrief }],
      screenwriter: [{ type: "success", text: "screenplay" }],
      "production-designer": [{ type: "success", text: "production bible" }],
    });

    const created = await orchestrator.create(request(["showrunner", "screenwriter", "production-designer"]));
    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");

    expect(completed.brief).toMatchObject({ targetDurationSec: 90, aspectRatio: "2.39:1", fps: 24 });
    expect(completed.artifacts[0]).toMatchObject({
      kind: "creative-brief",
      payload: {
        document: {
          title: "Approved creative brief",
          deliverable: { theme: "identity" },
        },
      },
    });
    expect(harness.prompts[1]?.prompt).toContain("Approved creative brief");
    expect(harness.prompts[2]?.prompt).toContain("screenplay");
    expect(harness.prompts[2]?.prompt).toContain("Approved creative brief");
  });

  it("resumes at the failed role without repeating succeeded work or duplicating its artifact", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: "approved-brief" }],
      screenwriter: [
        { type: "failure", error: "planner unavailable" },
        { type: "success", text: "recovered-script" },
      ],
      "shot-planner": [{ type: "success", text: "shot-plan" }],
    });

    const created = await orchestrator.create(request(["showrunner", "screenwriter", "shot-planner"]));
    const failed = await waitForRun(store, created.id, (run) => run.status === "failed");
    expect(failed.nodes.map((node) => node.status)).toEqual(["succeeded", "failed", "pending"]);

    // Duplicate HTTP retries must be idempotent and may not launch two copies
    // of the same role graph.
    await Promise.all([orchestrator.resume(created.id), orchestrator.resume(created.id)]);
    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");

    expect(harness.prompts.map((entry) => entry.roleId)).toEqual([
      "showrunner",
      "screenwriter",
      "screenwriter",
      "shot-planner",
    ]);
    expect(harness.prompts[2]?.prompt).toContain("approved-brief");
    expect(completed.nodes.map((node) => node.attempt)).toEqual([1, 2, 1]);
    expect(completed.artifacts.map((artifact) => artifact.payload)).toEqual([
      { text: "approved-brief" },
      { text: "recovered-script" },
      { text: "shot-plan" },
    ]);
    expect(harness.listenerCount()).toBe(0);
  });

  it("interrupts an active harness turn, cancels pending roles, and releases its event subscription", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "hang" }],
    });

    const created = await orchestrator.create(request(["showrunner", "screenwriter"]));
    await waitForRun(store, created.id, (run) => run.activeNodeId !== null);
    const cancelled = await orchestrator.cancel(created.id);
    await waitForRun(store, created.id, (run) => run.status === "cancelled");

    expect(cancelled.nodes.map((node) => node.status)).toEqual(["cancelled", "cancelled"]);
    expect(harness.interruptedSessionIds).toHaveLength(1);
    expect(harness.listenerCount()).toBe(0);
  });

  it("keeps completed tool results as generation, Director and native Blender receipts", async () => {
    const { store, orchestrator } = setup({
      "production-designer": [
        {
          type: "success",
          text: "native set complete",
          receipts: [
            {
              title: "blender_native",
              result: {
                success: true,
                result: { receipt: { revisionBefore: 3, revisionAfter: 4 } },
              },
            },
          ],
        },
      ],
      "stage-director": [
        {
          type: "success",
          text: "blocking complete",
          receipts: [
            {
              title: "director_workbench",
              result: { success: true, result: { changed: true } },
            },
          ],
        },
      ],
      "generation-operator": [
        {
          type: "success",
          text: "submitted",
          receipts: [{ title: "stage_video", result: { success: true, result: { job_id: "video-real-receipt" } } }],
        },
      ],
    });

    const created = await orchestrator.create(
      request(["production-designer", "stage-director", "generation-operator"]),
    );
    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");

    expect(completed.artifacts.map((artifact) => artifact.kind)).toEqual([
      "director-receipt",
      "director-receipt",
      "generation-receipt",
    ]);
    expect(completed.artifacts[2]?.payload).toMatchObject({
      text: "submitted",
      receipts: [{ title: "stage_video", status: "completed" }],
    });
  });

  it("keeps an unverified generation claim as a plan instead of a render receipt", async () => {
    const { store, orchestrator } = setup({
      "generation-operator": [{ type: "success", text: "I claim that rendering succeeded." }],
    });

    const created = await orchestrator.create(request(["generation-operator"]));
    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");
    expect(completed.artifacts[0]).toMatchObject({
      kind: "generation-plan",
      payload: { text: "I claim that rendering succeeded." },
    });
  });
});

describe("ProductionRunOrchestrator configurable graphs", () => {
  const DIAMOND_GRAPH = {
    nodes: [
      { id: "brief", roleId: "showrunner" as const, dependsOn: [] },
      { id: "script", roleId: "screenwriter" as const, dependsOn: ["brief"] },
      { id: "sound", roleId: "sound-designer" as const, dependsOn: ["brief"] },
      { id: "cut", roleId: "editor" as const, dependsOn: ["script", "sound"] },
    ],
  };

  function graphRequest(graph: typeof DIAMOND_GRAPH): CreateProductionRunRequest {
    return {
      objective: "Assemble a verified diamond-shaped production graph.",
      provider: "api",
      profileId: "api-default",
      graph,
      target: TARGET,
    };
  }

  it("completes a non-serial diamond graph and hands each node exactly its dependency artifacts", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: "brief-artifact" }],
      screenwriter: [{ type: "success", text: "script-artifact" }],
      "sound-designer": [{ type: "success", text: "sound-artifact" }],
      editor: [{ type: "success", text: "cut-artifact" }],
    });

    const created = await orchestrator.create(graphRequest(DIAMOND_GRAPH));
    expect(created.nodes.map((node) => [node.id, node.dependsOn])).toEqual([
      ["brief", []],
      ["script", ["brief"]],
      ["sound", ["brief"]],
      ["cut", ["script", "sound"]],
    ]);

    const completed = await waitForRun(store, created.id, (run) => run.status === "completed");
    expect(completed.nodes.every((node) => node.status === "succeeded" && node.attempt === 1)).toBe(true);

    // The scheduler must respect the edges: brief first, cut last, branches in between.
    const promptedRoles = harness.prompts.map((entry) => entry.roleId);
    expect(promptedRoles[0]).toBe("showrunner");
    expect(promptedRoles[3]).toBe("editor");
    expect(promptedRoles.slice(1, 3).sort()).toEqual(["screenwriter", "sound-designer"]);

    // Both branches consume the brief; the join consumes both branch artifacts.
    const nodeById = new Map(completed.nodes.map((node) => [node.id, node]));
    expect(nodeById.get("script")?.inputArtifactIds).toEqual(nodeById.get("brief")?.outputArtifactIds);
    expect(nodeById.get("sound")?.inputArtifactIds).toEqual(nodeById.get("brief")?.outputArtifactIds);
    expect(new Set(nodeById.get("cut")?.inputArtifactIds)).toEqual(
      new Set([
        ...(nodeById.get("script")?.outputArtifactIds ?? []),
        ...(nodeById.get("sound")?.outputArtifactIds ?? []),
      ]),
    );
    const editorPrompt = harness.prompts.find((entry) => entry.roleId === "editor")?.prompt ?? "";
    expect(editorPrompt).toContain("script-artifact");
    expect(editorPrompt).toContain("sound-artifact");
    expect(harness.listenerCount()).toBe(0);
  });

  it("runs independent branches concurrently instead of as a serial list", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: "brief-artifact" }],
      screenwriter: [{ type: "hang" }],
      "sound-designer": [{ type: "success", text: "sound-artifact" }],
    });

    const created = await orchestrator.create(graphRequest(DIAMOND_GRAPH));
    // The sound branch completes while the script branch is still running —
    // impossible under the legacy fixed serial list, where sound-designer
    // would only ever start after screenwriter finished.
    const observed = await waitForRun(store, created.id, (run) => {
      const script = run.nodes.find((node) => node.id === "script");
      const sound = run.nodes.find((node) => node.id === "sound");
      return script?.status === "running" && sound?.status === "succeeded";
    });
    expect(observed.nodes.find((node) => node.id === "cut")?.status).toBe("pending");

    await orchestrator.cancel(created.id);
    await waitForRun(store, created.id, (run) => run.status === "cancelled");
    expect(harness.interruptedSessionIds).toHaveLength(1);
    expect(harness.listenerCount()).toBe(0);
  });

  it("resumes from a checkpoint node, re-running it and its transitive dependents only", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: "brief-artifact" }],
      screenwriter: [
        { type: "success", text: "script-v1" },
        { type: "success", text: "script-v2" },
      ],
      "sound-designer": [{ type: "success", text: "sound-artifact" }],
      editor: [
        { type: "success", text: "cut-v1" },
        { type: "success", text: "cut-v2" },
      ],
    });

    const created = await orchestrator.create(graphRequest(DIAMOND_GRAPH));
    await waitForRun(store, created.id, (run) => run.status === "completed");

    await orchestrator.resume(created.id, undefined, { fromNodeId: "script" });
    const resumed = await waitForRun(
      store,
      created.id,
      (run) => run.status === "completed" && run.nodes.every((node) => node.status === "succeeded"),
    );

    expect(resumed.nodes.map((node) => [node.id, node.attempt])).toEqual([
      ["brief", 1],
      ["script", 2],
      ["sound", 1],
      ["cut", 2],
    ]);
    // Replaced artifacts are dropped; the re-run join consumed the new script.
    const texts = resumed.artifacts.map((artifact) => (artifact.payload as { text: string }).text);
    expect(texts).toContain("script-v2");
    expect(texts).toContain("cut-v2");
    expect(texts).not.toContain("script-v1");
    expect(texts).not.toContain("cut-v1");
    const finalEditorPrompt = harness.prompts.filter((entry) => entry.roleId === "editor").at(-1)?.prompt ?? "";
    expect(finalEditorPrompt).toContain("script-v2");
    expect(finalEditorPrompt).toContain("sound-artifact");
    expect(harness.listenerCount()).toBe(0);
  });

  it("rejects a checkpoint resume for an unknown node id", async () => {
    const { store, orchestrator } = setup({
      showrunner: [{ type: "success", text: "brief-artifact" }],
    });
    const created = await orchestrator.create(request(["showrunner"]));
    await waitForRun(store, created.id, (run) => run.status === "completed");
    await expect(orchestrator.resume(created.id, undefined, { fromNodeId: "missing-node" })).rejects.toThrow(
      /checkpoint node/,
    );
  });

  it("supports checkpoint resume on legacy serial runs through the implicit chain", async () => {
    const { store, harness, orchestrator } = setup({
      showrunner: [{ type: "success", text: "brief-v1" }],
      screenwriter: [
        { type: "success", text: "script-v1" },
        { type: "success", text: "script-v2" },
      ],
      "shot-planner": [
        { type: "success", text: "plan-v1" },
        { type: "success", text: "plan-v2" },
      ],
    });
    const created = await orchestrator.create(request(["showrunner", "screenwriter", "shot-planner"]));
    await waitForRun(store, created.id, (run) => run.status === "completed");

    await orchestrator.resume(created.id, undefined, { fromNodeId: "node-02-screenwriter" });
    const resumed = await waitForRun(
      store,
      created.id,
      (run) => run.status === "completed" && run.nodes.every((node) => node.status === "succeeded"),
    );
    expect(resumed.nodes.map((node) => node.attempt)).toEqual([1, 2, 2]);
    expect(harness.prompts.map((entry) => entry.roleId)).toEqual([
      "showrunner",
      "screenwriter",
      "shot-planner",
      "screenwriter",
      "shot-planner",
    ]);
  });
});
