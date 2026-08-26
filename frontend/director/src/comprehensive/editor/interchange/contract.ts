import type { DirectorProject, DirectorTimeline } from "../schema/directorProject";
import { isRecord } from "../../../../../../packages/protocol/src/primitives";
import { parseDirectorProject } from "../schema/directorProjectSchema";
import { getDirectorCharacterAssetBindingIssues } from "../modelLibrary/mixamoCharacterCatalog";
import {
  createDefaultDirectorTimebase,
  frameRateToNumber,
  normalizeDirectorTimebase,
  type DirectorTimelineTimebase,
} from "../timeline/frameRate";

export const DIRECTOR_INTERCHANGE_CONTRACT = "director-interchange-v1" as const;

/** The native Director and glTF space. USD exports declare the same values explicitly. */
export const DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM = Object.freeze({
  linearUnit: "meter" as const,
  metersPerUnit: 1 as const,
  upAxis: "Y" as const,
  handedness: "right" as const,
});

/** The top-level interchange envelope that wraps a project with its contract identity. */
export interface DirectorInterchangeManifest {
  /** Must equal {@link DIRECTOR_INTERCHANGE_CONTRACT}. */
  contract: typeof DIRECTOR_INTERCHANGE_CONTRACT;
  /** Manifest format version; currently always 1. */
  version: 1;
  /** Declared coordinate system; must match {@link DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM}. */
  coordinateSystem: typeof DIRECTOR_INTERCHANGE_COORDINATE_SYSTEM;
  /** The validated Director project payload. */
  project: DirectorProject;
}

/** Result of importing a project through any interchange format. */
export interface DirectorInterchangeImportResult {
  /** The parsed and validated project. */
  project: DirectorProject;
  /** Non-fatal diagnostic messages from the import process. */
  warnings: string[];
  /**
   * Typed omit records when the format stamps them (Fountain today; Creative
   * OTIO uses its own import result). Optional for formats that only warn.
   */
  omitted?: Array<{ code: string; subject: string; reason: string }>;
}

/**
 * Produces a stable, deterministic ID from a namespace and source string.
 *
 * Uses FNV-1a hashing so the same inputs always produce the same ID,
 * independent of import order or session state.
 *
 * @param namespace - The entity type namespace (e.g. "object", "camera").
 * @param source - The source string to hash.
 * @returns A stable ID like `"object-abc123"`.
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
 * Validates and wraps a project into the standard interchange manifest.
 *
 * Throws if any character asset bindings are invalid — the interchange
 * contract requires concrete asset identities, not viewport-only fallbacks.
 *
 * @param project - The project to wrap.
 * @returns A frozen interchange manifest ready for serialization.
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
 * Interchange boundaries must never serialize a character whose visible model
 * would be guessed by the receiving application. The concrete asset identity
 * is part of the portable scene contract, not a viewport-only fallback.
 */
export function assertDirectorInterchangeCharacterAssets(project: DirectorProject) {
  const issues = getDirectorCharacterAssetBindingIssues(project);
  if (issues.length) {
    throw new Error(`Director interchange character asset binding is invalid: ${issues.slice(0, 8).join("; ")}`);
  }
  return project;
}

/**
 * Parses and validates an unknown value as a Director interchange manifest.
 *
 * Throws if the contract identifier, version, or coordinate system don't match
 * the expected values. Character asset bindings are validated as part of the
 * project parse, ensuring the receiving application never guesses asset identity.
 *
 * @param value - The untrusted value to parse.
 * @returns A validated interchange manifest.
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
 * Extracts or synthesizes a timeline from a project.
 *
 * If the project has an explicit timeline, it is normalized and returned.
 * Otherwise a default timeline is derived from the storyboard shot extents.
 *
 * @param project - The project whose timeline to extract.
 * @returns A normalized, frame-rate-aware timeline.
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
 * Creates a minimal, well-formed project with default scene settings.
 *
 * Used as a baseline when importing content that doesn't carry a full
 * project manifest.
 *
 * @param timebaseInput - Optional partial timebase to override the default 24 fps.
 * @returns A valid, empty Director project.
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
 * Normalizes interchange source bytes to a `Uint8Array`.
 *
 * Accepts the three common byte-carrying types and converts them
 * to a uniform representation for downstream parsers.
 *
 * @param source - Raw bytes from a file, network, or in-memory buffer.
 * @returns A `Uint8Array` view of the bytes.
 */
export async function readInterchangeBytes(source: Uint8Array | ArrayBuffer | Blob) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}
