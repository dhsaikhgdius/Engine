import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FilmCharacter, ShotSpec } from "../../../packages/protocol/src/filmPipelineProtocol";
import { ModelDriverHttpError, ModelDriverResponseError, redactModelDriverText } from "@director/model-provider/runtime";
import { runFfmpeg } from "./filmFfmpeg";

/**
 * Film audio pipeline: audioDesc parsing, OpenAI-compatible text-to-speech,
 * and per-shot dialogue dubbing.
 *
 * Dialogue cues in a shot's audioDesc are synthesized with a stable voice per
 * character and overlaid on the rendered clip's own soundtrack. Effect cues
 * are parsed but not synthesized in this version — video models usually bake
 * ambient sound into the clip already. Dubbing is strictly an enhancement:
 * any TTS or ffmpeg failure falls back to the original clip instead of
 * poisoning the render, so scene assembly always has a playable input.
 */

// ---------------------------------------------------------------------------
// audioDesc parsing
// ---------------------------------------------------------------------------

/** A single audio cue parsed from a shot audioDesc. */
export type AudioCue =
  | { kind: "dialogue"; speaker: string; emotion: string | null; text: string }
  | { kind: "effect"; text: string };

type DialogueCue = Extract<AudioCue, { kind: "dialogue" }>;

/** `[Speaker] name (emotion): text` / `[Sound Effect] text`, tolerant of 【】 brackets and list bullets. */
const CUE_LINE_PATTERN = /^(?:[-*•]\s*)?[[【]\s*([^\]】]*?)\s*[\]】]\s*(.*)$/;
/** Speaker rest with an (emotion) group directly before the colon; both CJK and ASCII punctuation accepted. */
const DIALOGUE_WITH_EMOTION_PATTERN = /^(.*?)\s*[（(]([^（）()]*)[）)]\s*[:：]\s*(.*)$/;
const DIALOGUE_PLAIN_PATTERN = /^([^:：]+?)\s*[:：]\s*(.*)$/;

function classifyCueTag(tag: string): "dialogue" | "effect" | null {
  const normalized = tag.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "speaker" || normalized === "dialogue" || normalized === "对白" || normalized === "台词") {
    return "dialogue";
  }
  if (normalized === "soundeffect" || normalized === "soundeffects" || normalized === "sfx" || normalized === "音效") {
    return "effect";
  }
  return null;
}

function parseDialogueRest(rest: string): Omit<DialogueCue, "kind"> | null {
  const withEmotion = DIALOGUE_WITH_EMOTION_PATTERN.exec(rest);
  if (withEmotion) {
    const speaker = withEmotion[1].trim();
    const emotion = withEmotion[2].trim();
    const text = withEmotion[3].trim();
    if (speaker && text) return { speaker, emotion: emotion || null, text };
  }
  const plain = DIALOGUE_PLAIN_PATTERN.exec(rest);
  if (plain) {
    const speaker = plain[1].trim();
    const text = plain[2].trim();
    if (speaker && text) return { speaker, emotion: null, text };
  }
  return null;
}

