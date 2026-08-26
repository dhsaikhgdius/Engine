import {
  gamePlaytestScriptSchema,
  gamePlaytestTraceSchema,
  type GamePlaytestInput,
  type GamePlaytestSample,
  type GamePlaytestScriptInput,
  type GamePlaytestTrace,
  type GameSliceVerb,
} from "@director/protocol/game-slice";
import { clamp } from "@director/protocol/primitives";
import {
  PLAYER_KEYBOARD_LOOK_PITCH_RAD_S,
  PLAYER_KEYBOARD_LOOK_YAW_RAD_S,
  type PlayerVehicleDriveInput,
} from "./playerInput";
import {
  createPlayerLocomotionState,
  getPlayerMoveAxes,
  stepPlayerLocomotion,
  type PlayerInput,
  type PlayerLocomotionState,
  type PlayerObstacle,
  type PlayerPosition,
} from "./playerLocomotion";

/**
 * Host-free playtest replay: runs a `director_game` scripted input tape
 * through the pure Stage locomotion model and emits a
 * `director-game-playtest-trace-v1` document that `evaluateGamePlaytest`
 * can score without a browser tab, Three.js, or Rapier.
 *
 * The same input mapping and trace recorder also drive the live Stage
 * session (`gamePlaytestSession.ts`), so a tape means the same thing in
 * vitest and in the running viewport.
 */

/** Planar speed below which a held move input counts as making no progress. */
export const GAME_PLAYTEST_STUCK_SPEED_MPS = 0.12;

/** How long a held move input may stay at ~zero planar speed before `stuck`. */
export const GAME_PLAYTEST_STUCK_HOLD_S = 0.5;

/**
 * Longest recoverable fall. A ground jump arc completes in ~0.7 s, so a
 * non-flying character still falling after this long has left every walkable
 * surface for good and the sample reports `on_ground: false`.
 */
export const GAME_PLAYTEST_FALL_LIMIT_S = 0.9;

/** How far below the lowest reachable support a fall counts as fallen through. */
const GAME_PLAYTEST_FALL_BELOW_SUPPORT_M = 0.25;

/** Mirrors PlayerController's live look-pitch clamp. */
const GAME_PLAYTEST_MAX_PITCH_RAD = 1.2;

/** `gamePlaytestTraceSchema` caps samples; reject oversized tapes up front. */
const GAME_PLAYTEST_TRACE_SAMPLE_BUDGET = 1_048_576;

/** Default slice id used when a tape is replayed outside a stored slice. */
export const GAME_PLAYTEST_REPLAY_SLICE_ID = "game-playtest-replay";

/**
 * Session verbs are Player Mode actions, not locomotion inputs. The live
 * driver dispatches the matching player action on the first frame of the
 * step; both drivers record the verb on every sample of the held step.
 */
const GAME_PLAYTEST_SESSION_VERBS = [
  "enter_vehicle",
  "exit_vehicle",
  "interact",
  "fire",
  "pause",
] as const satisfies readonly GameSliceVerb[];

/** The session verb held by a tape input, or undefined for pure locomotion. */
export function resolveGamePlaytestSessionVerb(input: GamePlaytestInput): GameSliceVerb | undefined {
  for (const verb of GAME_PLAYTEST_SESSION_VERBS) {
    if (input[verb]) return verb;
  }
  return undefined;
}

/**
 * Maps one held tape input onto the Stage `PlayerInput` contract. Session
 * verbs (interact/fire/enter_vehicle/exit_vehicle/pause) are intentionally
 * not mapped: they are dispatched as player-session actions and recorded on
 * the sample `verb` field instead.
 *
 * @param input - The held tape input for the current step.
 * @param previousJumpHeld - Whether the previous tape frame held jump, so a
 *  fresh hold latches `jumpPressed` exactly like a physical key edge.
 */
export function mapGamePlaytestInputToPlayerInput(input: GamePlaytestInput, previousJumpHeld = false): PlayerInput {
  return {
    forward: input.forward,
    backward: input.backward,
    left: input.left,
    right: input.right,
    sprint: input.sprint,
    jump: input.jump,
    jumpPressed: input.jump && !previousJumpHeld,
    descend: input.descend,
    dash: input.dash,
    crouch: input.crouch,
    lookLeft: input.look_left,
    lookRight: input.look_right,
    lookUp: input.look_up,
    lookDown: input.look_down,
    moveForwardAxis: input.move_forward_axis,
    moveRightAxis: input.move_right_axis,
  };
}

