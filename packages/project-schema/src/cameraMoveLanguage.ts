import {
  deriveDirectorShotLanguage,
  type DirectorCameraFraming,
  type DirectorFramingSubject,
  type DirectorShotLanguage,
} from "./filmLanguage";

/**
 * Director camera-move language: a camera move is two framings and a duration.
 *
 * Interpolation runs in subject-centred coordinates (distance, azimuth, lens
 * height) instead of raw positions, so an arc eases around the subject the way
 * a dolly grip would push it instead of cutting through the chord. The
 * classifier then names the move from what the two framings geometrically
 * prove — a prompt claims "push-in" only when the camera actually pushes in.
 */

/** All camera move names the classifier can prove from geometry. */
export const DIRECTOR_CAMERA_MOVE_IDS = [
  "static",
  "pan-left",
  "pan-right",
  "tilt-up",
  "tilt-down",
  "zoom-in",
  "zoom-out",
  "push-in",
  "pull-out",
  "crane-up",
  "crane-down",
  "orbit-left",
  "orbit-right",
  "contra-zoom",
  "track",
] as const;
export type DirectorCameraMoveId = (typeof DIRECTOR_CAMERA_MOVE_IDS)[number];

/** Simplified-Chinese source labels for camera moves. */
export const DIRECTOR_CAMERA_MOVE_LABELS: Record<DirectorCameraMoveId, string> = {
  static: "固定机位",
  "pan-left": "左摇",
  "pan-right": "右摇",
  "tilt-up": "上仰",
  "tilt-down": "下俯",
  "zoom-in": "变焦推近",
  "zoom-out": "变焦拉远",
  "push-in": "推进",
  "pull-out": "拉远",
  "crane-up": "升降上升",
  "crane-down": "升降下降",
  "orbit-left": "左环绕",
  "orbit-right": "右环绕",
  "contra-zoom": "滑动变焦",
  track: "移动跟拍",
};

const TWO_PI = Math.PI * 2;
const DEG_PER_RAD = 180 / Math.PI;

/** Signed shortest angular distance from a to b, in (-PI, PI]. */
export function shortestAngleRad(a: number, b: number): number {
  let delta = (b - a) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta <= -Math.PI) delta += TWO_PI;
  return delta;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The classic film ease: slow leaving A, slow arriving at B. */
export function directorMoveEase(t: number): number {
  const clamped = clamp01(t);
  return clamped * clamped * (3 - 2 * clamped);
}

interface DecomposedFraming {
  /** Horizontal camera-to-anchor distance in metres. */
  radius: number;
  /** Azimuth around the anchor: position = anchor + radius * (sin, cos). */
  azimuthRad: number;
  /** Absolute lens height in metres. */
  heightM: number;
  /** World aim point the lens looks at. */
  aim: [number, number, number];
  focalLengthMm: number;
}

function decomposeFraming(framing: DirectorCameraFraming, anchor: { x: number; z: number }): DecomposedFraming {
  const dx = framing.position[0] - anchor.x;
  const dz = framing.position[2] - anchor.z;
  return {
    radius: Math.max(Math.hypot(dx, dz), 1e-6),
    azimuthRad: Math.atan2(dx, dz),
    heightM: framing.position[1],
    aim: [...framing.target],
    focalLengthMm: framing.focalLengthMm,
  };
}

/**
 * Blends two framings around a subject anchor. Distance, azimuth, and lens
 * height each ease independently, azimuth takes the short way around, and the
 * lens interpolates in focal millimetres — the space a zoom ring moves in.
 * t=0 and t=1 reproduce the input framings exactly.
 */
export function interpolateDirectorCameraFraming(
  a: DirectorCameraFraming,
  b: DirectorCameraFraming,
  anchor: { x: number; z: number },
  t: number,
  ease: (t: number) => number = directorMoveEase,
): DirectorCameraFraming {
  const k = ease(clamp01(t));
  const from = decomposeFraming(a, anchor);
  const to = decomposeFraming(b, anchor);
  const radius = lerp(from.radius, to.radius, k);
  const azimuth = from.azimuthRad + shortestAngleRad(from.azimuthRad, to.azimuthRad) * k;
  const position: [number, number, number] = [
    anchor.x + Math.sin(azimuth) * radius,
    lerp(from.heightM, to.heightM, k),
    anchor.z + Math.cos(azimuth) * radius,
  ];
  const target: [number, number, number] = [
    lerp(from.aim[0], to.aim[0], k),
    lerp(from.aim[1], to.aim[1], k),
    lerp(from.aim[2], to.aim[2], k),
  ];
  return {
    position,
    target,
    focalLengthMm: lerp(from.focalLengthMm, to.focalLengthMm, k),
    aspectRatio: a.aspectRatio,
    sensorFormat: a.sensorFormat,
  };
}

