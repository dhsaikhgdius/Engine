import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  portraitRegistrySchema,
  type CameraPlanNode,
  type CharacterReference,
  type FilmCharacter,
  type PortraitRegistry,
  type ShotSpec,
  type StageReference,
} from "../../../packages/protocol/src/filmPipelineProtocol";
import { writeJsonAtomic } from "../atomicJsonFile";
import { createLimiter } from "../promiseLimiter";
import { concatVideos, extractFrameAfterFirstCut } from "./filmFfmpeg";
import type { FilmPlanningAgents, ReferenceCandidate } from "./filmPlanningAgents";
import type { FilmImageGenerator, FilmVideoGenerator } from "./filmMediaProviders";

/**
 * Film render coordinator.
 *
 * Render phase: character portraits, camera-tree keyframe propagation,
 * per-shot first/last frames, first/last-frame conditioned video clips, and
 * scene assembly. Every artifact is a file checkpoint — a crashed or cancelled
 * run resumes by skipping existing files.
 *
 * When a shot carries a white-box stage capture, that capture becomes the
 * authoritative spatial reference for the shot's frames and skips
 * transition-video camera derivation for that camera.
 */

async function fileExists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function safePathComponent(value: string) {
  const cleaned = value.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "character").slice(0, 80);
}

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolvePromise, rejectPromise) => {
      this.resolve = resolvePromise;
      this.reject = rejectPromise;
    });
  }
}

const PORTRAIT_PROMPTS = {
  front: (name: string, features: string, style: string) =>
    `Generate a full-body, front-view portrait of character ${name} based on the following description, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Gazing straight ahead. Standing with arms relaxed at sides. Natural expression.\nFeatures: ${features}\nStyle: ${style}`,
  side: (name: string) =>
    `Generate a full-body, side-view portrait of character ${name} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. Facing left. Standing with arms relaxed at sides.`,
  back: (name: string) =>
    `Generate a full-body, back-view portrait of character ${name} based on the provided front-view portrait, with a pure white background. Use a wide 16:9 landscape canvas, not a vertical portrait canvas. The character should be centered in the image, occupying the middle of the wide frame with enough horizontal empty space. No facial features should be visible.`,
} as const;

const STAGE_REFERENCE_PRIORITY_NOTE =
  "You must treat this white-box stage capture as the authoritative reference for composition, camera angle, framing and spatial blocking. Replace the mannequin figures and untextured geometry with the final styled characters and environment.";

/** Callback for reporting render progress events. */
export type FilmRenderEvent = (stage: string, message: string) => void;

/** Subset of FilmPlanningAgents needed by the render coordinator. */
export type ReferenceSelectorLike = Pick<FilmPlanningAgents, "selectReferences">;

/** Configuration for the film render coordinator. */
export type FilmRenderCoordinatorOptions = {
  planningAgents: ReferenceSelectorLike;
  imageGenerator: FilmImageGenerator;
  videoGenerator: FilmVideoGenerator;
  ffmpegPath: string;
  imageConcurrency?: number;
  videoConcurrency?: number;
  onEvent?: FilmRenderEvent;
};

/** Hook that mixes per-shot dialogue audio onto a rendered clip. */
export type ShotAudioMixHook = (input: {
  shotDirectory: string;
  spec: ShotSpec;
  characters: readonly FilmCharacter[];
  signal?: AbortSignal;
}) => Promise<string>;

/** Complete input for rendering one scene's worth of shots. */
export type SceneRenderRequest = {
  runDirectory: string;
  sceneIdx: number;
  shotSpecs: readonly ShotSpec[];
  cameraPlan: readonly CameraPlanNode[];
  characters: readonly FilmCharacter[];
  registry: PortraitRegistry;
  stageReferences: readonly StageReference[];
  aspectRatio: string;
  clipDurationSec: number | null;
  /** When provided, each shot's concat input is the returned (audio-mixed) path. */
  mixShotAudio?: ShotAudioMixHook;
  signal?: AbortSignal;
};

/**
 * Render phase: character portraits, camera-tree keyframe propagation,
 * per-shot first/last frames, first/last-frame conditioned video clips, and
 * scene assembly. Every artifact is a file checkpoint — a crashed or cancelled
 * run resumes by skipping existing files.
 *
 * When a shot carries a white-box stage capture, that capture becomes the
 * authoritative spatial reference for the shot's frames and skips
 * transition-video camera derivation for that camera.
 */
