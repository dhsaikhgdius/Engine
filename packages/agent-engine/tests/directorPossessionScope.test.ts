import { describe, expect, it } from "vitest";
import {
  collectPossessedObjectIds,
  describeDirectorPossessionTargetAmbiguity,
  evaluateDirectorPossessionScope,
  fillDirectorAuthorCharacterTargets,
  findDirectorAuthorCharacterTargetGaps,
} from "../src/directorPossessionScope";
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
  const characters = [
    { id: "hero", agent_binding: { session_id: SESSION, profile_id: null, role_id: null, mode: "possess" } },
    { id: "extra", agent_binding: { session_id: "dsh-session-2", profile_id: null, role_id: null, mode: "possess" } },
    { id: "unbound" },
    { id: "profile-only", agent_binding: { session_id: null, profile_id: "profile-a", mode: "possess" } },
    {
      id: "session-and-profile",
      agent_binding: { session_id: "dsh-session-3", profile_id: "profile-a", mode: "possess" },
    },
  ];

  it("collects only characters possessed by the calling session", () => {
    expect(collectPossessedObjectIds(characters, { sessionId: SESSION })).toEqual(["hero"]);
    expect(collectPossessedObjectIds(characters, { sessionId: "dsh-session-2" })).toEqual(["extra"]);
    expect(collectPossessedObjectIds(characters, { sessionId: "" })).toEqual([]);
    expect(collectPossessedObjectIds(undefined, { sessionId: SESSION })).toEqual([]);
    expect(collectPossessedObjectIds([{ nonsense: true }], { sessionId: SESSION })).toEqual([]);
  });

  it("matches profile-only bindings against the request profile id", () => {
    expect(collectPossessedObjectIds(characters, { sessionId: "mcp-fresh", profileId: "profile-a" })).toEqual([
      "profile-only",
    ]);
    expect(collectPossessedObjectIds(characters, { sessionId: "mcp-fresh", profileId: "profile-b" })).toEqual([]);
    expect(collectPossessedObjectIds(characters, { sessionId: "mcp-fresh" })).toEqual([]);
    expect(collectPossessedObjectIds(characters, { sessionId: "mcp-fresh", profileId: null })).toEqual([]);
  });

  it("keeps session-named bindings owned by that exact session even when profiles match", () => {
    // "session-and-profile" names dsh-session-3, so a different session with the
    // same profile does not possess it, while the exact session still does.
    expect(collectPossessedObjectIds(characters, { sessionId: "dsh-session-3", profileId: "profile-a" })).toEqual([
      "profile-only",
      "session-and-profile",
    ]);
    expect(collectPossessedObjectIds(characters, { sessionId: SESSION, profileId: "profile-a" })).toEqual([
      "hero",
      "profile-only",
    ]);
  });
});

