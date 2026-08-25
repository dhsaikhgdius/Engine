import { describe, expect, it } from "vitest";
import { collectPossessedObjectIds, evaluateDirectorPossessionScope } from "../src/directorPossessionScope";
import { parseDirectorWorkbenchInput, type DirectorWorkbenchOperation } from "../src/directorWorkbenchContract";

const SESSION = "dsh-session-1";

function parseOperation(input: unknown): DirectorWorkbenchOperation {
  const parsed = parseDirectorWorkbenchInput(input);
  if (!parsed.success) throw new Error(parsed.error);
  return parsed.operation;
}

function evaluate(input: unknown, possessedObjectIds: readonly string[]) {
  return evaluateDirectorPossessionScope({
    operation: parseOperation(input),
    sessionId: SESSION,
    possessedObjectIds,
  });
}

describe("collectPossessedObjectIds", () => {
  it("collects only characters possessed by the calling session", () => {
    const characters = [
      { id: "hero", agent_binding: { session_id: SESSION, profile_id: null, role_id: null, mode: "possess" } },
      { id: "extra", agent_binding: { session_id: "dsh-session-2", profile_id: null, role_id: null, mode: "possess" } },
      { id: "unbound" },
      { id: "profile-only", agent_binding: { session_id: null, profile_id: "profile-a", mode: "possess" } },
    ];
    expect(collectPossessedObjectIds(characters, SESSION)).toEqual(["hero"]);
    expect(collectPossessedObjectIds(characters, "dsh-session-2")).toEqual(["extra"]);
    expect(collectPossessedObjectIds(characters, "")).toEqual([]);
    expect(collectPossessedObjectIds(undefined, SESSION)).toEqual([]);
    expect(collectPossessedObjectIds([{ nonsense: true }], SESSION)).toEqual([]);
  });
});

describe("evaluateDirectorPossessionScope", () => {
  it("keeps sessions without possessed characters unrestricted", () => {
    expect(evaluate({ op: "undo" }, [])).toEqual({ allowed: true });
    expect(
      evaluate({ op: "author", actions: [{ action: "delete_objects", object_ids: ["anything"] }] }, []),
    ).toEqual({ allowed: true });
  });

  it("allows reads and character-scoped author actions on possessed characters", () => {
    expect(evaluate({ op: "observe" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "capture", frame: 0 }, ["hero"])).toEqual({ allowed: true });
    expect(
      evaluate(
        {
          op: "author",
          actions: [
            { action: "set_character_motion", object_id: "hero", clip_id: "walk" },
            { action: "set_character_pose_controls", object_id: "hero", controls: [{ control: "head.yaw", value: 20 }] },
            { action: "update_object", object_id: "hero", patch: { transform: { position: [1, 0, 2] } } },
            {
              action: "set_character_ik",
              object_id: "hero",
              effector: "leftHand",
              target: [0.4, 1.2, 0.3],
              pole: [0.4, 0.6, 0.6],
              weight: 1,
              reach_clamp: 0.98,
            },
            { action: "unbind_character_agent", object_id: "hero" },
          ],
        },
        ["hero"],
      ),
    ).toEqual({ allowed: true });
  });

  it("allows multi-object transforms and object animation limited to the possessed set", () => {
    expect(
      evaluate(
        {
          op: "author",
          actions: [
            { action: "batch_update_objects", object_ids: ["hero", "sidekick"], patch: { visible: true } },
            { action: "reset_transforms", object_ids: ["hero"], components: ["rotation"] },
            { action: "set_animation", target_type: "object", target_id: "hero", animation: null },
          ],
        },
        ["hero", "sidekick"],
      ),
    ).toEqual({ allowed: true });
  });

  it("rejects author actions that touch characters outside the possessed set", () => {
    const verdict = evaluate(
      {
        op: "author",
        actions: [{ action: "set_character_motion", object_id: "villain", clip_id: "walk" }],
      },
      ["hero"],
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.error).toContain('"villain"');
      expect(verdict.error).toContain('"hero"');
      expect(verdict.error).toContain(SESSION);
    }
  });

  it("rejects stage-wide author actions and camera animation under possession", () => {
    const deletion = evaluate(
      { op: "author", actions: [{ action: "delete_objects", object_ids: ["hero"] }] },
      ["hero"],
    );
    expect(deletion).toMatchObject({ allowed: false, error: expect.stringContaining('"delete_objects"') });

    const startScene = evaluate({ op: "author", actions: [{ action: "start_scene" }] }, ["hero"]);
    expect(startScene).toMatchObject({ allowed: false, error: expect.stringContaining('"start_scene"') });

    const cameraAnimation = evaluate(
      { op: "author", actions: [{ action: "set_animation", target_type: "camera", target_id: "cam_1", animation: null }] },
      ["hero"],
    );
    expect(cameraAnimation).toMatchObject({ allowed: false, error: expect.stringContaining('"set_animation"') });
  });

  it("rejects non-author mutations with a readable, actionable error", () => {
    const undo = evaluate({ op: "undo" }, ["hero"]);
    expect(undo).toMatchObject({ allowed: false, error: expect.stringContaining('"undo"') });
    if (!undo.allowed) expect(undo.error).toContain("unbind_character_agent");

    const patch = evaluate(
      { op: "patch", patches: [{ op: "replace", path: "/project/name", value: "Hijack" }] },
      ["hero"],
    );
    expect(patch).toMatchObject({ allowed: false, error: expect.stringContaining('"patch"') });

    const production = evaluate(
      { op: "production", command: { action: "delete_scene", scene_id: "scene-1", idempotency_key: "k1" } },
      ["hero"],
    );
    expect(production).toMatchObject({
      allowed: false,
      error: expect.stringContaining('"production.delete_scene"'),
    });
  });
});
