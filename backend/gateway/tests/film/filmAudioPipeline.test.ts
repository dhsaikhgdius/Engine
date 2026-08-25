import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shotSpecSchema, type FilmCharacter, type ShotSpec } from "../../../../packages/protocol/src/filmPipelineProtocol";
import {
  FilmAudioMixer,
  OpenAiSpeechProvider,
  parseAudioCues,
  type FilmSpeechGenerator,
  type SpeechRequest,
} from "../../film/filmAudioPipeline";
import { runFfmpeg } from "../../film/filmFfmpeg";

vi.mock("../../film/filmFfmpeg", () => ({
  runFfmpeg: vi.fn(),
}));

const runFfmpegMock = vi.mocked(runFfmpeg);

describe("parseAudioCues", () => {
  it("parses standard speaker and sound effect lines", () => {
    const cues = parseAudioCues(
      "[Speaker] Alice (Happy): Hello, how are you?\n" +
        "[Sound Effect] Ambient sound (supermarket background noise, shopping cart wheels rolling)",
    );
    expect(cues).toEqual([
      { kind: "dialogue", speaker: "Alice", emotion: "Happy", text: "Hello, how are you?" },
      { kind: "effect", text: "Ambient sound (supermarket background noise, shopping cart wheels rolling)" },
    ]);
  });

  it("keeps cue order across mixed multi-line input with blank lines and bullets", () => {
    const cues = parseAudioCues(
      "\n[Speaker] Alice: First line.\n\n[SOUND EFFECT] door slams\n- [speaker] Bob (angry): Second line!\n",
    );
    expect(cues).toEqual([
      { kind: "dialogue", speaker: "Alice", emotion: null, text: "First line." },
      { kind: "effect", text: "door slams" },
      { kind: "dialogue", speaker: "Bob", emotion: "angry", text: "Second line!" },
    ]);
  });

  it("tolerates full-width brackets, colons and CJK emotion parentheses", () => {
    const cues = parseAudioCues("【Speaker】爱丽丝(开心):你好呀,今天买点什么?\n[speaker] 老渔夫:出海吧。");
    expect(cues).toEqual([
      { kind: "dialogue", speaker: "爱丽丝", emotion: "开心", text: "你好呀,今天买点什么?" },
      { kind: "dialogue", speaker: "老渔夫", emotion: null, text: "出海吧。" },
    ]);
  });

  it("returns [] for empty or whitespace-only input", () => {
    expect(parseAudioCues("")).toEqual([]);
    expect(parseAudioCues("  \n\t\n")).toEqual([]);
  });

  it("treats free text and unparseable tagged lines as effects", () => {
    expect(parseAudioCues("远处传来汽笛声,雨越下越大")).toEqual([
      { kind: "effect", text: "远处传来汽笛声,雨越下越大" },
    ]);
    expect(parseAudioCues("[Speaker] Alice")).toEqual([{ kind: "effect", text: "[Speaker] Alice" }]);
    expect(parseAudioCues("[Music] soft piano theme")).toEqual([{ kind: "effect", text: "[Music] soft piano theme" }]);
  });
});

