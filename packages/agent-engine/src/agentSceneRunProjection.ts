import type { AgentEvent } from "./agentSessionSchema";

export type AgentSceneRunPhaseId = "context" | "build" | "verify" | "repair";
export type AgentSceneRunPhaseState = "idle" | "active" | "complete" | "attention";
export type AgentSceneRunStatus = "idle" | "running" | "verification_needed" | "verified" | "complete" | "attention";

export type AgentSceneRunPhase = {
  id: AgentSceneRunPhaseId;
  state: AgentSceneRunPhaseState;
  calls: number;
};

export type AgentSceneRunOperation = {
  eventId: string;
  tool: string;
  op: string | null;
  phase: AgentSceneRunPhaseId;
  state: "running" | "complete" | "attention";
};

export type AgentSceneRunRevision = {
  authority: "director" | "blender";
  value: string | number;
};

export type AgentSceneRunProjection = {
  visible: boolean;
  status: AgentSceneRunStatus;
  activePhase: AgentSceneRunPhaseId | null;
  phases: AgentSceneRunPhase[];
  latestOperation: AgentSceneRunOperation | null;
  sceneRevision: AgentSceneRunRevision | null;
  targetIds: string[];
  targetCount: number;
};

const MUTATION_OPS = new Set([
  "apply",
  "author",
  "correct",
  "execute",
  "execute_batch",
  "patch",
  "replace_project",
  "undo",
]);
const VERIFY_OPS = new Set(["audit", "capture", "diff", "inspect", "observe", "query_objects", "scene"]);
const CONTEXT_OPS = new Set([
  "capabilities",
  "catalog",
  "describe",
  "inspect",
  "observe",
  "query_objects",
  "scene",
  "status",
]);
const FAILED_STATUSES = new Set(["cancelled", "canceled", "error", "failed", "interrupted"]);
const ATTENTION_OUTCOMES = new Set(["failed", "outcome_unknown", "stale_revision", "timed_out"]);
const TARGET_ARRAY_KEYS = new Set([
  "asset_ids",
  "camera_ids",
  "character_ids",
  "ids",
  "light_ids",
  "object_ids",
  "target_node_ids",
  "track_ids",
]);
const TARGET_KEYS = new Set([
  "asset_id",
  "camera_id",
  "character_id",
  "clip_id",
  "follow_object_id",
  "light_id",
  "object_id",
  "subject_id",
  "target_id",
  "track_id",
]);

type ToolDescriptor = {
  eventId: string;
  tool: string;
  op: string | null;
  input: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toolItem(event: AgentEvent) {
  return asRecord(event.data.item);
}

function toolInput(event: AgentEvent): Record<string, unknown> | null {
  const direct = asRecord(event.data.input);
  if (direct) return direct;
  const item = toolItem(event);
  return asRecord(item?.arguments) ?? asRecord(item?.input) ?? asRecord(item?.params);
}

function toolDescriptor(event: AgentEvent): ToolDescriptor {
  const item = toolItem(event);
  const input = toolInput(event);
  const tool = text(item?.tool) ?? text(item?.name) ?? text(event.data.title) ?? "";
  return {
    eventId: event.id,
    tool,
    op: text(event.data.op) ?? text(input?.op),
    input,
  };
}

function isSceneTool(tool: string) {
  const normalized = tool.toLowerCase().replaceAll("-", "_");
  return normalized.includes("director_workbench") || normalized.includes("blender_native");
}

function eventResult(event: AgentEvent) {
  return asRecord(event.data.result);
}

function resultOutcomes(event: AgentEvent) {
  const result = eventResult(event);
  const inner = asRecord(result?.result);
  const candidates = [result?.outcomes, inner?.outcomes, event.data.outcomes];
  return candidates.flatMap((candidate) =>
    Array.isArray(candidate)
      ? candidate.flatMap((entry) => {
          const outcome = asRecord(entry);
          return outcome ? [text(outcome.kind)] : [];
        })
      : [],
  );
}

function eventNeedsAttention(event: AgentEvent) {
  if (FAILED_STATUSES.has(String(event.data.status ?? "").toLowerCase())) return true;
  const result = eventResult(event);
  if (result?.success === false || asRecord(result?.result)?.success === false) return true;
  return resultOutcomes(event).some((kind) => kind && ATTENTION_OUTCOMES.has(kind));
}

function numericRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function eventRevision(event: AgentEvent): AgentSceneRunRevision | null {
  const result = eventResult(event);
  const inner = asRecord(result?.result);
  const director = text(event.data.project_revision) ?? text(result?.project_revision) ?? text(inner?.project_revision);
  if (director) return { authority: "director", value: director };
  const receipt = asRecord(result?.receipt) ?? asRecord(inner?.receipt);
  const evidence = asRecord(result?.evidence) ?? asRecord(inner?.evidence);
  const native =
    numericRevision(receipt?.revisionAfter) ??
    numericRevision(evidence?.revision) ??
    numericRevision(result?.revision) ??
    numericRevision(inner?.revision);
  return native === null ? null : { authority: "blender", value: native };
}

function collectTargetIds(input: Record<string, unknown> | null) {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = text(value);
    if (id && id !== "ground") ids.add(id);
  };
  const visit = (value: unknown, depth: number) => {
    const record = asRecord(value);
    if (!record || depth > 2) return;
    for (const [key, entry] of Object.entries(record)) {
      if (TARGET_ARRAY_KEYS.has(key) && Array.isArray(entry)) entry.forEach(add);
      else if (TARGET_KEYS.has(key)) add(entry);
      else if (key === "id" && depth > 0) add(entry);
      else if ((key === "actions" || key === "operations") && Array.isArray(entry)) {
        entry.forEach((item) => visit(item, depth + 1));
      }
    }
  };
  visit(input, 0);
  return [...ids];
}

