import { beforeEach, describe, expect, it } from "vitest";
import {
  applyObservedAgentGuard,
  prepareAgentDurableJobMutation,
  prepareAgentMutation,
  resetAgentNaiveBoundaryForTests,
} from "../../agentNaiveBoundary";

describe("Agent naive public boundary", () => {
  beforeEach(() => resetAgentNaiveBoundaryForTests());

  it("adds a request key and remembers the first Workbench guard across target reconnects", () => {
    const mutation = {
      tool: "director_workbench" as const,
      operation: {
        op: "author" as const,
        idempotency_key: "naive-workbench-retry-v1",
        actions: [{ action: "set_scene" as const, patch: { backgroundColor: "#111827" } }],
      },
    };
    const prepared = prepareAgentMutation(mutation, "agent-session-1");
    expect(prepared.needsObservation).toBe(true);
    const guarded = applyObservedAgentGuard(prepared, "agent-session-1", "project-revision-1");
    expect(guarded.mutation.operation).toMatchObject({
      idempotency_key: "naive-workbench-retry-v1",
      expected_revision: "project-revision-1",
    });

    const retry = prepareAgentMutation(mutation, "agent-session-1");
    expect(retry).toMatchObject({
      needsObservation: false,
      mutation: { operation: { expected_revision: "project-revision-1" } },
      receipt: { guard: { source: "remembered_retry" } },
    });
  });

  it("guards Canvas pipeline start and collaboration comments through their native fields", () => {
    const pipeline = prepareAgentMutation(
      {
        tool: "director_creative",
        operation: {
          op: "pipeline",
          request: {
            action: "start",
            target_node_ids: [],
            force_node_ids: [],
            max_parallel: 4,
            await_completion: false,
          },
        },
      },
      "agent-session-2",
    );
    const guardedPipeline = applyObservedAgentGuard(pipeline, "agent-session-2", "creative-revision-1");
    expect(guardedPipeline.mutation.operation).toMatchObject({
      request: { expected_snapshot_fingerprint: "creative-revision-1", idempotency_key: expect.any(String) },
    });

    const comment = prepareAgentMutation(
      {
        tool: "director_creative",
        operation: {
          op: "collaboration",
          request: {
            action: "add-comment",
            anchor: { type: "scene", scene_id: "scene-1" },
            body: "Check continuity.",
          },
        },
      },
      "agent-session-2",
    );
    const guardedComment = applyObservedAgentGuard(comment, "agent-session-2", "collaboration-revision-1");
    expect(guardedComment.mutation.operation).toMatchObject({
      request: {
        expected_collaboration_fingerprint: "collaboration-revision-1",
        idempotency_key: expect.any(String),
      },
    });
  });

  it("binds Production mutations to the first observed production revision", () => {
    const mutation = {
      tool: "director_workbench" as const,
      operation: {
        op: "production" as const,
        command: { action: "rename_scene" as const, scene_id: "scene-a", title: "Opening" },
      },
    };
    const prepared = prepareAgentMutation(mutation, "agent-session-production");
    const guarded = applyObservedAgentGuard(prepared, "agent-session-production", "7");
    expect(guarded).toMatchObject({
      mutation: {
        operation: {
          command: {
            idempotency_key: expect.stringMatching(/^agent-intent:/),
            expected_revision: 7,
          },
        },
      },
      receipt: { operation: "production.rename_scene", guard: { field: "expected_production_revision" } },
    });
  });

  it.each([
    {
      op: "generated_3d" as const,
      command: { action: "promote" as const, job_id: "generated-job-1" },
      operation: "generated_3d.promote",
    },
    {
      op: "storyboard_artifact" as const,
      command: { action: "capture_missing" as const },
      operation: "storyboard_artifact.capture_missing",
    },
    {
      op: "storyboard_artifact" as const,
      command: { action: "export_pdf" as const },
      operation: "storyboard_artifact.export_pdf",
    },
  ])("guards and keys nested $operation commands", ({ op, command, operation }) => {
    const prepared = prepareAgentMutation(
      { tool: "director_workbench", operation: { op, command } as never },
      "agent-session-nested",
    );
    const guarded = applyObservedAgentGuard(prepared, "agent-session-nested", "project-revision-nested");
    expect(guarded).toMatchObject({
      mutation: {
        operation: {
          command: {
            expected_revision: "project-revision-nested",
            idempotency_key: expect.stringMatching(/^agent-intent:/),
          },
        },
      },
      receipt: { operation, guard: { field: "expected_revision" } },
    });
  });

  it.each([
    {
      op: "generation" as const,
      command: {
        action: "submit" as const,
        kind: "image.generate" as const,
        workflow_id: "comfy-workflow-main",
        prompt: "A production city establishing shot",
      },
    },
    {
      op: "transcription" as const,
      command: { action: "retry" as const, job_id: "transcription-job-1" },
    },
    {
      op: "generated_3d" as const,
      command: {
        action: "submit" as const,
        mode: "text-to-3d" as const,
        name: "Hero prop",
        prompt: "A detailed production-ready hero prop",
      },
    },
  ])("assigns a durable retry key to $op.$command.action without a project preflight", ({ op, command }) => {
    const prepared = prepareAgentDurableJobMutation({
      tool: "director_workbench",
      operation: { op, command } as never,
    });
    expect(prepared).toMatchObject({
      needsObservation: false,
      mutation: { operation: { command: { idempotency_key: expect.stringMatching(/^agent-intent:/) } } },
      receipt: {
        operation: `${op}.${command.action}`,
        preflight_observe: false,
        guard: { mode: "durable_job", source: "gateway" },
        idempotency: { source: "generated", stable_retry: true },
      },
    });
  });
});