describe("evaluateDirectorPossessionScope", () => {
  it("keeps sessions without possessed characters unrestricted", () => {
    expect(evaluate({ op: "undo" }, [])).toEqual({ allowed: true });
    expect(evaluate({ op: "author", actions: [{ action: "delete_objects", object_ids: ["anything"] }] }, [])).toEqual({
      allowed: true,
    });
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
            {
              action: "set_character_pose_controls",
              object_id: "hero",
              controls: [{ control: "head.yaw", value: 20 }],
            },
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

  it("allows spatial actions that move possessed characters toward unpossessed references", () => {
    expect(
      evaluate(
        {
          op: "author",
          actions: [
            { action: "place_relative", object_id: "hero", anchor_id: "villain", relation: "front", orient: "target" },
            { action: "orient_toward", object_id: "hero", target_id: "villain" },
          ],
        },
        ["hero"],
      ),
    ).toEqual({ allowed: true });
    expect(
      evaluate(
        {
          op: "author",
          actions: [
            { action: "arrange_group", object_ids: ["hero", "sidekick"], layout: "line" },
            { action: "arrange_facing_pair", object_ids: ["hero", "sidekick"] },
          ],
        },
        ["hero", "sidekick"],
      ),
    ).toEqual({ allowed: true });
  });

  it("rejects spatial actions that would move unpossessed objects", () => {
    const moveOther = evaluate(
      {
        op: "author",
        actions: [{ action: "place_relative", object_id: "villain", anchor_id: "hero", relation: "front" }],
      },
      ["hero"],
    );
    expect(moveOther).toMatchObject({ allowed: false, error: expect.stringContaining('"villain"') });

    const orientOther = evaluate(
      { op: "author", actions: [{ action: "orient_toward", object_id: "villain", target_id: "hero" }] },
      ["hero"],
    );
    expect(orientOther).toMatchObject({ allowed: false, error: expect.stringContaining('"villain"') });

    const groupWithOutsider = evaluate(
      { op: "author", actions: [{ action: "arrange_group", object_ids: ["hero", "villain"], layout: "line" }] },
      ["hero"],
    );
    expect(groupWithOutsider).toMatchObject({ allowed: false, error: expect.stringContaining('"villain"') });
  });

  it("allows compose_blocking only when its characters are a subset of the possessed set", () => {
    const blocking = (characterIds: string[]) => ({
      op: "author",
      actions: [
        {
          action: "compose_blocking",
          characters: characterIds.map((id) => ({ id, name: id })),
          camera: { id: "cam_blocking", object_id: "cam_blocking_rig", name: "Blocking Cam" },
        },
      ],
    });
    expect(evaluate(blocking(["hero", "sidekick"]), ["hero", "sidekick"])).toEqual({ allowed: true });
    expect(evaluate(blocking(["hero", "villain"]), ["hero", "sidekick"])).toMatchObject({
      allowed: false,
      error: expect.stringContaining('"villain"'),
    });
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
    const deletion = evaluate({ op: "author", actions: [{ action: "delete_objects", object_ids: ["hero"] }] }, [
      "hero",
    ]);
    expect(deletion).toMatchObject({ allowed: false, error: expect.stringContaining('"delete_objects"') });

    // Duplication creates new, unpossessed objects; it stays stage-wide.
    const duplication = evaluate({ op: "author", actions: [{ action: "duplicate_objects", object_ids: ["hero"] }] }, [
      "hero",
    ]);
    expect(duplication).toMatchObject({ allowed: false, error: expect.stringContaining('"duplicate_objects"') });

    const startScene = evaluate({ op: "author", actions: [{ action: "start_scene" }] }, ["hero"]);
    expect(startScene).toMatchObject({ allowed: false, error: expect.stringContaining('"start_scene"') });

    const cameraAnimation = evaluate(
      {
        op: "author",
        actions: [{ action: "set_animation", target_type: "camera", target_id: "cam_1", animation: null }],
      },
      ["hero"],
    );
    expect(cameraAnimation).toMatchObject({ allowed: false, error: expect.stringContaining('"set_animation"') });
  });

  it("scopes player enter/set_actor/teleport/walk_to to an explicitly named possessed actor", () => {
    // Omitted actor_id would fall back to shared-tab state (nearest candidate
    // or the user's selection), so possession requires the explicit id.
    for (const action of ["enter", "set_actor", "teleport", "walk_to"] as const) {
      const omitted = evaluate(
        action === "teleport"
          ? { op: "player", action, position: [1, 0, 2] }
          : action === "walk_to"
            ? { op: "player", action, object_id: "marker" }
            : { op: "player", action },
        ["hero"],
      );
      expect(omitted).toMatchObject({ allowed: false, error: expect.stringContaining("actor_id") });

      const outside = evaluate(
        action === "teleport"
          ? { op: "player", action, actor_id: "villain", position: [1, 0, 2] }
          : action === "walk_to"
            ? { op: "player", action, actor_id: "villain", object_id: "marker" }
            : { op: "player", action, actor_id: "villain" },
        ["hero"],
      );
      expect(outside).toMatchObject({ allowed: false, error: expect.stringContaining('"villain"') });
    }

    expect(evaluate({ op: "player", action: "enter", actor_id: "hero" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "player", action: "set_actor", actor_id: "hero" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "player", action: "teleport", actor_id: "hero", position: [1, 0, 2] }, ["hero"])).toEqual({
      allowed: true,
    });
    expect(evaluate({ op: "player", action: "walk_to", actor_id: "hero", object_id: "marker" }, ["hero"])).toEqual({
      allowed: true,
    });
  });

  it("keeps the live-actor player verbs available to a possessed session", () => {
    expect(evaluate({ op: "player", action: "exit" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "player", action: "record_start" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "player", action: "record_stop" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "player", action: "interact", object_id: "door" }, ["hero"])).toEqual({ allowed: true });
    // Unpossessed sessions keep the whole player surface, including teleport
    // without an explicit actor (Stage may fall back to selection).
    expect(evaluate({ op: "player", action: "enter" }, [])).toEqual({ allowed: true });
    expect(evaluate({ op: "player", action: "teleport", position: [0, 0, 0] }, [])).toEqual({ allowed: true });
  });

  it("rejects pilot.record_waypoint under possession but keeps transient flight", () => {
    const waypoint = evaluate({ op: "pilot", action: "record_waypoint" }, ["hero"]);
    expect(waypoint).toMatchObject({ allowed: false, error: expect.stringContaining("pilot.record_waypoint") });
    if (!waypoint.allowed) expect(waypoint.error).toContain("camera keyframes");

    expect(evaluate({ op: "pilot", action: "start" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "pilot", action: "stop" }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "pilot", action: "set_view", position: [0, 1.6, 4] }, ["hero"])).toEqual({ allowed: true });
    expect(evaluate({ op: "pilot", action: "record_waypoint" }, [])).toEqual({ allowed: true });
  });

  it("rejects non-author mutations with a readable, actionable error", () => {
    const undo = evaluate({ op: "undo" }, ["hero"]);
    expect(undo).toMatchObject({ allowed: false, error: expect.stringContaining('"undo"') });
    if (!undo.allowed) expect(undo.error).toContain("unbind_character_agent");

    const patch = evaluate({ op: "patch", patches: [{ op: "replace", path: "/project/name", value: "Hijack" }] }, [
      "hero",
    ]);
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

describe("findDirectorAuthorCharacterTargetGaps", () => {
  it("finds omitted object targets on character-scoped author actions", () => {
    expect(
      findDirectorAuthorCharacterTargetGaps({
        op: "author",
        actions: [
          { action: "set_character_motion", clip_id: "walk" },
          { action: "place_relative", anchor_id: "villain", relation: "front" },
          { action: "batch_update_objects", patch: { visible: true } },
          { action: "set_animation", target_type: "object", animation: null },
        ],
      }),
    ).toEqual([
      { index: 0, action: "set_character_motion", field: "object_id" },
      { index: 1, action: "place_relative", field: "object_id" },
      { index: 2, action: "batch_update_objects", field: "object_ids" },
      { index: 3, action: "set_animation", field: "target_id" },
    ]);
  });

  it("reports no gaps for provided ids, non-fillable actions, and non-author operations", () => {
    expect(
      findDirectorAuthorCharacterTargetGaps({
        op: "author",
        actions: [
          { action: "set_character_motion", object_id: "hero", clip_id: "walk" },
          { action: "delete_objects" },
          { action: "arrange_group", layout: "line" },
          { action: "align_objects", axis: "x" },
          { action: "start_scene" },
          { action: "set_animation", target_type: "camera", animation: null },
        ],
      }),
    ).toEqual([]);
    expect(findDirectorAuthorCharacterTargetGaps({ op: "undo" })).toEqual([]);
    expect(findDirectorAuthorCharacterTargetGaps({ op: "author" })).toEqual([]);
    expect(findDirectorAuthorCharacterTargetGaps(null)).toEqual([]);
  });
});

describe("fillDirectorAuthorCharacterTargets", () => {
  it("fills every reported gap with the possessed character id without mutating the input", () => {
    const input = {
      op: "author",
      actions: [
        { action: "set_character_motion", clip_id: "walk" },
        { action: "orient_toward", target_id: "villain" },
        { action: "batch_update_objects", patch: { visible: true } },
        { action: "update_object", object_id: "prop-1", patch: { visible: false } },
      ],
    };
    const gaps = findDirectorAuthorCharacterTargetGaps(input);
    const filled = fillDirectorAuthorCharacterTargets(input, gaps, "hero") as {
      actions: Record<string, unknown>[];
    };
    expect(filled.actions[0]).toEqual({ action: "set_character_motion", clip_id: "walk", object_id: "hero" });
    expect(filled.actions[1]).toEqual({ action: "orient_toward", target_id: "villain", object_id: "hero" });
    expect(filled.actions[2]).toEqual({
      action: "batch_update_objects",
      patch: { visible: true },
      object_ids: ["hero"],
    });
    expect(filled.actions[3]).toEqual({ action: "update_object", object_id: "prop-1", patch: { visible: false } });
    expect(input.actions[0]).toEqual({ action: "set_character_motion", clip_id: "walk" });
    expect(parseDirectorWorkbenchInput(filled).success).toBe(true);
  });

  it("returns the input unchanged when there is nothing to fill", () => {
    const input = { op: "undo" };
    expect(fillDirectorAuthorCharacterTargets(input, [], "hero")).toBe(input);
  });
});

describe("describeDirectorPossessionTargetAmbiguity", () => {
  it("names the session, the possessed characters, and every omitted field", () => {
    const message = describeDirectorPossessionTargetAmbiguity({
      sessionId: SESSION,
      possessedObjectIds: ["hero", "sidekick"],
      gaps: [
        { index: 0, action: "set_character_motion", field: "object_id" },
        { index: 2, action: "batch_update_objects", field: "object_ids" },
      ],
    });
    expect(message).toContain(SESSION);
    expect(message).toContain('"hero"');
    expect(message).toContain('"sidekick"');
    expect(message).toContain('actions[0] "set_character_motion" omitted object_id');
    expect(message).toContain('actions[2] "batch_update_objects" omitted object_ids');
    expect(message).toContain("exactly one character");
  });
});
