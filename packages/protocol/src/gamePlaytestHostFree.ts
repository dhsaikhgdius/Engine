/**
 * Host-free kinematic playtest tape runner for `director_game`.
 *
 * Emits a `director-game-playtest-trace-v1` that `evaluateGamePlaytest` can
 * score without a browser tab, Three.js, or Rapier. The live Stage motor
 * remains the preferred driver when a workbench tab is connected; this
 * runner is the Gateway default so agents can close plan → bind → playtest
 * → evaluate over HTTP/MCP/CLI alone.
 *
 * Motion is intentionally simple (flat infinite ground, yaw-relative
 * locomotion). It matches evaluator contracts (`on_ground`, facing, stuck,
 * verbs) rather than duplicating the full frontend locomotion stack.
 */

import {
  gamePlaytestScriptSchema,
  gamePlaytestTraceSchema,
  playerRole,
  type GamePlaytestInput,
  type GamePlaytestSample,
  type GamePlaytestScript,
  type GamePlaytestScriptInput,
  type GamePlaytestTrace,
  type GameSlice,
  type GameSliceVerb,
} from "./gameSliceProtocol";

/** Planar walk speed (m/s) for a held forward input. */
export const HOST_FREE_WALK_SPEED_MPS = 1.2;

/** Planar sprint speed (m/s). */
export const HOST_FREE_SPRINT_SPEED_MPS = 2.4;

/** Planar dash burst speed (m/s). */
export const HOST_FREE_DASH_SPEED_MPS = 4.0;

/** Keyboard look yaw rate (rad/s), aligned with Stage player look. */
export const HOST_FREE_LOOK_YAW_RAD_S = 2.2;

/** Keyboard look pitch rate (rad/s). */
export const HOST_FREE_LOOK_PITCH_RAD_S = 1.6;

/** Pitch clamp matching the live PlayerController. */
const HOST_FREE_MAX_PITCH_RAD = 1.2;

/** Held move below this planar speed accrues stuck time. */
const HOST_FREE_STUCK_SPEED_MPS = 0.12;

/** Stuck hold threshold in seconds. */
const HOST_FREE_STUCK_HOLD_S = 0.5;

/** Trace sample budget (matches `gamePlaytestTraceSchema`). */
const HOST_FREE_TRACE_SAMPLE_BUDGET = 1_048_576;

const SESSION_VERBS = [
  "enter_vehicle",
  "exit_vehicle",
  "interact",
  "fire",
  "pause",
] as const satisfies readonly GameSliceVerb[];

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Session verb held by a tape input, or undefined for pure locomotion. */
export function resolveHostFreeSessionVerb(input: GamePlaytestInput): GameSliceVerb | undefined {
  for (const verb of SESSION_VERBS) {
    if (input[verb]) return verb;
  }
  return undefined;
}

function moveAxes(input: GamePlaytestInput): { forward: number; right: number } {
  let forward = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
  let right = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (input.move_forward_axis !== undefined) forward = input.move_forward_axis;
  if (input.move_right_axis !== undefined) right = input.move_right_axis;
  const length = Math.hypot(forward, right);
  if (length > 1) {
    forward /= length;
    right /= length;
  }
  return { forward, right };
}

function planarSpeedForInput(input: GamePlaytestInput, moveHeld: boolean): number {
  if (!moveHeld) return 0;
  if (input.dash) return HOST_FREE_DASH_SPEED_MPS;
  if (input.sprint) return HOST_FREE_SPRINT_SPEED_MPS;
  if (input.crouch) return HOST_FREE_WALK_SPEED_MPS * 0.45;
  return HOST_FREE_WALK_SPEED_MPS;
}

function locomotionVerb(
  input: GamePlaytestInput,
  moveHeld: boolean,
  jumpHeld: boolean,
): GameSliceVerb | undefined {
  if (jumpHeld) return "jump";
  if (input.dash && moveHeld) return "dash";
  if (input.crouch) return "crouch";
  if (input.sprint && moveHeld) return "sprint";
  if (moveHeld) return "move";
  if (input.look_left || input.look_right || input.look_up || input.look_down) return "look";
  return undefined;
}

export type RunHostFreeGamePlaytestInput = {
  /** Slice being playtested (id + project revision stamp the trace). */
  slice: Pick<GameSlice, "id" | "project_revision" | "roles">;
  /** Raw or parsed tape. */
  script: GamePlaytestScriptInput | GamePlaytestScript;
  /** Optional spawn pose; defaults to origin facing +Z on the ground plane. */
  initial?: {
    position?: [number, number, number];
    yaw?: number;
    pitch?: number;
  };
};

/**
 * Wall-clock-ish timeout helper shared with live Stage playtest dispatch.
 * Triples simulated duration and adds grace for Player Mode entry.
 */
export function hostFreePlaytestTimeoutMs(script: GamePlaytestScriptInput | GamePlaytestScript): number {
  const parsed = gamePlaytestScriptSchema.parse(script);
  const frames = parsed.steps.reduce((total, step) => total + step.frames, 0);
  return Math.ceil(frames * parsed.dt * 1000 * 3) + 8_000;
}