export class FilmRenderCoordinator {
  private readonly limitImage: <T>(task: () => Promise<T>) => Promise<T>;
  private readonly limitVideo: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(private readonly options: FilmRenderCoordinatorOptions) {
    this.limitImage = createLimiter(Math.max(1, options.imageConcurrency ?? 4));
    this.limitVideo = createLimiter(Math.max(1, options.videoConcurrency ?? 2));
  }

  private emit(stage: string, message: string) {
    this.options.onEvent?.(stage, message);
  }

  // -------------------------------------------------------------------------
  // Character portraits
  // -------------------------------------------------------------------------

  /**
   * Ensures front, side, and back portraits exist for every visible character.
   * Existing portraits are reused; missing ones are generated and persisted
   * to the run directory. Returns the complete portrait registry.
   *
   * @param input.runDirectory - The film run's artifact directory.
   * @param input.characters - Characters needing portraits.
   * @param input.style - Visual style description for generation prompts.
   * @param input.characterReferences - User-provided identity reference images.
   * @param input.signal - Optional abort signal.
   * @returns The complete portrait registry keyed by character name.
   */
  async ensurePortraits(input: {
    runDirectory: string;
    characters: readonly FilmCharacter[];
    style: string;
    characterReferences: readonly CharacterReference[];
    signal?: AbortSignal;
  }): Promise<PortraitRegistry> {
    const registryPath = join(input.runDirectory, "character_portraits_registry.json");
    let registry: PortraitRegistry = {};
    if (await fileExists(registryPath)) {
      registry = portraitRegistrySchema.parse(JSON.parse(await readFile(registryPath, "utf8")));
    }
    const pending = input.characters.filter((character) => character.isVisible && !registry[character.name]);
    for (const character of pending) {
      input.signal?.throwIfAborted();
      registry[character.name] = await this.generatePortraitsForCharacter({
        runDirectory: input.runDirectory,
        character,
        style: input.style,
        references: input.characterReferences.filter((reference) => reference.name === character.name),
        signal: input.signal,
      });
      await writeJsonAtomic(registryPath, registry);
      this.emit("character_portraits", `Portraits ready for ${character.name}`);
    }
    return registry;
  }

  private async generatePortraitsForCharacter(input: {
    runDirectory: string;
    character: FilmCharacter;
    style: string;
    references: readonly CharacterReference[];
    signal?: AbortSignal;
  }) {
    const character = input.character;
    const directory = join(
      input.runDirectory,
      "character_portraits",
      `${character.idx}_${safePathComponent(character.name)}`,
    );
    await mkdir(directory, { recursive: true });
    const paths = {
      front: join(directory, "front.png"),
      side: join(directory, "side.png"),
      back: join(directory, "back.png"),
    } as const;

    // User-provided identity references win over generated portraits.
    for (const reference of input.references) {
      if (!(await fileExists(paths[reference.view]))) await copyFile(reference.imagePath, paths[reference.view]);
    }

    if (!(await fileExists(paths.front))) {
      const features = `(static) ${character.staticFeatures}; (dynamic) ${character.dynamicFeatures ?? ""}`;
      const image = await this.limitImage(() =>
        this.options.imageGenerator.generateImage({
          prompt: PORTRAIT_PROMPTS.front(character.name, features, input.style),
          signal: input.signal,
        }),
      );
      await writeFile(paths.front, image);
    }

    // Side/back re-angling edits fail intermittently on some image models;
    // fall back to the front portrait instead of aborting the run.
    for (const view of ["side", "back"] as const) {
      if (await fileExists(paths[view])) continue;
      try {
        const image = await this.limitImage(() =>
          this.options.imageGenerator.generateImage({
            prompt: PORTRAIT_PROMPTS[view](character.name),
            referenceImagePaths: [paths.front],
            signal: input.signal,
          }),
        );
        await writeFile(paths[view], image);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        this.emit("character_portraits", `${view} portrait failed for ${character.name}; reusing front portrait`);
        await copyFile(paths.front, paths[view]);
      }
    }

    return {
      front: { path: paths.front, description: `A front view portrait of ${character.name}.` },
      side: { path: paths.side, description: `A side view portrait of ${character.name}.` },
      back: { path: paths.back, description: `A back view portrait of ${character.name}.` },
    };
  }

  // -------------------------------------------------------------------------
  // Scene rendering
  // -------------------------------------------------------------------------