/**
 * Maps a tape input onto the vehicle drive contract for steps performed while
 * seated. Space (jump) doubles as the handbrake, matching the live keyboard.
 */
export function mapGamePlaytestInputToVehicleDriveInput(input: GamePlaytestInput): PlayerVehicleDriveInput {
  return {
    forward: input.forward || (input.move_forward_axis ?? 0) > 0.2,
    backward: input.backward || (input.move_forward_axis ?? 0) < -0.2,
    left: input.left || (input.move_right_axis ?? 0) < -0.2,
    right: input.right || (input.move_right_axis ?? 0) > 0.2,
    handbrake: input.jump,
  };
}

/** Total simulation ticks a parsed script will run. */
export function countGamePlaytestScriptFrames(script: { steps: ReadonlyArray<{ frames: number }> }): number {
  return script.steps.reduce((total, step) => total + step.frames, 0);
}

/** Locomotion fields the recorder samples once per simulation tick. */
export type GamePlaytestSampledState = {
  position: PlayerPosition;
  /** Omitted velocity is derived from the previous sample's position. */
  velocity?: PlayerPosition;
  yaw: number;
  pitch?: number;
  onGround: boolean;
  flying: boolean;
};

export type GamePlaytestRecordInput = {
  /** The held tape input that produced this tick. */
  input: GamePlaytestInput;
  /** The mapped `PlayerInput` (used for move-hold stuck detection). */
  playerInput: PlayerInput;
  state: GamePlaytestSampledState;
  /** Session verb held by this step, recorded on the sample verb field. */
  sessionVerb?: GameSliceVerb;
  /** Live camera occlusion flag from the follow rig, when available. */
  cameraClip?: boolean;
  /** Nearest in-range interaction candidate id, when available. */
  interactionObjectId?: string;
  /**
   * True when the foot is below every walkable support at its planar
   * position, so the airborne arc can never land (host-free replay only).
   */
  belowSupport?: boolean;
  /** Seated in a vehicle: the seat is the support, so no fall accrues. */
  seated?: boolean;
};

export type GamePlaytestTraceRecorder = {
  /** Appends one sample and returns it (already schema-shaped). */
  record: (tick: GamePlaytestRecordInput) => GamePlaytestSample;
  /** Parses and returns the finished trace document. */
  finish: () => GamePlaytestTrace;
  /** Samples recorded so far. */
  frameCount: () => number;
};

/**
 * Shared trace recorder for the host-free replay and the live Stage driver.
 *
 * Sample semantics match `evaluateGamePlaytest`: `on_ground` is the
 * playability contract "supported, or in a recoverable airborne arc" — a
 * legitimate jump keeps `on_ground: true` and only a genuine fall-through
 * (below every support, or falling longer than any jump arc) reports
 * `on_ground: false` with `flying: false`. Yaw and velocity are always the
 * raw locomotion values so the evaluator can flag `facing_mismatch` honestly.
 */
