import directorGameCapabilities from "./directorGameCapabilities.json";
import { describeDirectorGameTarget } from "./directorGameDescribe";
import type { DirectorGameEnvelope, DirectorGameOperation } from "./directorGameProtocol";
import { directorGameOperationSchema } from "./directorGameProtocol";
import {
  createGameSliceFromBrief,
  gameEvaluationReportSchema,
  gameSliceBindComplete,
  gameSliceIdSchema,
  gameSliceSchema,
  playerRole,
  playerUnboundIssue,
  type GameEvaluationReport,
  type GamePlaytestSample,
  type GamePlaytestTrace,
  type GameSlice,
  type GameSliceIssue,
  type GameSlicePlayabilityCheck,
  type GameSliceVerb,
} from "./gameSliceProtocol";
import { suggestedPlaytestScriptForSlice } from "./gamePlaytestFixtures";

/** In-memory slice table. Gateway persistence wraps this reducer. */
export type DirectorGameState = {
  slices: Map<string, GameSlice>;
};

export type DirectorGameMachineContext = {
  now: string;
  createId?: () => string;
  /**
   * Optional live-Stage playtest runner. When omitted, `playtest` accepts an
   * explicit `trace` (host-free) or returns `game_playtest_needs_stage`.
   */
  runPlaytest?: (input: {
    slice: GameSlice;
    operation: Extract<DirectorGameOperation, { op: "playtest" }>;
  }) => Promise<GamePlaytestTrace> | GamePlaytestTrace;
};

function rejection(
  code: string,
  error: string,
  extra?: { corrective_call?: unknown; result?: unknown },
): DirectorGameEnvelope {
  return { success: false, code, error, ...extra };
}

function ok(result: unknown): DirectorGameEnvelope {
  return { success: true, result };
}

function requireSlice(state: DirectorGameState, sliceId: string): GameSlice | DirectorGameEnvelope {
  const slice = state.slices.get(sliceId);
  if (!slice) {
    return rejection("game_slice_not_found", `No game slice "${sliceId}". Call {"op":"plan","brief":{...}} first.`, {
      corrective_call: { op: "plan", brief: { requirement: "<game requirement>", genre: "exploration" } },
    });
  }
  return slice;
}

function put(state: DirectorGameState, slice: GameSlice): GameSlice {
  const parsed = gameSliceSchema.parse(slice);
  state.slices.set(parsed.id, parsed);
  return parsed;
}

function planarSpeed(sample: GamePlaytestSample): number {
  const velocity = sample.velocity;
  if (!velocity) return 0;
  return Math.hypot(velocity[0], velocity[2]);
}