/**
 * Replay a scripted input tape on a flat infinite ground and return a
 * scored-ready playtest trace.
 */
export function runHostFreeGamePlaytest(input: RunHostFreeGamePlaytestInput): GamePlaytestTrace {
  const script = gamePlaytestScriptSchema.parse(input.script);
  const totalFrames = script.steps.reduce((total, step) => total + step.frames, 0);
  if (totalFrames > HOST_FREE_TRACE_SAMPLE_BUDGET) {
    throw new Error(
      `Playtest script would emit ${totalFrames} samples; the trace budget is ${HOST_FREE_TRACE_SAMPLE_BUDGET}. Split the tape.`,
    );
  }

  const objectiveId = input.slice.roles.find((role) => role.kind === "objective")?.object_id;

  let position: [number, number, number] = input.initial?.position
    ? [...input.initial.position]
    : [0, 0, 0];
  let yaw = input.initial?.yaw ?? 0;
  let pitch = input.initial?.pitch ?? 0;
  let stuckElapsedS = 0;
  let jumpCooldownFrames = 0;

  const samples: GamePlaytestSample[] = [];
  const verbs = new Set<GameSliceVerb>();
  let frame = 0;

  for (const step of script.steps) {
    const sessionVerb = resolveHostFreeSessionVerb(step.input);
    for (let i = 0; i < step.frames; i += 1) {
      const { forward, right } = moveAxes(step.input);
      const moveHeld = Math.hypot(forward, right) > 0.0001;

      if (step.input.look_left) yaw = wrapAngle(yaw + HOST_FREE_LOOK_YAW_RAD_S * script.dt);
      if (step.input.look_right) yaw = wrapAngle(yaw - HOST_FREE_LOOK_YAW_RAD_S * script.dt);
      if (step.input.look_up) pitch = clamp(pitch + HOST_FREE_LOOK_PITCH_RAD_S * script.dt, -HOST_FREE_MAX_PITCH_RAD, HOST_FREE_MAX_PITCH_RAD);
      if (step.input.look_down) pitch = clamp(pitch - HOST_FREE_LOOK_PITCH_RAD_S * script.dt, -HOST_FREE_MAX_PITCH_RAD, HOST_FREE_MAX_PITCH_RAD);

      const speed = planarSpeedForInput(step.input, moveHeld);
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      // +forward along facing (+Z at yaw 0); +right strafes.
      const vx = (forward * sin + right * cos) * speed;
      const vz = (forward * cos - right * sin) * speed;
      position = [position[0] + vx * script.dt, 0, position[2] + vz * script.dt];

      const jumpHeld = step.input.jump || jumpCooldownFrames > 0;
      if (step.input.jump && jumpCooldownFrames === 0) jumpCooldownFrames = Math.max(1, Math.round(0.35 / script.dt));
      if (jumpCooldownFrames > 0) jumpCooldownFrames -= 1;

      const planar = Math.hypot(vx, vz);
      stuckElapsedS = moveHeld && planar < HOST_FREE_STUCK_SPEED_MPS ? stuckElapsedS + script.dt : 0;
      const stuck = stuckElapsedS > HOST_FREE_STUCK_HOLD_S;

      const verb = sessionVerb ?? locomotionVerb(step.input, moveHeld, jumpHeld);
      if (verb) verbs.add(verb);

      const sample: GamePlaytestSample = {
        frame,
        time_s: frame * script.dt,
        position: [position[0], position[1], position[2]],
        yaw,
        pitch,
        velocity: [vx, jumpHeld ? 2.5 : 0, vz],
        // Recoverable jump arcs keep on_ground true — matches evaluateGamePlaytest /
        // live trace recorder semantics (fell_through only for genuine falls).
        on_ground: true,
        flying: false,
        ...(verb ? { verb } : {}),
        ...(sessionVerb === "interact" && objectiveId ? { interaction_object_id: objectiveId } : {}),
        camera_clip: false,
        stuck,
      };
      samples.push(sample);
      frame += 1;
    }
  }

  if (samples.length === 0) {
    throw new Error("Host-free playtest produced no samples.");
  }

  return gamePlaytestTraceSchema.parse({
    contract: "director-game-playtest-trace-v1",
    slice_id: input.slice.id,
    ...(input.slice.project_revision ? { project_revision: input.slice.project_revision } : {}),
    dt: script.dt,
    samples,
    verbs_exercised: [...verbs],
  });
}

/**
 * Convenience wrapper matching `DirectorGameMachineContext["runPlaytest"]`.
 * Ignores live session state; always runs the kinematic tape.
 */
export function createHostFreePlaytestRunner(): (input: {
  slice: GameSlice;
  operation: { script: GamePlaytestScriptInput | GamePlaytestScript };
}) => GamePlaytestTrace {
  return ({ slice, operation }) => {
    // Bound check is owned by the machine before the runner is invoked.
    void playerRole(slice);
    return runHostFreeGamePlaytest({ slice, script: operation.script });
  };
}
