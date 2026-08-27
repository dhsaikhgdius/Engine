import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorWorkbenchOperation } from "@director/agent-engine";
import { runHostFreeGamePlaytest } from "../../../../packages/protocol/src/gamePlaytestHostFree";
import type {
  GameEvaluationReport,
  GamePlaytestScript,
  GamePlaytestTrace,
  GameSlice,
} from "../../../../packages/protocol/src/gameSliceProtocol";
import { createDirectorGame, type DirectorGameRuntime } from "../../game/createDirectorGame";
import { createLiveStagePlaytestRunner, type LiveWorkbenchCommandResult } from "../../game/liveStagePlaytest";

/**
 * Live `director_game` playtest wiring against the durable Gateway runtime
 * with a mocked workbench command bus: the same `createDirectorGame` +
 * `createLiveStagePlaytestRunner` composition `agent-gateway.ts` boots, minus
 * the WebSocket transport. Proves the live path end to end — the internal
 * `game_playtest` dispatch, the `live_stage` provenance restamp, the durable
 * `trace_source` receipt — and the host-free fallback parity for the same
 * canonical tape.
 */

const NOW = "2026-08-27T01:00:00.000Z";
const SLICE_ID = "game-live-loop-01";

type PlaytestResult = {
  slice: GameSlice;
  trace: GamePlaytestTrace;
  evaluation: GameEvaluationReport;
};

/**
 * Simulates a healthy workbench tab: replies to the internal `game_playtest`
 * dispatch with a `play_script` receipt whose trace replays the tape through
 * the shared kinematic semantics. The tab reply deliberately keeps the
 * standalone session slice id and a non-live source stamp so the test proves
 * the Gateway bridge restamps both.
 */
function liveTabBus() {
  return vi.fn(async (input: DirectorWorkbenchOperation): Promise<LiveWorkbenchCommandResult> => {
    if (input.op !== "game_playtest") throw new Error(`unexpected workbench op ${input.op}`);
    const trace = runHostFreeGamePlaytest({
      slice: {
        id: "game-playtest-session",
        roles: [{ id: "objective-1", kind: "objective", purpose: "Reachable interactable.", object_id: "stele-1" }],
      },
      script: input.script,
    });
    return {
      success: true,
      result: {
        surface: "player",
        action: "play_script",
        actor_id: input.actor_id ?? null,
        trace,
        sample_count: trace.samples.length,
        verbs_exercised: trace.verbs_exercised,
      },
    };
  });
}

async function planAndBind(runtime: DirectorGameRuntime): Promise<GamePlaytestScript> {
  const planned = await runtime.execute({
    op: "plan",
    slice_id: SLICE_ID,
    brief: { requirement: "Walk to the stele and interact.", genre: "exploration" },
  });
  expect(planned).toMatchObject({ success: true, result: { slice: { status: "draft" } } });
  const bound = await runtime.execute({
    op: "bind",
    slice_id: SLICE_ID,
    bindings: [
      { role_id: "player", object_id: "hero-1" },
      { role_id: "spawn", object_id: "spawn-1" },
      { role_id: "objective-1", object_id: "stele-1" },
    ],
  });
  expect(bound).toMatchObject({ success: true, result: { bind_complete: true } });
  if (!bound.success) throw new Error("bind failed");
  return (bound.result as { suggested_playtest_script: GamePlaytestScript }).suggested_playtest_script;
}