describe("OpenAiSpeechProvider", () => {
  it("posts an OpenAI-compatible speech request and returns the audio bytes", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(Buffer.from("mp3-bytes"), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiSpeechProvider({
      baseUrl: "https://tts.example.com/v1/",
      apiKey: "sk-test-secret",
      model: "gpt-4o-mini-tts",
      fetchImpl,
    });

    const audio = await provider.synthesizeSpeech({
      text: "Hello, how are you?",
      voice: "nova",
      instructions: "Happy",
    });

    expect(audio.toString("utf8")).toBe("mp3-bytes");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://tts.example.com/v1/audio/speech");
    expect(requests[0].init?.method).toBe("POST");
    expect(requests[0].init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-test-secret",
    });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Hello, how are you?",
      voice: "nova",
      response_format: "mp3",
      instructions: "Happy",
    });
  });

  it("omits instructions and the auth header when they are not configured", async () => {
    const requests: { init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ init });
      return new Response(Buffer.from("ok"), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiSpeechProvider({ baseUrl: "https://tts.example.com/v1", model: "tts-1", fetchImpl });

    await provider.synthesizeSpeech({ text: "hi", voice: "alloy" });

    expect(requests[0].init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      model: "tts-1",
      input: "hi",
      voice: "alloy",
      response_format: "mp3",
    });
  });

  it("fails closed on 401 without leaking the api key and without retrying", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-super-secret" } }), {
          status: 401,
        }),
    ) as typeof fetch;
    const provider = new OpenAiSpeechProvider({
      baseUrl: "https://tts.example.com/v1",
      apiKey: "sk-super-secret",
      model: "tts-1",
      fetchImpl,
    });

    const failure = await provider.synthesizeSpeech({ text: "hi", voice: "alloy" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("401");
    expect((failure as Error).message).not.toContain("sk-super-secret");
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("retries transport failures and 429s before succeeding", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      if (attempt === 2) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
      return new Response(Buffer.from("recovered"), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiSpeechProvider({ baseUrl: "https://tts.example.com/v1", model: "tts-1", fetchImpl });

    const audio = await provider.synthesizeSpeech({ text: "hi", voice: "alloy" });

    expect(audio.toString("utf8")).toBe("recovered");
    expect(attempt).toBe(3);
  });

  it("throws promptly when the signal is already aborted", async () => {
    const fetchImpl = vi.fn() as typeof fetch;
    const provider = new OpenAiSpeechProvider({ baseUrl: "https://tts.example.com/v1", model: "tts-1", fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesizeSpeech({ text: "hi", voice: "alloy", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });
});

describe("FilmAudioMixer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  beforeEach(() => {
    runFfmpegMock.mockReset();
    runFfmpegMock.mockImplementation(async (_ffmpegPath, args) => {
      if (args.includes("-filter_complex")) await writeFile(args[args.length - 1], "mixed-video");
      return "";
    });
  });

  async function newShotDirectory() {
    const dir = await mkdtemp(join(tmpdir(), "director-film-audio-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "video.mp4"), "original-video");
    return dir;
  }

  function shotSpec(audioDesc: string, idx = 0): ShotSpec {
    return shotSpecSchema.parse({
      idx,
      camIdx: 0,
      visualDesc: `visual ${idx}`,
      variationType: "small",
      ffDesc: `ff ${idx}`,
      motionDesc: `motion ${idx}`,
      audioDesc,
    });
  }

  function character(idx: number, name: string): FilmCharacter {
    return { idx, name, isVisible: true, staticFeatures: "", dynamicFeatures: null };
  }

  function fakeSpeechGenerator() {
    const calls: SpeechRequest[] = [];
    const generator: FilmSpeechGenerator = {
      id: "fake-speech",
      async synthesizeSpeech(request) {
        request.signal?.throwIfAborted();
        calls.push(request);
        return Buffer.from(`mp3|${request.voice}|${request.text}`);
      },
    };
    return { generator, calls };
  }

  function mixFilterGraph() {
    const call = runFfmpegMock.mock.calls.find(([, args]) => args.includes("-filter_complex"));
    expect(call).toBeDefined();
    const args = call![1];
    return { args, graph: args[args.indexOf("-filter_complex") + 1] };
  }

  it("returns the original clip untouched when there is no dialogue", async () => {
    const dir = await newShotDirectory();
    const { generator, calls } = fakeSpeechGenerator();
    const mixer = new FilmAudioMixer({ speechGenerator: generator, ffmpegPath: "ffmpeg" });

    const result = await mixer.mixShotAudio({
      shotDirectory: dir,
      spec: shotSpec("[Sound Effect] rain on the window"),
      characters: [character(0, "Alice")],
    });

    expect(result).toBe(join(dir, "video.mp4"));
    expect(calls).toHaveLength(0);
    expect(runFfmpegMock).not.toHaveBeenCalled();
  });

  it("synthesizes dialogue, mixes over the base track and resumes without repeat work", async () => {
    const dir = await newShotDirectory();
    const { generator, calls } = fakeSpeechGenerator();
    const events: string[] = [];
    const mixer = new FilmAudioMixer({
      speechGenerator: generator,
      ffmpegPath: "ffmpeg",
      onEvent: (stage, message) => events.push(`${stage}: ${message}`),
    });
    const request = {
      shotDirectory: dir,
      spec: shotSpec("[Speaker] Alice (Happy): Hello!\n[Sound Effect] wind\n[Speaker] Bob: Hi."),
      characters: [character(0, "Alice"), character(3, "Bob")],
    };

    const result = await mixer.mixShotAudio(request);

    expect(result).toBe(join(dir, "video_with_audio.mp4"));
    expect(await readFile(result, "utf8")).toBe("mixed-video");
    expect(calls.map((call) => call.text)).toEqual(["Hello!", "Hi."]);
    expect(calls[0].instructions).toBe("Happy");
    expect(calls[1].instructions).toBeUndefined();
    expect(calls[0].voice).not.toBe(calls[1].voice);
    expect(await readFile(join(dir, "audio", "dialogue_0.mp3"), "utf8")).toBe(`mp3|${calls[0].voice}|Hello!`);
    expect(await readFile(join(dir, "audio", "dialogue_1.mp3"), "utf8")).toBe(`mp3|${calls[1].voice}|Hi.`);

    const { args, graph } = mixFilterGraph();
    expect(graph).toContain("apad=pad_dur=0.3");
    expect(graph).toContain("concat=n=2:v=0:a=1[dub]");
    expect(graph).toContain("[0:a]");
    expect(graph).toContain("amix=inputs=2:duration=longest:normalize=0");
    expect(args.join(" ")).toContain("-c:v copy");
    // Stream copy carries the source color metadata through unchanged, so the
    // dub mix must not inject encoder color flags of its own.
    expect(args).not.toContain("-color_primaries");
    expect(args.join(" ")).toContain("-c:a aac");
    expect(args).toContain("-shortest");
    expect(events.some((entry) => entry.startsWith("shot_audio:"))).toBe(true);

    // Audio-stream probe plus the mix itself.
    const ffmpegCallsAfterFirstMix = runFfmpegMock.mock.calls.length;
    expect(ffmpegCallsAfterFirstMix).toBe(2);

    const resumed = await mixer.mixShotAudio(request);
    expect(resumed).toBe(result);
    expect(calls).toHaveLength(2);
    expect(runFfmpegMock.mock.calls.length).toBe(ffmpegCallsAfterFirstMix);
  });

  it("skips synthesis for dialogue files already on disk", async () => {
    const dir = await newShotDirectory();
    await mkdir(join(dir, "audio"), { recursive: true });
    await writeFile(join(dir, "audio", "dialogue_0.mp3"), "existing");
    const { generator, calls } = fakeSpeechGenerator();
    const mixer = new FilmAudioMixer({ speechGenerator: generator, ffmpegPath: "ffmpeg" });

    const result = await mixer.mixShotAudio({
      shotDirectory: dir,
      spec: shotSpec("[Speaker] Alice: Only line."),
      characters: [character(0, "Alice")],
    });

    expect(result).toBe(join(dir, "video_with_audio.mp4"));
    expect(calls).toHaveLength(0);
    expect(await readFile(join(dir, "audio", "dialogue_0.mp3"), "utf8")).toBe("existing");
  });

  it("mixes dialogue alone when the clip has no audio stream", async () => {
    runFfmpegMock.mockImplementation(async (_ffmpegPath, args) => {
      if (args.includes("-frames:a")) throw new Error("Stream map '0:a:0' matches no streams.");
      if (args.includes("-filter_complex")) await writeFile(args[args.length - 1], "mixed-video");
      return "";
    });
    const dir = await newShotDirectory();
    const { generator } = fakeSpeechGenerator();
    const mixer = new FilmAudioMixer({ speechGenerator: generator, ffmpegPath: "ffmpeg" });

    const result = await mixer.mixShotAudio({
      shotDirectory: dir,
      spec: shotSpec("[Speaker] Alice: Hello there."),
      characters: [character(0, "Alice")],
    });

    expect(result).toBe(join(dir, "video_with_audio.mp4"));
    const { graph } = mixFilterGraph();
    expect(graph).not.toContain("[0:a]");
    expect(graph).not.toContain("amix");
    expect(graph).toContain("[d0]apad[mix]");
  });

  it("keeps the original clip when synthesis fails", async () => {
    const dir = await newShotDirectory();
    const generator: FilmSpeechGenerator = {
      id: "broken-speech",
      async synthesizeSpeech() {
        throw new Error("TTS quota exhausted");
      },
    };
    const events: string[] = [];
    const mixer = new FilmAudioMixer({
      speechGenerator: generator,
      ffmpegPath: "ffmpeg",
      onEvent: (stage, message) => events.push(`${stage}: ${message}`),
    });

    const result = await mixer.mixShotAudio({
      shotDirectory: dir,
      spec: shotSpec("[Speaker] Alice: Hello!"),
      characters: [],
    });

    expect(result).toBe(join(dir, "video.mp4"));
    expect(events.some((entry) => entry.includes("TTS quota exhausted"))).toBe(true);
    expect(runFfmpegMock.mock.calls.filter(([, args]) => args.includes("-filter_complex"))).toHaveLength(0);
  });

  it("keeps the original clip when ffmpeg mixing fails but retains synthesized audio", async () => {
    runFfmpegMock.mockImplementation(async (_ffmpegPath, args) => {
      if (args.includes("-filter_complex")) throw new Error("Invalid filtergraph");
      return "";
    });
    const dir = await newShotDirectory();
    const { generator, calls } = fakeSpeechGenerator();
    const events: string[] = [];
    const mixer = new FilmAudioMixer({
      speechGenerator: generator,
      ffmpegPath: "ffmpeg",
      onEvent: (stage, message) => events.push(`${stage}: ${message}`),
    });

    const result = await mixer.mixShotAudio({
      shotDirectory: dir,
      spec: shotSpec("[Speaker] Alice: Hello!"),
      characters: [character(0, "Alice")],
    });

    expect(result).toBe(join(dir, "video.mp4"));
    expect(calls).toHaveLength(1);
    expect(await readFile(join(dir, "audio", "dialogue_0.mp3"), "utf8")).toBe(`mp3|${calls[0].voice}|Hello!`);
    expect(events.some((entry) => entry.includes("Invalid filtergraph"))).toBe(true);
  });

  it("propagates aborts instead of degrading", async () => {
    const dir = await newShotDirectory();
    const { generator, calls } = fakeSpeechGenerator();
    const mixer = new FilmAudioMixer({ speechGenerator: generator, ffmpegPath: "ffmpeg" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      mixer.mixShotAudio({
        shotDirectory: dir,
        spec: shotSpec("[Speaker] Alice: Hello!"),
        characters: [character(0, "Alice")],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("assigns deterministic default voices and matches speakers loosely", async () => {
    const dirA = await newShotDirectory();
    const dirB = await newShotDirectory();
    const { generator, calls } = fakeSpeechGenerator();
    const mixer = new FilmAudioMixer({ speechGenerator: generator, ffmpegPath: "ffmpeg" });
    const characters = [character(0, "Alice"), character(1, "Bob")];

    await mixer.mixShotAudio({
      shotDirectory: dirA,
      spec: shotSpec("[Speaker] ALICE: Line one.\n[Speaker] Narrator: Voice over."),
      characters,
    });
    await mixer.mixShotAudio({
      shotDirectory: dirB,
      spec: shotSpec("[Speaker] Alice Smith: Line two.\n[Speaker] narrator: More voice over.", 1),
      characters,
    });

    // "ALICE" and "Alice Smith" both resolve to character Alice, keeping one voice film-wide.
    expect(calls[2].voice).toBe(calls[0].voice);
    // Speakers without a character entry still get a stable voice across shots.
    expect(calls[3].voice).toBe(calls[1].voice);
    expect(calls.every((call) => call.voice.length > 0)).toBe(true);
  });

  it("lets integrators override voice selection and passes emotion as instructions", async () => {
    const dir = await newShotDirectory();
    const { generator, calls } = fakeSpeechGenerator();
    const mixer = new FilmAudioMixer({
      speechGenerator: generator,
      ffmpegPath: "ffmpeg",
      voiceForCharacter: (matched, speaker) => (matched ? `char-${matched.idx}` : `guest-${speaker}`),
    });

    await mixer.mixShotAudio({
      shotDirectory: dir,
      spec: shotSpec("[Speaker] 爱丽丝(轻声):慢一点。\n[Speaker] 路人甲: 让让。"),
      characters: [character(7, "爱丽丝")],
    });

    expect(calls.map((call) => call.voice)).toEqual(["char-7", "guest-路人甲"]);
    expect(calls[0].instructions).toBe("轻声");
  });
});
