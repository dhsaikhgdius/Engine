import type { DirectorCameraAspectRatio, DirectorCameraSensorFormat } from "./directorProject";
import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getDirectorCameraUsedSensorHeight,
} from "./cameraGeometry";

/**
 * Director film language: one shared, pure implementation that converts
 * Stage geometry into crew vocabulary (shot size, view, camera level, lens)
 * and crew vocabulary back into a physical camera pose.
 *
 * The Stage HUD, workbench observe/audit, the frame_shot author action, and
 * generation prompt assembly all consume this module so the UI and agents can
 * never disagree about what, say, a 50 mm eye-level medium three-quarter is.
 *
 * All positions are metric metres with floor-pivot conventions: a subject's
 * position is the point where it meets the ground.
 */

/** Shot sizes ordered wide to tight; extends the storyboard wide/full/medium naming. */
export const DIRECTOR_SHOT_SIZE_IDS = [
  "extreme-wide",
  "wide",
  "full",
  "medium",
  "medium-close-up",
  "close-up",
  "extreme-close-up",
] as const;
export type DirectorShotSize = (typeof DIRECTOR_SHOT_SIZE_IDS)[number];

/** Horizontal view of the subject, named from the subject's own facing. */
export const DIRECTOR_SHOT_VIEW_IDS = ["front", "front-quarter", "profile", "rear-quarter", "back"] as const;
export type DirectorShotView = (typeof DIRECTOR_SHOT_VIEW_IDS)[number];

/** Which of the subject's sides the camera occupies for quarter/profile views. */
export const DIRECTOR_SHOT_SIDE_IDS = ["left", "right"] as const;
export type DirectorShotSide = (typeof DIRECTOR_SHOT_SIDE_IDS)[number];

/** Camera level named by where the lens physically rides, the way a crew calls it. */
export const DIRECTOR_SHOT_LEVEL_IDS = ["ground", "knee", "hip", "chest", "eye", "high", "overhead"] as const;
export type DirectorShotLevel = (typeof DIRECTOR_SHOT_LEVEL_IDS)[number];

/** Simplified-Chinese source labels for shot sizes (matches storyboard naming style). */
export const DIRECTOR_SHOT_SIZE_LABELS: Record<DirectorShotSize, string> = {
  "extreme-wide": "大远景",
  wide: "远景",
  full: "全景",
  medium: "中景",
  "medium-close-up": "中近景",
  "close-up": "近景",
  "extreme-close-up": "大特写",
};

/** Simplified-Chinese source labels for views. */
export const DIRECTOR_SHOT_VIEW_LABELS: Record<DirectorShotView, string> = {
  front: "正面",
  "front-quarter": "前侧",
  profile: "侧面",
  "rear-quarter": "后侧",
  back: "背面",
};

/** Simplified-Chinese source labels for camera sides. */
export const DIRECTOR_SHOT_SIDE_LABELS: Record<DirectorShotSide, string> = {
  left: "左",
  right: "右",
};

/** Simplified-Chinese source labels for camera levels. */
export const DIRECTOR_SHOT_LEVEL_LABELS: Record<DirectorShotLevel, string> = {
  ground: "贴地",
  knee: "膝位",
  hip: "腰位",
  chest: "胸位",
  eye: "眼平",
  high: "俯拍",
  overhead: "顶拍",
};

/**
 * A working prime set. Crews carry discrete glass, and generation models have
 * seen far more captions that say "35mm" than "47mm", so reported focal
 * lengths snap to this ladder while the exact value stays available.
 */
export const DIRECTOR_FILM_PRIME_LENSES_MM = [16, 20, 24, 28, 35, 50, 65, 85, 105, 135] as const;

/** Default standing height in metres when a subject provides none. */
export const DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M = 1.72;