function latestTurn(events: readonly AgentEvent[]) {
  let start = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === "user.message" && event.data.source !== "compact" && event.data.source !== "inject") {
      start = index;
    }
  }
  return events.slice(start);
}

function createPhases(): Record<AgentSceneRunPhaseId, AgentSceneRunPhase> {
  return {
    context: { id: "context", state: "idle", calls: 0 },
    build: { id: "build", state: "idle", calls: 0 },
    verify: { id: "verify", state: "idle", calls: 0 },
    repair: { id: "repair", state: "idle", calls: 0 },
  };
}

function operationPhase(op: string | null, pendingVerification: boolean, repairMode: boolean): AgentSceneRunPhaseId {
  if (op && MUTATION_OPS.has(op)) return repairMode ? "repair" : "build";
  if (pendingVerification && op && VERIFY_OPS.has(op)) return "verify";
  return "context";
}

/** Pure, replayable projection of the latest 3D scene-building turn. */
export function deriveAgentSceneRun(events: readonly AgentEvent[]): AgentSceneRunProjection {
  const phases = createPhases();
  const openCalls = new Map<string, { descriptor: ToolDescriptor; phase: AgentSceneRunPhaseId }>();
  const targets = new Set<string>();
  let visible = false;
  let pendingVerification = false;
  let repairMode = false;
  let unresolvedAttention = false;
  let sceneRevision: AgentSceneRunRevision | null = null;
  let mutationRevision: AgentSceneRunRevision | null = null;
  let latestOperation: AgentSceneRunOperation | null = null;

  for (const event of latestTurn(events)) {
    if (event.type !== "tool.started" && event.type !== "tool.completed") continue;
    const callKey = event.itemId ?? event.id;
    const fromStart = openCalls.get(callKey)?.descriptor;
    const direct = toolDescriptor(event);
    const descriptor: ToolDescriptor = {
      eventId: event.id,
      tool: direct.tool || fromStart?.tool || "",
      op: direct.op ?? fromStart?.op ?? null,
      input: direct.input ?? fromStart?.input ?? null,
    };
    if (!isSceneTool(descriptor.tool)) continue;
    visible = true;
    collectTargetIds(descriptor.input).forEach((id) => targets.add(id));

    if (event.type === "tool.started") {
      const phase = operationPhase(descriptor.op, pendingVerification, repairMode);
      openCalls.set(callKey, { descriptor, phase });
      phases[phase] = { ...phases[phase], state: "active" };
      latestOperation = { eventId: event.id, tool: descriptor.tool, op: descriptor.op, phase, state: "running" };
      continue;
    }

    const phase = openCalls.get(callKey)?.phase ?? operationPhase(descriptor.op, pendingVerification, repairMode);
    openCalls.delete(callKey);
    const needsAttention = eventNeedsAttention(event);
    const revision = eventRevision(event);
    if (revision) sceneRevision = revision;

    phases[phase] = {
      ...phases[phase],
      state: needsAttention ? "attention" : "complete",
      calls: phases[phase].calls + 1,
    };
    latestOperation = {
      eventId: event.id,
      tool: descriptor.tool,
      op: descriptor.op,
      phase,
      state: needsAttention ? "attention" : "complete",
    };

    if (needsAttention) {
      unresolvedAttention = true;
      if (phase === "build" || phase === "verify") repairMode = true;
      continue;
    }

    if (descriptor.op && MUTATION_OPS.has(descriptor.op)) {
      pendingVerification = true;
      mutationRevision = revision ?? sceneRevision;
      if (phase === "repair") repairMode = false;
      continue;
    }

    if (pendingVerification && descriptor.op && VERIFY_OPS.has(descriptor.op)) {
      if (
        mutationRevision &&
        revision &&
        mutationRevision.authority === revision.authority &&
        mutationRevision.value !== revision.value
      ) {
        phases.verify = { ...phases.verify, state: "attention" };
        unresolvedAttention = true;
        repairMode = true;
      } else {
        pendingVerification = false;
        unresolvedAttention = false;
      }
    } else if (descriptor.op && CONTEXT_OPS.has(descriptor.op)) {
      phases.context = { ...phases.context, state: "complete" };
    }
  }

  const active = [...openCalls.values()].at(-1)?.phase ?? null;
  const status: AgentSceneRunStatus = active
    ? "running"
    : unresolvedAttention
      ? "attention"
      : pendingVerification
        ? "verification_needed"
        : phases.verify.calls > 0
          ? "verified"
          : visible
            ? "complete"
            : "idle";

  return {
    visible,
    status,
    activePhase: active,
    phases: [phases.context, phases.build, phases.verify, phases.repair],
    latestOperation,
    sceneRevision,
    targetIds: [...targets].slice(0, 6),
    targetCount: targets.size,
  };
}