/** Parses a shot audioDesc; unrecognized lines become effects; empty input returns []. */
export function parseAudioCues(audioDesc: string): AudioCue[] {
  const cues: AudioCue[] = [];
  for (const rawLine of audioDesc.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tagged = CUE_LINE_PATTERN.exec(line);
    if (tagged) {
      const kind = classifyCueTag(tagged[1]);
      const rest = tagged[2].trim();
      if (kind === "dialogue") {
        const dialogue = parseDialogueRest(rest);
        // A [Speaker] line we cannot split into name and text is kept verbatim
        // as an effect so no authored intent is silently dropped.
        cues.push(dialogue ? { kind: "dialogue", ...dialogue } : { kind: "effect", text: line });
        continue;
      }
      if (kind === "effect") {
        if (rest) cues.push({ kind: "effect", text: rest });
        continue;
      }
    }
    cues.push({ kind: "effect", text: line });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Speech synthesis (OpenAI-compatible /audio/speech)
// ---------------------------------------------------------------------------

/** Parameters for a single TTS synthesis call. */
export type SpeechRequest = { text: string; voice: string; instructions?: string; signal?: AbortSignal };

/** Pluggable text-to-speech provider for the film audio pipeline. */
export interface FilmSpeechGenerator {
  /** Stable provider identifier (e.g. "speech-api:tts-1"). */
  readonly id: string;
  /** Synthesizes speech audio and returns raw audio bytes (mp3). */
  synthesizeSpeech(request: SpeechRequest): Promise<Buffer>;
}

const MAX_SPEECH_RETRIES = 2;

/** Same abort-aware sleep as modelDrivers/http.ts (private there, and we need binary responses). */
function wait(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(resolveWait, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function speechRetryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(30_000, Math.max(0, timestamp - Date.now()));
  }
  return Math.min(8_000, 250 * 2 ** attempt);
}

/** OpenAI-compatible /audio/speech endpoint (POST JSON {model, input, voice, ...} to audio bytes). */
export class OpenAiSpeechProvider implements FilmSpeechGenerator {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: { baseUrl: string; apiKey?: string; model: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.id = `speech-api:${config.model}`;
  }

  async synthesizeSpeech(request: SpeechRequest): Promise<Buffer> {
    request.signal?.throwIfAborted();
    const payload: Record<string, unknown> = {
      model: this.model,
      input: request.text,
      voice: request.voice,
      response_format: "mp3",
    };
    if (request.instructions) payload.instructions = request.instructions;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    };

    for (let attempt = 0; attempt <= MAX_SPEECH_RETRIES; attempt += 1) {
      request.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, { ...init, signal: request.signal });
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        if (attempt < MAX_SPEECH_RETRIES) {
          await wait(Math.min(8_000, 250 * 2 ** attempt), request.signal);
          continue;
        }
        const detail = redactModelDriverText(error instanceof Error ? error.message : String(error), [this.apiKey]);
        throw new ModelDriverHttpError(this.id, 0, true, `${this.id} transport failed${detail ? `: ${detail}` : ""}`);
      }

      if (response.ok) {
        const audio = Buffer.from(await response.arrayBuffer());
        if (!audio.length) throw new ModelDriverResponseError(this.id, `${this.id} returned empty audio`);
        return audio;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_SPEECH_RETRIES) {
        await wait(speechRetryDelayMs(response, attempt), request.signal);
        continue;
      }
      const body = await response.text().catch(() => "");
      const detail = redactModelDriverText(body, [this.apiKey]);
      throw new ModelDriverHttpError(
        this.id,
        response.status,
        retryable,
        `${this.id} speech request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    throw new ModelDriverHttpError(this.id, 0, true, `${this.id} speech request exhausted retries`);
  }
}

// ---------------------------------------------------------------------------
// Voice assignment and speaker matching
// ---------------------------------------------------------------------------

/** OpenAI TTS voice roster; character idx round-robins so a character keeps one voice film-wide. */
const DEFAULT_SPEECH_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

function normalizeSpeakerName(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’.,。，!！?？:：;；()（）【】[\]<>《》_—–-]+/gu, "");
}

function matchCharacterBySpeaker(characters: readonly FilmCharacter[], speaker: string): FilmCharacter | null {
  const target = normalizeSpeakerName(speaker);
  if (!target) return null;
  for (const character of characters) {
    if (normalizeSpeakerName(character.name) === target) return character;
  }
  // Loose containment covers "Alice" vs "Alice Smith" or "老渔夫" vs "老渔夫(旁白)".
  for (const character of characters) {
    const name = normalizeSpeakerName(character.name);
    if (!name) continue;
    const shorterLength = Math.min(name.length, target.length);
    if (shorterLength >= 2 && (name.includes(target) || target.includes(name))) return character;
  }
  return null;
}

function defaultVoiceForCharacter(character: FilmCharacter | null, speaker: string): string {
  if (character) return DEFAULT_SPEECH_VOICES[character.idx % DEFAULT_SPEECH_VOICES.length];
  // Unknown speakers (narrators, uncredited voices) still get a stable voice.
  const normalized = normalizeSpeakerName(speaker) || speaker;
  let hash = 0;
  for (const char of normalized) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return DEFAULT_SPEECH_VOICES[hash % DEFAULT_SPEECH_VOICES.length];
}

// ---------------------------------------------------------------------------
// Per-shot dubbing
// ---------------------------------------------------------------------------

/** Input for mixing dialogue audio onto a single rendered shot clip. */
export type ShotAudioMixRequest = {
  /** Per-shot directory containing video.mp4 and the audio/ subdirectory. */
  shotDirectory: string;
  /** The shot specification with its audioDesc dialogue cues. */
  spec: ShotSpec;
  /** Characters available for voice matching. */
  characters: readonly FilmCharacter[];
  signal?: AbortSignal;
};

/** Configuration for the per-shot audio dubbing mixer. */
export type FilmAudioMixerOptions = {
  /** Speech synthesis provider (OpenAI-compatible /audio/speech). */
  speechGenerator: FilmSpeechGenerator;
  /** Path to the ffmpeg binary. */
  ffmpegPath: string;
  /** Custom voice assignment; defaults to round-robin over the OpenAI TTS voice roster. */
  voiceForCharacter?: (character: FilmCharacter | null, speaker: string) => string;
  /** Optional event emitter for progress reporting. */
  onEvent?: (stage: string, message: string) => void;
};

const DIALOGUE_GAP_SECONDS = 0.3;
const AUDIO_EVENT_STAGE = "shot_audio";

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the -filter_complex graph: dialogues normalized to one format, joined
 * with a 0.3s gap, then laid over the clip's own soundtrack when it has one.
 * The trailing apad plus -shortest clamps everything to the video duration.
 */
function buildMixFilterGraph(dialogueCount: number, hasBaseAudio: boolean) {
  const normalize = "aformat=sample_rates=44100:channel_layouts=stereo";
  const parts: string[] = [];
  const labels: string[] = [];
  for (let index = 0; index < dialogueCount; index += 1) {
    const gap = index < dialogueCount - 1 ? `,apad=pad_dur=${DIALOGUE_GAP_SECONDS}` : "";
    parts.push(`[${index + 1}:a]${normalize}${gap}[d${index}]`);
    labels.push(`[d${index}]`);
  }
  let dubLabel = "[d0]";
  if (dialogueCount > 1) {
    parts.push(`${labels.join("")}concat=n=${dialogueCount}:v=0:a=1[dub]`);
    dubLabel = "[dub]";
  }
  if (hasBaseAudio) {
    parts.push(`[0:a]${normalize}[base]`);
    parts.push(`[base]${dubLabel}amix=inputs=2:duration=longest:normalize=0,apad[mix]`);
  } else {
    parts.push(`${dubLabel}apad[mix]`);
  }
  return parts.join(";");
}

/**
 * Per-shot dialogue dubbing mixer: parses audioDesc cues, synthesizes
 * dialogue with stable per-character voices, and overlays the result onto
 * the rendered clip. Any TTS or ffmpeg failure falls back to the original
 * clip so scene assembly always has a playable input.
 */
export class FilmAudioMixer {
  constructor(private readonly options: FilmAudioMixerOptions) {}

  private emit(message: string) {
    this.options.onEvent?.(AUDIO_EVENT_STAGE, message);
  }

  /**
   * Returns the clip path scene assembly should use: the dubbed
   * `<shotDirectory>/video_with_audio.mp4` when the shot has dialogue, or the
   * original `video.mp4` when it has none or when dubbing fails.
   */
  async mixShotAudio(request: ShotAudioMixRequest): Promise<string> {
    const originalVideoPath = join(request.shotDirectory, "video.mp4");
    const dialogues = parseAudioCues(request.spec.audioDesc).filter(
      (cue): cue is DialogueCue => cue.kind === "dialogue",
    );
    if (!dialogues.length) return originalVideoPath;

    const mixedVideoPath = join(request.shotDirectory, "video_with_audio.mp4");
    try {
      if (await fileExists(mixedVideoPath)) return mixedVideoPath;
      const dialoguePaths = await this.ensureDialogueAudio(request, dialogues);
      await this.overlayDialogueOnVideo(request, originalVideoPath, dialoguePaths, mixedVideoPath);
      this.emit(`Mixed ${dialogues.length} dialogue clip(s) into shot ${request.spec.idx}`);
      return mixedVideoPath;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.emit(`Audio mix failed for shot ${request.spec.idx}; keeping original video: ${detail}`);
      return originalVideoPath;
    }
  }

  /** Synthesizes each dialogue cue to audio/dialogue_<k>.mp3, skipping files that already exist. */
  private async ensureDialogueAudio(request: ShotAudioMixRequest, dialogues: readonly DialogueCue[]) {
    const audioDirectory = join(request.shotDirectory, "audio");
    await mkdir(audioDirectory, { recursive: true });
    const pickVoice = this.options.voiceForCharacter ?? defaultVoiceForCharacter;
    const paths: string[] = [];
    for (const [index, cue] of dialogues.entries()) {
      request.signal?.throwIfAborted();
      const audioPath = join(audioDirectory, `dialogue_${index}.mp3`);
      paths.push(audioPath);
      if (await fileExists(audioPath)) continue;
      const character = matchCharacterBySpeaker(request.characters, cue.speaker);
      const voice = pickVoice(character, cue.speaker);
      const audio = await this.options.speechGenerator.synthesizeSpeech({
        text: cue.text,
        voice,
        instructions: cue.emotion ?? undefined,
        signal: request.signal,
      });
      // Temp-write plus rename keeps a crash from leaving a truncated mp3
      // that a resumed run would mistake for a finished checkpoint.
      const stagingPath = `${audioPath}.tmp`;
      await writeFile(stagingPath, audio);
      await rename(stagingPath, audioPath);
      this.emit(
        `Synthesized dialogue ${index} for shot ${request.spec.idx} (speaker "${cue.speaker}", voice ${voice})`,
      );
    }
    return paths;
  }

  /** True when the clip has a decodable audio stream (image-to-video output is sometimes silent). */
  private async videoHasAudioStream(videoPath: string, signal?: AbortSignal) {
    try {
      await runFfmpeg(
        this.options.ffmpegPath,
        ["-loglevel", "error", "-i", videoPath, "-map", "0:a:0", "-frames:a", "1", "-f", "null", "-"],
        signal,
      );
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  private async overlayDialogueOnVideo(
    request: ShotAudioMixRequest,
    originalVideoPath: string,
    dialoguePaths: readonly string[],
    mixedVideoPath: string,
  ) {
    const hasBaseAudio = await this.videoHasAudioStream(originalVideoPath, request.signal);
    const stagingPath = join(request.shotDirectory, "video_with_audio.tmp.mp4");
    await runFfmpeg(
      this.options.ffmpegPath,
      [
        "-loglevel",
        "error",
        "-i",
        originalVideoPath,
        ...dialoguePaths.flatMap((path) => ["-i", path]),
        "-filter_complex",
        buildMixFilterGraph(dialoguePaths.length, hasBaseAudio),
        "-map",
        "0:v:0",
        "-map",
        "[mix]",
        // Video is stream-copied, so the clip's existing color metadata
        // (container colr atom / bitstream VUI) passes through untouched;
        // explicit Rec.709 tagging happens on re-encode paths (filmFfmpeg).
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-y",
        stagingPath,
      ],
      request.signal,
    );
    await rename(stagingPath, mixedVideoPath);
  }
}