// How much of the frame height the full subject occupies for each size.
// A value above 1 means the figure overflows the frame (framed tighter than
// full body). aimFraction is where on the body the lens is pointed, as a
// fraction of standing height.
const SIZE_PROFILES: Record<DirectorShotSize, { fraction: number; defaultLensMm: number; aimFraction: number }> = {
  "extreme-wide": { fraction: 0.16, defaultLensMm: 20, aimFraction: 0.5 },
  wide: { fraction: 0.4, defaultLensMm: 24, aimFraction: 0.5 },
  full: { fraction: 0.8, defaultLensMm: 35, aimFraction: 0.5 },
  medium: { fraction: 1.02, defaultLensMm: 50, aimFraction: 0.68 },
  "medium-close-up": { fraction: 1.32, defaultLensMm: 65, aimFraction: 0.78 },
  "close-up": { fraction: 1.85, defaultLensMm: 85, aimFraction: 0.86 },
  "extreme-close-up": { fraction: 3.1, defaultLensMm: 105, aimFraction: 0.9 },
};

// Classification bands sit at the geometric midpoints between the size
// profiles above so a solved framing always classifies back to its intent.
const SIZE_BANDS: ReadonlyArray<[number, DirectorShotSize]> = [
  [2.4, "extreme-close-up"],
  [1.55, "close-up"],
  [1.16, "medium-close-up"],
  [0.9, "medium"],
  [0.56, "full"],
  [0.26, "wide"],
  [Number.NEGATIVE_INFINITY, "extreme-wide"],
];

// Lens height as a fraction of subject standing height for each level.
const LEVEL_RATIOS: Record<DirectorShotLevel, number> = {
  ground: 0.09,
  knee: 0.33,
  hip: 0.56,
  chest: 0.74,
  eye: 0.94,
  high: 1.28,
  overhead: 1.9,
};

// Classification bands between the level ratios above.
const LEVEL_BANDS: ReadonlyArray<[number, DirectorShotLevel]> = [
  [1.5, "overhead"],
  [1.1, "high"],
  [0.83, "eye"],
  [0.65, "chest"],
  [0.45, "hip"],
  [0.2, "knee"],
  [Number.NEGATIVE_INFINITY, "ground"],
];

// Azimuth offset from the subject's facing for each view, in radians.
const VIEW_OFFSETS: Record<DirectorShotView, number> = {
  front: 0,
  "front-quarter": Math.PI / 4,
  profile: Math.PI / 2,
  "rear-quarter": (Math.PI * 3) / 4,
  back: Math.PI,
};

// Facing/to-camera alignment bands: |cos| above FRONT_BACK_COS reads as dead
// front/back; below QUARTER_COS reads as profile; between is a quarter view.
const FRONT_BACK_COS = 0.885;
const QUARTER_COS = 0.37;

// The framing pivot the distance is measured to, as a fraction of standing
// height. A camera craned to the floor is still close to the body it points
// at; measuring to a mid-body pivot reports that honestly.
const FRAMING_PIVOT_FRACTION = 0.72;

// A lens physically cannot sit closer to the pivot than this.
const MIN_CAMERA_DISTANCE_M = 0.45;
// Fraction of the camera-to-pivot distance the vertical rise may consume
// before the requested level becomes geometrically unreachable.
const MAX_ELEVATION_FRACTION = 0.985;

const pickBand = <T>(bands: ReadonlyArray<[number, T]>, value: number): T =>
  (bands.find(([threshold]) => value >= threshold) ?? bands[bands.length - 1])[1];

/** Optics the film-language math needs to reason about a framing. */
export interface DirectorFramingOptics {
  aspectRatio?: DirectorCameraAspectRatio;
  sensorFormat?: DirectorCameraSensorFormat;
}

/** A subject to frame: floor-pivot ground position, facing yaw, standing height. */
export interface DirectorFramingSubject {
  /** Floor-pivot world position in metres; y is the ground under the subject. */
  position: [number, number, number];
  /** Yaw around +Y in radians; 0 faces +Z, matching object transform rotation. */
  yawRad: number;
  /** Standing height in metres. */
  heightM: number;
}

/** A physical camera framing: lens (view) position, aim target, and glass. */
export interface DirectorCameraFraming {
  /** Lens world position in metres (the view position, not the rig pivot). */
  position: [number, number, number];
  /** World point the lens is aimed at. */
  target: [number, number, number];
  focalLengthMm: number;
  aspectRatio?: DirectorCameraAspectRatio;
  sensorFormat?: DirectorCameraSensorFormat;
}

