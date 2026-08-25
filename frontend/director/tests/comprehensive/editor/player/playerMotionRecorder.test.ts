import { describe, expect, it } from "vitest";
import type { DirectorTransform } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  createPlayerMotionRecorder,
  createPlayerMotionRecordingSession,
  PLAYER_MOTION_POSITION_TOLERANCE_M,
  type PlayerMotionRecorderOptions,
} from "../../../../src/comprehensive/editor/player/playerMotionRecorder";

const BASE_TRANSFORM: DirectorTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

function makeRecorder(overrides: Partial<PlayerMotionRecorderOptions> = {}) {
  return createPlayerMotionRecorder({
    fps: 24,
    startFrame: 0,
    frameEnd: 10_000,
    baseTransform: BASE_TRANSFORM,
    ...overrides,
  });
}

describe("player motion recorder", () => {
  it("maps sample times to integer frames at the timeline fps and offsets from the playhead", () => {
    const recorder = makeRecorder({ fps: 30, startFrame: 48 });
    recorder.ingest({ timeSeconds: 0, position: [0, 0, 0], yawRadians: 0 });
    recorder.ingest({ timeSeconds: 1, position: [1, 0, 0], yawRadians: 0 });
    recorder.ingest({ timeSeconds: 2.5, position: [2, 0, 3], yawRadians: 0 });

    const samples = recorder.getFrameSamples();
    expect(samples.map((entry) => entry.frame)).toEqual([48, 78, 123]);
  });

  it("clamps recorded frames at the timeline end instead of extending it", () => {
    const recorder = makeRecorder({ fps: 24, startFrame: 90, frameEnd: 96 });
    recorder.ingest({ timeSeconds: 0, position: [0, 0, 0], yawRadians: 0 });
    recorder.ingest({ timeSeconds: 10, position: [10, 0, 0], yawRadians: 0 });
    recorder.ingest({ timeSeconds: 20, position: [20, 0, 0], yawRadians: 0 });

    const frames = recorder.getFrameSamples().map((entry) => entry.frame);
    expect(Math.max(...frames)).toBe(96);
  });

  it("dedupes same-frame samples keeping the last pose", () => {
    const recorder = makeRecorder({ fps: 24 });
    recorder.ingest({ timeSeconds: 0, position: [0, 0, 0], yawRadians: 0 });
    // Three samples inside frame 1's window (24 fps → 1/24 s per frame).
    recorder.ingest({ timeSeconds: 0.034, position: [0.1, 0, 0], yawRadians: 0 });
    recorder.ingest({ timeSeconds: 0.038, position: [0.2, 0, 0], yawRadians: 0 });
    recorder.ingest({ timeSeconds: 0.042, position: [0.3, 0, 0], yawRadians: 0 });

    const samples = recorder.getFrameSamples();
    expect(samples).toHaveLength(2);
    expect(samples[1]!.frame).toBe(1);
    expect(samples[1]!.transform.position[0]).toBeCloseTo(0.3, 10);
  });

  it("drops collinear runs and keeps the corner of a straight-line-then-turn path", () => {
    const recorder = makeRecorder({ fps: 24 });
    // Straight +X leg: 2 seconds, then a 90° turn onto +Z for 2 seconds.
    for (let step = 0; step <= 48; step += 1) {
      recorder.ingest({ timeSeconds: step / 24, position: [step * 0.1, 0, 0], yawRadians: 0 });
    }
    for (let step = 1; step <= 48; step += 1) {
      recorder.ingest({
        timeSeconds: 2 + step / 24,
        position: [4.8, 0, step * 0.1],
        yawRadians: Math.PI / 2,
      });
    }

    const recording = recorder.finalize();
    expect(recording).not.toBeNull();
    // Straight legs collapse: first, around the corner, last — no dense chain.
    expect(recording!.keyframeCount).toBeGreaterThanOrEqual(3);
    expect(recording!.keyframeCount).toBeLessThanOrEqual(6);
    const keyframes = recording!.animation.keyframes.filter((keyframe) => keyframe.transform);
    expect(keyframes[0]!.frame).toBe(recording!.frameStart);
    expect(keyframes[keyframes.length - 1]!.frame).toBe(recording!.frameEnd);
    // The corner survives decimation: some kept frame sits near x≈4.8, z≈0.
    const corner = keyframes.find(
      (keyframe) =>
        Math.abs(keyframe.transform!.position[0] - 4.8) < 0.35 && Math.abs(keyframe.transform!.position[2]) < 0.35,
    );
    expect(corner).toBeDefined();
  });

  it("unwraps yaw across the -π/π seam so keyframes never lerp the long way", () => {
    const recorder = makeRecorder({ fps: 24 });
    // Rotate through the seam: 170° → 175° → -175° → -170° (continuous +20°).
    const degrees = [170, 175, -175, -170];
    degrees.forEach((value, index) => {
      recorder.ingest({
        timeSeconds: index,
        position: [index * 5, 0, index % 2 === 0 ? 0.001 : -0.001],
        yawRadians: (value * Math.PI) / 180,
      });
    });

    const samples = recorder.getFrameSamples();
    const yaws = samples.map((entry) => entry.transform.rotation[1]);
    for (let index = 1; index < yaws.length; index += 1) {
      expect(Math.abs(yaws[index]! - yaws[index - 1]!)).toBeLessThan(Math.PI / 2);
    }
    expect(yaws[yaws.length - 1]!).toBeGreaterThan(yaws[0]!);
  });

  it("is deterministic for identical input sequences", () => {
    const run = () => {
      const recorder = makeRecorder({ fps: 24 });
      for (let step = 0; step <= 100; step += 1) {
        const t = step / 24;
        recorder.ingest({
          timeSeconds: t,
          position: [Math.sin(t) * 4, 0, t * 1.5],
          yawRadians: Math.atan2(Math.cos(t) * 4, 1.5),
        });
      }
      return recorder.finalize();
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it("preserves the base transform's scale and tilt while recording yaw only", () => {
    const recorder = makeRecorder({
      baseTransform: { position: [9, 9, 9], rotation: [0.1, 0, -0.05], scale: [2, 2, 2] },
    });
    recorder.ingest({ timeSeconds: 0, position: [0, 0.2, 0], yawRadians: 0.4 });
    recorder.ingest({ timeSeconds: 1, position: [3, 0.2, 1], yawRadians: 0.9 });

    const sample = recorder.getFrameSamples()[0]!;
    expect(sample.transform.scale).toEqual([2, 2, 2]);
    expect(sample.transform.rotation[0]).toBeCloseTo(0.1, 10);
    expect(sample.transform.rotation[1]).toBeCloseTo(0.4, 10);
    expect(sample.transform.rotation[2]).toBeCloseTo(-0.05, 10);
  });

  it("returns null for clips without motion and refuses double finalize", () => {
    const still = makeRecorder();
    still.ingest({ timeSeconds: 0, position: [0, 0, 0], yawRadians: 0 });
    expect(still.finalize()).toBeNull();
    expect(still.finalize()).toBeNull();

    const moving = makeRecorder();
    moving.ingest({ timeSeconds: 0, position: [0, 0, 0], yawRadians: 0 });
    moving.ingest({ timeSeconds: 1, position: [5, 0, 0], yawRadians: 0 });
    expect(moving.finalize()).not.toBeNull();
    expect(moving.finalize()).toBeNull();
  });

  it("respects the keyframes-per-second cap on jittery paths", () => {
    const recorder = makeRecorder({ fps: 24, maxKeyframesPerSecond: 4 });
    // Zig-zag violently every frame for 2 seconds: without the cap every
    // sample would be a corner.
    for (let step = 0; step <= 48; step += 1) {
      recorder.ingest({
        timeSeconds: step / 24,
        position: [step * 0.2, 0, (step % 2) * PLAYER_MOTION_POSITION_TOLERANCE_M * 40],
        yawRadians: 0,
      });
    }
    const recording = recorder.finalize();
    expect(recording).not.toBeNull();
    // 2 seconds × 4/s cap + endpoints headroom.
    expect(recording!.keyframeCount).toBeLessThanOrEqual(11);
  });
});

describe("player motion recording session", () => {
  const actorTransforms: Record<string, DirectorTransform> = {
    hero: BASE_TRANSFORM,
    car: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };

  function makeSession(commits: Array<{ actorId: string; frameStart: number; frameEnd: number }>) {
    return createPlayerMotionRecordingSession({
      fps: 24,
      startFrame: 0,
      frameEnd: 10_000,
      resolveActor: (actorId) => (actorTransforms[actorId] ? { baseTransform: actorTransforms[actorId]! } : null),
      commitClip: ({ actorId, recorder }) => {
        const recording = recorder.finalize();
        if (recording) {
          commits.push({ actorId, frameStart: recording.frameStart, frameEnd: recording.frameEnd });
        }
      },
    });
  }

  it("splits walk→drive performances into sequential per-actor clips", () => {
    const commits: Array<{ actorId: string; frameStart: number; frameEnd: number }> = [];
    const session = makeSession(commits);

    // Walk 2 s, then drive 2 s from session-second 2.
    for (let step = 0; step <= 48; step += 1) {
      session.ingest("hero", step / 24, { position: [step * 0.08, 0, 0], yawRadians: 0 });
    }
    for (let step = 1; step <= 48; step += 1) {
      session.ingest("car", 2 + step / 24, { position: [4 + step * 0.4, 0, 0], yawRadians: 0 });
    }
    session.stop();

    expect(commits.map((clip) => clip.actorId)).toEqual(["hero", "car"]);
    expect(commits[0]!.frameStart).toBe(0);
    // The drive clip starts at the session frame where the switch happened:
    // first car sample at 2 + 1/24 s → round(2.0417 × 24) = frame 49.
    expect(commits[1]!.frameStart).toBe(49);
    expect(commits[1]!.frameEnd).toBeGreaterThan(commits[1]!.frameStart);
  });

  it("ignores unknown actors and refuses samples after stop", () => {
    const commits: Array<{ actorId: string; frameStart: number; frameEnd: number }> = [];
    const session = makeSession(commits);
    session.ingest("ghost", 0, { position: [0, 0, 0], yawRadians: 0 });
    session.ingest("hero", 0.5, { position: [0, 0, 0], yawRadians: 0 });
    session.ingest("hero", 1.5, { position: [3, 0, 0], yawRadians: 0 });
    session.stop();
    session.ingest("hero", 2, { position: [6, 0, 0], yawRadians: 0 });
    session.stop();

    expect(commits).toHaveLength(1);
    expect(commits[0]!.actorId).toBe("hero");
  });

  it("drops sub-two-sample clips instead of committing empty animations", () => {
    const commits: Array<{ actorId: string; frameStart: number; frameEnd: number }> = [];
    const session = makeSession(commits);
    session.ingest("hero", 0, { position: [0, 0, 0], yawRadians: 0 });
    // Immediate switch: hero clip has a single sample and must be dropped.
    session.ingest("car", 0.05, { position: [4, 0, 0], yawRadians: 0 });
    session.ingest("car", 1.05, { position: [9, 0, 0], yawRadians: 0 });
    session.stop();

    expect(commits.map((clip) => clip.actorId)).toEqual(["car"]);
  });
});
