import { describe, expect, it } from "vitest";
import { evaluateGamePlaytest } from "@director/protocol/director-game-machine";
import {
  createGameSliceFromBrief,
  gamePlaytestTraceSchema,
  type GamePlaytestScriptInput,
  type GameSliceVerb,
} from "@director/protocol/game-slice";
import {
  cancelActiveGamePlaytestSession,
  getActiveGamePlaytestSession,
  startGamePlaytestSession,
  type ActiveGamePlaytestSession,
} from "../../../../src/comprehensive/editor/player/gamePlaytestSession";
import {
  createPlayerLocomotionState,
  stepPlayerLocomotion,
  type PlayerLocomotionState,
} from "../../../../src/comprehensive/editor/player/playerLocomotion";

const DT = 1 / 30;

function script(steps: GamePlaytestScriptInput["steps"]): GamePlaytestScriptInput {
  return { dt: DT, steps };
}

/**
 * Drives an active session exactly like the live PlayerController frame loop:
 * pull one tape tick, step the motor at the fixed dt, push the sampled state.
 */
function runHostLoop(
  session: ActiveGamePlaytestSession,
  options: {
    initialState?: PlayerLocomotionState;
    onFirstFrameVerb?: (verb: GameSliceVerb, stepIndex: number) => void;
    interactionObjectId?: string;
    cameraClip?: boolean;
  } = {},
) {
  let state = options.initialState ?? createPlayerLocomotionState([0, 0, 0], 0, 0);
  let ticks = 0;
  for (;;) {
    const frame = session.beginFrame();
    if (!frame) break;
    if (frame.firstFrameOfStep && frame.sessionVerb) {
      options.onFirstFrameVerb?.(frame.sessionVerb, frame.stepIndex);
    }
    state = stepPlayerLocomotion({
      state,
      input: frame.playerInput,
      delta: frame.dt,
      groundHeight: 0,
      obstacles: [],
    });
    session.recordSample(
      {
        position: state.position,
        velocity: state.velocity,
        yaw: state.yaw,
        pitch: state.pitch,
        onGround: state.onGround,
        flying: state.flying,
      },
      {
        cameraClip: options.cameraClip,
        interactionObjectId: options.interactionObjectId,
      },
    );
    ticks += 1;
    if (ticks > 100_000) throw new Error("host loop failed to terminate");
  }
  return { state, ticks };
}

describe("gamePlaytestSession", () => {
  it("hands the host one mapped tick per frame and resolves the trace after the last sample", async () => {
    const promise = startGamePlaytestSession({
      script: script([
        { frames: 20, input: { forward: true, sprint: true } },
        { frames: 10, input: { interact: true } },
      ]),
      sliceId: "game-live-playtest",
    });
    const session = getActiveGamePlaytestSession();
    expect(session).not.toBeNull();
    expect(session!.totalFrames).toBe(30);
    expect(session!.dt).toBeCloseTo(DT, 8);

    const dispatched: Array<{ verb: GameSliceVerb; stepIndex: number }> = [];
    const { ticks } = runHostLoop(session!, {
      onFirstFrameVerb: (verb, stepIndex) => dispatched.push({ verb, stepIndex }),
      interactionObjectId: "stele-1",
    });

    const trace = await promise;
    expect(ticks).toBe(30);
    expect(getActiveGamePlaytestSession()).toBeNull();
    expect(gamePlaytestTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.slice_id).toBe("game-live-playtest");
    expect(trace.samples).toHaveLength(30);
    // Session verbs dispatch exactly once, on the first frame of their step.
    expect(dispatched).toEqual([{ verb: "interact", stepIndex: 1 }]);
    // ...but are recorded on every sample of the held step.
    expect(trace.samples.filter((sample) => sample.verb === "interact")).toHaveLength(10);
    expect(trace.samples.filter((sample) => sample.verb === "sprint").length).toBeGreaterThan(0);
    expect(trace.samples.every((sample) => sample.interaction_object_id === "stele-1")).toBe(true);
    expect(trace.verbs_exercised).toEqual(expect.arrayContaining(["sprint", "interact"]));
  });

  it("records the live camera occlusion flag so the evaluator can warn on camera clip", async () => {
    const promise = startGamePlaytestSession({
      script: script([{ frames: 15, input: { forward: true } }]),
    });
    runHostLoop(getActiveGamePlaytestSession()!, { cameraClip: true });
    const trace = await promise;
    expect(trace.samples.every((sample) => sample.camera_clip)).toBe(true);

    const slice = createGameSliceFromBrief({
      id: "game-live-playtest",
      brief: { requirement: "Camera clip repro.", genre: "exploration" },
      now: "2026-08-26T00:00:00.000Z",
    });
    slice.roles = slice.roles.map((role) => ({ ...role, object_id: `stage-${role.id}` }));
    const report = evaluateGamePlaytest(slice, { ...trace, slice_id: slice.id });
    expect(report.issues.map((issue) => issue.code)).toContain("camera_clip");
  });

  it("rejects the pending tape when cancelled and clears the active session", async () => {
    const promise = startGamePlaytestSession({
      script: script([{ frames: 30, input: { forward: true } }]),
    });
    expect(getActiveGamePlaytestSession()).not.toBeNull();

    cancelActiveGamePlaytestSession("Player Mode exited before the playtest tape finished.");
    await expect(promise).rejects.toThrow(/Player Mode exited/);
    expect(getActiveGamePlaytestSession()).toBeNull();
  });

  it("fails a tape still in flight when a new session starts", async () => {
    const first = startGamePlaytestSession({
      script: script([{ frames: 30, input: { forward: true } }]),
    });
    const staleSession = getActiveGamePlaytestSession()!;
    const second = startGamePlaytestSession({
      script: script([{ frames: 5, input: { forward: true } }]),
    });
    await expect(first).rejects.toThrow(/replaced/);

    // The stale session handle is inert: it cannot tick or record samples.
    expect(staleSession.beginFrame()).toBeNull();

    runHostLoop(getActiveGamePlaytestSession()!);
    const trace = await second;
    expect(trace.samples).toHaveLength(5);
  });

  it("latches the jump edge across steps like a physical key", async () => {
    const promise = startGamePlaytestSession({
      script: script([
        { frames: 2, input: { jump: true } },
        { frames: 2, input: { jump: true } },
        { frames: 2, input: {} },
        { frames: 2, input: { jump: true } },
      ]),
    });
    const session = getActiveGamePlaytestSession()!;
    const edges: boolean[] = [];
    for (;;) {
      const frame = session.beginFrame();
      if (!frame) break;
      edges.push(frame.playerInput.jumpPressed === true);
      session.recordSample({ position: [0, 0, 0], yaw: 0, onGround: true, flying: false });
    }
    await promise;
    // Fresh hold -> edge; continued hold across a step boundary -> no edge;
    // release then re-hold -> a second edge.
    expect(edges).toEqual([true, false, false, false, false, false, true, false]);
  });
});
