import {
  DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO,
  DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM,
  DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE,
  DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT,
  getVerticalFovFromFocalLength,
  normalizeDirectorCameraOptics,
} from "../schema/cameraGeometry";
import type {
  DirectorCameraAspectRatio,
  DirectorCameraHandheldShake,
  DirectorCameraSensorFormat,
  DirectorCameraShot,
} from "../schema/directorProject";

/** Discriminated union of all built-in cinematography preset identifiers. */
export type DirectorCinematographyPresetId =
  | "natural-narrative"
  | "anamorphic-night"
  | "super16-documentary"
  | "portrait-closeup"
  | "large-format-epic"
  | "crisp-action"
  | "vertical-story";

/** The full set of optical and mechanical camera parameters that define a cinematographic look. */
export interface DirectorCinematographySettings {
  /** 35mm-equivalent focal length in millimeters. */
  focalLengthMm: number;
  /** Target sensor or film-gate format. */
  sensorFormat: DirectorCameraSensorFormat;
  /** Lens aperture expressed as an f-stop denominator (e.g. 2.8 means f/2.8). */
  apertureFStop: number;
  /** Distance from the camera to the focal plane in meters. */
  focusDistanceM: number;
  /** Rotary shutter angle in degrees (180° is the standard cinematic default). */
  shutterAngle: number;
  /** Sensor sensitivity (ISO). */
  iso: number;
  /** Horizontal squeeze factor from an anamorphic lens (1.0 = spherical). */
  anamorphicSqueeze: number;
  /** Output aspect ratio. */
  aspectRatio: DirectorCameraAspectRatio;
  /** Intensity of simulated handheld camera shake. */
  handheldShake: DirectorCameraHandheldShake;
}

/** A named, documented bundle of cinematography settings intended for a specific shooting style. */
export interface DirectorCinematographyPreset {
  /** Unique preset identifier. */
  id: DirectorCinematographyPresetId;
  /** Human-readable preset name. */
  name: string;
  /** What the preset looks like and how it feels. */
  description: string;
  /** Scenarios where this preset is most appropriate. */
  bestFor: string;
  /** The concrete camera parameters. */
  settings: DirectorCinematographySettings;
}

/**
 * A complete camera settings patch that includes the computed vertical field of view.
 *
 * Derives {@link fov} from focal length, aspect ratio, and sensor format so
 * consumers receive a ready-to-apply camera patch.
 */
export interface DirectorCinematographyCameraPatch extends DirectorCinematographySettings {
  /** Vertical field of view in degrees, derived from the optical parameters. */
  fov: number;
}

/** Severity level for a cinematography diagnostic issue. */
export type DirectorCinematographyIssueSeverity = "critical" | "warning" | "info";

/** A diagnostic issue detected during cinematography evaluation. */
export interface DirectorCinematographyIssue {
  /** Machine-readable issue code. */
  code:
    | "focus-before-near-clip"
    | "focus-beyond-far-clip"
    | "anamorphic-output-mismatch"
    | "telephoto-handheld"
    | "motion-smear"
    | "staccato-motion"
    | "high-iso"
    | "shallow-focus"
    | "spherical-scope";
  /** How urgent the issue is. */
  severity: DirectorCinematographyIssueSeverity;
  /** Short human-readable summary. */
  title: string;
  /** Actionable explanation or suggested fix. */
  detail: string;
}