  /**
   * Renders one complete scene: all camera frames and shot clips, then
   * assembles them into a single scene video. Already-existing artifacts
   * are skipped so the scene is safe to resume.
   *
   * @param request - Fully specified scene render request.
   * @returns The assembled scene video path and clip count.
   */
  async renderScene(request: SceneRenderRequest): Promise<{ videoPath: string; clipCount: number }> {
    const sceneDirectory = join(request.runDirectory, `scene_${request.sceneIdx}`);
    const shotDirectory = (shotIdx: number) => join(sceneDirectory, "shots", String(shotIdx));
    const specByIdx = new Map(request.shotSpecs.map((spec) => [spec.idx, spec]));

    const frameEvents = new Map<number, { firstFrame: Deferred; lastFrame: Deferred | null }>();
    for (const spec of request.shotSpecs) {
      const firstFrame = new Deferred();
      const lastFrame = spec.variationType === "small" ? null : new Deferred();
      // Guard against unhandled rejections from deferreds nobody awaits
      // after a sibling task has already failed the scene.
      firstFrame.promise.catch(() => undefined);
      lastFrame?.promise.catch(() => undefined);
      frameEvents.set(spec.idx, { firstFrame, lastFrame });
    }
    const priorityShotIdxs = new Set(
      request.cameraPlan.map((camera) => camera.parentShotIdx).filter((value): value is number => value !== null),
    );

    const settle = <T>(deferred: Deferred<T> | null | undefined, task: Promise<T>) => {
      if (deferred) task.then(deferred.resolve, deferred.reject);
      return task;
    };

    const cameraTasks = request.cameraPlan.map((camera) =>
      this.renderCameraFrames({
        request,
        camera,
        sceneDirectory,
        shotDirectory,
        specByIdx,
        frameEvents,
        priorityShotIdxs,
        settle,
      }),
    );
    const clipTasks = request.shotSpecs.map((spec) =>
      this.renderShotClip({ request, spec, shotDirectory, frameEvents }),
    );
    // A camera failure rejects every unsettled frame deferred so clip tasks
    // waiting on those frames fail instead of hanging forever.
    const cameraPhase = Promise.all(cameraTasks).catch((error: unknown) => {
      for (const events of frameEvents.values()) {
        events.firstFrame.reject(error);
        events.lastFrame?.reject(error);
      }
      throw error;
    });
    await Promise.all([cameraPhase, ...clipTasks]);

    const orderedShots = [...request.shotSpecs].sort((left, right) => left.idx - right.idx);
    const sceneVideoPath = join(sceneDirectory, "scene_video.mp4");
    if (!(await fileExists(sceneVideoPath))) {
      const concatInputs: string[] = [];
      for (const spec of orderedShots) {
        const clipPath = join(shotDirectory(spec.idx), "video.mp4");
        if (!request.mixShotAudio) {
          concatInputs.push(clipPath);
          continue;
        }
        concatInputs.push(
          await request.mixShotAudio({
            shotDirectory: shotDirectory(spec.idx),
            spec,
            characters: request.characters,
            signal: request.signal,
          }),
        );
      }
      await concatVideos(this.options.ffmpegPath, concatInputs, sceneVideoPath, request.signal);
      this.emit("scene_assembled", `Scene ${request.sceneIdx} assembled from ${orderedShots.length} clips`);
    }
    return { videoPath: sceneVideoPath, clipCount: orderedShots.length };
  }

  private portraitCandidates(
    registry: PortraitRegistry,
    characters: readonly FilmCharacter[],
    characterIdxs: readonly number[],
  ): ReferenceCandidate[] {
    const candidates: ReferenceCandidate[] = [];
    for (const characterIdx of characterIdxs) {
      const character = characters.find((candidate) => candidate.idx === characterIdx);
      const views = character ? registry[character.name] : undefined;
      if (!views) continue;
      for (const view of [views.front, views.side, views.back]) {
        candidates.push({ imagePath: view.path, description: view.description });
      }
    }
    return candidates;
  }

  private stageCandidates(request: SceneRenderRequest, shotIdx: number): ReferenceCandidate[] {
    return request.stageReferences
      .filter((reference) => reference.sceneIdx === request.sceneIdx && reference.shotIdx === shotIdx)
      .map((reference) => ({
        imagePath: reference.imagePath,
        description: `${reference.note} ${STAGE_REFERENCE_PRIORITY_NOTE}`,
      }));
  }

