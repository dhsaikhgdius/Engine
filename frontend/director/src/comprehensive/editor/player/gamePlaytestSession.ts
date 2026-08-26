import {
  gamePlaytestScriptSchema,
  type GamePlaytestInput,
  type GamePlaytestScript,
  type GamePlaytestScriptInput,
  type GamePlaytestTrace,
  type GameSliceVerb,
} from "@director/protocol/game-slice";
import {
  countGamePlaytestScriptFrames,
  createGamePlaytestTraceRecorder,
  mapGamePlaytestInputToPlayerInput,
  resolveGamePlaytestSessionVerb,
  type GamePlaytestSampledState,
} from "./gamePlaytestReplay";
import type { PlayerInput } from "./playerLocomotion";

/**
 * Live Stage playtest session: a scripted input tape that the running
 * PlayerController consumes one simulation tick per rendered frame while
 * sampling the real locomotion state, camera occlusion, and nearest
 * interaction into a `director-game-playtest-trace-v1` document.
 *
 * DirectorCanvas starts a session from the `play_script` player session
 * command; PlayerController pulls `beginFrame()` / pushes `recordSample()`.
 * The tape — not a video — is the playability receipt the Gateway machine
 * scores, so samples come straight from the live motor without correction.
 */

/** Slice id used when a live tape runs without a stored `director_game` slice. */
export const GAME_PLAYTEST_SESSION_SLICE_ID = "game-playtest-session";

/** One tape tick handed to the live controller for the current rendered frame. */
export type GamePlaytestSessionFrame = {
  /** Fixed simulation timestep for this tick (the script's dt). */
  dt: number;
  /** Raw held tape input for the current step. */
  input: GamePlaytestInput;
  /** Mapped Stage input the motor should consume this frame. */
  playerInput: PlayerInput;
  /** Session verb held by this step, if any. */
  sessionVerb?: GameSliceVerb;
  /** True on the first tick of a step: dispatch session verbs exactly once. */
  firstFrameOfStep: boolean;
  stepIndex: number;
};

export type GamePlaytestSessionRecordExtras = {
  cameraClip?: boolean;
  interactionObjectId?: string;
  /** Seated in a vehicle: the seat supports the actor and velocity is derived. */
  seated?: boolean;
};

export type ActiveGamePlaytestSession = {
  readonly sliceId: string;
  readonly dt: number;
  readonly totalFrames: number;
  /**
   * Advances the tape cursor and returns the tick to simulate this frame,
   * or null when the tape is exhausted (or the session was cancelled).
   */
  beginFrame: () => GamePlaytestSessionFrame | null;
  /**
   * Records the post-step locomotion state for the tick returned by the
   * matching `beginFrame()`. Resolves the session promise after the final
   * sample lands.
   */
  recordSample: (state: GamePlaytestSampledState, extras?: GamePlaytestSessionRecordExtras) => void;
};

type SessionInternals = {
  session: ActiveGamePlaytestSession;
  fail: (error: Error) => void;
};

let active: SessionInternals | null = null;

/** The tape session the live PlayerController should drive, if any. */
export function getActiveGamePlaytestSession(): ActiveGamePlaytestSession | null {
  return active?.session ?? null;
}

/** Fails and clears the active session (player mode exit, actor switch). */
export function cancelActiveGamePlaytestSession(reason: string): void {
  const current = active;
  if (!current) return;
  active = null;
  current.fail(new Error(reason));
}

export type StartGamePlaytestSessionOptions = {
  /** Raw or parsed tape; validated with `gamePlaytestScriptSchema`. */
  script: GamePlaytestScript | GamePlaytestScriptInput;
  /** Trace slice id; defaults to the standalone session id. */
  sliceId?: string;
  projectRevision?: string;
};

/**
 * Registers a scripted tape for the live PlayerController to drive and
 * resolves with the recorded trace once every frame has been sampled.
 * Starting a new session fails any tape still in flight.
 */
export function startGamePlaytestSession(options: StartGamePlaytestSessionOptions): Promise<GamePlaytestTrace> {
  const script = gamePlaytestScriptSchema.parse(options.script);
  const totalFrames = countGamePlaytestScriptFrames(script);
  cancelActiveGamePlaytestSession("A new playtest tape replaced this session before it finished.");

  return new Promise<GamePlaytestTrace>((resolve, reject) => {
    const recorder = createGamePlaytestTraceRecorder({
      sliceId: options.sliceId ?? GAME_PLAYTEST_SESSION_SLICE_ID,
      dt: script.dt,
      projectRevision: options.projectRevision,
    });
    let stepIndex = 0;
    let frameInStep = 0;
    let previousJumpHeld = false;
    let currentFrame: GamePlaytestSessionFrame | null = null;

    const internals: SessionInternals = {
      fail: reject,
      session: {
        sliceId: options.sliceId ?? GAME_PLAYTEST_SESSION_SLICE_ID,
        dt: script.dt,
        totalFrames,
        beginFrame() {
          if (active !== internals) return null;
          if (stepIndex >= script.steps.length) return null;
          const step = script.steps[stepIndex]!;
          const firstFrameOfStep = frameInStep === 0;
          currentFrame = {
            dt: script.dt,
            input: step.input,
            playerInput: mapGamePlaytestInputToPlayerInput(step.input, previousJumpHeld),
            sessionVerb: resolveGamePlaytestSessionVerb(step.input),
            firstFrameOfStep,
            stepIndex,
          };
          previousJumpHeld = step.input.jump;
          frameInStep += 1;
          if (frameInStep >= step.frames) {
            stepIndex += 1;
            frameInStep = 0;
          }
          return currentFrame;
        },
        recordSample(state, extras) {
          if (active !== internals || !currentFrame) return;
          recorder.record({
            input: currentFrame.input,
            playerInput: currentFrame.playerInput,
            state,
            sessionVerb: currentFrame.sessionVerb,
            cameraClip: extras?.cameraClip,
            interactionObjectId: extras?.interactionObjectId,
            seated: extras?.seated,
          });
          currentFrame = null;
          if (stepIndex >= script.steps.length) {
            active = null;
            try {
              resolve(recorder.finish());
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        },
      },
    };
    active = internals;
  });
}