/** All built-in cinematography presets, ordered from most general to most specialized. */
export const DIRECTOR_CINEMATOGRAPHY_PRESETS: readonly DirectorCinematographyPreset[] = [
  {
    id: "natural-narrative",
    name: "自然主义叙事",
    description: "接近人眼观察感的中广角，保留轻微呼吸感和柔和景深。",
    bestFor: "对白、剧情短片、写实预演",
    settings: {
      focalLengthMm: 35,
      sensorFormat: "fullFrame",
      apertureFStop: 2.8,
      focusDistanceM: 4,
      shutterAngle: 180,
      iso: 800,
      anamorphicSqueeze: 1,
      aspectRatio: "1.85:1",
      handheldShake: "subtle",
    },
  },
  {
    id: "anamorphic-night",
    name: "变形宽银幕夜景",
    description: "Super 35 与 2× 变形镜头组合，强调横向空间和浅景深。",
    bestFor: "夜景、霓虹、悬疑与科幻",
    settings: {
      focalLengthMm: 50,
      sensorFormat: "super35",
      apertureFStop: 2,
      focusDistanceM: 5,
      shutterAngle: 180,
      iso: 1600,
      anamorphicSqueeze: 2,
      aspectRatio: "2.39:1",
      handheldShake: "subtle",
    },
  },
  {
    id: "super16-documentary",
    name: "Super 16 纪录片",
    description: "小画幅广角与中等手持，获得贴近人物、反应迅速的纪实感。",
    bestFor: "纪录片、追拍、复古电视感",
    settings: {
      focalLengthMm: 16,
      sensorFormat: "super16",
      apertureFStop: 2.8,
      focusDistanceM: 3,
      shutterAngle: 172.8,
      iso: 800,
      anamorphicSqueeze: 1,
      aspectRatio: "4:3",
      handheldShake: "medium",
    },
  },
  {
    id: "portrait-closeup",
    name: "电影感近景",
    description: "长焦压缩透视并缩短景深，突出表演和面部层次。",
    bestFor: "特写、情绪反应、人物肖像",
    settings: {
      focalLengthMm: 85,
      sensorFormat: "fullFrame",
      apertureFStop: 2,
      focusDistanceM: 2.5,
      shutterAngle: 180,
      iso: 400,
      anamorphicSqueeze: 1,
      aspectRatio: "1.85:1",
      handheldShake: "off",
    },
  },
  {
    id: "large-format-epic",
    name: "65mm 史诗场面",
    description: "大画幅、较深景深与稳定机位，让环境和调度同时保持清晰。",
    bestFor: "大全景、建筑、群像与宏大场面",
    settings: {
      focalLengthMm: 65,
      sensorFormat: "imax65",
      apertureFStop: 4,
      focusDistanceM: 12,
      shutterAngle: 180,
      iso: 400,
      anamorphicSqueeze: 1,
      aspectRatio: "2.39:1",
      handheldShake: "off",
    },
  },
  {
    id: "crisp-action",
    name: "清晰动作镜头",
    description: "较短快门和中广角降低运动拖影，保留适度手持冲击力。",
    bestFor: "动作、追逐、快速运镜",
    settings: {
      focalLengthMm: 28,
      sensorFormat: "super35",
      apertureFStop: 4,
      focusDistanceM: 7,
      shutterAngle: 90,
      iso: 800,
      anamorphicSqueeze: 1,
      aspectRatio: "16:9",
      handheldShake: "medium",
    },
  },
  {
    id: "vertical-story",
    name: "竖屏叙事",
    description: "为 9:16 输出保留自然透视和轻微手持，适合人物主导构图。",
    bestFor: "短视频、移动端广告、竖屏剧情",
    settings: {
      focalLengthMm: 35,
      sensorFormat: "fullFrame",
      apertureFStop: 2.8,
      focusDistanceM: 4,
      shutterAngle: 180,
      iso: 800,
      anamorphicSqueeze: 1,
      aspectRatio: "9:16",
      handheldShake: "subtle",
    },
  },
] as const;

/**
 * Looks up a cinematography preset by its identifier.
 *
 * Falls back to the first preset when the requested id is not found, so
 * callers always receive a valid preset.
 *
 * @param id - The preset identifier to look up.
 * @returns The matching preset, or the first preset as a fallback.
 */
export function getDirectorCinematographyPreset(id: DirectorCinematographyPresetId) {
  return DIRECTOR_CINEMATOGRAPHY_PRESETS.find((preset) => preset.id === id) ?? DIRECTOR_CINEMATOGRAPHY_PRESETS[0];
}

/**
 * Converts a cinematography preset into a ready-to-apply camera patch.
 *
 * Computes the vertical field of view from the preset's focal length, aspect
 * ratio, and sensor format so that the returned patch carries both the raw
 * optical parameters and the derived FOV.
 *
 * @param preset - The preset to convert.
 * @returns A camera patch with all preset settings plus the computed FOV.
 */
export function createDirectorCinematographyCameraPatch(
  preset: DirectorCinematographyPreset,
): DirectorCinematographyCameraPatch {
  const settings = preset.settings;
  return {
    ...settings,
    fov: getVerticalFovFromFocalLength(settings.focalLengthMm, settings.aspectRatio, settings.sensorFormat),
  };
}

