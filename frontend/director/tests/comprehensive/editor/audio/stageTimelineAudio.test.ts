import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectorTimelineAudioClip, DirectorTimelineAudioTrack } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  createDirectorStageAudioSource,
  getStageAudioClipGainAt,
  getStageTimelineAudioWindow,
} from "../../../../src/comprehensive/editor/audio/stageTimelineAudio";

function clip(patch: Partial<DirectorTimelineAudioClip> = {}): DirectorTimelineAudioClip {
  return {
    id: "audio_clip_1",
    name: "环境声",
    mediaId: "creative-media:audio:abc",
    sourceUrl: "blob:ambience",
    startFrame: 0,
    durationFrames: 48,
    inSec: 0,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
    ...patch,
  };
}

function track(clips: DirectorTimelineAudioClip[], patch: Partial<DirectorTimelineAudioTrack> = {}) {
  return { id: "audio_track_1", name: "音频轨 1", muted: false, clips, ...patch } satisfies DirectorTimelineAudioTrack;
}

// 24fps window over frames [24, 71]: seconds [1, 3) including the OUT frame's
// full display interval, matching getDirectorVideoDurationSec.
const window24 = { frameStart: 24, frameEnd: 71, fps: 24 };

describe("getStageTimelineAudioWindow", () => {
  it("schedules a clip fully inside the window relative to IN", () => {
    const entries = getStageTimelineAudioWindow([track([clip({ startFrame: 36, durationFrames: 24 })])], window24);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ atSec: 0.5, inSec: 0, durationSec: 1, volume: 1 });
  });

  it("advances the source offset for a clip straddling IN", () => {
    const entries = getStageTimelineAudioWindow(
      [track([clip({ startFrame: 0, durationFrames: 48, inSec: 0.25 })])],
      window24,
    );
    expect(entries).toHaveLength(1);
    // One second of the clip plays before IN, so the source resumes 1s deeper.
    expect(entries[0]).toMatchObject({ atSec: 0, inSec: 1.25, durationSec: 1 });
  });

  it("truncates a clip straddling OUT at the window end", () => {
    const entries = getStageTimelineAudioWindow([track([clip({ startFrame: 48, durationFrames: 96 })])], window24);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ atSec: 1, inSec: 0, durationSec: 1 });
  });

  it("drops clips entirely outside the window", () => {
    const entries = getStageTimelineAudioWindow(
      [
        track([
          clip({ id: "before", startFrame: 0, durationFrames: 24 }),
          clip({ id: "after", startFrame: 72, durationFrames: 24 }),
        ]),
      ],
      window24,
    );
    expect(entries).toEqual([]);
  });

  it("drops muted tracks, muted clips, silent clips, and unresolvable sources", () => {
    const audible = clip({ id: "audible", startFrame: 24, durationFrames: 24 });
    expect(getStageTimelineAudioWindow([track([audible], { muted: true })], window24)).toEqual([]);
    expect(getStageTimelineAudioWindow([track([{ ...audible, muted: true }])], window24)).toEqual([]);
    expect(getStageTimelineAudioWindow([track([{ ...audible, volume: 0 }])], window24)).toEqual([]);
    expect(getStageTimelineAudioWindow([track([{ ...audible, sourceUrl: undefined }])], window24)).toEqual([]);
  });

  it("prefers the resolver URL over the persisted sourceUrl", () => {
    const entries = getStageTimelineAudioWindow([track([clip({ startFrame: 24, durationFrames: 24 })])], {
      ...window24,
      resolveSourceUrl: () => "blob:resolved",
    });
    expect(entries[0]?.sourceUrl).toBe("blob:resolved");
  });

  it("bounds the audible duration by the cached source duration minus the trim", () => {
    const entries = getStageTimelineAudioWindow(
      [track([clip({ startFrame: 24, durationFrames: 96, inSec: 0.5, sourceDurationSec: 2 })])],
      window24,
    );
    // 4 timeline seconds requested, but only 1.5s of source remains after the trim.
    expect(entries[0]?.durationSec).toBeCloseTo(1.5, 6);
  });

  it("splits fade ramps across the window boundaries", () => {
    const entries = getStageTimelineAudioWindow(
      [track([clip({ startFrame: 0, durationFrames: 96, volume: 0.8, fadeInSec: 2, fadeOutSec: 2 })])],
      window24,
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    // The window opens 1s into a 2s fade-in and closes 1s into the fade-out
    // (clip spans 0..4s, fade-out starts at 2s).
    expect(entry!.startVolume).toBeCloseTo(0.4, 6);
    expect(entry!.fadeInSec).toBeCloseTo(1, 6);
    expect(entry!.fadeOutSec).toBeCloseTo(1, 6);
    expect(entry!.endVolume).toBeCloseTo(0.4, 6);
  });

  it("sorts entries by start offset across tracks", () => {
    const entries = getStageTimelineAudioWindow(
      [
        track([clip({ id: "late", startFrame: 48, durationFrames: 12 })]),
        track([clip({ id: "early", startFrame: 24, durationFrames: 12 })], { id: "audio_track_2" }),
      ],
      window24,
    );
    expect(entries.map((entry) => entry.clipId)).toEqual(["early", "late"]);
  });
});