export function createGamePlaytestTraceRecorder(options: {
  sliceId: string;
  dt: number;
  projectRevision?: string;
}): GamePlaytestTraceRecorder {
  const samples: GamePlaytestSample[] = [];
  const verbs = new Set<GameSliceVerb>();
  let frame = 0;
  let stuckElapsedS = 0;
  let fallElapsedS = 0;
  let airborneFromJump = false;
  let previousOnGround = true;
  let previousPosition: PlayerPosition | null = null;

  function deriveVelocity(position: PlayerPosition): PlayerPosition {
    if (!previousPosition) return [0, 0, 0];
    return [
      (position[0] - previousPosition[0]) / options.dt,
      (position[1] - previousPosition[1]) / options.dt,
      (position[2] - previousPosition[2]) / options.dt,
    ];
  }

  return {
    record(tick) {
      const { state } = tick;
      const velocity = tick.state.velocity ?? deriveVelocity(state.position);
      const planarSpeed = Math.hypot(velocity[0], velocity[2]);
      const [moveForward, moveRight] = getPlayerMoveAxes(tick.playerInput);
      const moveHeld = Math.hypot(moveForward, moveRight) > 0.0001;

      // Stuck: a held move input that keeps planar speed at ~zero. The timer
      // survives across steps so alternating inputs cannot mask a pinned actor.
      stuckElapsedS = moveHeld && planarSpeed < GAME_PLAYTEST_STUCK_SPEED_MPS ? stuckElapsedS + options.dt : 0;
      const stuck = stuckElapsedS > GAME_PLAYTEST_STUCK_HOLD_S;

      // Fall-through: only airborne, non-flying, unsupported motion counts.
      const supported = state.onGround || state.flying || tick.seated === true;
      if (supported) {
        fallElapsedS = 0;
      } else if (velocity[1] < 0) {
        fallElapsedS += options.dt;
      }
      const fellThrough =
        !supported && (tick.belowSupport === true || fallElapsedS > GAME_PLAYTEST_FALL_LIMIT_S);

      // A takeoff (grounded -> ascending) marks the recoverable jump arc that
      // keeps emitting the jump verb until the character lands again.
      if (previousOnGround && !state.onGround && !state.flying && velocity[1] > 0.5) {
        airborneFromJump = true;
      }
      if (state.onGround || state.flying) airborneFromJump = false;

      const verb =
        tick.sessionVerb ??
        (airborneFromJump
          ? "jump"
          : tick.playerInput.dash && moveHeld
            ? "dash"
            : tick.playerInput.crouch
              ? "crouch"
              : tick.playerInput.sprint && moveHeld
                ? "sprint"
                : moveHeld
                  ? "move"
                  : tick.input.look_left || tick.input.look_right || tick.input.look_up || tick.input.look_down
                    ? "look"
                    : undefined);
      if (verb) verbs.add(verb);

      const sample: GamePlaytestSample = {
        frame,
        time_s: frame * options.dt,
        position: [state.position[0], state.position[1], state.position[2]],
        yaw: state.yaw,
        ...(state.pitch !== undefined ? { pitch: state.pitch } : {}),
        velocity: [velocity[0], velocity[1], velocity[2]],
        on_ground: state.flying ? false : state.onGround || (tick.seated === true ? true : !fellThrough),
        flying: state.flying,
        ...(verb ? { verb } : {}),
        ...(tick.interactionObjectId ? { interaction_object_id: tick.interactionObjectId } : {}),
        camera_clip: tick.cameraClip === true,
        stuck,
      };
      samples.push(sample);
      frame += 1;
      previousOnGround = state.onGround;
      previousPosition = [state.position[0], state.position[1], state.position[2]];
      return sample;
    },
    finish() {
      return gamePlaytestTraceSchema.parse({
        contract: "director-game-playtest-trace-v1",
        slice_id: options.sliceId,
        ...(options.projectRevision ? { project_revision: options.projectRevision } : {}),
        dt: options.dt,
        samples,
        verbs_exercised: [...verbs],
      });
    },
    frameCount: () => frame,
  };
}

export type GamePlaytestReplayOptions = {
  /** Raw or parsed tape; validated with `gamePlaytestScriptSchema`. */
  script: GamePlaytestScriptInput;
  /** Trace slice id; defaults to the standalone replay id. */
  sliceId?: string;
  projectRevision?: string;
  /** Spawn state; defaults to origin on the ground plane facing +Z. */
  initialState?: PlayerLocomotionState;
  /** Planar collision/support obstacles (boxes and circles only). */
  obstacles?: PlayerObstacle[];
  /** Director ground plane height, walkable when `groundEnabled`. */
  groundHeight?: number;
  groundEnabled?: boolean;
  /** View-controls speed multiplier, mirroring the live controller. */
  speedScale?: number;
};

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * The lowest walkable surface that could still catch a fall at this planar
 * position, or null when nothing (not even the ground plane) is below.
 */
function lowestSupportY(
  position: PlayerPosition,
  obstacles: readonly PlayerObstacle[],
  groundHeight: number,
  groundEnabled: boolean,
): number | null {
  let lowest: number | null = groundEnabled ? groundHeight : null;
  for (const obstacle of obstacles) {
    if (obstacle.shape === "mesh" || obstacle.walkableSurface === false) continue;
    const [rotationX, , rotationZ] = obstacle.rotation ?? [0, obstacle.yaw ?? 0, 0];
    if (Math.abs(rotationX) > 0.001 || Math.abs(rotationZ) > 0.001) continue;
    const halfHeight = Math.max(0.025, obstacle.halfHeight ?? obstacle.radius);
    const topY = obstacle.position[1] + halfHeight * 2;
    let contains: boolean;
    if (obstacle.shape === "box") {
      const [halfWidth, halfDepth] = obstacle.halfExtents ?? [obstacle.radius, obstacle.radius];
      const obstacleYaw = obstacle.yaw ?? 0;
      const cosine = Math.cos(obstacleYaw);
      const sine = Math.sin(obstacleYaw);
      const dx = position[0] - obstacle.position[0];
      const dz = position[2] - obstacle.position[2];
      contains =
        Math.abs(cosine * dx - sine * dz) <= halfWidth + 0.001 && Math.abs(sine * dx + cosine * dz) <= halfDepth + 0.001;
    } else {
      contains =
        Math.hypot(position[0] - obstacle.position[0], position[2] - obstacle.position[2]) <= obstacle.radius + 0.001;
    }
    if (!contains) continue;
    if (lowest === null || topY < lowest) lowest = topY;
  }
  return lowest;
}