/**
 * Runs cinematography diagnostics on a camera shot.
 *
 * Evaluates focus placement, anamorphic/output ratio alignment, handheld
 * suitability for the focal length, shutter-angle motion character, ISO
 * noise risk, depth-of-field, and spherical-vs-scope choices. Issues are
 * returned in severity order: critical first, then warnings, then info.
 *
 * @param camera - A subset of the camera shot fields relevant to cinematography evaluation.
 * @returns Severity-sorted list of diagnostic issues.
 */
export function evaluateDirectorCinematography(
  camera: Pick<
    DirectorCameraShot,
    | "focalLengthMm"
    | "sensorFormat"
    | "apertureFStop"
    | "focusDistanceM"
    | "shutterAngle"
    | "iso"
    | "nearClipM"
    | "farClipM"
    | "anamorphicSqueeze"
    | "aspectRatio"
    | "handheldShake"
    | "action"
  >,
): DirectorCinematographyIssue[] {
  const optics = normalizeDirectorCameraOptics(camera);
  const focalLengthMm = camera.focalLengthMm ?? DEFAULT_DIRECTOR_CAMERA_FOCAL_LENGTH_MM;
  const sensorFormat = camera.sensorFormat ?? DEFAULT_DIRECTOR_CAMERA_SENSOR_FORMAT;
  const aspectRatio = camera.aspectRatio ?? DEFAULT_DIRECTOR_CAMERA_ASPECT_RATIO;
  const handheldShake = camera.handheldShake ?? DEFAULT_DIRECTOR_CAMERA_HANDHELD_SHAKE;
  const issues: DirectorCinematographyIssue[] = [];

  if (optics.focusDistanceM <= optics.nearClipM) {
    issues.push({
      code: "focus-before-near-clip",
      severity: "critical",
      title: "焦点落在近裁剪面以内",
      detail: "减小近裁剪距离，或把对焦距离移到近裁剪面之后。",
    });
  } else if (optics.focusDistanceM >= optics.farClipM) {
    issues.push({
      code: "focus-beyond-far-clip",
      severity: "critical",
      title: "焦点落在远裁剪面之外",
      detail: "增大远裁剪距离，或把对焦距离移回可见范围。",
    });
  }

  if (optics.anamorphicSqueeze >= 1.3 && aspectRatio !== "2.39:1" && aspectRatio !== "1.85:1") {
    issues.push({
      code: "anamorphic-output-mismatch",
      severity: "warning",
      title: "变形镜头与输出画幅不匹配",
      detail: `当前 ${optics.anamorphicSqueeze.toFixed(2)}× 挤压更适合 2.39:1 或 1.85:1 输出。`,
    });
  }

  if (focalLengthMm >= 85 && (handheldShake === "medium" || handheldShake === "strong")) {
    issues.push({
      code: "telephoto-handheld",
      severity: "warning",
      title: "长焦手持会放大抖动",
      detail: "建议降低手持强度、使用更短焦距，或改为稳定机位。",
    });
  }

  if (optics.shutterAngle > 270 && (handheldShake === "medium" || handheldShake === "strong")) {
    issues.push({
      code: "motion-smear",
      severity: "warning",
      title: "手持与大快门角会产生明显拖影",
      detail: "将快门角降到 180° 左右，可保留更清晰的运动轮廓。",
    });
  } else if (optics.shutterAngle < 90 && camera.action?.mode !== "still") {
    issues.push({
      code: "staccato-motion",
      severity: "info",
      title: "短快门会形成跳切式运动质感",
      detail: "这是动作镜头的常用选择；自然运动通常使用约 180°。",
    });
  }

  if (optics.iso >= 3200) {
    issues.push({
      code: "high-iso",
      severity: "warning",
      title: "高 ISO 可能放大噪点",
      detail: "如果光照允许，优先开大光圈或增加场景照度后再降低 ISO。",
    });
  }

  if (optics.apertureFStop <= 1.4 && optics.focusDistanceM <= 3) {
    issues.push({
      code: "shallow-focus",
      severity: "info",
      title: "当前景深非常浅",
      detail: "适合特写，但人物移动时需要更精确的焦点跟随。",
    });
  }

  if (aspectRatio === "2.39:1" && optics.anamorphicSqueeze < 1.1) {
    issues.push({
      code: "spherical-scope",
      severity: "info",
      title: "当前是球面宽银幕裁切",
      detail: `可保持现状；若需要变形镜头质感，可选择变形预设。${sensorFormat === "imax65" ? " 65mm 大画幅使用球面镜头也很常见。" : ""}`,
    });
  }

  const severityOrder: Record<DirectorCinematographyIssueSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return issues.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]);
}