  /** Reference selection + image generation with a JSON checkpoint per frame. */
  private async generateFrame(input: {
    request: SceneRenderRequest;
    shotIdx: number;
    frameType: "first_frame" | "last_frame";
    frameDescription: string;
    candidates: readonly ReferenceCandidate[];
    outputPath: string;
  }) {
    const request = input.request;
    if (await fileExists(input.outputPath)) return;
    const selectorPath = join(dirname(input.outputPath), `${input.frameType}_selector_output.json`);
    let selection: { references: ReferenceCandidate[]; textPrompt: string };
    if (await fileExists(selectorPath)) {
      selection = JSON.parse(await readFile(selectorPath, "utf8")) as typeof selection;
    } else {
      selection = await this.options.planningAgents.selectReferences({
        candidates: input.candidates,
        frameDescription: input.frameDescription,
        signal: request.signal,
      });
      await writeJsonAtomic(selectorPath, selection);
    }
    const prefix = selection.references
      .map((reference, index) => `Image ${index}: ${reference.description}`)
      .join("\n");
    const image = await this.limitImage(() =>
      this.options.imageGenerator.generateImage({
        prompt: `${prefix}\n\n${selection.textPrompt}`,
        referenceImagePaths: selection.references.map((reference) => reference.imagePath),
        aspectRatio: request.aspectRatio,
        signal: request.signal,
      }),
    );
    await mkdir(dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, image);
    this.emit("frame_done", `Generated ${input.frameType} for shot ${input.shotIdx}`);
  }