/**
 * Replays a `director_game` playtest script against the pure Stage
 * locomotion model and returns a scored-ready trace. Runs headless in
 * vitest/jsdom — no browser tab, Three.js, React, or Rapier.
 *
 * Look inputs integrate into yaw/pitch at the live keyboard look rates; the
 * replay never rewrites yaw to match the motion heading, so a tape that
 * strafes reports the honest mismatch for `facing_matches_move` scoring.
 */
export function replayGamePlaytestScript(options: GamePlaytestReplayOptions): GamePlaytestTrace {
  const script = gamePlaytestScriptSchema.parse(options.script);
  const totalFrames = countGamePlaytestScriptFrames(script);
  if (totalFrames > GAME_PLAYTEST_TRACE_SAMPLE_BUDGET) {
    throw new Error(
      `Playtest script would emit ${totalFrames} samples; the trace budget is ${GAME_PLAYTEST_TRACE_SAMPLE_BUDGET}. Split the tape.`,
    );
  }
  const groundHeight = options.groundHeight ?? 0;
  const groundEnabled = options.groundEnabled ?? true;
  const obstacles = options.obstacles ?? [];
  const recorder = createGamePlaytestTraceRecorder({
    sliceId: options.sliceId ?? GAME_PLAYTEST_REPLAY_SLICE_ID,
    dt: script.dt,
    projectRevision: options.projectRevision,
  });

  let state =
    options.initialState ?? createPlayerLocomotionState([0, 0, 0], 0, groundEnabled ? groundHeight : 0);
  let previousJumpHeld = state.jumpHeld;

  for (const step of script.steps) {
    const sessionVerb = resolveGamePlaytestSessionVerb(step.input);
    let playerInput = mapGamePlaytestInputToPlayerInput(step.input, previousJumpHeld);
    previousJumpHeld = step.input.jump;
    const lookYawPerFrame =
      -(Number(step.input.look_right) - Number(step.input.look_left)) * PLAYER_KEYBOARD_LOOK_YAW_RAD_S * script.dt;
    const lookPitchPerFrame =
      -(Number(step.input.look_down) - Number(step.input.look_up)) * PLAYER_KEYBOARD_LOOK_PITCH_RAD_S * script.dt;

    for (let frameInStep = 0; frameInStep < step.frames; frameInStep += 1) {
      if (lookYawPerFrame !== 0 || lookPitchPerFrame !== 0) {
        state = {
          ...state,
          yaw: wrapAngle(state.yaw + lookYawPerFrame),
          pitch: clamp(state.pitch + lookPitchPerFrame, -GAME_PLAYTEST_MAX_PITCH_RAD, GAME_PLAYTEST_MAX_PITCH_RAD),
        };
      }
      state = stepPlayerLocomotion({
        state,
        input: playerInput,
        delta: script.dt,
        groundHeight,
        groundEnabled,
        obstacles,
        speedScale: options.speedScale,
      });
      if (frameInStep === 0 && playerInput.jumpPressed) {
        playerInput = { ...playerInput, jumpPressed: false };
      }
      const support = lowestSupportY(state.position, obstacles, groundHeight, groundEnabled);
      recorder.record({
        input: step.input,
        playerInput,
        state: {
          position: state.position,
          velocity: state.velocity,
          yaw: state.yaw,
          pitch: state.pitch,
          onGround: state.onGround,
          flying: state.flying,
        },
        sessionVerb,
        belowSupport: support !== null && state.position[1] < support - GAME_PLAYTEST_FALL_BELOW_SUPPORT_M,
      });
    }
  }

  return recorder.finish();
}
