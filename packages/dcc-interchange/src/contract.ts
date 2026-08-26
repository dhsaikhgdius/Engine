import type { DirectorProject, DirectorTimeline } from "@director/project-schema";
import { isRecord } from "@director/protocol/primitives";
import { parseDirectorProject } from "@director/project-schema";
import { getDirectorCharacterAssetBindingIssues } from "./mixamoCharacterCatalog";
import {
  createDefaultDirectorTimebase,
  frameRateToNumber,
  normalizeDirectorTimebase,
  type DirectorTimelineTimebase,
} from "@director/project-schema";

/** Contract identifier for the Director interchange manifest. */
export const DIRECTOR_INTERCHANGE_CONTRACT = "director-interchange-v1" as const;

/** The native Director and glTF space. USD exports declare the same values explicitly. */
export const DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM = Object.freeze({
  linearUnit: "meter" as const,
  metersPerUnit: 1 as const,
  upAxis: "Y" as const,
  handedness: "right" as const,
});

/** The top-level interchange manifest, carrying the project and coordinate system. */
export interface DirectorInterchangeManifest {
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  version: 1;
  coordinateSystem: typeof DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM;
  project: DirectorProject;
}

/** The result of importing a project through the interchange layer. */
export interface DirectorInterchangeImportResult {
  project: DirectorProject;
  warnings: string[];
  /**
   * Structured warn-and-omit records when the adapter stamps typed codes.
   * Free-text `warnings` remain for humans; agents prefer `omitted`.
   */
  omitted?: Array<{ code: string; subject: string; reason: string }>;
}

/**
 * Generate a stable, content-addressable identifier from a namespace and source string.
 * Uses FNV-1a 32-bit hash to produce a deterministic short suffix.
 *
 * @param namespace - The entity namespace (e.g. "object", "camera").
 * @param source - The source string to derive the ID from (e.g. the entity name).
 * @returns A stable ID in the form `{namespace}-{hash}`.
 */
export function stableDirectorInterchangeId(namespace: string, source: string) {
  let hash = 0x811c9dc5;
  const value = `${namespace}\u0000${source}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${namespace}-${(hash >>> 0).toString(36)}`;
}

/**
 * Create a validated interchange manifest from a Director project.
 * Clones the project to avoid mutating the caller's reference and asserts
 * character asset integrity before packaging.
 *
 * @param project - The Director project to wrap in a manifest.
 * @returns A validated interchange manifest.
 */
export function createDirectorInterchangeManifest(project: DirectorProject): DirectorInterchangeManifest {
  const parsedProject = parseDirectorProject(structuredClone(project));
  assertDirectorInterchangeCharacterAssets(parsedProject);
  return {
    contract: DIRECTOR_INTERCHANGE_CONTRACT,
    version: 1,
    coordinateSystem: { ...DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM },
    project: parsedProject,
  };
}

/**
 * Assert that every character object in the project has a valid, concrete asset
 * binding. Throws on the first batch of issues rather than silently exporting
 * an ambiguous scene.
 *
 * @param project - The project to validate.
 * @returns The project unchanged if valid.
 * @throws If any character has a missing, mismatched, or unregistered asset binding.
 */
export function assertDirectorInterchangeCharacterAssets(project: DirectorProject) {
  const issues = getDirectorCharacterAssetBindingIssues(project);
  if (issues.length) {
    throw new Error(`Director interchange character asset binding is invalid: ${issues.slice(0, 8).join("; ")}`);
  }
  return project;
}

/**
 * Parse and validate an interchange manifest from an untrusted value.
 * Rejects unknown contracts, mismatched coordinate systems, and invalid projects.
 *
 * @param value - The untrusted manifest value to parse.
 * @returns A validated interchange manifest.
 * @throws If the contract, coordinate system, or project is invalid.
 */
export function parseDirectorInterchangeManifest(value: unknown): DirectorInterchangeManifest {
  if (!isRecord(value) || value.contract !== DIRECTOR_INTERCHANGE_CONTRACT || value.version !== 1) {
    throw new Error("Unsupported Director interchange manifest contract");
  }
  const coordinateSystem = value.coordinateSystem;
  if (
    !isRecord(coordinateSystem) ||
    coordinateSystem.linearUnit !== "meter" ||
    coordinateSystem.metersPerUnit !== 1 ||
    coordinateSystem.upAxis !== "Y" ||
    coordinateSystem.handedness !== "right"
  ) {
    throw new Error("Director interchange requires metres, Y-up, and a right-handed coordinate system");
  }
  const project = parseDirectorProject(value.project);
  assertDirectorInterchangeCharacterAssets(project);
  return {
    contract: DIRECTOR_INTERCHANGE_CONTRACT,
    version: 1,
    coordinateSystem: { ...DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM },
    project,
  };
}

/**
 * Extract the timeline from a project, falling back to a default derived from
 * the storyboard shot range when no explicit timeline exists.
 *
 * @param project - The Director project to extract the timeline from.
 * @returns A normalized timeline with rational timebase.
 */
export function getDirectorProjectTimeline(project: DirectorProject): DirectorTimeline {
  const timeline = project.scene.timeline;
  if (timeline) {
    const timebase = normalizeDirectorTimebase(timeline.timebase, timeline.fps);
    return { ...timeline, fps: frameRateToNumber(timebase.rate), timebase };
  }
  const timebase = createDefaultDirectorTimebase();
  return {
    version: 1,
    fps: frameRateToNumber(timebase.rate),
    timebase,
    frameStart: 0,
    frameEnd: Math.max(0, ...(project.storyboard?.shots.map((shot) => Math.round(shot.frameEnd)) ?? [0])),
    currentFrame: 0,
    loop: false,
  };
}

/**
 * Create an empty Director project suitable as a base for import operations.
 * Uses sensible defaults for all scene, timeline, and storyboard fields.
 *
 * @param timebaseInput - Optional partial timebase to override the default 24 fps.
 * @returns A minimal but valid Director project.
 */
export function createEmptyDirectorInterchangeProject(
  timebaseInput?: Partial<DirectorTimelineTimebase>,
): DirectorProject {
  const timebase = normalizeDirectorTimebase(timebaseInput, timebaseInput?.rate ?? 24);
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#111827",
      panoramaYaw: 0,
      panoramaRadius: 40,
      showLabels: false,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.35,
      groundHeight: 0,
      timeline: {
        version: 1,
        fps: frameRateToNumber(timebase.rate),
        timebase,
        frameStart: 0,
        frameEnd: 0,
        currentFrame: 0,
        loop: false,
      },
    },
    assets: [],
    objects: [],
    cameras: [],
    storyboard: { version: 1, title: "Imported project", logline: "", shots: [] },
    activeCameraId: null,
    panoramaAssetId: null,
  };
}

/**
 * Normalize interchange bytes from various input types into a Uint8Array.
 *
 * @param source - Raw bytes as Uint8Array, ArrayBuffer, or Blob.
 * @returns A Uint8Array view of the data.
 */
export async function readInterchangeBytes(source: Uint8Array | ArrayBuffer | Blob) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}