/** The derived crew vocabulary for one camera/subject pair. */
export interface DirectorShotLanguage {
  size: DirectorShotSize;
  view: DirectorShotView;
  /** Camera side for quarter/profile views; null for dead front/back. */
  side: DirectorShotSide | null;
  level: DirectorShotLevel;
  /** Nearest prime from the working lens set. */
  focalLengthMm: number;
  /** The exact measured focal length before prime snapping. */
  exactFocalLengthMm: number;
  /** Camera-to-pivot distance in metres. */
  distanceM: number;
  /** Fraction of the frame height the full subject occupies (may exceed 1). */
  subjectScreenFraction: number;
  /** Camera pitch relative to the subject's upper body, in degrees. */
  elevationDeg: number;
  /** Lens height above the subject's ground, in metres. */
  cameraHeightM: number;
}

function usedGateHeightMm(optics: DirectorFramingOptics): number {
  return getDirectorCameraUsedSensorHeight(
    optics.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
    optics.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  );
}

/** Tangent of the half vertical field of view for a focal length on the cropped gate. */
function tanHalfVerticalFov(focalLengthMm: number, optics: DirectorFramingOptics): number {
  return usedGateHeightMm(optics) / (2 * Math.max(focalLengthMm, 1));
}

/** Snaps a measured focal length to the nearest prime in the working set. */
export function nearestDirectorPrimeLensMm(focalLengthMm: number): number {
  return DIRECTOR_FILM_PRIME_LENSES_MM.reduce((best, candidate) =>
    Math.abs(candidate - focalLengthMm) < Math.abs(best - focalLengthMm) ? candidate : best,
  );
}

/**
 * Derives crew vocabulary from raw camera and subject geometry.
 *
 * Size comes from how much of the frame height the subject occupies at its
 * measured distance, level from how high the lens physically rides relative
 * to the subject, and view/side from where the camera sits around the
 * subject's facing. The same bands drive {@link solveDirectorShotFraming},
 * so a solved intent always derives back to itself.
 */
export function deriveDirectorShotLanguage(
  framing: DirectorCameraFraming,
  subject: DirectorFramingSubject,
): DirectorShotLanguage {
  const heightM = subject.heightM > 0 ? subject.heightM : DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M;
  const pivotY = subject.position[1] + heightM * FRAMING_PIVOT_FRACTION;
  const dx = framing.position[0] - subject.position[0];
  const dz = framing.position[2] - subject.position[2];
  const dy = framing.position[1] - pivotY;
  const horizontal = Math.hypot(dx, dz);
  const distanceM = Math.max(Math.hypot(horizontal, dy), 1e-6);

  const tanHalf = tanHalfVerticalFov(framing.focalLengthMm, framing);
  const subjectScreenFraction = heightM / (2 * distanceM * tanHalf);
  const size = pickBand(SIZE_BANDS, subjectScreenFraction);

  const cameraHeightM = framing.position[1] - subject.position[1];
  const level = pickBand(LEVEL_BANDS, cameraHeightM / heightM);

  const facing = { x: Math.sin(subject.yawRad), z: Math.cos(subject.yawRad) };
  const safeHorizontal = Math.max(horizontal, 1e-6);
  const toCamera = { x: dx / safeHorizontal, z: dz / safeHorizontal };
  const alignment = facing.x * toCamera.x + facing.z * toCamera.z;
  const sideSign = facing.x * toCamera.z - facing.z * toCamera.x;
  const side: DirectorShotSide = sideSign >= 0 ? "right" : "left";

  let view: DirectorShotView;
  if (alignment >= FRONT_BACK_COS) view = "front";
  else if (alignment <= -FRONT_BACK_COS) view = "back";
  else if (alignment > QUARTER_COS) view = "front-quarter";
  else if (alignment < -QUARTER_COS) view = "rear-quarter";
  else view = "profile";

  const elevationDeg = (Math.atan2(framing.position[1] - heightM * 0.94 - subject.position[1], safeHorizontal) * 180) / Math.PI;

  return {
    size,
    view,
    side: view === "front" || view === "back" ? null : side,
    level,
    focalLengthMm: nearestDirectorPrimeLensMm(framing.focalLengthMm),
    exactFocalLengthMm: framing.focalLengthMm,
    distanceM,
    subjectScreenFraction,
    elevationDeg,
    cameraHeightM,
  };
}

