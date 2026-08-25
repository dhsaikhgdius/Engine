import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_PILOT_INERTIA,
  DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED,
  DEFAULT_VIEWPORT_MOVE_SPEED,
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  VIEWPORT_CHARACTER_MOVE_SPEED_MAX,
  VIEWPORT_CHARACTER_MOVE_SPEED_MIN,
  VIEWPORT_MOVE_SPEED_MAX,
  VIEWPORT_MOVE_SPEED_MIN,
  normalizeCameraPilotFeel,
  normalizeViewportCharacterMoveSpeed,
  normalizeViewportMoveSpeed,
  normalizeViewportSensitivity,
} from "../../../../src/comprehensive/editor/schema/viewportNavigation";

describe("viewport navigation settings", () => {
  it("normalizes sensitivity to supported steps", () => {
    expect(normalizeViewportSensitivity(0.37, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY)).toBe(0.35);
    expect(normalizeViewportSensitivity(99, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY)).toBe(1.5);
    expect(normalizeViewportSensitivity(Number.NaN, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY)).toBe(0.35);
  });

  it("normalizes movement speed without accepting invalid values", () => {
    expect(normalizeViewportMoveSpeed(7.24)).toBe(7);
    expect(normalizeViewportMoveSpeed(0)).toBe(VIEWPORT_MOVE_SPEED_MIN);
    expect(normalizeViewportMoveSpeed(999)).toBe(VIEWPORT_MOVE_SPEED_MAX);
    expect(normalizeViewportMoveSpeed(undefined)).toBe(DEFAULT_VIEWPORT_MOVE_SPEED);
  });

  it("normalizes character roam speed as a multiplier", () => {
    expect(normalizeViewportCharacterMoveSpeed(1.22)).toBe(1.2);
    expect(normalizeViewportCharacterMoveSpeed(0)).toBe(VIEWPORT_CHARACTER_MOVE_SPEED_MIN);
    expect(normalizeViewportCharacterMoveSpeed(9)).toBe(VIEWPORT_CHARACTER_MOVE_SPEED_MAX);
    expect(normalizeViewportCharacterMoveSpeed(undefined)).toBe(DEFAULT_VIEWPORT_CHARACTER_MOVE_SPEED);
  });

  it("normalizes camera pilot feel controls to a stable zero-to-one range", () => {
    expect(normalizeCameraPilotFeel(0.43, DEFAULT_CAMERA_PILOT_INERTIA)).toBe(0.45);
    expect(normalizeCameraPilotFeel(2, DEFAULT_CAMERA_PILOT_INERTIA)).toBe(1);
    expect(normalizeCameraPilotFeel(Number.NaN, DEFAULT_CAMERA_PILOT_INERTIA)).toBe(DEFAULT_CAMERA_PILOT_INERTIA);
  });
});