describe("director_game live playtest wiring (mocked workbench bus)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createRuntime(requestWorkbenchCommand: Parameters<typeof createLiveStagePlaytestRunner>[0]["requestWorkbenchCommand"]) {
    const dir = await mkdtemp(join(tmpdir(), "director-game-live-"));
    tempDirs.push(dir);
    const runtime = createDirectorGame(dir, {
      now: () => NOW,
      runPlaytest: createLiveStagePlaytestRunner({ requestWorkbenchCommand }),
    });
    return { runtime, dir };
  }

  it("dispatches the internal game_playtest op and returns a live_stage receipt end to end", async () => {
    const bus = liveTabBus();
    const { runtime, dir } = await createRuntime(bus);
    const script = await planAndBind(runtime);

    const playtested = await runtime.execute({ op: "playtest", slice_id: SLICE_ID, script });
    expect(playtested.success).toBe(true);
    if (!playtested.success) throw new Error("playtest failed");
    const result = playtested.result as PlaytestResult;

    // The live bridge sent exactly one internal dispatch, carrying the bound
    // player actor and the slice id so the tab enters the right session.
    expect(bus).toHaveBeenCalledTimes(1);
    expect(bus).toHaveBeenCalledWith(
      expect.objectContaining({ op: "game_playtest", actor_id: "hero-1", slice_id: SLICE_ID }),
      expect.any(Number),
    );

    // Provenance: the tab reply was restamped to this slice and live_stage.
    expect(result.trace.slice_id).toBe(SLICE_ID);
    expect(result.trace.source).toBe("live_stage");
    expect(result.evaluation.trace_source).toBe("live_stage");
    expect(result.evaluation.playable, JSON.stringify(result.evaluation.issues)).toBe(true);
    expect(result.slice.status).toBe("playable");

    // Durability: a fresh runtime over the same store still reports the live
    // provenance on the stored evaluation, with no bus available at all.
    const reloaded = createDirectorGame(dir, { now: () => NOW });
    const evaluated = await reloaded.execute({ op: "evaluate", slice_id: SLICE_ID });
    expect(evaluated).toMatchObject({
      success: true,
      result: { evaluation: { playable: true, trace_source: "live_stage" } },
    });
  });

  it("falls back to host_free provenance when no workbench tab is connected", async () => {
    const bus = vi.fn(async (): Promise<LiveWorkbenchCommandResult> => null);
    const { runtime } = await createRuntime(bus);
    const script = await planAndBind(runtime);

    const playtested = await runtime.execute({ op: "playtest", slice_id: SLICE_ID, script });
    expect(playtested.success).toBe(true);
    if (!playtested.success) throw new Error("playtest failed");
    const result = playtested.result as PlaytestResult;

    expect(bus).toHaveBeenCalledTimes(1);
    expect(result.trace.source).toBe("host_free");
    expect(result.evaluation.trace_source).toBe("host_free");
    expect(result.evaluation.playable, JSON.stringify(result.evaluation.issues)).toBe(true);
  });

  it("keeps live and host-free parity: the same canonical tape is playable on both drivers", async () => {
    const live = await createRuntime(liveTabBus());
    const hostFree = await createRuntime(async () => null);

    const liveScript = await planAndBind(live.runtime);
    const hostFreeScript = await planAndBind(hostFree.runtime);
    expect(hostFreeScript).toEqual(liveScript);

    const livePlaytested = await live.runtime.execute({ op: "playtest", slice_id: SLICE_ID, script: liveScript });
    const hostFreePlaytested = await hostFree.runtime.execute({
      op: "playtest",
      slice_id: SLICE_ID,
      script: hostFreeScript,
    });
    expect(livePlaytested.success).toBe(true);
    expect(hostFreePlaytested.success).toBe(true);
    if (!livePlaytested.success || !hostFreePlaytested.success) throw new Error("parity playtest failed");
    const liveResult = livePlaytested.result as PlaytestResult;
    const hostFreeResult = hostFreePlaytested.result as PlaytestResult;

    // Both drivers satisfy evaluate for the same tape...
    expect(liveResult.evaluation.playable, JSON.stringify(liveResult.evaluation.issues)).toBe(true);
    expect(hostFreeResult.evaluation.playable, JSON.stringify(hostFreeResult.evaluation.issues)).toBe(true);
    expect([...liveResult.evaluation.verbs_exercised].sort()).toEqual(
      [...hostFreeResult.evaluation.verbs_exercised].sort(),
    );
    expect(liveResult.evaluation.checks).toEqual(hostFreeResult.evaluation.checks);
    // ...and only the provenance label distinguishes the receipts.
    expect(liveResult.trace.source).toBe("live_stage");
    expect(hostFreeResult.trace.source).toBe("host_free");
  });

  it("never lets an inline trace borrow the live runner's provenance", async () => {
    const bus = liveTabBus();
    const { runtime } = await createRuntime(bus);
    await planAndBind(runtime);

    const inlineTrace = runHostFreeGamePlaytest({
      slice: {
        id: SLICE_ID,
        roles: [{ id: "objective-1", kind: "objective", purpose: "Reachable interactable.", object_id: "stele-1" }],
      },
      script: { steps: [{ frames: 8, input: { forward: true } }] },
    });
    const playtested = await runtime.execute({
      op: "playtest",
      slice_id: SLICE_ID,
      script: { steps: [{ frames: 8, input: { forward: true } }] },
      trace: { ...inlineTrace, source: "live_stage" },
    });
    expect(playtested.success).toBe(true);
    if (!playtested.success) throw new Error("playtest failed");
    const result = playtested.result as PlaytestResult;

    // An inline trace short-circuits the runner entirely and evaluates as
    // inline no matter what source it claimed on the wire.
    expect(bus).not.toHaveBeenCalled();
    expect(result.trace.source).toBe("inline");
    expect(result.evaluation.trace_source).toBe("inline");
  });
});