/** A physical constraint the solver had to resolve while honouring the intent. */
export interface DirectorFramingAdjustment {
  code: "lens-extended" | "level-flattened";
  message: string;
}

/** Declarative framing intent consumed by frame_shot and the framing solver. */
export interface DirectorShotFramingIntent extends DirectorFramingOptics {
  size?: DirectorShotSize;
  view?: DirectorShotView;
  side?: DirectorShotSide;
  level?: DirectorShotLevel;
  /** Explicit lens; omitted picks the conventional prime for the size. */
  focalLengthMm?: number;
}

/** The solved camera pose plus any physical adjustments that were required. */
export interface DirectorShotFramingSolution {
  /** Lens world position (view position). */
  position: [number, number, number];
  /** World aim point. */
  target: [number, number, number];
  focalLengthMm: number;
  distanceM: number;
  adjustments: DirectorFramingAdjustment[];
}

function nextLongerPrime(focalLengthMm: number): number | null {
  for (const prime of DIRECTOR_FILM_PRIME_LENSES_MM) {
    if (prime > focalLengthMm + 1e-6) return prime;
  }
  return null;
}

/**
 * Places a camera from cinematic intent relative to a subject.
 *
 * When the requested size is physically unreachable on the requested lens —
 * an extreme close-up on a wide lens would put the camera inside the subject,
 * or an overhead level would need more rise than the working distance allows —
 * the solver lengthens the lens along the prime ladder and reports that as an
 * adjustment instead of failing silently. Only when the longest prime still
 * cannot buy enough distance does it flatten the level and report that too.
 */
export function solveDirectorShotFraming(
  intent: DirectorShotFramingIntent,
  subject: DirectorFramingSubject,
): DirectorShotFramingSolution {
  const size = intent.size ?? "medium";
  const view = intent.view ?? "front-quarter";
  const side = intent.side ?? "right";
  const level = intent.level ?? "eye";
  const heightM = subject.heightM > 0 ? subject.heightM : DIRECTOR_DEFAULT_SUBJECT_HEIGHT_M;
  const profile = SIZE_PROFILES[size];
  const adjustments: DirectorFramingAdjustment[] = [];

  const groundY = subject.position[1];
  const pivotY = groundY + heightM * FRAMING_PIVOT_FRACTION;
  let cameraY = groundY + heightM * LEVEL_RATIOS[level];

  let focalLengthMm = intent.focalLengthMm ?? profile.defaultLensMm;
  const requestedLensMm = focalLengthMm;
  const minDistance = Math.max(MIN_CAMERA_DISTANCE_M, heightM * 0.2);

  const distanceFor = (lensMm: number) => heightM / (2 * profile.fraction * tanHalfVerticalFov(lensMm, intent));
  const requiredDistance = () => Math.max(minDistance, Math.abs(cameraY - pivotY) / MAX_ELEVATION_FRACTION);

  let distanceM = distanceFor(focalLengthMm);
  while (distanceM < requiredDistance()) {
    const longer = nextLongerPrime(focalLengthMm);
    if (longer === null) break;
    focalLengthMm = longer;
    distanceM = distanceFor(focalLengthMm);
  }
  if (focalLengthMm !== requestedLensMm) {
    adjustments.push({
      code: "lens-extended",
      message: `${requestedLensMm}mm cannot hold a ${size} framing at a workable distance; the lens was extended to ${focalLengthMm}mm.`,
    });
  }
  if (distanceM < requiredDistance()) {
    // Even the longest prime cannot buy the rise: flatten the level onto the
    // reachable sphere instead of placing the camera inside the subject.
    const rise = Math.sign(cameraY - pivotY) * distanceM * MAX_ELEVATION_FRACTION;
    cameraY = pivotY + rise;
    const flattened = pickBand(LEVEL_BANDS, (cameraY - groundY) / heightM);
    adjustments.push({
      code: "level-flattened",
      message: `A ${level} level is out of reach at this distance; the camera rides at ${flattened} level instead.`,
    });
  }

  const rise = cameraY - pivotY;
  const horizontal = Math.sqrt(Math.max(distanceM * distanceM - rise * rise, 4e-4));
  const sideSign = side === "right" ? 1 : -1;
  const azimuth = subject.yawRad - sideSign * VIEW_OFFSETS[view];
  const position: [number, number, number] = [
    subject.position[0] + Math.sin(azimuth) * horizontal,
    cameraY,
    subject.position[2] + Math.cos(azimuth) * horizontal,
  ];
  const target: [number, number, number] = [
    subject.position[0],
    groundY + heightM * profile.aimFraction,
    subject.position[2],
  ];
  return { position, target, focalLengthMm, distanceM, adjustments };
}

