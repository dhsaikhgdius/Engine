/**
 * Deterministic caption composer for synthetic episodes.
 *
 * LingBot-World captions "blind" video with a VLM; we have the scene graph
 * and the action log, so captions are a pure function of structured state.
 * Downstream training can treat `generator.method = "deterministic-composed"`
 * as verifiable text, distinct from VLM- or human-authored layers.
 *
 * `sceneStatic` is deliberately motion-free so scene generation can be
 * decoupled from action control. `denseTemporal` windows are clustered by
 * shared event frame (one inclusive [frame, frame] window per distinct
 * frame that has events; empty gaps are skipped). `narrative` weaves the
 * two together into a single paragraph.
 */
import { compareText } from "@director/protocol/primitives";
import {
  EPISODE_CAPTIONS_CONTRACT,
  episodeCaptionsSchema,
  type EpisodeCaptions,
  type EpisodeSemanticEvent,
  type EpisodeTimebase,
} from "@director/protocol/episode";
import type { DirectorObject, DirectorProject } from "../schema/directorProject";

/** Input for composing deterministic captions from a project snapshot and episode events. */
export interface ComposeEpisodeCaptionsInput {
  project: DirectorProject;
  events: readonly EpisodeSemanticEvent[];
  timebase: EpisodeTimebase;
  /** BCP-47 tag for the caption layers. Dataset default is English. */
  language?: string;
}

const DETERMINISTIC_GENERATOR = { method: "deterministic-composed" as const };

const SMALL_COUNTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const;

const KIND_LABELS: Record<DirectorObject["kind"], string> = {
  character: "character",
  scene: "scene asset",
  prop: "prop",
  camera: "camera",
  panorama: "panorama",
};

const LIGHT_LABELS: Record<string, string> = {
  ambient: "ambient light",
  hemisphere: "hemisphere light",
  directional: "directional light",
  point: "point light",
  spot: "spot light",
  "rect-area": "rectangular area light",
};

const WEATHER_LABELS: Record<string, string> = {
  clear: "clear weather",
  overcast: "overcast weather",
  rain: "rain",
  snow: "snow",
  storm: "stormy weather",
};

/**
 * Phrases used for known event types. Unknown types fall back to a generic
 * "event <type> occurs" sentence so conversion never throws.
 */