// Below these deltas the camera is, cinematically speaking, not doing that.
const HOLD_POSITION_M = 0.12;
const HOLD_AIM_DEG = 5;
const DOLLY_MIN_M = 0.3;
const CRANE_MIN_M = 0.4;
const ORBIT_MIN_DEG = 18;
const ZOOM_MIN_MM = 9;
const CONTRA_ZOOM_MIN_MM = 7;
// A contra-zoom moves the camera while the lens compensates: the subject's
// screen size may drift only this much for the vertigo reading to hold.
const CONTRA_ZOOM_SIZE_DRIFT = 0.16;

function aimDirection(framing: DirectorCameraFraming): { x: number; z: number; pitchRad: number } {
  const dx = framing.target[0] - framing.position[0];
  const dy = framing.target[1] - framing.position[1];
  const dz = framing.target[2] - framing.position[2];
  const horizontal = Math.max(Math.hypot(dx, dz), 1e-6);
  return { x: dx / horizontal, z: dz / horizontal, pitchRad: Math.atan2(dy, horizontal) };
}

/**
 * Signed horizontal aim sweep from framing A to framing B in operator terms:
 * positive means the lens sweeps to the camera's own right (a pan right).
 */
function aimYawSweepRad(a: DirectorCameraFraming, b: DirectorCameraFraming): number {
  const from = aimDirection(a);
  const to = aimDirection(b);
  // rightA = forwardA × up for a Y-up world, flattened to the ground plane.
  return Math.atan2(to.x * -from.z + to.z * from.x, to.x * from.x + to.z * from.z);
}

/** A geometrically proven camera move between two framings of one subject. */
export interface DirectorCameraMoveDescription {
  id: DirectorCameraMoveId;
  /** Simplified-Chinese label for the move. */
  label: string;
  /** English generation phrase, e.g. "a slow push-in from a full shot to a close-up". */
  phrase: string;
  /** "slow" | "fast" | "" depending on lens travel per second. */
  tempo: "slow" | "fast" | "";
  from: DirectorShotLanguage;
  to: DirectorShotLanguage;
  deltas: {
    distance_m: number;
    azimuth_deg: number;
    height_m: number;
    focal_mm: number;
    aim_yaw_deg: number;
    aim_pitch_deg: number;
    travel_m: number;
  };
}

/** Optional tuning for {@link describeDirectorCameraMove}. */
export interface DirectorCameraMoveOptions {
  /** Wall-clock length of the move; drives the slow/fast tempo reading. */
  durationSeconds?: number;
}

/**
 * Names the move the two framings prove. The user may claim any move; this is
 * the measured one, and the phrase slots directly into a generation prompt.
 */