/** English phrase fragments generation prompts can claim from measured geometry. */
const SIZE_PHRASES: Record<DirectorShotSize, string> = {
  "extreme-wide": "extreme wide shot",
  wide: "wide shot",
  full: "full shot",
  medium: "medium shot",
  "medium-close-up": "medium close-up",
  "close-up": "close-up",
  "extreme-close-up": "extreme close-up",
};

const LEVEL_PHRASES: Record<DirectorShotLevel, string> = {
  ground: "a dramatic ground-level angle looking up at the subject",
  knee: "a low knee-level angle looking up at the subject",
  hip: "a low hip-level angle",
  chest: "chest level",
  eye: "eye level",
  high: "a high angle looking down at the subject",
  overhead: "a top-down overhead view of the subject",
};

function viewPhrase(view: DirectorShotView, side: DirectorShotSide | null): string {
  const sideWord = side ?? "right";
  switch (view) {
    case "front":
      return "seen squarely from the front";
    case "front-quarter":
      return `a three-quarter front view from the subject's ${sideWord}`;
    case "profile":
      return `a ${sideWord}-side profile view`;
    case "rear-quarter":
      return `a three-quarter rear view from the subject's ${sideWord}`;
    case "back":
      return "seen from directly behind";
  }
}

/**
 * One-line English framing statement, e.g.
 * "medium shot on a 50mm lens, eye level, a three-quarter front view from the subject's right".
 */
export function buildDirectorFramingPhrase(language: DirectorShotLanguage): string {
  return `${SIZE_PHRASES[language.size]} on a ${language.focalLengthMm}mm lens, ${LEVEL_PHRASES[language.level]}, ${viewPhrase(
    language.view,
    language.side,
  )}`;
}

/** The compact viewfinder slate, e.g. "MEDIUM · FRONT-QUARTER R · EYE · 50MM". */
export function formatDirectorShotSlate(language: DirectorShotLanguage): string {
  const sideInitial = language.side ? ` ${language.side === "right" ? "R" : "L"}` : "";
  return [language.size, `${language.view}${sideInitial}`, language.level, `${language.focalLengthMm}mm`]
    .join(" · ")
    .toUpperCase();
}

/** Structured wire form of a derived shot description for observe/audit/shot IR. */
export interface DirectorShotLanguageReport {
  size: DirectorShotSize;
  view: DirectorShotView;
  side: DirectorShotSide | null;
  level: DirectorShotLevel;
  focal_length_mm: number;
  exact_focal_length_mm: number;
  distance_m: number;
  subject_screen_fraction: number;
  camera_height_m: number;
  slate: string;
  phrase: string;
}

/** Serializes a derived shot language into its snake_case wire form. */
export function directorShotLanguageReport(language: DirectorShotLanguage): DirectorShotLanguageReport {
  return {
    size: language.size,
    view: language.view,
    side: language.side,
    level: language.level,
    focal_length_mm: language.focalLengthMm,
    exact_focal_length_mm: Number(language.exactFocalLengthMm.toFixed(2)),
    distance_m: Number(language.distanceM.toFixed(3)),
    subject_screen_fraction: Number(language.subjectScreenFraction.toFixed(4)),
    camera_height_m: Number(language.cameraHeightM.toFixed(3)),
    slate: formatDirectorShotSlate(language),
    phrase: buildDirectorFramingPhrase(language),
  };
}