const EVENT_TYPE_PHRASES: Record<string, (event: EpisodeSemanticEvent) => string> = {
  "workbench.author": (event) => `the operator authors a change${entitySuffix(event)}`,
  "workbench.select": (event) => `the selection changes${entitySuffix(event)}`,
  "workbench.viewport": () => "the viewport mode changes",
  "workbench.patch": () => "the project is patched",
  "workbench.undo": () => "an undo is applied",
  "workbench.correct": () => "an audit correction is applied",
  "workbench.replace_project": () => "the project is replaced",
  "workbench.run_macro": () => "a macro is run",
  "workbench.playback": () => "playback is issued",
  "timeline.playhead": (event) => {
    const playhead = asRecord(event.payload)?.playheadFrame;
    return typeof playhead === "number"
      ? `the playhead is set to frame ${playhead}`
      : "the playhead is set";
  },
  "authoring.add_object": (event) => `object ${entityName(event)} is added`,
  "authoring.update_object": (event) => `object ${entityName(event)} is updated`,
  "authoring.delete_objects": (event) => `object ${entityName(event)} is deleted`,
  "authoring.add_camera": (event) => `camera ${entityName(event)} is added`,
  "authoring.update_camera": (event) => `camera ${entityName(event)} is updated`,
  "authoring.delete_cameras": (event) => `camera ${entityName(event)} is deleted`,
  "authoring.add_light": (event) => `light ${entityName(event)} is added`,
  "authoring.update_light": (event) => `light ${entityName(event)} is updated`,
  "authoring.set_active_camera": (event) => `the active camera is set${entitySuffix(event)}`,
  "authoring.set_character_motion": (event) => `character motion is set${entitySuffix(event)}`,
  "authoring.add_world_effect": (event) => `a world effect is added${entitySuffix(event)}`,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entityName(event: EpisodeSemanticEvent): string {
  return event.subjectId ?? event.objectId ?? "unknown";
}

function entitySuffix(event: EpisodeSemanticEvent): string {
  return event.subjectId ? ` (${event.subjectId})` : "";
}

function countWords(count: number): string {
  return count >= 0 && count < SMALL_COUNTS.length ? SMALL_COUNTS[count] : String(count);
}

function joinList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function countedPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${countWords(count)} ${count === 1 ? singular : plural}`;
}

function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const mm = String(wrapped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function groupCount<T>(items: readonly T[], keyOf: (item: T) => string): Array<{ key: string; count: number }> {
  const tallies = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    tallies.set(key, (tallies.get(key) ?? 0) + 1);
  }
  return [...tallies.entries()]
    .sort((left, right) => compareText(left[0], right[0]))
    .map(([key, count]) => ({ key, count }));
}

function namedGroup(items: readonly { name: string }[], label: string, plural = `${label}s`): string | null {
  if (items.length === 0) return null;
  const names = [...items].map((item) => item.name).sort(compareText);
  const unique = [...new Set(names)];
  const head = countedPhrase(items.length, label, plural);
  if (unique.length === items.length && unique.length <= 6) {
    return `${head} (${joinList(unique)})`;
  }
  return head;
}

function describeSceneStatic(project: DirectorProject): string {
  const sentences: string[] = [];
  const objects = [...project.objects].sort((left, right) => compareText(left.id, right.id));
  const kindGroups = groupCount(objects, (object) => object.kind).map((group) => {
    const members = objects.filter((object) => object.kind === group.key);
    const label = KIND_LABELS[group.key as DirectorObject["kind"]] ?? group.key;
    return namedGroup(members, label) ?? countedPhrase(group.count, label);
  });
  sentences.push(kindGroups.length > 0 ? `The stage contains ${joinList(kindGroups)}.` : "The stage is empty.");

  const lights = [...(project.lights ?? [])].sort((left, right) => compareText(left.id, right.id));
  if (lights.length > 0) {
    const lightGroups = groupCount(lights, (light) => light.type).map((group) => {
      const label = LIGHT_LABELS[group.key] ?? `${group.key} light`;
      const plural = label.endsWith("light") ? `${label}s` : `${label}s`;
      return countedPhrase(group.count, label, plural);
    });
    sentences.push(`Lighting consists of ${joinList(lightGroups)}.`);
  }

  const world = project.world;
  if (world?.settings.enabled) {
    const weather = WEATHER_LABELS[world.settings.weather.preset] ?? world.settings.weather.preset;
    sentences.push(`Time of day is ${formatHours(world.settings.timeOfDay.hours)}.`);
    sentences.push(`The environment has ${weather}.`);
    const water = world.waterBodies.length;
    if (water > 0) sentences.push(`The environment includes ${countedPhrase(water, "water body", "water bodies")}.`);
    const wildlife = world.wildlife
      .slice()
      .sort((left, right) => compareText(left.id, right.id))
      .map((group) => `${group.count} ${group.species}`);
    if (wildlife.length > 0) sentences.push(`Wildlife consists of ${joinList(wildlife)}.`);
    const effects = groupCount(world.effects, (effect) => effect.kind).map((group) =>
      countedPhrase(group.count, `${group.key} effect`),
    );
    if (effects.length > 0) sentences.push(`Atmospheric effects consist of ${joinList(effects)}.`);
  }

  if (project.scene.showGround) sentences.push("A ground plane is present.");
  const fog = project.scene.fog;
  if (fog?.enabled) sentences.push(`${fog.mode === "exponential" ? "Exponential" : "Linear"} fog is present.`);

  return sentences.join(" ");
}

function phraseForEvent(event: EpisodeSemanticEvent): string {
  const writer = EVENT_TYPE_PHRASES[event.type];
  if (writer) return writer(event);
  const readable = event.type.replace(/[._]/g, " ");
  return `event ${readable} occurs${entitySuffix(event)}`;
}

function clusterEvents(
  events: readonly EpisodeSemanticEvent[],
  frameCount: number,
): Array<{ frameStart: number; frameEnd: number; events: EpisodeSemanticEvent[] }> {
  const clusters: Array<{ frameStart: number; frameEnd: number; events: EpisodeSemanticEvent[] }> = [];
  for (const event of events) {
    if (!Number.isSafeInteger(event.frame) || event.frame < 0 || event.frame >= frameCount) continue;
    const last = clusters[clusters.length - 1];
    if (last && last.frameStart === event.frame) {
      last.events.push(event);
    } else {
      clusters.push({ frameStart: event.frame, frameEnd: event.frame, events: [event] });
    }
  }
  return clusters;
}

function describeCluster(cluster: { frameStart: number; events: EpisodeSemanticEvent[] }): string {
  const phrases = cluster.events.map(phraseForEvent);
  const unique = [...new Set(phrases)];
  if (cluster.frameStart === cluster.events[0]?.frame) {
    return `At frame ${cluster.frameStart}, ${joinList(unique)}.`;
  }
  return joinList(unique);
}

function describeNarrative(sceneStatic: string, clusterCaptions: readonly string[], eventCount: number): string {
  if (eventCount === 0) {
    return `${sceneStatic} No scripted events are present.`;
  }
  return `${sceneStatic} ${clusterCaptions.join(" ")}`;
}

/**
 * Composes deterministic captions for a synthetic episode from the project scene graph
 * and the action log. Produces three caption layers: sceneStatic (motion-free scene
 * description), denseTemporal (per-event-frame captions), and narrative (a single
 * paragraph weaving both together).
 *
 * The generator is marked as "deterministic-composed" so downstream training can
 * distinguish verifiable text from VLM- or human-authored captions.
 *
 * @param input - The project snapshot, events, timebase, and optional language tag.
 * @returns A validated EpisodeCaptions object.
 */
export function composeEpisodeCaptions(input: ComposeEpisodeCaptionsInput): EpisodeCaptions {
  const language = input.language ?? "en";
  const sceneStaticText = describeSceneStatic(input.project);
  const orderedEvents = input.events.map((event, index) => ({ event, index })).sort((left, right) => {
    const frameOrder = left.event.frame - right.event.frame;
    return frameOrder !== 0 ? frameOrder : left.index - right.index;
  });
  const clusters = clusterEvents(
    orderedEvents.map((item) => item.event),
    input.timebase.frameCount,
  );
  const denseEntries = clusters.map((cluster) => ({
    frameStart: cluster.frameStart,
    frameEnd: cluster.frameEnd,
    caption: describeCluster(cluster),
  }));
  const narrativeText = describeNarrative(
    sceneStaticText,
    denseEntries.map((entry) => entry.caption),
    input.events.length,
  );

  return episodeCaptionsSchema.parse({
    contract: EPISODE_CAPTIONS_CONTRACT,
    sceneStatic: {
      language,
      generator: DETERMINISTIC_GENERATOR,
      text: sceneStaticText,
    },
    narrative: {
      language,
      generator: DETERMINISTIC_GENERATOR,
      text: narrativeText,
    },
    ...(denseEntries.length > 0
      ? {
          denseTemporal: {
            language,
            generator: DETERMINISTIC_GENERATOR,
            entries: denseEntries,
          },
        }
      : {}),
  });
}