export function describeDirectorCameraMove(
  a: DirectorCameraFraming,
  b: DirectorCameraFraming,
  subject: DirectorFramingSubject,
  options: DirectorCameraMoveOptions = {},
): DirectorCameraMoveDescription {
  const anchor = { x: subject.position[0], z: subject.position[2] };
  const from = decomposeFraming(a, anchor);
  const to = decomposeFraming(b, anchor);
  const shotA = deriveDirectorShotLanguage(a, subject);
  const shotB = deriveDirectorShotLanguage(b, subject);

  const dRadius = to.radius - from.radius;
  const dAzimuthDeg = shortestAngleRad(from.azimuthRad, to.azimuthRad) * DEG_PER_RAD;
  const dHeight = to.heightM - from.heightM;
  const dFocal = to.focalLengthMm - from.focalLengthMm;
  const dAimYawDeg = aimYawSweepRad(a, b) * DEG_PER_RAD;
  const dAimPitchDeg = (aimDirection(b).pitchRad - aimDirection(a).pitchRad) * DEG_PER_RAD;
  const positionDelta = Math.hypot(
    b.position[0] - a.position[0],
    b.position[1] - a.position[1],
    b.position[2] - a.position[2],
  );
  const sizeDrift =
    Math.abs(shotB.subjectScreenFraction - shotA.subjectScreenFraction) /
    Math.max(shotA.subjectScreenFraction, 1e-6);

  const travel = Math.hypot(
    Math.abs(dRadius),
    (Math.abs(dAzimuthDeg) / DEG_PER_RAD) * ((from.radius + to.radius) / 2),
    dHeight,
  );
  const durationSeconds = Math.max(options.durationSeconds ?? 3, 0.1);
  const speed = travel / durationSeconds;
  const tempo: DirectorCameraMoveDescription["tempo"] =
    travel < HOLD_POSITION_M ? "" : speed < 0.32 ? "slow" : speed > 1.5 ? "fast" : "";
  const tempoPrefix = tempo ? `${tempo} ` : "";

  const holdsPosition = positionDelta < HOLD_POSITION_M;
  const sizesSpan = `from a ${shotA.size.replace(/-/g, " ")} shot to a ${shotB.size.replace(/-/g, " ")} shot`;

  let id: DirectorCameraMoveId;
  let phrase: string;

  if (
    holdsPosition &&
    Math.abs(dAimYawDeg) < HOLD_AIM_DEG &&
    Math.abs(dAimPitchDeg) < HOLD_AIM_DEG &&
    Math.abs(dFocal) < ZOOM_MIN_MM
  ) {
    id = "static";
    phrase = "a static, locked-off shot";
  } else if (holdsPosition && Math.abs(dFocal) >= ZOOM_MIN_MM) {
    id = dFocal > 0 ? "zoom-in" : "zoom-out";
    phrase = `a ${tempoPrefix}zoom ${dFocal > 0 ? "in, tightening" : "out, opening"} ${sizesSpan}`;
  } else if (holdsPosition) {
    if (Math.abs(dAimYawDeg) >= Math.abs(dAimPitchDeg)) {
      const way = dAimYawDeg >= 0 ? "right" : "left";
      id = way === "right" ? "pan-right" : "pan-left";
      phrase = `a ${tempoPrefix}pan to the ${way}`;
    } else {
      const way = dAimPitchDeg > 0 ? "up" : "down";
      id = way === "up" ? "tilt-up" : "tilt-down";
      phrase = `a ${tempoPrefix}tilt ${way}`;
    }
  } else if (
    Math.abs(dRadius) >= DOLLY_MIN_M &&
    Math.abs(dFocal) >= CONTRA_ZOOM_MIN_MM &&
    Math.sign(dFocal) === Math.sign(dRadius) &&
    sizeDrift <= CONTRA_ZOOM_SIZE_DRIFT
  ) {
    id = "contra-zoom";
    phrase = `a contra-zoom (vertigo effect): the camera ${
      dRadius < 0 ? "pushes in" : "pulls back"
    } while the lens compensates to hold the subject's size, and the background ${
      dRadius < 0 ? "falls away" : "closes in"
    }`;
  } else if (Math.abs(dAzimuthDeg) >= ORBIT_MIN_DEG) {
    // Orbit direction names the way the camera travels: while facing the
    // subject, increasing azimuth carries the camera toward its own right.
    const way = dAzimuthDeg >= 0 ? "right" : "left";
    id = way === "right" ? "orbit-right" : "orbit-left";
    const radial =
      dRadius <= -DOLLY_MIN_M
        ? ", closing in as it circles"
        : dRadius >= DOLLY_MIN_M
          ? ", drifting wider as it circles"
          : "";
    phrase = `a ${tempoPrefix}orbit around the subject, arcing ${Math.round(Math.abs(dAzimuthDeg))} degrees to the ${way}${radial}`;
  } else if (Math.abs(dHeight) >= CRANE_MIN_M && Math.abs(dHeight) >= Math.abs(dRadius) * 0.8) {
    const way = dHeight > 0 ? "up" : "down";
    id = way === "up" ? "crane-up" : "crane-down";
    phrase = `a ${tempoPrefix}crane ${way}, the camera ${dHeight > 0 ? "rising" : "sinking"} from ${shotA.level} level to ${shotB.level} level`;
  } else if (dRadius <= -DOLLY_MIN_M) {
    id = "push-in";
    const crane = Math.abs(dHeight) >= CRANE_MIN_M ? `, craning ${dHeight > 0 ? "up" : "down"} as it moves` : "";
    phrase = `a ${tempoPrefix}push-in ${sizesSpan}${crane}`;
  } else if (dRadius >= DOLLY_MIN_M) {
    id = "pull-out";
    const crane = Math.abs(dHeight) >= CRANE_MIN_M ? `, craning ${dHeight > 0 ? "up" : "down"} as it moves` : "";
    phrase = `a ${tempoPrefix}pull-out ${sizesSpan}${crane}`;
  } else {
    id = "track";
    phrase = `a ${tempoPrefix}tracking move alongside the subject`;
  }

  return {
    id,
    label: DIRECTOR_CAMERA_MOVE_LABELS[id],
    phrase,
    tempo,
    from: shotA,
    to: shotB,
    deltas: {
      distance_m: Number(dRadius.toFixed(3)),
      azimuth_deg: Number(dAzimuthDeg.toFixed(2)),
      height_m: Number(dHeight.toFixed(3)),
      focal_mm: Number(dFocal.toFixed(2)),
      aim_yaw_deg: Number(dAimYawDeg.toFixed(2)),
      aim_pitch_deg: Number(dAimPitchDeg.toFixed(2)),
      travel_m: Number(travel.toFixed(3)),
    },
  };
}

/** The burned-in move slate, e.g. "FULL 35MM → CLOSE-UP 85MM · PUSH-IN". */
export function formatDirectorCameraMoveSlate(move: DirectorCameraMoveDescription): string {
  const from = `${move.from.size} ${move.from.focalLengthMm}mm`;
  const to = `${move.to.size} ${move.to.focalLengthMm}mm`;
  return `${from} → ${to} · ${move.id}`.toUpperCase();
}

/** Chains segment phrases in time order for a multi-key camera track. */
export function buildDirectorCameraMovePhrase(segments: readonly DirectorCameraMoveDescription[]): string {
  return segments.map((segment) => segment.phrase).join(", then ");
}