describe("getStageAudioClipGainAt", () => {
  it("applies fade-in, steady volume, and fade-out", () => {
    const envelope = { volume: 0.8, fadeInSec: 1, fadeOutSec: 2, durationSec: 10 };
    expect(getStageAudioClipGainAt(envelope, 0)).toBe(0);
    expect(getStageAudioClipGainAt(envelope, 0.5)).toBeCloseTo(0.4, 6);
    expect(getStageAudioClipGainAt(envelope, 5)).toBeCloseTo(0.8, 6);
    expect(getStageAudioClipGainAt(envelope, 9)).toBeCloseTo(0.4, 6);
    expect(getStageAudioClipGainAt(envelope, 10)).toBe(0);
  });
});

type GainEvent = { type: "cancel" | "set" | "ramp"; value?: number; time: number };

class FakeAudioParam {
  events: GainEvent[] = [];
  cancelScheduledValues(time: number) {
    this.events.push({ type: "cancel", time });
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ type: "ramp", value, time });
  }
}

class FakeGainNode {
  gain = new FakeAudioParam();
  target: unknown = null;
  connect(node: unknown) {
    this.target = node;
    return node;
  }
}

class FakeBufferSourceNode {
  buffer: { duration: number } | null = null;
  starts: Array<{ when: number; offset: number; duration: number }> = [];
  stopCalls = 0;
  connectedTo: unknown = null;
  connect(node: unknown) {
    this.connectedTo = node;
    return node;
  }
  start(when: number, offset: number, duration: number) {
    this.starts.push({ when, offset, duration });
  }
  stop() {
    this.stopCalls += 1;
    if (this.starts.length === 0) throw new DOMException("never started", "InvalidStateError");
  }
}

class FakeMediaStreamTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStreamDestination {
  track = new FakeMediaStreamTrack();
  stream = {
    getTracks: () => [this.track],
    getAudioTracks: () => [this.track],
  } as unknown as MediaStream;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static decodedDurationSec = 10;
  static failDecode = false;
  currentTime = 1;
  state: AudioContextState = "suspended";
  sampleRate: number;
  destination = { kind: "speakers" };
  sources: FakeBufferSourceNode[] = [];
  gains: FakeGainNode[] = [];
  streamDestinations: FakeMediaStreamDestination[] = [];
  resumeCalls = 0;
  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate ?? 44_100;
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamDestination() {
    const destination = new FakeMediaStreamDestination();
    this.streamDestinations.push(destination);
    return destination;
  }
  createBufferSource() {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source;
  }
  createGain() {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }
  async decodeAudioData(_data: ArrayBuffer) {
    if (FakeAudioContext.failDecode) throw new Error("decode failure");
    return { duration: FakeAudioContext.decodedDurationSec } as AudioBuffer;
  }
  async resume() {
    this.resumeCalls += 1;
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
}

function stubAudioEnvironment() {
  FakeAudioContext.instances = [];
  FakeAudioContext.decodedDurationSec = 10;
  FakeAudioContext.failDecode = false;
  vi.stubGlobal("AudioContext", FakeAudioContext as unknown as typeof AudioContext);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const scheduleEntry = {
  clipId: "audio_clip_1",
  mediaId: "creative-media:audio:abc",
  name: "环境声",
  sourceUrl: "blob:ambience",
  atSec: 0.5,
  inSec: 0.25,
  durationSec: 2,
  volume: 0.8,
  fadeInSec: 1,
  startVolume: 0,
  fadeOutSec: 0.5,
  endVolume: 0,
};

describe("createDirectorStageAudioSource", () => {
  it("returns undefined without entries", async () => {
    stubAudioEnvironment();
    await expect(createDirectorStageAudioSource([])).resolves.toBeUndefined();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("builds a 48kHz stream graph and schedules sources against one origin", async () => {
    stubAudioEnvironment();
    const source = await createDirectorStageAudioSource([
      scheduleEntry,
      { ...scheduleEntry, clipId: "audio_clip_2", atSec: 1.5, fadeInSec: 0, fadeOutSec: 0, startVolume: 0.8 },
    ]);
    expect(source).toBeDefined();
    const context = FakeAudioContext.instances[0]!;
    expect(context.sampleRate).toBe(48_000);
    expect(source!.stream).toBe(context.streamDestinations[0]!.stream);

    await source!.start();
    expect(context.resumeCalls).toBe(1);
    expect(context.sources).toHaveLength(2);
    // Origin is currentTime (1) + 0.035; entries offset from it by atSec.
    expect(context.sources[0]!.starts).toEqual([{ when: 1.535, offset: 0.25, duration: 2 }]);
    expect(context.sources[1]!.starts).toEqual([{ when: 2.535, offset: 0.25, duration: 2 }]);
    // Sources route through their gain node into the stream destination.
    expect(context.sources[0]!.connectedTo).toBe(context.gains[0]);
    expect(context.gains[0]!.target).toBe(context.streamDestinations[0]);

    const events = context.gains[0]!.gain.events;
    expect(events).toEqual([
      { type: "cancel", time: 1.535 },
      { type: "set", value: 0, time: 1.535 },
      { type: "ramp", value: 0.8, time: 2.535 },
      { type: "set", value: 0.8, time: 3.035 },
      { type: "ramp", value: 0, time: 3.535 },
    ]);
  });

  it("clamps the scheduled duration to the decoded audio that remains after the trim", async () => {
    stubAudioEnvironment();
    FakeAudioContext.decodedDurationSec = 1;
    const source = await createDirectorStageAudioSource([scheduleEntry]);
    await source!.start();
    const context = FakeAudioContext.instances[0]!;
    expect(context.sources[0]!.starts).toEqual([{ when: 1.535, offset: 0.25, duration: 0.75 }]);
  });

  it("fetches and decodes each source URL once across entries", async () => {
    const fetchMock = stubAudioEnvironment();
    await createDirectorStageAudioSource([scheduleEntry, { ...scheduleEntry, clipId: "audio_clip_2", atSec: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops sources, ends stream tracks, and closes the context on stop", async () => {
    stubAudioEnvironment();
    const source = await createDirectorStageAudioSource([scheduleEntry]);
    await source!.start();
    await source!.stop();
    const context = FakeAudioContext.instances[0]!;
    expect(context.sources[0]!.stopCalls).toBe(1);
    expect(context.streamDestinations[0]!.track.stopped).toBe(true);
    expect(context.state).toBe("closed");
    // stop() is idempotent; a second call must not throw or double-close.
    await expect(source!.stop()).resolves.toBeUndefined();
  });

  it("plays straight to the speakers without a stream in rehearsal mode", async () => {
    stubAudioEnvironment();
    const source = await createDirectorStageAudioSource([scheduleEntry], { output: "speakers" });
    expect(source!.stream).toBeNull();
    await source!.start();
    const context = FakeAudioContext.instances[0]!;
    expect(context.streamDestinations).toHaveLength(0);
    expect(context.gains[0]!.target).toBe(context.destination);
  });

  it("does not schedule anything when stopped before start", async () => {
    stubAudioEnvironment();
    const source = await createDirectorStageAudioSource([scheduleEntry]);
    await source!.stop();
    await source!.start();
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0);
  });

  it("fails loudly and closes the context when a source cannot be fetched", async () => {
    stubAudioEnvironment();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    await expect(createDirectorStageAudioSource([scheduleEntry])).rejects.toThrow("环境声");
    expect(FakeAudioContext.instances[0]!.state).toBe("closed");
  });

  it("reports the clip name when decoding fails", async () => {
    stubAudioEnvironment();
    FakeAudioContext.failDecode = true;
    await expect(createDirectorStageAudioSource([scheduleEntry])).rejects.toThrow("环境声 的音频无法解码");
    expect(FakeAudioContext.instances[0]!.state).toBe("closed");
  });

  it("throws for the export path when WebAudio is missing but degrades for rehearsal", async () => {
    vi.stubGlobal("AudioContext", undefined);
    await expect(createDirectorStageAudioSource([scheduleEntry])).rejects.toThrow("不支持音频混合");
    await expect(createDirectorStageAudioSource([scheduleEntry], { output: "speakers" })).resolves.toBeUndefined();
  });

  it("aborts loading through the provided signal", async () => {
    stubAudioEnvironment();
    const controller = new AbortController();
    controller.abort();
    await expect(createDirectorStageAudioSource([scheduleEntry], { signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    );
    expect(FakeAudioContext.instances[0]!.state).toBe("closed");
  });
});