function headingDeltaRad(yaw: number, vx: number, vz: number): number {
  if (Math.hypot(vx, vz) < 0.05) return 0;
  const moveYaw = Math.atan2(vx, vz);
  let delta = moveYaw - yaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

function sampleVerb(sample: GamePlaytestSample, fallback?: GameSliceVerb): GameSliceVerb | undefined {
  return sample.verb ?? fallback;
}

/**
 * Score a recorded playtest tape against the slice acceptance checks.
 * This is the structured replacement for GameFactory's "watch a video" table:
 * each check is a boolean with a typed issue and a corrective call.
 */
export function evaluateGamePlaytest(slice: GameSlice, trace: GamePlaytestTrace): GameEvaluationReport {
  const issues: GameSliceIssue[] = [];
  const verbs = new Set<GameSliceVerb>(trace.verbs_exercised);
  for (const sample of trace.samples) {
    const verb = sampleVerb(sample);
    if (verb) verbs.add(verb);
  }

  const player = playerRole(slice);
  if (!player?.object_id) issues.push(playerUnboundIssue(slice));

  let fellThrough = false;
  let facingMismatch = false;
  let cameraClip = false;
  let stuck = false;
  for (const sample of trace.samples) {
    if (!sample.on_ground && !sample.flying) {
      fellThrough = true;
      issues.push({
        code: "fell_through_floor",
        severity: "error",
        check: "on_ground",
        message: `Player left the ground at frame ${sample.frame} without flying.`,
        sample_frame: sample.frame,
        object_id: player?.object_id,
        corrective_call: {
          op: "bind",
          slice_id: slice.id,
          bindings: [{ role_id: "spawn", object_id: "<grounded spawn marker>" }],
        },
      });
      break;
    }
  }
  for (const sample of trace.samples) {
    const velocity = sample.velocity;
    if (!velocity) continue;
    if (headingDeltaRad(sample.yaw, velocity[0], velocity[2]) > (25 * Math.PI) / 180 && planarSpeed(sample) > 0.4) {
      facingMismatch = true;
      issues.push({
        code: "facing_mismatch",
        severity: "error",
        check: "facing_matches_move",
        message: `Movement heading disagrees with yaw at frame ${sample.frame}. Fix asset forward axis, not gameplay compensation.`,
        sample_frame: sample.frame,
        object_id: player?.object_id,
      });
      break;
    }
  }
  for (const sample of trace.samples) {
    if (sample.camera_clip) {
      cameraClip = true;
      issues.push({
        code: "camera_clip",
        severity: "warning",
        check: "no_camera_clip",
        message: `Camera clipped the environment at frame ${sample.frame}.`,
        sample_frame: sample.frame,
      });
      break;
    }
  }
  let consecutiveSlow = 0;
  for (const sample of trace.samples) {
    const moving =
      planarSpeed(sample) > 0.15 ||
      sample.verb === "jump" ||
      sample.verb === "interact" ||
      sample.verb === "fire" ||
      sample.verb === "attack" ||
      sample.verb === "reload" ||
      sample.verb === "enter_vehicle" ||
      sample.verb === "exit_vehicle" ||
      sample.verb === "dash";
    consecutiveSlow = moving ? 0 : consecutiveSlow + 1;
    if (sample.stuck || consecutiveSlow > Math.max(12, Math.round(1.5 / trace.dt))) {
      stuck = true;
      issues.push({
        code: "stuck",
        severity: "error",
        check: "no_stuck",
        message: `Player made no progress near frame ${sample.frame}.`,
        sample_frame: sample.frame,
        object_id: player?.object_id,
      });
      break;
    }
  }

  const missingVerbs = slice.acceptance.operations.filter((verb) => !verbs.has(verb));
  for (const verb of missingVerbs) {
    issues.push({
      code: "verb_not_exercised",
      severity: "error",
      check: "verb_exercised",
      message: `Acceptance requires verb "${verb}" but the playtest tape never exercised it.`,
      corrective_call: {
        op: "playtest",
        slice_id: slice.id,
        script: {
          steps: [{ frames: 30, input: verbInput(verb), expect: { verb } }],
        },
      },
    });
  }

  const hudUnbound = slice.hud.widgets.some((widget) => widget.role_id && !slice.roles.some((role) => role.id === widget.role_id && role.object_id));
  if (hudUnbound) {
    issues.push({
      code: "hud_unbound",
      severity: "warning",
      check: "hud_bound",
      message: "One or more HUD widgets reference a role that has no object_id.",
      corrective_call: { op: "bind", slice_id: slice.id, bindings: [{ role_id: "<hud widget role_id>", object_id: "<id>" }] },
    });
  }

  const checkPassed: Record<GameSlicePlayabilityCheck, boolean> = {
    on_ground: !fellThrough,
    facing_matches_move: !facingMismatch,
    no_camera_clip: !cameraClip,
    verb_exercised: missingVerbs.length === 0,
    interaction_in_range: !issues.some((issue) => issue.code === "interaction_out_of_range"),
    hud_bound: !hudUnbound,
    objective_reachable: !issues.some((issue) => issue.code === "objective_unreachable"),
    no_stuck: !stuck,
  };

  const requested = slice.acceptance.playability_checks;
  const blocking = issues.filter((issue) => issue.severity === "error");
  return gameEvaluationReportSchema.parse({
    contract: "director-game-evaluation-v1",
    slice_id: slice.id,
    playable: blocking.length === 0,
    verbs_exercised: [...verbs],
    checks: requested.map((check) => ({ check, passed: checkPassed[check] })),
    issues,
    notes:
      blocking.length === 0
        ? ["Playtest tape passed every error-severity check. Visual style still needs a Stage capture image block."]
        : [],
  });
}

function verbInput(verb: GameSliceVerb): Record<string, boolean> {
  switch (verb) {
    case "move":
      return { forward: true };
    case "jump":
      return { jump: true };
    case "sprint":
      return { forward: true, sprint: true };
    case "dash":
      return { dash: true };
    case "crouch":
      return { crouch: true };
    case "interact":
      return { interact: true };
    case "attack":
    case "fire":
      return { fire: true };
    case "enter_vehicle":
      return { enter_vehicle: true };
    case "exit_vehicle":
      return { exit_vehicle: true };
    case "pause":
      return { pause: true };
    case "look":
      return { look_right: true };
    case "reload":
      return { fire: true };
  }
}

function defaultId(createId: (() => string) | undefined): string {
  const suffix = createId?.() ?? `game-${crypto.randomUUID()}`;
  if (gameSliceIdSchema.safeParse(suffix).success) return suffix;
  return `game-${suffix.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 48) || crypto.randomUUID()}`;
}

function applyBind(slice: GameSlice, operation: Extract<DirectorGameOperation, { op: "bind" }>, now: string): GameSlice {
  const roles = slice.roles.map((role) => {
    const patch = operation.bindings.find((binding) => binding.role_id === role.id);
    if (!patch) return role;
    return {
      ...role,
      object_id: patch.object_id ?? role.object_id,
      asset_id: patch.asset_id ?? role.asset_id,
    };
  });
  const unknown = operation.bindings.filter((binding) => !slice.roles.some((role) => role.id === binding.role_id));
  const assets = [...slice.assets];
  for (const binding of operation.bindings) {
    if (!binding.object_id && !binding.asset_id) continue;
    const index = assets.findIndex((asset) => asset.role_id === binding.role_id);
    const next = {
      role_id: binding.role_id,
      source: binding.source ?? "project",
      asset_id: binding.asset_id,
      object_id: binding.object_id,
      license: binding.license,
    };
    if (index >= 0) assets[index] = { ...assets[index], ...next };
    else assets.push(next);
  }
  const next: GameSlice = {
    ...slice,
    roles,
    assets,
    project_revision: operation.project_revision ?? slice.project_revision,
    status: gameSliceBindComplete({ ...slice, roles }) ? "bound" : slice.status === "draft" ? "draft" : slice.status,
    updated_at: now,
    notes: unknown.length
      ? [
          ...slice.notes,
          `Ignored unknown role_id(s): ${unknown.map((binding) => binding.role_id).join(", ")}.`,
        ].slice(-32)
      : slice.notes,
  };
  return gameSliceSchema.parse(next);
}

/**
 * Host-free `director_game` reducer. Persistence, live Stage playtest, and
 * `director_dcc` export are injected by the Gateway; this function is the
 * single source of slice transitions.
 */
export async function executeDirectorGame(
  state: DirectorGameState,
  raw: unknown,
  context: DirectorGameMachineContext,
): Promise<DirectorGameEnvelope> {
  const parsed = directorGameOperationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "input";
    return rejection(
      "invalid_request",
      `Invalid director_game input at ${path}: ${issue?.message ?? "invalid value"}. Use {"op":"describe","target":"<op>"}.`,
      { corrective_call: { op: "describe", target: "plan" } },
    );
  }
  const operation = parsed.data;
  switch (operation.op) {
    case "capabilities":
      return ok(directorGameCapabilities);
    case "describe": {
      const described = describeDirectorGameTarget(operation.target);
      if ("error" in described) {
        return rejection("unknown_describe_target", described.error, {
          corrective_call: { op: "capabilities" },
        });
      }
      return ok(described);
    }
    case "plan": {
      const id = operation.slice_id ?? defaultId(context.createId);
      const existing = state.slices.get(id);
      if (existing && !operation.slice_id) {
        return rejection("game_slice_id_collision", `Generated slice id ${id} already exists. Retry plan.`, {
          corrective_call: { op: "plan", brief: operation.brief, slice_id: `game-${crypto.randomUUID()}` },
        });
      }
      const slice = createGameSliceFromBrief({
        id,
        brief: operation.brief,
        now: context.now,
        title: operation.title ?? existing?.title,
      });
      if (existing) {
        slice.created_at = existing.created_at;
        slice.roles = existing.roles;
        slice.assets = existing.assets;
        slice.project_revision = existing.project_revision;
        slice.status = gameSliceBindComplete(slice) ? "bound" : "draft";
      }
      return ok({ slice: put(state, slice), created: !existing, notes: slice.notes });
    }
    case "observe": {
      if (operation.slice_id) {
        const slice = requireSlice(state, operation.slice_id);
        if (!("id" in slice)) return slice;
        return ok({
          slice,
          bind_complete: gameSliceBindComplete(slice),
          player: playerRole(slice) ?? null,
          suggested_playtest_script: suggestedPlaytestScriptForSlice(slice),
        });
      }
      const limit = operation.limit ?? 20;
      const slices = [...state.slices.values()]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, limit)
        .map((slice) => ({
          id: slice.id,
          title: slice.title,
          status: slice.status,
          genre: slice.brief.genre,
          engine_target: slice.brief.engine_target,
          updated_at: slice.updated_at,
        }));
      return ok({ counts: { slices: state.slices.size, returned: slices.length }, slices });
    }
    case "bind": {
      const slice = requireSlice(state, operation.slice_id);
      if (!("id" in slice)) return slice;
      const next = put(state, applyBind(slice, operation, context.now));
      return ok({
        slice: next,
        bind_complete: gameSliceBindComplete(next),
        notes: gameSliceBindComplete(next)
          ? [
              "Every role has an object_id. Next: playtest with a scripted input tape (see observe.suggested_playtest_script).",
            ]
          : ["Some roles remain unbound. Playtest will reject until the player role has an object_id."],
        suggested_playtest_script: gameSliceBindComplete(next) ? suggestedPlaytestScriptForSlice(next) : undefined,
      });
    }
    case "author_loop": {
      const slice = requireSlice(state, operation.slice_id);
      if (!("id" in slice)) return slice;
      const next = put(
        state,
        gameSliceSchema.parse({
          ...slice,
          loop: { ...slice.loop, ...operation.loop, verbs: operation.loop.verbs ?? slice.loop.verbs },
          controls: operation.controls ? { ...slice.controls, ...operation.controls } : slice.controls,
          updated_at: context.now,
        }),
      );
      return ok({ slice: next });
    }
    case "author_hud": {
      const slice = requireSlice(state, operation.slice_id);
      if (!("id" in slice)) return slice;
      const next = put(state, { ...slice, hud: operation.hud, updated_at: context.now });
      return ok({ slice: next });
    }
    case "playtest": {
      const slice = requireSlice(state, operation.slice_id);
      if (!("id" in slice)) return slice;
      if (!playerRole(slice)?.object_id) {
        const issue = playerUnboundIssue(slice);
        return rejection("game_player_unbound", issue.message, { corrective_call: issue.corrective_call, result: { issues: [issue] } });
      }
      const trace =
        operation.trace ??
        (context.runPlaytest ? await context.runPlaytest({ slice, operation }) : undefined);
      if (!trace) {
        return rejection(
          "game_playtest_needs_stage",
          `Playtest of ${slice.id} needs a live Stage player session (or a host-free trace). Drive the bound actor with director_workbench {"op":"player","action":"enter"} then retry with a script, or pass trace for a disconnected evaluation.`,
          {
            corrective_call: {
              op: "playtest",
              slice_id: slice.id,
              script: operation.script,
              trace: {
                contract: "director-game-playtest-trace-v1",
                slice_id: slice.id,
                dt: operation.script.dt,
                samples: [
                  {
                    frame: 0,
                    time_s: 0,
                    position: [0, 0, 0],
                    yaw: 0,
                    on_ground: true,
                  },
                ],
              },
            },
          },
        );
      }
      const report = evaluateGamePlaytest(slice, trace);
      const next = put(state, {
        ...slice,
        status: report.playable ? "playable" : "playtested",
        last_evaluation: report,
        last_playtest_id: `playtest-${trace.samples.length}-${trace.samples[0]?.frame ?? 0}`,
        updated_at: context.now,
      });
      return ok({ slice: next, trace, evaluation: report });
    }
    case "evaluate": {
      const slice = requireSlice(state, operation.slice_id);
      if (!("id" in slice)) return slice;
      const trace = operation.trace;
      if (!trace && !slice.last_evaluation) {
        return rejection(
          "game_evaluation_missing_trace",
          `Slice ${slice.id} has no playtest trace to evaluate. Call playtest first.`,
          { corrective_call: { op: "playtest", slice_id: slice.id, script: { steps: [{ frames: 30, input: { forward: true } }] } } },
        );
      }
      const report = trace ? evaluateGamePlaytest(slice, trace) : slice.last_evaluation;
      if (!report) {
        return rejection("game_evaluation_missing_trace", `Slice ${slice.id} has no evaluation.`);
      }
      const next = put(state, {
        ...slice,
        last_evaluation: report,
        status: report.playable ? "playable" : slice.status === "draft" ? "draft" : "playtested",
        updated_at: context.now,
      });
      return ok({ slice: next, evaluation: report });
    }
    case "export_slice": {
      const slice = requireSlice(state, operation.slice_id);
      if (!("id" in slice)) return slice;
      if (slice.status !== "playable") {
        return rejection(
          "game_export_not_playable",
          `Slice ${slice.id} status is "${slice.status}". export_slice requires a playable Stage receipt. A compile is not evidence.`,
          {
            corrective_call: {
              op: "playtest",
              slice_id: slice.id,
              script: { steps: [{ frames: 45, input: { forward: true } }] },
            },
          },
        );
      }
      return rejection(
        "game_export_via_dcc",
        `Engine export is director_dcc send_to_engine, not generated engine source. Discover readiness first, then send the bound Stage scene.`,
        {
          corrective_call: { op: "discover" },
          result: {
            slice_id: slice.id,
            provider: operation.provider,
            next: [
              { tool: "director_dcc", input: { op: "discover" } },
              { tool: "director_dcc", input: { op: "status", provider: operation.provider } },
              {
                tool: "director_dcc",
                input: { op: "send_to_engine", provider: operation.provider, ...(operation.formats ? { formats: operation.formats } : {}) },
              },
            ],
          },
        },
      );
    }
  }
}

export function createDirectorGameState(slices: Iterable<GameSlice> = []): DirectorGameState {
  const map = new Map<string, GameSlice>();
  for (const slice of slices) map.set(slice.id, gameSliceSchema.parse(slice));
  return { slices: map };
}
