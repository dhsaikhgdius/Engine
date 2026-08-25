import { expect, it } from "vitest";
import type { AgentEvent } from "../src/agentSessionSchema";
import { deriveAgentSceneRun } from "../src/agentSceneRunProjection";

function event(
  sequence: number,
  type: AgentEvent["type"],
  data: Record<string, unknown> = {},
  itemId: string | null = null,
): AgentEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type,
    timestamp: `2026-08-15T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    turnId: "turn-1",
    itemId,
    provider: "api",
    data,
  };
}

function toolPair(
  sequence: number,
  itemId: string,
  op: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  return [
    event(sequence, "tool.started", { title: "director_workbench", input: { op, ...input }, op }, itemId),
    event(sequence + 1, "tool.completed", { title: "director_workbench", status: "completed", result }, itemId),
  ];
}

it("projects a blockout turn from context through revision-bound visual verification", () => {
  const projection = deriveAgentSceneRun([
    event(1, "user.message", { text: "搭建大厅白膜" }),
    ...toolPair(
      2,
      "read",
      "observe",
      { fields: ["objects"] },
      { success: true, result: { project_revision: "rev-1" } },
    ),
    ...toolPair(
      4,
      "build",
      "author",
      { actions: [{ action: "add_object", id: "hall-wall", object_id: "hall-wall" }] },
      { success: true, result: { project_revision: "rev-2" } },
    ),
    ...toolPair(
      6,
      "verify",
      "capture",
      { camera_id: "camera-main", frame: 0 },
      { success: true, result: { project_revision: "rev-2", capture_verified: true } },
    ),
  ]);

  expect(projection.status).toBe("verified");
  expect(projection.sceneRevision).toEqual({ authority: "director", value: "rev-2" });
  expect(projection.phases.map((phase) => phase.state)).toEqual(["complete", "complete", "complete", "idle"]);
  expect(projection.targetIds).toEqual(expect.arrayContaining(["hall-wall", "camera-main"]));
});

it("binds Blender apply and inspect calls to the native scene revision", () => {
  const projection = deriveAgentSceneRun([
    event(1, "user.message", { text: "添加原生墙体" }),
    event(
      2,
      "tool.started",
      {
        title: "blender_native",
        op: "apply",
        input: { op: "apply", operations: [{ op: "create_primitive", id: "native-wall" }] },
      },
      "native-build",
    ),
    event(
      3,
      "tool.completed",
      {
        title: "blender_native",
        status: "completed",
        result: { success: true, result: { receipt: { revisionAfter: 8 } } },
      },
      "native-build",
    ),
    event(
      4,
      "tool.started",
      { title: "blender_native", op: "inspect", input: { op: "inspect", id: "native-wall" } },
      "native-inspect",
    ),
    event(
      5,
      "tool.completed",
      {
        title: "blender_native",
        status: "completed",
        result: { success: true, result: { evidence: { revision: 8 } } },
      },
      "native-inspect",
    ),
  ]);

  expect(projection.status).toBe("verified");
  expect(projection.sceneRevision).toEqual({ authority: "blender", value: 8 });
  expect(projection.targetIds).toContain("native-wall");
});

it("keeps an authored scene pending until a targeted check is recorded", () => {
  const projection = deriveAgentSceneRun([
    event(1, "user.message", { text: "添加墙体" }),
    ...toolPair(
      2,
      "build",
      "author",
      { actions: [{ action: "add_object", id: "wall-a" }] },
      { success: true, result: { project_revision: "rev-2" } },
    ),
  ]);

  expect(projection.status).toBe("verification_needed");
  expect(projection.phases.find((phase) => phase.id === "build")?.state).toBe("complete");
  expect(projection.phases.find((phase) => phase.id === "verify")?.state).toBe("idle");
});

it("moves a stale check into local repair and accepts a later verification", () => {
  const staleCapture = toolPair(
    4,
    "verify",
    "capture",
    { camera_id: "camera-main", frame: 0 },
    {
      success: true,
      result: {
        project_revision: "rev-3",
        outcomes: [{ kind: "stale_revision" }],
      },
    },
  );
  const projection = deriveAgentSceneRun([
    event(1, "user.message", { text: "修好入口" }),
    ...toolPair(
      2,
      "build",
      "author",
      { actions: [{ action: "update_object", object_id: "entrance" }] },
      { success: true, result: { project_revision: "rev-2" } },
    ),
    ...staleCapture,
    ...toolPair(
      6,
      "repair",
      "author",
      { actions: [{ action: "update_object", object_id: "entrance" }] },
      { success: true, result: { project_revision: "rev-4" } },
    ),
    ...toolPair(
      8,
      "verify-again",
      "inspect",
      { object_id: "entrance" },
      { success: true, result: { project_revision: "rev-4" } },
    ),
  ]);

  expect(projection.status).toBe("verified");
  expect(projection.phases.find((phase) => phase.id === "repair")?.state).toBe("complete");
  expect(projection.latestOperation?.phase).toBe("verify");
});

it("projects only the latest user turn", () => {
  const projection = deriveAgentSceneRun([
    event(1, "user.message", { text: "旧任务" }),
    ...toolPair(2, "old-build", "author", { actions: [{ action: "add_object", id: "old" }] }, { success: true }),
    event(4, "user.message", { text: "新任务" }),
  ]);

  expect(projection.visible).toBe(false);
  expect(projection.status).toBe("idle");
});