  private async renderCameraFrames(context: {
    request: SceneRenderRequest;
    camera: CameraPlanNode;
    sceneDirectory: string;
    shotDirectory: (shotIdx: number) => string;
    specByIdx: Map<number, ShotSpec>;
    frameEvents: Map<number, { firstFrame: Deferred; lastFrame: Deferred | null }>;
    priorityShotIdxs: Set<number>;
    settle: <T>(deferred: Deferred<T> | null | undefined, task: Promise<T>) => Promise<T>;
  }) {
    const { request, camera, shotDirectory, specByIdx, frameEvents, priorityShotIdxs, settle } = context;
    const firstShotIdx = camera.activeShotIdxs[0];
    const firstShotSpec = specByIdx.get(firstShotIdx);
    if (!firstShotSpec) throw new Error(`Camera ${camera.idx} references missing shot ${firstShotIdx}`);
    const firstFramePath = join(shotDirectory(firstShotIdx), "first_frame.png");
    const firstShotEvents = frameEvents.get(firstShotIdx)!;

    const anchorFirstFrame = async () => {
      if (await fileExists(firstFramePath)) return;
      await mkdir(shotDirectory(firstShotIdx), { recursive: true });
      const stageRefs = this.stageCandidates(request, firstShotIdx);
      const candidates: ReferenceCandidate[] = [
        ...this.portraitCandidates(request.registry, request.characters, firstShotSpec.ffVisCharIdxs),
        ...stageRefs,
      ];

      // Camera-tree derivation is only needed when no white-box capture
      // anchors this camera: generate a hard-cut transition video from the
      // parent shot and lift the post-cut frame as the new camera's geometry.
      if (camera.parentShotIdx !== null && !stageRefs.length) {
        const parentShotIdx = camera.parentShotIdx;
        await frameEvents.get(parentShotIdx)?.firstFrame.promise;
        const parentFramePath = join(shotDirectory(parentShotIdx), "first_frame.png");
        const parentSpec = specByIdx.get(parentShotIdx);
        const transitionPath = join(shotDirectory(firstShotIdx), `transition_video_from_shot_${parentShotIdx}.mp4`);
        if (!(await fileExists(transitionPath))) {
          const transition = await this.limitVideo(() =>
            this.options.videoGenerator.generateVideoClip({
              prompt:
                `Two shots. The transition between the shots is a cut to. The style of the two shots should be consistent.` +
                `\nThe first shot description: ${parentSpec?.visualDesc ?? ""}.` +
                `\nThe second shot description: ${firstShotSpec.visualDesc}.`,
              frameImagePaths: [parentFramePath],
              durationSec: request.clipDurationSec ?? undefined,
              aspectRatio: request.aspectRatio,
              signal: request.signal,
            }),
          );
          await writeFile(transitionPath, transition);
          this.emit("transition_video", `Transition video for shot ${firstShotIdx} from shot ${parentShotIdx}`);
        }
        const newCameraPath = join(shotDirectory(firstShotIdx), `new_camera_${camera.idx}.png`);
        if (!(await fileExists(newCameraPath))) {
          await extractFrameAfterFirstCut(this.options.ffmpegPath, transitionPath, newCameraPath, {
            signal: request.signal,
          });
        }
        if (camera.missingInfo === null) {
          await copyFile(newCameraPath, firstFramePath);
          this.emit("frame_done", `Camera ${camera.idx} first frame lifted from transition video`);
          return;
        }
        candidates.push({
          imagePath: newCameraPath,
          description:
            `The composition and background are correct but some elements may be wrong. The wrong elements should be replaced.` +
            `\nWrong elements: ${camera.missingInfo}.` +
            `\nYou must select this image as the main reference and replace the characters in the image with the provided character portraits. Don't change the background.`,
        });
      }

      await this.generateFrame({
        request,
        shotIdx: firstShotIdx,
        frameType: "first_frame",
        frameDescription: firstShotSpec.ffDesc,
        candidates,
        outputPath: firstFramePath,
      });
    };

    await settle(firstShotEvents.firstFrame, anchorFirstFrame());

    const anchorCandidate: ReferenceCandidate = { imagePath: firstFramePath, description: firstShotSpec.ffDesc };
    const followUpFrame = (spec: ShotSpec, frameType: "first_frame" | "last_frame") => {
      const events = frameEvents.get(spec.idx)!;
      const deferred = frameType === "first_frame" ? events.firstFrame : events.lastFrame;
      const characterIdxs = frameType === "first_frame" ? spec.ffVisCharIdxs : spec.lfVisCharIdxs;
      const task = this.generateFrame({
        request,
        shotIdx: spec.idx,
        frameType,
        frameDescription: frameType === "first_frame" ? spec.ffDesc : spec.lfDesc || spec.ffDesc,
        candidates: [
          ...this.portraitCandidates(request.registry, request.characters, characterIdxs),
          anchorCandidate,
          ...this.stageCandidates(request, spec.idx),
        ],
        outputPath: join(shotDirectory(spec.idx), `${frameType}.png`),
      });
      return settle(deferred, task);
    };

    const priorityTasks: Promise<void>[] = [];
    const normalTasks: Promise<void>[] = [];
    if (firstShotSpec.variationType !== "small") normalTasks.push(followUpFrame(firstShotSpec, "last_frame"));
    for (const shotIdx of camera.activeShotIdxs.slice(1)) {
      const spec = specByIdx.get(shotIdx);
      if (!spec) throw new Error(`Camera ${camera.idx} references missing shot ${shotIdx}`);
      const firstFrameTask = followUpFrame(spec, "first_frame");
      (priorityShotIdxs.has(shotIdx) ? priorityTasks : normalTasks).push(firstFrameTask);
      if (spec.variationType !== "small") normalTasks.push(followUpFrame(spec, "last_frame"));
    }
    await Promise.all(priorityTasks);
    await Promise.all(normalTasks);
  }

  private async renderShotClip(context: {
    request: SceneRenderRequest;
    spec: ShotSpec;
    shotDirectory: (shotIdx: number) => string;
    frameEvents: Map<number, { firstFrame: Deferred; lastFrame: Deferred | null }>;
  }) {
    const { request, spec, shotDirectory, frameEvents } = context;
    const videoPath = join(shotDirectory(spec.idx), "video.mp4");
    if (await fileExists(videoPath)) return;
    const events = frameEvents.get(spec.idx)!;
    await events.firstFrame.promise;
    if (events.lastFrame) await events.lastFrame.promise;
    const framePaths = [join(shotDirectory(spec.idx), "first_frame.png")];
    if (events.lastFrame) framePaths.push(join(shotDirectory(spec.idx), "last_frame.png"));
    const clip = await this.limitVideo(() =>
      this.options.videoGenerator.generateVideoClip({
        prompt: `${spec.motionDesc}\n${spec.audioDesc}`.trim(),
        frameImagePaths: framePaths,
        durationSec: request.clipDurationSec ?? undefined,
        aspectRatio: request.aspectRatio,
        signal: request.signal,
      }),
    );
    await writeFile(videoPath, clip);
    this.emit("video_clip", `Generated video clip for shot ${spec.idx}`);
  }
}
